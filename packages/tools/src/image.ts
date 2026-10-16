import type { GeneratedImage, ImageService } from "@rack/mcp-kit";
import { type OpenRouterConfig, openRouterPost } from "./openrouter.js";

export interface ImageConfig extends OpenRouterConfig {
  defaultModel: string;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { cost?: number };
}

export function createImageService(config: ImageConfig): ImageService {
  return {
    async generate(input) {
      const body: Record<string, unknown> = {
        model: input.model ?? config.defaultModel,
        prompt: input.prompt,
        n: Math.min(Math.max(input.n ?? 1, 1), 4),
      };
      if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

      const data = await openRouterPost<ImagesResponse>(config, "/images", body);
      const images = (data.data ?? [])
        .filter((item): item is { b64_json: string; media_type?: string } =>
          Boolean(item.b64_json),
        )
        .map((item): GeneratedImage => ({
          base64: stripDataUrl(item.b64_json),
          mimeType: item.media_type ?? "image/png",
        }));
      if (images.length === 0) {
        throw new Error("OpenRouter returned no image");
      }
      return {
        images,
        ...(data.usage?.cost !== undefined ? { cost: data.usage.cost } : {}),
      };
    },
  };
}

function stripDataUrl(value: string) {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  return comma >= 0 ? value.slice(comma + 1) : value;
}
