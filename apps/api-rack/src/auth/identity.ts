import { grantsFromScopes, type Identity } from "@rack/mcp-kit";
import type { JWTPayload } from "jose";
import type { Auth } from "./auth.js";
import { API_KEY_PREFIX } from "./auth.js";

/** Pull an API key from `Authorization: Bearer rk_…` or `x-api-key`. */
export function extractApiKey(headers: Headers): string | null {
  const direct = headers.get("x-api-key");
  if (direct) return direct.trim();
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return null;
}

export function hasBearerToken(headers: Headers) {
  return headers.get("authorization")?.toLowerCase().startsWith("bearer ") ?? false;
}

export async function identityFromApiKey(
  auth: Auth,
  key: string,
): Promise<Identity | null> {
  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) return null;
  const permissions = result.key.permissions ?? {};
  return {
    userId: result.key.referenceId,
    via: "apikey",
    keyId: result.key.id,
    grants: grantsFromScopes(Object.keys(permissions)),
  };
}

export function identityFromAccessToken(claims: JWTPayload): Identity | null {
  if (typeof claims.sub !== "string") return null;
  const scope = typeof claims.scope === "string" ? claims.scope.split(/\s+/) : [];
  const identity: Identity = {
    userId: claims.sub,
    via: "oauth",
    grants: grantsFromScopes(scope),
  };
  if (typeof claims.client_id === "string") identity.clientId = claims.client_id;
  if (typeof claims.email === "string") identity.email = claims.email;
  return identity;
}

export async function identityFromSession(
  auth: Auth,
  headers: Headers,
): Promise<Identity | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    via: "session",
    grants: { mcps: "*", caps: "*" },
  };
}

export async function sessionUser(auth: Auth, headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const user = session.user as typeof session.user & {
    role?: string | null;
    kind?: string | null;
    banned?: boolean | null;
  };
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role ?? "user",
    kind: user.kind ?? "internal",
    isAdmin: (user.role ?? "").split(",").includes("admin"),
    banned: user.banned ?? false,
  };
}
