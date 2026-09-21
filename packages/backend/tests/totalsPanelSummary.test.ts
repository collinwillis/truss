/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * What the totals panel reads beyond the cost roll-up itself.
 *
 * The roll-up is proven by `precisionRollups.test.ts`. These guard the lines an
 * estimator reviews a bid by: indirect hours by kind, the cost sitting in hidden
 * breakdowns, and phase progress. Each is asserted against the summary's own
 * totals rather than a hand-typed number, because the property that matters is
 * that the parts and the whole can never tell two stories.
 */

import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { ensureTestBook, laborActivity, seedProposal } from "./convexFixtures";
import { RATES_2020 } from "./rates";

/** One estimate with direct work, all four indirect codes, and mixed progress. */
async function seedBid() {
  const { t, as } = await ownerHarness();
  const tree = await seedProposal(t, {
    proposalNumber: "2060",
    rates: RATES_2020,
    wbs: [
      {
        poolId: 10000,
        name: "MOBILIZE",
        phases: [{ phaseNumber: 10001, activities: [laborActivity(10)] }],
      },
      {
        poolId: 190000,
        name: "DEMOBILIZE",
        phases: [{ phaseNumber: 190001, activities: [laborActivity(6)] }],
      },
      {
        poolId: 200000,
        name: "SUPPORT",
        phases: [{ phaseNumber: 200001, activities: [laborActivity(40)] }],
      },
      {
        poolId: 180000,
        name: "SPECIALTY SERVICES",
        phases: [{ phaseNumber: 180001, activities: [laborActivity(4)] }],
      },
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [
          { phaseNumber: 70001, isCompleted: true, activities: [laborActivity(100)] },
          { phaseNumber: 70002, activities: [laborActivity(50)] },
        ],
      },
      {
        poolId: 110000,
        name: "PAINTING",
        phases: [{ phaseNumber: 110001, activities: [laborActivity(20)] }],
      },
      { poolId: 120000, name: "DISMANTLING", phases: [{ phaseNumber: 120001, activities: [] }] },
    ],
  });
  return { t, as, tree };
}

describe("getProposalSummary — the totals panel's lines", () => {
  it("splits indirect hours by kind, and the kinds add up to the indirect total", async () => {
    const { as, tree } = await seedBid();
    const summary = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });

    const byKind = summary.indirectHoursByKind;
    // 0.55 MH per unit: mobilize 10 + demobilize 6 read together, as legacy did.
    expect(byKind.mobilization).toBeCloseTo(16 * 0.55, 6);
    expect(byKind.support).toBeCloseTo(40 * 0.55, 6);
    expect(byKind.specialty).toBeCloseTo(4 * 0.55, 6);

    // The property that matters: the parts are the whole.
    expect(byKind.mobilization + byKind.support + byKind.specialty).toBeCloseTo(
      summary.indirectHours,
      6
    );
    expect(summary.directHours + summary.indirectHours).toBeCloseTo(summary.totalHours, 6);
  });

  it("counts completed phases", async () => {
    const { as, tree } = await seedBid();
    const summary = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });
    expect(summary.completedPhaseCount).toBe(1);
    expect(summary.phaseCount).toBe(8);
  });

  it("reports the cost held in hidden breakdowns, and leaves the total alone", async () => {
    const { as, tree } = await seedBid();
    const before = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });
    expect(before.hiddenWbsCount).toBe(0);
    expect(before.hiddenCost).toBe(0);

    const painting = tree.wbsByCode.get(110000);
    const dismantling = tree.wbsByCode.get(120000);
    if (!painting || !dismantling) throw new Error("fixture: WBS missing");
    await as.mutation(api.precision.setWBSHidden, { wbsId: painting, hidden: true });
    // Hidden AND empty: decluttering the rail, nothing to warn about.
    await as.mutation(api.precision.setWBSHidden, { wbsId: dismantling, hidden: true });

    const after = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });
    expect(after.hiddenWbsCount).toBe(1);
    expect(after.hiddenCost).toBeGreaterThan(0);
    // Hiding is navigation. It must never move the bid.
    expect(after.totalCost).toBe(before.totalCost);

    // The hidden figure is that breakdown's own total, not an estimate of it.
    const rows = await as.query(api.precision.getWBSListWithCosts, {
      proposalId: tree.proposalId,
    });
    const paintingRow = rows.find((row) => row._id === painting);
    expect(after.hiddenCost).toBe(paintingRow?.costs.totalCost);
  });
});

describe("getWBSForProposal", () => {
  it("says which breakdowns are indirect work", async () => {
    const { as, tree } = await seedBid();
    const rows = await as.query(api.precision.getWBSForProposal, {
      proposalId: tree.proposalId,
    });
    const indirect = rows.filter((row) => row.isIndirect).map((row) => row.wbsPoolId);
    expect(indirect.sort((a, b) => a - b)).toEqual([10000, 180000, 190000, 200000]);
  });
});

