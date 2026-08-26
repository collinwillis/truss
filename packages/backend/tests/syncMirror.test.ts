/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The differential mirror, exercised through the mutations that actually write.
 *
 * `syncDiff.test.ts` proves the differ reaches the right verdicts. This suite
 * proves the mirror ACTS on them — that an unchanged pass writes nothing, that a
 * repaired catalog link survives a Firestore document still holding the stale
 * id, that a row Firestore stopped returning is flagged and left in place, and
 * that a broken run can be proven dead and picked back up.
 *
 * Everything here calls the internal sync mutations through `t`: they run as the
 * system, not as a user, and are not part of the guarded Precision surface.
 */

import { describe, expect, it } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { parseDocument, type FirestoreDocument } from "../convex/sync/firestoreClient";
import { mapActivity, mapPhase, mapProposal, mapWBS } from "../convex/sync/fieldMapping";
import { ownerHarness } from "./authFixtures";
import type { TestRunner } from "./convexFixtures";
import { RATES_2020 } from "./rates";

// ============================================================================
// A tree shaped exactly as the field mappers emit it
// ============================================================================

/** `mapProposal` output for one estimate. */
function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    firestoreId: "fs-prop",
    proposalNumber: "2042",
    description: "GND DEBOTTLENECKING",
    ownerName: "Test Owner",
    status: "bidding",
    projectAddress: { city: "Baytown", state: "TX" },
    estimators: ["RS"],
    rates: { ...RATES_2020 },
    datasetVersion: "v1" as const,
    ...overrides,
  };
}

/** `mapWBS` output, carrying the transport key the mutation destructures away. */
function wbsRow(overrides: Record<string, unknown> = {}) {
  return {
    firestoreId: "fs-wbs",
    fsProposalId: "fs-prop",
    wbsPoolId: 70000,
    name: "AG PIPING",
    sortOrder: 70000,
    ...overrides,
  };
}

/** `mapPhase` output. */
function phaseRow(overrides: Record<string, unknown> = {}) {
  return {
    firestoreId: "fs-phase",
    fsProposalId: "fs-prop",
    fsWbsId: "fs-wbs",
    phasePoolId: 70001,
    poolName: "CARBON STEEL",
    phaseNumber: 1,
    description: "PHASE ONE",
    isCompleted: false,
    sortOrder: 1,
    ...overrides,
  };
}

/**
 * `mapActivity` output for a labor line.
 *
 * `laborPoolId: 28` is `EXCAVATE, LIGHT (CLASS C - GRAVEL)` from `labor_v1.json`
 * — the same real row the link-repair fixtures use, so "Firestore still holds
 * the stale id" is the production shape and not a made-up number.
 */
function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    firestoreId: "fs-act-1",
    fsProposalId: "fs-prop",
    fsWbsId: "fs-wbs",
    fsPhaseId: "fs-phase",
    type: "labor" as const,
    description: "EXCAVATE, LIGHT (CLASS C - GRAVEL)",
    quantity: 12,
    unit: "CY",
    sortOrder: 1,
    laborPoolId: 28,
    equipmentPoolId: undefined,
    labor: { craftConstant: 0.55, welderConstant: 0 },
    equipment: undefined,
    subcontractor: undefined,
    unitPrice: undefined,
    ...overrides,
  };
}

/** One whole tree, as a mirror pass would hand it over. */
function tree(over?: {
  proposal?: Record<string, unknown>;
  activities?: Record<string, unknown>[];
}) {
  return {
    proposal: proposalRow(over?.proposal),
    wbsList: [wbsRow()],
    phasesList: [phaseRow()],
    activitiesList: over?.activities ?? [activityRow()],
  };
}

/** The stored activity a fixture keeps re-reading. */
async function storedActivity(t: TestRunner, firestoreId: string): Promise<Doc<"activities">> {
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("activities")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", firestoreId))
      .first()
  );
  if (!row) throw new Error(`fixture: no stored activity ${firestoreId}`);
  return row;
}

// ============================================================================

