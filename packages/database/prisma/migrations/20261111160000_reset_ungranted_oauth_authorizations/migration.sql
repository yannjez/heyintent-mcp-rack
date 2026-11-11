-- Authorizations accepted before "mcp_grants" existed carry MCP scopes without
-- a grant row, and the provider would keep renewing them without showing the
-- consent screen again. From now on a client without a grant has no access to
-- an MCP, so these are dropped once: the next authorization goes through the
-- consent screen, which writes the grant. Identity-only authorizations (no
-- "mcp:" scope) and API keys are left alone.
DELETE FROM "oauthAccessToken" t
WHERE t."userId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM unnest(t."scopes") AS scope WHERE scope LIKE 'mcp:%')
  AND NOT EXISTS (
    SELECT 1 FROM "mcp_grants" g
    WHERE g."clientId" = t."clientId" AND g."userId" = t."userId"
  );

DELETE FROM "oauthRefreshToken" t
WHERE EXISTS (SELECT 1 FROM unnest(t."scopes") AS scope WHERE scope LIKE 'mcp:%')
  AND NOT EXISTS (
    SELECT 1 FROM "mcp_grants" g
    WHERE g."clientId" = t."clientId" AND g."userId" = t."userId"
  );

DELETE FROM "oauthConsent" c
WHERE c."userId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM unnest(c."scopes") AS scope WHERE scope LIKE 'mcp:%')
  AND NOT EXISTS (
    SELECT 1 FROM "mcp_grants" g
    WHERE g."clientId" = c."clientId" AND g."userId" = c."userId"
  );
