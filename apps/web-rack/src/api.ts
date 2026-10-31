export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // Only announce a JSON body when there is one: Fastify rejects a bodyless
    // request (DELETE, bare POST) sent with a JSON content-type as 400.
    headers: {
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    credentials: "same-origin",
  });
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    // Our routes answer { error }, Fastify itself { error, message }: prefer the detail.
    const body = data as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.message ?? body?.error ?? (text || response.statusText),
    );
  }
  return data as T;
}

export type Access = "read" | "write";
export const ACCESS_LABELS: Record<Access, string> = {
  read: "Lecture",
  write: "Lecture & écriture",
};

export type UserKind = "internal" | "external" | "client";
export const USER_KINDS: UserKind[] = ["internal", "external", "client"];
export const KIND_LABELS: Record<UserKind, string> = {
  internal: "Interne",
  external: "Externe",
  client: "Client",
};

export interface Me {
  id: string;
  email: string;
  name: string;
  role: string;
  kind: UserKind;
  isAdmin: boolean;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  write: boolean;
}

export interface SettingSpec {
  key: string;
  /** Environment variable the rack reads this setting from. */
  env: string;
  label: string;
  description?: string;
  example?: string;
}

/**
 * "package": shipped with the rack or declared in EXTERNAL_MCPS.
 * "site" / "remote" / "partner": resources added by an admin from the catalogue.
 * A partner MCP is a remote MCP that also receives the user's identity.
 */
export type McpKind = "package" | "site" | "remote" | "partner";
export type ResourceKind = Exclude<McpKind, "package">;
export const RESOURCE_KINDS: ResourceKind[] = ["site", "remote", "partner"];
export const KIND_NAMES: Record<McpKind, string> = {
  package: "Package du rack",
  site: "Site",
  remote: "MCP distant",
  partner: "MCP partenaire",
};

export interface SiteConfigView {
  apiUrl: string;
  hasToken: boolean;
}

export interface RemoteConfigView {
  url: string;
  headerName: "Authorization" | "x-api-key";
  hasToken: boolean;
}

export interface ResourceProbe {
  ok: boolean;
  message: string;
  tools?: ToolInfo[];
}

export interface UserMcp {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  version: string;
  kind: McpKind;
  access: Access;
  tools: ToolInfo[];
  url: string;
  /** UI of an external application, null for MCPs served by the rack. */
  appUrl: string | null;
}

export interface AdminMcp {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  version: string;
  kind: McpKind;
  /** Connection parameters of a resource, secrets masked; null for packages. */
  config: SiteConfigView | RemoteConfigView | null;
  loadError: string | null;
  /** Origin of an MCP hosted outside the rack (EXTERNAL_MCPS), null otherwise. */
  externalUrl: string | null;
  enabled: boolean;
  loaded: boolean;
  tools: ToolInfo[];
  settingsSpec: SettingSpec[];
  configuredSettings: string[];
  userCount: number;
  groupCount: number;
  groups: Array<{ id: string; name: string }>;
  registeredAt: string;
  lastSeenAt: string;
  url: string;
}

export interface Grants {
  mcps: "*" | Record<string, Access>;
  caps: "*" | string[];
}

export interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  expiresAt: string | null;
  lastRequest: string | null;
  requestCount: number;
  grants: Grants;
  createdAt: string;
  owner?: { id: string; email: string | null; name: string | null };
}

/** The group a user belongs to, as returned with the admin user listing. */
export interface UserGroupRef {
  id: string;
  name: string;
  mcps: string[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  role: string;
  isAdmin: boolean;
  banned: boolean;
  emailVerified: boolean;
  createdAt: string;
  /**
   * Individual overrides on top of group availability: "write" grants more,
   * "none" blocks the MCP, no entry means the group default (read).
   */
  mcps: Record<string, Access | "none">;
  groups: UserGroupRef[];
  keyCount: number;
}

export interface GroupMember {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  isAdmin: boolean;
}

export interface AdminGroup {
  id: string;
  name: string;
  description: string;
  mcps: string[];
  members: GroupMember[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Groups define availability; users default to read unless granted write or blocked. */
export function effectiveMcps(user: Pick<AdminUser, "mcps" | "groups">) {
  const result: Record<string, Access> = {};
  for (const group of user.groups) {
    for (const slug of group.mcps) {
      const override = user.mcps[slug];
      if (override === "none") continue;
      result[slug] = override ?? "read";
    }
  }
  return result;
}

export interface LogRow {
  id: string;
  mcp: string;
  mcpName: string;
  userId: string | null;
  userEmail: string | null;
  keyId: string | null;
  tool: string;
  capability: string | null;
  ok: boolean;
  durationMs: number;
  cost: number | null;
  error: string | null;
  createdAt: string;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function formatRelative(value: string | null | undefined) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return formatDate(value);
}

export interface AdminApplication {
  clientId: string;
  name: string | null;
  uri: string | null;
  disabled: boolean;
  accessRestricted: boolean;
  groupIds: string[];
  users: { userId: string; allowed: boolean }[];
  redirectUris: string[];
  scopes: string[];
}

export interface UserApplication {
  clientId: string;
  name: string | null;
  url: string | null;
}
