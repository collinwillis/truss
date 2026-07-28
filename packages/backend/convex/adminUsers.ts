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
import {
  refuseOwnerTarget,
  requireOrgAdmin,
  requireOrgAdminForMember,
  requireOrgMember,
} from "./model/orgAdmin";

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
 *
 * Requires the caller to be an owner or admin of `organizationId`: the row
 * shape includes every colleague's email address.
 */
export const listOrganizationMembers = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    await requireOrgAdmin(ctx, args.organizationId);

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

/**
 * Get a single member's detail view by memberId.
 *
 * Requires the caller to be an owner or admin of the organization the member
 * belongs to. Authorization runs before any read, and a missing member reports
 * the same refusal as an unauthorized one, so neither the response nor the error
 * lets an outsider confirm that a member id exists.
 */
export const getMemberDetail = query({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    await requireOrgAdminForMember(ctx, args.memberId);

    // Re-read the row for display: the authorization helper deliberately models
    // only the fields authorization depends on, so `createdAt` is not on it.
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

/**
 * Names and avatars of an organization's members, for a picker.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link listOrganizationMembers}: assigning a
 * colleague to a project is a Momentum capability, not organization
 * administration — Momentum gates that dialog on `isWorkspaceAdmin`, which is
 * true for an app admin who is a plain org member. Pointing it at the admin
 * roster forced a choice between breaking it for exactly those users and
 * weakening the guard on a query that also carries roles, ban status and app
 * permissions.
 *
 * So this returns only what a picker renders — no role, no ban state, no
 * permissions, no assignment counts — and asks only that the caller belong to
 * the organization. Widening this projection re-creates the problem it solves.
 */
/** Exactly the fields a member picker renders — deliberately nothing more. */
interface PickerMember {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  image?: string;
}

export const listOrganizationMembersForPicker = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.organizationId);

    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "member",
      where: [{ field: "organizationId", value: args.organizationId }],
      paginationOpts: { cursor: null, numItems: 500 },
    });
    const rawMembers = result?.page;

    if (!rawMembers || rawMembers.length === 0) return [];

    // Sequential rather than Promise.all, matching listOrganizationMembers: the
    // adapter is a Convex sub-query and the roster is small (6 members today,
    // capped at 500), so parallelism buys nothing and diverging from the
    // neighbouring implementation costs a reader more than it saves.
    const picks: PickerMember[] = [];
    for (const raw of rawMembers) {
      const member = asMember(raw);

      const rawUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "user",
        where: [{ field: "_id", value: member.userId }],
      });
      const user = rawUser ? asUser(rawUser) : null;

      picks.push({
        memberId: member._id,
        userId: member.userId,
        name: user?.name ?? "Unknown",
        email: user?.email ?? "",
        image: user?.image,
      });
    }

    return picks;
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
 *
 * Requires the caller to be an owner or admin of the target's organization.
 * The owner's role is immutable — demoting them would strand the organization.
 */
export const updateMemberRole = mutation({
  args: {
    memberId: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);
    refuseOwnerTarget(target, "change the role of");

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
 *
 * Requires the caller to be an owner or admin of the target's organization.
 */
export const banMember = mutation({
  args: {
    memberId: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);
    refuseOwnerTarget(target, "ban");

    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: target.userId }],
        update: {
          banned: true,
          banReason: args.reason ?? "Suspended by admin",
        },
      },
    });
  },
});

/**
 * Unban (reactivate) a member.
 *
 * Requires the caller to be an owner or admin of the target's organization.
 *
 * WHY NO OWNER REFUSAL: restoring access is the one action on an owner that
 * cannot strand the organization, and refusing it would make an owner banned by
 * an earlier bug unrecoverable from this screen.
 */
export const unbanMember = mutation({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);

    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: target.userId }],
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
 *
 * Requires the caller to be an owner or admin of the target's organization.
 */
export const removeMember = mutation({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);
    refuseOwnerTarget(target, "remove");

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
      .withIndex("by_user", (q) => q.eq("userId", target.userId))
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
