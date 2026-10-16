# Ressource Rack · Intent

Rack [Intent](https://heyintent.com) pour déployer simplement des serveurs MCP (Model Context
Protocol) derrière une couche commune d'authentification, de comptes, de clés API et de services
partagés. Il expose les ressources de l'entreprise aux agents IA (Claude Code, Codex, Cursor…)
avec des accès nominatifs, en lecture ou en écriture.

- **Auth & comptes** : connexion par email OTP (en développement, le code s'affiche dans la
  console d'api-rack, même si SMTP est configuré), autodiscover OAuth 2.1 pour les clients MCP
  (Claude Code, Cursor…), clés API par utilisateur. Typologie d'utilisateur **interne / externe /
  client** ; les comptes externes et clients sont créés par un admin (hors domaine autorisé).
- **Disponibilité par groupes** : l'admin affecte des groupes aux MCP, puis des groupes aux
  utilisateurs. Un utilisateur peut appartenir à plusieurs groupes. Seuls les membres d'au moins
  un groupe autorisé peuvent accéder au MCP, y compris les administrateurs. Sans groupe commun,
  aucun accès ; retirer une association révoque immédiatement cet accès (clés API et OAuth inclus).
- **Droits individuels** : un MCP disponible est en **lecture** par défaut. L'admin règle
  **lecture / lecture & écriture** par utilisateur. Les groupes ne portent aucun niveau de droit.
  Les clés API et consentements OAuth ne peuvent jamais dépasser les droits de l'utilisateur.
  En lecture, les tools d'écriture ne sont pas exposés au client.
- **MCP** : un MCP est un package `mcps/<slug>` exposé sur `/mcp/<slug>`, enregistré en base au
  démarrage, administré (activation, paramètres de connexion chiffrés) et journalisé (page Logs).
  - `site-public` — contenu du site public heyintent.com (pages, actualités, événements) :
    lecture, rédaction, publication, via l'API REST configurée, sinon contenu de démonstration.
  - `sample` — MCP de référence exerçant les services techniques du rack.
- **Tools (packages/tools)** : briques techniques fournies aux MCP, invisibles dans l'interface :
  LLM via OpenRouter, génération d'image, push GitHub, données clé/valeur par (MCP, utilisateur).

## Stack

TypeScript strict ESM · pnpm workspaces · Turborepo · Fastify 5 · Better Auth 1.7 (`@better-auth/mcp`,
`@better-auth/api-key`, `admin`, `emailOTP`, `jwt`) · MCP TypeScript SDK v2
(`@modelcontextprotocol/server`) · PostgreSQL 18 + Prisma 7 · React 19 + Vite 8 + react-router.

```
apps/api-rack      Fastify : auth, OAuth, clés, admin REST, /mcp/<slug>, sert le build web en prod
apps/web-rack      React/Vite : login OTP, consent OAuth, Mon espace (Mes ressources, Mes clés),
                   Administration (Utilisateurs, Groupes, Ressources, Logs)
packages/database  Prisma (schéma Better Auth + Mcp, McpAccess, McpGroup, McpGroupMcp, McpGroupUser, McpData, ToolCall)
packages/mcp-kit   defineMcp(), types Access/Identity/ToolServices, describeTools(), helpers
packages/tools     services llm / image / github / data + journal des appels
mcps/site-public   contenu du site public (REST ou sandbox)
mcps/sample        MCP de référence exerçant les 4 services techniques
mcps/_template     squelette pour un nouveau MCP
```

## Démarrage

Prérequis : Node 22+, pnpm 10 (`corepack enable`), Docker.

```bash
cp .env.example .env            # renseigner BETTER_AUTH_SECRET (32+ caractères), ADMIN_EMAILS, OPENROUTER_API_KEY…
docker compose up -d            # PostgreSQL sur 127.0.0.1:5435
pnpm install
pnpm db:migrate                 # applique les migrations Prisma
pnpm db:seed                    # crée ou promeut yann@heyintent.com en admin
pnpm build                      # compile les packages (requis avant dev)
pnpm dev                        # api-rack sur :3001, web-rack sur :5173 (proxy vers l'API)
```

Ouvrir <http://localhost:5173>, se connecter avec un email du domaine autorisé : le code OTP
apparaît dans les logs d'api-rack. En dev, les pages `/login` et `/consent` demandées sur l'origine
de l'API (`BETTER_AUTH_URL`, où les clients OAuth sont envoyés) sont redirigées vers Vite
(`WEB_DEV_ORIGIN`). Les comptes listés dans `ADMIN_EMAILS` reçoivent le rôle admin
à leur création. Le seed crée aussi `yann@heyintent.com` en admin (ou promeut le compte existant),
sans modifier son nom ni son état de vérification. La connexion utilise toujours un code OTP.

## Connecter un client MCP

Deux modes, au choix du client :

1. **OAuth autodiscover** (recommandé pour Claude Code / Cursor) : le client reçoit un `401` avec
   `WWW-Authenticate: Bearer resource_metadata=…`, découvre le serveur d'autorisation, s'enregistre
   (DCR ou CIMD), ouvre le navigateur sur `/login` puis `/consent`, et obtient un access token lié à
   la ressource `/mcp` avec les scopes `mcp:<slug>:read` / `mcp:<slug>:write` consentis.

   ```bash
   claude mcp add --transport http sample http://localhost:3001/mcp/sample
   ```

2. **Clé API** : créée dans « Mes clés API » (restreinte à des MCP, en lecture ou en écriture),
   envoyée dans `Authorization: Bearer rk_…` ou `x-api-key`.

   ```bash
   claude mcp add --transport http sample http://localhost:3001/mcp/sample \
     --header "Authorization: Bearer rk_…"
   ```

Les deux modes produisent la même `Identity` côté serveur (`userId`, `grants.mcps`).
Accès effectif = disponibilité via un groupe commun ∩ droits individuels (lecture par défaut)
∩ niveau porté par la credential. Sans groupe commun, le MCP répond 403. En lecture, seuls les tools `readOnlyHint: true` sont servis.

## Ajouter un MCP

Voir [mcps/_template/README.md](mcps/_template/README.md) : copier le template, déclarer `slug`,
`settings`, `capabilities` et les tools avec `server.registerTool(...)` (lecture =
`readOnlyHint: true`), ajouter le package à `apps/api-rack/src/mcp/catalog.ts`,
`pnpm install && pnpm build`.

### Connexion aux systèmes cibles

L'authentification est toujours celle du rack : l'utilisateur se connecte en OAuth ou avec une
clé `rk_…`, le rack tranche son niveau d'accès, puis appelle le système cible (API du site, base
de données…) avec **ses propres identifiants de service**, lus dans l'environnement au démarrage.
Chaque MCP déclare dans `settings` la variable qu'il attend (`SITE_PUBLIC_API_URL`,
`SAMPLE_GITHUB_TOKEN`…) ; l'admin voit seulement si elle est renseignée, jamais sa valeur.
Variable absente = **mode démo** sur des données factices. Changer une valeur demande un
redémarrage de `api-rack`. La liste complète est dans [.env.example](.env.example).