describe("a pass that changes nothing writes nothing", () => {
  it("reports every row unchanged the second time through", async () => {
    const { t } = await ownerHarness();

    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    expect(first.inserted).toBe(4); // proposal + wbs + phase + activity
    expect(first.updated).toBe(0);

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(4);
    expect(second.byLevel.activity.unchanged).toBe(1);
  });

  it("does not re-queue the cached-total rollup", async () => {
    // The economic claim, made falsifiable: an unchanged pass must not
    // invalidate the proposal total, or every pass re-reads every activity of
    // all 736 estimates to recompute a number that did not move.
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());

    const jobAfterImport = await t.run(async (ctx) => {
      const p = await ctx.db
        .query("proposals")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-prop"))
        .first();
      return p?.costTotalJob ?? null;
    });
    expect(jobAfterImport).not.toBeNull();

    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const jobAfterNoop = await t.run(async (ctx) => {
      const p = await ctx.db
        .query("proposals")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-prop"))
        .first();
      return p?.costTotalJob ?? null;
    });
    expect(jobAfterNoop).toBe(jobAfterImport);
  });

  it("patches only the row that moved", async () => {
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...tree({ activities: [activityRow({ quantity: 40 })] }),
    });
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(3);
    expect(result.byLevel.activity.patch).toBe(1);
    expect((await storedActivity(t, "fs-act-1")).quantity).toBe(40);
  });

  it("re-parents a line moved to another phase rather than duplicating it", async () => {
    // Matching by phase instead of by firestoreId would insert a second copy
    // here AND report the original as deleted upstream. Both at once.
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());

    const moved = tree();
    moved.phasesList = [phaseRow(), phaseRow({ firestoreId: "fs-phase-2", phaseNumber: 2 })];
    moved.activitiesList = [activityRow({ fsPhaseId: "fs-phase-2" })];

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, moved);
    expect(result.byLevel.activity.insert).toBe(0);
    expect(result.byLevel.activity.patch).toBe(1);

    const rows = await t.run(async (ctx) => ctx.db.query("activities").collect());
    expect(rows).toHaveLength(1);
    const phase2 = await t.run(async (ctx) =>
      ctx.db
        .query("phases")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", "fs-phase-2"))
        .first()
    );
    expect(rows[0]?.phaseId).toBe(phase2?._id);
  });
});

describe("the repaired catalog link survives every pass", () => {
  /**
   * The 8,944-row guarantee. Firestore still holds the id the line was written
   * with; `activityLinks.repairBatch` re-pointed the row at the item it actually
   * describes. If the mirror wrote the incoming id back, the repair would be
   * undone within six hours — for ever, silently.
   */
  async function importThenRepair(t: TestRunner) {
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const activity = await storedActivity(t, "fs-act-1");
    await t.run(async (ctx) => {
      await ctx.db.patch(activity._id, { laborPoolId: 1204 });
    });
    return activity._id;
  }

  it("withholds the stale id and does not even count the row as changed", async () => {
    const { t } = await ownerHarness();
    await importThenRepair(t);

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    expect((await storedActivity(t, "fs-act-1")).laborPoolId).toBe(1204);
    // The second half of the guarantee: suppression happens BEFORE the verdict,
    // so a repaired line costs zero writes a pass instead of rewriting for ever.
    expect(result.byLevel.activity.patch).toBe(0);
    expect(result.byLevel.activity.unchanged).toBe(1);
    expect(result.suppressedLinks).toBe(1);
  });

  it("takes the incoming id when the estimator re-picked the item", async () => {
    const { t } = await ownerHarness();
    await importThenRepair(t);

    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...tree({ activities: [activityRow({ description: "SEAM WELDING 1/8 THK" })] }),
    });
    const after = await storedActivity(t, "fs-act-1");
    expect(after.description).toBe("SEAM WELDING 1/8 THK");
    expect(after.laborPoolId).toBe(28);
  });

  it("writes the real edit and still withholds the link", async () => {
    const { t } = await ownerHarness();
    await importThenRepair(t);

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...tree({ activities: [activityRow({ quantity: 99 })] }),
    });
    const after = await storedActivity(t, "fs-act-1");
    expect(after.quantity).toBe(99);
    expect(after.laborPoolId).toBe(1204);
    expect(result.suppressedLinks).toBe(1);
  });
});

