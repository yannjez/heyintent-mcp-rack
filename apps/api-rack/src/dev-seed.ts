/**
 * Local fixtures: a handful of products the way they really look — an
 * application a user opens plus the MCP channels of the same product — so the
 * personal space and the admin catalogue have something to show.
 *
 * Development only. Everything it writes carries a `vitest`-free but
 * recognisable name and can be removed with `--clean`. It never touches the
 * packages shipped with the rack, except to attach `site-public` to its
 * product and to leave `sample` standalone on purpose.
 */
import { createPrismaClient, type Db } from "@rack/database";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env.js";
import { sealConfig, type ResourceConfig } from "./mcp/resources.js";
import { SecretBox } from "./mcp/secrets.js";

const env = loadEnv(process.env);
const db: Db = createPrismaClient(env.databaseUrl);
const box = new SecretBox(env.resourceSecret);
const clean = process.argv.includes("--clean");

/** Products: one application, and the MCP channels hanging off it. */
const PRODUCTS = [
  {
    clientId: "dev-ai-space",
    name: "AI space",
    uri: "https://ai-space.heyintent.com",
    resources: [
      {
        slug: "ai-space-content",
        name: "AI space · contenu",
        description: "Pages, espaces et documents de l'AI space.",
        resource: {
          kind: "site",
          config: { apiUrl: "https://ai-space.vps02.heyintent.com", apiToken: "" },
        } satisfies ResourceConfig,
      },
    ],
  },
  {
    clientId: "dev-veille-ao",
    name: "Veille AO",
    uri: "https://veille-ao.vps02.heyintent.com",
    resources: [
      {
        slug: "veille-ao-mcp",
        name: "Veille AO · appels d'offres",
        description: "Recherche et suivi des appels d'offres, relayé par le rack.",
        resource: {
          kind: "partner",
          config: {
            url: "https://veille-ao.vps02.heyintent.com/mcp",
            headerName: "Authorization",
            token: "dev-token-veille-ao",
          },
        } satisfies ResourceConfig,
      },
    ],
  },
  {
    clientId: "dev-heyintent-com",
    name: "heyintent.com",
    uri: "https://heyintent.com",
    // The shipped `site-public` package is this product's MCP channel.
    adopt: ["site-public"],
    resources: [],
  },
];

/** An agent that registered itself, to populate « Mes consommateurs ». */
const CONSUMER = { clientId: "dev-codex-cli", name: "Codex CLI (local)" };

const GROUP = "Équipe Intent";
const SLUGS = PRODUCTS.flatMap((p) => p.resources.map((r) => r.slug));
const CLIENT_IDS = [...PRODUCTS.map((p) => p.clientId), CONSUMER.clientId];

async function wipe() {
  await db.mcp.updateMany({
    where: { clientId: { in: CLIENT_IDS } },
    data: { clientId: null },
  });
  await db.mcp.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.oauthClient.deleteMany({ where: { clientId: { in: CLIENT_IDS } } });
  await db.mcpGroup.deleteMany({ where: { name: GROUP } });
}

