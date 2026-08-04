/**
 * duplicateProposal — copy fidelity for the fields that carry meaning.
 *
 * A deep copy that drops a field is the quietest kind of bug: nothing errors,
 * the tree looks right, and the numbers are wrong somewhere downstream. This
 * pins the one that shipped — `countsTowardTakeoff`, the estimator's explicit
 * call on whether a line counts toward the phase takeoff, and the ONLY
 * mechanism a custom line has (see model/takeoff.ts). Losing it changed a
 * revision's takeoff quantities in both directions, and those quantities are
 * what Momentum tracks progress against.
 *
 * `copyActivitiesToPhase` already carries the flag; this mutation did not,
 * which is exactly the sort of divergence between two copy paths worth a test
 * rather than a promise.
 */
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { laborActivity, seedProposal } from "./convexFixtures";
import { RATES_2020 } from "./rates";

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`fixture missing ${label}`);
  return value;
}

describe("duplicateProposal fidelity", () => {
  it("carries each line's explicit takeoff flag into the copy", async () => {
    const { t, as } = await ownerHarness();
    const tree = await seedProposal(t, {
      proposalNumber: "2049",
      rates: RATES_2020,
      wbs: [
        {
          poolId: 70000,
          name: "AG PIPING",
          phases: [
            {
              phaseNumber: 1,
              activities: [
                // Flagged ON by the estimator.
                { ...laborActivity(10), countsTowardTakeoff: true },
                // Flagged OFF — the deliberate exclusion of a line that the
                // catalog would otherwise have counted.
                { ...laborActivity(20), countsTowardTakeoff: false },
                // Never touched: stays undefined so the catalog decides.
                laborActivity(30),
              ],
            },
          ],
        },
      ],
    });

    const copyId = await as.mutation(api.precision.duplicateProposal, {
      sourceProposalId: tree.proposalId,
      newProposalNumber: "2049.R1",
    });

    const wbs = await as.query(api.precision.getWBSForProposal, { proposalId: copyId });
    const phases = await as.query(api.precision.getPhaseListWithCosts, {
      wbsId: must(wbs[0], "copied wbs")._id,
    });
    const copied = await as.query(api.precision.getActivitiesWithCosts, {
      phaseId: must(phases[0], "copied phase")._id,
    });

    expect(copied).toHaveLength(3);
    const byQuantity = new Map(copied.map((a) => [a.quantity, a]));
    expect(must(byQuantity.get(10), "qty 10").countsTowardTakeoff).toBe(true);
    expect(must(byQuantity.get(20), "qty 20").countsTowardTakeoff).toBe(false);
    // Undefined must stay undefined — coercing it to false would silence the
    // catalog, which is the same defect with the opposite sign.
    expect(must(byQuantity.get(30), "qty 30").countsTowardTakeoff).toBeUndefined();
  });
});
