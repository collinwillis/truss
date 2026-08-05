/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The two things the publish gates cannot work without: a revision that moves
 * when the catalog moves, and a lock that lets go when its owner dies.
 *
 * WHY THE FIRST GROUP IS WORTH THE FIXTURE. `rateBooks.contentRevision` is read
 * by three of eleven gates and by every acknowledgement, and nothing about a
 * missed bump looks wrong: the diff still renders, the signatures still show as
 * given, and G5 still says a current comparison exists. It just says it about a
 * catalog that has since changed. So each writer of a pool row is exercised
 * through the real mutation and the revision is read after it — the assertion
 * `writePoolRow` staying the only writer is supposed to make structural.
 *
 * THE SECOND GROUP IS THE ROUND TRIP. `model/rateBookDiff.ts`,
 * `model/repriceBenchmark.ts` and `model/publishGates.ts` carry no Convex
 * imports at all, so their interfaces and the schema's validators are two
 * transcriptions of one shape with nothing between them. A field added there
 * and not here fails at the insert, which is why the fixtures are built by
 * CALLING those modules rather than by writing out what they are believed to
 * return.
 */
import { describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  DEFAULT_DIFF_THRESHOLDS,
  diffPair,
  newDraftScanState,
  newPoolTally,
  observeDraftRow,
  poolIntegrity,
  summarizeDiff,
  tallyPair,
  type DiffRowInput,
  type DiffSummary,
} from "../convex/model/rateBookDiff";
import {
  emptyBenchmarkAccumulator,
  equipmentRateFacts,
  finalizeBenchmark,
  serializeAccumulator,
  type BenchmarkReport,
} from "../convex/model/repriceBenchmark";
import { STALE_LOCK_MS } from "../convex/model/rateBookAccess";
import { ownerHarness, type Caller } from "./authFixtures";
import type { TestRunner } from "./convexFixtures";

const WBS_CODE = 70000;
const PHASE_CODE = 70001;

interface Draft {
  t: TestRunner;
  as: Caller;
  bookId: Id<"rateBooks">;
  labor: Id<"laborPool">[];
  equipment: Id<"equipmentPool">[];
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/** A ready draft with one phase, two labor rows and one equipment row. */
async function seedDraft(): Promise<Draft> {
  const { t, as } = await ownerHarness();

  const seeded = await t.run(async (ctx) => {
    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber: 2,
      name: "2026 Draft",
      status: "draft",
      isDefault: false,
      createdBy: "fixture",
      createdAt: 0,
      buildState: "ready",
      proposalCount: 0,
    });

    for (const key of ["wbs", "phases", "labor", "equipment"]) {
      await ctx.db.insert("rateBookCounters", { key, next: 90000 });
    }

    await ctx.db.insert("wbsPool", {
      bookId,
      datasetVersion: "v1",
      poolId: WBS_CODE,
      name: "AG PIPING",
      sortOrder: 10,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });
    await ctx.db.insert("phasePool", {
      bookId,
      datasetVersion: "v1",
      poolId: PHASE_CODE,
      wbsPoolId: WBS_CODE,
      name: "CARBON STEEL - A106/A53 (SCH 10/40)",
      sortOrder: 10,
      takeoffUnit: "LF",
      reservedPhaseNumber: false,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });

    const labor: Id<"laborPool">[] = [];
    for (const spec of [
      { poolId: 2738, description: "FSW - ≤.75", craft: 0.6 },
      { poolId: 2739, description: "CUT - 2", craft: 0.25 },
    ]) {
      labor.push(
        await ctx.db.insert("laborPool", {
          bookId,
          datasetVersion: "v1",
          poolId: spec.poolId,
          phasePoolId: PHASE_CODE,
          description: spec.description,
          sortOrder: spec.poolId,
          craftConstant: spec.craft,
          craftUnits: "LF",
          weldConstant: 0,
          weldUnits: "",
          countsTowardTakeoff: false,
          isCustom: false,
          isActive: true,
          rowRevision: 0,
        })
      );
    }

    const equipment = [
      await ctx.db.insert("equipmentPool", {
        bookId,
        datasetVersion: "v1",
        poolId: 1,
        description: "AIR COMPRESSOR 0-185 CFM",
        hourRate: 8,
        dayRate: 64,
        weekRate: 256,
        monthRate: 768,
        sortOrder: 10,
        isCustom: false,
        isActive: true,
        rowRevision: 0,
      }),
    ];

    return { bookId, labor, equipment };
  });

  return { t, as, ...seeded };
}

