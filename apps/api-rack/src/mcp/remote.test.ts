import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { testMcp } from "@rack/mcp-kit/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { createRemoteMcp, probeRemote, rackIdentityHeaders } from "./remote.js";

/** A rack context as `register` receives it, with only the fields the headers use. */
const ctx = {
  identity: { userId: "user-42", email: "ada@example.com", via: "oauth" as const },
  access: "write" as const,
  mcp: { slug: "matiere-de-lien" },
};

describe("rackIdentityHeaders", () => {
  it("describes the user, access level and resource alongside the static credential", () => {
    expect(rackIdentityHeaders(ctx, { authorization: "Bearer rack" })).toEqual({
      "x-rack-user": "user-42",
      "x-rack-user-email": "ada@example.com",
      "x-rack-access": "write",
      "x-rack-slug": "matiere-de-lien",
      "x-rack-via": "oauth",
    });
  });

  it("sends nothing without a static credential", () => {
    expect(rackIdentityHeaders(ctx, {})).toEqual({});
  });

  it("drops values that are not valid header values instead of throwing", () => {
    const headers = rackIdentityHeaders(
      {
        ...ctx,
        identity: { ...ctx.identity, userId: "line\r\nbreak", email: "éric@example.com" },
      },
      { "x-api-key": "rack" },
    );
    expect(headers).toEqual({
      "x-rack-access": "write",
      "x-rack-slug": "matiere-de-lien",
      "x-rack-via": "oauth",
    });
  });
});

/**
 * Minimal remote MCP server over Streamable HTTP that records the headers of
 * every request it receives, so the tests can inspect the `initialize` call.
 */
interface SeenRequest {
  method: string | null;
  headers: Record<string, string>;
}

function startRemoteServer() {
  const seen: SeenRequest[] = [];
  const handler = createMcpHandler(
    async () => {
      const server = new McpServer({ name: "remote", version: "0.0.0" });
      server.registerTool(
        "ping",
        {
          title: "Ping",
          description: "Answers pong.",
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        },
        async () => ({ content: [{ type: "text", text: "pong" }] }),
      );
      server.registerTool(
        "write",
        { title: "Write", description: "A write tool.", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: "written" }] }),
      );
      return server;
    },
    { legacy: "stateless" },
  );
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const headers = new Headers();
    const flat: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const joined = Array.isArray(value) ? value.join(", ") : value;
      flat[name] = joined;
      if (name !== "content-length") headers.set(name, joined);
    }
    let method: string | null = null;
    try {
      method = (JSON.parse(body) as { method?: string }).method ?? null;
    } catch {
      /* not a JSON body (GET, DELETE) */
    }
    seen.push({ method, headers: flat });
    const response = await handler.fetch(
      new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        headers,
        ...(body ? { body } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  });
  return {
    seen,
    async listen() {
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return `http://127.0.0.1:${port}/mcp`;
    },
    async close() {
      await handler.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

function rackHeadersOf(request: SeenRequest | undefined) {
  return Object.fromEntries(
    Object.entries(request?.headers ?? {}).filter(([name]) => name.startsWith("x-rack-")),
  );
}

describe("remote MCP relay", () => {
  const remote = startRemoteServer();
  let url = "";

  beforeAll(async () => {
    url = await remote.listen();
  });
  afterAll(() => remote.close());

  function initialize() {
    return remote.seen.find((request) => request.method === "initialize");
  }

  function relay(headers: Record<string, string>) {
    return createRemoteMcp({
      slug: "matiere-de-lien",
      name: "Matière de Lien",
      description: "",
      url,
      headers,
    });
  }

  it("forwards the user's identity and access level with the rack's credential", async () => {
    remote.seen.length = 0;
    const mcp = await testMcp(relay({ authorization: "Bearer rack-secret" }), {
      identity: { userId: "user-42", email: "ada@example.com", via: "oauth" },
      access: "write",
    });
    try {
      expect(await mcp.toolNames()).toEqual(["ping", "write"]);
      expect(await mcp.text("ping")).toBe("pong");
      const init = initialize();
      expect(init?.headers.authorization).toBe("Bearer rack-secret");
      expect(rackHeadersOf(init)).toEqual({
        "x-rack-user": "user-42",
        "x-rack-user-email": "ada@example.com",
        "x-rack-access": "write",
        "x-rack-slug": "matiere-de-lien",
        "x-rack-via": "oauth",
      });
      // Every request of the upstream session carries them, not only initialize.
      const calls = remote.seen.filter((r) => r.method === "tools/call");
      expect(calls.length).toBeGreaterThan(0);
      for (const request of calls) {
        expect(rackHeadersOf(request)["x-rack-user"]).toBe("user-42");
      }
    } finally {
      await mcp.close();
    }
  });

  it("reports the read access level of the rack session", async () => {
    remote.seen.length = 0;
    const mcp = await testMcp(relay({ "x-api-key": "rack-secret" }), { access: "read" });
    try {
      await mcp.toolNames();
      expect(rackHeadersOf(initialize())["x-rack-access"]).toBe("read");
      expect(initialize()?.headers["x-api-key"]).toBe("rack-secret");
    } finally {
      await mcp.close();
    }
  });

  it("sends no identity without a static credential", async () => {
    remote.seen.length = 0;
    const mcp = await testMcp(relay({}), {
      identity: { userId: "user-42", email: "ada@example.com", via: "oauth" },
      access: "write",
    });
    try {
      expect(await mcp.toolNames()).toEqual(["ping", "write"]);
      expect(initialize()).toBeDefined();
      expect(rackHeadersOf(initialize())).toEqual({});
    } finally {
      await mcp.close();
    }
  });

  it("probes the catalog without any identity", async () => {
    remote.seen.length = 0;
    const tools = await probeRemote(
      url,
      { authorization: "Bearer rack-secret" },
      { timeoutMs: 5_000 },
    );
    expect(tools.map((t) => [t.name, t.write])).toEqual([
      ["ping", false],
      ["write", true],
    ]);
    expect(remote.seen.length).toBeGreaterThan(0);
    for (const request of remote.seen) {
      expect(rackHeadersOf(request)).toEqual({});
      expect(request.headers.authorization).toBe("Bearer rack-secret");
    }
  });

  it("omits the email header when the identity has none", async () => {
    remote.seen.length = 0;
    const mcp = await testMcp(relay({ authorization: "Bearer rack-secret" }), {
      identity: { userId: "key-user", email: undefined, via: "apikey" },
      access: "write",
    });
    try {
      await mcp.toolNames();
      expect(rackHeadersOf(initialize())).toEqual({
        "x-rack-user": "key-user",
        "x-rack-access": "write",
        "x-rack-slug": "matiere-de-lien",
        "x-rack-via": "apikey",
      });
    } finally {
      await mcp.close();
    }
  });

  it("omits a non-ASCII value without failing the session", async () => {
    remote.seen.length = 0;
    const mcp = await testMcp(relay({ authorization: "Bearer rack-secret" }), {
      identity: { userId: "user-42", email: "éric@example.com", via: "session" },
      access: "write",
    });
    try {
      expect(await mcp.toolNames()).toEqual(["ping", "write"]);
      expect(rackHeadersOf(initialize())).toEqual({
        "x-rack-user": "user-42",
        "x-rack-access": "write",
        "x-rack-slug": "matiere-de-lien",
        "x-rack-via": "session",
      });
    } finally {
      await mcp.close();
    }
  });
});
