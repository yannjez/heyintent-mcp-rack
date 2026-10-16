import type { DataStore } from "@rack/mcp-kit";
import { DEMO_CONTENT } from "./demo.js";

export type ContentType = "page" | "news" | "event";
export type ContentStatus = "draft" | "published";

export interface Content {
  slug: string;
  type: ContentType;
  title: string;
  summary: string;
  /** Markdown body. */
  body: string;
  tags: string[];
  status: ContentStatus;
  author: string | null;
  updatedAt: string;
  publishedAt: string | null;
}

export type ContentInput = Pick<
  Content,
  "slug" | "type" | "title" | "summary" | "body" | "tags"
>;

export interface SiteBackend {
  mode: "sandbox" | "site";
  list(filter: {
    type?: ContentType | undefined;
    status?: ContentStatus | undefined;
  }): Promise<Omit<Content, "body">[]>;
  get(slug: string): Promise<Content | null>;
  create(input: ContentInput, author: string): Promise<Content>;
  update(slug: string, patch: Partial<ContentInput>, author: string): Promise<Content>;
  setStatus(slug: string, status: ContentStatus): Promise<Content>;
  remove(slug: string): Promise<boolean>;
}

const PREFIX = "content:";
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function assertSlug(slug: string) {
  if (!SLUG.test(slug))
    throw new Error(`Invalid slug "${slug}": lowercase letters, digits and dashes`);
}

function summary(content: Content): Omit<Content, "body"> {
  const { body: _body, ...rest } = content;
  return rest;
}

/** Sandbox: content lives in the MCP-wide data store, seeded with demo pages. */
export function sandboxBackend(store: DataStore): SiteBackend {
  async function all(): Promise<Content[]> {
    const entries = await store.list(PREFIX);
    if (entries.length === 0) {
      for (const demo of DEMO_CONTENT) await store.set(PREFIX + demo.slug, demo);
      return [...DEMO_CONTENT];
    }
    return entries.map((entry) => entry.value as Content);
  }
  async function save(content: Content) {
    await store.set(PREFIX + content.slug, content);
    return content;
  }
  return {
    mode: "sandbox",
    async list(filter) {
      return (await all())
        .filter((c) => !filter.type || c.type === filter.type)
        .filter((c) => !filter.status || c.status === filter.status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summary);
    },
    async get(slug) {
      await all();
      return ((await store.get(PREFIX + slug)) as Content | null) ?? null;
    },
    async create(input, author) {
      assertSlug(input.slug);
      if (await this.get(input.slug))
        throw new Error(`Content "${input.slug}" already exists`);
      return save({
        ...input,
        status: "draft",
        author,
        updatedAt: new Date().toISOString(),
        publishedAt: null,
      });
    },
    async update(slug, patch, author) {
      const current = await this.get(slug);
      if (!current) throw new Error(`Unknown content "${slug}"`);
      if (patch.slug && patch.slug !== slug)
        throw new Error("Renaming a slug is not supported");
      return save({
        ...current,
        ...patch,
        slug,
        author,
        updatedAt: new Date().toISOString(),
      });
    },
    async setStatus(slug, status) {
      const current = await this.get(slug);
      if (!current) throw new Error(`Unknown content "${slug}"`);
      const now = new Date().toISOString();
      return save({
        ...current,
        status,
        updatedAt: now,
        publishedAt: status === "published" ? (current.publishedAt ?? now) : null,
      });
    },
    async remove(slug) {
      return store.delete(PREFIX + slug);
    },
  };
}

/** Public site: HTTP API `{apiUrl}/content[/slug]` with a bearer token. */
export function siteBackend(apiUrl: string, apiToken: string): SiteBackend {
  const base = apiUrl.replace(/\/$/, "");
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(base + path, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 404) return null as T;
    if (!response.ok)
      throw new Error(`Site API ${response.status}: ${await response.text()}`);
    if (response.status === 204) return null as T;
    return (await response.json()) as T;
  }
  const required = async <T>(promise: Promise<T | null>, slug: string) => {
    const value = await promise;
    if (!value) throw new Error(`Unknown content "${slug}"`);
    return value;
  };
  return {
    mode: "site",
    list(filter) {
      const params = new URLSearchParams();
      if (filter.type) params.set("type", filter.type);
      if (filter.status) params.set("status", filter.status);
      const query = params.toString();
      return call(`/content${query ? `?${query}` : ""}`);
    },
    get: (slug) => call(`/content/${encodeURIComponent(slug)}`),
    create: (input, author) =>
      call("/content", { method: "POST", body: JSON.stringify({ ...input, author }) }),
    update: (slug, patch, author) =>
      required(
        call(`/content/${encodeURIComponent(slug)}`, {
          method: "PATCH",
          body: JSON.stringify({ ...patch, author }),
        }),
        slug,
      ),
    setStatus: (slug, status) =>
      required(
        call(`/content/${encodeURIComponent(slug)}/status`, {
          method: "PUT",
          body: JSON.stringify({ status }),
        }),
        slug,
      ),
    async remove(slug) {
      await call(`/content/${encodeURIComponent(slug)}`, { method: "DELETE" });
      return true;
    },
  };
}
