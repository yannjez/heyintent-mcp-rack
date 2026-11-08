import {
  InMemoryServerEventBus,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
import type { Logger } from "@rack/mcp-kit";

export interface McpNotifierOptions {
  log?: Logger;
  /** Test seam, and where a cross-process bus (Postgres LISTEN/NOTIFY…) plugs in. */
  createBus?: (slug: string) => ServerEventBus;
}

/**
 * Tells connected MCP clients to list the tools again.
 *
 * A client on the 2026-07-28 revision keeps a `subscriptions/listen` stream
 * open; publishing a `tools_list_changed` event on the bus its handler was
 * built with sends it `notifications/tools/list_changed`, and the client
 * re-issues `tools/list`. Nothing reaches clients on the 2025-era wire: the
 * rack serves them statelessly (see `legacy: "stateless"` in handler.ts), so
 * there is no stream to push on — they refresh by reconnecting.
 *
 * One bus per MCP, so a change on `site-public` never wakes the clients
 * listening on `sample`. Within one MCP the event is a broadcast: the bus
 * carries no routing metadata, so every subscriber re-lists, not only the
 * user whose rights moved. That stays correct — each `tools/list` is answered
 * by a server instance built from that caller's own `Access` — it is just not
 * minimal.
 */
export class McpNotifier {
  private readonly buses = new Map<string, ServerEventBus>();
  private readonly createBus: (slug: string) => ServerEventBus;

  constructor(options: McpNotifierOptions = {}) {
    const log = options.log;
    this.createBus =
      options.createBus ??
      ((slug) =>
        new InMemoryServerEventBus((error) =>
          log?.warn("mcp notification failed", { mcp: slug, error: error.message }),
        ));
  }

  /** The bus to hand `createMcpHandler` for this MCP; stable across handler rebuilds. */
  bus(slug: string): ServerEventBus {
    const existing = this.buses.get(slug);
    if (existing) return existing;
    const created = this.createBus(slug);
    this.buses.set(slug, created);
    return created;
  }

  /**
   * Publish `notifications/tools/list_changed` for these MCPs. Slugs with no
   * bus never had a handler built, so nobody is listening; duplicates and
   * unknown slugs are ignored. Safe to call with no open subscription.
   */
  toolsChanged(slugs: Iterable<string>) {
    for (const slug of new Set(slugs)) {
      this.buses.get(slug)?.publish({ kind: "tools_list_changed" });
    }
  }
}
