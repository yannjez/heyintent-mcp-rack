import { describe, expect, it } from "vitest";
import {
  effectiveAccess,
  effectiveCapabilities,
  grantsAllowMcp,
  grantsFromScopes,
  parseMcpScope,
  scopesFromGrants,
} from "./grants.js";
import type { Identity } from "./types.js";

function identity(grants: Identity["grants"]): Identity {
  return { userId: "u1", via: "apikey", grants };
}

describe("grants", () => {
  it("parses mcp access scopes, defaulting to *", () => {
    expect(
      grantsFromScopes([
        "openid",
        "mcp:sample:read",
        "mcp:site-public:read",
        "mcp:site-public:write",
        "mcp:legacy",
        "cap:llm",
        "cap:bogus",
      ]),
    ).toEqual({
      mcps: { sample: "read", "site-public": "write", legacy: "write" },
      caps: ["llm"],
    });
    expect(grantsFromScopes(["openid"])).toEqual({ mcps: "*", caps: "*" });
  });

  it("round-trips scopes", () => {
    expect(scopesFromGrants({ mcps: { a: "write", b: "read" }, caps: ["data"] })).toEqual(
      ["mcp:a:read", "mcp:a:write", "mcp:b:read", "cap:data"],
    );
    expect(scopesFromGrants({ mcps: "*", caps: "*" })).toEqual([]);
    expect(parseMcpScope("mcp:a:write")).toEqual({ slug: "a", access: "write" });
    expect(parseMcpScope("cap:llm")).toBeNull();
  });

  it("checks mcp access", () => {
    expect(grantsAllowMcp(identity({ mcps: "*", caps: "*" }), "x")).toBe(true);
    expect(grantsAllowMcp(identity({ mcps: { x: "read" }, caps: "*" }), "x")).toBe(true);
    expect(grantsAllowMcp(identity({ mcps: { y: "read" }, caps: "*" }), "x")).toBe(false);
  });

  it("narrows the user's assignment by the credential", () => {
    const full = identity({ mcps: "*", caps: "*" });
    expect(effectiveAccess("write", full, "x")).toBe("write");
    expect(effectiveAccess("read", full, "x")).toBe("read");
    expect(effectiveAccess(null, full, "x")).toBeNull();
    const readKey = identity({ mcps: { x: "read" }, caps: "*" });
    expect(effectiveAccess("write", readKey, "x")).toBe("read");
    expect(effectiveAccess("write", readKey, "y")).toBeNull();
  });

  it("intersects declared, admin-allowed and granted capabilities", () => {
    const id = identity({ mcps: "*", caps: ["llm", "data"] });
    expect(effectiveCapabilities(["llm", "image", "data"], [], id)).toEqual([
      "llm",
      "data",
    ]);
    expect(
      effectiveCapabilities(["llm", "image", "data"], ["image", "data"], id),
    ).toEqual(["data"]);
    expect(
      effectiveCapabilities(["llm"], [], identity({ mcps: "*", caps: "*" })),
    ).toEqual(["llm"]);
  });
});
