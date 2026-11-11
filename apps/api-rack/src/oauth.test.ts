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
    // The challenge and the metadata are about this MCP only: a client that
    // follows them asks for `sample`, not for every MCP of the rack.
    expect(challenge.headers.get("www-authenticate")).toContain(
      'scope="mcp:sample:read mcp:sample:write"',
    );
    const resourceMeta = (await (await fetch(metadataUrl!)).json()) as {
      authorization_servers: string[];
      resource: string;
      scopes_supported: string[];
    };
    expect(resourceMeta.resource).toBe(`${baseUrl}/mcp/sample`);
    expect(resourceMeta.scopes_supported).toEqual([
      "mcp:sample:read",
      "mcp:sample:write",
    ]);
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
      resource: `${baseUrl}/mcp/sample`,
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
    // The consent page learns which MCP is being connected from the resource.
    expect(consentRedirect.searchParams.get("resource")).toBe(`${baseUrl}/mcp/sample`);

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
        resource: `${baseUrl}/mcp/sample`,
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

    // The consent was recorded as the rack's own grant, shown to the account.
    const consumers = async () =>
      (await (
        await fetch(`${baseUrl}/api/consumers`, { headers: { cookie } })
      ).json()) as Array<{
        clientIds: string[];
        grants: Array<{ slug: string; access: string | null; max: string | null }>;
      }>;
    const mine = (await consumers()).find((c) => c.clientIds.includes(client.client_id));
    expect(mine?.grants).toEqual([
      expect.objectContaining({ slug: "sample", access: "read", max: "read" }),
    ]);
    // Filed as an application (an agent whose metadata publishes an address),
    // it still holds a right on this account: it stays listed, and revocable.
    await db.oauthClient.update({
      where: { clientId: client.client_id },
      data: { kind: "application" },
    });
    const filed = (await consumers()).find((c) => c.clientIds.includes(client.client_id));
    expect(filed?.grants).toEqual([
      expect.objectContaining({ slug: "sample", access: "read" }),
    ]);
    await db.oauthClient.update({
      where: { clientId: client.client_id },
      data: { kind: "consumer" },
    });
    // The account names the connection: the rack cannot know which account
    // is signed in on the client's side, the user does.
    const named = await fetch(`${baseUrl}/api/consumers/label`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        clientIds: [client.client_id],
        slugs: ["sample"],
        label: "  Vitest, portable perso  ",
      }),
    });
    expect(named.status, await named.text()).toBe(200);
    expect(
      (await consumers()).find((c) => c.clientIds.includes(client.client_id))?.grants[0],
    ).toMatchObject({ slug: "sample", labels: ["Vitest, portable perso"] });

    // A second client of the same agent (same name) shares its card; a
    // declared application bearing that name does not, or one click on
    // « Déconnecter » would revoke two unrelated clients.
    const twinRegistration = await fetch(asMeta.registration_endpoint, {
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
    const twin = (await twinRegistration.json()) as { client_id: string };
    expect(twinRegistration.status).toBe(201);
    applicationIds.push(twin.client_id);
    await db.mcpGrant.create({
      data: {
        clientId: twin.client_id,
        userId: user.id,
        mcpId: sample.id,
        access: "read",
        consentedAccess: "read",
      },
    });
    const cardOf = async (clientId: string) =>
      (await consumers()).find((c) => c.clientIds.includes(clientId));
    expect((await cardOf(client.client_id))?.clientIds.sort()).toEqual(
      [client.client_id, twin.client_id].sort(),
    );
    await db.oauthClient.update({
      where: { clientId: twin.client_id },
      data: { kind: "application" },
    });
    expect((await cardOf(client.client_id))?.clientIds).toEqual([client.client_id]);
    expect((await cardOf(twin.client_id))?.clientIds).toEqual([twin.client_id]);
    // Closed to this account's groups, the application keeps its right, so it
    // stays listed: the right would work again if the policy changed.
    await db.oauthClient.update({
      where: { clientId: twin.client_id },
      data: { accessRestricted: true },
    });
    expect(await cardOf(twin.client_id)).toMatchObject({
      blocked: true,
      grants: [expect.objectContaining({ slug: "sample" })],
    });
    expect(await cardOf(client.client_id)).toMatchObject({ blocked: false });
    await db.mcpGrant.deleteMany({ where: { clientId: twin.client_id } });
    // Without a right, a client the account may not use is not shown.
    expect(await cardOf(twin.client_id)).toBeUndefined();
    const call = () =>
      fetch(`${baseUrl}/mcp/sample`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await call()).status).toBe(200);
    // Withdrawing the MCP cuts the consumer on its next call, token still
    // valid, and sends it back through authorization.
    const withdraw = await fetch(`${baseUrl}/api/consumers/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        clientIds: [client.client_id],
        slug: "sample",
        access: "none",
      }),
    });
    expect(withdraw.status, await withdraw.text()).toBe(200);
    const cut = await call();
    expect(cut.status).toBe(401);
    expect(cut.headers.get("www-authenticate")).toContain("invalid_token");
    expect(await db.oauthConsent.count({ where: { clientId: client.client_id } })).toBe(
      0,
    );
    // Restore the grant: the rest of the scenario is about the other rules.
    await db.mcpGrant.create({
      data: {
        clientId: client.client_id,
        userId: user.id,
        mcpId: sample.id,
        access: "read",
        consentedAccess: "read",
      },
    });
    // A token is bound to its MCP: this one is refused by any other.
    const elsewhere = await fetch(`${baseUrl}/mcp/site-public`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect([401, 404]).toContain(elsewhere.status);

    // Restricting the application without linking any group cuts the access.
    await db.oauthClient.update({
      where: { clientId: client.client_id },
      data: { accessRestricted: true },
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
    await db.oauthClient.update({
      where: { clientId: client.client_id },
      data: { accessRestricted: false },
    });
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

  it("caps the mcp_access claim of renewed tokens by the consumer's level", async () => {
    // An app hosted elsewhere never calls the rack: it reads `mcp_access` from
    // the token, so a lowered level has to be in the next token it is issued.
    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    const group = await db.mcpGroup.findUniqueOrThrow({
      where: { name: "vitest-oauth-group" },
    });
    await db.mcpGroupUser.create({ data: { groupId: group.id, userId: user.id } });
    const resource = `${baseUrl}/mcp/sample`;
    const registration = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Vitest renewing client",
        application_type: "native",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    expect(registration.status).toBe(201);
    applicationIds.push(clientId);

    const verifier = b64url(randomBytes(32));
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid offline_access mcp:sample:read mcp:sample:write",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource,
    });
    const authorize = await fetch(`${baseUrl}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie },
      redirect: "manual",
    });
    const consentRedirect = await redirectTarget(authorize, baseUrl);
    expect(consentRedirect.pathname, consentRedirect.toString()).toBe("/consent");
    const consent = await fetch(`${baseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, cookie },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentRedirect.search.slice(1),
      }),
    });
    const consentBody = (await consent.json()) as { url: string };
    expect(consent.status, JSON.stringify(consentBody)).toBe(200);

    const issue = async (params: Record<string, string>) => {
      const response = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: clientId, resource }),
      });
      const body = (await response.json()) as {
        access_token: string;
        refresh_token: string;
      };
      expect(response.status, JSON.stringify(body)).toBe(200);
      const claims = JSON.parse(
        Buffer.from(body.access_token.split(".")[1]!, "base64url").toString(),
      ) as { mcp_access?: Record<string, string> };
      return { refreshToken: body.refresh_token, access: claims.mcp_access };
    };
    const setLevel = async (access: string) => {
      const response = await fetch(`${baseUrl}/api/consumers/grants`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ clientIds: [clientId], slug: "sample", access }),
      });
      expect(response.status, await response.text()).toBe(200);
    };

    const first = await issue({
      grant_type: "authorization_code",
      code: new URL(consentBody.url).searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
    expect(first.access).toEqual({ sample: "write" });

    await setLevel("read");
    const lowered = await issue({
      grant_type: "refresh_token",
      refresh_token: first.refreshToken,
    });
    expect(lowered.access).toEqual({ sample: "read" });

    // Back within what was consented: no new authorization needed.
    await setLevel("write");
    const restored = await issue({
      grant_type: "refresh_token",
      refresh_token: lowered.refreshToken,
    });
    expect(restored.access).toEqual({ sample: "write" });

    // No grant, no access: scopes and consent alone open nothing.
    await db.mcpGrant.deleteMany({ where: { clientId } });
    const ungranted = await issue({
      grant_type: "refresh_token",
      refresh_token: restored.refreshToken,
    });
    expect(ungranted.access).toEqual({});

    await db.mcpGroupUser.deleteMany({ where: { userId: user.id } });
  });

  it("grants no MCP to a request that names none", async () => {
    // A client configured before each MCP became its own resource, or one
    // that got an MCP address wrong, names the rack as a whole and asks for
    // every MCP at once.
    const registration = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Vitest lost client",
        application_type: "native",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    expect(registration.status).toBe(201);
    applicationIds.push(clientId);
    const authorize = (extra: Record<string, string>) =>
      fetch(
        `${baseUrl}/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_challenge: b64url(createHash("sha256").update("verifier").digest()),
          code_challenge_method: "S256",
          ...extra,
        })}`,
        { headers: { cookie }, redirect: "manual" },
      );

    // Both reach the consent screen, which tells the user what to do. Even if
    // accepted, the rack records no right: the scopes alone open nothing.
    for (const request of [
      { scope: "mcp:sample:read mcp:sample:write", resource: `${baseUrl}/mcp` },
      { scope: "openid mcp:sample:read" },
    ]) {
      const page = await redirectTarget(await authorize(request), baseUrl);
      expect(page.pathname, page.toString()).toBe("/consent");
      const consent = await fetch(`${baseUrl}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl, cookie },
        body: JSON.stringify({ accept: true, oauth_query: page.search.slice(1) }),
      });
      expect(consent.status, await consent.text()).toBe(200);
      expect(await db.mcpGrant.count({ where: { clientId } })).toBe(0);
    }
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
      // The policy under test is the application one, and a client that
      // registers itself is born a consumer: promote it as an admin would.
      await db.oauthClient.update({ where: { clientId }, data: { kind: "application" } });
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
      // Unlinking the group closes the restricted application again.
      await db.applicationGroup.deleteMany({ where: { clientId, groupId: group.id } });
      expect((await authorize()).status).toBe(403);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      await db.applicationGroup.create({ data: { clientId, groupId: group.id } });
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
      // Leaving the authorized group revokes the restricted application live.
      await db.mcpGroupUser.deleteMany({ where: { userId: user.id } });
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
      const setGroupApplication = (enabled: boolean) =>
        fetch(
          `${baseUrl}/api/admin/applications/${encodeURIComponent(clientId)}/groups/${group.id}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ enabled }),
          },
        );
      await db.mcpGroupUser.create({ data: { userId: user.id, groupId: group.id } });
      expect((await setGroupApplication(false)).status).toBe(200);
      expect(await db.oauthConsent.count({ where: { clientId } })).toBe(0);
      expect(await db.oauthRefreshToken.count({ where: { clientId } })).toBe(0);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        false,
      );
      expect((await setGroupApplication(true)).status).toBe(200);
      expect((await myApplications()).some((app) => app.clientId === clientId)).toBe(
        true,
      );
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
      // An application carries the MCP channels of the same product; this one
      // has none, and no OAuth credential ever leaves the rack.
      expect(publicApplication).toEqual({
        clientId,
        name: "Coding factory",
        url: "https://factory.example/",
        resources: [],
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
      // Individual exceptions are gone: the former field is rejected outright.
      expect((await patch({ users: [{ userId: user.id, allowed: true }] })).status).toBe(
        400,
      );
      expect(
        (await patch({ disabled: true, accessRestricted: true, groupIds: [] })).status,
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