describe("orphans are flagged, never deleted", () => {
  it("marks a row Firestore stopped returning and leaves it exactly where it is", async () => {
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const activity = await storedActivity(t, "fs-act-1");

    const keys = await t.query(internal.sync.syncMutations.listMirrorKeys, {
      level: "activity",
      proposalId: activity.proposalId,
      cursor: null,
      numItems: 100,
    });
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0]?.flagged).toBe(false);

    const flagResult = await t.mutation(internal.sync.syncMutations.flagMirrorOrphans, {
      level: "activity",
      flag: [activity._id],
      clear: [],
      at: 1_700_000_000_000,
    });
    expect(flagResult.flagged).toBe(1);

    const after = await storedActivity(t, "fs-act-1");
    expect(after.mirrorDeletedAt).toBe(1_700_000_000_000);
    // The point of the whole design: momentumActivities.sourceActivityId still
    // resolves, because nothing was removed.
    expect(await t.run(async (ctx) => ctx.db.get(activity._id))).not.toBeNull();
  });

  it("clears the flag on the next pass that sees the row again", async () => {
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const activity = await storedActivity(t, "fs-act-1");
    await t.mutation(internal.sync.syncMutations.flagMirrorOrphans, {
      level: "activity",
      flag: [activity._id],
      clear: [],
      at: 1_700_000_000_000,
    });

    // A bad read condemns a row for one pass; the next pass must lift it, or a
    // single Firestore hiccup marks an estimate for ever.
    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    expect(result.byLevel.activity.patch).toBe(1);
    expect((await storedActivity(t, "fs-act-1")).mirrorDeletedAt).toBeUndefined();
  });

  it("reports a Precision-born row as having no mirror key at all", async () => {
    // A row with no firestoreId was never mirrored, so Firestore's silence about
    // it says nothing — flagging it would condemn work the estimator never had.
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const seed = await storedActivity(t, "fs-act-1");
    const localId = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        proposalId: seed.proposalId,
        wbsId: seed.wbsId,
        phaseId: seed.phaseId,
        type: "labor",
        description: "ADDED IN PRECISION",
        quantity: 1,
        unit: "EA",
        sortOrder: 2,
        labor: { craftConstant: 1, welderConstant: 0 },
      })
    );

    const keys = await t.query(internal.sync.syncMutations.listMirrorKeys, {
      level: "activity",
      proposalId: seed.proposalId,
      cursor: null,
      numItems: 100,
    });
    expect(keys.keys.find((k) => k.id === localId)?.firestoreId).toBeNull();
  });
});

describe("the run is resumable and its stalls are provable", () => {
  /** A job in whatever state a test needs, without going through the engine. */
  async function seedJob(t: TestRunner, patch: Partial<Doc<"syncJobs">>): Promise<Id<"syncJobs">> {
    return await t.run(async (ctx) =>
      ctx.db.insert("syncJobs", {
        status: "running",
        mode: "full",
        totalProposals: 3,
        processedProposals: 0,
        insertedRecords: 0,
        errors: [],
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        ...patch,
      })
    );
  }

  it("declines a second run while a healthy one holds the lane", async () => {
    const { t } = await ownerHarness();
    await seedJob(t, {});
    const second = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "proposals",
      totalProposals: 0,
    });
    // Null, not a throw: a 6-hourly tick landing inside a pass that runs for
    // tens of minutes is expected operation, not an incident to page on.
    expect(second).toBeNull();
  });

  it("reclaims a run that stopped heartbeating", async () => {
    const { t } = await ownerHarness();
    const dead = await seedJob(t, { lastProgressAt: Date.now() - 60 * 60 * 1000 });

    const fresh = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "full",
      totalProposals: 0,
    });
    expect(fresh).not.toBeNull();
    const reclaimed = await t.run(async (ctx) => ctx.db.get(dead));
    expect(reclaimed?.status).toBe("failed");
    expect(reclaimed?.error).toMatch(/no progress/);
  });

  it("measures staleness from the heartbeat, not from the start time", async () => {
    // A full pass legitimately runs for tens of minutes. Measuring from
    // startedAt would reclaim a perfectly healthy run halfway through it.
    const { t } = await ownerHarness();
    await seedJob(t, { startedAt: Date.now() - 60 * 60 * 1000, lastProgressAt: Date.now() });
    const second = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "proposals",
      totalProposals: 0,
    });
    expect(second).toBeNull();
  });

  it("refuses to resume a run that is still working", async () => {
    const { t } = await ownerHarness();
    const jobId = await seedJob(t, {});
    await expect(
      t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId })
    ).rejects.toThrow(/still working/);
  });

  it("resumes a stalled run still marked running", async () => {
    // The exact state a hard runtime abort leaves behind: the batch never
    // reaches its own error handler, so nothing marks the run failed and it
    // would block every future pass for ever.
    const { t } = await ownerHarness();
    const jobId = await seedJob(t, {
      lastProgressAt: Date.now() - 60 * 60 * 1000,
      processedProposals: 2,
      proposalQueue: ["a", "b", "c"],
    });
    const result = await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId });
    expect(result.resumedAt).toBe(2);
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))?.status)).toBe("running");
  });

  it("resumes a failed run at its cursor", async () => {
    const { t } = await ownerHarness();
    const jobId = await seedJob(t, {
      status: "failed",
      processedProposals: 1,
      proposalQueue: ["a", "b", "c"],
    });
    await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId });

    const next = await t.query(internal.sync.syncMutations.nextQueuedProposal, { jobId });
    expect(next.active).toBe(true);
    expect(next.proposalFsId).toBe("b");
  });

  it("refuses to resume into a lane another run is holding", async () => {
    // `createSyncJob` is the lock, and a resume does not go through it. Without
    // this refusal two chains walk the same queue, and because each advances the
    // cursor on its own outcome they step over proposals nobody visited.
    const { t } = await ownerHarness();
    const dead = await seedJob(t, {
      status: "failed",
      proposalQueue: ["a", "b"],
    });
    await seedJob(t, { mode: "proposals", lastProgressAt: Date.now() });

    await expect(
      t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId: dead })
    ).rejects.toThrow(/Another sync is in flight/);
  });

  it("resumes once the other run has itself gone stale", async () => {
    const { t } = await ownerHarness();
    const dead = await seedJob(t, { status: "failed", proposalQueue: ["a", "b"] });
    await seedJob(t, { mode: "proposals", lastProgressAt: Date.now() - 60 * 60 * 1000 });

    const result = await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId: dead });
    expect(result.jobId).toBe(dead);
  });

  it("refuses a proposals-only run, which has no queue to resume", async () => {
    const { t } = await ownerHarness();
    const jobId = await seedJob(t, { mode: "proposals", status: "failed" });
    await expect(
      t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId })
    ).rejects.toThrow(/full-estate pass/);
  });

  it("gives up on a proposal that has killed the run three times and walks on", async () => {
    // The wedge the heartbeat alone does not prevent: the cursor only advances
    // on a reported outcome, so an estimate too big to finish inside the ~100s
    // action ceiling is re-attempted by every resume for ever and the proposals
    // behind it never sync again.
    const { t } = await ownerHarness();
    const jobId = await seedJob(t, {
      proposalQueue: ["poison", "b", "c"],
      lastProgressAt: Date.now() - 60 * 60 * 1000,
    });

    /** Exactly what a hard runtime abort leaves: still `running`, no heartbeat. */
    const killMidProposal = async () =>
      await t.run(async (ctx) => {
        await ctx.db.patch(jobId, {
          status: "running",
          lastProgressAt: Date.now() - 60 * 60 * 1000,
        });
      });

    const attempts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId });
      attempts.push(r.attempt);
      expect(r.resumedAt).toBe(0);
      expect(r.quarantined).toBeNull();
      await killMidProposal();
    }
    expect(attempts).toEqual([1, 2, 3]);

    const gaveUp = await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId });
    expect(gaveUp.quarantined).toBe("poison");
    expect(gaveUp.resumedAt).toBe(1);
    expect(gaveUp.attempt).toBe(1);

    // Loud, not silent: a person can read which estimate the mirror gave up on
    // rather than deduce it from a total that never reaches 736.
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.errors.at(-1)?.firestoreId).toBe("poison");
    const reports = await t.run(async (ctx) => ctx.db.query("syncProposalReports").collect());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toMatch(/Quarantined/);

    const next = await t.query(internal.sync.syncMutations.nextQueuedProposal, { jobId });
    expect(next.proposalFsId).toBe("b");
  });

  it("counts attempts against the cursor, not against the run", async () => {
    // Two failures at different proposals are two first attempts. Counting them
    // against the run would quarantine a healthy estimate after three unrelated
    // hiccups spread across the estate.
    const { t } = await ownerHarness();
    const jobId = await seedJob(t, {
      status: "failed",
      proposalQueue: ["a", "b", "c"],
      processedProposals: 0,
    });
    expect(
      (await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId })).attempt
    ).toBe(1);

    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { status: "failed", processedProposals: 1 });
    });
    expect(
      (await t.mutation(internal.sync.syncMutations.resumeEstateSync, { jobId })).attempt
    ).toBe(1);
  });
});

