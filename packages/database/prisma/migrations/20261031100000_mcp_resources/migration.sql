-- Resources added by an administrator: a public site driven by the site-public
-- package, or a remote MCP server relayed by the rack. Packages shipped with
-- the rack keep kind "package" and no config.
ALTER TABLE "mcps" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'package';
ALTER TABLE "mcps" ADD COLUMN "config" JSONB;
