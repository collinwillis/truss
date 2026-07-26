/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Ordering contracts for the Precision queries.
 *
 * WBS order by their numeric code (`wbsPoolId`), phases by `phaseNumber`. Both
 * used to come from `sortOrder`, which was seeded from the index of a legacy
 * JSON array sorted lexicographically by stringified id — so natively-created
 * estimates rendered their WBS in a nonsense order.
 *
 * Every fixture here seeds `sortOrder` in **conflict** with the domain order
 * (see `convexFixtures.ts`), so an implementation that regressed to `sortOrder`
 * would fail rather than quietly pass.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedProposal, laborActivity } from "./convexFixtures";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * WBS codes in an order where numeric and lexicographic disagree.
 * Lexicographically: 10000, 100000, 300000, 70000. Numerically: 10000, 70000,
 * 100000, 300000. Any implementation sorting the stringified id fails.
 */
const CODES = [300000, 70000, 10000, 100000];
const CODES_IN_NUMERIC_ORDER = [10000, 70000, 100000, 300000];

function treeSpec() {
  return {
    wbs: CODES.map((poolId) => ({
      poolId,
      name: `WBS ${poolId}`,
      phases: [
        { phaseNumber: 30, description: "THIRD" },
        { phaseNumber: 4, description: "FIRST", activities: [laborActivity(10)] },
        { phaseNumber: 12, description: "SECOND" },
      ],
    })),
  };
}

describe("WBS ordering", () => {
  it("getWBSForProposal orders by numeric WBS code, not sortOrder", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, treeSpec());

    const wbs = await t.query(api.precision.getWBSForProposal, { proposalId });

    expect(wbs.map((w) => w.wbsPoolId)).toEqual(CODES_IN_NUMERIC_ORDER);
    // Proves the fixture is adversarial: sortOrder disagrees, so a regression
    // to sortOrder ordering would produce a different array.
    expect(wbs.map((w) => w.sortOrder)).not.toEqual(
      [...wbs.map((w) => w.sortOrder)].sort((a, b) => a - b)
    );
  });

  it("getWBSWithPhasesForNav orders WBS by code and phases by phaseNumber", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, treeSpec());

    const tree = await t.query(api.precision.getWBSWithPhasesForNav, { proposalId });

    expect(tree.map((w) => w.name)).toEqual(CODES_IN_NUMERIC_ORDER.map((c) => `WBS ${c}`));
    for (const wbsNode of tree) {
      expect(wbsNode.phases.map((p) => p.phaseNumber)).toEqual([4, 12, 30]);
    }
  });

  it("getWBSListWithCosts orders by numeric WBS code", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, treeSpec());

    const rows = await t.query(api.precision.getWBSListWithCosts, { proposalId });

    expect(rows.map((r) => r.wbsPoolId)).toEqual(CODES_IN_NUMERIC_ORDER);
  });
});

describe("phase ordering", () => {
  it("getPhaseListWithCosts orders by phaseNumber, not sortOrder", async () => {
    const t = convexTest(schema, modules);
    const { wbsByCode } = await seedProposal(t, treeSpec());

    const wbsId = wbsByCode.get(70000);
    expect(wbsId).toBeDefined();
    if (!wbsId) return;

    const phases = await t.query(api.precision.getPhaseListWithCosts, { wbsId });

    expect(phases.map((p) => p.phaseNumber)).toEqual([4, 12, 30]);
    expect(phases.map((p) => p.description)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("getExportData orders WBS by code and phases by phaseNumber", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedProposal(t, treeSpec());

    const data = await t.query(api.precision.getExportData, { proposalId });

    expect(data.wbs.map((w) => w.wbsPoolId)).toEqual(CODES_IN_NUMERIC_ORDER);
    for (const wbsItem of data.wbs) {
      expect(wbsItem.phases.map((p) => p.phaseNumber)).toEqual([4, 12, 30]);
    }
  });

  it("ties on phaseNumber are stable rather than throwing", async () => {
    // phaseNumber has no uniqueness constraint, so duplicates are reachable.
    const t = convexTest(schema, modules);
    const { wbsByCode } = await seedProposal(t, {
      wbs: [
        {
          poolId: 70000,
          phases: [
            { phaseNumber: 5, description: "A" },
            { phaseNumber: 5, description: "B" },
            { phaseNumber: 1, description: "C" },
          ],
        },
      ],
    });

    const wbsId = wbsByCode.get(70000);
    if (!wbsId) throw new Error("fixture did not seed WBS 70000");

    const phases = await t.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(phases.map((p) => p.phaseNumber)).toEqual([1, 5, 5]);
  });
});
