import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import {
  defineMcp,
  type McpContext,
  type McpDefinition,
  type McpToolInfo,
} from "@rack/mcp-kit";

export interface RemoteMcpOptions {
  slug: string;
  name: string;
  description: string;
  version?: string;
  /** Streamable HTTP endpoint of the remote MCP server. */
  url: string;
  /** Headers sent with every request (typically an Authorization bearer). */
  headers: Record<string, string>;
  /**
   * Add the rack user's identity and access level (`X-Rack-*`) to every
   * upstream session. Only honoured when `headers` carries a credential.
   */
  forwardIdentity?: boolean;
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

/** Printable ASCII without CR/LF: safe as an HTTP header value. */
function isHeaderValue(value: string): boolean {
  return value.length > 0 && /^[ -~]+$/.test(value);
}

/**
 * Identity headers the rack adds to an upstream session so the remote server
 * can journal the end user and apply its own access rules. They are only
 * meaningful alongside the rack's static credential for that server: without
 * one (`staticHeaders` empty), nothing is added, so a remote server must only
 * trust `X-Rack-*` when the credential it knows accompanies them. Values that
 * would not survive as HTTP header values are dropped rather than failing the
 * session.
 */
export function rackIdentityHeaders(
  ctx: Pick<McpContext, "identity" | "access" | "mcp">,
  staticHeaders: Record<string, string>,
): Record<string, string> {
  if (Object.keys(staticHeaders).length === 0) return {};
  const candidates: Record<string, string | undefined> = {
    "x-rack-user": ctx.identity.userId,
    "x-rack-user-email": ctx.identity.email,
    "x-rack-access": ctx.access,
    "x-rack-slug": ctx.mcp.slug,
    "x-rack-via": ctx.identity.via,
  };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidates)) {
    if (typeof value === "string" && isHeaderValue(value)) headers[name] = value;
  }
  return headers;
}

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
 * `connectTimeoutMs`, and closes it with it. With `forwardIdentity`, that
 * session also carries the end user's identity and access level in `X-Rack-*`
 * headers (see `rackIdentityHeaders`). Catalog discovery must not go through
 * `register` (the recording server used by `describeTools` never closes):
 * use `probeRemote` instead, which sends only the static headers so the
 * remote server lists its whole catalog.
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
      const headers = {
        ...options.headers,
        ...(options.forwardIdentity ? rackIdentityHeaders(ctx, options.headers) : {}),
      };
      const session = await openRemote(options.url, headers, timeoutMs);
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
            ctx.log.info("remote tool call", { tool: tool.name, access: ctx.access });
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
