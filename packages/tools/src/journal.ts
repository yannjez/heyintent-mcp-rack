import type { Db } from "@rack/database";
import type { Capability, Identity, Logger } from "@rack/mcp-kit";

export interface JournalContext {
  db: Db;
  mcpId: string;
  identity: Identity;
  log: Logger;
}

/** Measure a tool-service call and persist it in `tool_calls` (best effort). */
export async function withToolCall<T>(
  ctx: JournalContext,
  tool: string,
  capability: Capability | null,
  fn: () => Promise<T>,
  cost?: (result: T) => number | undefined,
): Promise<T> {
  const started = performance.now();
  let ok = false;
  let errorMessage: string | null = null;
  let result: T | undefined;
  try {
    result = await fn();
    ok = true;
    return result;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const durationMs = Math.round(performance.now() - started);
    const resolvedCost = ok && cost && result !== undefined ? cost(result) : undefined;
    ctx.db.toolCall
      .create({
        data: {
          mcpId: ctx.mcpId,
          userId: ctx.identity.userId,
          keyId: ctx.identity.keyId ?? null,
          tool,
          capability,
          ok,
          durationMs,
          cost: resolvedCost ?? null,
          error: errorMessage?.slice(0, 500) ?? null,
        },
      })
      .catch((error: unknown) => {
        ctx.log.warn("tool call journal failed", { error: String(error) });
      });
  }
}
