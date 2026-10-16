import { createPrismaClient } from "@rack/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataService } from "./data.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("data service (postgres)", () => {
  const db = createPrismaClient(url);
  let mcpId = "";

  beforeAll(async () => {
    const mcp = await db.mcp.upsert({
      where: { slug: "test-data" },
      create: { slug: "test-data", name: "Test" },
      update: {},
    });
    mcpId = mcp.id;
    await db.mcpData.deleteMany({ where: { mcpId } });
  });

  afterAll(async () => {
    await db.mcp.deleteMany({ where: { slug: "test-data" } });
    await db.$disconnect();
  });

  it("isolates user and global namespaces", async () => {
    const alice = createDataService(db, mcpId, "alice");
    const bob = createDataService(db, mcpId, "bob");

    await alice.set("note", { text: "hello" });
    await alice.global.set("shared", 42);

    expect(await alice.get("note")).toEqual({ text: "hello" });
    expect(await bob.get("note")).toBeNull();
    expect(await bob.global.get("shared")).toBe(42);

    await alice.set("note", "updated");
    expect(await alice.get("note")).toBe("updated");
    expect(await alice.list()).toMatchObject([{ key: "note", value: "updated" }]);

    expect(await alice.delete("note")).toBe(true);
    expect(await alice.delete("note")).toBe(false);
  });

  it("rejects bad keys", async () => {
    const svc = createDataService(db, mcpId, "u");
    await expect(svc.set("bad key!", 1)).rejects.toThrow(/Invalid key/);
  });
});
