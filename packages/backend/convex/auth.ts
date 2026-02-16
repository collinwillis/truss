/**
 * Better Auth configuration for the Convex backend.
 *
 * Uses the Local Install pattern so organization, admin, and twoFactor
 * plugins can extend the component schema.
 *
 * @see https://labs.convex.dev/better-auth/features/local-install
 * @module
 */

import { createClient, type GenericCtx, type AuthFunctions } from "@convex-dev/better-auth";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { admin, twoFactor, organization } from "better-auth/plugins";
import authConfig from "./auth.config";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authSchema from "./betterAuth/schema";

const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
const DEFAULT_ORG_SLUG = "indemand";

const authFunctions: AuthFunctions = internal.auth;

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
  authFunctions,
  triggers: {
    user: {
      onCreate: async (ctx, user) => {
        const org = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "organization",
          where: [{ field: "slug", value: DEFAULT_ORG_SLUG }],
        });
        if (!org) return;

        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "member",
            data: {
              userId: user._id,
              organizationId: org._id,
              role: "member",
              createdAt: Date.now(),
            },
          },
        });
      },
    },
  },
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

/**
 * Build Better Auth options bound to a Convex context.
 *
 * Exported so the Local Install adapter can import it.
 */
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    database: authComponent.adapter(ctx),

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
      ...(process.env.GITHUB_CLIENT_ID &&
        process.env.GITHUB_CLIENT_SECRET && {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }),
      ...(process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET && {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }),
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },

    user: {
      additionalFields: {
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
        adminRoles: ["admin"],
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
          // TODO: integrate email provider
          console.log("Send invitation email:", data);
        },
      }),
    ],
  } satisfies BetterAuthOptions;
};

/** Create a Better Auth instance bound to the given Convex context. */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

/** Query the currently authenticated user (returns null if unauthenticated). */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.safeGetAuthUser(ctx);
  },
});
