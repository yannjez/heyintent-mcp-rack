import { defineMcp, guarded, jsonResult, textResult } from "@rack/mcp-kit";
import * as z from "zod";
import { assertSlug, sandboxBackend, type SiteBackend, siteBackend } from "./backend.js";

const contentType = z.enum(["page", "news", "event"]);
const contentStatus = z.enum(["draft", "published"]);

/**
 * Site public: read and edit the content of the public website (pages, news,
 * events). Writes create drafts or update existing content; publishing is a
 * separate explicit tool. Without an API URL the MCP works on demo content
 * stored in the rack.
 */
export default defineMcp({
  slug: "site-public",
  name: "Site public",
  version: "0.2.0",
  category: "Site web",
  description:
    "Accès au contenu du site public : pages, actualités et événements, en lecture, rédaction et publication.",
  capabilities: ["data"],
  settings: [
    {
      key: "apiUrl",
      env: "SITE_PUBLIC_API_URL",
      label: "URL de l'API de contenu",
      description: "Point d'entrée REST du site public. Absente = contenu de démonstration.",
      example: "https://heyintent.com/api/content",
    },
    {
      key: "apiToken",
      env: "SITE_PUBLIC_API_TOKEN",
      label: "Jeton d'API",
      description: "Jeton Bearer utilisé par le rack pour lire et modifier le contenu.",
    },
  ],
  register(server, ctx) {
    const backend = (): SiteBackend =>
      ctx.settings.apiUrl
        ? siteBackend(ctx.settings.apiUrl, ctx.settings.apiToken ?? "")
        : sandboxBackend(ctx.tools.data.global);
    const author = ctx.identity.email ?? ctx.identity.userId;

    server.registerTool(
      "list_content",
      {
        title: "Lister le contenu",
        description:
          "Pages, actualités et événements du site, filtrables par type et statut (sans le corps).",
        inputSchema: z.object({
          type: contentType.optional(),
          status: contentStatus.optional(),
        }),
        annotations: { readOnlyHint: true },
      },
      async (filter) =>
        guarded(async () => {
          const site = backend();
          return jsonResult({ mode: site.mode, items: await site.list(filter) });
        }),
    );

    server.registerTool(
      "get_content",
      {
        title: "Lire un contenu",
        description: "Contenu complet (corps en Markdown) identifié par son slug.",
        inputSchema: z.object({ slug: z.string().min(1).max(100) }),
        annotations: { readOnlyHint: true },
      },
      async ({ slug }) =>
        guarded(async () => {
          const content = await backend().get(slug);
          if (!content) throw new Error(`Unknown content "${slug}"`);
          return jsonResult(content);
        }),
    );

    server.registerTool(
      "search_content",
      {
        title: "Rechercher",
        description:
          "Recherche plein texte simple dans les titres, résumés, tags et corps.",
        inputSchema: z.object({ query: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: true },
      },
      async ({ query }) =>
        guarded(async () => {
          const site = backend();
          const needle = query.toLowerCase();
          const hits = [];
          for (const item of await site.list({})) {
            const full = await site.get(item.slug);
            const haystack = [
              item.title,
              item.summary,
              item.tags.join(" "),
              full?.body ?? "",
            ]
              .join("\n")
              .toLowerCase();
            if (haystack.includes(needle)) hits.push(item);
          }
          return jsonResult({ query, items: hits });
        }),
    );

    server.registerTool(
      "create_content",
      {
        title: "Créer un contenu",
        description: "Crée une page, une actualité ou un événement en brouillon.",
        inputSchema: z.object({
          slug: z.string().min(1).max(100),
          type: contentType,
          title: z.string().min(1).max(200),
          summary: z.string().max(500).default(""),
          body: z.string().max(100_000).default(""),
          tags: z.array(z.string().max(40)).max(20).default([]),
        }),
      },
      async (input) =>
        guarded(async () => {
          assertSlug(input.slug);
          return jsonResult(await backend().create(input, author));
        }),
    );

    server.registerTool(
      "update_content",
      {
        title: "Modifier un contenu",
        description:
          "Met à jour le titre, le résumé, le corps ou les tags d'un contenu existant.",
        inputSchema: z.object({
          slug: z.string().min(1).max(100),
          title: z.string().min(1).max(200).optional(),
          summary: z.string().max(500).optional(),
          body: z.string().max(100_000).optional(),
          tags: z.array(z.string().max(40)).max(20).optional(),
        }),
        annotations: { idempotentHint: true },
      },
      async ({ slug, ...patch }) =>
        guarded(async () => {
          const clean = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          );
          return jsonResult(await backend().update(slug, clean, author));
        }),
    );

    server.registerTool(
      "publish_content",
      {
        title: "Publier",
        description: "Publie un contenu (visible sur le site public).",
        inputSchema: z.object({ slug: z.string().min(1).max(100) }),
        annotations: { idempotentHint: true },
      },
      async ({ slug }) =>
        guarded(async () => jsonResult(await backend().setStatus(slug, "published"))),
    );

    server.registerTool(
      "unpublish_content",
      {
        title: "Dépublier",
        description: "Repasse un contenu en brouillon.",
        inputSchema: z.object({ slug: z.string().min(1).max(100) }),
        annotations: { idempotentHint: true },
      },
      async ({ slug }) =>
        guarded(async () => jsonResult(await backend().setStatus(slug, "draft"))),
    );

    server.registerTool(
      "delete_content",
      {
        title: "Supprimer",
        description: "Supprime définitivement un contenu.",
        inputSchema: z.object({ slug: z.string().min(1).max(100) }),
        annotations: { destructiveHint: true },
      },
      async ({ slug }) =>
        guarded(async () =>
          textResult(
            (await backend().remove(slug)) ? `Deleted "${slug}".` : `No "${slug}".`,
          ),
        ),
    );
  },
});
