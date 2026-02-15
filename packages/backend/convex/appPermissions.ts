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

const appValidator = v.union(v.literal("precision"), v.literal("momentum"));
const permissionValidator = v.union(
  v.literal("none"),
  v.literal("read"),
  v.literal("write"),
  v.literal("admin")
);

/** Get app permissions for a specific member */
export const getMemberPermissions = query({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
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

/** Set app permission for a member (upsert) */
export const setPermission = mutation({
  args: {
    memberId: v.string(),
    app: appValidator,
    permission: permissionValidator,
  },
  handler: async (ctx, args) => {
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

/** Check if a user has at least the required permission level for an app */
export const checkPermission = query({
  args: {
    memberId: v.string(),
    app: appValidator,
    requiredPermission: permissionValidator,
  },
  handler: async (ctx, args) => {
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
