-- The first guess (a client with a public address is an application) filed
-- ChatGPT as an application: its client ID metadata document publishes a
-- `client_uri`, so it vanished from « Mes consommateurs ».
--
-- Only that client is refiled. Nothing in the row tells a wrong guess from a
-- promotion an admin made on purpose, so a rule over every URL-valued client
-- ID would undo such promotions. Other agents filed by mistake are refiled
-- from Administration → Applications et ressources, which keeps their consents.
--
-- Even for this one, any sign of admin work means it is treated as a product
-- and left alone: an MCP channel attached to it, a restricted
-- access, or groups.
-- Consents and tokens are left untouched.
UPDATE "oauthClient" AS c
SET "kind" = 'consumer'
WHERE c."clientId" = 'https://chatgpt.com/oauth/client.json'
  AND c."kind" = 'application'
  AND c."accessRestricted" = false
  AND NOT EXISTS (SELECT 1 FROM "mcps" m WHERE m."clientId" = c."clientId")
  AND NOT EXISTS (
    SELECT 1 FROM "application_groups" g WHERE g."clientId" = c."clientId"
  );
