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

/** One breakdown's slice of the estimate, unrounded. */
export interface WbsRollup {
  totalCost: number;
  /** Craft and welder hours together. */
  hours: number;
}

export interface ProposalRollup {
  /** Unrounded accumulator — round once, at the edge. */
  costs: ActivityCosts;
  directCraftHours: number;
  directWelderHours: number;
  indirectHours: number;
  /**
   * Cost and hours per WBS id.
   *
   * WHY HERE rather than in a second loop at the caller: the summary needs to
   * say how many hours each KIND of indirect work holds and how much cost sits
   * in hidden breakdowns, and both are per-WBS sums. Costing every activity a
   * second time to get them would double the CPU of a query that already reads
   * 11,000 documents on the largest estimate.
   */
  byWbs: Map<string, WbsRollup>;
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
  const byWbs = new Map<string, WbsRollup>();

  for (const activity of activities) {
    const activityCosts = computeActivityCosts(activity, rates);
    addCosts(costs, activityCosts);

    const wbsKey = activity.wbsId as string;
    const hours = activityCosts.craftManHours + activityCosts.welderManHours;
    const slice = byWbs.get(wbsKey);
    if (slice) {
      slice.totalCost += activityCosts.totalCost;
      slice.hours += hours;
    } else {
      byWbs.set(wbsKey, { totalCost: activityCosts.totalCost, hours });
    }

    if (indirectWbsIds.has(wbsKey)) {
      indirectHours += hours;
    } else {
      directCraftHours += activityCosts.craftManHours;
      directWelderHours += activityCosts.welderManHours;
    }
  }

  return { costs, directCraftHours, directWelderHours, indirectHours, byWbs };
}
