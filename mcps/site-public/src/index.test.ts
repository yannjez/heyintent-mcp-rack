import { testMcp, type TestMcp } from "@rack/mcp-kit/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sitePublic, { createSiteMcp, SITE_SETTINGS } from "./index.js";

interface Content {
  slug: string;
  type: string;
  status: string;
  title: string;
  body?: string;
  publishedAt: string | null;
}

describe("site-public (sandbox)", () => {
  let mcp: TestMcp;
  beforeAll(async () => {
    mcp = await testMcp(sitePublic);
  });
  afterAll(() => mcp.close());

  it("lists and reads the demo content", async () => {
    const listed = await mcp.json<{ mode: string; items: Content[] }>("list_content");
    expect(listed.mode).toBe("sandbox");
    expect(listed.items.map((c) => c.slug)).toContain("accueil");
    expect(listed.items.every((c) => !("body" in c))).toBe(true);

    const news = await mcp.json<{ items: Content[] }>("list_content", { type: "news" });
    expect(news.items.every((c) => c.type === "news")).toBe(true);

    const home = await mcp.json<Content>("get_content", { slug: "accueil" });
    expect(home.body).toBeTruthy();
    expect(await mcp.call("get_content", { slug: "nope" })).toMatchObject({
      isError: true,
    });
  });

  it("drafts, edits, publishes and deletes content", async () => {
    const created = await mcp.json<Content>("create_content", {
      slug: "page-test",
      type: "page",
      title: "Page de test",
      body: "Un corps **Markdown**.",
    });
    expect(created).toMatchObject({ status: "draft", publishedAt: null });
    expect(
      await mcp.call("create_content", { slug: "page-test", type: "page", title: "x" }),
    ).toMatchObject({ isError: true });
    expect(
      await mcp.call("create_content", { slug: "Bad Slug", type: "page", title: "x" }),
    ).toMatchObject({ isError: true });

    const edited = await mcp.json<Content>("update_content", {
      slug: "page-test",
      title: "Page de test (v2)",
    });
    expect(edited.title).toBe("Page de test (v2)");

    const published = await mcp.json<Content>("publish_content", { slug: "page-test" });
    expect(published.status).toBe("published");
    expect(published.publishedAt).toBeTruthy();
    const found = await mcp.json<{ items: Content[] }>("search_content", {
      query: "markdown",
    });
    expect(found.items.map((c) => c.slug)).toContain("page-test");

    const draft = await mcp.json<Content>("unpublish_content", { slug: "page-test" });
    expect(draft).toMatchObject({ status: "draft", publishedAt: null });

    expect(await mcp.text("delete_content", { slug: "page-test" })).toMatch(/Deleted/);
    expect(await mcp.call("get_content", { slug: "page-test" })).toMatchObject({
      isError: true,
    });
  });
});

describe("site-public (configured API)", () => {
  it("reports an unreachable content API as a tool error", async () => {
    const mcp = await testMcp(sitePublic, { settings: { apiUrl: "http://127.0.0.1:9" } });
    try {
      const result = await mcp.call("list_content");
      expect(result.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("instantiates one definition per site resource", () => {
    expect(sitePublic.slug).toBe("site-public");
    expect(sitePublic.settings).toEqual(SITE_SETTINGS);
    const site = createSiteMcp({ slug: "site-sial", name: "Site SIAL", settings: [] });
    expect(site).toMatchObject({ slug: "site-sial", name: "Site SIAL", settings: [] });
    expect(() => createSiteMcp({ slug: "Bad Slug" })).toThrow(/Invalid MCP slug/);
  });
});
