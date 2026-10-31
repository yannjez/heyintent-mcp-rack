import type { Db, Mcp } from "@rack/database";
import {
  type Access,
  describeTools,
  isAccess,
  type McpDefinition,
  type McpSettingSpec,
  type McpToolInfo,
} from "@rack/mcp-kit";
import {
  buildResource,
  isResourceKind,
  type McpKind,
  openConfig,
  presentConfig,
  type ResourceConfig,
  type ResourceKind,
  sealConfig,
} from "./resources.js";
import { SecretBox } from "./secrets.js";

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
  kind: McpKind;
  /** Connection parameters of a site or remote resource, secrets masked. */
  config: ReturnType<typeof presentConfig>;
  /** Why the resource could not be loaded (unreachable server, bad config…). */
  loadError: string | null;
  enabled: boolean;
  loaded: boolean;
  capabilities: string[];
  allowedCapabilities: string[];
  tools: McpToolInfo[];
  settingsSpec: McpSettingSpec[];
  /** Setting keys whose environment variable is set (values never leave the server). */
  configuredSettings: string[];
  /** Origin of an MCP hosted outside the rack (EXTERNAL_MCPS), null for the rack's own. */
  externalUrl: string | null;
  registeredAt: Date;
  lastSeenAt: Date;
}

export interface RegistryOptions {
  /** Where MCP connection parameters are read from (`process.env` in production). */
  environment?: NodeJS.ProcessEnv;
  /** Encrypts resource secrets at rest (the rack secret by default). */
  secret?: string;
}

export interface ResourceInput {
  slug: string;
  name: string;
  description: string;
  resource: ResourceConfig;
}

export type RegistryListener = (slug: string) => void;

/**
 * Every MCP the rack serves: packages shipped in the catalog and resources
 * (sites, remote MCP servers) added by administrators and stored in the
 * database.
 */
export class McpRegistry {
  private readonly bySlug = new Map<string, McpDefinition>();
  private readonly kinds = new Map<string, McpKind>();
  private readonly toolsBySlug = new Map<string, McpToolInfo[]>();
  private readonly settingsBySlug = new Map<string, Record<string, string>>();
  private readonly loadErrors = new Map<string, string>();
  private readonly listeners = new Set<RegistryListener>();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly box: SecretBox | null;

  constructor(
    private readonly db: Db,
    definitions: McpDefinition[],
    options: RegistryOptions | NodeJS.ProcessEnv = {},
  ) {
    const opts: RegistryOptions = isRegistryOptions(options)
      ? options
      : { environment: options };
    this.environment = opts.environment ?? process.env;
    this.box = opts.secret ? new SecretBox(opts.secret) : null;
    for (const definition of definitions) {
      if (this.bySlug.has(definition.slug)) {
        throw new Error(`Duplicate MCP slug "${definition.slug}"`);
      }
      this.bySlug.set(definition.slug, definition);
      this.kinds.set(definition.slug, "package");
      this.settingsBySlug.set(
        definition.slug,
        resolveSettings(definition, this.environment),
      );
    }
  }

  get definitions() {
    return [...this.bySlug.values()];
  }

  /** Packages shipped with the rack (never removable through the API). */
  get packages() {
    return this.definitions.filter((d) => this.kinds.get(d.slug) === "package");
  }

  definition(slug: string): McpDefinition | undefined {
    return this.bySlug.get(slug);
  }

  kind(slug: string): McpKind | undefined {
    return this.kinds.get(slug);
  }

  tools(slug: string): McpToolInfo[] {
    return this.toolsBySlug.get(slug) ?? [];
  }

  /** Connection parameters of an MCP, keyed by setting key ("" when the variable is unset). */
  settings(slug: string): Record<string, string> {
    return this.settingsBySlug.get(slug) ?? {};
  }

