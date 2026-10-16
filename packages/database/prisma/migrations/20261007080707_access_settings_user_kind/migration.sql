/*
  Warnings:

  - You are about to drop the column `githubToken` on the `mcps` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "mcps" DROP COLUMN "githubToken",
ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'internal';

-- CreateTable
CREATE TABLE "mcp_access" (
    "id" TEXT NOT NULL,
    "mcpId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_access_userId_idx" ON "mcp_access"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_access_mcpId_userId_key" ON "mcp_access"("mcpId", "userId");

-- CreateIndex
CREATE INDEX "tool_calls_createdAt_idx" ON "tool_calls"("createdAt");

-- AddForeignKey
ALTER TABLE "mcp_access" ADD CONSTRAINT "mcp_access_mcpId_fkey" FOREIGN KEY ("mcpId") REFERENCES "mcps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
