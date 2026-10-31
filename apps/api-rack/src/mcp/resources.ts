import type { Mcp } from "@rack/database";
import { describeTools, type McpDefinition, type McpToolInfo } from "@rack/mcp-kit";
import { createSiteMcp } from "@rack/mcp-site-public";
import * as z from "zod";
import { createRemoteMcp, probeRemote, type RemoteToolSummary } from "./remote.js";
import type { SecretBox } from "./secrets.js";

/** Resource kinds an administrator may add; packages are shipped with the rack. */
export const RESOURCE_KINDS = ["site", "remote"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type McpKind = "package" | ResourceKind;

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

const url = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//.test(value), "Only http(s) URLs are supported");

export const siteConfigSchema = z.object({
  /** REST entry point of the public site content API. */
  apiUrl: url,
  /** Bearer token sent by the rack; "" keeps the current value on update. */
  apiToken: z.string().max(2000).default(""),
});

export const remoteConfigSchema = z.object({
  /** Streamable HTTP endpoint of the remote MCP server. */
  url,
  headerName: z.enum(["Authorization", "x-api-key"]).default("Authorization"),
  /** Credential the rack sends to the remote server; "" keeps the current value on update. */
  token: z.string().max(4000).default(""),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type ResourceConfig =
  { kind: "site"; config: SiteConfig } | { kind: "remote"; config: RemoteConfig };

/** Stored JSON shape (secret fields sealed). */
type StoredConfig = Record<string, string>;

const SECRET_FIELDS: Record<ResourceKind, string> = { site: "apiToken", remote: "token" };

export function parseResourceConfig(
  kind: ResourceKind,
  input: unknown,
): { ok: true; value: ResourceConfig } | { ok: false; error: string } {
  const schema = kind === "site" ? siteConfigSchema : remoteConfigSchema;
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return {
    ok: true,
    value:
      kind === "site"
        ? { kind, config: parsed.data as SiteConfig }
        : { kind, config: parsed.data as RemoteConfig },
  };
}

/** Encrypt the secret field before storing; an empty secret keeps `previous`'s. */
export function sealConfig(
  resource: ResourceConfig,
  box: SecretBox,
  previous?: StoredConfig | null,
): StoredConfig {
  const field = SECRET_FIELDS[resource.kind];
  const config = { ...(resource.config as Record<string, string>) };
  const secret = config[field] ?? "";
  config[field] = secret ? box.seal(secret) : (previous?.[field] ?? "");
  return config;
}

/** Decrypt a stored config; null when the record is a package or unreadable. */
export function openConfig(record: Pick<Mcp, "kind" | "config">, box: SecretBox) {
  if (!isResourceKind(record.kind)) return null;
  const stored = (record.config ?? {}) as StoredConfig;
  const field = SECRET_FIELDS[record.kind];
  let secret: string;
  try {
    secret = stored[field] ? box.open(stored[field]) : "";
  } catch {
    // A rotated ENCRYPTION_KEY or a damaged ciphertext must not take the rack
    // down: the resource is reported as unloaded until its secret is re-entered.
    return {
      ok: false as const,
      error: "Stored secret cannot be decrypted (encryption key changed?): re-enter it",
    };
  }
  return parseResourceConfig(record.kind, { ...stored, [field]: secret });
}

/** What the admin UI may see: URLs and whether a secret is set, never its value. */
export function presentConfig(record: Pick<Mcp, "kind" | "config">) {
  if (!isResourceKind(record.kind)) return null;
  const stored = (record.config ?? {}) as StoredConfig;
  if (record.kind === "site") {
    return { apiUrl: stored.apiUrl ?? "", hasToken: Boolean(stored.apiToken) };
  }
  return {
    url: stored.url ?? "",
    headerName: stored.headerName ?? "Authorization",
    hasToken: Boolean(stored.token),
  };
}

function remoteHeaders(config: RemoteConfig): Record<string, string> {
  if (!config.token) return {};
  return config.headerName === "Authorization"
    ? {
        authorization: config.token.startsWith("Bearer ")
          ? config.token
          : `Bearer ${config.token}`,
      }
    : { "x-api-key": config.token };
}

/** Build the MCP definition and the `ctx.settings` of a stored resource. */
/** Upper bound on remote tool discovery at startup or on edit. */
export const REMOTE_DISCOVERY_TIMEOUT_MS = 15_000;

export interface BuiltResource {
  definition: McpDefinition;
  settings: Record<string, string>;
  /**
   * Catalog of tools for the admin UI. Remote servers are probed with a
   * bounded session that is closed afterwards; sites are described offline.
   */
  describe: () => Promise<McpToolInfo[]>;
}

export function buildResource(
  record: Pick<Mcp, "slug" | "name" | "description" | "version">,
  resource: ResourceConfig,
): BuiltResource {
  if (resource.kind === "site") {
    const definition = createSiteMcp({
      slug: record.slug,
      name: record.name,
      description: record.description,
      version: record.version,
      settings: [],
    });
    return {
      definition,
      settings: { apiUrl: resource.config.apiUrl, apiToken: resource.config.apiToken },
      describe: () => describeTools(definition),
    };
  }
  const headers = remoteHeaders(resource.config);
  return {
    definition: createRemoteMcp({
      slug: record.slug,
      name: record.name,
      description: record.description,
      version: record.version,
      url: resource.config.url,
      headers,
    }),
    settings: {},
    describe: () =>
      probeRemote(resource.config.url, headers, {
        timeoutMs: REMOTE_DISCOVERY_TIMEOUT_MS,
      }),
  };
}

export interface ResourceProbe {
  ok: boolean;
  message: string;
  tools?: RemoteToolSummary[];
}

/** Check that the rack can reach the resource with the given parameters. */
export async function probeResource(
  resource: ResourceConfig,
  fetchLike: typeof fetch = fetch,
): Promise<ResourceProbe> {
  try {
    if (resource.kind === "site") {
      const base = resource.config.apiUrl.replace(/\/$/, "");
      const response = await fetchLike(`${base}/content`, {
        headers: {
          accept: "application/json",
          ...(resource.config.apiToken
            ? { authorization: `Bearer ${resource.config.apiToken}` }
            : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { ok: false, message: `Site API answered ${response.status}` };
      }
      const body = (await response.json()) as unknown;
      const count = Array.isArray(body) ? body.length : null;
      return {
        ok: true,
        message:
          count === null
            ? "Site API reachable"
            : `Site API reachable · ${count} contents`,
      };
    }
    const tools = await probeRemote(resource.config.url, remoteHeaders(resource.config), {
      timeoutMs: REMOTE_DISCOVERY_TIMEOUT_MS,
    });
    return {
      ok: true,
      message: `${tools.length} tool${tools.length > 1 ? "s" : ""} advertised`,
      tools,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