  /** Called with the slug whenever a definition is added, replaced or removed. */
  onChange(listener: RegistryListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(slug: string) {
    for (const listener of this.listeners) listener(slug);
  }

  /** Upsert declared metadata; `enabled` stays admin-owned. Then load stored resources. */
  async sync() {
    for (const definition of this.packages) {
      this.toolsBySlug.set(definition.slug, await describeTools(definition));
      await this.db.mcp.upsert({
        where: { slug: definition.slug },
        create: {
          slug: definition.slug,
          name: definition.name,
          description: definition.description,
          version: definition.version,
          capabilities: definition.capabilities,
          kind: "package",
        },
        update: {
          name: definition.name,
          description: definition.description,
          version: definition.version,
          capabilities: definition.capabilities,
          kind: "package",
          lastSeenAt: new Date(),
        },
      });
    }
    const resources = await this.db.mcp.findMany({
      where: { kind: { in: ["site", "remote"] } },
      orderBy: { slug: "asc" },
    });
    // Remote discovery is bounded (see REMOTE_DISCOVERY_TIMEOUT_MS) and runs in
    // parallel, so a slow server delays startup by one timeout at most.
    await Promise.all(resources.map((record) => this.load(record)));
  }

  /** Build and register the definition of a stored resource (tools described best-effort). */
  private async load(record: Mcp) {
    if (!this.box || !isResourceKind(record.kind)) return;
    this.loadErrors.delete(record.slug);
    const opened = openConfig(record, this.box);
    if (!opened || !opened.ok) {
      this.loadErrors.set(record.slug, opened?.error ?? "Unreadable configuration");
      this.bySlug.delete(record.slug);
      this.kinds.set(record.slug, record.kind);
      this.notify(record.slug);
      return;
    }
    const { definition, settings, describe } = buildResource(record, opened.value);
    this.bySlug.set(record.slug, definition);
    this.kinds.set(record.slug, record.kind);
    this.settingsBySlug.set(record.slug, settings);
    try {
      this.toolsBySlug.set(record.slug, await describe());
    } catch (error) {
      // A remote server that is down still gets served later: the handler
      // reconnects on each session. Only the admin catalog lacks its tools.
      this.toolsBySlug.set(record.slug, []);
      this.loadErrors.set(
        record.slug,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.notify(record.slug);
  }

  /** Register a site or remote MCP server added by an administrator. */
  async addResource(input: ResourceInput): Promise<Mcp> {
    if (!this.box) throw new Error("Resources need a configured secret");
    if (this.bySlug.has(input.slug) || this.kinds.has(input.slug)) {
      throw new RegistryError(409, `An MCP with slug "${input.slug}" already exists`);
    }
    const record = await this.db.mcp.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description,
        version: "1.0.0",
        kind: input.resource.kind,
        capabilities: input.resource.kind === "site" ? ["data"] : [],
        config: sealConfig(input.resource, this.box),
      },
    });
    await this.load(record);
    return record;
  }

  /** Change the name, description or connection parameters of a resource. */
  async updateResource(
    slug: string,
    patch: { name?: string; description?: string; resource?: ResourceConfig },
  ): Promise<Mcp> {
    if (!this.box) throw new Error("Resources need a configured secret");
    const existing = await this.db.mcp.findUnique({ where: { slug } });
    if (!existing || !isResourceKind(existing.kind)) {
      throw new RegistryError(404, "Unknown resource");
    }
    if (patch.resource && patch.resource.kind !== existing.kind) {
      throw new RegistryError(400, "A resource cannot change kind");
    }
    const record = await this.db.mcp.update({
      where: { slug },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.resource
          ? {
              config: sealConfig(
                patch.resource,
                this.box,
                existing.config as Record<string, string> | null,
              ),
            }
          : {}),
        lastSeenAt: new Date(),
      },
    });
    await this.load(record);
    return record;
  }

  /** Remove a resource and everything attached to it (accesses, groups, journal). */
  async removeResource(slug: string) {
    const existing = await this.db.mcp.findUnique({ where: { slug } });
    if (!existing || !isResourceKind(existing.kind)) {
      throw new RegistryError(404, "Unknown resource");
    }
    await this.db.mcp.delete({ where: { slug } });
    this.bySlug.delete(slug);
    this.kinds.delete(slug);
    this.toolsBySlug.delete(slug);
    this.settingsBySlug.delete(slug);
    this.loadErrors.delete(slug);
    this.notify(slug);
  }

  /** Decrypted configuration of a resource (server-side use only). */
  async resourceConfig(slug: string): Promise<ResourceConfig | null> {
    if (!this.box) return null;
    const record = await this.db.mcp.findUnique({ where: { slug } });
    if (!record) return null;
    const opened = openConfig(record, this.box);
    return opened?.ok ? opened.value : null;
  }

  /** Reload a resource definition after its stored record changed. */
  async reload(slug: string) {
    const record = await this.db.mcp.findUnique({ where: { slug } });
    if (record) await this.load(record);
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
      const kind = (isResourceKind(record.kind) ? record.kind : "package") as McpKind;
      return {
        id: record.id,
        slug: record.slug,
        name: record.name,
        description: record.description,
        category: definition?.category ?? (kind === "remote" ? "MCP distant" : null),
        version: record.version,
        kind,
        config: presentConfig(record),
        loadError: this.loadErrors.get(record.slug) ?? null,
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

/** Error carrying the HTTP status an admin route should answer with. */
export class RegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isRegistryOptions(
  value: RegistryOptions | NodeJS.ProcessEnv,
): value is RegistryOptions {
  const keys = Object.keys(value);
  return keys.every((key) => key === "environment" || key === "secret");
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

export type { ResourceConfig, ResourceKind };
