-- The first guess (a client with a public address is an application) was wrong
-- for the agents identified by a client ID metadata document: ChatGPT and the
-- like publish a `client_uri`, so they were filed as applications and vanished
-- from « Mes consommateurs ». A client whose id is a URL described itself; an
-- admin never declared it. Consents and tokens are left untouched.
UPDATE "oauthClient"
SET "kind" = 'consumer'
WHERE "kind" = 'application'
  AND ("clientId" LIKE 'https://%' OR "clientId" LIKE 'http://%');
