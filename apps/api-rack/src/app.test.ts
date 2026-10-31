import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPrismaClient } from "@rack/database";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { catalog } from "./mcp/catalog.js";
import { freePort } from "./test-helpers.js";

const databaseUrl = process.env.DATABASE_URL;
const EMAIL = "tester@rack.test";
const CLIENT_EMAIL = "client@partner.example";
const PUBLIC_EMAILS = [
  "rack-login-test@gmail.com",
  "rack-login-test@outlook.com",
  "rack-login-test@elsewhere.test",
];
const GROUP_NAME = "vitest-group";
const BASE_GROUP = "vitest-base-group";
const RESOURCE_SLUGS = ["vitest-site", "vitest-remote"];

describe.skipIf(!databaseUrl)("api-rack", () => {
  const db = createPrismaClient(databaseUrl);
  let app: FastifyInstance;
  let baseUrl = "";
  let lastOtp = "";
  let cookie = "";
  let apiKey = "";

  beforeAll(async () => {
    await db.user.deleteMany({
      where: { email: { in: [EMAIL, CLIENT_EMAIL, ...PUBLIC_EMAILS] } },
    });
    await db.mcpGroup.deleteMany({ where: { name: { in: [GROUP_NAME, BASE_GROUP] } } });
    await db.mcp.deleteMany({ where: { slug: { in: RESOURCE_SLUGS } } });
    await db.mcp.updateMany({
      where: { slug: "sample" },
      data: { enabled: true, allowedCapabilities: [] },
    });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        NODE_ENV: "development",
        BETTER_AUTH_URL: baseUrl,
        PORT: String(port),
        ADMIN_EMAILS: EMAIL,
      }),
      db,
      catalog,
      logger: false,
      sendOtp: async (_email, otp) => {
        lastOtp = otp;
      },
      toolConfig: {
        openRouter: {
          apiKey: "test",
          defaultModel: "test/model",
          allowedModels: [],
          imageModel: "test/image",
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [{ message: { content: "résumé" } }],
                usage: { cost: 0.01 },
              }),
            ),
        },
      },
    });
    await app.listen({ port, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
    await db.user.deleteMany({
      where: { email: { in: [EMAIL, CLIENT_EMAIL, ...PUBLIC_EMAILS] } },
    });
    await db.mcpGroup.deleteMany({ where: { name: { in: [GROUP_NAME, BASE_GROUP] } } });
    await db.mcp.deleteMany({ where: { slug: { in: RESOURCE_SLUGS } } });
    await db.$disconnect();
  });

  it("serves health and discovery documents", async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    expect(health).toMatchObject({
      status: "ok",
      mcps: expect.arrayContaining(["sample", "site-public"]),
    });

    const as = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const asDoc = (await as.json()) as {
      authorization_endpoint: string;
      registration_endpoint?: string;
    };
    expect(asDoc.authorization_endpoint).toContain("/oauth2/authorize");
    expect(asDoc.registration_endpoint).toContain("/oauth2/register");

    const pr = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(pr.status).toBe(200);
    const prDoc = (await pr.json()) as { resource: string; scopes_supported?: string[] };
    expect(prDoc.scopes_supported).toContain("mcp:sample:read");
    expect(prDoc.scopes_supported).toContain("mcp:site-public:write");
  });

  it("hands browser requests for UI pages to the Vite dev server", async () => {
    const consent = await fetch(`${baseUrl}/consent?client_id=x&scope=openid`, {
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(consent.status).toBe(302);
    expect(consent.headers.get("location")).toBe(
      "http://localhost:5173/consent?client_id=x&scope=openid",
    );
    const json = await fetch(`${baseUrl}/nope`, {
      headers: { accept: "application/json" },
    });
    expect(json.status).toBe(404);
  });

  it("challenges unauthenticated MCP calls with RFC 9728 metadata", async () => {
    const response = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("accepts OTP requests from the Vite development origin", async () => {
    const response = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: EMAIL, type: "sign-in" }),
    });
    expect(response.status, await response.text()).toBe(200);
    expect(lastOtp).toMatch(/^\d{6}$/);
  });

  it("signs in with an email OTP and becomes admin", async () => {
    const send = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, type: "sign-in" }),
    });
    expect(send.status, await send.text()).toBe(200);
    expect(lastOtp).toMatch(/^\d{6}$/);

    const verify = await fetch(`${baseUrl}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, otp: lastOtp }),
    });
    expect(verify.status, await verify.clone().text()).toBe(200);
    cookie = (verify.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("better-auth");

    const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email: EMAIL, isAdmin: true });
    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    // Admin role permits management, but does not bypass MCP group availability.
    expect(await app.registry.userAccesses(user.id, true)).toEqual({});
    await db.mcpGroup.create({
      data: {
        name: BASE_GROUP,
        mcps: { create: (await db.mcp.findMany()).map((mcp) => ({ mcpId: mcp.id })) },
        users: { create: { userId: user.id } },
      },
    });
    await db.mcpAccess.createMany({
      data: (await db.mcp.findMany()).map((mcp) => ({
        mcpId: mcp.id,
        userId: user.id,
        access: "write",
      })),
    });
  });

  it.each(PUBLIC_EMAILS)(
    "signs in a new user from any email domain: %s",
    async (email) => {
      const send = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ email, type: "sign-in" }),
      });
      expect(send.status, await send.text()).toBe(200);
      expect(lastOtp).toMatch(/^\d{6}$/);
      const verify = await fetch(`${baseUrl}/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ email, otp: lastOtp }),
      });
      expect(verify.status, await verify.clone().text()).toBe(200);
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      expect(user.role).toBe("user");
      expect(user.emailVerified).toBe(true);
      expect(await app.registry.userAccesses(user.id)).toEqual({});
    },
  );

  it("rejects an invalid email address", async () => {
    const send = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: "invalid-email", type: "sign-in" }),
    });
    expect(send.status).toBe(400);
  });

  it("lists the MCPs the admin may use, with their tools", async () => {
    const mcps = (await (
      await fetch(`${baseUrl}/api/mcps`, { headers: { cookie } })
    ).json()) as Array<{
      slug: string;
      access: string;
      tools: Array<{ name: string; write: boolean }>;
    }>;
    const sample = mcps.find((m) => m.slug === "sample");
    expect(sample?.access).toBe("write");
    expect(sample?.tools.find((t) => t.name === "echo")?.write).toBe(false);
    expect(sample?.tools.find((t) => t.name === "remember")?.write).toBe(true);
    expect(mcps.map((m) => m.slug)).toEqual(
      expect.arrayContaining(["site-public", "sample"]),
    );
  });

  it("creates an API key with write access to the sample MCP", async () => {
    const create = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "test key", mcps: { sample: "write" } }),
    });
    const body = (await create.json()) as { key?: string; grants?: unknown };
    expect(create.status, JSON.stringify(body)).toBe(201);
    expect(body.grants).toEqual({ mcps: { sample: "write" }, caps: "*" });
    expect(body.key).toMatch(/^rk_/);
    apiKey = body.key!;
  });

  it("runs MCP tools with the API key and journals the calls", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp/sample`),
      {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      },
    );
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["echo", "summarize", "remember", "recall", "make_image"]),
    );

    const echo = await client.callTool({ name: "echo", arguments: { message: "hi" } });
    expect(echo.structuredContent).toMatchObject({
      message: "hi",
      via: "apikey",
      access: "write",
    });

    await client.callTool({
      name: "remember",
      arguments: { key: "color", value: "blue" },
    });
    const recall = await client.callTool({ name: "recall", arguments: { key: "color" } });
    expect(recall.structuredContent).toEqual({ key: "color", value: "blue" });

    const summary = await client.callTool({
      name: "summarize",
      arguments: { text: "long text" },
    });
    expect(summary.content).toEqual([{ type: "text", text: "résumé" }]);

    await client.close();

    const calls = await db.toolCall.findMany({
      where: { tool: "llm.complete" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(calls[0]).toMatchObject({ ok: true });
    expect(Number(calls[0]?.cost)).toBeCloseTo(0.01);
    const logs = (await (
      await fetch(`${baseUrl}/api/admin/logs?slug=sample&limit=20`, {
        headers: { cookie },
      })
    ).json()) as Array<{ tool: string; ok: boolean; userEmail: string | null }>;
    expect(logs.find((l) => l.tool === "summarize")).toMatchObject({
      ok: true,
      userEmail: EMAIL,
    });
  });

  it("reads the demo content of the public site through the site-public MCP", async () => {
    // The key only names "sample": other MCPs are refused.
    const refused = await fetch(`${baseUrl}/mcp/site-public`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(403);

    const create = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "all mcps", mcps: {} }),
    });
    const { key } = (await create.json()) as { key: string };
    const site = new Client({ name: "test", version: "0.0.0" });
    await site.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/site-public`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    const result = await site.callTool({
      name: "list_content",
      arguments: { type: "page", status: "published" },
    });
    const { mode, items } = result.structuredContent as {
      mode: string;
      items: Array<{ slug: string }>;
    };
    expect(mode).toBe("sandbox");
    expect(items.map((item) => item.slug)).toEqual(
      expect.arrayContaining(["accueil", "agents-ia", "methode"]),
    );
    await site.close();
  });

  it("lets the admin create a client user outside the email allowlist and assign read access", async () => {
    const create = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: CLIENT_EMAIL, name: "Partner", kind: "client" }),
    });
    const created = (await create.json()) as { id: string };
    expect(create.status, JSON.stringify(created)).toBe(201);

    const assign = await fetch(`${baseUrl}/api/admin/users/${created.id}/mcps/sample`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ access: "read" }),
    });
    expect(await assign.json()).toEqual({ slug: "sample", access: "read" });

    const users = (await (
      await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie } })
    ).json()) as Array<{ email: string; kind: string; mcps: Record<string, string> }>;
    expect(users.find((u) => u.email === CLIENT_EMAIL)).toMatchObject({
      kind: "client",
      mcps: { sample: "read" },
    });

    // The pre-created account signs in despite the domain allowlist.
    const send = await fetch(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: CLIENT_EMAIL, type: "sign-in" }),
    });
    expect(send.status, await send.text()).toBe(200);
    const verify = await fetch(`${baseUrl}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: CLIENT_EMAIL, otp: lastOtp }),
    });
    expect(verify.status, await verify.clone().text()).toBe(200);
    const clientCookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const me = (await (
      await fetch(`${baseUrl}/api/me`, { headers: { cookie: clientCookie } })
    ).json()) as { kind: string; isAdmin: boolean };
    expect(me).toMatchObject({ kind: "client", isAdmin: false });
    const mine = (await (
      await fetch(`${baseUrl}/api/mcps`, { headers: { cookie: clientCookie } })
    ).json()) as Array<{ slug: string; access: string }>;
    expect(mine).toEqual([]);
    expect(await app.registry.userAccesses(created.id)).toEqual({});
    // Assigning rights alone cannot bypass group availability.
    const baseGroup = await db.mcpGroup.findUniqueOrThrow({
      where: { name: BASE_GROUP },
    });
    const join = await fetch(`${baseUrl}/api/admin/users/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ groupIds: [baseGroup.id] }),
    });
    expect(join.status).toBe(200);
    const available = await (
      await fetch(`${baseUrl}/api/mcps`, { headers: { cookie: clientCookie } })
    ).json();
    expect(available).toContainEqual(
      expect.objectContaining({ slug: "sample", access: "read" }),
    );

    // A write key is refused; a read key only exposes read-only tools.
    const refused = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: clientCookie },
      body: JSON.stringify({ name: "nope", mcps: { sample: "write" } }),
    });
    expect(refused.status).toBe(403);
    const readKey = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: clientCookie },
      body: JSON.stringify({ name: "reader", mcps: {} }),
    });
    const { key } = (await readKey.json()) as { key: string };
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/sample`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toContain("recall");
    expect(names).not.toContain("remember");
    await mcp.close();
  });

  it("assigns multiple availability groups while keeping rights on users", async () => {
    const headers = { "content-type": "application/json", cookie };
    const create = await fetch(`${baseUrl}/api/admin/groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: GROUP_NAME,
        description: "Groupe de test",
        mcps: ["site-public"],
      }),
    });
    const group = (await create.json()) as { id: string; mcps: string[] };
    expect(create.status, JSON.stringify(group)).toBe(201);
    expect(group.mcps).toEqual(["site-public"]);

    // Same name twice is refused; the group can grow afterwards.
    const dup = await fetch(`${baseUrl}/api/admin/groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: GROUP_NAME }),
    });
    expect(dup.status).toBe(409);
    const grant = await fetch(`${baseUrl}/api/admin/mcps/sample/groups/${group.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(await grant.json()).toEqual({ slug: "sample", enabled: true });

    // The client user (individually: sample read) joins the group.
    const users = (await (
      await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie } })
    ).json()) as Array<{ id: string; email: string }>;
    const client = users.find((u) => u.email === CLIENT_EMAIL)!;
    const baseGroup = await db.mcpGroup.findUniqueOrThrow({
      where: { name: BASE_GROUP },
    });
    const join = await fetch(`${baseUrl}/api/admin/users/${client.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ groupIds: [baseGroup.id, group.id] }),
    });
    expect(await join.json()).toMatchObject({ groupIds: [baseGroup.id, group.id] });
    const unknown = await fetch(`${baseUrl}/api/admin/users/${client.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ groupIds: ["nope"] }),
    });
    expect(unknown.status).toBe(404);

    const listed = (await (
      await fetch(`${baseUrl}/api/admin/groups`, { headers: { cookie } })
    ).json()) as Array<{ id: string; userCount: number; members: Array<{ id: string }> }>;
    expect(listed.find((g) => g.id === group.id)).toMatchObject({
      userCount: 1,
      members: [expect.objectContaining({ id: client.id })],
    });
    const withGroup = (await (
      await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie } })
    ).json()) as Array<{ email: string; groups: Array<{ id: string; name: string }> }>;
    expect(withGroup.find((u) => u.email === CLIENT_EMAIL)?.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: group.id, name: GROUP_NAME }),
        expect.objectContaining({ id: baseGroup.id }),
      ]),
    );

    // Removing one group keeps availability through another group.
    expect(await app.registry.userAccesses(client.id)).toMatchObject({
      sample: "read",
      "site-public": "read",
    });
    const sampleId = (await db.mcp.findUniqueOrThrow({ where: { slug: "sample" } })).id;
    expect(await app.registry.userAccess(client.id, sampleId)).toBe("read");
    await fetch(`${baseUrl}/api/admin/groups/${group.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(await app.registry.userAccess(client.id, sampleId)).toBe("read");
    // An individual "none" blocks the MCP despite the group; "default" lifts the block.
    const block = await fetch(`${baseUrl}/api/admin/users/${client.id}/mcps/sample`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ access: "none" }),
    });
    expect(await block.json()).toEqual({ slug: "sample", access: "none" });
    expect(await app.registry.userAccess(client.id, sampleId)).toBeNull();
    expect(await app.registry.userAccesses(client.id)).not.toHaveProperty("sample");
    const lift = await fetch(`${baseUrl}/api/admin/users/${client.id}/mcps/sample`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ access: "default" }),
    });
    expect(await lift.json()).toEqual({ slug: "sample", access: null });
    expect(await app.registry.userAccess(client.id, sampleId)).toBe("read");
    await db.mcpAccess.upsert({
      where: { mcpId_userId: { mcpId: sampleId, userId: client.id } },
      create: { mcpId: sampleId, userId: client.id, access: "read" },
      update: { access: "read" },
    });
    // Individual write rights still cannot bypass the last membership removal.
    await db.mcpAccess.update({
      where: { mcpId_userId: { mcpId: sampleId, userId: client.id } },
      data: { access: "write" },
    });
    expect(await app.registry.userAccess(client.id, sampleId)).toBe("write");
    await fetch(`${baseUrl}/api/admin/users/${client.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ groupIds: [] }),
    });
    expect(await app.registry.userAccesses(client.id)).toEqual({});
    expect(await app.registry.userAccess(client.id, sampleId)).toBeNull();
  });

  it("refuses the key on another MCP slug and invalid keys", async () => {
    const other = await fetch(`${baseUrl}/mcp/nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(other.status).toBe(404);

    const bad = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: { authorization: "Bearer rk_invalid", "content-type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
  });

  it("revokes an existing API key when its last group is removed from the MCP", async () => {
    const group = await db.mcpGroup.findUniqueOrThrow({ where: { name: BASE_GROUP } });
    const headers = { "content-type": "application/json", cookie };
    const url = `${baseUrl}/api/admin/mcps/sample/groups/${group.id}`;
    const remove = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(remove.status).toBe(200);
    const denied = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);
    const restore = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(restore.status).toBe(200);
  });

  it("lets the admin disable an MCP and list keys", async () => {
    const patch = await fetch(`${baseUrl}/api/admin/mcps/sample`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ enabled: false }),
    });
    expect(await patch.json()).toMatchObject({ slug: "sample", enabled: false });

    const disabled = await fetch(`${baseUrl}/mcp/sample`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(disabled.status).toBe(404);

    await fetch(`${baseUrl}/api/admin/mcps/sample`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ enabled: true }),
    });

    const keys = (await (
      await fetch(`${baseUrl}/api/admin/keys`, { headers: { cookie } })
    ).json()) as Array<{
      name: string;
      owner: { email: string };
    }>;
    expect(keys.find((k) => k.name === "test key")?.owner.email).toBe(EMAIL);
  });

  it("lets the admin add a public site resource, served without a restart", async () => {
    const headers = { "content-type": "application/json", cookie };
    const refused = await fetch(`${baseUrl}/api/admin/resources`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "site", slug: "sample", name: "Clash", config: {} }),
    });
    expect(refused.status).toBe(400);
    const create = await fetch(`${baseUrl}/api/admin/resources`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "site",
        slug: "vitest-site",
        name: "Site de test",
        description: "Un site ajouté par l'admin",
        config: { apiUrl: "http://127.0.0.1:9/api", apiToken: "secret-token" },
      }),
    });
    const created = (await create.json()) as {
      slug: string;
      kind: string;
      config: { apiUrl: string; hasToken: boolean };
      tools: Array<{ name: string }>;
      url: string;
    };
    expect(create.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject({
      slug: "vitest-site",
      kind: "site",
      config: { apiUrl: "http://127.0.0.1:9/api", hasToken: true },
      url: `${baseUrl}/mcp/vitest-site`,
    });
    expect(created.tools.map((t) => t.name)).toContain("list_content");
    // The secret is encrypted at rest, and the same slug is refused twice.
    const row = await db.mcp.findUniqueOrThrow({ where: { slug: "vitest-site" } });
    expect((row.config as { apiToken: string }).apiToken).toMatch(/^enc:v1:/);
    const dup = await fetch(`${baseUrl}/api/admin/resources`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "site",
        slug: "vitest-site",
        name: "Encore",
        config: { apiUrl: "http://127.0.0.1:9/api" },
      }),
    });
    expect(dup.status).toBe(409);

    // OAuth clients may now ask for its scopes.
    const pr = (await (
      await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { scopes_supported?: string[] };
    expect(pr.scopes_supported).toContain("mcp:vitest-site:write");

    // Availability still goes through groups; the site then answers over MCP.
    const baseGroup = await db.mcpGroup.findUniqueOrThrow({
      where: { name: BASE_GROUP },
    });
    await fetch(`${baseUrl}/api/admin/mcps/vitest-site/groups/${baseGroup.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    const keyResponse = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "site key", mcps: {} }),
    });
    const { key } = (await keyResponse.json()) as { key: string };
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/vitest-site`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("list_content");
    // The configured API is unreachable: the error is reported, not thrown.
    const listed = await client.callTool({ name: "list_content", arguments: {} });
    expect(listed.isError).toBe(true);
    await client.close();

    const probe = (await (
      await fetch(`${baseUrl}/api/admin/resources/probe`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "site",
          slug: "vitest-site",
          config: { apiUrl: "http://127.0.0.1:9/api" },
        }),
      })
    ).json()) as { ok: boolean };
    expect(probe.ok).toBe(false);

    // Editing keeps the stored secret when none is typed; packages are read-only.
    const patch = await fetch(`${baseUrl}/api/admin/mcps/vitest-site`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        name: "Site renommé",
        config: { apiUrl: "http://127.0.0.1:9/v2", apiToken: "" },
      }),
    });
    expect(await patch.json()).toMatchObject({
      name: "Site renommé",
      config: { apiUrl: "http://127.0.0.1:9/v2", hasToken: true },
    });
    const locked = await fetch(`${baseUrl}/api/admin/mcps/sample`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(locked.status).toBe(400);
    const keep = await fetch(`${baseUrl}/api/admin/mcps/sample`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(keep.status).toBe(404);

    const remove = await fetch(`${baseUrl}/api/admin/mcps/vitest-site`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(remove.status).toBe(200);
    const gone = await fetch(`${baseUrl}/mcp/vitest-site`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(gone.status).toBe(404);
  });

  it("relays a remote MCP server with the rack's own credential and access levels", async () => {
    const headers = { "content-type": "application/json", cookie };
    // The rack's sample MCP stands in for the remote server, reached with the write key.
    const create = await fetch(`${baseUrl}/api/admin/resources`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "remote",
        slug: "vitest-remote",
        name: "MCP distant",
        config: { url: `${baseUrl}/mcp/sample`, token: apiKey },
      }),
    });
    const created = (await create.json()) as {
      kind: string;
      config: { url: string; hasToken: boolean };
      tools: Array<{ name: string; write: boolean }>;
    };
    expect(create.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject({
      kind: "remote",
      config: {
        url: `${baseUrl}/mcp/sample`,
        headerName: "Authorization",
        hasToken: true,
      },
    });
    expect(created.tools.find((t) => t.name === "echo")?.write).toBe(false);
    expect(created.tools.find((t) => t.name === "remember")?.write).toBe(true);

    const probe = (await (
      await fetch(`${baseUrl}/api/admin/resources/probe`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "remote",
          slug: "vitest-remote",
          config: { url: `${baseUrl}/mcp/sample` },
        }),
      })
    ).json()) as { ok: boolean; tools?: Array<{ name: string }> };
    expect(probe.ok).toBe(true);
    expect(probe.tools?.map((t) => t.name)).toContain("echo");

    const baseGroup = await db.mcpGroup.findUniqueOrThrow({
      where: { name: BASE_GROUP },
    });
    await fetch(`${baseUrl}/api/admin/mcps/vitest-remote/groups/${baseGroup.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    const keyResponse = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "remote key", mcps: {} }),
    });
    const { key } = (await keyResponse.json()) as { key: string };

    // Read by default on a new resource: write tools stay hidden.
    const reader = new Client({ name: "test", version: "0.0.0" });
    await reader.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/vitest-remote`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    const readNames = (await reader.listTools()).tools.map((t) => t.name);
    expect(readNames).toContain("echo");
    expect(readNames).not.toContain("remember");
    const echo = await reader.callTool({ name: "echo", arguments: { message: "relay" } });
    expect(echo.structuredContent).toMatchObject({ message: "relay", via: "apikey" });
    await reader.close();

    // Granting write on the relay exposes the remote write tools.
    const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await fetch(`${baseUrl}/api/admin/users/${user.id}/mcps/vitest-remote`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ access: "write" }),
    });
    const writer = new Client({ name: "test", version: "0.0.0" });
    await writer.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/vitest-remote`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    expect((await writer.listTools()).tools.map((t) => t.name)).toContain("remember");
    await writer.close();
    const journal = await db.toolCall.findMany({
      where: { mcp: { slug: "vitest-remote" }, tool: "echo" },
    });
    expect(journal.length).toBeGreaterThan(0);
  });
});
