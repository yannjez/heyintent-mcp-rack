ALTER TABLE "oauthClient" ADD COLUMN "accessRestricted" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "application_groups" (
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE,
  "groupId" TEXT NOT NULL REFERENCES "mcp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("clientId", "groupId")
);
CREATE INDEX "application_groups_groupId_idx" ON "application_groups"("groupId");

CREATE TABLE "application_access" (
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "allowed" BOOLEAN NOT NULL,
  PRIMARY KEY ("clientId", "userId")
);
CREATE INDEX "application_access_userId_idx" ON "application_access"("userId");