async function revisionOf(t: TestRunner, bookId: Id<"rateBooks">): Promise<number> {
  const book = await t.run(async (ctx) => ctx.db.get(bookId));
  return must(book, "the draft").contentRevision ?? 0;
}

/**
 * Step the clock between two mutations.
 *
 * `Date.now()` is fixed for the duration of a Convex mutation, and `touchDraft`
 * compares against it so a 300-row apply bumps the revision once rather than
 * three hundred times. Under fake timers every call in a test would otherwise
 * share one millisecond and read as a single transaction — so the clock is
 * stepped exactly as it steps in life. Fake timers rather than real ones because
 * the alternative is a suite that passes or fails on whether a millisecond
 * happened to roll over mid-batch.
 */
function nextTransaction(): void {
  vi.advanceTimersByTime(1);
}

/**
 * ⚠️ THE ADAPTER EVERY CALLER OF THESE TABLES OWES THEM, written out once.
 *
 * Two conversions, and only one of them is cosmetic. `readonly T[]` and `T[]`
 * are the same array at runtime — the pure modules return readonly everywhere
 * and Convex generates `v.array(...)` as mutable — so those are copies the
 * compiler asks for and nothing else. A `Map` is NOT: it is not a Convex value
 * at all, and written straight into a document it comes back as `{}`, so a
 * report that stored `laborReach` as it lives would say "referenced by 0
 * activities" about every changed item and a resumed benchmark would report
 * that no catalog row was ever exercised.
 *
 * Typed against the generated document rather than written free-hand, so a field
 * the schema and the module disagree about fails here instead of at an insert
 * somebody has to reproduce.
 */
type StoredSummary = NonNullable<Doc<"rateBookDiffs">["summary"]>;
type StoredReport = NonNullable<Doc<"rateBookBenchmarks">["report"]>;

function storedSummary(summary: DiffSummary): StoredSummary {
  return {
    ...summary,
    pools: summary.pools.map((pool) => ({
      ...pool,
      duplicatePoolIds: [...pool.duplicatePoolIds],
      missingFromDraft: [...pool.missingFromDraft],
      keyCollisions: [...pool.keyCollisions],
      danglingParentRefs: [...pool.danglingParentRefs],
    })),
    shiftBands: summary.shiftBands.map((band) => ({ ...band, poolIds: [...band.poolIds] })),
    systematicGroups: summary.systematicGroups.map((group) => ({
      ...group,
      exampleDescriptions: [...group.exampleDescriptions],
    })),
    changedLaborPoolIds: [...summary.changedLaborPoolIds],
    changedEquipmentPoolIds: [...summary.changedEquipmentPoolIds],
    deactivatedPoolIds: {
      wbs: [...summary.deactivatedPoolIds.wbs],
      phases: [...summary.deactivatedPoolIds.phases],
      labor: [...summary.deactivatedPoolIds.labor],
      equipment: [...summary.deactivatedPoolIds.equipment],
    },
    bulkEditPools: [...summary.bulkEditPools],
    massChangePools: [...summary.massChangePools],
    takeoffFlagBulkPhases: [...summary.takeoffFlagBulkPhases],
  };
}

