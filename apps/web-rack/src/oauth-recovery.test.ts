import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  isInvalidOAuthQuery,
  oauthRequestExpired,
  restartOAuthPath,
} from "./oauth-recovery";

describe("OAuth recovery", () => {
  it("restarts through the provider with state, PKCE, nonce and resources preserved", () => {
    const params = new URLSearchParams({
      client_id: "https://factory.example/.well-known/oauth-client.json",
      redirect_uri: "https://factory.example/auth/callback",
      response_type: "code",
      scope: "openid profile email",
      state: "state+with/special=characters",
      nonce: "nonce",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      sig: "expired/signature+",
      exp: "1",
      ba_iat: "1",
      ba_pl: "session",
    });
    params.append("resource", "https://a.example/mcp");
    params.append("resource", "https://b.example/mcp");
    params.append("ba_param", "state");
    params.append("ba_param", "ba_param");
    const restart = new URL(restartOAuthPath(params.toString())!, "https://rack.example");
    expect(restart.origin + restart.pathname).toBe(
      "https://rack.example/api/auth/oauth2/authorize",
    );
    for (const key of [
      "state",
      "nonce",
      "client_id",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
    ]) {
      expect(restart.searchParams.get(key)).toBe(params.get(key));
    }
    expect(restart.searchParams.getAll("resource")).toEqual(params.getAll("resource"));
    for (const key of ["sig", "exp", "ba_param", "ba_iat", "ba_pl"])
      expect(restart.searchParams.has(key)).toBe(false);
  });
  it("does not start OAuth for a direct Rack login", () => {
    expect(restartOAuthPath("?from=/admin/users")).toBe(null);
    expect(oauthRequestExpired("", 2000)).toBe(false);
  });
  it("recognizes expired requests and the actual invalid_signature response", () => {
    expect(oauthRequestExpired("?sig=s&exp=1", 2000)).toBe(true);
    expect(oauthRequestExpired("?sig=s&exp=10", 2000)).toBe(false);
    expect(isInvalidOAuthQuery({ error: "invalid_signature", status: 400 })).toBe(true);
    expect(isInvalidOAuthQuery({ message: "Code invalide" })).toBe(false);
    expect(authErrorMessage({ error: "invalid_signature" }, "Fallback")).toContain(
      "Reprenez la connexion",
    );
    expect(authErrorMessage({ status: 429 }, "Fallback")).toContain("Trop de tentatives");
  });
});
