import {
  type Access,
  ACCESS_LEVELS,
  grantsFromScopes,
  minAccess,
  scopesFromGrants,
} from "@rack/mcp-kit";
import type { Db } from "@rack/database";
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import type { Auth } from "../auth/auth.js";
import { sessionUser } from "../auth/identity.js";
import { jsonError, toWebRequest } from "../http.js";
import type { McpRegistry } from "../mcp/registry.js";

export interface KeyRoutesDeps {
  auth: Auth;
  db: Db;
  registry: McpRegistry;
}

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  /** Access per MCP slug. Empty = every MCP the user is assigned, at that level. */
  mcps: z.record(z.string(), z.enum(ACCESS_LEVELS)).default({}),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * Self-service API keys. Permissions are a server-only property in Better
 * Auth, so creation goes through here rather than the client endpoint.
 */
export async function registerKeyRoutes(app: FastifyInstance, deps: KeyRoutesDeps) {
  app.get("/api/keys", async (request, reply) => {
    const user = await sessionUser(deps.auth, toWebRequest(request).headers);
    if (!user) return jsonError(reply, 401, "Sign in required");
    const keys = await deps.db.apikey.findMany({
      where: { referenceId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return keys.map(presentKey);
  });

  app.post("/api/keys", async (request, reply) => {
    const user = await sessionUser(deps.auth, toWebRequest(request).headers);
    if (!user) return jsonError(reply, 401, "Sign in required");
    const parsed = createKeySchema.safeParse(request.body);
    if (!parsed.success)
      return jsonError(reply, 400, parsed.error.issues.map((i) => i.message).join("; "));

    const assigned = await deps.registry.userAccesses(user.id, user.isAdmin);
    const selection: Record<string, Access> = {};
    for (const [slug, access] of Object.entries(parsed.data.mcps)) {
      const allowed = minAccess(assigned[slug] ?? null, access);
      if (!allowed) return jsonError(reply, 403, `You have no access to MCP "${slug}"`);
      if (allowed !== access)
        return jsonError(reply, 403, `You only have read access to MCP "${slug}"`);
      selection[slug] = access;
    }

    const scopes = scopesFromGrants({
      mcps: Object.keys(selection).length > 0 ? selection : "*",
      caps: "*",
    });
    const permissions = Object.fromEntries(scopes.map((scope) => [scope, ["use"]]));

    const created = await deps.auth.api.createApiKey({
      body: {
        userId: user.id,
        name: parsed.data.name,
        permissions,
        ...(parsed.data.expiresInDays
          ? { expiresIn: parsed.data.expiresInDays * 86_400 }
          : {}),
      },
    });
    return reply.status(201).send({ ...presentKey(created), key: created.key });
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (request, reply) => {
    const user = await sessionUser(deps.auth, toWebRequest(request).headers);
    if (!user) return jsonError(reply, 401, "Sign in required");
    const result = await deps.db.apikey.deleteMany({
      where: { id: request.params.id, referenceId: user.id },
    });
    if (result.count === 0) return jsonError(reply, 404, "Unknown key");
    return { deleted: true };
  });
}

interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean | null;
  expiresAt: Date | null;
  lastRequest: Date | null;
  requestCount: number | null;
  createdAt: Date;
  permissions: string | Record<string, string[]> | null | undefined;
}

export function presentKey(key: KeyRow) {
  const permissions =
    typeof key.permissions === "string"
      ? (JSON.parse(key.permissions) as Record<string, string[]>)
      : (key.permissions ?? {});
  return {
    id: key.id,
    name: key.name,
    start: key.start,
    enabled: key.enabled ?? true,
    expiresAt: key.expiresAt,
    lastRequest: key.lastRequest,
    requestCount: key.requestCount ?? 0,
    grants: grantsFromScopes(Object.keys(permissions)),
    createdAt: key.createdAt,
  };
}
