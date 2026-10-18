import { apiKeyClient } from "@better-auth/api-key/client";
import { rackOAuthProviderClient } from "./oauth-client-plugin";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  // The default "redirect" fetch plugin navigates to any `{ redirect, url }`
  // response on its own; the OAuth pages handle that hop themselves (see
  // src/oauth.ts), so it must not race with them.
  disableDefaultFetchPlugins: true,
  plugins: [emailOTPClient(), adminClient(), apiKeyClient(), rackOAuthProviderClient()],
});
