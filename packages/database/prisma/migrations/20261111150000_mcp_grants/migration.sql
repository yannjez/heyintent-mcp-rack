-- What a user allowed one OAuth client to do on one MCP. Better Auth keeps a
-- single consent row per client and account and overwrites it on each
-- authorization, so it cannot tell which MCPs a consumer may still use. This
-- table is the rack's own record: written on consent, checked on every call.
CREATE TABLE "mcp_grants" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mcpId" TEXT NOT NULL,
  "access" TEXT NOT NULL,
  "consentedAccess" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "mcp_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_grants_clientId_userId_mcpId_key" ON "mcp_grants"("clientId", "userId", "mcpId");
CREATE INDEX "mcp_grants_userId_idx" ON "mcp_grants"("userId");
CREATE INDEX "mcp_grants_mcpId_idx" ON "mcp_grants"("mcpId");

ALTER TABLE "mcp_grants"
  ADD CONSTRAINT "mcp_grants_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauthClient"("clientId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_grants"
  ADD CONSTRAINT "mcp_grants_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_grants"
  ADD CONSTRAINT "mcp_grants_mcpId_fkey"
  FOREIGN KEY ("mcpId") REFERENCES "mcps"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
