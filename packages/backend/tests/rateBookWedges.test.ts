/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The ways an ordinary day's work could leave a draft that can never be
 * published and can never be fixed.
 *
 * WHY THESE THREE BELONG TOGETHER. Publishing is now gated, and a gate that
 * blocks is only as good as the remedy it names. Each case below ends with a
 * gate blocking correctly, on a fact that is true, whose stated remedy does not
 * work — and the at-most-one-open-draft rule means the admin cannot start again
 * either. That is a worse outcome than the ungated publish these gates replaced,
 * because it arrives after somebody has already done the work.
 *
 *  1. G1 compares `rateBooks.rowCounts` against the rows the comparison
 *     counted, and its remedy is "clone this draft again" — which throws away
 *     every edit and every import in the draft. So the count has to be
 *     maintained by every path that adds or removes a row, not by some of them.
 *  2. G9 blocks while an import is `applying`, and its remedy is "wait for it to
 *     finish". A batch killed by a runtime limit never reaches its own catch, so
 *     it never will — and `resumeImport` is the only door out.
 *  3. The same, through the revert lane, which has its own state and its own
 *     door.
 *
 * The first is proven as an invariant rather than through a gate, because
 * `publishGates.test.ts` already proves what G1 does with a count that
 * disagrees: what was missing is anything proving the count still agrees.
 */
import { describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ownerHarness, type Caller } from "./authFixtures";
import type { TestRunner } from "./convexFixtures";

const WBS_CODE = 70000;
const PHASE_CODE = 70001;

/** Older than the two minutes {@link STALL_AFTER_MS} allows, and not by a hair. */
const LONG_ENOUGH_TO_BE_DEAD = 10 * 60 * 1000;

interface Draft {
  t: TestRunner;
  as: Caller;
  bookId: Id<"rateBooks">;
  laborRowIds: Map<number, Id<"laborPool">>;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/**
 * Step the clock between two mutations.
 *
 * `Date.now()` is fixed for the duration of a Convex mutation and `touchDraft`
 * compares against it, so two writes in one millisecond read as one transaction.
 * Under fake timers every call in a test would otherwise share that millisecond.
 */
function nextTransaction(): void {
  vi.advanceTimersByTime(1);
}

function withTimers(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  };
}

/**
 * A ready draft with two labor rows, and `rowCounts` that agrees with them.
 *
 * The counts are seeded because a book that predates the field has none at all
 * and G1 skips the check entirely — a fixture without them would pass whatever
 * the write paths did.
 */
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
      rowCounts: { wbs: 1, phases: 1, labor: 2, equipment: 0 },
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

    const laborRowIds: { poolId: number; rowId: Id<"laborPool"> }[] = [];
    for (const spec of [
      { poolId: 2738, description: "FSW - ≤.75", craft: 0.6 },
      { poolId: 2739, description: "CUT - 2", craft: 0.25 },
    ]) {
      laborRowIds.push({
        poolId: spec.poolId,
        rowId: await ctx.db.insert("laborPool", {
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
        }),
      });
    }

    return { bookId, laborRowIds };
  });

  return {
    t,
    as,
    bookId: seeded.bookId,
    laborRowIds: new Map(seeded.laborRowIds.map((row) => [row.poolId, row.rowId])),
  };
}

