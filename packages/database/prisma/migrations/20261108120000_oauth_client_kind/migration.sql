-- An OAuth client is either an application a user opens, or a consumer: an
-- agent that calls the MCP endpoints (Codex, Claude Code…). A client that
-- registers itself through DCR is born a consumer; an admin promotes it.
ALTER TABLE "oauthClient" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'consumer';

-- One-time guess for the clients already registered: having a public address
-- is what an application has and an agent does not. Wrong guesses are fixed
-- from Administration → Applications et ressources.
UPDATE "oauthClient"
SET "kind" = 'application'
WHERE "uri" IS NOT NULL AND btrim("uri") <> '';

CREATE INDEX "oauthClient_kind_idx" ON "oauthClient"("kind");
