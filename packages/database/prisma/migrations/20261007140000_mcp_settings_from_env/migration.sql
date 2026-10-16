-- MCP connection parameters now come from the rack's environment variables.
-- AlterTable
ALTER TABLE "mcps" DROP COLUMN "settings";
