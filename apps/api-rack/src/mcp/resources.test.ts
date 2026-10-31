import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { probeRemote } from "./remote.js";
import {
  buildResource,
  openConfig,
  parseResourceConfig,
  presentConfig,
  sealConfig,
} from "./resources.js";
import { SecretBox } from "./secrets.js";

const box = new SecretBox("a-secret-long-enough-for-the-tests-0123456789");

describe("resource configuration", () => {
  it("validates site and remote parameters", () => {
    expect(parseResourceConfig("site", { apiUrl: "ftp://x" })).toMatchObject({
      ok: false,
    });
    expect(parseResourceConfig("site", { apiUrl: "https://a.example/api" })).toEqual({
      ok: true,
      value: { kind: "site", config: { apiUrl: "https://a.example/api", apiToken: "" } },
    });
    expect(parseResourceConfig("remote", { url: "https://mcp.example/mcp" })).toEqual({
      ok: true,
      value: {
        kind: "remote",
        config: {
          url: "https://mcp.example/mcp",
          headerName: "Authorization",
          token: "",
        },
      },
    });
  });

  it("seals secrets at rest, keeps them on update, and never presents them", () => {
    const parsed = parseResourceConfig("remote", {
      url: "https://mcp.example/mcp",
      token: "rk_secret",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const stored = sealConfig(parsed.value, box);
    expect(stored.token).toMatch(/^enc:v1:/);
    expect(SecretBox.isSealed(stored.token!)).toBe(true);

    const opened = openConfig({ kind: "remote", config: stored }, box);
    expect(opened).toMatchObject({ ok: true, value: { config: { token: "rk_secret" } } });

    const edited = parseResourceConfig("remote", { url: "https://mcp.example/v2" });
    if (!edited.ok) throw new Error(edited.error);
    const updated = sealConfig(edited.value, box, stored);
    expect(updated.url).toBe("https://mcp.example/v2");
    expect(updated.token).toBe(stored.token);

    expect(presentConfig({ kind: "remote", config: updated })).toEqual({
      url: "https://mcp.example/v2",
      headerName: "Authorization",
      hasToken: true,
    });
    expect(presentConfig({ kind: "package", config: null })).toBeNull();
    const other = new SecretBox("another-secret-that-does-not-match-the-first");
    expect(() => other.open(stored.token!)).toThrow();
  });

  it("reports an undecryptable secret instead of throwing", () => {
    const parsed = parseResourceConfig("site", {
      apiUrl: "https://a.example/api",
      apiToken: "t",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const stored = sealConfig(parsed.value, box);
    const rotated = new SecretBox("rotated-key-rotated-key-rotated-key-rotated-key");
    expect(openConfig({ kind: "site", config: stored }, rotated)).toMatchObject({
      ok: false,
      error: expect.stringContaining("decrypt"),
    });
  });

  it("gives up on a remote server that accepts connections but never answers", async () => {
    const server = createServer(() => {
      /* keep the request pending forever */
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const started = Date.now();
      await expect(
        probeRemote(`http://127.0.0.1:${port}/mcp`, {}, { timeoutMs: 300 }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(5_000);
      // The pending initialize request is aborted, not left dangling upstream.
      // Node's fetch may hold the aborted socket until its keep-alive timeout
      // (undici default 4 s) before destroying it, hence the generous bound.
      const deadline = Date.now() + 8_000;
      while (sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(sockets.size).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("builds a site definition fed by its stored parameters", () => {
    const parsed = parseResourceConfig("site", {
      apiUrl: "https://a.example/api",
      apiToken: "t",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const built = buildResource(
      { slug: "site-a", name: "Site A", description: "", version: "1.0.0" },
      parsed.value,
    );
    expect(built.definition.slug).toBe("site-a");
    expect(built.definition.settings).toEqual([]);
    expect(built.settings).toEqual({ apiUrl: "https://a.example/api", apiToken: "t" });
  });
});
