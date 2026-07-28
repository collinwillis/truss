/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Data-integrity contracts: the referential guard on `deleteProposal`, and the
 * rule that an activity's WBS is always derived from its phase.
 *
 * Both exist because Convex has no referential integrity and no cross-table
 * invariants — nothing but these checks stops the two defects reproduced here.
 *
 * Calls go through `as` rather than `t` because every Precision function now
 * requires a permitted caller — see `precisionAuthorization.test.ts` for the
 * guard itself. The internal sync mutations keep using `t`: they run as the
 * system, not as a user, and are not part of the guarded surface.
 *
 * @see docs/precision/DECISIONS.md D-wbsId
 */

import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { seedProposal, laborActivity, type TestRunner } from "./convexFixtures";
import { RATES_2020 } from "./rates";

describe("deleteProposal referential guard", () => {
  it("refuses when a Momentum project was created from the proposal", async () => {
    const { t, as } = await ownerHarness();
    const { proposalId } = await seedProposal(t, {
      proposalNumber: "2042",
      wbs: [{ poolId: 70000, phases: [{ phaseNumber: 1, activities: [laborActivity(10)] }] }],
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("momentumProjects", {
        proposalId,
        name: "GND DEBOTTLENECKING",
        proposalNumber: "2042",
        ownerName: "Test Owner",
        status: "active",
      });
    });

    // Convex has no foreign keys, so without this guard the cascade would
    // succeed and leave a live project in the released Momentum app pointing at
    // a proposal that no longer exists.
    await expect(as.mutation(api.precision.deleteProposal, { proposalId })).rejects.toThrow(
      /Momentum project/i
    );

    // And nothing was deleted on the way to refusing.
    const survivors = await t.run(async (ctx) => ({
      proposal: await ctx.db.get(proposalId),
      activities: (await ctx.db.query("activities").collect()).length,
      phases: (await ctx.db.query("phases").collect()).length,
      wbs: (await ctx.db.query("wbs").collect()).length,
    }));
    expect(survivors.proposal).not.toBeNull();
    expect(survivors.activities).toBe(1);
    expect(survivors.phases).toBe(1);
    expect(survivors.wbs).toBe(1);
  });

  it("names the blocking projects so the error is actionable", async () => {
    const { t, as } = await ownerHarness();
    const { proposalId } = await seedProposal(t, { proposalNumber: "2042" });

    await t.run(async (ctx) => {
      await ctx.db.insert("momentumProjects", {
        proposalId,
        name: "GND DEBOTTLENECKING",
        proposalNumber: "2042",
        ownerName: "Test Owner",
        status: "active",
      });
    });

    await expect(as.mutation(api.precision.deleteProposal, { proposalId })).rejects.toThrow(
      /GND DEBOTTLENECKING/
    );
  });

  it("cascades the whole tree when nothing references the proposal", async () => {
    const { t, as } = await ownerHarness();
    const { proposalId } = await seedProposal(t, {
      wbs: [
        {
          poolId: 70000,
          phases: [
            { phaseNumber: 1, activities: [laborActivity(10), laborActivity(3)] },
            { phaseNumber: 2, activities: [laborActivity(7)] },
          ],
        },
        { poolId: 10000, phases: [{ phaseNumber: 1, activities: [laborActivity(1)] }] },
      ],
    });

    await as.mutation(api.precision.deleteProposal, { proposalId });

    const remaining = await t.run(async (ctx) => ({
      proposal: await ctx.db.get(proposalId),
      activities: (await ctx.db.query("activities").collect()).length,
      phases: (await ctx.db.query("phases").collect()).length,
      wbs: (await ctx.db.query("wbs").collect()).length,
    }));

    expect(remaining.proposal).toBeNull();
    expect(remaining.activities).toBe(0);
    expect(remaining.phases).toBe(0);
    expect(remaining.wbs).toBe(0);
  });
});

