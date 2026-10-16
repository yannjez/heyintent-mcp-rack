import { describe, expect, it, vi } from "vitest";
import { createImageService } from "./image.js";

describe("image service", () => {
  it("returns base64 images without the data url prefix", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: "data:image/png;base64,AAAA", media_type: "image/png" }],
            usage: { cost: 0.04 },
          }),
        ),
    );
    const image = createImageService({
      apiKey: "k",
      defaultModel: "m",
      fetch: fetchImpl,
    });
    const result = await image.generate({ prompt: "a cat", aspectRatio: "1:1" });
    expect(result).toEqual({
      images: [{ base64: "AAAA", mimeType: "image/png" }],
      cost: 0.04,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "m",
      prompt: "a cat",
      n: 1,
      aspect_ratio: "1:1",
    });
  });
});
