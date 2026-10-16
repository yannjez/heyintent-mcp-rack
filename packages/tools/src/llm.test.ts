import { describe, expect, it, vi } from "vitest";
import { createLlmService } from "./llm.js";

function fakeFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

describe("llm service", () => {
  it("sends a chat completion and maps the response", async () => {
    const fetchImpl = fakeFetch({
      model: "openai/gpt-5",
      choices: [{ message: { content: "Bonjour" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.001 },
    });
    const llm = createLlmService({
      apiKey: "k",
      defaultModel: "openai/gpt-5",
      allowedModels: [],
      fetch: fetchImpl,
    });
    const result = await llm.complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    });
    expect(result).toEqual({
      text: "Bonjour",
      model: "openai/gpt-5",
      usage: { promptTokens: 3, completionTokens: 2, cost: 0.001 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("rejects models outside the allowlist", async () => {
    const llm = createLlmService({
      apiKey: "k",
      defaultModel: "a/b",
      allowedModels: ["a/b"],
      fetch: fakeFetch({}),
    });
    await expect(llm.complete({ messages: [], model: "x/y" })).rejects.toThrow(
      /not allowed/,
    );
  });

  it("surfaces upstream errors", async () => {
    const llm = createLlmService({
      apiKey: "k",
      defaultModel: "a/b",
      allowedModels: [],
      fetch: fakeFetch({ error: "nope" }, 402),
    });
    await expect(llm.complete({ messages: [] })).rejects.toThrow(/402/);
  });
});
