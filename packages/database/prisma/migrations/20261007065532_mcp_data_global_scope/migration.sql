/*
  Warnings:

  - Made the column `userId` on table `mcp_data` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "mcp_data" ALTER COLUMN "userId" SET NOT NULL,
ALTER COLUMN "userId" SET DEFAULT '';
