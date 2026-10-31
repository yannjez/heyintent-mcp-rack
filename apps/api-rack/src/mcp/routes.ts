import { requireMcpAuth } from "@better-auth/mcp";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { effectiveAccess, type Identity, type Logger } from "@rack/mcp-kit";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth/auth.js";
import {
  extractApiKey,
  identityFromAccessToken,
  identityFromApiKey,
} from "../auth/identity.js";
import { canAccessApplication } from "../auth/applications.js";
import { mcpResource } from "../auth/auth.js";
import { jsonError, sendWebResponse, toWebRequest } from "../http.js";
import { createRackMcpHandler, type McpHandlerDeps, toAuthInfo } from "./handler.js";
import type { McpRegistry } from "./registry.js";

export interface McpRoutesDeps extends McpHandlerDeps {
  auth: Auth;
  registry: McpRegistry;
  baseUrl: string;
  log: Logger;
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpRoutesDeps) {
  // Handlers are built on first use so resources added at runtime are served
  // without a restart; a changed or removed definition drops its handler.
  const handlers = new Map<string, McpHttpHandler>();
  function handlerFor(slug: string): McpHttpHandler | null {
    const cached = handlers.get(slug);
    if (cached) return cached;
    const definition = deps.registry.definition(slug);
    // External MCPs are served by their own app, which validates rack tokens.
    if (!definition || definition.external) return null;
    const handler = createRackMcpHandler(definition, deps);
    handlers.set(slug, handler);
    return handler;
  }
  const unsubscribe = deps.registry.onChange((slug) => {
    const stale = handlers.get(slug);
    handlers.delete(slug);
    void stale?.close().catch(() => {});
  });
  app.addHook("onClose", async () => {
    unsubscribe();
    await Promise.all([...handlers.values()].map((handler) => handler.close()));
  });

  const resource = mcpResource(deps.baseUrl);

  /**
   * Resolve the MCP and the caller's effective access, or an HTTP error:
   * 404 unknown/disabled MCP, 403 when neither the admin assignment nor the
   * credential allows it.
   */
  async function resolve(slug: string, identity: Identity) {
    if (
      identity.via === "oauth" &&
      (!identity.clientId ||
        !(await canAccessApplication(deps.db, identity.clientId, identity.userId)))
    ) {
      return { status: 403 as const, error: "Application access denied" };
    }
    const registered = await deps.registry.get(slug);
    const handler = registered ? handlerFor(slug) : null;
    if (!registered || !handler || !registered.record.enabled) {
      return { status: 404 as const, error: `MCP "${slug}" not found` };
    }
    const assigned = await deps.registry.userAccess(
      identity.userId,
      registered.record.id,
    );
    const access = effectiveAccess(assigned, identity, slug);
    if (!access) {
      return {
        status: 403 as const,
        error: assigned
          ? `This credential cannot use MCP "${slug}"`
          : `No access to MCP "${slug}": ask an administrator`,
      };
    }
    return { status: 200 as const, registered, handler, access };
  }

  app.route<{ Params: { slug: string } }>({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp/:slug",
    config: { rawBody: true },
    async handler(request, reply) {
      const { slug } = request.params;
      const webRequest = toWebRequest(request);
      const parsedBody = request.body !== undefined ? { parsedBody: request.body } : {};

      // 1. API key (Authorization: Bearer rk_… or x-api-key)
      const apiKey = extractApiKey(webRequest.headers);
      if (apiKey) {
        const identity = await identityFromApiKey(deps.auth, apiKey);
        if (!identity) return jsonError(reply, 401, "Invalid API key");
        const resolved = await resolve(slug, identity);
        if (resolved.status !== 200)
          return jsonError(reply, resolved.status, resolved.error);
        const response = await resolved.handler.fetch(webRequest, {
          authInfo: toAuthInfo(identity, resolved.registered.record, resolved.access),
          ...parsedBody,
        });
        return sendWebResponse(reply, response);
      }

      // 2. OAuth access token, or the RFC 9728 challenge when missing.
      const protectedHandler = requireMcpAuth(
        deps.auth,
        async (req, claims) => {
          const identity = identityFromAccessToken(claims);
          if (!identity)
            return Response.json({ error: "Invalid token subject" }, { status: 401 });
          const resolved = await resolve(slug, identity);
          if (resolved.status !== 200) {
            return Response.json({ error: resolved.error }, { status: resolved.status });
          }
          return resolved.handler.fetch(req, {
            authInfo: toAuthInfo(identity, resolved.registered.record, resolved.access),
            ...parsedBody,
          });
        },
        { resource },
      );
      const response = await protectedHandler(webRequest);
      return sendWebResponse(reply, response);
    },
  });
}