describe("sync derives activity.wbsId from the phase", () => {
  /**
   * Reproduces the production corruption exactly.
   *
   * Legacy's copy-activities-between-phases wrote only `phaseId`, carrying
   * `wbsId` over from the SOURCE activity. So a row copied into a phase under a
   * different WBS permanently claims the wrong one — measured live on proposal
   * 2042, where 4 of 680 activities disagree with their phase.
   *
   * The activity below is the poison pill: its own `fsWbsId` says WBS A while
   * its phase lives under WBS B.
   */
  it("ignores the activity's own wbsId when it disagrees with its phase", async () => {
    const { t } = await ownerHarness();

    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: {
        firestoreId: "fs-proposal-1",
        proposalNumber: "2042",
        description: "GND DEBOTTLENECKING",
        ownerName: "Test Owner",
        rates: { ...RATES_2020 },
        datasetVersion: "v1",
      },
      wbsList: [
        {
          firestoreId: "fs-wbs-A",
          fsProposalId: "fs-proposal-1",
          wbsPoolId: 10000,
          name: "MOBILIZE",
          sortOrder: 1,
        },
        {
          firestoreId: "fs-wbs-B",
          fsProposalId: "fs-proposal-1",
          wbsPoolId: 70000,
          name: "AG PIPING",
          sortOrder: 2,
        },
      ],
      phasesList: [
        {
          firestoreId: "fs-phase-underB",
          fsProposalId: "fs-proposal-1",
          fsWbsId: "fs-wbs-B",
          phasePoolId: 70001,
          poolName: "CARBON STEEL",
          phaseNumber: 1,
          description: "PHASE UNDER B",
          isCompleted: false,
          sortOrder: 1,
        },
      ],
      activitiesList: [
        {
          firestoreId: "fs-activity-corrupt",
          fsProposalId: "fs-proposal-1",
          // Claims WBS A …
          fsWbsId: "fs-wbs-A",
          // … while sitting in a phase that belongs to WBS B.
          fsPhaseId: "fs-phase-underB",
          type: "labor",
          description: "CHANGE TRAILER",
          quantity: 1,
          unit: "EA",
          sortOrder: 1,
          labor: { craftConstant: 0.55, welderConstant: 0 },
        },
      ],
    });

    const result = await t.run(async (ctx) => {
      const activity = await ctx.db
        .query("activities")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-activity-corrupt"))
        .first();
      const phase = activity ? await ctx.db.get(activity.phaseId) : null;
      const wbsB = await ctx.db
        .query("wbs")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-wbs-B"))
        .first();
      const wbsA = await ctx.db
        .query("wbs")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-wbs-A"))
        .first();
      return {
        activityWbsId: activity?.wbsId ?? null,
        phaseWbsId: phase?.wbsId ?? null,
        wbsAId: wbsA?._id ?? null,
        wbsBId: wbsB?._id ?? null,
      };
    });

    // The invariant: an activity's WBS always equals its phase's WBS.
    expect(result.activityWbsId).toBe(result.phaseWbsId);
    expect(result.activityWbsId).toBe(result.wbsBId);
    expect(result.activityWbsId).not.toBe(result.wbsAId);
  });

  it("keeps the rollups agreeing after importing a corrupted row", async () => {
    // The reason the invariant matters: the WBS table groups by
    // `activity.wbsId` while the phase drill-down groups by phase. Before the
    // fix those two surfaces disagreed silently on an affected proposal.
    const { t, as } = await ownerHarness();

    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: {
        firestoreId: "fs-p",
        proposalNumber: "2042",
        description: "GND DEBOTTLENECKING",
        ownerName: "Owner",
        rates: { ...RATES_2020 },
        datasetVersion: "v1",
      },
      wbsList: [
        {
          firestoreId: "w-a",
          fsProposalId: "fs-p",
          wbsPoolId: 10000,
          name: "MOBILIZE",
          sortOrder: 1,
        },
        {
          firestoreId: "w-b",
          fsProposalId: "fs-p",
          wbsPoolId: 70000,
          name: "AG PIPING",
          sortOrder: 2,
        },
      ],
      phasesList: [
        {
          firestoreId: "ph-b",
          fsProposalId: "fs-p",
          fsWbsId: "w-b",
          phasePoolId: 70001,
          poolName: "CS",
          phaseNumber: 1,
          description: "P1",
          isCompleted: false,
          sortOrder: 1,
        },
      ],
      activitiesList: [
        {
          firestoreId: "a-1",
          fsProposalId: "fs-p",
          fsWbsId: "w-a",
          fsPhaseId: "ph-b",
          type: "labor",
          description: "TOOLS",
          quantity: 100,
          unit: "EA",
          sortOrder: 1,
          labor: { craftConstant: 0.55, welderConstant: 0 },
        },
      ],
    });

    const proposalId = await t.run(async (ctx) => {
      const p = await ctx.db
        .query("proposals")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-p"))
        .first();
      if (!p) throw new Error("proposal not seeded");
      return p._id;
    });

    const wbsRows = await as.query(api.precision.getWBSListWithCosts, { proposalId });
    const byCode = new Map(wbsRows.map((r) => [r.wbsPoolId, r]));

    // All the cost sits under 70000, where the phase actually lives — not under
    // 10000, which the activity's imported wbsId claimed.
    expect(byCode.get(70000)?.costs.totalCost).toBeGreaterThan(0);
    expect(byCode.get(10000)?.costs.totalCost).toBe(0);

    // And the WBS rollup ties to the proposal summary.
    const summary = await as.query(api.precision.getProposalSummary, { proposalId });
    const wbsSum = wbsRows.reduce((n, r) => n + r.costs.totalCost, 0);
    expect(Math.abs(wbsSum - summary.totalCost)).toBeLessThan(0.02);
  });
});

