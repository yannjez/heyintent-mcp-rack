import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type {
  Access,
  DataEntry,
  DataService,
  DataStore,
  Identity,
  McpContext,
  McpDefinition,
  ToolServices,
} from "./types.js";

/**
 * Test harness for MCP packages: runs a definition on an in-memory
 * `McpServer` wired to an SDK `Client`, with in-memory technical services.
 * No rack, no database, no network: tools are exercised exactly as a client
 * would, but every dependency is a fake the test controls.
 */

/** In-memory key/value store with the same contract as the rack's `data` service. */
export function memoryStore(): DataStore & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    async get(key) {
      return entries.has(key) ? entries.get(key)! : null;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async list(prefix = "") {
      const now = new Date().toISOString();
      return [...entries]
        .filter(([key]) => key.startsWith(prefix))
        .map<DataEntry>(([key, value]) => ({ key, value, updatedAt: now }));
    },
  };
}

export function memoryDataService(): DataService & {
  user: ReturnType<typeof memoryStore>;
  shared: ReturnType<typeof memoryStore>;
} {
  const user = memoryStore();
  const shared = memoryStore();
  return { ...user, global: shared, user, shared };
}

/** Stand-in for a service the test did not provide: any call fails loudly. */
function unavailable<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: () => () => {
      throw new Error(`Service "${name}" is not available in this test`);
    },
  });
}

export interface TestMcpOptions {
  /** `ctx.settings` (connection parameters); empty = sandbox / demo mode. */
  settings?: Record<string, string>;
  access?: Access;
  identity?: Partial<Identity>;
  /** Fakes for the rack services; missing ones throw when called. */
  tools?: Partial<ToolServices>;
}

export interface TestMcp {
  client: Client;
  data: ReturnType<typeof memoryDataService>;
  /** Names of the tools the server advertises. */
  toolNames(): Promise<string[]>;
  /** Raw tool call, including `isError` results. */
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Structured result of a successful call; throws with the tool's message otherwise. */
  json<T = Record<string, unknown>>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  /** First text block of a successful call; throws with the tool's message otherwise. */
  text(name: string, args?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export function firstText(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

export async function testMcp(
  definition: McpDefinition,
  options: TestMcpOptions = {},
): Promise<TestMcp> {
  const data = options.tools?.data
    ? (options.tools.data as ReturnType<typeof memoryDataService>)
    : memoryDataService();
  const identity: Identity = {
    userId: "user-1",
    email: "user@test.example",
    via: "session",
    grants: { mcps: "*", caps: "*" },
    ...options.identity,
  };
  const ctx: McpContext = {
    mcp: {
      id: `test-${definition.slug}`,
      slug: definition.slug,
      name: definition.name,
      version: definition.version,
      capabilities: definition.capabilities,
    },
    identity,
    access: options.access ?? "write",
    settings: options.settings ?? {},
    tools: {
      llm: options.tools?.llm ?? unavailable("llm"),
      image: options.tools?.image ?? unavailable("image"),
      github: options.tools?.github ?? unavailable("github"),
      data,
    },
    log: { info() {}, warn() {}, error() {} },
  };

  const server = new McpServer({ name: definition.name, version: definition.version });
  await definition.register(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const ok = async (name: string, args?: Record<string, unknown>) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(`${name}: ${firstText(result)}`);
    return result;
  };

  return {
    client,
    data,
    async toolNames() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    call,
    async json<T>(name: string, args?: Record<string, unknown>) {
      return (await ok(name, args)).structuredContent as T;
    },
    async text(name: string, args?: Record<string, unknown>) {
      return firstText(await ok(name, args));
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
