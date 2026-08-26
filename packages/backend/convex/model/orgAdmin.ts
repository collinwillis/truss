/**
 * Caller authorization for organization-administration functions.
 *
 * WHY THIS EXISTS: every function behind the Admin → Members screen was
 * enforced only in React. An audit of the two modules found that NOT ONE
 * verified the caller may administer the organization:
 *
 *   listOrganizationMembers  nothing
 *   getMemberDetail          nothing
 *   updateMemberRole         authenticated + target-not-owner
 *   banMember                authenticated + target-not-owner
 *   unbanMember              authenticated
 *   removeMember             authenticated + target-not-owner
 *   setPermission            nothing
 *
 * So any authenticated account could read the full roster with emails, ban or
 * remove colleagues, change roles, and — via `setPermission` — grant itself
 * `admin` on either application. The target-not-owner checks limited the blast
 * radius to non-owners; they were never authorization.
 *
 * These helpers make the server the enforcement point. The UI keeps its own
 * checks for affordance (a control you cannot use should not look usable), but
 * the UI is no longer what makes the rule true.
 *
 * @see docs/precision/DECISIONS.md D-orgauthz
 * @module
 */

import { components } from "../_generated/api";
import type { QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";

/** The Better Auth membership rows this module reasons about. */
interface MemberRecord {
  _id: string;
  userId: string;
  organizationId: string;
  role: string;
}

/** Roles permitted to administer an organization's members. */
const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * The single refusal message for every authorization failure on this surface.
 *
 * Deliberately uniform: distinguishing "not a member of this organization" from
 * "a member but not an admin" — or from "no such member" — confirms an
 * organization's existence and the shape of its membership to an outsider.
 */
const ORG_ADMIN_REFUSAL = "Organization admin access required.";

function asMember(record: Record<string, unknown>): MemberRecord {
  return record as unknown as MemberRecord;
}

/**
 * Look up a membership row by its id.
 *
 * Returns `null` rather than throwing so callers can phrase their own
 * "not found" message with the context they have.
 */
export async function findMemberById(
  ctx: QueryCtx,
  memberId: string
): Promise<MemberRecord | null> {
  const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "member",
    where: [{ field: "_id", value: memberId }],
  });
  return raw ? asMember(raw) : null;
}

/**
 * Assert that the caller may administer `organizationId`.
 *
 * WHY IT RESOLVES THE CALLER'S OWN MEMBERSHIP: authentication only proves who
 * someone is. Authorization is a property of their membership IN THIS
 * ORGANIZATION, so a signed-in user who belongs to a different org — or to none
 * — must be refused even though `safeGetAuthUser` succeeds.
 *
 * Returns the caller's membership so a handler can apply further rules (for
 * example, refusing to let an admin act on the owner) without a second lookup.
 */
export async function requireOrgAdmin(
  ctx: QueryCtx,
  organizationId: string
): Promise<MemberRecord> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("Not authenticated.");

  const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "member",
    where: [
      { field: "userId", value: user._id },
      { field: "organizationId", value: organizationId },
    ],
  });

  const caller = raw ? asMember(raw) : null;
  if (!caller || !ADMIN_ROLES.has(caller.role)) {
    throw new Error(ORG_ADMIN_REFUSAL);
  }

  return caller;
}

/**
 * Assert the caller may administer the organization that `memberId` belongs to,
 * and return both memberships.
 *
 * WHY SCOPED TO THE TARGET'S ORG: the member-mutating functions take only a
 * `memberId`. Checking the caller against their own active organization would
 * let an admin of org A act on a member of org B simply by passing that id.
 * Authorization has to be evaluated against the record being changed.
 */
export async function requireOrgAdminForMember(
  ctx: QueryCtx,
  memberId: string
): Promise<{ caller: MemberRecord; target: MemberRecord }> {
  const target = await findMemberById(ctx, memberId);

  // A missing target reports the SAME refusal as an unauthorized one. Throwing
  // "Member not found." here instead would let any authenticated outsider probe
  // whether a member id exists, since the two cases would be distinguishable by
  // message even though neither returns data. Callers that legitimately need to
  // tell the difference are already inside the organization and can use
  // findMemberById directly.
  if (!target) throw new Error(ORG_ADMIN_REFUSAL);

  const caller = await requireOrgAdmin(ctx, target.organizationId);
  return { caller, target };
}

/**
 * Assert the caller belongs to `organizationId`, in any role.
 *
 * WHY A SECOND, WEAKER PREDICATE: reading a colleague's name to pick them from a
 * list is not organization administration. Momentum's assign-to-project dialog
 * needs a roster, and requiring org-admin there would break it for exactly the
 * users it exists to serve — a Momentum app admin who is a plain org member.
 *
 * Pair this with a projection that returns only what a picker needs. Do not use
 * it to widen a query that also carries roles, ban status or permissions.
 */
export async function requireOrgMember(
  ctx: QueryCtx,
  organizationId: string
): Promise<MemberRecord> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("Not authenticated.");

  const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "member",
    where: [
      { field: "userId", value: user._id },
      { field: "organizationId", value: organizationId },
    ],
  });

  if (!raw) throw new Error("Organization membership required.");
  return asMember(raw);
}

/**
 * Refuse an action aimed at the organization owner.
 *
 * WHY SEPARATE FROM {@link requireOrgAdminForMember}: some actions on an owner
 * are legitimate (unbanning) while others are not (banning, demoting, removing,
 * downgrading app access). Callers opt in, and say what they were attempting so
 * the message is actionable.
 */
export function refuseOwnerTarget(target: MemberRecord, attemptedAction: string): void {
  if (target.role === "owner") {
    throw new Error(`Cannot ${attemptedAction} the organization owner.`);
  }
}
