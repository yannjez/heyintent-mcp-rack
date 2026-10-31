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
  /** Deadline for opening a live session (initialize + tools/list). */
  connectTimeoutMs?: number;
}

export type RemoteToolSummary = McpToolInfo;

export interface RemoteConnectOptions {
  /** Abort the connection (initialize + first request) after this delay. */
  timeoutMs?: number;
}

/** Default deadline for every upstream handshake, live sessions included. */
export const REMOTE_CONNECT_TIMEOUT_MS = 15_000;

type JsonSchema = Parameters<typeof fromJsonSchema>[0];

export interface RemoteSession {
  client: Client;
  /** Closes the transport (aborting any in-flight request) without ever hanging. */
  close(): void;
}

/**
 * Reject after `ms` and run `onTimeout` so the pending work is torn down:
 * a server that accepts the connection but never answers must not keep a
 * socket, a transport or a rack request alive.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Remote MCP server timed out after ${ms} ms (${what})`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // The losing branch may still settle later: never let it surface as unhandled.
    work.catch(() => {});
  }
}

/**
 * Open a client session on the remote server within `timeoutMs`; the caller
 * closes it. On timeout the transport is closed, which aborts the pending
 * initialize request instead of leaving it dangling.
 */
export async function openRemote(
  url: string,
  headers: Record<string, string>,
  timeoutMs = REMOTE_CONNECT_TIMEOUT_MS,
): Promise<RemoteSession> {
  const client = new Client({ name: "mcp-rack", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  const close = () => {
    void transport.close().catch(() => {});
    void client.close().catch(() => {});
  };
  try {
    await withDeadline(client.connect(transport), timeoutMs, close, "initialize");
  } catch (error) {
    close();
    throw error;
  }
  return { client, close };
}

/** Tools advertised by a remote server, as the admin UI lists them. */
export async function probeRemote(
  url: string,
  headers: Record<string, string>,
  options: RemoteConnectOptions = {},
): Promise<RemoteToolSummary[]> {
  const timeoutMs = options.timeoutMs ?? REMOTE_CONNECT_TIMEOUT_MS;
  const session = await openRemote(url, headers, timeoutMs);
  try {
    const { tools } = await withDeadline(
      session.client.listTools(),
      timeoutMs,
      session.close,
      "tools/list",
    );
    return tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description ?? "",
      write: tool.annotations?.readOnlyHint !== true,
    }));
  } finally {
    session.close();
  }
}

/**
 * Relay a remote MCP server through the rack: its tools are re-registered
 * under the rack's authentication, access levels and journal, and every call
 * is forwarded with the rack's own credential for that server. Users never
 * see the remote credential.
 *
 * `register` opens one upstream session per rack-side session, bounded by
 * `connectTimeoutMs`, and closes it with it. Catalog discovery must not go
 * through `register` (the recording server used by `describeTools` never
 * closes): use `probeRemote` instead.
 */
export function createRemoteMcp(options: RemoteMcpOptions): McpDefinition {
  const timeoutMs = options.connectTimeoutMs ?? REMOTE_CONNECT_TIMEOUT_MS;
  return defineMcp({
    slug: options.slug,
    name: options.name,
    version: options.version ?? "0.0.0",
    description: options.description,
    capabilities: [],
    async register(server, ctx) {
      const session = await openRemote(options.url, options.headers, timeoutMs);
      // Tear the upstream session down with the rack-side session.
      const previous = server.server.onclose;
      server.server.onclose = () => {
        previous?.();
        session.close();
      };
      let tools;
      try {
        ({ tools } = await withDeadline(
          session.client.listTools(),
          timeoutMs,
          session.close,
          "tools/list",
        ));
      } catch (error) {
        session.close();
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
            const result = await session.client.callTool({
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