## Commandes

```bash
pnpm validate     # lint + build + typecheck + test (nécessite la base locale pour les tests d'intégration)
pnpm dev          # tous les workspaces en mode watch
pnpm db:migrate   # prisma migrate dev
pnpm db:seed      # initialise le compte admin yann@heyintent.com (relançable)
pnpm auth:schema  # régénère les tables Better Auth dans packages/database/prisma/schema.prisma
```

## Réparer les clés JWT locales

Si la connexion locale échoue avec `Failed to decrypt private key` après un changement
de `BETTER_AUTH_SECRET`, exécuter `pnpm auth:repair-jwks`. Cette commande est réservée
au développement sur une base PostgreSQL locale : elle supprime uniquement les clés JWT
illisibles avec le secret actuel. Better Auth les remplace automatiquement à la prochaine
requête. Les comptes, clés API et données sont conservés ; les clients MCP utilisant les
anciens JWT doivent se reconnecter. Garder ensuite `BETTER_AUTH_SECRET` stable.

## Production

- `pnpm build`, puis `WEB_DIST=/chemin/apps/web-rack/dist node apps/api-rack/dist/server.js` :
  api-rack sert l'interface sur la même origine (`BETTER_AUTH_URL`).
- `BETTER_AUTH_URL` doit être en HTTPS hors loopback (exigence du plugin MCP) ; SMTP obligatoire,
  les codes OTP ne sont jamais loggés en production.
- Appliquer les migrations avec `pnpm --filter @rack/database migrate:deploy`.

### Déploiement Coolify

1. Créer une application depuis ce dépôt avec le build pack **Docker Compose**.
2. Choisir `/docker-compose.coolify.yml` comme fichier Compose (ne pas le combiner avec
   `docker-compose.yml`, réservé au PostgreSQL de développement).
3. Dans le service `app`, configurer le domaine
   `https://mcp-rack.vps02.heyintent.com:3000` : Coolify termine le HTTPS et transmet
   les requêtes au port interne 3000. L'URL publique reste
   `https://mcp-rack.vps02.heyintent.com`.
4. Vérifier que `SERVICE_URL_APP_3000` contient cette URL publique HTTPS, sans `:3000`
   ni slash final. `BETTER_AUTH_URL` reprend exactement cette variable. Utiliser
   `SERVICE_URL_…` (avec schéma), et non `SERVICE_FQDN_…` (nom d'hôte).
5. Coolify génère `SERVICE_PASSWORD_POSTGRES` et `SERVICE_BASE64_64_AUTH`. Conserver
   ces valeurs entre les déploiements : le secret d'authentification chiffre aussi
   les clés JWT et, par défaut, les secrets MCP. Si le mot de passe PostgreSQL est
   remplacé manuellement, utiliser des caractères compatibles avec une URL de connexion.
6. Renseigner `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`
   et `SMTP_FROM` pour recevoir les codes de connexion en production. Ajuster
   `ADMIN_EMAILS` et `ALLOWED_EMAIL_DOMAINS`, puis les variables des services nécessaires
   (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `SITE_PUBLIC_API_URL`…).
7. Déployer. L'image compile l'API et l'interface ; à chaque démarrage, elle applique
   les migrations Prisma avant de lancer l'API. Le compte listé dans `ADMIN_EMAILS`
   devient admin à sa première connexion, sans seed de production.

Le healthcheck vérifie `/health`. PostgreSQL utilise un volume persistant et n'expose
aucun port sur l'hôte. Aucun secret du `.env` local n'est copié dans l'image.

Référence : [Docker Compose dans Coolify](https://coolify.io/docs/applications/builds/docker-compose).
