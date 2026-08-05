/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The contract between one chunk of a large estimate and the next.
 *
 * A tree over `PHASE_CHUNK` phases or `ACTIVITY_CHUNK` activities is written by
 * several mutations, and every one after the first is handed the parent ids the
 * earlier ones resolved. That hand-off is the whole reason a chunk does not
 * re-collect the proposal's WBS and phase lists — the shape of waste that
 * aborted `activityLinks.repairBatch` mid-run with a hard runtime abort no
 * `catch` could record.
 *
 * These tests pin the hand-off itself rather than the chunk sizes, so they stay
 * fast and stay true if the constants move.
 */

import { describe, expect, it } from "vitest";

import { internal } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { RATES_2020 } from "./rates";

function proposalRow() {
  return {
    firestoreId: "fs-prop",
    proposalNumber: "2042",
    description: "GND DEBOTTLENECKING",
    ownerName: "Test Owner",
    status: "bidding",
    rates: { ...RATES_2020 },
    datasetVersion: "v1" as const,
  };
}

function wbsRow(firestoreId: string, sortOrder: number) {
  return {
    firestoreId,
    fsProposalId: "fs-prop",
    wbsPoolId: 70000 + sortOrder,
    name: `WBS ${sortOrder}`,
    sortOrder,
  };
}

function phaseRow(firestoreId: string, fsWbsId: string, phaseNumber: number) {
  return {
    firestoreId,
    fsProposalId: "fs-prop",
    fsWbsId,
    phasePoolId: 70001,
    poolName: "CARBON STEEL",
    phaseNumber,
    description: `PHASE ${phaseNumber}`,
    isCompleted: false,
    sortOrder: phaseNumber,
  };
}

function activityRow(firestoreId: string, fsWbsId: string, fsPhaseId: string) {
  return {
    firestoreId,
    fsProposalId: "fs-prop",
    fsWbsId,
    fsPhaseId,
    type: "labor" as const,
    description: "EXCAVATE, LIGHT (CLASS C - GRAVEL)",
    quantity: 12,
    unit: "CY",
    sortOrder: 1,
    laborPoolId: 28,
    labor: { craftConstant: 0.55, welderConstant: 0 },
  };
}

describe("a later chunk is handed every parent the tree has resolved", () => {
  it("carries the WBS map forward through a phase chunk that adds none", async () => {
    // THE LANDMINE THIS PINS: `resolved` used to answer "what did THIS call
    // resolve", so a phase chunk — which is handed no WBS list and therefore
    // resolves no WBS — reported an empty map. The engine compensated by merging
    // only the phases, which is correct exactly as long as `phases` stays the
    // only level that chunks. A caller taking the answer at its word instead
    // dropped the WBS map, and every later chunk fell back to collecting the
    // whole `by_proposal` WBS list again — the per-chunk re-scan the hand-off
    // exists to prevent.
    const { t } = await ownerHarness();

    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [wbsRow("fs-wbs-a", 1), wbsRow("fs-wbs-b", 2)],
      phasesList: [phaseRow("fs-phase-1", "fs-wbs-a", 1)],
      activitiesList: [],
    });
    expect(first.resolved?.wbs).toHaveLength(2);
    expect(first.resolved?.phases).toHaveLength(1);

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [phaseRow("fs-phase-2", "fs-wbs-b", 2)],
      activitiesList: [],
      resolved: first.resolved ?? undefined,
      continuation: true,
    });

    // Cumulative: what it was handed, plus what it added. Taking this whole has
    // to be correct, because that is what the engine does.
    expect(second.resolved?.wbs.map((w) => w.firestoreId).sort()).toEqual(["fs-wbs-a", "fs-wbs-b"]);
    expect(second.resolved?.phases.map((p) => p.firestoreId).sort()).toEqual([
      "fs-phase-1",
      "fs-phase-2",
    ]);
    expect(second.unresolved).toBe(0);
  });

  it("resolves an activity chunk against a phase an earlier chunk created", async () => {
    const { t } = await ownerHarness();

    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [wbsRow("fs-wbs-a", 1), wbsRow("fs-wbs-b", 2)],
      phasesList: [phaseRow("fs-phase-1", "fs-wbs-a", 1)],
      activitiesList: [],
    });
    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [phaseRow("fs-phase-2", "fs-wbs-b", 2)],
      activitiesList: [],
      resolved: first.resolved ?? undefined,
      continuation: true,
    });

    // The activity chunk hangs off the phase the SECOND chunk created, under the
    // WBS the FIRST one created — so it only resolves if both survived.
    const third = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [],
      activitiesList: [activityRow("fs-act-1", "fs-wbs-b", "fs-phase-2")],
      resolved: second.resolved ?? undefined,
      continuation: true,
    });
    expect(third.unresolved).toBe(0);
    expect(third.byLevel.activity.insert).toBe(1);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("activities")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-act-1"))
        .first()
    );
    const wbsB = await t.run(async (ctx) =>
      ctx.db
        .query("wbs")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-wbs-b"))
        .first()
    );
    // Denormalized from the PHASE's WBS, never from the activity's own — the
    // rule that survives chunking only because the phase map carries `wbsId`.
    expect(stored?.wbsId).toBe(wbsB?._id);
  });

  it("still refuses the whole tree when Precision claims it between chunks", async () => {
    const { t } = await ownerHarness();
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [wbsRow("fs-wbs-a", 1)],
      phasesList: [phaseRow("fs-phase-1", "fs-wbs-a", 1)],
      activitiesList: [],
    });
    const resolved = first.resolved;
    if (!resolved) throw new Error("fixture: expected resolved parents");
    await t.run(async (ctx) => ctx.db.patch(resolved.proposalId, { precisionOwnedAt: Date.now() }));

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [],
      activitiesList: [activityRow("fs-act-1", "fs-wbs-a", "fs-phase-1")],
      resolved,
      continuation: true,
    });
    expect(second.skipReason).toBe("precision_owned");
    expect(await t.run(async (ctx) => (await ctx.db.query("activities").collect()).length)).toBe(0);
  });
});

