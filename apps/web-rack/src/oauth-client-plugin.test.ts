import { afterEach, describe, expect, it, vi } from "vitest";
import { rackOAuthProviderClient } from "./oauth-client-plugin";

describe("OAuth client request scoping", () => {
  afterEach(() => vi.unstubAllGlobals());
  const signed = new URLSearchParams({
    client_id: "https://factory.example/client.json",
    state: "s",
    exp: "1",
    sig: "signature",
  });
  for (const key of ["client_id", "state", "exp", "ba_param"])
    signed.append("ba_param", key);

  it("sends OTP without the stale OAuth context while keeping it on sign-in and consent", async () => {
    vi.stubGlobal("window", { location: { search: `?${signed}&ui_hint=ignored` } });
    const plugin = rackOAuthProviderClient();
    const hook = plugin.fetchPlugins[0]!.hooks.onRequest;
    for (const path of [
      "email-otp/send-verification-otp",
      "sign-in/email-otp",
      "oauth2/consent",
    ]) {
      const context = {
        url: `https://rack.example/api/auth/${path}`,
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ email: "yann@example.test", type: "sign-in" }),
      } as Parameters<typeof hook>[0];
      await hook(context);
      const body = JSON.parse(context.body as string) as {
        oauth_query?: string;
        email: string;
      };
      expect(body.email).toBe("yann@example.test");
      if (path.startsWith("email-otp/")) expect(body.oauth_query).toBeUndefined();
      else expect(body.oauth_query).toBe(signed.toString());
    }
  });
});