function storedReport(report: BenchmarkReport): StoredReport {
  return {
    ...report,
    proposalsExcluded: [...report.proposalsExcluded],
    selfCheckFailures: [...report.selfCheckFailures],
    coverage: { ...report.coverage, neverExercised: [...report.coverage.neverExercised] },
    laborReach: [...report.laborReach].map(([poolId, lines]) => ({ poolId, lines })),
    equipmentReach: [...report.equipmentReach].map(([poolId, lines]) => ({ poolId, lines })),
    equipment: {
      ...report.equipment,
      facts: { ...report.equipment.facts, inversions: [...report.equipment.facts.inversions] },
    },
    movers: {
      byDollarUp: [...report.movers.byDollarUp],
      byDollarDown: [...report.movers.byDollarDown],
      byPercentUp: [...report.movers.byPercentUp],
      byPercentDown: [...report.movers.byPercentDown],
      byItem: [...report.movers.byItem],
    },
    caveats: [...report.caveats],
  };
}

/**
 * Stage an import that adds one labor row, already reviewed and ready to apply.
 *
 * `edits` decides whether two existing rows move as well, and the two callers
 * want opposite answers. The apply test wants both paths in one transaction;
 * the revert test wants NONE, because a revert restores an edited row through
 * `writePoolRow` and would bump the revision through the chokepoint — hiding
 * whether the delete path bumps it at all.
 */
async function stageAddition(
  t: TestRunner,
  bookId: Id<"rateBooks">,
  options: { edits: boolean }
): Promise<Id<"rateBookImports">> {
  return await t.run(async (ctx) => {
    const edited = options.edits ? 2 : 0;
    const importId = await ctx.db.insert("rateBookImports", {
      bookId,
      pool: "labor",
      fileName: "labor.csv",
      uploadedBy: "fixture",
      uploadedAt: 0,
      state: "review",
      stats: {
        total: edited + 1,
        unchanged: 0,
        edited,
        added: 1,
        conflict: 0,
        invalid: 0,
        idDisagrees: 0,
        blankNumericKept: 0,
      },
      coverage: { inFile: edited + 1, inBook: 2 },
    });

    for (const staged of options.edits
      ? [
          { rowNumber: 2, targetPoolId: 2738, craftConstant: 0.66 },
          { rowNumber: 3, targetPoolId: 2739, craftConstant: 0.3 },
        ]
      : []) {
      await ctx.db.insert("rateBookImportRows", {
        importId,
        rowNumber: staged.rowNumber,
        verdict: "edited",
        blocking: false,
        errors: [],
        targetPoolId: staged.targetPoolId,
        description: `row ${staged.targetPoolId}`,
        values: { craftConstant: staged.craftConstant },
        before: { craftConstant: staged.targetPoolId === 2738 ? 0.6 : 0.25 },
      });
    }
    await ctx.db.insert("rateBookImportRows", {
      importId,
      rowNumber: 4,
      verdict: "added",
      blocking: false,
      errors: [],
      description: "WELD OUT - 3",
      values: {
        description: "WELD OUT - 3",
        phasePoolId: PHASE_CODE,
        sortOrder: 40,
        craftConstant: 1.2,
        craftUnits: "LF",
        weldConstant: 0,
        weldUnits: "",
      },
    });

    return importId;
  });
}