describe("progress is measured, not asserted", () => {
  it("takes the total from the queue it actually built", async () => {
    // The predecessor hard-coded 623 against a live 736, so its own progress
    // report was wrong by 15% from the first tick.
    const { t } = await ownerHarness();
    const jobId = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "full",
      totalProposals: 0,
    });
    if (!jobId) throw new Error("fixture: expected a job");

    await t.mutation(internal.sync.syncMutations.setSyncJobQueue, {
      jobId,
      proposalQueue: ["a", "b", "c", "d"],
    });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.totalProposals).toBe(4);
  });

  it("walks the queue and stops at the end", async () => {
    const { t } = await ownerHarness();
    const jobId = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "full",
      totalProposals: 0,
    });
    if (!jobId) throw new Error("fixture: expected a job");
    await t.mutation(internal.sync.syncMutations.setSyncJobQueue, {
      jobId,
      proposalQueue: ["a", "b"],
    });

    const seen: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await t.query(internal.sync.syncMutations.nextQueuedProposal, { jobId });
      seen.push(next.proposalFsId);
      if (next.proposalFsId === null) break;
      await t.mutation(internal.sync.syncMutations.recordProposalOutcome, {
        jobId,
        atIndex: next.index,
        firestoreId: next.proposalFsId,
        proposalNumber: "n/a",
        byLevel: {
          proposal: { insert: 0, patch: 0, unchanged: 1, orphaned: 0, localOnly: 0, duplicate: 0 },
          wbs: { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 },
          phase: { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 },
          activity: { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 },
        },
        suppressedLinks: 0,
        unresolved: 0,
        durationMs: 1,
      });
    }
    expect(seen).toEqual(["a", "b", null]);
  });

  it("drops an outcome whose claimed index the cursor has already passed", async () => {
    // A blind `+ 1` is only safe while exactly one chain is alive, and nothing
    // enforces that: a hop the scheduler ran twice, or a zombie chain from a run
    // that was reclaimed and then resumed, would each add one and step the
    // cursor over a proposal NOBODY visited. That is the one failure this design
    // cannot detect afterwards — the pass reports 736 done and the estimate
    // nobody read stays stale for ever.
    const { t } = await ownerHarness();
    const jobId = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "full",
      totalProposals: 0,
    });
    if (!jobId) throw new Error("fixture: expected a job");
    await t.mutation(internal.sync.syncMutations.setSyncJobQueue, {
      jobId,
      proposalQueue: ["a", "b", "c"],
    });

    const zero = { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 };
    const record = async (atIndex: number) =>
      await t.mutation(internal.sync.syncMutations.recordProposalOutcome, {
        jobId,
        atIndex,
        firestoreId: "fs-a",
        proposalNumber: "2042",
        byLevel: { proposal: zero, wbs: zero, phase: zero, activity: { ...zero, patch: 1 } },
        suppressedLinks: 0,
        unresolved: 0,
        durationMs: 1,
      });

    expect((await record(0)).applied).toBe(true);
    // The duplicate. Under a blind increment the cursor would reach 2 and
    // proposal "b" would be skipped in silence.
    expect((await record(0)).applied).toBe(false);

    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.processedProposals).toBe(1);
    expect(job?.updatedRecords).toBe(1);
    const next = await t.query(internal.sync.syncMutations.nextQueuedProposal, { jobId });
    expect(next.proposalFsId).toBe("b");
  });

  it("writes a report row only when a proposal actually changed", async () => {
    // A heartbeat for every proposal, a report row only for news. Otherwise a
    // 736-proposal pass buries its three real changes in 736 rows of nothing.
    const { t } = await ownerHarness();
    const jobId = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "full",
      totalProposals: 0,
    });
    if (!jobId) throw new Error("fixture: expected a job");

    const zero = { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 };
    let atIndex = 0;
    const record = async (activity: typeof zero) =>
      await t.mutation(internal.sync.syncMutations.recordProposalOutcome, {
        jobId,
        atIndex: atIndex++,
        firestoreId: "fs-x",
        proposalNumber: "2042",
        byLevel: { proposal: zero, wbs: zero, phase: zero, activity },
        suppressedLinks: 3,
        unresolved: 0,
        durationMs: 1,
      });

    await record({ ...zero, unchanged: 500 });
    expect(await t.run(async (ctx) => ctx.db.query("syncProposalReports").collect())).toHaveLength(
      0
    );

    await record({ ...zero, patch: 2, unchanged: 498 });
    const reports = await t.run(async (ctx) => ctx.db.query("syncProposalReports").collect());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.counts.patch).toBe(2);

    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.processedProposals).toBe(2);
    expect(job?.unchangedRecords).toBe(998);
    expect(job?.updatedRecords).toBe(2);
    // The running proof that the link repair is being protected, pass by pass.
    expect(job?.suppressedLinks).toBe(6);
    expect(job?.lastProgressAt).toBeGreaterThan(0);
  });

  it("reports a refused orphan scan even though it moved no counter", async () => {
    // A refusal means a level read back EMPTY while Convex holds rows for it —
    // an entire estimate's lines apparently gone. Refusing to sweep them is
    // right; leaving the fact out of the change log is not, and none of the
    // counters can carry it, because refusing IS the decision not to move any.
    const { t } = await ownerHarness();
    const jobId = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      mode: "full",
      totalProposals: 0,
    });
    if (!jobId) throw new Error("fixture: expected a job");

    const zero = { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 };
    await t.mutation(internal.sync.syncMutations.recordProposalOutcome, {
      jobId,
      atIndex: 0,
      firestoreId: "fs-quiet",
      proposalNumber: "2042",
      byLevel: { proposal: zero, wbs: zero, phase: zero, activity: { ...zero, unchanged: 680 } },
      suppressedLinks: 0,
      unresolved: 0,
      orphanScanRefused: true,
      durationMs: 1,
    });

    const reports = await t.run(async (ctx) => ctx.db.query("syncProposalReports").collect());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.orphanScanRefused).toBe(true);
  });
});

