import type { Db } from "@rack/database";
import type { DataEntry, DataService, DataStore } from "@rack/mcp-kit";

const KEY = /^[A-Za-z0-9._:/-]{1,200}$/;

function assertKey(key: string) {
  if (!KEY.test(key)) {
    throw new Error("Invalid key: use 1-200 chars among letters, digits, . _ : / -");
  }
}

/** Sentinel userId for the MCP-wide namespace. */
export const GLOBAL_SCOPE = "";

function createStore(db: Db, mcpId: string, userId: string): DataStore {
  return {
    async get(key) {
      assertKey(key);
      const row = await db.mcpData.findUnique({
        where: { mcpId_userId_key: { mcpId, userId, key } },
      });
      return row ? row.value : null;
    },
    async set(key, value) {
      assertKey(key);
      const json =
        value === undefined ? null : (JSON.parse(JSON.stringify(value)) as object);
      await db.mcpData.upsert({
        where: { mcpId_userId_key: { mcpId, userId, key } },
        create: { mcpId, userId, key, value: json ?? {} },
        update: { value: json ?? {} },
      });
    },
    async delete(key) {
      assertKey(key);
      const result = await db.mcpData.deleteMany({ where: { mcpId, userId, key } });
      return result.count > 0;
    },
    async list(prefix) {
      const rows = await db.mcpData.findMany({
        where: { mcpId, userId, ...(prefix ? { key: { startsWith: prefix } } : {}) },
        orderBy: { key: "asc" },
        take: 500,
      });
      return rows.map((row): DataEntry => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
  };
}

export function createDataService(db: Db, mcpId: string, userId: string): DataService {
  return {
    ...createStore(db, mcpId, userId),
    global: createStore(db, mcpId, GLOBAL_SCOPE),
  };
}
