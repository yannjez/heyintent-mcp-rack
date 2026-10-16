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
import { createAuth } from "./auth/auth.js";
import { createOtpSender, type OtpSender } from "./auth/email.js";
import type { Env } from "./env.js";
import { sendWebResponse, toWebRequest } from "./http.js";
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

  const registry = new McpRegistry(db, catalog, options.environment ?? process.env);
  await registry.sync();

  const auth = createAuth(db, {
    baseUrl: env.baseUrl,
    secret: env.secret,
    isProduction: env.isProduction,
    trustedOrigins:
      env.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : [],
    allowedEmailDomains: env.allowedEmailDomains,
    adminEmails: env.adminEmails,
    sendOtp: options.sendOtp ?? createOtpSender(env, (message) => app.log.info(message)),
    userExists: async (email) =>
      Boolean(await db.user.findUnique({ where: { email }, select: { id: true } })),
    extraScopes: registry.definitions.flatMap((d) => mcpScopes(d.slug)),
  });

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
  app.get("/.well-known/oauth-protected-resource", async (request, reply) =>
    sendWebResponse(reply, await auth.handler(toWebRequest(request))),
  );
  app.get("/.well-known/oauth-protected-resource/*", async (request, reply) =>
    sendWebResponse(reply, await auth.handler(toWebRequest(request))),
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
  });

  await registerKeyRoutes(app, { auth, db, registry });

  await registerAdminRoutes(app, {
    auth,
    db,
    registry,
    baseUrl: env.baseUrl,
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
