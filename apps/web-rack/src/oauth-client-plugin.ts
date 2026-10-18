import { oauthProviderClient } from "@better-auth/oauth-provider/client";

/** OTP delivery is an identity operation, independent from a pending OAuth request. */
export function rackOAuthProviderClient() {
  const plugin = oauthProviderClient();
  for (const fetchPlugin of plugin.fetchPlugins) {
    const original = fetchPlugin.hooks.onRequest;
    fetchPlugin.hooks.onRequest = async (ctx) => {
      const path = new URL(ctx.url, "http://localhost").pathname;
      if (path.endsWith("/email-otp/send-verification-otp")) return;
      return original(ctx);
    };
  }
  return plugin;
}
