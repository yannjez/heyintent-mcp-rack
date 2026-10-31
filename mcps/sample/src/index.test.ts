import type { GithubPushInput, LlmCompleteInput } from "@rack/mcp-kit";
import { testMcp, type TestMcp } from "@rack/mcp-kit/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sample from "./index.js";

describe("sample", () => {
  let mcp: TestMcp;
  const llmCalls: LlmCompleteInput[] = [];
  const pushes: GithubPushInput[] = [];

  beforeAll(async () => {
    mcp = await testMcp(sample, {
      identity: { userId: "alice", via: "apikey", keyId: "key-1" },
      tools: {
        llm: {
          async complete(input) {
            llmCalls.push(input);
            return { text: "• résumé", model: input.model ?? "fake/model" };
          },
          allowedModels: () => [],
        },
        image: {
          async generate() {
            return { images: [{ base64: "QUJD", mimeType: "image/png" }] };
          },
        },
        github: {
          async pushFiles(input) {
            pushes.push(input);
            return {
              commitSha: "abc123",
              commitUrl: "https://github.example/commit/abc123",
              branch: input.branch,
            };
          },
        },
      },
    });
  });
  afterAll(() => mcp.close());

  it("echoes the resolved identity and access", async () => {
    expect(await mcp.json("echo", { message: "hi" })).toMatchObject({
      message: "hi",
      userId: "alice",
      via: "apikey",
      access: "write",
      capabilities: ["llm", "image", "github", "data"],
    });
  });

  it("summarises through the rack LLM service", async () => {
    expect(
      await mcp.text("summarize", { text: "long text", language: "en", model: "x/y" }),
    ).toBe("• résumé");
    expect(llmCalls.at(-1)).toMatchObject({
      model: "x/y",
      maxTokens: 400,
      messages: [
        { role: "system", content: expect.stringContaining("in en") },
        { role: "user", content: "long text" },
      ],
    });
  });

  it("keeps a private memory per user and a shared note", async () => {
    expect(await mcp.text("remember", { key: "color", value: "blue" })).toMatch(/Stored/);
    expect(await mcp.json("recall", { key: "color" })).toEqual({
      key: "color",
      value: "blue",
    });
    expect(mcp.data.user.entries.get("color")).toBe("blue");
    // A top-level array is wrapped by the SDK as { result: [...] }.
    expect((await mcp.json<{ result: unknown[] }>("recall")).result).toHaveLength(1);
    expect(await mcp.text("forget", { key: "color" })).toMatch(/Deleted/);
    expect(await mcp.text("forget", { key: "color" })).toMatch(/No "color"/);

    expect(await mcp.json("shared_note", { text: "hello" })).toEqual({
      note: { text: "hello", by: "alice" },
    });
    expect(mcp.data.shared.entries.get("note")).toEqual({ text: "hello", by: "alice" });
  });

  it("returns generated images and GitHub push results", async () => {
    const image = await mcp.call("make_image", { prompt: "a rack" });
    expect(image.isError).toBeFalsy();
    expect(image.content).toEqual([
      { type: "text", text: "Image for: a rack" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);

    const push = await mcp.json("publish_to_github", {
      owner: "o",
      repo: "r",
      message: "docs",
      files: [{ path: "README.md", content: "# hi" }],
    });
    expect(push).toMatchObject({ commitSha: "abc123", branch: "main" });
    expect(pushes.at(-1)).toMatchObject({ owner: "o", repo: "r", branch: "main" });
  });

  it("surfaces service failures as tool errors", async () => {
    const bare = await testMcp(sample);
    try {
      const result = await bare.call("summarize", { text: "x" });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("llm") });
    } finally {
      await bare.close();
    }
  });
});
