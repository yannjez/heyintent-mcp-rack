import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPrismaClient } from "@rack/database";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { catalog } from "./mcp/catalog.js";
import { freePort } from "./test-helpers.js";

const databaseUrl = process.env.DATABASE_URL;
const EMAIL = "oauth@rack.test";
const REDIRECT_URI = "http://127.0.0.1:9/callback";

function b64url(buffer: Buffer) {
  return buffer.toString("base64url");
}

/**
 * Browsers navigating to /oauth2/authorize get a 302; programmatic fetches
 * (sec-fetch-mode: cors) get `{ redirect: true, url }`. Accept both.
 */
async function redirectTarget(response: Response, base: string) {
  if (response.status === 302) return new URL(response.headers.get("location")!, base);
  const body = (await response.json()) as { redirect?: boolean; url?: string };
  expect(body.redirect, JSON.stringify(body)).toBe(true);
  return new URL(body.url!, base);
}

/**
 * Full MCP autodiscovery flow as an MCP client performs it: dynamic client
 * registration, PKCE authorization, OTP login, consent, token exchange, then
 * tool calls with the resulting bearer token.
 */
describe.skipIf(!databaseUrl)("oauth autodiscover flow", () => {
  const db = createPrismaClient(databaseUrl);
  let app: FastifyInstance;
  let baseUrl = "";
  let lastOtp = "";
  let cookie = "";
  const applicationIds: string[] = [];

  beforeAll(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.mcpGroup.deleteMany({ where: { name: "vitest-oauth-group" } });
    await db.mcp.updateMany({
      where: { slug: "sample" },
      data: { enabled: true, allowedCapabilities: [] },
    });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        BETTER_AUTH_URL: baseUrl,
        PORT: String(port),
        ALLOWED_EMAIL_DOMAINS: "rack.test",
        ADMIN_EMAILS: "",
      }),
      db,
      catalog,
      logger: false,
      sendOtp: async (_email, otp) => {
        lastOtp = otp;
      },
    });
    await app.listen({ port, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.mcpGroup.deleteMany({ where: { name: "vitest-oauth-group" } });
    await db.oauthClient.deleteMany({ where: { clientId: { in: applicationIds } } });
    await db.$disconnect();
  });

  it("registers a client, authorizes through OTP login + consent and calls tools", async () => {
    // Discovery: challenge → resource metadata → authorization server metadata.
    const challenge = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      body: "{}",
    });
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(
      challenge.headers.get("www-authenticate") ?? "",
    )?.[1];
    expect(metadataUrl).toBeTruthy();
    const resourceMeta = (await (await fetch(metadataUrl!)).json()) as {
      authorization_servers: string[];
    };
    const issuer = resourceMeta.authorization_servers[0]!;
    const issuerPath = new URL(issuer).pathname;
    const asMeta = (await (
      await fetch(
        `${new URL(issuer).origin}/.well-known/oauth-authorization-server${issuerPath}`,
      )
    ).json()) as {
      registration_endpoint: string;
      authorization_endpoint: string;
      token_endpoint: string;
    };

    // Dynamic client registration (public client, PKCE).
    const registration = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Vitest MCP client",
        application_type: "native",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const client = (await registration.json()) as { client_id: string };
    expect(registration.status, JSON.stringify(client)).toBe(201);
    applicationIds.push(client.client_id);

    // Authorization request → redirected to the login page with a signed query.
    const verifier = b64url(randomBytes(32));
    const codeChallenge = b64url(createHash("sha256").update(verifier).digest());
    const authorizeUrl = new URL(asMeta.authorization_endpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "openid mcp:sample:read",
      state: "xyz",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: `${baseUrl}/mcp`,
    }).toString();
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    const loginRedirect = await redirectTarget(authorize, baseUrl);
    expect(loginRedirect.pathname, loginRedirect.toString()).toBe("/login");
    expect(loginRedirect.searchParams.get("client_id")).toBe(client.client_id);

    // OTP delivery must work even when an older UI attaches an expired or
    // malformed OAuth context. Only the later authorization verifies it.
    const invalidQuery = `client_id=${encodeURIComponent(client.client_id)}&exp=1&sig=invalid`;
    for (const oauthQuery of [invalidQuery, loginRedirect.search.slice(1)]) {
      const sent = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ email: EMAIL, type: "sign-in", oauth_query: oauthQuery }),
      });
      expect(sent.status, await sent.text()).toBe(200);
      expect(lastOtp).toMatch(/^\d{6}$/);
    }
    const invalidSignIn = await fetch(`${baseUrl}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, otp: lastOtp, oauth_query: invalidQuery }),
    });
    expect(invalidSignIn.status).toBe(400);
    expect(await invalidSignIn.json()).toMatchObject({ error: "invalid_signature" });
    // Signing in with the signed `oauth_query` (what the oauthProviderClient
    // plugin attaches from the login page URL) resumes the authorization: the
    // response is the next hop, here the consent page.
    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        email: EMAIL,
        otp: lastOtp,
        oauth_query: loginRedirect.search.slice(1),
      }),
    });
    const signInBody = (await signIn.json()) as { redirect?: boolean; url?: string };
    expect(signIn.status, JSON.stringify(signInBody)).toBe(200);
    cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(signInBody.redirect).toBe(true);
    const consentRedirect = new URL(signInBody.url!, baseUrl);
    expect(consentRedirect.pathname, consentRedirect.toString()).toBe("/consent");
    expect(consentRedirect.searchParams.get("scope")).toContain("mcp:sample");

    // Consent → redirect back to the client with a code.
    const consent = await fetch(`${baseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, cookie },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentRedirect.search.slice(1),
      }),
    });
    const consentBody = (await consent.json()) as { redirect?: boolean; url?: string };
    expect(consent.status, JSON.stringify(consentBody)).toBe(200);
    const callback = new URL(consentBody.url!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("xyz");
    const code = callback.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Token exchange (form-encoded, like real clients).
    const token = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }).toString(),
    });
    const tokens = (await token.json()) as { access_token?: string; scope?: string };
    expect(token.status, JSON.stringify(tokens)).toBe(200);
    expect(tokens.scope).toContain("mcp:sample:read");

    // Even individual write rights cannot bypass missing group availability.
    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    const sample = await db.mcp.findUniqueOrThrow({ where: { slug: "sample" } });
    await db.mcpAccess.create({
      data: { mcpId: sample.id, userId: user.id, access: "write" },
    });
    const denied = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(403);
    await db.mcpGroup.create({
      data: {
        name: "vitest-oauth-group",
        mcps: { create: { mcpId: sample.id } },
        users: { create: { userId: user.id } },
      },
    });

    // MCP calls with the access token: the consent only carried read access,
    // so write tools are hidden even though the admin assigned write.
    const mcp = new Client({ name: "vitest", version: "0.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/sample`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("echo");
    expect(tools).not.toContain("summarize");
    const echo = await mcp.callTool({ name: "echo", arguments: { message: "oauth" } });
    expect(echo.structuredContent).toMatchObject({ via: "oauth", access: "read" });
    await mcp.close();
    await db.applicationAccess.create({
      data: { clientId: client.client_id, userId: user.id, allowed: false },
    });
    const applicationRevoked = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(applicationRevoked.status).toBe(403);
    await db.applicationAccess.deleteMany({ where: { clientId: client.client_id } });
    await db.mcpGroupUser.deleteMany({ where: { userId: user.id } });
    const revoked = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(revoked.status).toBe(403);
  });

  it.each(["none", "client_secret_basic", "client_secret_post"] as const)(
    "supports identity-only consent and application access with %s",
    async (authMethod) => {
      const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
      const registration = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Vitest identity application",
          application_type: "native",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: authMethod,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      const { client_id: clientId, client_secret: clientSecret } =
        (await registration.json()) as { client_id: string; client_secret?: string };
      const tokenHeaders: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      const credentials: Record<string, string> = {};
      if (authMethod === "client_secret_basic") {
        tokenHeaders.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret!)}`).toString("base64")}`;
      } else {
        credentials.client_id = clientId;
        if (authMethod === "client_secret_post")
          credentials.client_secret = clientSecret!;
      }
      expect(registration.status).toBe(201);
      applicationIds.push(clientId);
      const headers = { "content-type": "application/json", origin: baseUrl, cookie };
      const myApplications = async () => {
        const response = await fetch(`${baseUrl}/api/applications`, {
          headers: { cookie },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as Array<{
          clientId: string;
          name: string | null;
          url: string | null;
        }>;
      };
      expect((await fetch(`${baseUrl}/api/applications`)).status).toBe(401);
      expect(await myApplications()).toEqual(
        expect.arrayContaining([expect.objectContaining({ clientId })]),
      );
      const verifier = b64url(randomBytes(32));
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "openid profile email offline_access",
        prompt: "consent",
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      });
      const authorize = () =>
        fetch(`${baseUrl}/api/auth/oauth2/authorize?${query}`, {
          headers: { cookie },
          redirect: "manual",
        });
      const consent = (oauthQuery: string, extra: object = {}) =>
        fetch(`${baseUrl}/api/auth/oauth2/consent`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            accept: true,
            oauth_query: oauthQuery,
            scope: "openid profile email offline_access",
            ...extra,
          }),
        });

      const redirect = await redirectTarget(await authorize(), baseUrl);
      expect(redirect.pathname).toBe("/consent");
      const signedQuery = redirect.search.slice(1);
      // A signed consent page cannot be used after access is restricted.
      await db.oauthClient.update({
        where: { clientId },
        data: { accessRestricted: true },
      });
      expect((await consent(signedQuery)).status).toBe(403);
      expect((await consent(signedQuery, { client_id: applicationIds[0] })).status).toBe(
        403,
      );
      expect((await authorize()).status).toBe(403);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );

      const group = await db.mcpGroup.findUniqueOrThrow({
        where: { name: "vitest-oauth-group" },
      });
      await db.applicationGroup.create({ data: { clientId, groupId: group.id } });
      await db.mcpGroupUser.create({ data: { groupId: group.id, userId: user.id } });
      const groupRedirect = await redirectTarget(await authorize(), baseUrl);
      expect(groupRedirect.pathname).toBe("/consent");
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        true,
      );
      await db.applicationAccess.create({
        data: { clientId, userId: user.id, allowed: false },
      });
      expect((await authorize()).status).toBe(403);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      await db.applicationAccess.update({
        where: { clientId_userId: { clientId, userId: user.id } },
        data: { allowed: true },
      });
      await db.mcpGroupUser.deleteMany({ where: { userId: user.id } });
      const allowedRedirect = await redirectTarget(await authorize(), baseUrl);
      const accepted = await consent(allowedRedirect.search.slice(1));
      const acceptedBody = (await accepted.json()) as { url: string };
      expect(accepted.status, JSON.stringify(acceptedBody)).toBe(200);
      const code = new URL(acceptedBody.url).searchParams.get("code")!;
      const ambiguous = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
        method: "POST",
        headers: tokenHeaders,
        body: new URLSearchParams([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["client_id", clientId],
          ["client_id", applicationIds[0]!],
        ]),
      });
      expect(ambiguous.status).toBe(400);
      expect(await ambiguous.json()).toMatchObject({
        error: "invalid_request",
        error_description: "Duplicate client parameters",
      });
      const token = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
        method: "POST",
        headers: tokenHeaders,
        body: new URLSearchParams({
          ...credentials,
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        }),
      });
      const tokens = (await token.json()) as {
        id_token: string;
        access_token: string;
        refresh_token: string;
        scope: string;
      };
      expect(token.status, JSON.stringify(tokens)).toBe(200);
      expect(tokens.id_token).toBeTruthy();
      expect(tokens.scope).toContain("profile");
      expect(tokens.refresh_token).toBeTruthy();
      const userInfo = () =>
        fetch(`${baseUrl}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
      expect((await userInfo()).status).toBe(200);
      await db.applicationAccess.update({
        where: { clientId_userId: { clientId, userId: user.id } },
        data: { allowed: false },
      });
      expect((await userInfo()).status).toBe(403);
      const renewed = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
        method: "POST",
        headers: tokenHeaders,
        body: new URLSearchParams({
          ...credentials,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }),
      });
      expect(renewed.status, await renewed.text()).toBe(403);

      // Administration is protected and accepts policies with complete reference validation.
      expect(
        (await fetch(`${baseUrl}/api/admin/applications`, { headers: { cookie } }))
          .status,
      ).toBe(403);
      for (const path of [
        `/api/admin/users/${user.id}`,
        `/api/admin/groups/${group.id}`,
      ]) {
        expect((await fetch(`${baseUrl}${path}`, { headers: { cookie } })).status).toBe(
          403,
        );
      }
      expect(
        (
          await fetch(
            `${baseUrl}/api/admin/users/${user.id}/applications/${encodeURIComponent(clientId)}`,
            {
              method: "PUT",
              headers,
              body: JSON.stringify({ access: "allow" }),
            },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(
            `${baseUrl}/api/admin/applications/${encodeURIComponent(clientId)}/groups/${group.id}`,
            {
              method: "PUT",
              headers,
              body: JSON.stringify({ enabled: true }),
            },
          )
        ).status,
      ).toBe(403);
      await db.user.update({ where: { id: user.id }, data: { role: "admin" } });
      const listing = await fetch(`${baseUrl}/api/admin/applications`, {
        headers: { cookie },
      });
      expect(listing.status).toBe(200);
      expect(await listing.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientId, accessRestricted: true }),
        ]),
      );
      const patch = (body: object) =>
        fetch(`${baseUrl}/api/admin/applications/${encodeURIComponent(clientId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        });
      const userDetail = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
        headers: { cookie },
      });
      expect(userDetail.status).toBe(200);
      expect(await userDetail.json()).toMatchObject({
        id: user.id,
        email: EMAIL,
        groups: [],
      });
      const groupDetail = await fetch(`${baseUrl}/api/admin/groups/${group.id}`, {
        headers: { cookie },
      });
      expect(groupDetail.status).toBe(200);
      expect(await groupDetail.json()).toMatchObject({ id: group.id, members: [] });
      for (const path of ["/api/admin/users/missing", "/api/admin/groups/missing"]) {
        expect((await fetch(`${baseUrl}${path}`, { headers: { cookie } })).status).toBe(
          404,
        );
      }
      const setUserApplication = (access: string) =>
        fetch(
          `${baseUrl}/api/admin/users/${user.id}/applications/${encodeURIComponent(clientId)}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ access }),
          },
        );
      const setGroupApplication = (enabled: boolean) =>
        fetch(
          `${baseUrl}/api/admin/applications/${encodeURIComponent(clientId)}/groups/${group.id}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ enabled }),
          },
        );
      expect((await setUserApplication("invalid")).status).toBe(400);
      expect((await setUserApplication("allow")).status).toBe(200);
      expect(await db.oauthConsent.count({ where: { clientId } })).toBe(0);
      expect(await db.oauthRefreshToken.count({ where: { clientId } })).toBe(0);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        true,
      );
      expect((await setUserApplication("default")).status).toBe(200);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      await db.mcpGroupUser.create({ data: { userId: user.id, groupId: group.id } });
      expect((await setGroupApplication(false)).status).toBe(200);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      expect((await setGroupApplication(true)).status).toBe(200);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        true,
      );
      expect((await setUserApplication("deny")).status).toBe(200);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      expect((await setUserApplication("default")).status).toBe(200);
      expect((await patch({ uri: baseUrl })).status).toBe(400);
      await db.oauthClient.update({ where: { clientId }, data: { uri: `${baseUrl}/` } });
      expect(
        (await myApplications()).some((application) => application.clientId === clientId),
      ).toBe(false);
      const withoutRack = await fetch(`${baseUrl}/api/admin/applications`, {
        headers: { cookie },
      });
      expect(
        ((await withoutRack.json()) as Array<{ clientId: string }>).some(
          (application) => application.clientId === clientId,
        ),
      ).toBe(false);
      expect((await patch({ disabled: true })).status).toBe(404);
      await db.oauthClient.update({ where: { clientId }, data: { uri: null } });
      expect((await patch({ uri: "not-a-url" })).status).toBe(400);
      expect((await patch({ uri: "javascript:alert(1)" })).status).toBe(400);
      expect((await patch({ uri: "https://user:password@factory.example" })).status).toBe(
        400,
      );
      expect(
        (await patch({ name: "Coding factory", uri: "https://factory.example/" })).status,
      ).toBe(200);
      const publicApplication = (await myApplications()).find(
        (app) => app.clientId === clientId,
      )!;
      expect(publicApplication).toEqual({
        clientId,
        name: "Coding factory",
        url: "https://factory.example/",
      });
      await db.oauthClient.update({
        where: { clientId },
        data: { uri: "javascript:alert(1)" },
      });
      expect((await myApplications()).find((app) => app.clientId === clientId)?.url).toBe(
        null,
      );
      await db.mcpGroupUser.deleteMany({ where: { userId: user.id } });
      expect((await patch({ groupIds: ["unknown"] })).status).toBe(404);
      expect(
        (await patch({ users: [{ userId: "unknown", allowed: true }] })).status,
      ).toBe(404);
      expect(
        (
          await patch({
            users: [
              { userId: user.id, allowed: true },
              { userId: user.id, allowed: false },
            ],
          })
        ).status,
      ).toBe(400);
      expect(
        (await patch({ disabled: true, accessRestricted: true, groupIds: [], users: [] }))
          .status,
      ).toBe(200);
      expect(await db.oauthConsent.count({ where: { clientId } })).toBe(0);
      expect(await db.oauthRefreshToken.count({ where: { clientId } })).toBe(0);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      const disabled = await redirectTarget(await authorize(), baseUrl);
      expect(disabled.searchParams.get("error")).toBeTruthy();
      expect(disabled.searchParams.has("code")).toBe(false);
      await db.user.update({ where: { id: user.id }, data: { role: "user" } });
    },
  );
});
