import { requireMcpAuth } from "@better-auth/mcp";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import {
  effectiveAccess,
  type Identity,
  type Logger,
  mcpScopes,
  minAccess,
} from "@rack/mcp-kit";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth/auth.js";
import {
  extractApiKey,
  identityFromAccessToken,
  identityFromApiKey,
} from "../auth/identity.js";
import { canAccessApplication } from "../auth/applications.js";
import { mcpResource } from "../auth/auth.js";
import { mcpResourceIdentifier } from "../auth/grants.js";
import { jsonError, sendWebResponse, toWebRequest } from "../http.js";
import { createRackMcpHandler, type McpHandlerDeps, toAuthInfo } from "./handler.js";
import type { McpNotifier } from "./notifier.js";
import { type McpRegistry, toAccess } from "./registry.js";

export interface McpRoutesDeps extends McpHandlerDeps {
  auth: Auth;
  registry: McpRegistry;
  baseUrl: string;
  log: Logger;
  /** Shared with the admin routes, which publish on it when rights change. */
  notifier: McpNotifier;
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
    const handler = createRackMcpHandler(definition, deps, deps.notifier.bus(slug));
    handlers.set(slug, handler);
    return handler;
  }
  const unsubscribe = deps.registry.onChange((slug) => {
    const stale = handlers.get(slug);
    handlers.delete(slug);
    if (!stale) return;
    // A changed definition is a changed tool list. Publish before closing:
    // the listen router enqueues the frame synchronously, and `close()` then
    // ends each stream gracefully so the client knows to listen again.
    deps.notifier.toolsChanged([slug]);
    void stale.close().catch(() => {});
  });
  app.addHook("onClose", async () => {
    unsubscribe();
    await Promise.all([...handlers.values()].map((handler) => handler.close()));
  });

  const rack = new URL(mcpResource(deps.baseUrl));
  const origin = rack.origin;
  const resourcePath = rack.pathname.replace(/\/$/, "");

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
    let access = effectiveAccess(assigned, identity, slug);
    // An OAuth client also needs what the user granted it on this MCP: the
    // row is read on every call, so a cut applies before the token expires.
    if (identity.via === "oauth" && identity.clientId) {
      const grant = await deps.db.mcpGrant.findUnique({
        where: {
          clientId_userId_mcpId: {
            clientId: identity.clientId,
            userId: identity.userId,
            mcpId: registered.record.id,
          },
        },
        select: { access: true },
      });
      if (!grant) return { status: 401 as const, error: "Authorization withdrawn" };
      access = minAccess(access, toAccess(grant.access));
    }
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

      // An unknown slug is no OAuth resource: nothing to challenge for.
      if (!deps.registry.definition(slug)) {
        return jsonError(reply, 404, `MCP "${slug}" not found`);
      }

      // 2. OAuth access token, or the RFC 9728 challenge when missing.
      const challengeScopes = mcpScopes(slug);
      const metadataUrl = `${origin}/.well-known/oauth-protected-resource${resourcePath}/${slug}`;
      const protectedHandler = requireMcpAuth(
        deps.auth,
        async (req, claims) => {
          const identity = identityFromAccessToken(claims);
          if (!identity)
            return Response.json({ error: "Invalid token subject" }, { status: 401 });
          const resolved = await resolve(slug, identity);
          if (resolved.status !== 200) {
            return Response.json(
              { error: resolved.error },
              {
                status: resolved.status,
                // A withdrawn grant is a dead token: send the client back
                // through authorization, where the user decides again.
                ...(resolved.status === 401
                  ? {
                      headers: {
                        "WWW-Authenticate": [
                          `Bearer error="invalid_token"`,
                          `error_description="${resolved.error}"`,
                          `resource_metadata="${metadataUrl}"`,
                          `scope="${challengeScopes.join(" ")}"`,
                        ].join(", "),
                      },
                    }
                  : {}),
              },
            );
          }
          return resolved.handler.fetch(req, {
            authInfo: toAuthInfo(identity, resolved.registered.record, resolved.access),
            ...parsedBody,
          });
        },
        // Each MCP is its own OAuth resource: the token must have been issued
        // for this one, and the challenge names its two scopes only.
        { resource: mcpResourceIdentifier(deps.baseUrl, slug), challengeScopes },
      );
      const response = await protectedHandler(webRequest);
      return sendWebResponse(reply, response);
    },
  });
}
