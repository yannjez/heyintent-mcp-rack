-- AlterTable
ALTER TABLE "user" ADD COLUMN     "groupId" TEXT;

-- CreateTable
CREATE TABLE "mcp_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_group_mcps" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "mcpId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_group_mcps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_groups_name_key" ON "mcp_groups"("name");

-- CreateIndex
CREATE INDEX "mcp_group_mcps_mcpId_idx" ON "mcp_group_mcps"("mcpId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_group_mcps_groupId_mcpId_key" ON "mcp_group_mcps"("groupId", "mcpId");

-- CreateIndex
CREATE INDEX "user_groupId_idx" ON "user"("groupId");

-- AddForeignKey
ALTER TABLE "mcp_group_mcps" ADD CONSTRAINT "mcp_group_mcps_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "mcp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_group_mcps" ADD CONSTRAINT "mcp_group_mcps_mcpId_fkey" FOREIGN KEY ("mcpId") REFERENCES "mcps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "mcp_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
