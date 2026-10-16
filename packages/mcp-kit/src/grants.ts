import {
  type Access,
  CAPABILITIES,
  type Capability,
  type Identity,
  isAccess,
  isCapability,
  minAccess,
} from "./types.js";

export const MCP_SCOPE_PREFIX = "mcp:";
export const CAP_SCOPE_PREFIX = "cap:";

/** Access the credential itself grants on this MCP (null = denied). */
export function credentialAccess(identity: Identity, slug: string): Access | null {
  if (identity.grants.mcps === "*") return "write";
  return identity.grants.mcps[slug] ?? null;
}

/** Does the credential allow calling this MCP slug at all? */
export function grantsAllowMcp(identity: Identity, slug: string) {
  return credentialAccess(identity, slug) !== null;
}

/**
 * Effective access for a request: what the admin assigned to the user,
 * narrowed by what the credential (API key / OAuth consent) carries.
 */
export function effectiveAccess(
  userAccess: Access | null,
  identity: Identity,
  slug: string,
): Access | null {
  return minAccess(userAccess, credentialAccess(identity, slug));
}

/**
 * Capabilities usable for a request: declared by the MCP, allowed by the admin
 * (empty = all declared), and granted to the credential.
 */
export function effectiveCapabilities(
  declared: readonly string[],
  adminAllowed: readonly string[],
  identity: Identity,
): Capability[] {
  const declaredCaps = declared.filter(isCapability);
  const allowedSet = adminAllowed.length > 0 ? new Set(adminAllowed) : null;
  return declaredCaps.filter((cap) => {
    if (allowedSet && !allowedSet.has(cap)) return false;
    return identity.grants.caps === "*" || identity.grants.caps.includes(cap);
  });
}

/**
 * Parse `mcp:<slug>:<read|write>` / `cap:<name>` entries from OAuth scopes or
 * API key permission keys. No entry of a kind means "*" for that kind. A bare
 * `mcp:<slug>` (legacy) counts as write.
 */
export function grantsFromScopes(scopes: Iterable<string>): Identity["grants"] {
  const mcps: Record<string, Access> = {};
  let anyMcp = false;
  const caps: Capability[] = [];
  for (const scope of scopes) {
    if (scope.startsWith(MCP_SCOPE_PREFIX)) {
      const [slug, level] = scope.slice(MCP_SCOPE_PREFIX.length).split(":");
      if (!slug) continue;
      anyMcp = true;
      const access: Access =
        level === undefined ? "write" : isAccess(level) ? level : "read";
      mcps[slug] = access === "write" || mcps[slug] === "write" ? "write" : "read";
    } else if (scope.startsWith(CAP_SCOPE_PREFIX)) {
      const cap = scope.slice(CAP_SCOPE_PREFIX.length);
      if (isCapability(cap)) caps.push(cap);
    }
  }
  return {
    mcps: anyMcp ? mcps : "*",
    caps: caps.length > 0 ? caps : "*",
  };
}

/** Build API key permissions / OAuth scopes from a grant selection. */
export function scopesFromGrants(grants: Identity["grants"]): string[] {
  const scopes: string[] = [];
  if (grants.mcps !== "*") {
    for (const [slug, access] of Object.entries(grants.mcps)) {
      scopes.push(mcpScope(slug, "read"));
      if (access === "write") scopes.push(mcpScope(slug, "write"));
    }
  }
  if (grants.caps !== "*")
    scopes.push(...grants.caps.map((cap) => CAP_SCOPE_PREFIX + cap));
  return scopes;
}

export function mcpScope(slug: string, access: Access) {
  return `${MCP_SCOPE_PREFIX}${slug}:${access}`;
}

/** Both scopes advertised for an MCP slug. */
export function mcpScopes(slug: string) {
  return [mcpScope(slug, "read"), mcpScope(slug, "write")];
}

/** Parse a `mcp:<slug>:<access>` scope; null for anything else. */
export function parseMcpScope(scope: string): { slug: string; access: Access } | null {
  if (!scope.startsWith(MCP_SCOPE_PREFIX)) return null;
  const [slug, level] = scope.slice(MCP_SCOPE_PREFIX.length).split(":");
  if (!slug) return null;
  return { slug, access: level && isAccess(level) ? level : "write" };
}

export function allCapabilityScopes() {
  return CAPABILITIES.map((cap) => CAP_SCOPE_PREFIX + cap);
}