describe("a dry run's forecast survives chunking", () => {
  /**
   * The 121 real proposals this sync exists for have metadata and no tree: the
   * 6-hourly proposals-only cron created the row, the full pull never happened.
   * Their phases are forecast in one chunk and their activities land in the
   * next, so without carrying the forecast every activity counted "unresolved"
   * and the dry run reported no inserts for a tree a real run fills completely.
   */
  it("counts activities under a forecast phase as inserts, not unresolved", async () => {
    const { t } = await ownerHarness();
    const proposalFsId = "fs-p-empty";

    // A proposal that EXISTS with no tree — exactly the 121.
    await t.run(async (ctx) => {
      const { status: _status, ...rest } = proposalRow();
      await ctx.db.insert("proposals", {
        ...rest,
        status: "bidding",
        firestoreId: proposalFsId,
        proposalNumber: "9001",
      });
    });

    const proposal = { ...proposalRow(), firestoreId: proposalFsId, proposalNumber: "9001" };

    // Chunk one: the WBS and phase, forecast only — nothing is written.
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal,
      wbsList: [
        {
          firestoreId: "fs-w",
          fsProposalId: proposalFsId,
          wbsPoolId: 10000,
          name: "AG PIPING",
          sortOrder: 10,
        },
      ],
      phasesList: [
        {
          firestoreId: "fs-ph",
          fsWbsId: "fs-w",
          fsProposalId: proposalFsId,
          phasePoolId: 70001,
          name: "CARBON STEEL",
          sortOrder: 10,
        },
      ],
      activitiesList: [],
      dryRun: true,
    });
    expect(first.unresolved).toBe(0);

    // Chunk two: the activities, in a SEPARATE mutation — the boundary that
    // used to lose the forecast.
    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal,
      wbsList: [],
      phasesList: [],
      activitiesList: [
        {
          firestoreId: "fs-a1",
          fsProposalId: proposalFsId,
          fsWbsId: "fs-w",
          fsPhaseId: "fs-ph",
          type: "labor",
          description: "CUT",
          quantity: 1,
          unit: "EA",
          sortOrder: 10,
        },
        {
          firestoreId: "fs-a2",
          fsProposalId: proposalFsId,
          fsWbsId: "fs-w",
          fsPhaseId: "fs-ph",
          type: "labor",
          description: "WELD",
          quantity: 1,
          unit: "EA",
          sortOrder: 20,
        },
      ],
      resolved: first.resolved ?? undefined,
      continuation: true,
      dryRun: true,
    });

    expect(second.unresolved).toBe(0);
    expect(second.byLevel.activity.insert).toBe(2);
  });
});
