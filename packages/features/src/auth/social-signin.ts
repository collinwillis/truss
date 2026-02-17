import { signInSocial } from "@daveyplate/better-auth-tauri";
import type { createAuthClient } from "better-auth/react";

/**
 * Helper function for social sign-in in Tauri desktop apps.
 * Uses the official Better Auth Tauri plugin's signInSocial helper
 * which properly handles OAuth flows through the Tauri Opener plugin.
 *
 * @see https://github.com/daveyplate/better-auth-tauri#social-sign-in
 */
export async function signInWithProvider(
  authClient: ReturnType<typeof createAuthClient>,
  provider: "google" | "github" | "apple" | "microsoft"
) {
  try {
    await signInSocial({
      authClient,
      provider,
    });
  } catch (error) {
    console.error(`[Auth] Failed to sign in with ${provider}:`, error);
    throw error;
  }
}
