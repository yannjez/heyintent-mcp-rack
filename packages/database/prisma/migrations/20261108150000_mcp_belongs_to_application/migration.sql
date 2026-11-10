-- A product has a back-office and an MCP: two channels, one product. The
-- application carries the product identity (name, public address) and its MCP
-- resources hang off it. A resource with no application stands alone.
--
-- SET NULL, not CASCADE: removing the back-office must not delete the MCP
-- channel, which keeps serving agents on its own.
ALTER TABLE "mcps" ADD COLUMN "clientId" TEXT;

ALTER TABLE "mcps"
  ADD CONSTRAINT "mcps_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauthClient"("clientId")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "mcps_clientId_idx" ON "mcps"("clientId");