describe("getPhaseTakeoffCatalog", () => {
  it("returns the phase type's unit and the labor lines that count toward it", async () => {
    const { t, as } = await ownerHarness();
    const bookId = await t.run(async (ctx) => {
      const id = await ensureTestBook(ctx);
      await ctx.db.insert("phasePool", {
        datasetVersion: "v1",
        bookId: id,
        poolId: 30001,
        wbsPoolId: 30000,
        name: "EQUIPMENT FOUNDATIONS",
        sortOrder: 1,
        isCustom: false,
        isActive: true,
        takeoffUnit: "CY",
      });
      const line = {
        datasetVersion: "v1" as const,
        bookId: id,
        phasePoolId: 30001,
        craftConstant: 1,
        craftUnits: "CY",
        weldConstant: 0,
        weldUnits: "",
        isCustom: false,
        isActive: true,
      };
      await ctx.db.insert("laborPool", {
        ...line,
        poolId: 101,
        description: "POUR",
        sortOrder: 101,
        countsTowardTakeoff: true,
      });
      // Carries the same unit and must NOT count: this is the 2x double-count
      // the flags exist to prevent.
      await ctx.db.insert("laborPool", {
        ...line,
        poolId: 104,
        description: "CLEAN UP",
        sortOrder: 104,
      });
      return id;
    });

    const catalog = await as.query(api.precision.getPhaseTakeoffCatalog, {
      bookId,
      phasePoolId: 30001,
    });
    expect(catalog.takeoffUnit).toBe("CY");
    expect(catalog.flaggedLaborPoolIds).toEqual([101]);

    // A phase type the book has never heard of has no takeoff, not an error.
    const unknown = await as.query(api.precision.getPhaseTakeoffCatalog, {
      bookId,
      phasePoolId: 99999,
    });
    expect(unknown.takeoffUnit).toBeNull();
    expect(unknown.flaggedLaborPoolIds).toEqual([]);
  });
});

describe("a takeoff flag belongs to its phase type", () => {
  /**
   * Measured on production: 7% of flagged lines sit in a phase of a different
   * type than the one that flags them, such as an offload line copied into a
   * pipe phase. The flags used to be pooled across whatever phase types a query
   * happened to load, so such a line counted on the WBS sheet or the overview
   * depending on what ELSE was in the estimate, and where it counted it doubled
   * the phase's footage.
   */
  it("does not count a line flagged under another phase type, on any screen", async () => {
    const { t, as } = await ownerHarness();
    await t.run(async (ctx) => {
      const bookId = await ensureTestBook(ctx);
      const pool = (poolId: number, name: string) =>
        ctx.db.insert("phasePool", {
          datasetVersion: "v1",
          bookId,
          poolId,
          wbsPoolId: 70000,
          name,
          sortOrder: poolId,
          isCustom: false,
          isActive: true,
          takeoffUnit: "LF",
        });
      await pool(70001, "CARBON STEEL");
      await pool(79989, "OFFLOAD");
      const item = (poolId: number, phasePoolId: number, description: string) =>
        ctx.db.insert("laborPool", {
          datasetVersion: "v1",
          bookId,
          poolId,
          phasePoolId,
          description,
          sortOrder: poolId,
          craftConstant: 0.2,
          craftUnits: "LF",
          weldConstant: 0,
          weldUnits: "",
          isCustom: false,
          isActive: true,
          countsTowardTakeoff: true,
        });
      await item(501, 70001, "HE - 3");
      await item(901, 79989, "OFF - 3");
    });

    const line = (laborPoolId: number, quantity: number) => ({
      ...laborActivity(quantity, 0.2),
      laborPoolId,
    });
    const tree = await seedProposal(t, {
      proposalNumber: "2061",
      rates: RATES_2020,
      wbs: [
        {
          poolId: 70000,
          name: "AG PIPING",
          phases: [
            // 1,280 LF of pipe, handled AND offloaded. The takeoff is 1,280.
            {
              phaseNumber: 70001,
              phasePoolId: 70001,
              activities: [line(501, 1280), line(901, 1280)],
            },
            // An offload phase, present so the WBS sheet LOADS the offload flags.
            { phaseNumber: 79989, phasePoolId: 79989, activities: [line(901, 300)] },
          ],
        },
      ],
    });

    const wbsId = tree.wbsByCode.get(70000);
    if (!wbsId) throw new Error("fixture: WBS missing");
    const phases = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    const pipe = phases.find((phase) => phase.phaseNumber === 70001);
    const offload = phases.find((phase) => phase.phaseNumber === 79989);
    expect(pipe?.takeoff?.quantity).toBe(1280); // not 2,560
    expect(offload?.takeoff?.quantity).toBe(300);

    // The overview rolls the same phases up, and must reach the same footage.
    const rows = await as.query(api.precision.getWBSListWithCosts, {
      proposalId: tree.proposalId,
    });
    expect(rows.find((row) => row._id === wbsId)?.takeoff?.quantity).toBe(1580);

    // And the phase screen's half of the rule hands back only its own type's flags.
    const catalog = await as.query(api.precision.getPhaseTakeoffCatalog, {
      bookId: tree.bookId,
      phasePoolId: 70001,
    });
    expect(catalog.flaggedLaborPoolIds).toEqual([501]);
  });
});
