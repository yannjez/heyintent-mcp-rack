# Nouveau MCP

1. Copier ce dossier vers `mcps/<slug>` et renommer le package en `@rack/mcp-<slug>` dans `package.json`.
2. Dans `src/index.ts`, renseigner `slug`, `name`, `category`, `description`, les `capabilities` de
   service utilisées (`llm`, `image`, `github`, `data`) et, si le MCP se branche sur un système
   externe, ses `settings` : chaque entrée associe une clé (`apiUrl`) à la variable d'environnement
   que le rack lit au démarrage (`env: "MON_MCP_API_URL"`). Ajouter la variable à `.env.example`.
   Absente, le MCP doit fonctionner en mode démo.
3. Enregistrer les tools dans `register(server, ctx)` avec `server.registerTool(...)`. Un tool avec
   `annotations: { readOnlyHint: true }` est un tool de **lecture** ; tous les autres sont des tools
   d'**écriture**, masqués automatiquement pour les sessions en lecture seule. Les paramètres
   résolus depuis l'environnement sont dans `ctx.settings` (`""` si absents), le niveau d'accès
   dans `ctx.access`, les services du rack dans `ctx.tools`.
4. Ajouter la dépendance dans `apps/api-rack/package.json` et l'import dans
   `apps/api-rack/src/mcp/catalog.ts`.
5. `pnpm install && pnpm build` puis redémarrer `api-rack` : le MCP est enregistré en base, visible
   dans l'admin ; affectez-lui des groupes, puis affectez ces groupes aux utilisateurs.