describe("D1 survives chunking", () => {
  it("refuses a tree claimed by Precision between chunks", async () => {
    // The window the old comment documented and could not close: ownership was
    // checked only where the proposal was looked up, so a claim landing between
    // chunks left the earlier chunks already reverted.
    const { t } = await ownerHarness();
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const resolved = first.resolved;
    if (!resolved) throw new Error("fixture: expected resolved parents");

    await t.run(async (ctx) => {
      await ctx.db.patch(resolved.proposalId, { precisionOwnedAt: Date.now() });
    });

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [],
      activitiesList: [activityRow({ firestoreId: "fs-act-2", quantity: 7 })],
      resolved,
    });
    expect(second.skipped).toBe(1);
    expect(second.skipReason).toBe("precision_owned");
    expect(await t.run(async (ctx) => (await ctx.db.query("activities").collect()).length)).toBe(1);
  });

  it("stops when the proposal was deleted between chunks", async () => {
    const { t } = await ownerHarness();
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());
    const resolved = first.resolved;
    if (!resolved) throw new Error("fixture: expected resolved parents");
    await t.run(async (ctx) => {
      await ctx.db.delete(resolved.proposalId);
    });

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [],
      activitiesList: [activityRow({ firestoreId: "fs-act-2" })],
      resolved,
    });
    expect(second.skipReason).toBe("deleted_in_precision");
  });
});

