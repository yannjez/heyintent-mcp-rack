-- Preserve existing memberships while allowing multiple groups per user.
CREATE TABLE "mcp_group_users" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "mcp_group_users_pkey" PRIMARY KEY ("groupId", "userId"),
    CONSTRAINT "mcp_group_users_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "mcp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mcp_group_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "mcp_group_users_userId_idx" ON "mcp_group_users"("userId");
INSERT INTO "mcp_group_users" ("groupId", "userId")
SELECT "groupId", "id" FROM "user" WHERE "groupId" IS NOT NULL;
ALTER TABLE "user" DROP CONSTRAINT "user_groupId_fkey";
DROP INDEX "user_groupId_idx";
ALTER TABLE "user" DROP COLUMN "groupId";

-- Preserve existing read/write rights on users before removing group access levels.
INSERT INTO "mcp_access" ("id", "mcpId", "userId", "access", "createdAt", "updatedAt")
SELECT 'group-migration-' || md5(gm."mcpId" || ':' || gu."userId"), gm."mcpId", gu."userId",
       CASE WHEN bool_or(gm."access" = 'write') THEN 'write' ELSE 'read' END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "mcp_group_mcps" gm JOIN "mcp_group_users" gu ON gu."groupId" = gm."groupId"
GROUP BY gm."mcpId", gu."userId"
ON CONFLICT ("mcpId", "userId") DO UPDATE SET
  "access" = CASE WHEN "mcp_access"."access" = 'write' OR EXCLUDED."access" = 'write' THEN 'write' ELSE 'read' END,
  "updatedAt" = CURRENT_TIMESTAMP;
ALTER TABLE "mcp_group_mcps" DROP COLUMN "access";
