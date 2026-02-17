"use client";

import { createAuthClient } from "better-auth/react";
import type { BetterAuthClientPlugin } from "better-auth";
import { twoFactorClient, organizationClient, adminClient } from "better-auth/client/plugins";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";

const getBaseUrl = () => {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_CONVEX_SITE_URL) {
    return import.meta.env.VITE_CONVEX_SITE_URL;
  }
  return "http://localhost:5173";
};

/**
 * Auth client for Tauri desktop apps.
 *
 * Type assertions on Convex plugins: upstream @better-auth/core version
 * mismatch causes $InferServerPlugin type errors. Runtime is unaffected.
 *
 * @see https://labs.convex.dev/better-auth/framework-guides/react
 */
export const tauriAuthClient = createAuthClient({
  baseURL: getBaseUrl(),
  disableDefaultFetchPlugins: true,
  plugins: [
    convexClient() as unknown as BetterAuthClientPlugin,
    crossDomainClient() as unknown as BetterAuthClientPlugin,
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.href = "/auth/2fa";
      },
    }),
    organizationClient(),
    adminClient(),
  ],
});

export const { useSession, signIn, signOut, signUp, useActiveOrganization, useListOrganizations } =
  tauriAuthClient;

export { tauriAuthClient as authClient };
