import type { LlmCompleteResult, LlmService } from "@rack/mcp-kit";
import { type OpenRouterConfig, openRouterPost } from "./openrouter.js";

export interface LlmConfig extends OpenRouterConfig {
  defaultModel: string;
  allowedModels: string[];
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | Array<{ type: string; text?: string }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export function createLlmService(config: LlmConfig): LlmService {
  function resolveModel(model: string | undefined) {
    const chosen = model ?? config.defaultModel;
    if (
      config.allowedModels.length > 0 &&
      !config.allowedModels.includes(chosen.toLowerCase())
    ) {
      throw new Error(
        `Model "${chosen}" is not allowed. Allowed: ${config.allowedModels.join(", ")}`,
      );
    }
    return chosen;
  }

  return {
    allowedModels: () => [...config.allowedModels],
    async complete(input): Promise<LlmCompleteResult> {
      const model = resolveModel(input.model);
      const body: Record<string, unknown> = { model, messages: input.messages };
      if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
      if (input.temperature !== undefined) body.temperature = input.temperature;

      const data = await openRouterPost<ChatCompletionResponse>(
        config,
        "/chat/completions",
        body,
      );
      const raw = data.choices?.[0]?.message?.content;
      const text = Array.isArray(raw)
        ? raw.map((part) => part.text ?? "").join("")
        : (raw ?? "");

      const result: LlmCompleteResult = { text, model: data.model ?? model };
      if (data.usage) {
        result.usage = {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          ...(data.usage.cost !== undefined ? { cost: data.usage.cost } : {}),
        };
      }
      return result;
    },
  };
}