describe("a chunked tree costs what an unchunked one costs", () => {
  it("threads the resolved parents through instead of re-deriving them", async () => {
    // The link-repair lesson in its positive form. Without `resolved`, this
    // second call would re-collect the proposal's whole phase list to answer a
    // question the first call already answered — and it is the second call, not
    // the first, that a 10K-activity estimate makes ten of.
    const { t } = await ownerHarness();
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [wbsRow()],
      phasesList: [phaseRow()],
      activitiesList: [],
    });
    const resolved = first.resolved;
    if (!resolved) throw new Error("fixture: expected resolved parents");
    expect(resolved.phases).toHaveLength(1);

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [],
      activitiesList: [activityRow()],
      resolved,
      continuation: true,
    });
    expect(second.byLevel.activity.insert).toBe(1);
    expect(second.unresolved).toBe(0);
    // The proposal row was decided by the first call and must not be counted,
    // let alone written, again.
    expect(second.byLevel.proposal).toEqual({
      insert: 0,
      patch: 0,
      unchanged: 0,
      orphaned: 0,
      localOnly: 0,
      duplicate: 0,
    });
  });

  it("forecasts a new estimate's chunks as one insert, not one per chunk", async () => {
    // A dry run of an estimate that does not exist yet resolves no parent ids at
    // all, so `continuation` is the only thing stopping every chunk from
    // forecasting the same new proposal again.
    const { t } = await ownerHarness();
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...tree({ activities: [] }),
      dryRun: true,
    });
    const second = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: proposalRow(),
      wbsList: [],
      phasesList: [],
      activitiesList: [activityRow()],
      continuation: true,
      dryRun: true,
    });
    expect(first.byLevel.proposal.insert).toBe(1);
    expect(second.byLevel.proposal.insert).toBe(0);
  });
});

describe("a dry run forecasts without writing", () => {
  it("reports the whole tree as inserts and leaves the database empty", async () => {
    const { t } = await ownerHarness();
    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...tree(),
      dryRun: true,
    });
    expect(result.inserted).toBe(4);
    // Children of a proposal that was never inserted have no parent to resolve
    // to. Reporting them as unresolved would forecast the opposite of the truth.
    expect(result.unresolved).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("activities").collect()).length)).toBe(0);
  });

  it("forecasts a patch against a tree that already exists", async () => {
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, tree());

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...tree({ activities: [activityRow({ quantity: 3 })] }),
      dryRun: true,
    });
    expect(result.updated).toBe(1);
    expect((await storedActivity(t, "fs-act-1")).quantity).toBe(12);
  });
});

// ============================================================================
// The same claim, made against the real mappers instead of hand-written rows
// ============================================================================

/**
 * Firestore's REST encoding, built by hand.
 *
 * WHY NOT REUSE THE ROWS ABOVE. Those are what the mappers are BELIEVED to
 * emit. The economic case for the whole design rests on mapper output comparing
 * equal to what Convex stored last time, and every way that could fail lives in
 * the encoding: an `integerValue` arrives as the string `"28"`, a `mapValue`
 * nests, a `timestampValue` becomes a number, an absent optional becomes an
 * explicitly-`undefined` key that Convex will drop on write and return absent.
 * A hand-written row skips all of it and proves nothing about production.
 */
const fsString = (value: string) => ({ stringValue: value });
const fsDouble = (value: number) => ({ doubleValue: value });
const fsInt = (value: number) => ({ integerValue: String(value) });
const fsBool = (value: boolean) => ({ booleanValue: value });
const fsTimestamp = (iso: string) => ({ timestampValue: iso });
const fsNull = () => ({ nullValue: null });
const fsMap = (fields: FirestoreDocument["fields"]) => ({ mapValue: { fields } });

