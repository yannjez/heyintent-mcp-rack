import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { Db } from "@rack/database";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
  allowedEmailDomains: string[];
  adminEmails: string[];
  sendOtp: OtpSender;
  /** Accounts pre-created by an admin may sign in whatever their domain. */
  userExists?: (email: string) => Promise<boolean>;
  /** Scopes advertised to OAuth clients (mcp:<slug>:read|write). */
  extraScopes?: string[];
  trustedOrigins?: string[];
}

export function mcpResource(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/mcp`;
}

/**
 * Better Auth instance: email OTP sign-in, admin roles, API keys, JWT/JWKS and
 * the OAuth 2.1 provider MCP clients discover (RFC 8414 / 9728).
 */
export function createAuth(db: Db | object, input: AuthInput) {
  const allowedDomains = input.allowedEmailDomains;
  const adminEmails = input.adminEmails;

  async function assertAllowedEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    const domain = normalized.split("@").at(1);
    if (!domain || (allowedDomains.length > 0 && !allowedDomains.includes(domain))) {
      if (input.userExists && (await input.userExists(normalized))) return;
      throw new APIError("FORBIDDEN", {
        message: "Use your approved company email address.",
      });
    }
  }

  const resource = mcpResource(input.baseUrl);
  const scopes = [...BASE_SCOPES, ...(input.extraScopes ?? [])];

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
          await assertAllowedEmail(email);
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
        resources: [{ identifier: resource, name: "MCP Accès", allowedScopes: scopes }],
        resourceSeedMode: "merge",
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
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
    hooks: {
      // Enforce the company-domain allowlist before any OTP is issued, whatever
      // the plugin's anti-enumeration behaviour returns.
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/email-otp/send-verification-otp" ||
          ctx.path === "/sign-in/email-otp"
        ) {
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          if (typeof email === "string") await assertAllowedEmail(email);
        }
      }),
    },
    rateLimit: {
      enabled: input.isProduction,
      window: 60,
      max: 20,
    },
  });
  const handler = auth.handler;
  auth.handler = async (request: Request) => {
    const url = new URL(request.url);
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
    return oauthClient.run(clientId, () => handler(request));
  };
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
