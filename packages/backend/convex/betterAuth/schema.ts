/**
 * Better Auth schema tables for the Local Install component.
 *
 * WHY: Local Install requires the auth tables to be defined in the
 * component's own schema. These tables support: emailAndPassword,
 * organization, admin, twoFactor, and crossDomain plugins.
 *
 * REGENERATE: Run `cd convex/betterAuth && npx @better-auth/cli generate -y`
 * when auth configuration changes.
 *
 * @module
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  /** Core user table */
  user: defineTable({
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Admin plugin
    role: v.optional(v.string()),
    banned: v.optional(v.boolean()),
    banReason: v.optional(v.string()),
    banExpires: v.optional(v.number()),
    // Two-factor plugin
    twoFactorEnabled: v.optional(v.boolean()),
    // Custom fields
    metadata: v.optional(v.any()),
  }).index("email", ["email"]),

  /** Auth sessions */
  session: defineTable({
    expiresAt: v.number(),
    token: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    userId: v.string(),
    activeOrganizationId: v.optional(v.string()),
    impersonatedBy: v.optional(v.string()),
  })
    .index("token", ["token"])
    .index("userId", ["userId"]),

  /** Linked accounts (email/password, OAuth providers) */
  account: defineTable({
    accountId: v.string(),
    providerId: v.string(),
    userId: v.string(),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    idToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    refreshTokenExpiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    password: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("accountId", ["accountId"])
    .index("userId", ["userId"]),

  /** Email verification tokens */
  verification: defineTable({
    identifier: v.string(),
    value: v.string(),
    expiresAt: v.number(),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("identifier", ["identifier"]),

  /** Two-factor auth secrets */
  twoFactor: defineTable({
    secret: v.string(),
    backupCodes: v.string(),
    userId: v.string(),
  }).index("userId", ["userId"]),

  /** Organizations */
  organization: defineTable({
    name: v.string(),
    slug: v.string(),
    logo: v.optional(v.string()),
    createdAt: v.number(),
    metadata: v.optional(v.string()),
    // Custom fields from organization plugin schema
    allowedDomains: v.optional(v.array(v.string())),
    autoJoinEnabled: v.optional(v.boolean()),
  }).index("slug", ["slug"]),

  /** Organization members */
  member: defineTable({
    organizationId: v.string(),
    userId: v.string(),
    role: v.string(),
    createdAt: v.number(),
  })
    .index("organizationId", ["organizationId"])
    .index("userId", ["userId"])
    .index("organizationId_userId", ["organizationId", "userId"]),

  /** Organization invitations */
  invitation: defineTable({
    organizationId: v.string(),
    email: v.string(),
    role: v.optional(v.string()),
    status: v.string(),
    expiresAt: v.number(),
    inviterId: v.string(),
  })
    .index("organizationId", ["organizationId"])
    .index("email", ["email"]),

  /** JSON Web Key Sets for Convex token signing */
  jwks: defineTable({
    publicKey: v.string(),
    privateKey: v.string(),
    createdAt: v.number(),
  }),
});

export default schema;
