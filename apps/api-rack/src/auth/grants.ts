import type { Db } from "@rack/database";
import { type Access, type McpDefinition, minAccess, parseMcpScope } from "@rack/mcp-kit";

/**
 * OAuth resource identifier of an MCP served by the rack: its own endpoint.
 * One resource per MCP, so a client connecting to one MCP is offered the
 * scopes of that MCP alone, and its token is bound to it.
 */
export function mcpResourceIdentifier(baseUrl: string, slug: string) {
  return `${baseUrl.replace(/\/$/, "")}/mcp/${slug}`;
}

/** Every OAuth resource a token for this MCP may name, external apps included. */
export function mcpResourceIdentifiers(baseUrl: string, definition: McpDefinition) {
  return definition.external
    ? [definition.external.url, `${definition.external.url}/mcp`]
    : [mcpResourceIdentifier(baseUrl, definition.slug)];
}

/** Highest level each MCP is asked for in a scope list. */
export function accessByScope(scopes: Iterable<string>): Record<string, Access> {
  const levels: Record<string, Access> = {};
  for (const scope of scopes) {
    const parsed = parseMcpScope(scope);
    if (!parsed) continue;
    if (levels[parsed.slug] !== "write") levels[parsed.slug] = parsed.access;
  }
  return levels;
}

/**
 * Record what the user just accepted for this client, MCP by MCP. Accepting
 * again replaces the level of the MCPs named, and leaves the others alone:
 * unlike the provider's consent row, grants add up across authorizations.
 * Returns the slugs written.
 */
export async function recordConsent(
  db: Db,
  input: { userId: string; clientId: string; scopes: Iterable<string> },
): Promise<string[]> {
  const levels = accessByScope(input.scopes);
  const slugs = Object.keys(levels);
  if (slugs.length === 0) return [];
  const mcps = await db.mcp.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  await db.$transaction(
    mcps.map((mcp) => {
      const access = levels[mcp.slug]!;
      return db.mcpGrant.upsert({
        where: {
          clientId_userId_mcpId: {
            clientId: input.clientId,
            userId: input.userId,
            mcpId: mcp.id,
          },
        },
        create: {
          clientId: input.clientId,
          userId: input.userId,
          mcpId: mcp.id,
          access,
          consentedAccess: access,
        },
        update: { access, consentedAccess: access },
      });
    }),
  );
  return mcps.map((mcp) => mcp.slug);
}

/** Level this account currently lets a client use, per MCP slug it was granted. */
export async function grantLevels(
  db: Db,
  input: { userId: string; clientId: string },
): Promise<Record<string, Access>> {
  const grants = await db.mcpGrant.findMany({
    where: input,
    select: { access: true, mcp: { select: { slug: true } } },
  });
  return Object.fromEntries(
    grants.map((grant) => [grant.mcp.slug, grant.access === "write" ? "write" : "read"]),
  );
}

/**
 * What a client may do for an account: the account's own access, lowered to
 * the level it granted the client. No grant, no access, as on the rack's own
 * /mcp/:slug route.
 */
export function capByGrants(
  accesses: Record<string, Access>,
  levels: Record<string, Access>,
): Record<string, Access> {
  const capped: Record<string, Access> = {};
  for (const [slug, level] of Object.entries(levels)) {
    const access = minAccess(accesses[slug] ?? null, level);
    if (access) capped[slug] = access;
  }
  return capped;
}

/**
 * Forget what the provider remembers of these clients for this account, so
 * the next authorization shows the consent screen again and no refresh token
 * outlives the cut. With `resources`, only the tokens bound to them go.
 */
export function clearProviderGrants(
  db: Db,
  input: { userId: string; clientIds: string[]; resources?: string[] },
) {
  const owner = { userId: input.userId, clientId: { in: input.clientIds } };
  const tokens = input.resources
    ? { ...owner, resources: { hasSome: input.resources } }
    : owner;
  return [
    db.oauthAccessToken.deleteMany({ where: tokens }),
    db.oauthRefreshToken.deleteMany({ where: tokens }),
    db.oauthConsent.deleteMany({ where: owner }),
  ];
}
