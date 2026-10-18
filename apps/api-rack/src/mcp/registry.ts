import type { Db, Mcp } from "@rack/database";
import {
  type Access,
  describeTools,
  isAccess,
  type McpDefinition,
  type McpSettingSpec,
  type McpToolInfo,
} from "@rack/mcp-kit";

/** Stored in `mcp_access.access` to block an MCP for a user despite their groups. */
export const DENIED = "none";

export interface RegisteredMcp {
  definition: McpDefinition;
  record: Mcp;
}

export interface McpListing {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  version: string;
  enabled: boolean;
  loaded: boolean;
  capabilities: string[];
  allowedCapabilities: string[];
  tools: McpToolInfo[];
  settingsSpec: McpSettingSpec[];
  /** Setting keys whose environment variable is set (values never leave the server). */
  configuredSettings: string[];
  /** Origin of an MCP hosted outside the rack, null for the rack's own. */
  externalUrl: string | null;
  registeredAt: Date;
  lastSeenAt: Date;
}

export class McpRegistry {
  private readonly bySlug = new Map<string, McpDefinition>();
  private readonly toolsBySlug = new Map<string, McpToolInfo[]>();
  private readonly settingsBySlug = new Map<string, Record<string, string>>();

  /**
   * @param environment Where MCP connection parameters are read from
   *   (`process.env` in production; injectable for tests).
   */
  constructor(
    private readonly db: Db,
    definitions: McpDefinition[],
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    for (const definition of definitions) {
      if (this.bySlug.has(definition.slug)) {
        throw new Error(`Duplicate MCP slug "${definition.slug}"`);
      }
      this.bySlug.set(definition.slug, definition);
      this.settingsBySlug.set(definition.slug, resolveSettings(definition, environment));
    }
  }

  get definitions() {
    return [...this.bySlug.values()];
  }

  tools(slug: string): McpToolInfo[] {
    return this.toolsBySlug.get(slug) ?? [];
  }

  /** Connection parameters of an MCP, keyed by setting key ("" when the variable is unset). */
  settings(slug: string): Record<string, string> {
    return this.settingsBySlug.get(slug) ?? {};
  }

  /** Upsert declared metadata; `enabled` stays admin-owned. */
  async sync() {
    for (const definition of this.bySlug.values()) {
      this.toolsBySlug.set(definition.slug, await describeTools(definition));
      await this.db.mcp.upsert({
        where: { slug: definition.slug },
        create: {
          slug: definition.slug,
          name: definition.name,
          description: definition.description,
          version: definition.version,
          capabilities: definition.capabilities,
        },
        update: {
          name: definition.name,
          description: definition.description,
          version: definition.version,
          capabilities: definition.capabilities,
          lastSeenAt: new Date(),
        },
      });
    }
  }

  async get(slug: string): Promise<RegisteredMcp | null> {
    const definition = this.bySlug.get(slug);
    if (!definition) return null;
    const record = await this.db.mcp.findUnique({ where: { slug } });
    if (!record) return null;
    return { definition, record };
  }

  async list(): Promise<McpListing[]> {
    const records = await this.db.mcp.findMany({ orderBy: { slug: "asc" } });
    return records.map((record) => {
      const definition = this.bySlug.get(record.slug);
      const settings = this.settings(record.slug);
      return {
        id: record.id,
        slug: record.slug,
        name: record.name,
        description: record.description,
        category: definition?.category ?? null,
        version: record.version,
        enabled: record.enabled,
        loaded: Boolean(definition),
        capabilities: record.capabilities,
        allowedCapabilities: record.allowedCapabilities,
        tools: this.tools(record.slug),
        settingsSpec: definition?.settings ?? [],
        configuredSettings: Object.keys(settings).filter((key) => settings[key]),
        externalUrl: definition?.external?.url ?? null,
        registeredAt: record.registeredAt,
        lastSeenAt: record.lastSeenAt,
      };
    });
  }

  /** Membership in an MCP group is mandatory, including for administrators. */
  async userAccess(userId: string, mcpId: string): Promise<Access | null> {
    const mcp = await this.db.mcp.findUnique({
      where: { id: mcpId },
      select: { slug: true },
    });
    if (!mcp) return null;
    return (await this.userAccesses(userId))[mcp.slug] ?? null;
  }

  /**
   * Group availability, refined by the user's individual rows: read by
   * default, "write" to grant more, "none" to block an MCP the groups would
   * otherwise make available.
   */
  async userAccesses(
    userId: string,
    _isAdmin?: boolean,
  ): Promise<Record<string, Access>> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { banned: true },
    });
    if (!user || user.banned) return {};
    const [rows, groupRows] = await Promise.all([
      this.db.mcpAccess.findMany({
        where: { userId },
        include: { mcp: { select: { slug: true } } },
      }),
      this.db.mcpGroupMcp.findMany({
        where: { group: { users: { some: { userId } } } },
        include: { mcp: { select: { slug: true } } },
      }),
    ]);
    const result: Record<string, Access> = {};
    for (const row of groupRows) {
      result[row.mcp.slug] = "read";
    }
    for (const row of rows) {
      if (!result[row.mcp.slug]) continue;
      if (row.access === DENIED) delete result[row.mcp.slug];
      else result[row.mcp.slug] = toAccess(row.access) ?? "read";
    }
    return result;
  }
}

/** Normalise a stored access string ("read" | "write"); anything else reads as "read". */
export function toAccess(value: string | null | undefined): Access | null {
  if (value == null) return null;
  return isAccess(value) ? value : "read";
}

/** Read the settings declared by a package from the environment ("" when unset). */
export function resolveSettings(
  definition: McpDefinition,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    (definition.settings ?? []).map((spec) => [
      spec.key,
      environment[spec.env]?.trim() ?? "",
    ]),
  );
}
