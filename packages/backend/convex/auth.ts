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
import { APIError } from "better-auth/api";
import authConfig from "./auth.config";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authSchema from "./betterAuth/schema";

const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
const DEFAULT_ORG_SLUG = "indemand";

/**
 * Email domains permitted to create an account.
 *
 * Override with the `ALLOWED_SIGNUP_DOMAINS` Convex env var (comma-separated) so
 * adding a domain does not require a code deploy.
 *
 * WHY A CONSTANT RATHER THAN THE ORGANIZATION'S `allowedDomains` FIELD: that
 * field exists on the org schema but is read by nothing, and resolving it would
 * put a database lookup on the sign-up path before we know which org the user
 * belongs to. With a single tenant, config is the simpler and more robust
 * source of truth. Revisit when M10 makes multi-tenancy real.
 */
const ALLOWED_SIGNUP_DOMAINS: readonly string[] = (
  process.env.ALLOWED_SIGNUP_DOMAINS ?? "indemandis.com"
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

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
        // WHY log instead of silently returning: a missing default org would
        // orphan the new user (no membership), which surfaces downstream as a
        // blank Admin > Members page. `backfillInDemandMembership` reconciles
        // any users missed here, but we want the gap visible in logs.
        if (!org) {
          console.error(
            `[auth] onCreate: default org "${DEFAULT_ORG_SLUG}" not found — user ${user._id} left without membership`
          );
          return;
        }

        // Best-effort: never block sign-up if the membership grant fails.
        // The user is created either way and the backfill will catch them.
        try {
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
        } catch (err) {
          console.error(
            `[auth] onCreate: failed to add user ${user._id} to "${DEFAULT_ORG_SLUG}":`,
            err
          );
        }
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
      // Windows WebView2 serves the app from the http scheme by default (no
      // useHttpsScheme set), so its origin is http — not https — tauri.localhost.
      // Without this, login fails on Windows with "invalid origin".
      "https://tauri.localhost",
      "http://tauri.localhost",
      "http://localhost:1420",
      "http://localhost:1421",
      "http://localhost:3000",
      siteUrl,
    ],

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      sendResetPassword: async ({ user, url: _url, token }) => {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
          console.error("[auth] RESEND_API_KEY not set — cannot send reset email");
          return;
        }

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Truss <noreply@truss.forerelic.com>",
            to: [user.email],
            subject: "Reset your password",
            html: [
              "<h2>Password Reset</h2>",
              `<p>Hi ${user.name || "there"},</p>`,
              "<p>We received a request to reset your password. Use the token below in the Momentum app to set a new password:</p>",
              `<p style="font-family:monospace;font-size:16px;background:#f4f4f5;padding:12px 16px;border-radius:8px;word-break:break-all;">${token}</p>`,
              "<p>If you didn't request this, you can safely ignore this email.</p>",
              "<p>— The Truss Team</p>",
            ].join(""),
          }),
        }).catch((err) => {
          console.error("[auth] Failed to send reset email:", err);
        });
      },
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

    databaseHooks: {
      // Gate account creation to approved email domains.
      //
      // WHY: sign-up was open to the internet. `emailAndPassword.enabled` plus
      // `autoSignIn` meant anyone who found the endpoint could create an account
      // and land inside the InDemand workspace, which holds 700+ real bids.
      //
      // WHY HERE RATHER THAN ON THE SIGN-UP ENDPOINT: every path that creates a
      // user runs this hook — email/password and every social provider — so
      // there is no second door to remember to lock.
      //
      // WHY THIS DOES NOT LOCK ANYONE OUT: the hook fires on user *creation*
      // only. All 23 existing accounts sign in untouched, including the one on a
      // non-company domain.
      //
      // This is a floor, not the real access model. Invitation-only is the
      // correct end state and is M10 work; until then a domain allow-list is the
      // cheapest control that actually closes the door.
      user: {
        create: {
          before: async (user) => {
            const email = String(user.email ?? "");
            const domain = email.split("@")[1]?.toLowerCase();

            if (!domain || !ALLOWED_SIGNUP_DOMAINS.includes(domain)) {
              console.warn(`[auth] blocked sign-up for disallowed domain: ${email}`);
              throw new APIError("FORBIDDEN", {
                message: "This email domain is not permitted. Ask an administrator to invite you.",
              });
            }
            return;
          },
        },
      },

      // Point every newly-created session at the InDemand organization.
      //
      // WHY: Better Auth never sets an active organization on its own. Without
      // this, a member signs in with `activeOrganizationId` unset, the client
      // falls back to the "personal workspace" branch, and org-scoped surfaces
      // (e.g. Admin > Members) render blank. InDemand is the only org and every
      // user belongs to it, so the active org is unambiguous. Best-effort: a
      // failure here must never block sign-in.
      session: {
        create: {
          before: async (session) => {
            try {
              const org = await ctx.runQuery(components.betterAuth.adapter.findOne, {
                model: "organization",
                where: [{ field: "slug", value: DEFAULT_ORG_SLUG }],
              });
              if (!org) return;
              return { data: { ...session, activeOrganizationId: org._id as string } };
            } catch (err) {
              console.error("[auth] session.create.before: failed to set active org:", err);
              return;
            }
          },
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
          const apiKey = process.env.RESEND_API_KEY;
          if (!apiKey) {
            console.error("[auth] RESEND_API_KEY not set — cannot send invitation");
            return;
          }

          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "Truss <noreply@truss.forerelic.com>",
              to: [data.email],
              subject: `You've been invited to ${data.organization.name}`,
              html: [
                "<h2>You're Invited</h2>",
                `<p>${data.inviter.user.name} has invited you to join <strong>${data.organization.name}</strong> on Truss.</p>`,
                `<p>Role: <strong>${data.role}</strong></p>`,
                "<p>Sign in to the Momentum app to accept your invitation.</p>",
                "<p>— The Truss Team</p>",
              ].join(""),
            }),
          }).catch((err) => {
            console.error("[auth] Failed to send invitation email:", err);
          });
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
