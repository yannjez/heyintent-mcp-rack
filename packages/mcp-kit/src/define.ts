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
