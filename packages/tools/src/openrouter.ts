export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
  fetch?: FetchLike;
}

export function openRouterHeaders(config: OpenRouterConfig) {
  if (!config.apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.referer ?? "https://heyintent.com",
    "X-Title": config.title ?? "Intent Ressource Rack",
  };
}

export async function openRouterPost<T>(
  config: OpenRouterConfig,
  path: string,
  body: unknown,
): Promise<T> {
  const fetchImpl = config.fetch ?? fetch;
  const base = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: openRouterHeaders(config),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter ${path} failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await response.json()) as T;
}
