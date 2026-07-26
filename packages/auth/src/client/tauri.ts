"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient, organizationClient, adminClient } from "better-auth/client/plugins";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { tauriFetchImpl } from "@daveyplate/better-auth-tauri";

const getBaseUrl = () => {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_CONVEX_SITE_URL) {
    return import.meta.env.VITE_CONVEX_SITE_URL;
  }
  return "http://localhost:5173";
};

/**
 * Auth client for Tauri desktop apps.
 *
 * WHY tauriFetchImpl: Tauri WebViews block cross-origin browser fetch due to
 * CORS (especially on Windows). tauriFetchImpl routes requests through
 * @tauri-apps/plugin-http which bypasses WebView CORS restrictions.
 *
 * The Convex plugins must stay un-asserted: widening them to
 * BetterAuthClientPlugin erases `$InferServerPlugin`, which is what gives the
 * client its `convex` namespace. ConvexBetterAuthProvider requires that
 * namespace, so an assertion here surfaces as an error at the call site.
 *
 * @see https://labs.convex.dev/better-auth/framework-guides/react
 */
export const tauriAuthClient = createAuthClient({
  baseURL: getBaseUrl(),
  disableDefaultFetchPlugins: true,
  fetchOptions: {
    customFetchImpl: tauriFetchImpl,
  },
  plugins: [
    convexClient(),
    crossDomainClient(),
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