describe("rate-override eligibility is enforced on the write path (D6)", () => {
  /** Seed one activity in a position we control, and return its id. */
  async function seedActivityAt(
    t: TestRunner,
    opts: { wbsPoolId: number; phasePoolId: number; type: "labor" | "custom_labor" }
  ) {
    const { activityIds } = await seedProposal(t, {
      wbs: [
        {
          poolId: opts.wbsPoolId,
          phases: [
            {
              phaseNumber: 1,
              phasePoolId: opts.phasePoolId,
              activities: [
                { type: opts.type, quantity: 10, labor: { craftConstant: 1, welderConstant: 0 } },
              ],
            },
          ],
        },
      ],
    });
    const [activityId] = activityIds;
    if (!activityId) throw new Error("fixture did not seed an activity");
    return activityId;
  }

  it("rejects an override on an ordinary craft line", async () => {
    const { t, as } = await ownerHarness();
    const activityId = await seedActivityAt(t, {
      wbsPoolId: 70000,
      phasePoolId: 70001,
      type: "labor",
    });

    // Legacy only ever checked this in React, so a client could set the override
    // anyway. The server is what makes the rule real.
    await expect(
      as.mutation(api.precision.updateActivity, {
        activityId,
        labor: { craftConstant: 1, welderConstant: 0, customCraftRate: 52.5 },
      })
    ).rejects.toThrow(/custom labor/i);
  });

  it("allows an override on a custom labor line", async () => {
    const { t, as } = await ownerHarness();
    const activityId = await seedActivityAt(t, {
      wbsPoolId: 70000,
      phasePoolId: 70001,
      type: "custom_labor",
    });

    await as.mutation(api.precision.updateActivity, {
      activityId,
      labor: { craftConstant: 1, welderConstant: 0, customCraftRate: 52.5 },
    });

    const stored = await t.run(async (ctx) => await ctx.db.get(activityId));
    expect(stored?.labor?.customCraftRate).toBe(52.5);
  });

  it("allows an override under the SUPPORT work breakdown", async () => {
    const { t, as } = await ownerHarness();
    const activityId = await seedActivityAt(t, {
      wbsPoolId: 200000,
      phasePoolId: 70001,
      type: "labor",
    });

    await as.mutation(api.precision.updateActivity, {
      activityId,
      labor: { craftConstant: 1, welderConstant: 0, customSubsistenceRate: 12 },
    });

    const stored = await t.run(async (ctx) => await ctx.db.get(activityId));
    expect(stored?.labor?.customSubsistenceRate).toBe(12);
  });

  it("allows an override on a FIREWATCH phase", async () => {
    const { t, as } = await ownerHarness();
    const activityId = await seedActivityAt(t, {
      wbsPoolId: 180000,
      phasePoolId: 180002,
      type: "labor",
    });

    await as.mutation(api.precision.updateActivity, {
      activityId,
      labor: { craftConstant: 1, welderConstant: 0, customCraftRate: 30 },
    });

    const stored = await t.run(async (ctx) => await ctx.db.get(activityId));
    expect(stored?.labor?.customCraftRate).toBe(30);
  });

  it("still allows non-override edits on an ineligible line", async () => {
    // The guard must gate the override fields only. Blocking ordinary edits to
    // an ineligible activity would make most of the grid read-only.
    const { t, as } = await ownerHarness();
    const activityId = await seedActivityAt(t, {
      wbsPoolId: 70000,
      phasePoolId: 70001,
      type: "labor",
    });

    await as.mutation(api.precision.updateActivity, { activityId, quantity: 42 });

    const stored = await t.run(async (ctx) => await ctx.db.get(activityId));
    expect(stored?.quantity).toBe(42);
  });

  it("reports eligibility to the grid so the UI shows what the server enforces", async () => {
    const { t, as } = await ownerHarness();
    const { phaseByNumber } = await seedProposal(t, {
      wbs: [
        {
          poolId: 70000,
          phases: [
            {
              phaseNumber: 1,
              phasePoolId: 70001,
              activities: [
                { type: "labor", quantity: 1, labor: { craftConstant: 1, welderConstant: 0 } },
                {
                  type: "custom_labor",
                  quantity: 1,
                  labor: { craftConstant: 1, welderConstant: 0 },
                },
              ],
            },
          ],
        },
      ],
    });
    const phaseId = phaseByNumber.get("70000:1");
    if (!phaseId) throw new Error("fixture did not seed the phase");

    const rows = await as.query(api.precision.getActivitiesWithCosts, { phaseId });
    const byType = new Map(rows.map((r) => [r.type, r.canOverrideRates]));

    expect(byType.get("labor")).toBe(false);
    expect(byType.get("custom_labor")).toBe(true);
  });
});
