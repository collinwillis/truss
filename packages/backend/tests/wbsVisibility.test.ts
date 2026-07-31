/**
 * WBS visibility (Setup toggles).
 *
 * The contract under test is the one that protects the bid: hiding a WBS is
 * NAVIGATIONAL ONLY. Queries report the flag so the client can declutter its
 * menus, but every cost rollup — per-WBS and proposal-wide — must be
 * identical before and after hiding, including for a WBS that carries real
 * work.
 */
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { laborActivity, seedProposal } from "./convexFixtures";
import { RATES_2020 } from "./rates";

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`fixture missing ${label}`);
  return value;
}

async function seedTwoWbs() {
  const { t, as } = await ownerHarness();
  const tree = await seedProposal(t, {
    proposalNumber: "2071",
    rates: RATES_2020,
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [{ phaseNumber: 1, activities: [laborActivity(100)] }],
      },
      { poolId: 90000, name: "PAINTING" },
    ],
  });
  return {
    t,
    as,
    proposalId: tree.proposalId,
    pipingId: must(tree.wbsByCode.get(70000), "wbs 70000"),
    paintingId: must(tree.wbsByCode.get(90000), "wbs 90000"),
  };
}

describe("setWBSHidden", () => {
  it("round-trips through every WBS query, and clearing removes the sparse flag", async () => {
    const { as, proposalId, paintingId } = await seedTwoWbs();

    const before = await as.query(api.precision.getWBSForProposal, { proposalId });
    expect(before.map((w) => w.isHidden)).toEqual([false, false]);

    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: true });

    const flat = await as.query(api.precision.getWBSForProposal, { proposalId });
    const nav = await as.query(api.precision.getWBSWithPhasesForNav, { proposalId });
    const costs = await as.query(api.precision.getWBSListWithCosts, { proposalId });
    for (const rows of [flat, nav, costs]) {
      expect(rows.find((w) => w._id === paintingId)?.isHidden).toBe(true);
      expect(rows.find((w) => w._id !== paintingId)?.isHidden).toBe(false);
    }

    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: false });
    const after = await as.query(api.precision.getWBSForProposal, { proposalId });
    expect(after.map((w) => w.isHidden)).toEqual([false, false]);
  });

  it("stores visibility sparsely — un-hiding removes the field, not writes false", async () => {
    const { t, as, paintingId } = await seedTwoWbs();

    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: true });
    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: false });

    const doc = await t.run(async (ctx) => ctx.db.get(paintingId));
    expect(doc?.isHidden).toBeUndefined();
  });

  it("never moves the bid: totals and rollups are identical with a costed WBS hidden", async () => {
    const { as, proposalId, pipingId } = await seedTwoWbs();

    const summaryBefore = await as.query(api.precision.getProposalSummary, { proposalId });
    const costsBefore = await as.query(api.precision.getWBSListWithCosts, { proposalId });
    const exportBefore = await as.query(api.precision.getExportData, { proposalId });
    expect(summaryBefore.totalCost).toBeGreaterThan(0);

    // Hide the WBS that carries ALL the work — the adversarial case.
    await as.mutation(api.precision.setWBSHidden, { wbsId: pipingId, hidden: true });

    const summaryAfter = await as.query(api.precision.getProposalSummary, { proposalId });
    const costsAfter = await as.query(api.precision.getWBSListWithCosts, { proposalId });
    const exportAfter = await as.query(api.precision.getExportData, { proposalId });

    expect(summaryAfter).toEqual(summaryBefore);
    expect(costsAfter.map((w) => w.costs)).toEqual(costsBefore.map((w) => w.costs));
    // The export is the bid document — hidden work MUST still be in it.
    expect(exportAfter).toEqual(exportBefore);
    // The hidden row is still REPORTED with its cost — the client's honesty
    // footnote ("hidden work still in totals") depends on it.
    expect(costsAfter.find((w) => w._id === pipingId)?.costs.totalCost).toBe(
      summaryBefore.totalCost
    );
  });

  it("survives proposal duplication", async () => {
    const { as, proposalId, paintingId } = await seedTwoWbs();
    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: true });

    const copyId = await as.mutation(api.precision.duplicateProposal, {
      sourceProposalId: proposalId,
      newProposalNumber: "2072",
    });

    const copied = await as.query(api.precision.getWBSForProposal, { proposalId: copyId });
    expect(copied.find((w) => w.wbsPoolId === 90000)?.isHidden).toBe(true);
    expect(copied.find((w) => w.wbsPoolId === 70000)?.isHidden).toBe(false);
  });

  it("does not claim a mirrored estimate for Precision", async () => {
    const { t, as, proposalId, paintingId } = await seedTwoWbs();
    await t.run(async (ctx) => ctx.db.patch(proposalId, { firestoreId: "fs-prop-1" }));

    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: true });

    // Hiding is navigation state, not estimate data — the D1 exception. This
    // fails if anyone adds claimForPrecision to setWBSHidden.
    const doc = await t.run(async (ctx) => ctx.db.get(proposalId));
    expect(doc?.precisionOwnedAt).toBeUndefined();
  });

  it("survives a re-sync of a still-mirrored estimate", async () => {
    const { t, as, proposalId, paintingId } = await seedTwoWbs();
    await t.run(async (ctx) => {
      await ctx.db.patch(proposalId, { firestoreId: "fs-prop-1" });
      await ctx.db.patch(paintingId, { firestoreId: "fs-wbs-paint" });
    });
    await as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: true });

    // The wbsList entry carries exactly mapWBS's closed field list — this
    // test fails if mapWBS widens to emit isHidden or the sync's patch
    // becomes a replace, the two ways the flag could die on a nightly run.
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: {
        firestoreId: "fs-prop-1",
        proposalNumber: "2071",
        description: "Tank 8 installation",
        ownerName: "Test Owner",
        rates: { ...RATES_2020 },
        datasetVersion: "v1",
      },
      wbsList: [
        {
          firestoreId: "fs-wbs-paint",
          fsProposalId: "fs-prop-1",
          wbsPoolId: 90000,
          name: "PAINTING",
          sortOrder: 1,
        },
      ],
      phasesList: [],
      activitiesList: [],
    });

    const rows = await as.query(api.precision.getWBSForProposal, { proposalId });
    expect(rows.find((w) => w._id === paintingId)?.isHidden).toBe(true);
  });

  it("refuses an unknown WBS id", async () => {
    const { as, paintingId } = await seedTwoWbs();

    // A deleted row is the only guaranteed-dangling id: convex-test mints
    // ids deterministically, so an id from another test instance collides
    // with a real row here.
    await as.mutation(api.precision.deleteWBS, { wbsId: paintingId });

    await expect(
      as.mutation(api.precision.setWBSHidden, { wbsId: paintingId, hidden: true })
    ).rejects.toThrow("WBS not found");
  });
});