describe("the draft's content revision", () => {
  it("moves once for a whole import, not once per row it wrote", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, bookId } = await seedDraft();
      const importId = await stageAddition(t, bookId, { edits: true });

      expect(await revisionOf(t, bookId)).toBe(0);

      nextTransaction();
      await as.mutation(api.rateBooks.applyImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // Three rows written — two edits through `writePoolRow` and one insert
      // through `insertPoolRow` — in one `applyImportBatch` transaction. Convex
      // coalesces the repeated patches into one document write, and G5's "it has
      // been written to N times since you looked" has to mean transactions or
      // this one import reads as three.
      expect(await revisionOf(t, bookId)).toBe(1);

      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("laborPool")
          .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
          .collect()
      );
      expect(rows).toHaveLength(3);
      expect(
        must(
          rows.find((row) => row.poolId === 2738),
          "the edited row"
        ).craftConstant
      ).toBe(0.66);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves for every way a row can be written, including the one that deletes", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, bookId, labor, equipment } = await seedDraft();
      const seen: number[] = [];

      nextTransaction();
      await as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId: must(labor[0], "the first labor row"),
        field: "craftConstant",
        value: 0.7,
        expectedRevision: 0,
      });
      seen.push(await revisionOf(t, bookId));

      nextTransaction();
      await as.mutation(api.catalog.addCatalogRow, {
        bookId,
        pool: "labor",
        parentPoolId: PHASE_CODE,
        values: {
          description: "BEVEL - 4",
          craftConstant: 0.4,
          craftUnits: "LF",
          weldConstant: 0,
          weldUnits: "",
        },
      });
      seen.push(await revisionOf(t, bookId));

      nextTransaction();
      await as.mutation(api.catalog.setCatalogRowRetired, {
        bookId,
        pool: "labor",
        rowId: must(labor[1], "the second labor row"),
        retired: true,
        expectedRevision: 0,
      });
      seen.push(await revisionOf(t, bookId));

      nextTransaction();
      await as.mutation(api.catalog.startBulkAdjust, {
        bookId,
        pool: "equipment",
        fields: ["hourRate", "dayRate", "weekRate", "monthRate"],
        percent: 3,
        rowIds: equipment,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      seen.push(await revisionOf(t, bookId));

      // The delete path, ISOLATED. `revertImportBatch` removes a row an import
      // ADDED without going anywhere near `writePoolRow`, so it is the one
      // writer the chokepoint does not cover — and a revert that left the
      // revision alone would leave the comparison of the catalog as it stood
      // BEFORE the undo reading as current. The import adds and edits nothing,
      // so the revert's only write is the delete: restoring an edited row goes
      // through `writePoolRow` and would bump the revision whatever the delete
      // path did.
      nextTransaction();
      const importId = await stageAddition(t, bookId, { edits: false });
      await as.mutation(api.rateBooks.applyImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const afterApply = await revisionOf(t, bookId);

      nextTransaction();
      await as.mutation(api.rateBooks.revertImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const afterRevert = await revisionOf(t, bookId);

      expect(seen).toEqual([1, 2, 3, 4]);
      expect(afterApply).toBe(5);
      expect(afterRevert).toBe(6);

      const remaining = await t.run(async (ctx) =>
        ctx.db
          .query("laborPool")
          .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
          .collect()
      );
      expect(remaining.some((row) => row.description === "WELD OUT - 3")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not move when a write is refused", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, bookId, labor } = await seedDraft();

      nextTransaction();
      await as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId: must(labor[0], "the first labor row"),
        field: "craftConstant",
        value: 0.7,
        expectedRevision: 0,
      });
      expect(await revisionOf(t, bookId)).toBe(1);

      // A stale edit is refused by `writePoolRow`'s revision guard, and the
      // whole transaction rolls back with it. A revision that moved on a write
      // nobody made would void every signature on the draft for nothing.
      nextTransaction();
      await expect(
        as.mutation(api.catalog.updateCatalogRow, {
          bookId,
          pool: "labor",
          rowId: must(labor[0], "the first labor row"),
          field: "craftConstant",
          value: 0.9,
          expectedRevision: 0,
        })
      ).rejects.toThrow();
      expect(await revisionOf(t, bookId)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the stale-lock reaper", () => {
  /** Put a lock on the draft that was last refreshed `agoMs` ago. */
  async function lockDraft(
    t: TestRunner,
    bookId: Id<"rateBooks">,
    op: NonNullable<Doc<"rateBooks">["lock"]>["op"],
    agoMs: number
  ): Promise<void> {
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(bookId, {
        lock: { op, startedBy: "someone", startedAt: now - agoMs, heartbeatAt: now - agoMs },
      });
    });
  }

  it("leaves a lock that is still being refreshed exactly as it found it", async () => {
    const { t, bookId } = await seedDraft();
    await lockDraft(t, bookId, "bulkEdit", 60_000);

    await t.mutation(internal.rateBooks.reapStaleLocks, {});

    const book = await t.run(async (ctx) => ctx.db.get(bookId));
    expect(must(book, "the draft").lock?.op).toBe("bulkEdit");
  });

  it("clears a dead bulk adjustment's lock and says the run stopped", async () => {
    const { t, bookId, equipment } = await seedDraft();
    const runId = await t.run(async (ctx) =>
      ctx.db.insert("catalogBulkRuns", {
        bookId,
        pool: "equipment",
        fields: ["hourRate"],
        percent: 3,
        rowIds: equipment,
        state: "running",
        cursor: 0,
        startedBy: "someone",
        startedAt: Date.now() - STALE_LOCK_MS,
        lastProgressAt: Date.now() - STALE_LOCK_MS,
        tally: { selected: 1, adjusted: 0, missing: 0, unchanged: 0 },
        skipped: [],
      })
    );
    await lockDraft(t, bookId, "bulkEdit", STALE_LOCK_MS + 60_000);

    const result = await t.mutation(internal.rateBooks.reapStaleLocks, {});
    expect(result.reaped).toHaveLength(1);

    const book = await t.run(async (ctx) => ctx.db.get(bookId));
    expect(must(book, "the draft").lock).toBeUndefined();

    // Marked failed rather than left `running`, because `resumeBulkAdjust` reads
    // a state and a run that silently disappeared must not look like one that
    // finished. The rows it already wrote stay written; its cursor advanced in
    // the same transaction as its writes, so the resume re-does only what never
    // landed.
    const run = must(await t.run(async (ctx) => ctx.db.get(runId)), "the adjustment");
    expect(run.state).toBe("failed");
    expect(run.error).toContain("stopped without finishing");
  });

  it("turns a clone that died into a draft that can be retried", async () => {
    const { t, as, bookId } = await seedDraft();
    await t.run(async (ctx) => {
      await ctx.db.patch(bookId, {
        buildState: "building",
        parentBookId: bookId,
        buildCursor: { pool: "laborPool", lastPoolId: 2738, done: 0, total: 0 },
      });
    });
    await lockDraft(t, bookId, "clone", STALE_LOCK_MS + 1);

    await t.mutation(internal.rateBooks.reapStaleLocks, {});

    const book = must(await t.run(async (ctx) => ctx.db.get(bookId)), "the draft");
    expect(book.buildState).toBe("failed");
    expect(book.lock).toBeUndefined();

    // The point of marking it failed rather than merely unlocking it: a draft
    // stuck at `building` refuses every edit AND refuses `retryDraftBuild`, so
    // the single draft slot is held by something that will never finish.
    await expect(as.mutation(api.rateBooks.retryDraftBuild, { bookId })).resolves.toBeNull();
  });

  it("fails the diff and benchmark runs whose lock it releases", async () => {
    const { t, bookId } = await seedDraft();
    const seeded = await t.run(async (ctx) => {
      const diffId = await ctx.db.insert("rateBookDiffs", {
        bookId,
        parentBookId: bookId,
        state: "running",
        startedBy: "someone",
        startedAt: Date.now() - STALE_LOCK_MS,
        startedAtContentRevision: 0,
      });
      const benchmarkId = await ctx.db.insert("rateBookBenchmarks", {
        bookId,
        parentBookId: bookId,
        state: "running",
        startedBy: "someone",
        startedAt: Date.now() - STALE_LOCK_MS,
        basedOnContentRevision: 0,
      });
      return { diffId, benchmarkId };
    });

    await lockDraft(t, bookId, "diff", STALE_LOCK_MS + 1);
    await t.mutation(internal.rateBooks.reapStaleLocks, {});
    expect(must(await t.run(async (ctx) => ctx.db.get(seeded.diffId)), "the diff").state).toBe(
      "failed"
    );
    // The benchmark's own lock had not been taken, so its run is untouched — the
    // reaper fails the job that held the lock it released, never every job on the
    // book.
    expect(
      must(await t.run(async (ctx) => ctx.db.get(seeded.benchmarkId)), "the benchmark").state
    ).toBe("running");

    await lockDraft(t, bookId, "benchmark", STALE_LOCK_MS + 1);
    await t.mutation(internal.rateBooks.reapStaleLocks, {});
    expect(
      must(await t.run(async (ctx) => ctx.db.get(seeded.benchmarkId)), "the benchmark").state
    ).toBe("failed");
  });
});

