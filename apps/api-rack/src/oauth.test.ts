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

    // OTP sign-in.
    await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, type: "sign-in" }),
    });
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
});
