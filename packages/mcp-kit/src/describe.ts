import type { McpServer } from "@modelcontextprotocol/server";
import type { McpContext, McpDefinition, McpToolInfo } from "./types.js";

function unavailable(name: string) {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`${name} is not available while describing an MCP`);
      },
    },
  );
}

/**
 * Enumerate the tools a package registers, by running `register` against a
 * recording stand-in for the server. Tool bodies never run here.
 */
export async function describeTools(definition: McpDefinition): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  const recorder = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") {
          return (
            name: string,
            config: {
              title?: string;
              description?: string;
              annotations?: { readOnlyHint?: boolean };
            },
          ) => {
            tools.push({
              name,
              title: config.title ?? name,
              description: config.description ?? "",
              write: config.annotations?.readOnlyHint !== true,
            });
            return { remove() {}, update() {}, enable() {}, disable() {} };
          };
        }
        // Resources, prompts, notifications…: accept and ignore.
        return () => ({ remove() {}, update() {}, enable() {}, disable() {} });
      },
    },
  ) as unknown as McpServer;

  const ctx: McpContext = {
    mcp: {
      id: "",
      slug: definition.slug,
      name: definition.name,
      version: definition.version,
      capabilities: definition.capabilities,
    },
    identity: { userId: "", via: "session", grants: { mcps: "*", caps: "*" } },
    access: "write",
    settings: {},
    tools: {
      llm: unavailable("llm") as McpContext["tools"]["llm"],
      image: unavailable("image") as McpContext["tools"]["image"],
      github: unavailable("github") as McpContext["tools"]["github"],
      data: unavailable("data") as McpContext["tools"]["data"],
    },
    log: { info() {}, warn() {}, error() {} },
  };
  await definition.register(recorder, ctx);
  return tools;
}