describe("what the pure modules produce, stored", () => {
  it("takes a real DiffSummary and the row it summarized", async () => {
    const { t, bookId } = await seedDraft();

    const parent: DiffRowInput = {
      poolId: 2738,
      parentPoolId: PHASE_CODE,
      description: "FSW - ≤.75",
      rowRevision: 0,
      values: {
        description: "FSW - ≤.75",
        sortOrder: 10,
        craftConstant: 0.6,
        craftUnits: "LF",
        weldConstant: 0,
        weldUnits: "",
        countsTowardTakeoff: false,
        isActive: true,
        phasePoolId: PHASE_CODE,
      },
    };
    // A doubling, so the stored row carries a `large_change` and the flag table
    // has something to be indexed by.
    const draft: DiffRowInput = {
      ...parent,
      rowRevision: 1,
      values: { ...parent.values, craftConstant: 1.2 },
    };

    const scan = newDraftScanState(new Set([PHASE_CODE]));
    const tally = newPoolTally();
    const pair = { poolId: 2738, parent, draft };
    observeDraftRow(scan, "labor", draft, parent);
    const row = must(diffPair("labor", pair, DEFAULT_DIFF_THRESHOLDS), "a diff row");
    tallyPair(tally, pair, row);

    const summary = summarizeDiff({
      pools: [poolIntegrity("labor", tally, scan)],
      rows: [row],
      bands: [],
      groups: [],
      takeoffFlagsByPhase: new Map(),
      thresholds: DEFAULT_DIFF_THRESHOLDS,
    });

    const stored = await t.run(async (ctx) => {
      const diffId = await ctx.db.insert("rateBookDiffs", {
        bookId,
        parentBookId: bookId,
        state: "ready",
        startedBy: "tester",
        startedAt: 1,
        finishedAt: 2,
        startedAtContentRevision: 3,
        finishedAtContentRevision: 3,
        summary: storedSummary(summary),
      });
      const rowId = await ctx.db.insert("rateBookDiffRows", {
        diffId,
        ...row,
        changes: row.changes.map((change) => ({ ...change, flags: [...change.flags] })),
        flags: [...row.flags],
      });
      for (const flag of row.flags) {
        await ctx.db.insert("rateBookDiffRowFlags", {
          diffId,
          rowId,
          flag,
          pool: row.pool,
          poolId: row.poolId,
        });
      }
      return { diffId, rowId };
    });

    const readBack = must(await t.run(async (ctx) => ctx.db.get(stored.diffId)), "the diff");
    expect(readBack.summary?.flagCounts.large_change).toBe(1);
    expect(readBack.summary?.pools[0]?.editedCount).toBe(1);

    // The reason the flags live in their own table: this is the read the review
    // screen makes, and it is impossible over an array field.
    const large = await t.run(async (ctx) =>
      ctx.db
        .query("rateBookDiffRowFlags")
        .withIndex("by_diff_flag", (q) => q.eq("diffId", stored.diffId).eq("flag", "large_change"))
        .collect()
    );
    expect(large.map((entry) => entry.poolId)).toEqual([2738]);
  });

  it("takes a real BenchmarkReport, its two reach maps flattened apart", async () => {
    const { t, bookId } = await seedDraft();

    const report = finalizeBenchmark({
      acc: emptyBenchmarkAccumulator(),
      changedLaborPoolIds: [2738],
      changedEquipmentPoolIds: [1],
      equipmentFacts: equipmentRateFacts(new Map(), new Map()),
      // Id 1 exists in both catalogs and means two different things. One map
      // keyed by a bare poolId would report one item's line count under the
      // other's name, which is why the schema stores two arrays.
      laborReach: new Map([[2738, 12]]),
      equipmentReach: new Map([[1, 501]]),
      reachAvailable: true,
      excludedProposals: [{ proposalNumber: "1956.01", bookId: "someOtherBook" }],
      parentBookName: "Book 1",
      basedOnContentRevision: 3,
      triggeredBy: "tester",
      startedAt: 1,
      finishedAt: 2,
      activityDocumentsRead: 10,
    });

    const benchmarkId = await t.run(async (ctx) =>
      ctx.db.insert("rateBookBenchmarks", {
        bookId,
        parentBookId: bookId,
        state: "ready",
        startedBy: "tester",
        startedAt: 1,
        finishedAt: 2,
        basedOnContentRevision: 3,
        report: storedReport(report),
      })
    );

    const stored = must(await t.run(async (ctx) => ctx.db.get(benchmarkId)), "the benchmark");
    expect(stored.report?.laborReach).toEqual([{ poolId: 2738, lines: 12 }]);
    expect(stored.report?.equipmentReach).toEqual([{ poolId: 1, lines: 501 }]);
    // An empty run measured nothing, and says so rather than printing $0.00.
    expect(stored.report?.measuredNothing).toBe(true);
    expect(stored.report?.caveats.length).toBeGreaterThan(0);
    expect(stored.report?.equipment.facts.tierChangePct.hour).toBeNull();
  });

  it("takes the accumulator snapshot a resumed benchmark reads back", async () => {
    const { t, bookId } = await seedDraft();
    const snapshot = serializeAccumulator(emptyBenchmarkAccumulator());

    const benchmarkId = await t.run(async (ctx) =>
      ctx.db.insert("rateBookBenchmarks", {
        bookId,
        parentBookId: bookId,
        state: "running",
        startedBy: "tester",
        startedAt: 1,
        lastProgressAt: 1,
        basedOnContentRevision: 3,
        progress: { done: 600, total: 713 },
        checkpoint: {
          cursor: null,
          activityDocumentsRead: 1200,
          // `serializeAccumulator`, not a hand-written literal: the live
          // accumulator holds a Set and a Map, and this is the function that
          // knows which two.
          accumulator: {
            ...snapshot,
            exercisedLaborPoolIds: [...snapshot.exercisedLaborPoolIds],
            perItemDelta: [...snapshot.perItemDelta],
          },
        },
      })
    );

    const stored = must(await t.run(async (ctx) => ctx.db.get(benchmarkId)), "the benchmark");
    expect(stored.checkpoint?.accumulator.exercisedLaborPoolIds).toEqual([]);
    expect(stored.checkpoint?.accumulator.perItemDelta).toEqual([]);
    expect(stored.report).toBeUndefined();
  });

  it("takes an acknowledgement, and keeps the revision it was made at", async () => {
    const { t, bookId } = await seedDraft();

    const ackId = await t.run(async (ctx) =>
      ctx.db.insert("rateBookAcknowledgements", {
        bookId,
        key: "flag:zeroed_constant",
        scope: "row",
        flag: "zeroed_constant",
        coveredRowCount: 3,
        atContentRevision: 7,
        by: "someone@indemand",
        at: Date.now(),
        reason: "The three concrete lines really are free under the new subcontract.",
      })
    );

    const atSeven = await t.run(async (ctx) =>
      ctx.db
        .query("rateBookAcknowledgements")
        .withIndex("by_book_revision", (q) => q.eq("bookId", bookId).eq("atContentRevision", 7))
        .collect()
    );
    expect(atSeven.map((ack) => ack._id)).toEqual([ackId]);

    // The read the publish mutation actually makes: only the signatures at the
    // current revision, so one more write to the draft leaves it with none and
    // the read stays bounded however long the draft has been open.
    const atEight = await t.run(async (ctx) =>
      ctx.db
        .query("rateBookAcknowledgements")
        .withIndex("by_book_revision", (q) => q.eq("bookId", bookId).eq("atContentRevision", 8))
        .collect()
    );
    expect(atEight).toEqual([]);
  });
});
