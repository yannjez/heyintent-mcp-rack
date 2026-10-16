import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { Db, Mcp } from "@rack/database";
import {
  type Access,
  effectiveCapabilities,
  type Identity,
  type Logger,
  type McpContext,
  type McpDefinition,
} from "@rack/mcp-kit";
import { createToolServices, type ToolServicesConfig } from "@rack/tools";
import type { McpRegistry } from "./registry.js";

export interface McpHandlerDeps {
  db: Db;
  registry: McpRegistry;
  toolConfig: ToolServicesConfig;
  log: Logger;
}

export interface McpAuthExtra {
  identity: Identity;
  mcpRecord: Mcp;
  access: Access;
}

/** Identity travels inside `authInfo.extra` from the route to the factory. */
export function toAuthInfo(identity: Identity, record: Mcp, access: Access) {
  const extra: McpAuthExtra = { identity, mcpRecord: record, access };
  return {
    token: identity.keyId ?? identity.clientId ?? identity.userId,
    clientId: identity.clientId ?? identity.keyId ?? "session",
    scopes: [],
    extra: extra as unknown as Record<string, unknown>,
  };
}

export function createRackMcpHandler(
  definition: McpDefinition,
  deps: McpHandlerDeps,
): McpHttpHandler {
  return createMcpHandler(
    async (ctx) => {
      const extra = ctx.authInfo?.extra as Partial<McpAuthExtra> | undefined;
      const identity = extra?.identity;
      const record = extra?.mcpRecord;
      const access = extra?.access;
      if (!identity || !record || !access) {
        throw new Error("MCP handler invoked without a resolved identity");
      }

      const capabilities = effectiveCapabilities(
        record.capabilities,
        record.allowedCapabilities,
        identity,
      );
      const log = scopedLogger(deps.log, {
        mcp: definition.slug,
        userId: identity.userId,
      });
      const settings = deps.registry.settings(definition.slug);
      const tools = createToolServices({
        db: deps.db,
        config: deps.toolConfig,
        mcpId: record.id,
        identity,
        capabilities,
        log,
        ...(settings.githubToken ? { githubToken: settings.githubToken } : {}),
      });

      const context: McpContext = {
        mcp: {
          id: record.id,
          slug: definition.slug,
          name: definition.name,
          version: definition.version,
          capabilities,
        },
        identity,
        access,
        settings,
        tools,
        log,
      };

      const server = new McpServer({
        name: definition.name,
        version: definition.version,
      });
      guardServer(server, context, deps.db);
      await definition.register(server, context);
      return server;
    },
    {
      // Accept clients still on earlier protocol revisions (Claude Code, Cursor…).
      legacy: "stateless",
      onerror: (error) =>
        deps.log.error("mcp handler error", {
          mcp: definition.slug,
          error: error.message,
        }),
    },
  );
}

type RegisterTool = McpServer["registerTool"];

/**
 * Hide write tools from read-only sessions and journal every invocation.
 * A tool is read-only when it declares `annotations.readOnlyHint: true`.
 */
function guardServer(server: McpServer, context: McpContext, db: Db) {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    cb: (...args: unknown[]) => unknown,
  ) => unknown;

  const guarded = (
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    cb: (...args: unknown[]) => unknown,
  ) => {
    const readOnly = config.annotations?.readOnlyHint === true;
    if (!readOnly && context.access === "read") {
      return { remove() {}, update() {}, enable() {}, disable() {} };
    }
    return original(name, config, async (...args: unknown[]) => {
      const started = performance.now();
      let ok = false;
      let error: string | null = null;
      try {
        const result = (await cb(...args)) as { isError?: boolean; content?: unknown[] };
        ok = result?.isError !== true;
        if (!ok) error = firstText(result) ?? "tool returned an error";
        return result;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        throw caught;
      } finally {
        db.toolCall
          .create({
            data: {
              mcpId: context.mcp.id,
              userId: context.identity.userId,
              keyId: context.identity.keyId ?? null,
              tool: name,
              capability: null,
              ok,
              durationMs: Math.round(performance.now() - started),
              error: error?.slice(0, 500) ?? null,
            },
          })
          .catch((journalError: unknown) => {
            context.log.warn("tool journal failed", { error: String(journalError) });
          });
      }
    });
  };
  server.registerTool = guarded as unknown as RegisterTool;
}

function firstText(result: { content?: unknown[] }) {
  const first = result.content?.[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? first.text : undefined;
}

function scopedLogger(base: Logger, scope: Record<string, unknown>): Logger {
  return {
    info: (m, d) => base.info(m, { ...scope, ...d }),
    warn: (m, d) => base.warn(m, { ...scope, ...d }),
    error: (m, d) => base.error(m, { ...scope, ...d }),
  };
}
