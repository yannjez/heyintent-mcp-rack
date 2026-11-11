import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { Db } from "@rack/database";
import { type Logger, type McpDefinition, mcpScopes } from "@rack/mcp-kit";
import type { ToolServicesConfig } from "@rack/tools";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { existsSync } from "node:fs";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerKeyRoutes } from "./keys/routes.js";
import {
  BASE_SCOPES,
  createAuth,
  externalResourceIdentifiers,
  linkClientsToResources,
  liveAuth,
  mcpResource,
} from "./auth/auth.js";
import { createOtpSender, type OtpSender } from "./auth/email.js";
import {
  capByGrants,
  grantLevels,
  mcpResourceIdentifier,
  recordConsent,
  targetedSlugs,
} from "./auth/grants.js";
import type { Env } from "./env.js";
import { sendWebResponse, toWebRequest } from "./http.js";
import { McpNotifier } from "./mcp/notifier.js";
import { McpRegistry } from "./mcp/registry.js";
import { registerMcpRoutes } from "./mcp/routes.js";

export interface BuildAppOptions {
  env: Env;
  db: Db;
  catalog: McpDefinition[];
  /** Test seams. */
  sendOtp?: OtpSender;
  /** Where MCP connection parameters are read from (default `process.env`). */
  environment?: NodeJS.ProcessEnv;
  toolConfig?: Partial<ToolServicesConfig>;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, db, catalog } = options;
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
  });
  const log: Logger = {
    info: (m, d) => app.log.info(d ?? {}, m),
    warn: (m, d) => app.log.warn(d ?? {}, m),
    error: (m, d) => app.log.error(d ?? {}, m),
  };

  const registry = new McpRegistry(db, [...catalog, ...env.externalMcps], {
    environment: options.environment ?? process.env,
    secret: env.resourceSecret,
  });
  await registry.sync();

  const rackResource = mcpResource(env.baseUrl);
  const currentScopes = () => [
    ...BASE_SCOPES,
    ...registry.definitions.flatMap((d) => mcpScopes(d.slug)),
  ];
  const externalResources = registry.definitions.flatMap((d) =>
    d.external ? [{ slug: d.slug, name: d.name, url: d.external.url }] : [],
  );
  // MCPs served here are one OAuth resource each; external apps declare theirs.
  const localMcps = () => registry.definitions.filter((d) => !d.external);
  const mcpResourceIds = () =>
    localMcps().map((d) => mcpResourceIdentifier(env.baseUrl, d.slug));

  // Shared by the OAuth server and both route sets: the MCP routes build their
  // handlers on its buses, the others publish on them when rights move.
  const notifier = new McpNotifier({ log });

  const buildAuth = (scopes: readonly string[]) =>
    createAuth(db, {
      baseUrl: env.baseUrl,
      secret: env.secret,
      isProduction: env.isProduction,
      trustedOrigins:
        env.nodeEnv === "development"
          ? ["http://localhost:5173", "http://127.0.0.1:5173"]
          : [],
      adminEmails: env.adminEmails,
      sendOtp:
        options.sendOtp ?? createOtpSender(env, (message) => app.log.info(message)),
      externalResources,
      mcpResources: localMcps().map((d) => ({ slug: d.slug, name: d.name })),
      // The rack's own record of what each client may use, MCP by MCP.
      onConsent: async ({ resources, ...consent }) => {
        const targets = targetedSlugs(env.baseUrl, registry.definitions, resources);
        notifier.toolsChanged(await recordConsent(db, { ...consent, targets }));
      },
      // A disabled MCP grants nothing, and the level the account set for this
      // client applies, as on the rack's own /mcp/:slug route.
      mcpAccesses: async (userId, clientId) => {
        const [accesses, enabled, levels] = await Promise.all([
          registry.userAccesses(userId),
          db.mcp.findMany({ where: { enabled: true }, select: { slug: true } }),
          grantLevels(db, { userId, clientId }),
        ]);
        const slugs = new Set(enabled.map((mcp) => mcp.slug));
        for (const slug of Object.keys(accesses)) {
          if (!slugs.has(slug)) delete accesses[slug];
        }
        return capByGrants(accesses, levels);
      },
      extraScopes: [...scopes],
    });

  // Better Auth copies its scope list when it is built, so the OAuth server
  // is rebuilt whenever the registry changes: the scopes of a resource added
  // at runtime are advertised and accepted without a restart. The protected
  // resource row and the clients that were handed the rack's full scope list
  // at registration follow; clients that chose a subset keep it.
  let scopes = currentScopes();
  let current = buildAuth(scopes);
  const auth = liveAuth(() => current);
  let syncing = Promise.resolve();
  registry.onChange(() => {
    syncing = syncing.then(async () => {
      const previous = scopes;
      const next = currentScopes();
      try {
        const rebuilt = buildAuth(next);
        await rebuilt.$context;
        current = rebuilt;
        scopes = next;
        await db.oauthResource.updateMany({
          where: { identifier: rackResource },
          data: { allowedScopes: next },
        });
        // The resource of an MCP added at runtime was seeded by the rebuild:
        // open it to the clients already registered, and drop the resources
        // of MCPs that are gone.
        const identifiers = mcpResourceIds();
        await linkClientsToResources(db, identifiers);
        await db.oauthResource.deleteMany({
          where: {
            identifier: { startsWith: `${rackResource}/`, notIn: identifiers },
          },
        });
        await db.oauthClient.updateMany({
          where: { scopes: { hasEvery: previous } },
          data: { scopes: next },
        });
      } catch (error) {
        log.warn("oauth scopes sync failed", { error: String(error) });
      }
    });
    return syncing;
  });

  // Resource rows are seeded when Better Auth initializes; then give clients
  // registered before an external app was declared access to its resources.
  await auth.$context;
  const linked = await linkClientsToResources(db, [
    ...mcpResourceIds(),
    ...externalResourceIdentifiers(externalResources),
  ]);
  if (linked > 0) log.info("linked existing OAuth clients to resources", { linked });

  await app.register(fastifyCors, {
    origin: [env.baseUrl],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Api-Key",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "DPoP",
    ],
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
  });

  // Accept any JSON-ish and form bodies as strings so they can be re-sent verbatim.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.get("/health", async () => ({
    status: "ok",
    mcps: registry.definitions.map((d) => d.slug),
  }));

  // Better Auth (OTP, sessions, API keys, OAuth 2.1 provider, JWKS).
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const response = await auth.handler(toWebRequest(request));
      return sendWebResponse(reply, response);
    },
  });

  // Discovery documents at the origin root, as MCP clients expect them.
  // RFC 8414 allows both the root document and the issuer-path-suffixed one
  // (the issuer is <origin>/api/auth), so serve both spellings.
  for (const doc of ["oauth-authorization-server", "openid-configuration"]) {
    const target = `/api/auth/.well-known/${doc}`;
    const relay = async (request: FastifyRequest, reply: FastifyReply) =>
      sendWebResponse(reply, await auth.handler(toWebRequest(request, target)));
    app.get(`/.well-known/${doc}`, relay);
    app.get(`/.well-known/${doc}/*`, relay);
  }
  // RFC 9728, one document per MCP: a client connecting to /mcp/<slug> is
  // told about that MCP's two scopes only, so the consent screen it opens
  // shows this MCP and not the whole rack. The provider knows a single
  // protected resource; its document is reused with the MCP's own identity.
  // Nothing else is a protected resource here: no document at the root nor
  // for an unknown MCP, or a client that got an address wrong would fall
  // back on it and ask for the whole rack.
  const rackResourcePath = new URL(rackResource).pathname.replace(/\/$/, "");
  app.get<{ Params: { "*": string } }>(
    "/.well-known/oauth-protected-resource/*",
    async (request, reply) => {
      const path = `/${request.params["*"]}`.replace(/\/$/, "");
      const slug = path.startsWith(`${rackResourcePath}/`)
        ? path.slice(rackResourcePath.length + 1)
        : null;
      const definition = slug ? registry.definition(slug) : undefined;
      if (!slug || !definition || definition.external) {
        return reply.code(404).send({ error: "Unknown protected resource" });
      }
      const base = await auth.handler(
        toWebRequest(request, `/.well-known/oauth-protected-resource${rackResourcePath}`),
      );
      if (!base.ok) return sendWebResponse(reply, base);
      const metadata = (await base.json()) as Record<string, unknown>;
      return reply.header("cache-control", "no-store").send({
        ...metadata,
        resource: mcpResourceIdentifier(env.baseUrl, slug),
        scopes_supported: mcpScopes(slug),
      });
    },
  );

  const toolConfig: ToolServicesConfig = {
    openRouter: {
      apiKey: env.openRouter.apiKey,
      defaultModel: env.openRouter.defaultModel,
      allowedModels: env.openRouter.allowedModels,
      imageModel: env.openRouter.imageModel,
      ...options.toolConfig?.openRouter,
    },
    github: { token: env.githubToken, ...options.toolConfig?.github },
  };

  await registerMcpRoutes(app, {
    auth,
    db,
    registry,
    baseUrl: env.baseUrl,
    toolConfig,
    log,
    notifier,
  });

  await registerKeyRoutes(app, { auth, db, registry });

  await registerAdminRoutes(app, {
    auth,
    db,
    registry,
    baseUrl: env.baseUrl,
    notifier,
  });

  const isAppRequest = (request: FastifyRequest) =>
    request.method === "GET" &&
    !request.url.startsWith("/api") &&
    !request.url.startsWith("/mcp") &&
    !request.url.startsWith("/.well-known");

  // Development without a built UI: Better Auth sends OAuth clients to
  // <BETTER_AUTH_URL>/login and /consent, which only Vite can render. Hand the
  // browser over to the dev server, query string included.
  if (!(env.webDist && existsSync(env.webDist)) && env.webDevOrigin) {
    app.setNotFoundHandler(async (request, reply) => {
      if (isAppRequest(request) && (request.headers.accept ?? "").includes("text/html")) {
        return reply.redirect(`${env.webDevOrigin}${request.url}`, 302);
      }
      return reply.status(404).send({ error: "Not found" });
    });
  }

  // Production: serve the built web UI (SPA fallback) from the same origin.
  if (env.webDist && existsSync(env.webDist)) {
    await app.register(fastifyStatic, { root: env.webDist, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (isAppRequest(request)) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({ error: "Not found" });
    });
  }

  app.decorate("auth", auth);
  app.decorate("registry", registry);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: ReturnType<typeof createAuth>;
    registry: McpRegistry;
  }
}
