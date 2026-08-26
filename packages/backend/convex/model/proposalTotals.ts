import { addCosts, computeActivityCosts, emptyCosts } from "./costEngine";
import type { ActivityCosts, ActivityInput, ProposalRates } from "./costEngine";

/**
 * Rolling up an estimate.
 *
 * ONE definition, used by both readers of the number: the estimate screen's
 * summary and the cached total the proposal log reads. They were never going
 * to be written twice without eventually disagreeing — a grand total that
 * differs by a dollar between two screens is the kind of thing that ends
 * arguments about whether the software can be trusted.
 *
 * Pure: the caller does the reading, this does the arithmetic, which is what
 * makes it testable against the legacy reference figures.
 */

export interface ProposalRollup {
  /** Unrounded accumulator — round once, at the edge. */
  costs: ActivityCosts;
  directCraftHours: number;
  directWelderHours: number;
  indirectHours: number;
}

/**
 * Accumulate every activity's cost, splitting hours by WBS classification.
 *
 * `indirectWbsIds` carries the WBS whose hours are indirect. Pass an empty set
 * when only the money matters — the cost total is identical either way, since
 * the split affects only which hour bucket each activity lands in.
 */
export function rollUpProposal(
  activities: readonly (ActivityInput & { wbsId: unknown })[],
  rates: ProposalRates,
  indirectWbsIds: ReadonlySet<string>
): ProposalRollup {
  const costs = emptyCosts();
  let directCraftHours = 0;
  let directWelderHours = 0;
  let indirectHours = 0;

  for (const activity of activities) {
    const activityCosts = computeActivityCosts(activity, rates);
    addCosts(costs, activityCosts);

    if (indirectWbsIds.has(activity.wbsId as string)) {
      indirectHours += activityCosts.craftManHours + activityCosts.welderManHours;
    } else {
      directCraftHours += activityCosts.craftManHours;
      directWelderHours += activityCosts.welderManHours;
    }
  }

  return { costs, directCraftHours, directWelderHours, indirectHours };
}