function fsDoc(collection: string, id: string, fields: FirestoreDocument["fields"]) {
  return {
    name: `projects/mcp-estimator/databases/(default)/documents/${collection}/${id}`,
    fields,
  };
}

const FS_PROPOSAL = fsDoc("proposals", "P1", {
  proposalNumber: fsString("2042.01"),
  proposalDescription: fsString("GND DEBOTTLENECKING"),
  proposalOwner: fsString("Chevron Phillips"),
  proposalStatus: fsString("Bidding"),
  bidType: fsString("Lump Sum"),
  projectCity: fsString("Baytown"),
  projectState: fsString("TX"),
  jobSiteAddress: fsString("2000 Independence Pkwy"),
  proposalEstimators: fsString("RS, CW"),
  proposalDateReceived: fsTimestamp("2026-01-14T00:00:00.000Z"),
  proposalDateDue: fsString("02/28/2026"),
  job: fsString("J-8814"),
  coNumber: fsNull(),
  craftBaseRate: fsDouble(52.5),
  weldBaseRate: fsInt(61),
  subsistenceRate: fsDouble(0),
  burdenRate: fsDouble(0.3875),
  overheadRate: fsDouble(0.12),
  consumablesRate: fsDouble(0.035),
  fuelRate: fsDouble(0.02),
  rigRate: fsDouble(0),
  useTaxRate: fsDouble(0.0825),
  salesTaxRate: fsDouble(0.0825),
  laborProfitRate: fsDouble(0.15),
  materialProfitRate: fsDouble(0.1),
  equipmentProfitRate: fsDouble(0.1),
  subContractorProfitRate: fsDouble(0.05),
  rigProfitRate: fsDouble(0),
});

const FS_WBS = fsDoc("wbs", "W1", {
  proposalId: fsString("P1"),
  wbsDatabaseId: fsInt(70000),
  name: fsString("AG PIPING"),
});

const FS_PHASE = fsDoc("phase", "H1", {
  proposalId: fsString("P1"),
  wbsId: fsString("W1"),
  phaseDatabaseId: fsInt(70001),
  phaseDatabaseName: fsString("CARBON STEEL"),
  phaseNumber: fsInt(1),
  description: fsString("UNIT 4 RACK"),
  area: fsString("NORTH"),
  sheet: fsInt(12),
  size: fsString('6"'),
  spec: fsString("CS150"),
  completed: fsBool(false),
});

/** A labor line: nested `constant` map, an integer pool id, a float constant. */
const FS_ACTIVITY_LABOR = fsDoc("activities", "A1", {
  proposalId: fsString("P1"),
  wbsId: fsString("W1"),
  phaseId: fsString("H1"),
  activityType: fsString("laborItem"),
  description: fsString("EXCAVATE, LIGHT (CLASS C - GRAVEL)"),
  quantity: fsDouble(12.5),
  constant: fsMap({
    id: fsInt(28),
    craftConstant: fsDouble(0.55),
    weldConstant: fsDouble(0),
    craftUnits: fsString("CY"),
    sortOrder: fsInt(3),
  }),
  equipment: fsNull(),
  dateAdded: fsInt(1_700_000_000_000),
});

/** An equipment line: the other nested map, an ownership enum, a unit price. */
const FS_ACTIVITY_EQUIPMENT = fsDoc("activities", "A2", {
  proposalId: fsString("P1"),
  wbsId: fsString("W1"),
  phaseId: fsString("H1"),
  activityType: fsString("equipmentItem"),
  description: fsString("EXCAVATOR, 30 TON"),
  quantity: fsInt(2),
  unit: fsString("MO"),
  sortOrder: fsInt(7),
  price: fsDouble(14250.75),
  time: fsDouble(1.5),
  equipmentOwnership: fsString("Rental"),
  equipment: fsMap({ id: fsInt(4102), name: fsString("EXCAVATOR, 30 TON") }),
  constant: fsNull(),
});

/** Exactly what a mirror pass hands the mutation, from the real mappers. */
function mappedTree() {
  return {
    proposal: mapProposal(parseDocument(FS_PROPOSAL)),
    wbsList: [mapWBS(parseDocument(FS_WBS))],
    phasesList: [mapPhase(parseDocument(FS_PHASE))],
    activitiesList: [
      mapActivity(parseDocument(FS_ACTIVITY_LABOR)),
      mapActivity(parseDocument(FS_ACTIVITY_EQUIPMENT)),
    ],
  };
}