/** An import that adds one labor row, staged and ready to apply. */
async function stageAddition(
  t: TestRunner,
  bookId: Id<"rateBooks">
): Promise<Id<"rateBookImports">> {
  return await t.run(async (ctx) => {
    const importId = await ctx.db.insert("rateBookImports", {
      bookId,
      pool: "labor",
      fileName: "labor.csv",
      uploadedBy: "fixture",
      uploadedAt: 0,
      state: "review",
      stats: {
        total: 1,
        unchanged: 0,
        edited: 0,
        added: 1,
        conflict: 0,
        invalid: 0,
        idDisagrees: 0,
        blankNumericKept: 0,
      },
      coverage: { inFile: 1, inBook: 2 },
    });
    await ctx.db.insert("rateBookImportRows", {
      importId,
      rowNumber: 2,
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

/** What the book claims, and what it actually holds. */
async function countsOf(
  t: TestRunner,
  bookId: Id<"rateBooks">
): Promise<{ recorded: number; counted: number }> {
  const book = must(await t.run(async (ctx) => ctx.db.get(bookId)), "the draft");
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("laborPool")
      .withIndex("by_book", (q) => q.eq("bookId", bookId))
      .collect()
  );
  return { recorded: must(book.rowCounts, "the row counts").labor, counted: rows.length };
}

describe("the book's own row counts", () => {
  it(
    "stay equal to the rows it holds, through every path that adds or removes one",
    withTimers(async () => {
      const { t, as, bookId } = await seedDraft();

      // The grid's door.
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
      expect(await countsOf(t, bookId)).toEqual({ recorded: 3, counted: 3 });

      // ⚠️ THE IMPORTER'S DOOR, and the one that was silently missing. An import
      // that adds a single row left the book claiming one fewer than it held, so
      // G1 blocked publish with "clone this draft again" — which throws the
      // import away, and importing it a second time reproduces the drift.
      nextTransaction();
      const importId = await stageAddition(t, bookId);
      await as.mutation(api.rateBooks.applyImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await countsOf(t, bookId)).toEqual({ recorded: 4, counted: 4 });

      // The revert's delete — the one writer that never goes through
      // `writePoolRow`, and the mirror of the insert above.
      nextTransaction();
      await as.mutation(api.rateBooks.revertImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await countsOf(t, bookId)).toEqual({ recorded: 3, counted: 3 });
    })
  );

  it(
    "are left alone on a book that never had them",
    withTimers(async () => {
      const { t, as, bookId } = await seedDraft();
      await t.run(async (ctx) => ctx.db.patch(bookId, { rowCounts: undefined }));

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

      // Absent stays absent: `backfillRowCounts` owns filling it in, and a count
      // invented from one row's arrival would be a confident wrong number where
      // there had been an honest absence — G1 skips the check when there is none.
      const book = must(await t.run(async (ctx) => ctx.db.get(bookId)), "the draft");
      expect(book.rowCounts).toBeUndefined();
    })
  );
});

describe("an import whose batch died without recording anything", () => {
  it(
    "can be picked up once it has stopped moving, rather than blocking publish for ever",
    withTimers(async () => {
      const { t, as, bookId } = await seedDraft();
      const importId = await stageAddition(t, bookId);

      nextTransaction();
      await as.mutation(api.rateBooks.applyImport, { importId });
      // The scheduled batch is deliberately NOT run: a mutation killed by a
      // runtime limit ("timed out performing too many system operations") is a
      // hard abort that never reaches its own catch, so the record keeps saying
      // `applying` and nothing will ever say otherwise.

      // While it is plausibly alive, the resume refuses — a live apply and a
      // dead one must not be resumed on the same terms.
      await expect(as.mutation(api.rateBooks.resumeImport, { importId })).rejects.toThrow(
        /still working/
      );

      vi.advanceTimersByTime(LONG_ENOUGH_TO_BE_DEAD);
      await as.mutation(api.rateBooks.resumeImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const record = must(await t.run(async (ctx) => ctx.db.get(importId)), "the import");
      expect(record.state).toBe("applied");
      // Once, not twice: `applyImportBatch` skips a row it has already applied,
      // so a resume that re-reads the file cannot add the row a second time.
      expect(await countsOf(t, bookId)).toEqual({ recorded: 3, counted: 3 });
    })
  );

  it(
    "is picked up through the revert lane the same way",
    withTimers(async () => {
      const { t, as, bookId } = await seedDraft();
      const importId = await stageAddition(t, bookId);

      nextTransaction();
      await as.mutation(api.rateBooks.applyImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      nextTransaction();
      await as.mutation(api.rateBooks.revertImport, { importId });
      // Again the batch never runs. `revertImport` is the only door out of
      // `reverting`, and until it accepted a stalled one there was none.
      await expect(as.mutation(api.rateBooks.revertImport, { importId })).rejects.toThrow(
        /still working/
      );

      vi.advanceTimersByTime(LONG_ENOUGH_TO_BE_DEAD);
      await as.mutation(api.rateBooks.revertImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const record = must(await t.run(async (ctx) => ctx.db.get(importId)), "the import");
      expect(record.state).toBe("reverted");
      expect(await countsOf(t, bookId)).toEqual({ recorded: 2, counted: 2 });
    })
  );

  it(
    "keeps saying it is alive across every batch, not only at the door it came in",
    withTimers(async () => {
      const { t, bookId } = await seedDraft();

      // ⚠️ MORE THAN ONE BATCH, which `APPLY_BATCH` puts at 300. A file that
      // fits in one cannot see this: the only sign of life would be the one
      // `applyImport` wrote on its way in, and a long apply would be declared
      // stalled — and resumed from the top under a running one — while it was
      // perfectly healthy. The rows are `unchanged` so the batch paginates
      // without writing a catalog row, which is exactly the case a heartbeat
      // written only beside a write would miss.
      const importId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("rateBookImports", {
          bookId,
          pool: "labor",
          fileName: "labor.csv",
          uploadedBy: "fixture",
          uploadedAt: 0,
          state: "applying",
          lastProgressAt: 0,
          stats: {
            total: 400,
            unchanged: 400,
            edited: 0,
            added: 0,
            conflict: 0,
            invalid: 0,
            idDisagrees: 0,
            blankNumericKept: 0,
          },
          coverage: { inFile: 400, inBook: 2 },
        });
        for (let row = 0; row < 400; row += 1) {
          await ctx.db.insert("rateBookImportRows", {
            importId: id,
            rowNumber: row + 2,
            verdict: "unchanged",
            blocking: false,
            errors: [],
            targetPoolId: 2738,
            description: "FSW - ≤.75",
            values: {},
          });
        }
        return id;
      });

      vi.advanceTimersByTime(LONG_ENOUGH_TO_BE_DEAD);
      const beat = Date.now();
      const first = await t.mutation(internal.rateBooks.applyImportBatch, {
        importId,
        cursor: null,
      });
      expect(first.done).toBe(false);

      const midway = must(await t.run(async (ctx) => ctx.db.get(importId)), "the import");
      expect(midway.state).toBe("applying");
      expect(midway.lastProgressAt).toBe(beat);

      // The revert lane has its own state, its own door and its own batch, so it
      // needs its own sign of life — the same file paginated back the other way.
      await t.run(async (ctx) => ctx.db.patch(importId, { state: "reverting" }));
      vi.advanceTimersByTime(LONG_ENOUGH_TO_BE_DEAD);
      const undoBeat = Date.now();
      const undone = await t.mutation(internal.rateBooks.revertImportBatch, {
        importId,
        cursor: null,
      });
      expect(undone.done).toBe(false);

      const unwinding = must(await t.run(async (ctx) => ctx.db.get(importId)), "the import");
      expect(unwinding.state).toBe("reverting");
      expect(unwinding.lastProgressAt).toBe(undoBeat);
    })
  );

  it(
    "blocks publish for exactly as long as it is unresolved",
    withTimers(async () => {
      const { t, as, bookId } = await seedDraft();
      const importId = await stageAddition(t, bookId);

      nextTransaction();
      await as.mutation(api.rateBooks.applyImport, { importId });

      const stuck = must(
        await as.query(api.rateBooks.getPublishReadiness, {
          bookId,
          typedName: "2026 Draft",
          typedNotes: "notes",
        }),
        "the readiness"
      );
      expect(stuck.blocking.map((gate) => gate.id)).toContain("G9");

      vi.advanceTimersByTime(LONG_ENOUGH_TO_BE_DEAD);
      await as.mutation(api.rateBooks.resumeImport, { importId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const after = must(
        await as.query(api.rateBooks.getPublishReadiness, {
          bookId,
          typedName: "2026 Draft",
          typedNotes: "notes",
        }),
        "the readiness"
      );
      expect(after.blocking.map((gate) => gate.id)).not.toContain("G9");
    })
  );
});
