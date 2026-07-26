/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Rollup correctness for the Precision queries.
 *
 * The cost engine is proven exactly equal to legacy by `costEngine.test.ts`.
 * What that suite cannot see is the layer above it: whether the queries
 * accumulate those per-activity numbers correctly up through phase → WBS →
 * proposal, and whether they honour the D2 rounding policy (accumulate in full
 * precision, round once at the boundary).
 *
 * The rounding assertions here are deliberately built from many small values,
 * because that is the only shape where round-then-sum and sum-then-round
 * disagree. A fixture with two tidy activities would pass under either.
 *
 * @see docs/precision/DECISIONS.md D2
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { computeActivityCosts, round2, type ActivityInput } from "../convex/model/costEngine";
import { seedProposal, type ActivitySpec } from "./convexFixtures";
import { RATES_2020 } from "./rates";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * A spread of activities whose costs do not land on clean cents, so a
 * round-then-sum implementation drifts measurably from sum-then-round.
 */
const AWKWARD: ActivitySpec[] = Array.from({ length: 40 }, (_, i) => ({
  type: "labor" as const,
  quantity: 0.333 + i * 0.01,
  labor: { craftConstant: 1.7777, welderConstant: 0.001 },
}));

/** Expected totals, computed independently through the engine itself. */
function expectedTotals(specs: ActivitySpec[]) {
  let craftManHours = 0;
  let welderManHours = 0;
  let totalCost = 0;
  for (const spec of specs) {
    const costs = computeActivityCosts(spec as ActivityInput, RATES_2020);
    craftManHours += costs.craftManHours;
    welderManHours += costs.welderManHours;
    totalCost += costs.totalCost;
  }
  return { craftManHours, welderManHours, totalCost };
}

describe("phase rollups", () => {
  it("a phase total equals the engine's sum over its activities", async () => {
    const t = convexTest(schema, modules);
    const { wbsByCode } = await seedProposal(t, {
      wbs: [{ poolId: 70000, phases: [{ phaseNumber: 1, activities: AWKWARD }] }],
    });

    const wbsId = wbsByCode.get(70000);
    if (!wbsId) throw new Error("fixture did not seed WBS 70000");

    const phases = await t.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(phases).toHaveLength(1);

    const expected = expectedTotals(AWKWARD);
    const actual = phases[0]?.costs;
    expect(actual).toBeDefined();
    if (!actual) return;

    // Rounded once, at the boundary — so it matches the raw sum rounded, NOT
    // the sum of individually-rounded activity costs.
    expect(actual.totalCost).toBe(round2(expected.totalCost));
    expect(actual.craftManHours).toBe(round2(expected.craftManHours));
    expect(actual.welderManHours).toBe(round2(expected.welderManHours));
  });

  it("accumulates in full precision rather than summing rounded activities", async () => {
    const t = convexTest(schema, modules);
    const { wbsByCode } = await seedProposal(t, {
      wbs: [{ poolId: 70000, phases: [{ phaseNumber: 1, activities: AWKWARD }] }],
    });

    const wbsId = wbsByCode.get(70000);
    if (!wbsId) throw new Error("fixture did not seed WBS 70000");

    const phases = await t.query(api.precision.getPhaseListWithCosts, { wbsId });
    const actual = phases[0]?.costs.totalCost;

    const raw = expectedTotals(AWKWARD).totalCost;
    const roundThenSum = AWKWARD.reduce(
      (sum, spec) =>
        sum + round2(computeActivityCosts(spec as ActivityInput, RATES_2020).totalCost),
      0
    );

    // The fixture is only meaningful if the two policies actually differ here.
    expect(round2(raw)).not.toBe(round2(roundThenSum));
    expect(actual).toBe(round2(raw));
  });
});

describe("WBS and proposal rollups", () => {
  const TREE = {
    wbs: [
      { poolId: 70000, phases: [{ phaseNumber: 1, activities: AWKWARD.slice(0, 20) }] },
      { poolId: 10000, phases: [{ phaseNumber: 1, activities: AWKWARD.slice(20) }] },
    ],
  };

  it("a WBS total equals the engine's sum over its own activities", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, TREE);

    const rows = await t.query(api.precision.getWBSListWithCosts, { proposalId });
    const byCode = new Map(rows.map((r) => [r.wbsPoolId, r]));

    expect(byCode.get(70000)?.costs.totalCost).toBe(
      round2(expectedTotals(AWKWARD.slice(0, 20)).totalCost)
    );
    expect(byCode.get(10000)?.costs.totalCost).toBe(
      round2(expectedTotals(AWKWARD.slice(20)).totalCost)
    );
  });

  it("the proposal summary equals the engine's sum over every activity", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, TREE);

    const summary = await t.query(api.precision.getProposalSummary, { proposalId });
    expect(summary.totalCost).toBe(round2(expectedTotals(AWKWARD).totalCost));
  });

  it("the export grand total ties to the proposal summary", async () => {
    // These are two independent aggregation paths over the same documents. If
    // they disagree, the bid sheet does not tie to the screen — which is exactly
    // the defect the legacy estimator shipped, because its export was a second
    // implementation of the math.
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, TREE);

    const [summary, exported] = await Promise.all([
      t.query(api.precision.getProposalSummary, { proposalId }),
      t.query(api.precision.getExportData, { proposalId }),
    ]);

    expect(exported.totals.totalCost).toBe(summary.totalCost);
    expect(exported.totals.craftManHours).toBe(summary.craftManHours);
  });

  it("the export grand total equals the engine's raw sum, not a sum of rounded WBS totals", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, TREE);

    const exported = await t.query(api.precision.getExportData, { proposalId });

    // The grand total must equal the engine's raw sum rounded once — NOT the
    // sum of the already-rounded per-WBS figures the export also returns.
    // Those two agree on small fixtures and drift apart as WBS count grows,
    // which is why the assertion is against the raw sum rather than against a
    // hand-built "wrong" value that a two-WBS fixture cannot distinguish.
    const raw = expectedTotals(AWKWARD).totalCost;
    expect(exported.totals.totalCost).toBe(round2(raw));

    // And the per-WBS rows are each rounded in their own right.
    for (const wbsRow of exported.wbs) {
      expect(wbsRow.costs.totalCost).toBe(round2(wbsRow.costs.totalCost));
    }
  });
});
