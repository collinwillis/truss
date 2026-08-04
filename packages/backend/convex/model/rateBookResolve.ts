import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Which rate book a read should use.
 *
 * ⚠️ THERE IS NO BACKWARD FALLBACK HERE, AND THAT IS THE POINT. The system
 * this replaces resolved a missing pool by silently dropping to the previous
 * version — `if (results.length === 0) return v1Rows`. That branch is why
 * "v2" could exist for two pools out of four and nobody noticed: every read
 * quietly succeeded with the wrong catalog. A book is complete by
 * construction, so an empty result now means a genuine absence and is allowed
 * to look like one.
 */

/** The book new estimates pin to. Exactly one published book carries the flag. */
export async function defaultBookId(ctx: QueryCtx): Promise<Id<"rateBooks">> {
  const book = await ctx.db
    .query("rateBooks")
    .withIndex("by_default", (q) => q.eq("isDefault", true))
    .first();
  if (!book) {
    // Unreachable in a migrated deployment, and worth saying out loud rather
    // than returning something plausible: a wrong catalog prices real bids.
    throw new Error("No default rate book is set. Precision cannot price an estimate without one.");
  }
  return book._id;
}

/**
 * The book this estimate is priced from.
 *
 * TRANSITIONAL `??`: every one of the 736 live proposals was stamped by the
 * foundation migration, so this coalesce is here only for the window in which
 * `proposals.bookId` is still optional in the schema. It resolves to the
 * default book rather than to "some older book", so it can never quietly
 * price an estimate against a catalog nobody chose.
 */
export async function bookIdForProposal(
  ctx: QueryCtx,
  proposal: Pick<Doc<"proposals">, "bookId">
): Promise<Id<"rateBooks">> {
  return proposal.bookId ?? (await defaultBookId(ctx));
}

/** The book for an estimate we only have the id of. */
export async function bookIdForProposalId(
  ctx: QueryCtx,
  proposalId: Id<"proposals">
): Promise<Id<"rateBooks">> {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) throw new Error("Proposal not found");
  return bookIdForProposal(ctx, proposal);
}
