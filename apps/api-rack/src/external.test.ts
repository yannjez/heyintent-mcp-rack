import { describe, expect, it } from "vitest";
import { grantedMcpAccess } from "./auth/auth.js";
import { parseExternalMcps } from "./env.js";

describe("EXTERNAL_MCPS", () => {
  it("is empty when unset", () => {
    expect(parseExternalMcps(undefined)).toEqual([]);
    expect(parseExternalMcps("  ")).toEqual([]);
  });

  it("declares an external MCP without local tools", () => {
    const [mcp] = parseExternalMcps(
      JSON.stringify([
        { slug: "veille-ao", name: "Veille AO", url: "https://ao.example.com/" },
      ]),
    );
    expect(mcp).toMatchObject({
      slug: "veille-ao",
      name: "Veille AO",
      capabilities: [],
      external: { url: "https://ao.example.com" },
    });
  });

  it("rejects malformed declarations", () => {
    expect(() => parseExternalMcps("{")).toThrow("JSON array");
    expect(() => parseExternalMcps('[{"slug":"x-y"}]')).toThrow("slug, name and url");
    expect(() =>
      parseExternalMcps('[{"slug":"ao","name":"AO","url":"http://ao.example.com"}]'),
    ).toThrow("HTTPS");
    expect(() =>
      parseExternalMcps('[{"slug":"ao","name":"AO","url":"https://ao.example.com/app"}]'),
    ).toThrow("origin");
  });
});

describe("mcp_access claim", () => {
  it("caps requested scopes by the user's rack access", () => {
    expect(
      grantedMcpAccess(
        ["openid", "mcp:veille-ao:read", "mcp:veille-ao:write", "mcp:sample:write"],
        { "veille-ao": "write", sample: "read" },
      ),
    ).toEqual({ "veille-ao": "write", sample: "read" });
  });

  it("grants read when only read is requested", () => {
    expect(grantedMcpAccess(["mcp:veille-ao:read"], { "veille-ao": "write" })).toEqual({
      "veille-ao": "read",
    });
  });

  it("omits MCPs the user may not use", () => {
    expect(grantedMcpAccess(["mcp:veille-ao:write"], {})).toEqual({});
  });
});
