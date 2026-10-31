import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { defineMcp, type McpDefinition, type McpToolInfo } from "@rack/mcp-kit";

export interface RemoteMcpOptions {
  slug: string;
  name: string;
  description: string;
  version?: string;
  /** Streamable HTTP endpoint of the remote MCP server. */
  url: string;
  /** Headers sent with every request (typically an Authorization bearer). */
  headers: Record<string, string>;
}

export type RemoteToolSummary = McpToolInfo;

export interface RemoteConnectOptions {
  /** Abort the connection (initialize + first request) after this delay. */
  timeoutMs?: number;
}

type JsonSchema = Parameters<typeof fromJsonSchema>[0];

/** Open a client session on the remote server; the caller closes it. */
export async function connectRemote(url: string, headers: Record<string, string>) {
  const client = new Client({ name: "mcp-rack", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

/**
 * Run `work` against a short-lived remote session that is always closed
 * afterwards, and give up after `timeoutMs` even if the server accepted the
 * connection but never answers.
 */
export async function withRemote<T>(
  url: string,
  headers: Record<string, string>,
  work: (client: Client) => Promise<T>,
  options: RemoteConnectOptions = {},
): Promise<T> {
  let client: Client | null = null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    if (!options.timeoutMs) return;
    timer = setTimeout(
      () =>
        reject(new Error(`Remote MCP server timed out after ${options.timeoutMs} ms`)),
      options.timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        client = await connectRemote(url, headers);
        return work(client);
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Never await a close that might hang on an unresponsive server.
    void (client as Client | null)?.close().catch(() => {});
  }
}

/** Tools advertised by a remote server, as the admin UI lists them. */
export async function probeRemote(
  url: string,
  headers: Record<string, string>,
  options: RemoteConnectOptions = {},
): Promise<RemoteToolSummary[]> {
  return withRemote(
    url,
    headers,
    async (client) => {
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? "",
        write: tool.annotations?.readOnlyHint !== true,
      }));
    },
    options,
  );
}

/**
 * Relay a remote MCP server through the rack: its tools are re-registered
 * under the rack's authentication, access levels and journal, and every call
 * is forwarded with the rack's own credential for that server. Users never
 * see the remote credential.
 *
 * `register` opens one upstream session per rack-side session and closes it
 * with it. Catalog discovery must not go through `register` (the recording
 * server used by `describeTools` never closes): use `probeRemote` instead.
 */
export function createRemoteMcp(options: RemoteMcpOptions): McpDefinition {
  return defineMcp({
    slug: options.slug,
    name: options.name,
    version: options.version ?? "0.0.0",
    description: options.description,
    capabilities: [],
    async register(server, ctx) {
      const client = await connectRemote(options.url, options.headers);
      // Tear the upstream session down with the rack-side session.
      const previous = server.server.onclose;
      server.server.onclose = () => {
        previous?.();
        void client.close().catch(() => {});
      };
      let tools;
      try {
        ({ tools } = await client.listTools());
      } catch (error) {
        void client.close().catch(() => {});
        throw error;
      }
      for (const tool of tools) {
        const inputSchema = (tool.inputSchema ?? { type: "object" }) as JsonSchema;
        server.registerTool(
          tool.name,
          {
            title: tool.title ?? tool.name,
            description: tool.description ?? "",
            inputSchema: fromJsonSchema<Record<string, unknown>>(inputSchema),
            ...(tool.outputSchema
              ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchema) }
              : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          },
          async (args) => {
            ctx.log.info("remote tool call", { tool: tool.name });
            const result = await client.callTool({
              name: tool.name,
              arguments: (args ?? {}) as Record<string, unknown>,
            });
            return result;
          },
        );
      }
    },
  });
}
