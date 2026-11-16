/**
 * Legacy app-permission functions, kept for installed apps.
 *
 * WHY THIS STILL EXISTS: Momentum ≤ 0.1.13 and Precision ≤ 0.1.4 read and
 * write the old four-level `none|read|write|admin` value through these three
 * functions. Access is now one role plus app access plus item grants
 * (docs/ACCESS.md, `convex/access.ts`), so these translate: reads derive a
 * legacy level from the new model, writes map onto it. New code calls
 * `access.getMyAccess` and `access.setMemberAppAccess` instead.
 *
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { meetsPermissionLevel } from "./model/appPermissionLevels";
import { appAccessFromLegacyWrite, isAdminRole } from "./model/access";
import {
  legacyPermissionsFor,
  readCaller,
  refuseAccess,
  requireActiveUser,
  setAppAccess,
  subjectForMember,
  type AccessSubject,
} from "./model/accessResolve";
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
 * The refusal for a legacy `admin` write.
 *
 * App-level admin no longer exists: administering is the Admin role. An old
 * Members screen still offers the choice, so it is told where the control is.
 */
export const LEGACY_ADMIN_REFUSAL = "Make them an Admin from the Role column instead.";

/** The refusal for setting app access on someone whose role already gives full access. */
export const ADMIN_TARGET_REFUSAL = "Admins have full access.";

/**
 * Assert the caller may READ the app permissions attached to `memberId`, and
 * return that member as an access subject.
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
async function requireSelfOrOrgAdmin(ctx: QueryCtx, memberId: string): Promise<AccessSubject> {
  const user = await requireActiveUser(ctx);

  const membership = await findMemberById(ctx, memberId);
  if (!membership) throw new Error("Member not found.");

  // The membership is the caller's own — no role required to read it.
  if (membership.userId !== user._id) await requireOrgAdmin(ctx, membership.organizationId);

  return subjectForMember(membership);
}

/**
 * Get app permissions for a specific member, as legacy levels.
 *
 * Readable by that member themselves, or by an admin of their organization.
 * Owner/Admin → `admin`; `edit_all` → `write`; `view_all` → `read`;
 * `assigned` → `write`/`read` by the best item they were added to, else
 * `none`; `none` → `none` (docs/ACCESS.md, Compatibility).
 *
 * A suspended caller gets `none` for both instead of a refusal: installed apps
 * run this above every route with no error screen of their own, so throwing
 * would replace the whole app, sign-out included. No access is what they have,
 * and a constant answer says nothing about the member asked about.
 */
export const getMemberPermissions = query({
  args: { memberId: v.string() },
  handler: async (ctx, args) => {
    if ((await readCaller(ctx)).status === "suspended") {
      return { precision: "none" as const, momentum: "none" as const };
    }
    const subject = await requireSelfOrOrgAdmin(ctx, args.memberId);
    const levels = await legacyPermissionsFor(ctx, subject);
    return { precision: levels.precision, momentum: levels.momentum };
  },
});

/**
 * Set app permission for a member from a legacy level.
 *
 * Requires the caller to be an owner or admin of the target's organization.
 * Maps Precision `none/read/write` → `none/view_all/edit_all` and any Momentum
 * level → `assigned`; refuses `admin`, and refuses Owner/Admin targets, whose
 * role already gives full access.
 *
 * WHY THE GUARD MATTERS MOST HERE: unguarded, this mutation let any
 * authenticated account grant ITSELF `admin` on either application — the
 * shortest path from a signed-in stranger to full control of both.
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
    if (isAdminRole(target.role)) throw refuseAccess(ADMIN_TARGET_REFUSAL);

    const access = appAccessFromLegacyWrite(args.app, args.permission);
    if (access === null) throw refuseAccess(LEGACY_ADMIN_REFUSAL);

    await setAppAccess(ctx, target._id, args.app, access);
  },
});

/**
 * Check if a member has at least the required legacy level for an app.
 *
 * Readable by that member themselves, or by an admin of their organization.
 * Answers from the same derivation as {@link getMemberPermissions}.
 */
export const checkPermission = query({
  args: {
    memberId: v.string(),
    app: appValidator,
    requiredPermission: permissionValidator,
  },
  handler: async (ctx, args) => {
    const subject = await requireSelfOrOrgAdmin(ctx, args.memberId);
    const levels = await legacyPermissionsFor(ctx, subject);
    return meetsPermissionLevel(levels[args.app], args.requiredPermission);
  },
});
