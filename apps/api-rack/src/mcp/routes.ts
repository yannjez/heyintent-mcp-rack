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
  const handlers = new Map<string, McpHttpHandler>();
  for (const definition of deps.registry.definitions) {
    // External MCPs are served by their own app, which validates rack tokens.
    if (definition.external) continue;
    handlers.set(definition.slug, createRackMcpHandler(definition, deps));
  }
  app.addHook("onClose", async () => {
    await Promise.all([...handlers.values()].map((handler) => handler.close()));
  });

  const resource = mcpResource(deps.baseUrl);

  /**
   * Resolve the MCP and the caller's effective access, or an HTTP error:
   * 404 unknown/disabled MCP, 403 when neither the admin assignment nor the
   * credential allows it.
   */
  async function resolve(slug: string, identity: Identity) {
    const registered = await deps.registry.get(slug);
    const handler = handlers.get(slug);
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
