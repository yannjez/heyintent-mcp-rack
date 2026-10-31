import { randomUUID } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { Db } from "@rack/database";
import { type Access, mcpScopes, parseMcpScope } from "@rack/mcp-kit";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { admin, emailOTP, jwt } from "better-auth/plugins";
import { canAccessApplication } from "./applications.js";
import type { OtpSender } from "./email.js";

export const API_KEY_PREFIX = "rk_";
export const BASE_SCOPES = ["openid", "profile", "email", "offline_access"];

export interface AuthInput {
  baseUrl: string;
  secret: string;
  isProduction: boolean;
  adminEmails: string[];
  sendOtp: OtpSender;
  /**
   * Scopes advertised to OAuth clients (mcp:<slug>:read|write). The array is
   * kept by reference: the provider reads it on every request, so the rack
   * mutates it in place when a resource is added or removed.
   */
  extraScopes?: string[];
  trustedOrigins?: string[];
  /** Apps hosted elsewhere: tokens are issued for `<url>` (UI) and `<url>/mcp`. */
  externalResources?: { slug: string; name: string; url: string }[];
  /** Current MCP access of a user, embedded in access tokens as `mcp_access`. */
  mcpAccesses?: (userId: string) => Promise<Record<string, Access>>;
}

export function mcpResource(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/mcp`;
}

/** External tokens are short-lived so access changes in the rack apply quickly. */
const EXTERNAL_ACCESS_TOKEN_TTL = 900;

/** OAuth resource identifiers of external apps: their UI and their MCP endpoint. */
export function externalResourceIdentifiers(externals: { url: string }[] = []) {
  return externals.flatMap((external) => [external.url, `${external.url}/mcp`]);
}

/**
 * Link every existing OAuth client to the given resources. Clients registered
 * later get them through `clientRegistrationDefaultResources` (CIMD clients also
 * when their metadata is revalidated); this covers clients registered before an
 * external app was declared, since per-client resource checks stay enforced.
 */
export async function linkClientsToResources(db: Db, identifiers: string[]) {
  if (identifiers.length === 0) return 0;
  const [clients, resources, links] = await Promise.all([
    db.oauthClient.findMany({ select: { clientId: true } }),
    db.oauthResource.findMany({
      where: { identifier: { in: identifiers } },
      select: { identifier: true },
    }),
    db.oauthClientResource.findMany({
      where: { resourceId: { in: identifiers } },
      select: { clientId: true, resourceId: true },
    }),
  ]);
  const linked = new Set(links.map((link) => `${link.clientId} ${link.resourceId}`));
  const now = new Date();
  const data = clients.flatMap((client) =>
    resources
      .filter((resource) => !linked.has(`${client.clientId} ${resource.identifier}`))
      .map((resource) => ({
        id: randomUUID(),
        clientId: client.clientId,
        resourceId: resource.identifier,
        createdAt: now,
      })),
  );
  if (data.length > 0) {
    await db.oauthClientResource.createMany({ data, skipDuplicates: true });
  }
  return data.length;
}

/**
 * Access level per MCP slug that a token may use: what its scopes ask for,
 * capped by what the user is allowed in the rack.
 */
export function grantedMcpAccess(
  scopes: readonly string[],
  allowed: Record<string, Access>,
): Record<string, Access> {
  const requested: Record<string, Access> = {};
  for (const scope of scopes) {
    const parsed = parseMcpScope(scope);
    if (!parsed) continue;
    if (requested[parsed.slug] !== "write") requested[parsed.slug] = parsed.access;
  }
  const granted: Record<string, Access> = {};
  for (const [slug, wanted] of Object.entries(requested)) {
    const permitted = allowed[slug];
    if (!permitted) continue;
    granted[slug] = wanted === "write" && permitted === "write" ? "write" : "read";
  }
  return granted;
}

/**
 * Better Auth instance: email OTP sign-in, admin roles, API keys, JWT/JWKS and
 * the OAuth 2.1 provider MCP clients discover (RFC 8414 / 9728).
 */
export function createAuth(db: Db | object, input: AuthInput) {
  const adminEmails = input.adminEmails;

  const resource = mcpResource(input.baseUrl);
  const scopes = input.extraScopes ?? [];
  scopes.unshift(...BASE_SCOPES.filter((scope) => !scopes.includes(scope)));

  // Keep the client identifier tied to this request across login continuations
  // and token issuance. OAuth validates the signed query/client credentials.
  const oauthClient = new AsyncLocalStorage<string | undefined>();
  async function assertApplicationAccess(
    userId: string,
    clientId = oauthClient.getStore(),
  ) {
    if (!clientId || !(await canAccessApplication(db as Db, clientId, userId))) {
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        error_description:
          "Accès à cette application non autorisé. Contactez un administrateur.",
      });
    }
  }

  const auth = betterAuth({
    appName: "Intent Ressource Rack",
    baseURL: input.baseUrl,
    secret: input.secret,
    trustedOrigins: [input.baseUrl, ...(input.trustedOrigins ?? [])],
    database: prismaAdapter(db, { provider: "postgresql" }),
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
        kind: { type: "string", defaultValue: "internal", input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              role: adminEmails.includes(user.email.toLowerCase()) ? "admin" : "user",
            },
          }),
        },
      },
    },
    plugins: [
      emailOTP({
        expiresIn: 600,
        otpLength: 6,
        async sendVerificationOTP({ email, otp }) {
          await input.sendOtp(email, otp);
        },
      }),
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        enableMetadata: true,
        apiKeyHeaders: ["x-api-key"],
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource,
        // Explicit resource row: the Prisma scalar list `allowedScopes` cannot be null.
        resources: [
          { identifier: resource, name: "MCP Accès", allowedScopes: scopes },
          ...(input.externalResources ?? []).flatMap((external) =>
            externalResourceIdentifiers([external]).map((identifier) => ({
              identifier,
              name: external.name,
              allowedScopes: [...BASE_SCOPES, ...mcpScopes(external.slug)],
              accessTokenTtl: EXTERNAL_ACCESS_TOKEN_TTL,
            })),
          ),
        ],
        resourceSeedMode: "merge",
        // Per-client resource checks stay on: new clients are linked to external
        // apps as well as to the rack (mcp() adds its own resource).
        clientRegistrationDefaultResources: externalResourceIdentifiers(
          input.externalResources,
        ),
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes,
        postLogin: {
          page: "/consent",
          shouldRedirect: async ({ user }) => {
            await assertApplicationAccess(user.id);
            return false;
          },
          consentReferenceId: async ({ user }) => {
            await assertApplicationAccess(user.id);
            return undefined;
          },
        },
        extensions: [
          {
            claims: {
              userInfo: async ({ user, client, jwt }) => {
                const clientId =
                  client?.clientId ??
                  (typeof jwt.client_id === "string" ? jwt.client_id : undefined);
                await assertApplicationAccess(user.id, clientId);
                return {};
              },
            },
          },
        ],
        customTokenResponseFields: async ({ user }) => {
          if (user) await assertApplicationAccess(user.id);
          return {};
        },
        // External apps cannot ask the rack who may use them: tell them in the token.
        async customAccessTokenClaims({ user, scopes: granted }) {
          if (!user || !input.mcpAccesses) return {};
          if (!granted.some((scope) => parseMcpScope(scope))) return {};
          const mcpAccess = grantedMcpAccess(granted, await input.mcpAccesses(user.id));
          return { mcp_access: mcpAccess };
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
    rateLimit: {
      enabled: input.isProduction,
      window: 60,
      max: 20,
    },
  });
  const handler = auth.handler;
  auth.handler = async (request: Request) => {
    const url = new URL(request.url);
    let authRequest = request;
    let clientId = url.searchParams.get("client_id") ?? undefined;
    if (request.method === "POST") {
      const copy = request.clone();
      let body: Record<string, unknown> = {};
      try {
        if (request.headers.get("content-type")?.includes("application/json")) {
          body = (await copy.json()) as Record<string, unknown>;
        } else {
          const form = new URLSearchParams(await copy.text());
          if (["client_id", "oauth_query"].some((key) => form.getAll(key).length > 1)) {
            return Response.json(
              {
                error: "invalid_request",
                error_description: "Duplicate client parameters",
              },
              { status: 400 },
            );
          }
          body = Object.fromEntries(form);
        }
      } catch {
        /* Let Better Auth report malformed bodies. */
      }
      // Older web bundles attach oauth_query to every POST, including OTP
      // delivery. Do not let an expired OAuth login page prevent sending a code.
      // Sign-in and consent still verify the provider's signed query as usual.
      if (
        url.pathname.endsWith("/email-otp/send-verification-otp") &&
        body &&
        typeof body === "object" &&
        "oauth_query" in body
      ) {
        delete body.oauth_query;
        const headers = new Headers(request.headers);
        headers.set("content-type", "application/json");
        headers.delete("content-length");
        authRequest = new Request(request, { headers, body: JSON.stringify(body) });
        clientId = undefined;
      }
      const tokenRequest = url.pathname.endsWith("/oauth2/token");
      if (tokenRequest) {
        // Only token credentials identify the client here. An unsigned oauth_query
        // or URL parameter must never override the client exchanging a token.
        clientId = typeof body?.client_id === "string" ? body.client_id : undefined;
      } else if (typeof body?.oauth_query === "string") {
        // For consent/login, only the provider-verified signed query is binding;
        // ignore any extra client_id or Authorization supplied in the POST body.
        clientId = new URLSearchParams(body.oauth_query).get("client_id") ?? undefined;
      }
      const authorization = request.headers.get("authorization");
      if (tokenRequest && authorization?.toLowerCase().startsWith("basic ")) {
        const credentials = Buffer.from(authorization.slice(6), "base64").toString();
        try {
          const basicClientId = decodeURIComponent(credentials.split(":")[0]!);
          if (clientId && clientId !== basicClientId) {
            return Response.json(
              {
                error: "invalid_request",
                error_description: "Conflicting client identifiers",
              },
              { status: 400 },
            );
          }
          clientId = basicClientId;
        } catch {
          clientId = undefined;
        }
      }
    }
    return oauthClient.run(clientId, () => handler(authRequest));
  };
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
