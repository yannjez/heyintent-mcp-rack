import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer, type Tool } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { McpNotifier } from "./notifier.js";

describe("McpNotifier", () => {
  it("keeps one bus per MCP and ignores slugs nobody listens on", () => {
    const notifier = new McpNotifier();
    const demo = notifier.bus("demo");
    expect(notifier.bus("demo")).toBe(demo);
    expect(notifier.bus("other")).not.toBe(demo);
    // Never built a handler for "ghost": publishing must not throw.
    expect(() => notifier.toolsChanged(["ghost"])).not.toThrow();
  });

  it("only wakes the MCP that changed", () => {
    const notifier = new McpNotifier();
    const seen: string[] = [];
    notifier.bus("demo").subscribe(() => seen.push("demo"));
    notifier.bus("other").subscribe(() => seen.push("other"));
    notifier.toolsChanged(["demo", "demo"]);
    expect(seen).toEqual(["demo"]);
  });
});

/**
 * The wire this rests on: a client listening for `tools/list_changed` must
 * re-list when the rack publishes on the bus its handler was built with.
 */
describe("tools/list_changed over subscriptions/listen", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
  });

  it("delivers the notification and the client re-lists", async () => {
    const notifier = new McpNotifier();
    // Stands in for the per-request server the rack builds from the caller's
    // access: the write tool only exists once `writable` flips.
    let writable = false;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "demo", version: "1.0.0" });
        server.registerTool(
          "read_thing",
          { description: "read", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [] }),
        );
        if (writable) {
          server.registerTool(
            "write_thing",
            { description: "write", inputSchema: {} },
            async () => ({ content: [] }),
          );
        }
        return server;
      },
      { legacy: "stateless", bus: notifier.bus("demo") },
    );
    cleanups.push(() => handler.close());

    const changes: Tool[][] = [];
    let announce: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const client = new Client(
      { name: "test", version: "0.0.0" },
      {
        // `tools/list_changed` only reaches a client that negotiated the
        // 2026-07-28 era: the SDK default is still the 2025 handshake, which
        // has no stream to push on.
        versionNegotiation: { mode: "auto" },
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (error, tools) => {
              if (error) return;
              changes.push(tools ?? []);
              announce?.();
            },
          },
        },
      },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://rack.test/mcp/demo"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    cleanups.push(() => client.close());

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read_thing",
    ]);

    writable = true;
    notifier.toolsChanged(["demo"]);
    await changed;

    expect(changes.at(-1)?.map((tool) => tool.name)).toEqual([
      "read_thing",
      "write_thing",
    ]);
  }, 10_000);
});
