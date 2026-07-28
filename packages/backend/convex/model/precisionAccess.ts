/**
 * Caller authorization for the Precision estimation functions.
 *
 * WHY THIS EXISTS: all 31 exported functions in `precision.ts` — 15 queries and
 * 16 mutations — had no caller check of any kind. `listProposals` was an
 * unfiltered `.collect()` that handed every one of the 713 real InDemand bids,
 * with their rates, costs and client names, to any caller that could reach the
 * deployment. Every mutation was equally open: create, edit, delete.
 *
 * The other half of the hole was that nothing in `apps/precision/src` reads
 * `precision_permission` either, so the permission model stored in
 * `appPermissions` was decorative on BOTH ends. Nothing enforced it anywhere.
 * These helpers make the server the enforcement point.
 *
 * ⚠️ THIS IS A REAL CAPABILITY CHANGE, not the tightening of a rule the client
 * already applied. A member holding Precision `read` can create, edit and delete
 * today; once these guards land they cannot. That is the stored intent finally
 * taking effect — but it IS a change, and it is deliberate.
 *
 * @see docs/precision/DECISIONS.md D-precisionauthz
 * @module
 */

import { components } from "../_generated/api";
import type { QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";

/** An app permission level. Ordered by {@link PRECISION_LEVEL_ORDER}. */
export type PrecisionLevel = "none" | "read" | "write" | "admin";

/** The caller's identity together with what they may do in Precision. */
export interface PrecisionAccess {
  /** The caller's Better Auth user id. */
  userId: string;
  /** The caller's effective Precision level. */
  level: PrecisionLevel;
}

/**
 * The permission ordering, least capable first.
 *
 * WHY IT IS RESTATED RATHER THAN IMPORTED: the source of truth is
 * `PERMISSION_HIERARCHY` in `packages/features/src/organizations/permissions.ts`,
 * which the client uses — but `@truss/features` already depends on
 * `@truss/backend`, so importing it here would close a dependency cycle. This is
 * a mirror of that array and must stay identical to it; a second, divergent
 * ordering is the failure mode to avoid, not a second copy of four strings.
 */
const PRECISION_LEVEL_ORDER: readonly PrecisionLevel[] = ["none", "read", "write", "admin"];

/** Organization roles that carry full app access without an explicit grant. */
const ORG_ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * The refusal for a caller who may not read Precision data.
 *
 * Deliberately uniform across every query and every record: a message that
 * distinguished "no such proposal" from "you may not see that proposal" would
 * make the refusal itself a lookup oracle for proposal ids. Every guard runs
 * BEFORE the first `ctx.db.get` for the same reason.
 */
const PRECISION_READ_REFUSAL = "Precision access required.";

/**
 * The refusal for a caller who may read but not write.
 *
 * WHY IT IS A DIFFERENT MESSAGE: it names a capability, never a record, so it
 * leaks nothing — and telling a view-only estimator "Precision access required"
 * when they plainly have access would send them to an administrator to fix
 * something that is not broken.
 */
const PRECISION_WRITE_REFUSAL = "Precision edit access required.";

/**
 * Refusal for a caller with no identity at all.
 *
 * WHY IT IS NOT THE SAME AS A PERMISSION REFUSAL: "we do not know who you are"
 * and "we know who you are and the answer is no" are different conditions with
 * different remedies — sign in, versus ask an administrator for access. The
 * client cannot pick the right recovery from a single message.
 */
const NOT_AUTHENTICATED = "Not authenticated.";

/** The Better Auth membership rows this module reasons about. */
interface MemberRecord {
  _id: string;
  /** The adapter surfaces this on some paths; see {@link permissionForMember}. */
  id?: string;
  userId: string;
  organizationId: string;
  role: string;
}

function asMember(record: Record<string, unknown>): MemberRecord {
  return record as unknown as MemberRecord;
}

/**
 * Whether `granted` satisfies `required` under the shared hierarchy.
 *
 * Exported so a handler needing a finer rule than read/write asks the same
 * question the guards ask, rather than comparing strings its own way.
 */
export function meetsPrecisionLevel(granted: PrecisionLevel, required: PrecisionLevel): boolean {
  return PRECISION_LEVEL_ORDER.indexOf(granted) >= PRECISION_LEVEL_ORDER.indexOf(required);
}

/**
 * The Precision grant attached to one membership row, or `none`.
 *
 * WHY BOTH `_id` AND `id` ARE TRIED: `appPermissions.memberId` is written from
 * the member id the client passes as `currentMember.id`, while the adapter
 * surfaces `_id` on raw rows. Matching only one of them would silently resolve a
 * granted member to `none` — a lockout, not a leak, but a lockout in the
 * application's own data. `projectAssignments.isMomentumAdmin` hedges the same
 * way for the same reason.
 */
async function permissionForMember(ctx: QueryCtx, member: MemberRecord): Promise<PrecisionLevel> {
  let level: PrecisionLevel = "none";

  for (const memberId of [member._id, member.id]) {
    if (typeof memberId !== "string") continue;

    const row = await ctx.db
      .query("appPermissions")
      .withIndex("by_member_app", (q) => q.eq("memberId", memberId).eq("app", "precision"))
      .first();

    if (row && meetsPrecisionLevel(row.permission, level)) level = row.permission;
  }

  return level;
}

/**
 * Resolve who the caller is and what they may do in Precision.
 *
 * ⚠️ THE ORG-ROLE BRANCH IS A LOCKOUT GUARD, NOT A CONVENIENCE. The production
 * owner has NO `appPermissions` row at all: `workspace-context.tsx` hardcodes
 * `owner` to `admin` on both apps and never queries permissions for them, so one
 * was never written. Resolving that account from the table alone returns `none`
 * and locks the owner out of their own product. Org `admin` takes the same
 * branch, matching the client.
 *
 * WHY UNAUTHENTICATED THROWS instead of resolving to `none`: absence of identity
 * is not a permission level. Collapsing the two would report "ask an
 * administrator for access" to someone whose session merely expired.
 *
 * WHY MEMBERSHIP IS NOT SCOPED TO ONE ORGANIZATION: `proposals` carries no
 * `organizationId`, and `auth.ts` pins every session to the single InDemand org,
 * so there is no second tenant for a role to be evaluated against. Org scoping is
 * deferred deliberately — it needs a schema field plus a backfill of 713 rows,
 * and whether Truss is ever multi-tenant is an open product question (D17).
 */
export async function resolvePrecisionAccess(ctx: QueryCtx): Promise<PrecisionAccess> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error(NOT_AUTHENTICATED);

  const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "member",
    where: [{ field: "userId", value: user._id }],
    paginationOpts: { cursor: null, numItems: 50 },
  });
  const members = ((result?.page ?? []) as Array<Record<string, unknown>>).map(asMember);

  if (members.some((member) => ORG_ADMIN_ROLES.has(member.role))) {
    return { userId: user._id, level: "admin" };
  }

  let level: PrecisionLevel = "none";
  for (const member of members) {
    const granted = await permissionForMember(ctx, member);
    if (meetsPrecisionLevel(granted, level)) level = granted;
  }

  return { userId: user._id, level };
}

/**
 * Assert the caller may read Precision data.
 *
 * Applies to every query, including the four reference-catalog pool queries:
 * a WBS/phase/labor/equipment catalog is not an estimate, but it still describes
 * the company's own cost structure and belongs to the same customer.
 *
 * Returns the resolved access so a handler can apply a further rule without a
 * second round trip.
 */
export async function requirePrecisionRead(ctx: QueryCtx): Promise<PrecisionAccess> {
  const access = await resolvePrecisionAccess(ctx);
  if (!meetsPrecisionLevel(access.level, "read")) throw new Error(PRECISION_READ_REFUSAL);
  return access;
}

/**
 * Assert the caller may modify Precision data.
 *
 * Applies to every mutation. Estimate mutations cascade — `deleteProposal`
 * removes an entire tree — so "can open the app" was never the right bar for
 * them.
 */
export async function requirePrecisionWrite(ctx: QueryCtx): Promise<PrecisionAccess> {
  const access = await resolvePrecisionAccess(ctx);
  if (!meetsPrecisionLevel(access.level, "write")) throw new Error(PRECISION_WRITE_REFUSAL);
  return access;
}
