/**
 * App permission queries and mutations.
 *
 * WHY: Replaces the Supabase-based permission system with reactive
 * Convex queries. Permissions auto-update in the UI when changed.
 *
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import {
  findMemberById,
  refuseOwnerTarget,
  requireOrgAdmin,
  requireOrgAdminForMember,
} from "./model/orgAdmin";

const appValidator = v.union(v.literal("precision"), v.literal("momentum"));
const permissionValidator = v.union(
  v.literal("none"),
  v.literal("read"),
  v.literal("write"),
  v.literal("admin")
);

/**
 * Assert the caller may READ the app permissions attached to `memberId`.
 *
 * WHY NOT {@link requireOrgAdmin} ALONE: these reads are not an admin surface.
 * `WorkspaceProvider` runs `getMemberPermissions` for the SIGNED-IN USER on
 * every session in both Momentum and Precision — it is how a member learns what
 * they may open. Requiring the org-admin role here would resolve every plain
 * member's access to "none" and lock them out of both applications entirely.
 *
 * So the rule is self-or-admin: reading your own grants is self-service,
 * reading someone else's is administration.
 */
async function requireSelfOrOrgAdmin(ctx: QueryCtx, memberId: string): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("Not authenticated.");

  const membership = await findMemberById(ctx, memberId);
  if (!membership) throw new Error("Member not found.");

  // The membership is the caller's own — no role required to read it.
  if (membership.userId === user._id) return;

  await requireOrgAdmin(ctx, membership.organizationId);
}

/**
 * Get app permissions for a specific member.
 *
 * Readable by that member themselves, or by an admin of their organization.
 */
export const getMemberPermissions = query({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    await requireSelfOrOrgAdmin(ctx, args.memberId);

    const permissions = await ctx.db
      .query("appPermissions")
      .withIndex("by_member", (q) => q.eq("memberId", args.memberId))
      .collect();

    const result = {
      precision: "none" as string,
      momentum: "none" as string,
    };

    for (const perm of permissions) {
      if (perm.app === "precision") result.precision = perm.permission;
      if (perm.app === "momentum") result.momentum = perm.permission;
    }

    return result;
  },
});

/**
 * Set app permission for a member (upsert).
 *
 * Requires the caller to be an owner or admin of the target's organization.
 *
 * WHY THIS ONE MATTERS MOST: unguarded, this mutation let any authenticated
 * account grant ITSELF `admin` on either application — the shortest path from
 * a signed-in stranger to full control of both.
 */
export const setPermission = mutation({
  args: {
    memberId: v.string(),
    app: appValidator,
    permission: permissionValidator,
  },
  handler: async (ctx, args) => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);
    refuseOwnerTarget(target, "change app access for");

    const existing = await ctx.db
      .query("appPermissions")
      .withIndex("by_member_app", (q) => q.eq("memberId", args.memberId).eq("app", args.app))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { permission: args.permission });
    } else {
      await ctx.db.insert("appPermissions", {
        memberId: args.memberId,
        app: args.app,
        permission: args.permission,
      });
    }
  },
});

/**
 * Check if a user has at least the required permission level for an app.
 *
 * Readable by that member themselves, or by an admin of their organization.
 */
export const checkPermission = query({
  args: {
    memberId: v.string(),
    app: appValidator,
    requiredPermission: permissionValidator,
  },
  handler: async (ctx, args) => {
    await requireSelfOrOrgAdmin(ctx, args.memberId);

    const hierarchy = ["none", "read", "write", "admin"];
    const requiredLevel = hierarchy.indexOf(args.requiredPermission);

    const existing = await ctx.db
      .query("appPermissions")
      .withIndex("by_member_app", (q) => q.eq("memberId", args.memberId).eq("app", args.app))
      .unique();

    const grantedLevel = hierarchy.indexOf(existing?.permission ?? "none");
    return grantedLevel >= requiredLevel;
  },
});
