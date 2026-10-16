import { defineMcp, jsonResult } from "@rack/mcp-kit";
import * as z from "zod";

/**
 * Copy this folder to `mcps/<slug>`, rename the package in package.json to
 * `@rack/mcp-<slug>`, declare only the capabilities you use, then add the
 * package to `apps/api-rack/src/mcp/catalog.ts` and run `pnpm install`.
 */
export default defineMcp({
  slug: "template",
  name: "Template",
  version: "0.1.0",
  description: "Starting point for a new MCP.",
  capabilities: [],
  register(server, ctx) {
    server.registerTool(
      "hello",
      {
        title: "Hello",
        description: "Says hello to the caller.",
        inputSchema: z.object({ name: z.string().default("world") }),
        annotations: { readOnlyHint: true },
      },
      async ({ name }) => jsonResult({ hello: name, userId: ctx.identity.userId }),
    );
  },
});
