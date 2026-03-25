/**
 * Admin user management queries and mutations.
 *
 * WHY: The admin panel needs composite views that join Better Auth
 * member/user data with Convex app permissions and project assignments
 * into unified display models for the members table.
 *
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { authComponent } from "./auth";

// ============================================================================
// ADAPTER RECORD SHAPES
// ============================================================================

/**
 * Shape of a Better Auth user record from the adapter.
 *
 * WHY: The adapter returns `Record<string, unknown>`. Declaring explicit
 * shapes avoids scattered `any` casts throughout queries and mutations.
 */
interface AuthUserRecord {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
  banned?: boolean;
  banReason?: string;
}

/** Shape of a Better Auth member record from the adapter. */
interface AuthMemberRecord {
  _id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt?: number;
}

/** Type-safe cast for adapter query results. */
function asUser(record: Record<string, unknown>): AuthUserRecord {
  return record as unknown as AuthUserRecord;
}

/** Type-safe cast for adapter query results. */
function asMember(record: Record<string, unknown>): AuthMemberRecord {
  return record as unknown as AuthMemberRecord;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * List all organization members with their app permissions and project
 * assignment counts.
 *
 * WHY: The admin table needs a single query that returns everything needed
 * to render each row — user details, org role, ban status, app permissions,
 * and assignment counts — without N+1 waterfalls on the client.
 */
export const listOrganizationMembers = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    // Fetch all members of the organization from Better Auth
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "member",
      where: [{ field: "organizationId", value: args.organizationId }],
      paginationOpts: { cursor: null, numItems: 500 },
    });
    const rawMembers = result?.page;

    if (!rawMembers || rawMembers.length === 0) return [];

    const results = [];

    for (const raw of rawMembers) {
      const member = asMember(raw);
      const memberId = member._id;
      const userId = member.userId;

      // Fetch user details from Better Auth
      let user: AuthUserRecord | null = null;
      try {
        const rawUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", value: userId }],
        });
        user = rawUser ? asUser(rawUser) : null;
      } catch {
        continue;
      }

      if (!user) continue;

      // Fetch app permissions from Convex
      const permissions = await ctx.db
        .query("appPermissions")
        .withIndex("by_member", (q) => q.eq("memberId", memberId))
        .collect();

      let precisionPerm = "none";
      let momentumPerm = "none";
      for (const perm of permissions) {
        if (perm.app === "precision") precisionPerm = perm.permission;
        if (perm.app === "momentum") momentumPerm = perm.permission;
      }

      // Count project assignments
      const assignments = await ctx.db
        .query("projectAssignments")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();

      results.push({
        memberId,
        userId,
        name: user.name ?? "",
        email: user.email ?? "",
        image: user.image ?? undefined,
        orgRole: member.role ?? "member",
        isBanned: user.banned === true,
        banReason: user.banReason ?? undefined,
        createdAt: member.createdAt
          ? new Date(member.createdAt).toISOString()
          : new Date().toISOString(),
        appPermissions: {
          precision: precisionPerm,
          momentum: momentumPerm,
        },
        projectAssignmentCount: assignments.length,
      });
    }

    return results;
  },
});

/** Get a single member's detail view by memberId. */
export const getMemberDetail = query({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    const rawMember = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "member",
      where: [{ field: "_id", value: args.memberId }],
    });

    if (!rawMember) return null;
    const member = asMember(rawMember);
    const userId = member.userId;

    const rawUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: userId }],
    });

    if (!rawUser) return null;
    const user = asUser(rawUser);

    // Fetch app permissions
    const permissions = await ctx.db
      .query("appPermissions")
      .withIndex("by_member", (q) => q.eq("memberId", args.memberId))
      .collect();

    let precisionPerm = "none";
    let momentumPerm = "none";
    for (const perm of permissions) {
      if (perm.app === "precision") precisionPerm = perm.permission;
      if (perm.app === "momentum") momentumPerm = perm.permission;
    }

    // Count project assignments
    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return {
      memberId: args.memberId,
      userId,
      name: user.name ?? "",
      email: user.email ?? "",
      image: user.image ?? undefined,
      orgRole: member.role ?? "member",
      isBanned: user.banned === true,
      banReason: user.banReason ?? undefined,
      createdAt: member.createdAt
        ? new Date(member.createdAt).toISOString()
        : new Date().toISOString(),
      appPermissions: {
        precision: precisionPerm,
        momentum: momentumPerm,
      },
      projectAssignmentCount: assignments.length,
    };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Update a member's organization role.
 *
 * WHY: Admins need to promote/demote members. Updates the Better Auth
 * member record directly via the adapter.
 */
export const updateMemberRole = mutation({
  args: {
    memberId: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const currentUser = await authComponent.safeGetAuthUser(ctx);
    if (!currentUser) throw new Error("Not authenticated.");

    const rawMember = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "member",
      where: [{ field: "_id", value: args.memberId }],
    });

    if (!rawMember) throw new Error("Member not found.");
    const member = asMember(rawMember);
    if (member.role === "owner") {
      throw new Error("Cannot change the organization owner's role.");
    }

    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "member",
        where: [{ field: "_id", value: args.memberId }],
        update: { role: args.role },
      },
    });
  },
});

/**
 * Ban (suspend) a member.
 *
 * WHY: Admins can temporarily revoke access without removing the member.
 * Uses Better Auth's user.banned field.
 */
export const banMember = mutation({
  args: {
    memberId: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await authComponent.safeGetAuthUser(ctx);
    if (!currentUser) throw new Error("Not authenticated.");

    const rawMember = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "member",
      where: [{ field: "_id", value: args.memberId }],
    });

    if (!rawMember) throw new Error("Member not found.");
    const member = asMember(rawMember);
    if (member.role === "owner") {
      throw new Error("Cannot ban the organization owner.");
    }

    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: member.userId }],
        update: {
          banned: true,
          banReason: args.reason ?? "Suspended by admin",
        },
      },
    });
  },
});

/** Unban (reactivate) a member. */
export const unbanMember = mutation({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    const currentUser = await authComponent.safeGetAuthUser(ctx);
    if (!currentUser) throw new Error("Not authenticated.");

    const rawMember = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "member",
      where: [{ field: "_id", value: args.memberId }],
    });

    if (!rawMember) throw new Error("Member not found.");
    const member = asMember(rawMember);

    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: member.userId }],
        update: {
          banned: false,
          banReason: undefined,
        },
      },
    });
  },
});

/**
 * Remove a member from the organization.
 *
 * WHY: Permanently removes a member and cleans up their app permissions
 * and project assignments.
 */
export const removeMember = mutation({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    const currentUser = await authComponent.safeGetAuthUser(ctx);
    if (!currentUser) throw new Error("Not authenticated.");

    const rawMember = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "member",
      where: [{ field: "_id", value: args.memberId }],
    });

    if (!rawMember) throw new Error("Member not found.");
    const member = asMember(rawMember);
    if (member.role === "owner") {
      throw new Error("Cannot remove the organization owner.");
    }

    // Clean up app permissions
    const permissions = await ctx.db
      .query("appPermissions")
      .withIndex("by_member", (q) => q.eq("memberId", args.memberId))
      .collect();

    for (const perm of permissions) {
      await ctx.db.delete(perm._id);
    }

    // Clean up project assignments
    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_user", (q) => q.eq("userId", member.userId))
      .collect();

    for (const assignment of assignments) {
      await ctx.db.delete(assignment._id);
    }

    // Delete the member record
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: {
        model: "member",
        where: [{ field: "_id", value: args.memberId }],
      },
    });
  },
});
