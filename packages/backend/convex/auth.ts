/**
 * Better Auth configuration for Convex backend.
 *
 * WHY: Centralizes all authentication logic inside Convex, eliminating
 * the need for a separate Postgres database and Next.js API routes.
 * Desktop apps authenticate directly with Convex HTTP endpoints.
 *
 * @module
 */

import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { admin, twoFactor, organization } from "better-auth/plugins";
import authConfig from "./auth.config";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authSchema from "./betterAuth/schema";

const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";

/** Component client for Better Auth data access */
export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
});

/**
 * Create Better Auth options for the given Convex context.
 *
 * WHY separated: The Local Install pattern requires this function
 * to be importable by the betterAuth component adapter.
 */
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    database: authComponent.adapter(ctx),
    baseURL: siteUrl,

    trustedOrigins: [
      "truss://",
      "tauri://localhost",
      "https://tauri.localhost",
      "http://localhost:1420",
      "http://localhost:1421",
      "http://localhost:3000",
      siteUrl,
    ],

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },

    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID ?? "",
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
        enabled: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      },
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 1 day
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },

    user: {
      additionalFields: {
        role: {
          type: "string" as const,
          defaultValue: "user",
          required: false,
        },
        metadata: {
          type: "json" as const,
          required: false,
        },
      },
    },

    plugins: [
      crossDomain({ siteUrl }),
      convex({ authConfig }),
      admin({
        defaultRole: "user",
        adminRole: "admin",
      }),
      twoFactor({
        issuer: "Truss",
      }),
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 10,
        schema: {
          organization: {
            additionalFields: {
              allowedDomains: {
                type: "string[]",
                required: false,
                defaultValue: null,
                input: true,
              },
              autoJoinEnabled: {
                type: "boolean",
                required: false,
                defaultValue: false,
                input: true,
              },
            },
          },
        },
        sendInvitationEmail: async (data) => {
          // Pending email provider integration
          console.log("Send invitation email:", data);
        },
        async onUserSignUp() {},
      }),
    ],
  } satisfies BetterAuthOptions;
};

/** Create a Better Auth instance bound to the given Convex context */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

/** Query to get the currently authenticated user */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.safeGetAuthUser(ctx);
  },
});
