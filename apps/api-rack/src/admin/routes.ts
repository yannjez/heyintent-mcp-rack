import {
  type Access,
  ACCESS_LEVELS,
  CLIENT_KINDS,
  isClientKind,
  maxAccess,
  minAccess,
  USER_KINDS,
} from "@rack/mcp-kit";
import type { Db } from "@rack/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import {
  applicationAllowed,
  canAccessApplication,
  isRackApplication,
} from "../auth/applications.js";
import type { Auth } from "../auth/auth.js";
import { clearProviderGrants, mcpResourceIdentifiers } from "../auth/grants.js";
import { sessionUser } from "../auth/identity.js";
import { jsonError, toWebRequest } from "../http.js";
import { presentKey } from "../keys/routes.js";
import type { McpNotifier } from "../mcp/notifier.js";
import {
  type McpListing,
  type McpRegistry,
  RegistryError,
  toAccess,
} from "../mcp/registry.js";
import {
  parseResourceConfig,
  probeResource,
  RESOURCE_KINDS,
  type ResourceConfig,
} from "../mcp/resources.js";

export interface AdminRoutesDeps {
  auth: Auth;
  db: Db;
  registry: McpRegistry;
  baseUrl: string;
  /** Shared with the MCP routes: pushes `tools/list_changed` when rights move. */
  notifier: McpNotifier;
}

const patchMcpSchema = z.object({
  enabled: z.boolean().optional(),
  /** Resources only (sites, remote MCP): packages keep their declared metadata. */
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Application this resource is a channel of; null detaches it. */
  clientId: z.string().min(1).max(255).nullable().optional(),
});

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

const createResourceSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  slug: z
    .string()
    .trim()
    .regex(SLUG, "Slug: lowercase letters, digits and dashes (2 to 63 characters)"),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  config: z.record(z.string(), z.unknown()).default({}),
});

const probeResourceSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  /** Existing resource whose stored secret applies when none is typed. */
  slug: z.string().trim().max(63).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

const createUserSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(100),
  kind: z.enum(USER_KINDS).default("external"),
  role: z.enum(["user", "admin"]).default("user"),
});

const patchUserSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  kind: z.enum(USER_KINDS).optional(),
  role: z.enum(["user", "admin"]).optional(),
  banned: z.boolean().optional(),
  groupIds: z.array(z.string().min(1).max(100)).max(100).optional(),
});

/** An address a browser can be sent to: http(s), and no credentials in it. */
const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use an HTTP(S) URL without credentials");

const createApplicationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Where "Ouvrir l'application" sends the user. */
  uri: httpUrl.optional(),
  /** Required by OAuth: where the authorization code comes back. */
  redirectUris: z.array(httpUrl).min(1).max(10),
  accessRestricted: z.boolean().default(false),
  groupIds: z.array(z.string().min(1).max(100)).max(100).default([]),
});

const accessSchema = z.object({
  /** "none" blocks the MCP despite the user's groups; "default" removes the override. */
  access: z.enum([...ACCESS_LEVELS, "none", "default"]),
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  /** MCP slugs made available to the group. */
  mcps: z.array(z.string().min(1)).max(100).default([]),
});

const patchGroupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
});

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps) {
  /** Where MCP clients connect: the rack route, or the external app's own endpoint. */
  const mcpUrl = (mcp: { slug: string; externalUrl: string | null }) =>
    mcp.externalUrl ? `${mcp.externalUrl}/mcp` : `${deps.baseUrl}/mcp/${mcp.slug}`;

  async function currentUser(request: FastifyRequest) {
    return sessionUser(deps.auth, toWebRequest(request).headers);
  }

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    const user = await currentUser(request);
    if (!user) {
      jsonError(reply, 401, "Sign in required");
      return null;
    }
    if (!user.isAdmin) {
      jsonError(reply, 403, "Admin role required");
      return null;
    }
    return user;
  }

  function invalid(reply: FastifyReply, error: z.ZodError) {
    return jsonError(reply, 400, error.issues.map((i) => i.message).join("; "));
  }

  /**
   * The address a browser may be sent to, or null. A client may register any
   * `client_uri`, so only plain http(s) without embedded credentials is
   * handed to the UI; native agents usually have none at all.
   */
  function publicUrl(uri: string | null): string | null {
    try {
      const parsed = new URL(uri ?? "");
      if (!["https:", "http:"].includes(parsed.protocol)) return null;
      if (parsed.username || parsed.password) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  /**
   * MCPs these groups make available: changing a group, or who belongs to it,
   * changes the tool list its members are served.
   */
  async function slugsOfGroups(groupIds: string[]): Promise<string[]> {
    if (groupIds.length === 0) return [];
    const rows = await deps.db.mcpGroupMcp.findMany({
      where: { groupId: { in: [...new Set(groupIds)] } },
      include: { mcp: { select: { slug: true } } },
    });
    return rows.map((row) => row.mcp.slug);
  }

  app.get("/api/me", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return jsonError(reply, 401, "Sign in required");
    return user;
  });

  /** Display name of an OAuth client (DCR `client_name` or CIMD metadata), for the consent pages. */
  app.get<{ Params: { clientId: string } }>(
    "/api/oauth-clients/:clientId",
    async (request, reply) => {
      const user = await currentUser(request);
      if (!user) return jsonError(reply, 401, "Sign in required");
      const client = await deps.db.oauthClient.findUnique({
        where: { clientId: request.params.clientId },
        select: { clientId: true, name: true, uri: true },
      });
      if (!client) return jsonError(reply, 404, "Unknown client");
      return {
        clientId: client.clientId,
        name: client.name,
        uri: client.uri,
        allowed: await canAccessApplication(deps.db, client.clientId, user.id),
      };
    },
  );

  /** MCPs the signed-in user may connect to, with their access level and tools. */
  app.get("/api/mcps", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return jsonError(reply, 401, "Sign in required");
    const [mcps, accesses] = await Promise.all([
      deps.registry.list(),
      deps.registry.userAccesses(user.id, user.isAdmin),
    ]);
    return mcps
      .filter((mcp) => mcp.enabled && mcp.loaded && accesses[mcp.slug])
      .map((mcp) => presentUserMcp(mcp, accesses[mcp.slug]!));
  });

  /** One MCP as the personal space shows it, with this user's access level. */
  function presentUserMcp(mcp: McpListing, access: Access) {
    return {
      slug: mcp.slug,
      name: mcp.name,
      description: mcp.description,
      category: mcp.category,
      version: mcp.version,
      kind: mcp.kind,
      access,
      tools: mcp.tools,
      url: mcpUrl(mcp),
      appUrl: mcp.externalUrl,
      clientId: mcp.clientId,
    };
  }

  /** Applications available to the signed-in user; never expose OAuth credentials. */
  app.get("/api/applications", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return jsonError(reply, 401, "Sign in required");
    if (user.banned) return [];
    const clients = await deps.db.oauthClient.findMany({
      where: { kind: "application" },
      orderBy: [{ name: "asc" }, { clientId: "asc" }],
      select: {
        clientId: true,
        name: true,
        uri: true,
        disabled: true,
        accessRestricted: true,
        applicationGroups: {
          where: { group: { users: { some: { userId: user.id } } } },
          select: { groupId: true },
        },
      },
    });
    // A product is one application plus the MCP channels attached to it. The
    // two carry their own access rules, so a user may see the back-office and
    // not the MCP, or the reverse — each side is filtered on its own.
    const [mcps, accesses] = await Promise.all([
      deps.registry.list(),
      deps.registry.userAccesses(user.id, user.isAdmin),
    ]);
    const reachable = mcps.filter(
      (mcp) => mcp.enabled && mcp.loaded && accesses[mcp.slug],
    );
    return clients
      .filter(
        (client) =>
          !isRackApplication(client, deps.baseUrl) && applicationAllowed(client),
      )
      .map(({ clientId, name, uri }) => ({
        clientId,
        name,
        url: publicUrl(uri),
        resources: reachable
          .filter((mcp) => mcp.clientId === clientId)
          .map((mcp) => presentUserMcp(mcp, accesses[mcp.slug]!)),
      }));
  });

  /**
   * The agents this account connected to the rack (Codex, Claude Code…).
   *
   * Unlike applications, a consumer is listed only for the users who actually
   * signed in through it: an agent registers itself, unrestricted, so the
   * group policy would otherwise show everyone's agents to everyone. The
   * consent row is the link, and it is also what the user would revoke.
   */
  app.get("/api/consumers", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return jsonError(reply, 401, "Sign in required");
    if (user.banned) return [];
    const [consents, grants, accesses, enabled] = await Promise.all([
      deps.db.oauthConsent.findMany({
        where: { userId: user.id, oauthclient: { kind: "consumer" } },
        select: { clientId: true, updatedAt: true },
      }),
      deps.db.mcpGrant.findMany({
        where: { userId: user.id, client: { kind: "consumer" } },
        orderBy: { mcp: { name: "asc" } },
        select: {
          clientId: true,
          access: true,
          consentedAccess: true,
          updatedAt: true,
          mcp: { select: { slug: true, name: true, kind: true, enabled: true } },
        },
      }),
      deps.registry.userAccesses(user.id),
      deps.db.mcp.findMany({ where: { enabled: true }, select: { slug: true } }),
    ]);
    const usable = new Set(enabled.map((mcp) => mcp.slug));
    const clients = await deps.db.oauthClient.findMany({
      where: {
        clientId: { in: [...consents, ...grants].map((row) => row.clientId) },
      },
      select: {
        clientId: true,
        name: true,
        uri: true,
        disabled: true,
        accessRestricted: true,
        applicationGroups: {
          where: { group: { users: { some: { userId: user.id } } } },
          select: { groupId: true },
        },
      },
    });

    // An agent that registers itself gets one client per MCP it connects to:
    // the same name is the same agent, shown once with everything it holds.
    interface Consumer {
      name: string | null;
      url: string | null;
      clientIds: string[];
      connectedAt: Date;
      grants: Map<
        string,
        {
          slug: string;
          name: string;
          kind: string;
          access: Access | null;
          consented: Access | null;
          clientIds: string[];
        }
      >;
    }
    const consumers = new Map<string, Consumer>();
    const byClient = new Map<string, Consumer>();
    for (const client of clients) {
      if (isRackApplication(client, deps.baseUrl) || !applicationAllowed(client))
        continue;
      const key = client.name?.trim().toLowerCase() || client.clientId;
      const consumer: Consumer = consumers.get(key) ?? {
        name: client.name,
        url: publicUrl(client.uri),
        clientIds: [],
        connectedAt: new Date(0),
        grants: new Map(),
      };
      consumer.url ??= publicUrl(client.uri);
      consumer.clientIds.push(client.clientId);
      consumers.set(key, consumer);
      byClient.set(client.clientId, consumer);
    }
    for (const row of [...consents, ...grants]) {
      const consumer = byClient.get(row.clientId);
      if (consumer && row.updatedAt > consumer.connectedAt) {
        consumer.connectedAt = row.updatedAt;
      }
    }
    for (const grant of grants) {
      const consumer = byClient.get(grant.clientId);
      if (!consumer) continue;
      const entry = consumer.grants.get(grant.mcp.slug) ?? {
        slug: grant.mcp.slug,
        name: grant.mcp.name,
        kind: grant.mcp.kind,
        access: null,
        consented: null,
        clientIds: [],
      };
      entry.access = maxAccess(entry.access, toAccess(grant.access));
      entry.consented = maxAccess(entry.consented, toAccess(grant.consentedAccess));
      entry.clientIds.push(grant.clientId);
      consumer.grants.set(grant.mcp.slug, entry);
    }
    return [...consumers.values()]
      .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime())
      .map((consumer) => ({
        name: consumer.name,
        url: consumer.url,
        clientIds: consumer.clientIds,
        connectedAt: consumer.connectedAt,
        grants: [...consumer.grants.values()].map((grant) => {
          // What the account itself may do today caps everything it granted.
          const own = usable.has(grant.slug) ? (accesses[grant.slug] ?? null) : null;
          return {
            slug: grant.slug,
            name: grant.name,
            kind: grant.kind,
            clientIds: grant.clientIds,
            /** Level in force; null when the account lost the MCP itself. */
            access: minAccess(grant.access, own),
            /** Highest level it can be set to without a new authorization. */
            max: minAccess(grant.consented, own),
          };
        }),
      }));
  });

  const consumerClientsSchema = z.array(z.string().min(1).max(2000)).min(1).max(100);

  /**
   * Change what a consumer may do on one MCP: lower or restore the level
   * within what was consented, or "none" to withdraw the MCP. Effective on the
   * consumer's very next call to the rack; an app hosted elsewhere reads the
   * level from its token, so it follows at the next issuance (15 minutes at
   * most). A withdrawal also drops the refresh tokens, so coming back means
   * going through the consent screen again.
   */
  app.put("/api/consumers/grants", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return jsonError(reply, 401, "Sign in required");
    const parsed = z
      .strictObject({
        clientIds: consumerClientsSchema,
        slug: z.string().min(1).max(63),
        access: z.enum([...ACCESS_LEVELS, "none"]),
      })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { clientIds, slug, access } = parsed.data;
    const mcp = await deps.db.mcp.findUnique({ where: { slug }, select: { id: true } });
    if (!mcp) return jsonError(reply, 404, "Unknown MCP");
    const owned = { userId: user.id, mcpId: mcp.id, clientId: { in: clientIds } };
    if (access === "none") {
      const definition = deps.registry.definition(slug);
      const [removed] = await deps.db.$transaction([
        deps.db.mcpGrant.deleteMany({ where: owned }),
        ...clearProviderGrants(deps.db, {
          userId: user.id,
          clientIds,
          // Without a definition the resource is unknown: drop every token.
          ...(definition
            ? { resources: mcpResourceIdentifiers(deps.baseUrl, definition) }
            : {}),
        }),
      ]);
      deps.notifier.toolsChanged([slug]);
      return { slug, access, updated: removed.count };
    }
    const rows = await deps.db.mcpGrant.findMany({
      where: owned,
      select: { id: true, consentedAccess: true },
    });
    if (rows.length === 0) return jsonError(reply, 404, "No such authorization");
    await deps.db.$transaction(
      rows.map((row) =>
        deps.db.mcpGrant.update({
          where: { id: row.id },
          // Never above what the consent screen was accepted for.
          data: { access: minAccess(access, toAccess(row.consentedAccess)) ?? "read" },
        }),
      ),
    );
    deps.notifier.toolsChanged([slug]);
    return { slug, access, updated: rows.length };
  });

  /** Withdraw everything this account granted these consumers. */
  app.post("/api/consumers/disconnect", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return jsonError(reply, 401, "Sign in required");
    const parsed = z
      .strictObject({ clientIds: consumerClientsSchema })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { clientIds } = parsed.data;
    const owned = { userId: user.id, clientId: { in: clientIds } };
    const grants = await deps.db.mcpGrant.findMany({
      where: owned,
      select: { mcp: { select: { slug: true } } },
    });
    await deps.db.$transaction([
      deps.db.mcpGrant.deleteMany({ where: owned }),
      ...clearProviderGrants(deps.db, { userId: user.id, clientIds }),
    ]);
    deps.notifier.toolsChanged(grants.map((grant) => grant.mcp.slug));
    return { disconnected: true };
  });

  // ---------------------------------------------------------------- Applications

  app.get("/api/admin/applications", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const clients = await deps.db.oauthClient.findMany({
      orderBy: { name: "asc" },
      select: {
        clientId: true,
        name: true,
        uri: true,
        kind: true,
        disabled: true,
        accessRestricted: true,
        redirectUris: true,
        scopes: true,
        userId: true,
        applicationGroups: { select: { groupId: true } },
        oauthconsents: {
          distinct: ["userId"],
          select: { user: { select: { id: true, email: true } } },
        },
      },
    });
    return (
      clients
        .filter((client) => !isRackApplication(client, deps.baseUrl))
        // `userId` is Better Auth's registrant: dropped, the consents below say
        // who actually uses the client.
        .map(({ applicationGroups, oauthconsents, userId: _userId, ...client }) => ({
          ...client,
          kind: isClientKind(client.kind) ? client.kind : "consumer",
          disabled: client.disabled ?? false,
          groupIds: applicationGroups.map((g) => g.groupId),
          /** Who signed in through it — the only meaningful owner of an agent. */
          users: oauthconsents.flatMap((consent) =>
            consent.user ? [{ id: consent.user.id, email: consent.user.email }] : [],
          ),
        }))
    );
  });

  /**
   * Declare an application: a product someone opens, which signs its users in
   * through the rack. Registration goes through Better Auth's own dynamic
   * registration endpoint so the credentials are built exactly as they are
   * for a client that registers itself — only the kind and the access policy
   * are ours. The secret is returned once and never stored in clear.
   */
  app.post("/api/admin/applications", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = createApplicationSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { name, uri, redirectUris, accessRestricted, groupIds } = parsed.data;
    if (uri && isRackApplication({ clientId: "", uri }, deps.baseUrl))
      return jsonError(reply, 400, "Rack cannot be used as an application URL");
    if (groupIds.length > 0) {
      const count = await deps.db.mcpGroup.count({ where: { id: { in: groupIds } } });
      if (count !== new Set(groupIds).size) return jsonError(reply, 404, "Unknown group");
    }
    const registration = await deps.auth.handler(
      new Request(new URL("/api/auth/oauth2/register", deps.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: name,
          ...(uri ? { client_uri: uri } : {}),
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      }),
    );
    const registered = (await registration.json()) as {
      client_id?: string;
      client_secret?: string;
      error_description?: string;
      error?: string;
    };
    if (!registration.ok || !registered.client_id) {
      return jsonError(
        reply,
        502,
        registered.error_description ?? registered.error ?? "Registration refused",
      );
    }
    const clientId = registered.client_id;
    await deps.db.oauthClient.update({
      where: { clientId },
      data: {
        kind: "application",
        accessRestricted,
        ...(groupIds.length > 0
          ? {
              applicationGroups: {
                create: [...new Set(groupIds)].map((groupId) => ({ groupId })),
              },
            }
          : {}),
      },
    });
    // The only time the secret leaves the rack: it is hashed at rest.
    return reply.status(201).send({
      clientId,
      clientSecret: registered.client_secret ?? null,
      name,
      uri: uri ?? null,
      redirectUris,
      kind: "application" as const,
      accessRestricted,
      groupIds,
    });
  });

  app.patch<{ Params: { clientId: string } }>(
    "/api/admin/applications/:clientId",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = z
        .strictObject({
          name: z.string().trim().min(1).max(200).optional(),
          uri: z
            .string()
            .url()
            .max(2000)
            .refine((value) => {
              try {
                const url = new URL(value);
                return (
                  ["https:", "http:"].includes(url.protocol) &&
                  !url.username &&
                  !url.password
                );
              } catch {
                return false;
              }
            }, "Use an HTTP(S) application URL without credentials")
            .nullable()
            .optional(),
          /** Promote an agent that registered itself, or demote a declared app. */
          kind: z.enum(CLIENT_KINDS).optional(),
          disabled: z.boolean().optional(),
          accessRestricted: z.boolean().optional(),
          groupIds: z.array(z.string().min(1)).max(100).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const { clientId } = request.params;
      const client = await deps.db.oauthClient.findUnique({
        where: { clientId },
        include: { applicationGroups: { select: { groupId: true } } },
      });
      if (!client || isRackApplication(client, deps.baseUrl))
        return jsonError(reply, 404, "Unknown application");
      const { name, uri, kind, disabled, accessRestricted, groupIds } = parsed.data;
      // Renaming or refiling a client is bookkeeping: only a real change of
      // who may use it invalidates what was granted. Wiping the consents on
      // every save would also erase the link « Mes consommateurs » relies on.
      const currentGroups = new Set(client.applicationGroups.map((g) => g.groupId));
      const policyChanged =
        (disabled !== undefined && disabled !== (client.disabled ?? false)) ||
        (accessRestricted !== undefined &&
          accessRestricted !== client.accessRestricted) ||
        (groupIds !== undefined &&
          (new Set(groupIds).size !== currentGroups.size ||
            groupIds.some((id) => !currentGroups.has(id))));
      if (uri && isRackApplication({ clientId, uri }, deps.baseUrl))
        return jsonError(reply, 400, "Rack cannot be used as an application URL");
      if (groupIds) {
        const count = await deps.db.mcpGroup.count({ where: { id: { in: groupIds } } });
        if (count !== new Set(groupIds).size)
          return jsonError(reply, 404, "Unknown group");
      }
      await deps.db.$transaction([
        deps.db.oauthClient.update({
          where: { clientId },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(uri !== undefined ? { uri } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(disabled !== undefined ? { disabled } : {}),
            ...(accessRestricted !== undefined ? { accessRestricted } : {}),
            ...(groupIds
              ? {
                  applicationGroups: {
                    deleteMany: {},
                    create: [...new Set(groupIds)].map((groupId) => ({ groupId })),
                  },
                }
              : {}),
          },
        }),
        // Clear saved grants and refresh credentials when the policy changes.
        ...(policyChanged
          ? [
              deps.db.oauthAccessToken.deleteMany({ where: { clientId } }),
              deps.db.oauthRefreshToken.deleteMany({ where: { clientId } }),
              deps.db.oauthConsent.deleteMany({ where: { clientId } }),
              deps.db.mcpGrant.deleteMany({ where: { clientId } }),
            ]
          : []),
      ]);
      return { clientId, updated: true };
    },
  );

  function clearApplicationGrants(clientId: string) {
    return [
      deps.db.oauthAccessToken.deleteMany({ where: { clientId } }),
      deps.db.oauthRefreshToken.deleteMany({ where: { clientId } }),
      deps.db.oauthConsent.deleteMany({ where: { clientId } }),
      deps.db.mcpGrant.deleteMany({ where: { clientId } }),
    ];
  }

  app.put<{ Params: { id: string; clientId: string } }>(
    "/api/admin/applications/:clientId/groups/:id",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const { id: groupId, clientId } = request.params;
      const [group, client] = await Promise.all([
        deps.db.mcpGroup.findUnique({ where: { id: groupId }, select: { id: true } }),
        deps.db.oauthClient.findUnique({
          where: { clientId },
          select: { id: true, clientId: true, uri: true },
        }),
      ]);
      if (!group || !client || isRackApplication(client, deps.baseUrl))
        return jsonError(reply, 404, "Unknown group or application");
      await deps.db.$transaction([
        parsed.data.enabled
          ? deps.db.applicationGroup.upsert({
              where: { clientId_groupId: { clientId, groupId } },
              create: { clientId, groupId },
              update: {},
            })
          : deps.db.applicationGroup.deleteMany({ where: { clientId, groupId } }),
        ...clearApplicationGrants(clientId),
      ]);
      return { clientId, groupId, enabled: parsed.data.enabled };
    },
  );

  // ---------------------------------------------------------------- MCPs

  app.get("/api/admin/mcps", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const [mcps, links, applications] = await Promise.all([
      deps.registry.list(),
      deps.db.mcpGroupMcp.findMany({
        include: { group: { include: { users: { select: { userId: true } } } } },
      }),
      deps.db.oauthClient.findMany({
        where: { kind: "application" },
        select: { clientId: true, name: true },
      }),
    ]);
    const nameOf = new Map(applications.map((app) => [app.clientId, app.name]));
    return mcps.map((mcp) => {
      const groups = links.filter((link) => link.mcpId === mcp.id);
      return {
        ...mcp,
        url: mcpUrl(mcp),
        applicationName: mcp.clientId ? (nameOf.get(mcp.clientId) ?? null) : null,
        userCount: new Set(
          groups.flatMap((link) => link.group.users.map((u) => u.userId)),
        ).size,
        groupCount: groups.length,
        groups: groups.map((link) => ({ id: link.groupId, name: link.group.name })),
      };
    });
  });

  /** One listing entry, as GET /api/admin/mcps returns it. */
  async function presentMcp(slug: string) {
    const [mcps, links] = await Promise.all([
      deps.registry.list(),
      deps.db.mcpGroupMcp.findMany({
        where: { mcp: { slug } },
        include: { group: { include: { users: { select: { userId: true } } } } },
      }),
    ]);
    const mcp = mcps.find((m) => m.slug === slug);
    if (!mcp) return null;
    const application = mcp.clientId
      ? await deps.db.oauthClient.findUnique({
          where: { clientId: mcp.clientId },
          select: { name: true },
        })
      : null;
    return {
      ...mcp,
      url: mcpUrl(mcp),
      applicationName: application?.name ?? null,
      userCount: new Set(links.flatMap((link) => link.group.users.map((u) => u.userId)))
        .size,
      groupCount: links.length,
      groups: links.map((link) => ({ id: link.groupId, name: link.group.name })),
    };
  }

  /** Secrets typed as "" mean "keep the stored one" when probing an existing resource. */
  async function withStoredSecret(
    resource: ResourceConfig,
    slug: string | undefined,
  ): Promise<ResourceConfig> {
    if (!slug) return resource;
    const stored = await deps.registry.resourceConfig(slug);
    if (!stored || stored.kind !== resource.kind) return resource;
    if (resource.kind === "site" && stored.kind === "site" && !resource.config.apiToken) {
      return {
        kind: "site",
        config: { ...resource.config, apiToken: stored.config.apiToken },
      };
    }
    if (resource.kind !== "site" && stored.kind !== "site" && !resource.config.token) {
      return {
        kind: resource.kind,
        config: { ...resource.config, token: stored.config.token },
      };
    }
    return resource;
  }

  function registryFailure(reply: FastifyReply, error: unknown) {
    if (error instanceof RegistryError)
      return jsonError(reply, error.status, error.message);
    throw error;
  }

  app.patch<{ Params: { slug: string } }>(
    "/api/admin/mcps/:slug",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = patchMcpSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const slug = request.params.slug;
      const record = await deps.db.mcp.findUnique({ where: { slug } });
      if (!record) return jsonError(reply, 404, "Unknown MCP");

      const { enabled, name, description, config, clientId } = parsed.data;
      const kind = deps.registry.kind(slug) ?? "package";
      const editsResource = name !== undefined || description !== undefined || !!config;
      if (kind === "package" && editsResource) {
        return jsonError(reply, 400, "Packages shipped with the rack cannot be edited");
      }
      // Only a declared application can own a channel: attaching a resource to
      // an agent that registered itself would make no sense as a product.
      if (clientId) {
        const owner = await deps.db.oauthClient.findUnique({
          where: { clientId },
          select: { kind: true },
        });
        if (!owner) return jsonError(reply, 404, "Unknown application");
        if (owner.kind !== "application")
          return jsonError(reply, 400, "Only an application can own a resource");
      }
      // Validate the whole patch before touching anything: a rejected request
      // must leave the resource exactly as it was, `enabled` included.
      let resource: ResourceConfig | undefined;
      if (config && kind !== "package") {
        const parsedConfig = parseResourceConfig(kind, config);
        if (!parsedConfig.ok) return jsonError(reply, 400, parsedConfig.error);
        resource = parsedConfig.value;
      }
      if (enabled !== undefined && enabled !== record.enabled) {
        await deps.db.mcp.update({ where: { slug }, data: { enabled } });
        // A disabled MCP answers 404; connected clients should stop offering
        // its tools without waiting for the next call to fail.
        deps.notifier.toolsChanged([slug]);
      }
      // Attaching is pure bookkeeping: the resource keeps its own access rules.
      if (clientId !== undefined && clientId !== record.clientId) {
        await deps.db.mcp.update({ where: { slug }, data: { clientId } });
      }
      if (kind !== "package" && editsResource) {
        try {
          await deps.registry.updateResource(slug, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(resource ? { resource } : {}),
          });
        } catch (error) {
          return registryFailure(reply, error);
        }
      }
      return presentMcp(slug);
    },
  );

  /**
   * Re-discover the tools of a site or remote resource, without a restart.
   * The upstream server is queried again, the admin catalog is refreshed and
   * `tools/list_changed` goes out to the clients listening on this MCP.
   *
   * Packages are not reloadable: their definition is the module imported at
   * boot, and re-importing it would leave the rest of the package's files on
   * the old code. In development `tsx watch` restarts the rack when
   * `mcps/<slug>/dist` changes, which is the supported way to pick them up.
   */
  app.post<{ Params: { slug: string } }>(
    "/api/admin/mcps/:slug/reload",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const slug = request.params.slug;
      const record = await deps.db.mcp.findUnique({ where: { slug } });
      if (!record) return jsonError(reply, 404, "Unknown MCP");
      if ((deps.registry.kind(slug) ?? "package") === "package") {
        return jsonError(
          reply,
          400,
          "Les packages livrés avec le rack sont rechargés au redémarrage",
        );
      }
      try {
        await deps.registry.reload(slug);
      } catch (error) {
        return registryFailure(reply, error);
      }
      return presentMcp(slug);
    },
  );

  /** Remove a site or remote MCP added by an admin (packages stay). */
  app.delete<{ Params: { slug: string } }>(
    "/api/admin/mcps/:slug",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      try {
        await deps.registry.removeResource(request.params.slug);
      } catch (error) {
        return registryFailure(reply, error);
      }
      return { deleted: true };
    },
  );

  // ----------------------------------------------------------- Resources

  /** Add a public site or a remote/partner MCP server, served at /mcp/<slug> right away. */
  app.post("/api/admin/resources", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = createResourceSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { kind, slug, name, description, config } = parsed.data;
    const parsedConfig = parseResourceConfig(kind, config);
    if (!parsedConfig.ok) return jsonError(reply, 400, parsedConfig.error);
    try {
      await deps.registry.addResource({
        slug,
        name,
        description,
        resource: parsedConfig.value,
      });
    } catch (error) {
      return registryFailure(reply, error);
    }
    return reply.status(201).send(await presentMcp(slug));
  });

  /** Try the connection parameters before saving them (or after, with the stored secret). */
  app.post("/api/admin/resources/probe", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = probeResourceSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const parsedConfig = parseResourceConfig(parsed.data.kind, parsed.data.config);
    if (!parsedConfig.ok) return jsonError(reply, 400, parsedConfig.error);
    const resource = await withStoredSecret(parsedConfig.value, parsed.data.slug);
    return probeResource(resource);
  });

  // ---------------------------------------------------------------- Users

  async function presentUsers(userId?: string) {
    const [users, accesses, keys, groups] = await Promise.all([
      deps.db.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 500,
        ...(userId ? { where: { id: userId } } : {}),
        include: { groups: true },
      }),
      deps.db.mcpAccess.findMany({ include: { mcp: { select: { slug: true } } } }),
      deps.db.apikey.groupBy({ by: ["referenceId"], _count: { _all: true } }),
      deps.db.mcpGroup.findMany({
        include: { mcps: { include: { mcp: { select: { slug: true } } } } },
      }),
    ]);
    const accessByUser = new Map<string, Record<string, string>>();
    for (const row of accesses) {
      const map = accessByUser.get(row.userId) ?? {};
      map[row.mcp.slug] = row.access;
      accessByUser.set(row.userId, map);
    }
    const keysByUser = new Map(keys.map((k) => [k.referenceId, k._count._all]));
    const groupById = new Map(
      groups.map((group) => [
        group.id,
        {
          id: group.id,
          name: group.name,
          mcps: group.mcps.map((row) => row.mcp.slug),
        },
      ]),
    );
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      kind: user.kind,
      role: user.role,
      isAdmin: user.role.split(",").includes("admin"),
      banned: user.banned ?? false,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      /** Individual read/write rights; group membership is required. */
      mcps: accessByUser.get(user.id) ?? {},
      groups: user.groups.flatMap((membership) => {
        const group = groupById.get(membership.groupId);
        return group ? [group] : [];
      }),
      keyCount: keysByUser.get(user.id) ?? 0,
    }));
  }

  app.get("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return presentUsers();
  });

  app.get<{ Params: { id: string } }>("/api/admin/users/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const [user] = await presentUsers(request.params.id);
    if (!user) return jsonError(reply, 404, "Unknown user");
    return user;
  });

  /** Pre-create an account (external or client users are not on the email allowlist). */
  app.post("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const email = parsed.data.email.trim().toLowerCase();
    const existing = await deps.db.user.findUnique({ where: { email } });
    if (existing) return jsonError(reply, 409, "A user with this email already exists");
    const user = await deps.db.user.create({
      data: {
        id: randomUUID(),
        email,
        name: parsed.data.name,
        kind: parsed.data.kind,
        role: parsed.data.role,
      },
    });
    return reply.status(201).send({ id: user.id, email: user.email });
  });

  app.patch<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const parsed = patchUserSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const { name, kind, role, banned, groupIds } = parsed.data;
      if (request.params.id === admin.id && (role === "user" || banned)) {
        return jsonError(reply, 400, "You cannot demote or ban yourself");
      }
      const existing = await deps.db.user.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) return jsonError(reply, 404, "Unknown user");
      if (groupIds !== undefined) {
        const groups = await deps.db.mcpGroup.findMany({
          where: { id: { in: groupIds } },
        });
        if (groups.length !== new Set(groupIds).size)
          return jsonError(reply, 404, "Unknown group");
      }
      // Groups left behind matter as much as groups joined, and a ban revokes
      // everything: read the current membership before it is replaced.
      const touched =
        groupIds !== undefined || banned !== undefined
          ? await deps.db.mcpGroupUser.findMany({
              where: { userId: existing.id },
              select: { groupId: true },
            })
          : [];
      const updated = await deps.db.user.update({
        where: { id: request.params.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(groupIds !== undefined
            ? {
                groups: {
                  deleteMany: {},
                  create: [...new Set(groupIds)].map((groupId) => ({ groupId })),
                },
              }
            : {}),
          ...(banned !== undefined
            ? { banned, banReason: banned ? "Désactivé par un administrateur" : null }
            : {}),
        },
      });
      if (banned) {
        await deps.db.session.deleteMany({ where: { userId: updated.id } });
      }
      if (touched.length > 0 || groupIds?.length) {
        deps.notifier.toolsChanged(
          await slugsOfGroups([
            ...touched.map((row) => row.groupId),
            ...(groupIds ?? []),
          ]),
        );
      }
      return {
        id: updated.id,
        kind: updated.kind,
        role: updated.role,
        banned: updated.banned,
        groupIds,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      if (request.params.id === admin.id)
        return jsonError(reply, 400, "You cannot delete yourself");
      const existing = await deps.db.user.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) return jsonError(reply, 404, "Unknown user");
      await deps.db.$transaction([
        deps.db.apikey.deleteMany({ where: { referenceId: existing.id } }),
        deps.db.mcpAccess.deleteMany({ where: { userId: existing.id } }),
        deps.db.user.delete({ where: { id: existing.id } }),
      ]);
      return { deleted: true };
    },
  );

  /**
   * Set a user's individual right on an MCP: "read" or "write", "none" to
   * block it even though a group makes it available, "default" to fall back
   * to the group rule (read).
   */
  app.put<{ Params: { id: string; slug: string } }>(
    "/api/admin/users/:id/mcps/:slug",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const parsed = accessSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const [user, registered] = await Promise.all([
        deps.db.user.findUnique({ where: { id: request.params.id } }),
        deps.registry.get(request.params.slug),
      ]);
      if (!user) return jsonError(reply, 404, "Unknown user");
      if (!registered) return jsonError(reply, 404, "Unknown MCP");
      const where = { mcpId_userId: { mcpId: registered.record.id, userId: user.id } };
      if (parsed.data.access === "default") {
        await deps.db.mcpAccess.deleteMany({
          where: { mcpId: registered.record.id, userId: user.id },
        });
        deps.notifier.toolsChanged([registered.record.slug]);
        return { slug: registered.record.slug, access: null };
      }
      const row = await deps.db.mcpAccess.upsert({
        where,
        create: {
          mcpId: registered.record.id,
          userId: user.id,
          access: parsed.data.access,
          grantedBy: admin.id,
        },
        update: { access: parsed.data.access, grantedBy: admin.id },
      });
      // Read ⇄ write changes which tools the user is served: tell the clients
      // listening on this MCP to list again.
      deps.notifier.toolsChanged([registered.record.slug]);
      return { slug: registered.record.slug, access: row.access };
    },
  );

  // ---------------------------------------------------------------- Groups

  async function presentGroup(group: {
    id: string;
    name: string;
    description: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const [rows, members] = await Promise.all([
      deps.db.mcpGroupMcp.findMany({
        where: { groupId: group.id },
        include: { mcp: { select: { slug: true } } },
      }),
      deps.db.user.findMany({
        where: { groups: { some: { groupId: group.id } } },
        orderBy: { email: "asc" },
        select: { id: true, email: true, name: true, kind: true, role: true },
      }),
    ]);
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      mcps: rows.map((row) => row.mcp.slug),
      members: members.map((user) => ({
        ...user,
        isAdmin: user.role.split(",").includes("admin"),
      })),
      userCount: members.length,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  /** Every group with its MCP accesses and members. */
  app.get("/api/admin/groups", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const groups = await deps.db.mcpGroup.findMany({ orderBy: { name: "asc" } });
    return Promise.all(groups.map(presentGroup));
  });

  app.get<{ Params: { id: string } }>("/api/admin/groups/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const group = await deps.db.mcpGroup.findUnique({ where: { id: request.params.id } });
    if (!group) return jsonError(reply, 404, "Unknown group");
    return presentGroup(group);
  });

  app.post("/api/admin/groups", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { name, description, mcps } = parsed.data;
    const existing = await deps.db.mcpGroup.findUnique({ where: { name } });
    if (existing) return jsonError(reply, 409, "A group with this name already exists");
    const rows: { mcpId: string }[] = [];
    for (const slug of new Set(mcps)) {
      const registered = await deps.registry.get(slug);
      if (!registered) return jsonError(reply, 404, `Unknown MCP "${slug}"`);
      rows.push({ mcpId: registered.record.id });
    }
    const group = await deps.db.mcpGroup.create({
      data: { name, description, mcps: { create: rows } },
    });
    deps.notifier.toolsChanged(mcps);
    return reply.status(201).send(await presentGroup(group));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/admin/groups/:id",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = patchGroupSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const { name, description } = parsed.data;
      const existing = await deps.db.mcpGroup.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) return jsonError(reply, 404, "Unknown group");
      if (name && name !== existing.name) {
        const clash = await deps.db.mcpGroup.findUnique({ where: { name } });
        if (clash) return jsonError(reply, 409, "A group with this name already exists");
      }
      const updated = await deps.db.mcpGroup.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      });
      return presentGroup(updated);
    },
  );

  /** Delete a group and revoke the availability it grants to its members. */
  app.delete<{ Params: { id: string } }>(
    "/api/admin/groups/:id",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      // Read the MCPs the group made available before the cascade removes them.
      const slugs = await slugsOfGroups([request.params.id]);
      const result = await deps.db.mcpGroup.deleteMany({
        where: { id: request.params.id },
      });
      if (result.count === 0) return jsonError(reply, 404, "Unknown group");
      deps.notifier.toolsChanged(slugs);
      return { deleted: true };
    },
  );

  /** Assign a group to an MCP, or remove the availability it grants. */
  app.put<{ Params: { id: string; slug: string } }>(
    "/api/admin/mcps/:slug/groups/:id",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const [group, registered] = await Promise.all([
        deps.db.mcpGroup.findUnique({ where: { id: request.params.id } }),
        deps.registry.get(request.params.slug),
      ]);
      if (!group) return jsonError(reply, 404, "Unknown group");
      if (!registered) return jsonError(reply, 404, "Unknown MCP");
      const mcpId = registered.record.id;
      if (!parsed.data.enabled) {
        await deps.db.mcpGroupMcp.deleteMany({ where: { groupId: group.id, mcpId } });
        deps.notifier.toolsChanged([registered.record.slug]);
        return { slug: registered.record.slug, enabled: false };
      }
      await deps.db.mcpGroupMcp.upsert({
        where: { groupId_mcpId: { groupId: group.id, mcpId } },
        create: { groupId: group.id, mcpId },
        update: {},
      });
      deps.notifier.toolsChanged([registered.record.slug]);
      return { slug: registered.record.slug, enabled: true };
    },
  );

  // ---------------------------------------------------------------- Keys & logs

  /** All API keys (admin), joined with their owner. */
  app.get("/api/admin/keys", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const keys = await deps.db.apikey.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const users = await deps.db.user.findMany({
      where: { id: { in: [...new Set(keys.map((k) => k.referenceId))] } },
      select: { id: true, email: true, name: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return keys.map((key) => ({
      ...presentKey(key),
      owner: byId.get(key.referenceId) ?? {
        id: key.referenceId,
        email: null,
        name: null,
      },
    }));
  });

  app.delete<{ Params: { id: string } }>(
    "/api/admin/keys/:id",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const result = await deps.db.apikey.deleteMany({
        where: { id: request.params.id },
      });
      if (result.count === 0) return jsonError(reply, 404, "Unknown key");
      return { deleted: true };
    },
  );

  /** Journal of MCP tool calls and rack service calls. */
  app.get<{
    Querystring: { slug?: string; userId?: string; ok?: string; limit?: string };
  }>("/api/admin/logs", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { slug, userId, ok } = request.query;
    const limit = Math.min(Number(request.query.limit ?? 100) || 100, 500);
    const calls = await deps.db.toolCall.findMany({
      where: {
        ...(slug ? { mcp: { slug } } : {}),
        ...(userId ? { userId } : {}),
        ...(ok === "true" ? { ok: true } : ok === "false" ? { ok: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { mcp: { select: { slug: true, name: true } } },
    });
    const userIds = [
      ...new Set(calls.map((c) => c.userId).filter((id): id is string => !!id)),
    ];
    const users = userIds.length
      ? await deps.db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return calls.map((call) => ({
      id: call.id,
      mcp: call.mcp.slug,
      mcpName: call.mcp.name,
      userId: call.userId,
      userEmail: call.userId ? (byId.get(call.userId)?.email ?? null) : null,
      keyId: call.keyId,
      tool: call.tool,
      capability: call.capability,
      ok: call.ok,
      durationMs: call.durationMs,
      cost: call.cost ? Number(call.cost) : null,
      error: call.error,
      createdAt: call.createdAt,
    }));
  });
}
