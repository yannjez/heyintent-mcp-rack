import { defineExternalMcp, type McpDefinition } from "@rack/mcp-kit";

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `EXTERNAL_MCPS`: JSON array of apps hosted elsewhere that sign in through the
 * rack, e.g. `[{"slug":"veille-ao","name":"Veille AO","url":"https://ao.example.com"}]`.
 */
export function parseExternalMcps(value: string | undefined): McpDefinition[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("EXTERNAL_MCPS must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("EXTERNAL_MCPS must be a JSON array");
  return parsed.map((entry: Record<string, unknown>) => {
    const text = (key: string) =>
      typeof entry?.[key] === "string" ? (entry[key] as string) : undefined;
    const slug = text("slug");
    const name = text("name");
    const url = text("url");
    if (!slug || !name || !url) {
      throw new Error("Each EXTERNAL_MCPS entry needs slug, name and url");
    }
    const description = text("description");
    const category = text("category");
    return defineExternalMcp({
      slug,
      name,
      url,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
    });
  });
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  const baseUrl = source.BETTER_AUTH_URL ?? "http://localhost:3001";
  const secret = source.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be configured with at least 32 characters");
  }

  return {
    nodeEnv: source.NODE_ENV ?? "development",
    isProduction: source.NODE_ENV === "production",
    port: Number(source.PORT ?? 3001),
    host: source.HOST ?? "127.0.0.1",
    baseUrl,
    secret,
    databaseUrl: source.DATABASE_URL,
    adminEmails: list(source.ADMIN_EMAILS),
    smtp:
      source.SMTP_HOST && source.SMTP_USER && source.SMTP_PASSWORD
        ? {
            host: source.SMTP_HOST,
            port: Number(source.SMTP_PORT ?? 587),
            secure: source.SMTP_SECURE === "true",
            user: source.SMTP_USER,
            password: source.SMTP_PASSWORD,
            from: source.SMTP_FROM ?? "Intent Ressource Rack <no-reply@heyintent.com>",
          }
        : null,
    openRouter: {
      apiKey: source.OPENROUTER_API_KEY ?? "",
      defaultModel: source.OPENROUTER_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4.5",
      allowedModels: list(source.OPENROUTER_ALLOWED_MODELS),
      imageModel: source.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image",
    },
    githubToken: source.GITHUB_TOKEN ?? "",
    externalMcps: parseExternalMcps(source.EXTERNAL_MCPS),
    webDist: source.WEB_DIST ?? "",
    /** Dev only: where the Vite UI lives, so /login and /consent can be reached from the API origin. */
    webDevOrigin:
      source.WEB_DEV_ORIGIN ??
      (source.NODE_ENV === "production" ? "" : "http://localhost:5173"),
  };
}

export type Env = ReturnType<typeof loadEnv>;
