/**
 * Authentication client for Tauri desktop applications.
 *
 * WHY: Points directly to Convex HTTP endpoints instead of proxying
 * through the Next.js web app. The crossDomainClient plugin handles
 * CORS and cookie management for Tauri's custom protocol.
 */

"use client";

import { createAuthClient } from "better-auth/react";
import type { BetterAuthClientPlugin } from "better-auth";
import { twoFactorClient, organizationClient, adminClient } from "better-auth/client/plugins";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";

/**
 * Get the Convex site URL for auth requests.
 *
 * WHY: Auth requests go directly to Convex HTTP endpoints now,
 * not through the Next.js web app.
 */
const getBaseUrl = () => {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    if (import.meta.env.VITE_CONVEX_SITE_URL) {
      return import.meta.env.VITE_CONVEX_SITE_URL;
    }
  }
  return "http://localhost:5173";
};

/**
 * Authentication client configured for Tauri desktop applications.
 * Uses Convex HTTP endpoints for all auth operations.
 *
 * WHY type assertions on Convex plugins: @convex-dev/better-auth compiles
 * against a different internal @better-auth/core type version, causing deep
 * $InferServerPlugin mismatches. Same upstream issue requiring declaration:
 * false in tsconfig. Runtime behavior is unaffected.
 */
export const tauriAuthClient = createAuthClient({
  baseURL: getBaseUrl(),

  // WHY: Better Auth's built-in redirectPlugin calls window.location.href after
  // signIn/signUp, navigating to the Convex site URL (the baseURL). In a Tauri
  // SPA we handle post-auth navigation via onSuccess callbacks, not page redirects.
  disableDefaultFetchPlugins: true,

  fetchOptions: {
    credentials: "include",
  },

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

/** Export authentication methods for use in components */
export const { useSession, signIn, signOut, signUp, useActiveOrganization, useListOrganizations } =
  tauriAuthClient;

export { tauriAuthClient as authClient };
