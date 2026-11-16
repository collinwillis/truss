/**
 * Caller authorization for Precision: the app, one estimate, and the rate books.
 *
 * A thin layer over `accessResolve.ts`, which applies the rules of
 * docs/ACCESS.md. What this module adds is the Precision shape of them:
 *
 *   requirePrecisionApp     opening Precision, reading the published catalog
 *   requireProposal         one estimate, keyed by its id
 *   requireProposalPart     one estimate, keyed by a WBS, phase or activity in it
 *   requireStartEstimate /  starting an estimate, then the creator's Can edit
 *     grantCreator
 *   requirePrecisionAdmin   rate books and draft catalogs: Owner or Admin only
 *
 * WHY EVERY FUNCTION CHECKS ITS ESTIMATE: an "Only assigned" estimator may
 * open Precision and see two estimates out of seven hundred. An app-level
 * check would hand them the other 698 through any function keyed by a phase
 * or activity id, so each one resolves the estimate it touches first.
 *
 * GUARD BEFORE LOOKUP: the app gate runs before any read, and a missing id is
 * refused exactly like one the caller may not see, so no refusal is an
 * existence oracle. Callers who see every estimate get the handler's own
 * "not found", which tells them nothing they could not already list.
 *
 * @see docs/ACCESS.md
 * @module
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  itemLevelFor,
  meetsItemLevel,
  type EffectiveAppAccess,
  type GrantLevel,
  type ItemLevel,
} from "./access";
import {
  ITEM_REFUSAL,
  VIEW_ONLY_REFUSAL,
  grantOn,
  refuseAccess,
  requireApp,
  requireOwnerOrAdmin,
  requireStartEstimate as requireStartEstimateAccess,
  writeGrant,
  type AccessCaller,
} from "./accessResolve";

/** Contexts these guards read from. */
type ReadCtx = QueryCtx | MutationCtx;

/** The caller, past Precision's access wall. */
export interface PrecisionCaller {
  /** The caller's Better Auth user id. */
  userId: string;
  /** Their Precision access; `full` for an Owner or Admin. Never `none`. */
  appAccess: EffectiveAppAccess;
  /** The membership they act through, for writers that need it. */
  caller: AccessCaller;
}

/** The caller and what they may do with one estimate. */
export interface ProposalAccess extends PrecisionCaller {
  /** `full`, `edit` or `view` — never below what was required. */
  level: ItemLevel;
}

/** The tables whose rows belong to exactly one estimate. */
export type EstimatePart = "wbs" | "phases" | "activities";

/**
 * Whether this caller sees every estimate, so a missing id may be named as
 * missing. Everyone else ("Only assigned") gets the item refusal for it.
 */
export function seesEveryEstimate(appAccess: EffectiveAppAccess): boolean {
  return appAccess !== "assigned";
}

/**
 * Assert the caller may open Precision at all.
 *
 * For app-wide reads: the published catalog, the default book. An "Only
 * assigned" member passes even with no estimates yet, because starting one is
 * how they get work into the system. Refusals: not authenticated (plain
 * Error), suspended, then "Precision access required." for No access and for
 * a signed-in non-member.
 */
export async function requirePrecisionApp(ctx: ReadCtx): Promise<PrecisionCaller> {
  const { caller, appAccess } = await requireApp(ctx, "precision");
  return { userId: caller.userId, appAccess, caller };
}

/**
 * The caller's level on one estimate, refusing below `needed`.
 *
 * Reads the grant only when app access leaves the answer open: an Owner,
 * Admin or Can edit all member is decided without a read, which is every call
 * on the hot screens for most of the company.
 */
async function levelOn(
  ctx: ReadCtx,
  who: PrecisionCaller,
  proposalId: Id<"proposals">,
  needed: GrantLevel
): Promise<ItemLevel> {
  const grant =
    who.appAccess === "assigned" || who.appAccess === "view_all"
      ? await grantOn(ctx, who.userId, { proposalId })
      : undefined;
  const level = itemLevelFor(who.appAccess, grant);
  if (level === null) throw refuseAccess(ITEM_REFUSAL.precision);
  if (!meetsItemLevel(level, needed)) throw refuseAccess(VIEW_ONLY_REFUSAL.precision);
  return level;
}

/**
 * Assert the caller may view or edit one estimate, before it is read.
 *
 * `who` lets a handler that touches two estimates (a copy, a duplicate)
 * resolve the caller once; omit it otherwise.
 */
export async function requireProposal(
  ctx: ReadCtx,
  proposalId: Id<"proposals">,
  needed: GrantLevel,
  who?: PrecisionCaller
): Promise<ProposalAccess> {
  const caller = who ?? (await requirePrecisionApp(ctx));
  const level = await levelOn(ctx, caller, proposalId, needed);
  return { ...caller, level };
}

/**
 * Assert the caller may view or edit the estimate a WBS, phase or activity
 * belongs to, and return that row.
 *
 * The row is read after the app gate and before the estimate check, because
 * it is the only way to learn which estimate it is in; nothing from it is
 * returned until the check passes. A missing row is `notFound` for callers who
 * see every estimate and the item refusal for everyone else, so an "Only
 * assigned" member cannot probe ids.
 */
export async function requireProposalPart<T extends EstimatePart>(
  ctx: ReadCtx,
  table: T,
  id: Id<T>,
  needed: GrantLevel,
  notFound: string,
  who?: PrecisionCaller
): Promise<{ access: ProposalAccess; doc: Doc<T> }> {
  const caller = who ?? (await requirePrecisionApp(ctx));
  const doc = await ctx.db.get(table, id);
  if (!doc) {
    if (seesEveryEstimate(caller.appAccess)) throw new Error(notFound);
    throw refuseAccess(ITEM_REFUSAL.precision);
  }
  const level = await levelOn(ctx, caller, doc.proposalId, needed);
  return { access: { ...caller, level }, doc };
}

/**
 * Assert the caller may start a new estimate: full, Can edit all, or Only
 * assigned. Can view all is refused — it is the read-only setting.
 *
 * The handler must then stamp `createdBy` and call {@link grantCreator}, or an
 * "Only assigned" estimator loses sight of the estimate they just started.
 */
export async function requireStartEstimate(ctx: ReadCtx): Promise<PrecisionCaller> {
  const { caller, appAccess } = await requireStartEstimateAccess(ctx);
  return { userId: caller.userId, appAccess, caller };
}

/**
 * Give an "Only assigned" creator Can edit on the estimate they just started,
 * in the same transaction as the insert.
 *
 * Only for `assigned`: everyone else who may start an estimate already edits
 * every one, and a grant for them would only clutter the Share panel.
 */
export async function grantCreator(
  ctx: MutationCtx,
  who: PrecisionCaller,
  proposalId: Id<"proposals">
): Promise<void> {
  if (who.appAccess !== "assigned") return;
  await writeGrant(ctx, {
    item: { proposalId },
    userId: who.userId,
    level: "edit",
    grantedBy: who.userId,
  });
}

/**
 * Assert the caller may administer the rate books: an organization Owner or
 * Admin, and nobody else.
 *
 * WHY THE LEGACY PRECISION `admin` NO LONGER COUNTS: it meant "administrator of
 * this app", which is now the Admin role, and the spec has no member setting
 * above Can edit all. In production every such grant sits on an org admin, so
 * nobody loses anything; a plain member holding one keeps Can edit all.
 *
 * Returns the caller so writers can stamp who held a lock or published.
 */
export async function requirePrecisionAdmin(ctx: ReadCtx): Promise<AccessCaller> {
  return requireOwnerOrAdmin(ctx);
}
