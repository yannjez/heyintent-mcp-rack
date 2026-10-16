import type { McpDefinition } from "@rack/mcp-kit";
import sample from "@rack/mcp-sample";
import sitePublic from "@rack/mcp-site-public";

/** Every MCP shipped by this rack. Add new packages here. */
export const catalog: McpDefinition[] = [sitePublic, sample];
