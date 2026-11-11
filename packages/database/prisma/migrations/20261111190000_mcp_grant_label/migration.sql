-- A free-text name the user gives a connection when authorizing it. An OAuth
-- client never tells the rack which account is signed in on its side, so this
-- is how the user tells two connections of the same agent apart.
ALTER TABLE "mcp_grants" ADD COLUMN "label" TEXT;