async function seed() {
  const admin = await db.user.findFirst({
    where: { role: { contains: "admin" } },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) throw new Error("No admin account: run `pnpm db:seed` first.");

  for (const product of PRODUCTS) {
    // Public client (no secret): enough to appear and be opened, and nothing
    // here should pretend to be a working credential.
    await db.oauthClient.upsert({
      where: { clientId: product.clientId },
      create: {
        id: randomUUID(),
        clientId: product.clientId,
        name: product.name,
        uri: product.uri,
        kind: "application",
        tokenEndpointAuthMethod: "none",
        redirectUris: [`${product.uri}/auth/callback`],
        postLogoutRedirectUris: [],
        scopes: ["openid", "profile", "email"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        contacts: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      update: { name: product.name, uri: product.uri, kind: "application" },
    });

    for (const entry of product.resources) {
      await db.mcp.upsert({
        where: { slug: entry.slug },
        create: {
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          version: "1.0.0",
          kind: entry.resource.kind,
          capabilities: entry.resource.kind === "site" ? ["data"] : [],
          config: sealConfig(entry.resource, box),
          clientId: product.clientId,
        },
        update: {
          name: entry.name,
          description: entry.description,
          clientId: product.clientId,
        },
      });
    }
    for (const slug of product.adopt ?? []) {
      await db.mcp.updateMany({ where: { slug }, data: { clientId: product.clientId } });
    }
  }

  await db.oauthClient.upsert({
    where: { clientId: CONSUMER.clientId },
    create: {
      id: randomUUID(),
      clientId: CONSUMER.clientId,
      name: CONSUMER.name,
      kind: "consumer",
      tokenEndpointAuthMethod: "none",
      redirectUris: ["http://127.0.0.1:1455/auth/callback"],
      postLogoutRedirectUris: [],
      scopes: ["openid", "profile", "email"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      contacts: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: { name: CONSUMER.name, kind: "consumer" },
  });
  // The consent is what makes a consumer visible, and only to this account.
  await db.oauthConsent.deleteMany({
    where: { clientId: CONSUMER.clientId, userId: admin.id },
  });
  await db.oauthConsent.create({
    data: {
      id: randomUUID(),
      clientId: CONSUMER.clientId,
      userId: admin.id,
      scopes: ["openid", "profile", "email"],
      resources: [],
      requestedUserInfoClaims: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  // What the consumer may do, MCP by MCP: one in write, one lowered to read.
  const granted = await db.mcp.findMany({
    orderBy: { slug: "asc" },
    take: 2,
    select: { id: true },
  });
  await db.mcpGrant.deleteMany({
    where: { clientId: CONSUMER.clientId, userId: admin.id },
  });
  await db.mcpGrant.createMany({
    data: granted.map((mcp, index) => ({
      clientId: CONSUMER.clientId,
      userId: admin.id,
      mcpId: mcp.id,
      access: index === 0 ? "write" : "read",
      consentedAccess: "write",
    })),
  });

  // Without a common group nothing is reachable, admin included.
  const every = await db.mcp.findMany({ select: { id: true, slug: true } });
  const group = await db.mcpGroup.upsert({
    where: { name: GROUP },
    create: {
      name: GROUP,
      description: "Groupe de développement local.",
      users: { create: { userId: admin.id } },
      mcps: { create: every.map((mcp) => ({ mcpId: mcp.id })) },
    },
    update: {},
  });
  await db.mcpGroupUser.upsert({
    where: { groupId_userId: { groupId: group.id, userId: admin.id } },
    create: { groupId: group.id, userId: admin.id },
    update: {},
  });
  for (const mcp of every) {
    await db.mcpGroupMcp.upsert({
      where: { groupId_mcpId: { groupId: group.id, mcpId: mcp.id } },
      create: { groupId: group.id, mcpId: mcp.id },
      update: {},
    });
    // Write on the products, read on the rest: both levels are visible.
    await db.mcpAccess.upsert({
      where: { mcpId_userId: { mcpId: mcp.id, userId: admin.id } },
      create: {
        mcpId: mcp.id,
        userId: admin.id,
        access: SLUGS.includes(mcp.slug) ? "write" : "read",
      },
      update: { access: SLUGS.includes(mcp.slug) ? "write" : "read" },
    });
  }

  console.log(`Produits : ${PRODUCTS.map((p) => p.name).join(", ")}`);
  console.log(`Consommateur : ${CONSUMER.name} (consenti par ${admin.email})`);
  console.log(
    `Groupe « ${GROUP} » : ${every.length} ressource(s), ${admin.email} membre`,
  );
  console.log("`sample` reste volontairement sans application (ressource autonome).");
}

try {
  await wipe();
  if (!clean) await seed();
  else console.log("Fixtures de développement supprimées.");
} finally {
  await db.$disconnect();
}
