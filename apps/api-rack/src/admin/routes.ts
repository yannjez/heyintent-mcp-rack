import { ACCESS_LEVELS, USER_KINDS } from "@rack/mcp-kit";
import type { Db } from "@rack/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { canAccessApplication } from "../auth/applications.js";
import type { Auth } from "../auth/auth.js";
import { sessionUser } from "../auth/identity.js";
import { jsonError, toWebRequest } from "../http.js";
import { presentKey } from "../keys/routes.js";
import type { McpRegistry } from "../mcp/registry.js";

export interface AdminRoutesDeps {
  auth: Auth;
  db: Db;
  registry: McpRegistry;
  baseUrl: string;
}

const patchMcpSchema = z.object({
  enabled: z.boolean().optional(),
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
      .map((mcp) => ({
        slug: mcp.slug,
        name: mcp.name,
        description: mcp.description,
        category: mcp.category,
        version: mcp.version,
        access: accesses[mcp.slug],
        tools: mcp.tools,
        url: mcpUrl(mcp),
        appUrl: mcp.externalUrl,
      }));
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
        disabled: true,
        accessRestricted: true,
        redirectUris: true,
        scopes: true,
        applicationGroups: { select: { groupId: true } },
        applicationAccesses: { select: { userId: true, allowed: true } },
      },
    });
    return clients.map(({ applicationGroups, applicationAccesses, ...client }) => ({
      ...client,
      disabled: client.disabled ?? false,
      groupIds: applicationGroups.map((g) => g.groupId),
      users: applicationAccesses,
    }));
  });

  app.patch<{ Params: { clientId: string } }>(
    "/api/admin/applications/:clientId",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = z
        .strictObject({
          disabled: z.boolean().optional(),
          accessRestricted: z.boolean().optional(),
          groupIds: z.array(z.string().min(1)).max(100).optional(),
          users: z
            .array(z.strictObject({ userId: z.string().min(1), allowed: z.boolean() }))
            .max(500)
            .optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const { clientId } = request.params;
      const client = await deps.db.oauthClient.findUnique({ where: { clientId } });
      if (!client) return jsonError(reply, 404, "Unknown application");
      const { disabled, accessRestricted, groupIds, users } = parsed.data;
      if (users && new Set(users.map((u) => u.userId)).size !== users.length)
        return jsonError(reply, 400, "Duplicate user");
      if (groupIds) {
        const count = await deps.db.mcpGroup.count({ where: { id: { in: groupIds } } });
        if (count !== new Set(groupIds).size)
          return jsonError(reply, 404, "Unknown group");
      }
      if (users) {
        const count = await deps.db.user.count({
          where: { id: { in: users.map((u) => u.userId) } },
        });
        if (count !== users.length) return jsonError(reply, 404, "Unknown user");
      }
      await deps.db.$transaction([
        deps.db.oauthClient.update({
          where: { clientId },
          data: {
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
            ...(users ? { applicationAccesses: { deleteMany: {}, create: users } } : {}),
          },
        }),
        // Clear saved grants and refresh credentials when the policy changes.
        deps.db.oauthAccessToken.deleteMany({ where: { clientId } }),
        deps.db.oauthRefreshToken.deleteMany({ where: { clientId } }),
        deps.db.oauthConsent.deleteMany({ where: { clientId } }),
      ]);
      return { clientId, updated: true };
    },
  );

  // ---------------------------------------------------------------- MCPs

  app.get("/api/admin/mcps", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const [mcps, links] = await Promise.all([
      deps.registry.list(),
      deps.db.mcpGroupMcp.findMany({
        include: { group: { include: { users: { select: { userId: true } } } } },
      }),
    ]);
    return mcps.map((mcp) => {
      const groups = links.filter((link) => link.mcpId === mcp.id);
      return {
        ...mcp,
        url: mcpUrl(mcp),
        userCount: new Set(
          groups.flatMap((link) => link.group.users.map((u) => u.userId)),
        ).size,
        groupCount: groups.length,
        groups: groups.map((link) => ({ id: link.groupId, name: link.group.name })),
      };
    });
  });

  app.patch<{ Params: { slug: string } }>(
    "/api/admin/mcps/:slug",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = patchMcpSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const registered = await deps.registry.get(request.params.slug);
      if (!registered) return jsonError(reply, 404, "Unknown MCP");

      const { enabled } = parsed.data;
      const updated = await deps.db.mcp.update({
        where: { slug: request.params.slug },
        data: { ...(enabled !== undefined ? { enabled } : {}) },
      });
      return { slug: updated.slug, enabled: updated.enabled };
    },
  );

  // ---------------------------------------------------------------- Users

  app.get("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const [users, accesses, keys, groups] = await Promise.all([
      deps.db.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 500,
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
      const result = await deps.db.mcpGroup.deleteMany({
        where: { id: request.params.id },
      });
      if (result.count === 0) return jsonError(reply, 404, "Unknown group");
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
        return { slug: registered.record.slug, enabled: false };
      }
      await deps.db.mcpGroupMcp.upsert({
        where: { groupId_mcpId: { groupId: group.id, mcpId } },
        create: { groupId: group.id, mcpId },
        update: {},
      });
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