describe("real mapper output settles to unchanged", () => {
  it("writes nothing on a second pass over identical Firestore documents", async () => {
    const { t } = await ownerHarness();
    const first = await t.mutation(
      internal.sync.syncMutations.upsertProposalHierarchy,
      mappedTree()
    );
    expect(first.inserted).toBe(5); // proposal + wbs + phase + 2 activities

    const second = await t.mutation(
      internal.sync.syncMutations.upsertProposalHierarchy,
      mappedTree()
    );
    // The whole economic case in one assertion: a field that fails to round-trip
    // turns 352,969 rows into 352,969 writes a pass, every pass, for ever.
    expect(second.updated).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(5);
    expect(second.unresolved).toBe(0);
  });

  it("keeps settling across a third pass", async () => {
    // A field that alternates rather than drifts would look settled after one
    // repeat and rewrite for ever in production.
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, mappedTree());
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, mappedTree());
    const third = await t.mutation(
      internal.sync.syncMutations.upsertProposalHierarchy,
      mappedTree()
    );
    expect(third.unchanged).toBe(5);
  });

  it("settles a tree that arrives in chunks, as a large estimate does", async () => {
    // The engine splits phases at 500 and activities at 1000 and threads
    // `resolved` through. If a later chunk derives a parent id differently from
    // the first, every activity of every large estimate patches on every pass —
    // and large estimates are exactly where that costs the most.
    const { t } = await ownerHarness();
    const tree = mappedTree();

    const seed = async () => {
      const head = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
        proposal: tree.proposal,
        wbsList: tree.wbsList,
        phasesList: tree.phasesList,
        activitiesList: [],
      });
      if (!head.resolved) throw new Error("fixture: expected resolved parents");
      const tail = [];
      for (const activity of tree.activitiesList) {
        tail.push(
          await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
            proposal: tree.proposal,
            wbsList: [],
            phasesList: [],
            activitiesList: [activity],
            resolved: head.resolved,
            continuation: true,
          })
        );
      }
      return { head, tail };
    };

    const first = await seed();
    expect(first.head.inserted).toBe(3);
    expect(first.tail.map((r) => r.inserted)).toEqual([1, 1]);

    const second = await seed();
    expect(second.head.updated).toBe(0);
    expect(second.head.unchanged).toBe(3);
    expect(second.tail.map((r) => r.updated)).toEqual([0, 0]);
    expect(second.tail.map((r) => r.unchanged)).toEqual([1, 1]);
    expect(second.tail.map((r) => r.unresolved)).toEqual([0, 0]);
  });

  it("leaves every Convex-only column alone, including through a real edit", async () => {
    // The differ compares only the fields the mapper emits, and this is the
    // list that depends on it: the rate book an estimate is pinned to, the
    // normalized contact, the navigation flag, the per-line takeoff override,
    // the cached total. None of them exists in the MCP Estimator, so a differ
    // driven by a hard-coded roster instead of the incoming row's own keys would
    // clear all five and nobody would find out until a bid came out wrong.
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, mappedTree());

    const activity = await storedActivity(t, "A1");
    const contactId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", { name: "J. Ruiz", email: "jr@example.com" })
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(activity._id, { countsTowardTakeoff: true });
      await ctx.db.patch(activity.wbsId, { isHidden: true });
      await ctx.db.patch(activity.proposalId, { contactId, costTotal: 812_450.25 });
    });

    const edited = mappedTree();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...edited,
      activitiesList: [{ ...edited.activitiesList[0], quantity: 31 }, edited.activitiesList[1]],
    });

    const after = await storedActivity(t, "A1");
    expect(after.quantity).toBe(31);
    expect(after.countsTowardTakeoff).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.get(activity.wbsId))?.isHidden)).toBe(true);
    const proposal = await t.run(async (ctx) => ctx.db.get(activity.proposalId));
    expect(proposal?.contactId).toBe(contactId);
    expect(proposal?.costTotal).toBe(812_450.25);
  });

  it("still catches a real edit made in the estimator", async () => {
    // The counterweight: proving nothing is written is worthless if the reason
    // is that nothing is ever written.
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, mappedTree());

    const edited = mappedTree();
    const moved = { ...edited.activitiesList[0], quantity: 40 };
    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      ...edited,
      activitiesList: [moved, edited.activitiesList[1]],
    });
    expect(result.updated).toBe(1);
    expect((await storedActivity(t, "A1")).quantity).toBe(40);
  });
});

describe("the proposals-only pass is differential too", () => {
  it("reports an identical proposal as unchanged and writes nothing", async () => {
    const { t } = await ownerHarness();
    const payload = proposalRow();
    const first = await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [payload],
    });
    expect(first.inserted).toBe(1);

    const second = await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [payload],
    });
    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 1, skipped: 0 });
  });

  it("still writes a proposal whose rates moved", async () => {
    const { t } = await ownerHarness();
    await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [proposalRow()],
    });
    const moved = proposalRow({ rates: { ...RATES_2020, burdenRate: 0.3875001 } });
    const result = await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [moved],
    });
    expect(result.updated).toBe(1);
  });
});
