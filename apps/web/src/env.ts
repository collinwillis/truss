/**
 * Environment Variable Validation
 *
 * Validates environment variables at build and runtime using Zod.
 *
 * @see https://env.t3.gg/docs/nextjs
 */

import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /** Server-side environment variables (never sent to client) */
  server: {
    // Authentication
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "BETTER_AUTH_SECRET must be at least 32 characters")
      .describe("Secret key for encrypting sessions and tokens"),

    // OAuth Providers (Optional)
    GITHUB_CLIENT_ID: z.string().optional().describe("GitHub OAuth client ID"),
    GITHUB_CLIENT_SECRET: z.string().optional().describe("GitHub OAuth client secret"),
    GOOGLE_CLIENT_ID: z.string().optional().describe("Google OAuth client ID"),
    GOOGLE_CLIENT_SECRET: z.string().optional().describe("Google OAuth client secret"),

    // Email (Optional)
    EMAIL_FROM: z.string().email().optional().describe("Email sender address"),
    RESEND_API_KEY: z.string().optional().describe("Resend API key for sending emails"),

    // Environment
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  },

  /** Client-side environment variables (prefixed with NEXT_PUBLIC_) */
  client: {
    // Convex
    NEXT_PUBLIC_CONVEX_URL: z.string().url().describe("Convex deployment URL"),

    // Application
    NEXT_PUBLIC_APP_URL: z
      .string()
      .url()
      .describe("Full URL of the application (for OAuth callbacks)"),
  },

  /** Runtime environment variables */
  runtimeEnv: {
    // Server
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    EMAIL_FROM: process.env.EMAIL_FROM,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    NODE_ENV: process.env.NODE_ENV,

    // Client
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },

  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
