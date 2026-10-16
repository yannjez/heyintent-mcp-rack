import { defineMcp, guarded, imageResult, jsonResult, textResult } from "@rack/mcp-kit";
import * as z from "zod";

/**
 * Reference MCP exercising every rack capability. Each tool is a thin wrapper
 * over `ctx.tools.*`; capability gating is enforced by the rack, so a denied
 * capability surfaces as an `isError` result.
 */
export default defineMcp({
  slug: "sample",
  name: "Sample",
  version: "0.1.0",
  category: "Démo",
  description:
    "MCP de référence : echo, résumé par LLM, mémoire par utilisateur, génération d'image, push GitHub.",
  capabilities: ["llm", "image", "github", "data"],
  settings: [
    {
      key: "githubToken",
      env: "SAMPLE_GITHUB_TOKEN",
      label: "Token GitHub dédié",
      description: "Remplace GITHUB_TOKEN pour ce MCP.",
      example: "github_pat_…",
    },
  ],
  register(server, ctx) {
    server.registerTool(
      "echo",
      {
        title: "Echo",
        description: "Echo a message back, with the identity the rack resolved.",
        inputSchema: z.object({ message: z.string().min(1).max(2000) }),
        annotations: { readOnlyHint: true },
      },
      async ({ message }) =>
        jsonResult({
          message,
          userId: ctx.identity.userId,
          via: ctx.identity.via,
          access: ctx.access,
          capabilities: ctx.mcp.capabilities,
        }),
    );

    server.registerTool(
      "summarize",
      {
        title: "Summarize",
        description: "Summarize a text with the rack's default LLM (OpenRouter).",
        inputSchema: z.object({
          text: z.string().min(1).max(20000),
          language: z.string().default("fr"),
          model: z.string().optional(),
        }),
      },
      async ({ text, language, model }) =>
        guarded(async () => {
          const result = await ctx.tools.llm.complete({
            ...(model ? { model } : {}),
            maxTokens: 400,
            messages: [
              {
                role: "system",
                content: `Summarize the user text in ${language} in at most 5 bullet points.`,
              },
              { role: "user", content: text },
            ],
          });
          return textResult(result.text);
        }),
    );

    server.registerTool(
      "remember",
      {
        title: "Remember",
        description: "Store a value under a key in your private memory for this MCP.",
        inputSchema: z.object({ key: z.string(), value: z.unknown() }),
        annotations: { idempotentHint: true },
      },
      async ({ key, value }) =>
        guarded(async () => {
          await ctx.tools.data.set(key, value);
          return textResult(`Stored "${key}".`);
        }),
    );

    server.registerTool(
      "recall",
      {
        title: "Recall",
        description:
          "Read a value from your private memory. Omit the key to list everything.",
        inputSchema: z.object({ key: z.string().optional() }),
        annotations: { readOnlyHint: true },
      },
      async ({ key }) =>
        guarded(async () =>
          key
            ? jsonResult({ key, value: await ctx.tools.data.get(key) })
            : jsonResult(await ctx.tools.data.list()),
        ),
    );

    server.registerTool(
      "forget",
      {
        title: "Forget",
        description: "Delete a key from your private memory.",
        inputSchema: z.object({ key: z.string() }),
        annotations: { destructiveHint: true },
      },
      async ({ key }) =>
        guarded(async () =>
          textResult(
            (await ctx.tools.data.delete(key)) ? `Deleted "${key}".` : `No "${key}".`,
          ),
        ),
    );

    server.registerTool(
      "shared_note",
      {
        title: "Shared note",
        description: "Read or write a note shared by every user of this MCP.",
        inputSchema: z.object({ text: z.string().optional() }),
      },
      async ({ text }) =>
        guarded(async () => {
          if (text !== undefined) {
            await ctx.tools.data.global.set("note", { text, by: ctx.identity.userId });
          }
          return jsonResult({ note: await ctx.tools.data.global.get("note") });
        }),
    );

    server.registerTool(
      "make_image",
      {
        title: "Make image",
        description: "Generate an image from a prompt (OpenRouter image models).",
        inputSchema: z.object({
          prompt: z.string().min(1).max(4000),
          aspectRatio: z.string().optional(),
          model: z.string().optional(),
        }),
      },
      async ({ prompt, aspectRatio, model }) =>
        guarded(async () => {
          const { images } = await ctx.tools.image.generate({
            prompt,
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(model ? { model } : {}),
          });
          const [first] = images;
          if (!first) throw new Error("No image generated");
          return imageResult(first.base64, first.mimeType, `Image for: ${prompt}`);
        }),
    );

    server.registerTool(
      "publish_to_github",
      {
        title: "Publish to GitHub",
        description: "Commit one or more files to a branch of a GitHub repository.",
        inputSchema: z.object({
          owner: z.string(),
          repo: z.string(),
          branch: z.string().default("main"),
          baseBranch: z.string().optional(),
          message: z.string().min(1),
          files: z
            .array(z.object({ path: z.string(), content: z.string() }))
            .min(1)
            .max(50),
        }),
        annotations: { destructiveHint: true },
      },
      async ({ owner, repo, branch, baseBranch, message, files }) =>
        guarded(async () =>
          jsonResult(
            await ctx.tools.github.pushFiles({
              owner,
              repo,
              branch,
              ...(baseBranch ? { baseBranch } : {}),
              message,
              files,
            }),
          ),
        ),
    );
  },
});
