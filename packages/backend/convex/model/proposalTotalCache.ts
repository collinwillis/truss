import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Keeping a proposal's cached grand total honest.
 *
 * The total lives in the activities, but the proposal log needs it for every
 * row at once — summing on read would touch over 200,000 documents in a
 * single query. So it is maintained on write, and this module owns the one
 * rule that makes that safe: ANY mutation that can change what an estimate
 * costs must invalidate it here.
 *
 * It lives in `model/` rather than beside the mutations because the Firestore
 * sync has to call it too, and a second copy of this logic in the sync file
 * is precisely how the number would start lying on one path and not the
 * other.
 */

/**
 * How long a proposal's total may lag an edit to it.
 *
 * Every cost-bearing write CANCELS the pending recompute and queues a fresh
 * one, so a burst of quantity edits costs a single rollup two seconds after
 * the estimator stops typing rather than one per keystroke. Recomputing
 * inline instead would mean re-reading every activity of the estimate on
 * every cell commit — exactly the fast-entry feel the grid exists to protect.
 */
const TOTAL_RECOMPUTE_DEBOUNCE_MS = 2_000;

/**
 * Mark a proposal's cached total out of date and queue the rollup.
 *
 * MUST be called by every mutation that can change what an estimate costs.
 * That list is not obvious from any single call site, so it is written down
 * here: activities (add, update, batch delete, copy, duplicate-phase), the
 * cascades that take activities with them (delete phase, delete WBS), the
 * rates (one change re-prices every line), a duplicated proposal (a new
 * estimate with no total of its own), and the Firestore sync, which rewrites
 * a proposal's activities wholesale.
 *
 * Deliberately tolerant of a missing proposal: one just deleted is not an
 * error, it simply has nothing left to total.
 */
export async function invalidateProposalTotal(
  ctx: MutationCtx,
  proposalId: Id<"proposals">
): Promise<void> {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) return;

  // Cancelling a job that has already run is a documented no-op, so this
  // needs no race handling — it either debounces a pending rollup or does
  // nothing at all.
  if (proposal.costTotalJob) await ctx.scheduler.cancel(proposal.costTotalJob);

  const costTotalJob = await ctx.scheduler.runAfter(
    TOTAL_RECOMPUTE_DEBOUNCE_MS,
    internal.precision.recomputeProposalTotal,
    { proposalId }
  );
  await ctx.db.patch(proposalId, { costTotalJob });
}
