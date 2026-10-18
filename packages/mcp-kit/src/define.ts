import type { McpDefinition } from "./types.js";

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function defineMcp(definition: McpDefinition): McpDefinition {
  if (!SLUG.test(definition.slug)) {
    throw new Error(
      `Invalid MCP slug "${definition.slug}": use lowercase letters, digits and dashes`,
    );
  }
  return definition;
}

export interface ExternalMcpSpec {
  slug: string;
  name: string;
  /** Origin of the external app, e.g. `https://veille-ao.example.com`. */
  url: string;
  description?: string;
  category?: string;
  version?: string;
}

/** An MCP hosted elsewhere that relies on the rack for sign-in and access. */
export function defineExternalMcp(spec: ExternalMcpSpec): McpDefinition {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    throw new Error(`Invalid URL for external MCP "${spec.slug}": ${spec.url}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`External MCP "${spec.slug}" must use HTTPS: ${spec.url}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`External MCP "${spec.slug}" URL must be an origin: ${spec.url}`);
  }
  return defineMcp({
    slug: spec.slug,
    name: spec.name,
    version: spec.version ?? "external",
    description: spec.description ?? "",
    ...(spec.category ? { category: spec.category } : {}),
    capabilities: [],
    external: { url: url.origin },
    register() {},
  });
}
