/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The Convex layer of the draft-vs-parent comparison.
 *
 * `rateBookDiff.test.ts` proves what a change MEANS; this proves that the
 * machinery around the pure module hands it the right things in the right order
 * and stores what it produced. Four properties are worth a fixture this size,
 * and all four are invisible in a unit test of any single function:
 *
 *  1. THE PROJECTION. `laborPool` stores `description` and `phasePool` stores
 *     `name`. Reach for the wrong one and `naturalKey` becomes `"undefined"` for
 *     every row in the pool — one key for all 228 phases, which is a collision on
 *     every one of them and blocks G3 for ever. The differ never sees a document,
 *     so nothing downstream can notice.
 *  2. THE PIPELINE ORDER. `shifted_payload`, `description_swap` and
 *     `takeoff_flags_bulk` exist nowhere until a marking step stamps them, so a
 *     run that summarized its raw rows reports zero of each while looking
 *     complete.
 *  3. THE RESUME. A pool that did not finish restarts from its first row and its
 *     already-flushed rows are discarded — and the pools that DID finish, and the
 *     `present` set the next pool checks its parents against, come back off the
 *     checkpoint rather than being recomputed.
 *  4. THE LOCK AND THE STAMPS. The draft is locked while computing and released
 *     before anybody reads, and the revision is recorded at both ends.
 *
 * The fixture is one small catalog carrying one of every finding at once, so the
 * counts are checked against each other as well as against expectations:
 * `unchangedRowCount` is a subtraction over the per-pool tallies, and it only
 * comes out right if every pool was walked and every kind was classified.
 */
import { describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { ownerHarness, type Caller } from "./authFixtures";
import type { TestRunner } from "./convexFixtures";

const WBS_ID = 70000;
const PHASE_A = 70001;
const PHASE_B = 70002;
const PHASE_C = 70003;
/** A phase id no book contains — what a dangling `phasePoolId` looks like. */
const ORPHAN_PHASE = 79999;

/**
 * `DIFF_PAGE` in `convex/rateBookDiff.ts`.
 *
 * Restated rather than imported because the constant is private to the action,
 * and a test that reached for it would pass by construction if it changed — the
 * whole point of the paging test below is that the two sides land on DIFFERENT
 * page counts, which only holds at the real number.
 */
const PAGE_SPAN = 1000;

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture did not seed ${what}`);
  return value;
}

interface LaborSpec {
  poolId: number;
  description: string;
  phasePoolId?: number;
  craftConstant?: number;
  countsTowardTakeoff?: boolean;
  isActive?: boolean;
  retired?: boolean;
}

interface EquipmentSpec {
  poolId: number;
  description: string;
  hourRate: number;
  dayRate: number;
  weekRate: number;
  monthRate: number;
}

interface Seeded {
  t: TestRunner;
  as: Caller;
  parentBookId: Id<"rateBooks">;
  draftBookId: Id<"rateBooks">;
  laborRows: Map<number, Id<"laborPool">>;
}

/**
 * The parent's labor pool: eleven rows, four of which are about to move.
 *
 * The descriptions of 100, 101 and 102 reappear one id higher in the draft. That
 * is the whole shape of the real 1,064-row incident, at the smallest size
 * `shiftBandMin` will call a band.
 */
const PARENT_LABOR: readonly LaborSpec[] = [
  { poolId: 100, description: "FSW - 0.75", craftConstant: 0.6 },
  { poolId: 101, description: "FSW - 1", craftConstant: 0.7 },
  { poolId: 102, description: "FSW - 1.5", craftConstant: 0.8 },
  { poolId: 103, description: "FSW - 2", craftConstant: 0.9 },
  { poolId: 104, description: "CUT - 2", craftConstant: 0.25 },
  { poolId: 105, description: "BEVEL - 2", craftConstant: 0.3 },
  { poolId: 106, description: "GRIND - 2", craftConstant: 0.35 },
  { poolId: 107, description: "FIT - 2", craftConstant: 0.4 },
  { poolId: 108, description: "DROPPED ITEM", craftConstant: 0.5 },
  { poolId: 109, description: "TO RETIRE", craftConstant: 0.5 },
  { poolId: 111, description: "DUPLICATED ITEM", craftConstant: 0.5 },
];

/**
 * The draft's labor pool.
 *
 * 100-103 carry the shifted payload; 104-107 are newly flagged for takeoff,
 * which is four under one phase against a threshold of three; 108 is simply gone;
 * 109 is retired; 110 is new; 111 is written twice with two different constants;
 * 112 is filed under a phase that does not exist.
 */
const DRAFT_LABOR: readonly LaborSpec[] = [
  { poolId: 100, description: "FSW - NEW", craftConstant: 0.6 },
  { poolId: 101, description: "FSW - 0.75", craftConstant: 0.7 },
  { poolId: 102, description: "FSW - 1", craftConstant: 0.8 },
  { poolId: 103, description: "FSW - 1.5", craftConstant: 0.9 },
  { poolId: 104, description: "CUT - 2", craftConstant: 0.25, countsTowardTakeoff: true },
  { poolId: 105, description: "BEVEL - 2", craftConstant: 0.3, countsTowardTakeoff: true },
  { poolId: 106, description: "GRIND - 2", craftConstant: 0.35, countsTowardTakeoff: true },
  { poolId: 107, description: "FIT - 2", craftConstant: 0.4, countsTowardTakeoff: true },
  { poolId: 109, description: "TO RETIRE", craftConstant: 0.5, isActive: false, retired: true },
  { poolId: 110, description: "NEW ITEM", craftConstant: 0.15 },
  { poolId: 111, description: "DUPLICATED ITEM", craftConstant: 0.5 },
  { poolId: 111, description: "DUPLICATED ITEM", craftConstant: 0.9 },
  { poolId: 112, description: "ORPHANED ITEM", craftConstant: 0.2, phasePoolId: ORPHAN_PHASE },
];

const PARENT_EQUIPMENT: readonly EquipmentSpec[] = [
  { poolId: 1, description: "AIR COMPRESSOR 0-185 CFM", ...rates(8, 64, 256, 768) },
  { poolId: 2, description: "MANLIFT - 60'", ...rates(10, 80, 320, 960) },
];

/** A tenfold month rate is a decimal shift; a five-fold day rate inverts the tiers. */
const DRAFT_EQUIPMENT: readonly EquipmentSpec[] = [
  { poolId: 1, description: "AIR COMPRESSOR 0-185 CFM", ...rates(8, 64, 256, 7680) },
  { poolId: 2, description: "MANLIFT - 60'", ...rates(10, 400, 320, 960) },
];

function rates(
  hourRate: number,
  dayRate: number,
  weekRate: number,
  monthRate: number
): Pick<EquipmentSpec, "hourRate" | "dayRate" | "weekRate" | "monthRate"> {
  return { hourRate, dayRate, weekRate, monthRate };
}

/** One book's four pools, written straight to the tables the clone would fill. */
async function seedBook(
  t: TestRunner,
  book: {
    bookNumber: number;
    name: string;
    status: "draft" | "published";
    parentBookId?: Id<"rateBooks">;
  },
  pools: {
    phaseCName: string;
    labor: readonly LaborSpec[];
    equipment: readonly EquipmentSpec[];
  }
): Promise<{ bookId: Id<"rateBooks">; laborRows: { poolId: number; rowId: Id<"laborPool"> }[] }> {
  return await t.run(async (ctx) => {
    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber: book.bookNumber,
      name: book.name,
      status: book.status,
      parentBookId: book.parentBookId,
      isDefault: book.status === "published",
      createdBy: "fixture",
      createdAt: 0,
      buildState: "ready",
      proposalCount: 0,
      rowCounts: {
        wbs: 1,
        phases: 3,
        labor: pools.labor.length,
        equipment: pools.equipment.length,
      },
    });

    await ctx.db.insert("wbsPool", {
      bookId,
      datasetVersion: "v1",
      poolId: WBS_ID,
      name: "AG PIPING",
      sortOrder: 10,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });

    for (const phase of [
      { poolId: PHASE_A, name: "CARBON STEEL - A106/A53 (SCH 10/40)" },
      { poolId: PHASE_B, name: "STAINLESS STEEL" },
      { poolId: PHASE_C, name: pools.phaseCName },
    ]) {
      await ctx.db.insert("phasePool", {
        bookId,
        datasetVersion: "v1",
        poolId: phase.poolId,
        wbsPoolId: WBS_ID,
        name: phase.name,
        sortOrder: phase.poolId,
        takeoffUnit: "LF",
        reservedPhaseNumber: false,
        isCustom: false,
        isActive: true,
        rowRevision: 0,
      });
    }

    const laborRows: { poolId: number; rowId: Id<"laborPool"> }[] = [];
    for (const row of pools.labor) {
      laborRows.push({
        poolId: row.poolId,
        rowId: await ctx.db.insert("laborPool", {
          bookId,
          datasetVersion: "v1",
          poolId: row.poolId,
          phasePoolId: row.phasePoolId ?? PHASE_A,
          description: row.description,
          sortOrder: row.poolId,
          craftConstant: row.craftConstant ?? 0.5,
          craftUnits: "LF",
          weldConstant: 0,
          weldUnits: "",
          countsTowardTakeoff: row.countsTowardTakeoff ?? false,
          isCustom: false,
          isActive: row.isActive ?? true,
          rowRevision: 0,
          ...(row.retired ? { retiredInBookId: bookId } : {}),
        }),
      });
    }

    for (const row of pools.equipment) {
      await ctx.db.insert("equipmentPool", {
        bookId,
        datasetVersion: "v1",
        poolId: row.poolId,
        description: row.description,
        hourRate: row.hourRate,
        dayRate: row.dayRate,
        weekRate: row.weekRate,
        monthRate: row.monthRate,
        sortOrder: row.poolId,
        isCustom: false,
        isActive: true,
        rowRevision: 0,
      });
    }

    return { bookId, laborRows };
  });
}

/** A published parent and the draft cut from it, already diverged. */
async function seedBooks(): Promise<Seeded> {
  const { t, as } = await ownerHarness();
  const parent = await seedBook(
    t,
    { bookNumber: 1, name: "Original Rate Book", status: "published" },
    { phaseCName: "ALLOY", labor: PARENT_LABOR, equipment: PARENT_EQUIPMENT }
  );
  const draft = await seedBook(
    t,
    { bookNumber: 2, name: "2026 Draft", status: "draft", parentBookId: parent.bookId },
    { phaseCName: "ALLOY - HIGH NICKEL", labor: DRAFT_LABOR, equipment: DRAFT_EQUIPMENT }
  );
  return {
    t,
    as,
    parentBookId: parent.bookId,
    draftBookId: draft.bookId,
    laborRows: new Map(draft.laborRows.map((row) => [row.poolId, row.rowId])),
  };
}

/** Start a comparison and let every scheduled function it spawns run to the end. */
async function compare(seeded: Seeded): Promise<Doc<"rateBookDiffs">> {
  const { diffId } = await seeded.as.mutation(api.rateBookDiff.startDiff, {
    bookId: seeded.draftBookId,
  });
  await seeded.t.finishAllScheduledFunctions(vi.runAllTimers);
  return must(await seeded.t.run(async (ctx) => ctx.db.get(diffId)), "the comparison");
}

async function rowsOf(
  t: TestRunner,
  diffId: Id<"rateBookDiffs">
): Promise<Doc<"rateBookDiffRows">[]> {
  return await t.run(async (ctx) =>
    ctx.db
      .query("rateBookDiffRows")
      .withIndex("by_diff", (q) => q.eq("diffId", diffId))
      .collect()
  );
}

async function flagged(
  t: TestRunner,
  diffId: Id<"rateBookDiffs">,
  flag: Doc<"rateBookDiffRowFlags">["flag"]
): Promise<number[]> {
  const entries = await t.run(async (ctx) =>
    ctx.db
      .query("rateBookDiffRowFlags")
      .withIndex("by_diff_flag", (q) => q.eq("diffId", diffId).eq("flag", flag))
      .collect()
  );
  return entries.map((entry) => entry.poolId).sort((a, b) => a - b);
}

function poolOf(
  summary: NonNullable<Doc<"rateBookDiffs">["summary"]>,
  pool: "wbs" | "phases" | "labor" | "equipment"
): NonNullable<Doc<"rateBookDiffs">["summary"]>["pools"][number] {
  return must(
    summary.pools.find((entry) => entry.pool === pool),
    `the ${pool} integrity`
  );
}

/** Every test runs a comparison, and a comparison runs on the scheduler. */
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

describe("comparing a draft against its parent", () => {
  it(
    "counts every pool and stores only the rows that moved",
    withTimers(async () => {
      const seeded = await seedBooks();
      const run = await compare(seeded);

      expect(run.state).toBe("ready");
      expect(run.error).toBeUndefined();
      const summary = must(run.summary, "the summary");

      // All four pools, in the order the reference checks need them.
      expect(summary.pools.map((pool) => pool.pool)).toEqual([
        "wbs",
        "phases",
        "labor",
        "equipment",
      ]);

      const labor = poolOf(summary, "labor");
      expect(labor.draftRowCount).toBe(13);
      expect(labor.parentRowCount).toBe(11);
      expect(labor.missingFromDraft).toEqual([108]);
      expect(labor.duplicatePoolIds).toEqual([111]);
      expect(labor.addedCount).toBe(2);
      expect(labor.deactivatedCount).toBe(1);
      expect(labor.editedCount).toBe(9);
      // ⚠️ The reference check only works because the pools are walked
      // wbs -> phases -> labor and the phase pool's `present` set is threaded
      // into labor's scan. A run that skipped the threading reports no orphan.
      expect(labor.danglingParentRefs).toEqual([{ poolId: 112, parentPoolId: ORPHAN_PHASE }]);
      // Two draft rows sit at id 111 with the same description, and only the
      // first is observed: the second copy is G1's finding, and reporting it as a
      // key collision too would recommend renaming one of them, which is the
      // wrong remedy for a replayed clone batch.
      expect(labor.keyCollisions).toEqual([]);

      // `unchangedRowCount` is a subtraction over the per-pool tallies, so it
      // only lands on the three genuinely untouched rows — the WBS and two of the
      // three phases — if every pool was walked and every kind classified.
      expect(summary.changedRowCount).toBe(16);
      expect(summary.unchangedRowCount).toBe(3);

      const stored = await rowsOf(seeded.t, run._id);
      expect(stored).toHaveLength(16);
      expect(stored.some((row) => row.pool === "wbs")).toBe(false);

      const byId = new Map(stored.map((row) => [`${row.pool}:${row.poolId}`, row]));
      expect(must(byId.get("labor:108"), "the missing row").kind).toBe("missing_in_draft");
      expect(must(byId.get("labor:109"), "the retired row").kind).toBe("deactivated");
      expect(must(byId.get("labor:110"), "the new row").kind).toBe("added");
      expect(must(byId.get("labor:111"), "the duplicate").kind).toBe("duplicate_in_draft");
      // Two identical copies is a replayed clone batch; two that disagree is
      // something else writing a different row at that id, and only one of those
      // is fixed by deleting the extra.
      expect(must(byId.get("labor:111"), "the duplicate").duplicateDiffers).toBe(true);
      expect(summary.deactivatedPoolIds.labor).toEqual([109]);

      expect(summary.flagCounts.decimal_shift).toBe(1);
      expect(summary.flagCounts.rate_tier_inversion).toBe(1);
      expect(summary.flagCounts.large_change).toBe(1);
      expect(await flagged(seeded.t, run._id, "decimal_shift")).toEqual([1]);
      expect(await flagged(seeded.t, run._id, "rate_tier_inversion")).toEqual([2]);

      expect(summary.bulkEditPools).toEqual(["phases", "labor", "equipment"]);
      expect(summary.massChangePools).toEqual(["labor"]);
    })
  );

  it(
    "reads a phase by the field a phase actually stores",
    withTimers(async () => {
      const seeded = await seedBooks();
      const run = await compare(seeded);
      const summary = must(run.summary, "the summary");

      // ⚠️ THE WHOLE POINT. `phasePool` stores `name`, not `description`. A
      // projection that reached for `description` would hand `naturalKey` the
      // string "undefined" for all three phases — one key for the pool, so one
      // collision, and the renamed phase would carry no description at all.
      expect(poolOf(summary, "phases").keyCollisions).toEqual([]);

      const stored = await rowsOf(seeded.t, run._id);
      const phase = must(
        stored.find((row) => row.pool === "phases" && row.poolId === PHASE_C),
        "the renamed phase"
      );
      expect(phase.parentDescription).toBe("ALLOY");
      expect(phase.draftDescription).toBe("ALLOY - HIGH NICKEL");
      expect(phase.parentParentPoolId).toBe(WBS_ID);

      // And the other three pools' name fields, so the same mistake in any one of
      // them is caught here rather than in production.
      const labor = must(
        stored.find((row) => row.pool === "labor" && row.poolId === 110),
        "the new labor row"
      );
      expect(labor.draftDescription).toBe("NEW ITEM");
      const equipment = must(
        stored.find((row) => row.pool === "equipment" && row.poolId === 1),
        "the re-rated compressor"
      );
      expect(equipment.draftDescription).toBe("AIR COMPRESSOR 0-185 CFM");
    })
  );

  it(
    "summarizes the rows the marking steps produced, not the raw ones",
    withTimers(async () => {
      const seeded = await seedBooks();
      const run = await compare(seeded);
      const summary = must(run.summary, "the summary");

      // A run that handed `summarizeDiff` its raw rows reports 0 for both of
      // these while looking entirely finished: neither flag exists until
      // `markShiftedRows` and `markTakeoffFlagBulk` stamp it.
      expect(summary.flagCounts.shifted_payload).toBe(3);
      expect(summary.flagCounts.takeoff_flags_bulk).toBe(4);
      expect(summary.flagCounts.description_swap).toBe(0);

      expect(summary.shiftBands).toHaveLength(1);
      const band = must(summary.shiftBands[0], "the band");
      expect(band.id).toBe("shift:labor:1:101-103");
      expect(band.pool).toBe("labor");
      expect(band.offset).toBe(1);
      expect(band.rowCount).toBe(3);
      expect(summary.takeoffFlagBulkPhases).toEqual([PHASE_A]);

      // The counts and the index agree because both are read off the same stored
      // rows — a cap over a mixed list would show the band and hide everything
      // under it, which is why the flags are rows in a table of their own.
      expect(await flagged(seeded.t, run._id, "shifted_payload")).toEqual([101, 102, 103]);
      expect(await flagged(seeded.t, run._id, "takeoff_flags_bulk")).toEqual([104, 105, 106, 107]);

      const stored = await rowsOf(seeded.t, run._id);
      for (const poolId of [101, 102, 103]) {
        const row = must(
          stored.find((entry) => entry.pool === "labor" && entry.poolId === poolId),
          `labor ${poolId}`
        );
        expect(row.shiftBandId).toBe(band.id);
      }
    })
  );

  it(
    "holds the draft only while computing, and records the revision at both ends",
    withTimers(async () => {
      const seeded = await seedBooks();
      const run = await compare(seeded);

      const book = must(
        await seeded.t.run(async (ctx) => ctx.db.get(seeded.draftBookId)),
        "the draft"
      );
      // Released before anybody reads the result: an admin reading a comparison
      // must not block the import that comparison told them to run, and G0 blocks
      // publish on any lock at all.
      expect(book.lock).toBeUndefined();

      // Two stamps, not one. Equal here because nothing wrote to the catalog
      // while the run was going; G5 blocks when they differ, and it can only see
      // a torn read because both ends are recorded.
      expect(run.startedAtContentRevision).toBe(0);
      expect(run.finishedAtContentRevision).toBe(0);
      expect(run.checkpoint).toBeUndefined();
      expect(run.progress).toBeUndefined();

      const latest = await seeded.as.query(api.rateBookDiff.getLatestDiff, {
        bookId: seeded.draftBookId,
      });
      expect(must(latest, "the latest comparison")._id).toEqual(run._id);
      expect(must(latest, "the latest comparison").bookContentRevision).toBe(0);
    })
  );

  it(
    "refuses to record a review of a comparison the catalog has moved past",
    withTimers(async () => {
      const seeded = await seedBooks();
      const run = await compare(seeded);

      const signed = await seeded.as.mutation(api.rateBookDiff.markDiffReviewed, {
        diffId: run._id,
      });
      expect(signed.reviewedAtContentRevision).toBe(0);

      // One cell, through the one chokepoint, and the draft is a different
      // catalog from the one anybody read.
      vi.advanceTimersByTime(1);
      await seeded.as.mutation(api.catalog.updateCatalogRow, {
        bookId: seeded.draftBookId,
        pool: "labor",
        rowId: must(seeded.laborRows.get(110), "the new labor row"),
        field: "craftConstant",
        value: 0.9,
        expectedRevision: 0,
      });

      // ⚠️ "Reviewed at revision 1" about a comparison of revision 0 is not a
      // stale signature, it is a false one. G5 would block either way; this keeps
      // the record from carrying a statement nobody made.
      await expect(
        seeded.as.mutation(api.rateBookDiff.markDiffReviewed, { diffId: run._id })
      ).rejects.toThrow(/this draft is at 1/);
    })
  );
});

describe("resuming a comparison that stopped part-way", () => {
  it(
    "restarts the unfinished pool and keeps what the finished ones produced",
    withTimers(async () => {
      const seeded = await seedBooks();
      const finished = await compare(seeded);
      const reference = must(finished.summary, "the first summary");

      // A run that got through wbs and phases and died inside labor: the two
      // finished pools and the phase ids labor checks its parents against are on
      // the checkpoint, and two labor rows it had already flushed are not.
      const restarted = await seeded.t.run(async (ctx) => {
        const diffId = await ctx.db.insert("rateBookDiffs", {
          bookId: seeded.draftBookId,
          parentBookId: seeded.parentBookId,
          state: "failed",
          startedBy: "someone",
          startedAt: Date.now() - 1000,
          lastProgressAt: Date.now() - 1000,
          error: "The comparison stopped.",
          startedAtContentRevision: 0,
          checkpoint: {
            poolIndex: 2,
            pools: reference.pools.slice(0, 2),
            bands: [],
            groups: [],
            takeoffFlagsByPhase: [],
            validParentIds: [PHASE_A, PHASE_B, PHASE_C],
          },
        });
        for (const poolId of [999, 1000]) {
          const rowId = await ctx.db.insert("rateBookDiffRows", {
            diffId,
            pool: "labor",
            poolId,
            kind: "edited",
            descriptionsNormalizeEqual: false,
            duplicateDiffers: false,
            changes: [],
            flags: ["large_change"],
          });
          await ctx.db.insert("rateBookDiffRowFlags", {
            diffId,
            rowId,
            flag: "large_change",
            pool: "labor",
            poolId,
          });
        }
        return diffId;
      });

      const resumed = await seeded.as.mutation(api.rateBookDiff.resumeDiff, { diffId: restarted });
      expect(resumed.resumingFrom).toBe("labor");
      await seeded.t.finishAllScheduledFunctions(vi.runAllTimers);

      const run = must(
        await seeded.t.run(async (ctx) => ctx.db.get(restarted)),
        "the resumed comparison"
      );
      expect(run.state).toBe("ready");
      const summary = must(run.summary, "the resumed summary");

      // The two finished pools came back off the checkpoint rather than being
      // walked again, and the two pools after them were walked.
      expect(summary.pools.map((pool) => pool.pool)).toEqual([
        "wbs",
        "phases",
        "labor",
        "equipment",
      ]);
      expect(poolOf(summary, "labor")).toEqual(poolOf(reference, "labor"));
      // Threaded off the checkpoint, not recomputed: labor's parent check is
      // against the phase ids the previous pool observed, and without them the
      // orphan reads as a legitimate row.
      expect(poolOf(summary, "labor").danglingParentRefs).toEqual([
        { poolId: 112, parentPoolId: ORPHAN_PHASE },
      ]);

      const stored = await rowsOf(seeded.t, restarted);
      // The stale rows are gone rather than sitting beside the real ones — every
      // count the summary reads off them would otherwise be two too high.
      expect(stored.some((row) => row.poolId === 999 || row.poolId === 1000)).toBe(false);
      expect(await flagged(seeded.t, restarted, "large_change")).toEqual([2]);
      // Exactly once each: a restart that appended rather than discarded shows up
      // here as two rows at one id, which is indistinguishable from the real
      // duplicate the join exists to catch.
      const laborIds = stored.filter((row) => row.pool === "labor").map((row) => row.poolId);
      expect(new Set(laborIds).size).toBe(laborIds.length);
      // The phases pool was NOT re-walked, so its one changed row is not in this
      // run's rows — the checkpoint carries the counts, not the rows.
      expect(stored.filter((row) => row.pool === "phases")).toHaveLength(0);
    })
  );

  it(
    "gives the draft back when a comparison is cancelled",
    withTimers(async () => {
      const seeded = await seedBooks();
      const { diffId } = await seeded.as.mutation(api.rateBookDiff.startDiff, {
        bookId: seeded.draftBookId,
      });

      const locked = must(
        await seeded.t.run(async (ctx) => ctx.db.get(seeded.draftBookId)),
        "the draft"
      );
      expect(locked.lock?.op).toBe("diff");
      // A second comparison is not a batch of the first one, so the lock refuses
      // it rather than tolerating a matching op the way `requireDraftBook` does.
      await expect(
        seeded.as.mutation(api.rateBookDiff.startDiff, { bookId: seeded.draftBookId })
      ).rejects.toThrow(/already running/);

      await seeded.as.mutation(api.rateBookDiff.cancelDiff, { diffId });
      const cancelled = must(
        await seeded.t.run(async (ctx) => ctx.db.get(seeded.draftBookId)),
        "the draft"
      );
      expect(cancelled.lock).toBeUndefined();
      expect(must(await seeded.t.run(async (ctx) => ctx.db.get(diffId)), "the run").state).toBe(
        "failed"
      );

      // The action was already scheduled. It finds the run cancelled before its
      // first read and stops without complaining, rather than resurrecting it —
      // and it must not leave a summary behind.
      await seeded.t.finishAllScheduledFunctions(vi.runAllTimers);
      const after = must(await seeded.t.run(async (ctx) => ctx.db.get(diffId)), "the run");
      expect(after.state).toBe("failed");
      expect(after.summary).toBeUndefined();
    })
  );

  it(
    "refuses a book with nothing to compare against",
    withTimers(async () => {
      const seeded = await seedBooks();
      await expect(
        seeded.as.mutation(api.rateBookDiff.startDiff, { bookId: seeded.parentBookId })
      ).rejects.toThrow(/published/);

      const orphanDraft = await seedBook(
        seeded.t,
        { bookNumber: 3, name: "Parentless Draft", status: "draft" },
        { phaseCName: "ALLOY", labor: [], equipment: [] }
      );
      await expect(
        seeded.as.mutation(api.rateBookDiff.startDiff, { bookId: orphanDraft.bookId })
      ).rejects.toThrow(/not cloned from another rate book/);
    })
  );
});

describe("the internal contract the action depends on", () => {
  it(
    "hands each row over exactly once, from a cursor it never persists",
    withTimers(async () => {
      const seeded = await seedBooks();
      // ⚠️ THE CURSOR IS WHY THE JOIN CAN BE TRUSTED. Two draft rows sit at id
      // 111 and a page boundary lands between them; a `poolId > last` keyset
      // cursor would skip the second copy, and the duplicate G1 exists to catch
      // would be invisible. A pagination cursor returns every document from
      // exactly one page, so the second copy arrives on the next one.
      const first = await seeded.t.query(internal.rateBookDiff.loadPoolPage, {
        bookId: seeded.draftBookId,
        pool: "labor",
        cursor: null,
        numItems: 11,
      });
      expect(first.rows.map((row) => row.poolId)).toEqual([
        100, 101, 102, 103, 104, 105, 106, 107, 109, 110, 111,
      ]);
      expect(first.isDone).toBe(false);

      const second = await seeded.t.query(internal.rateBookDiff.loadPoolPage, {
        bookId: seeded.draftBookId,
        pool: "labor",
        cursor: first.cursor,
        numItems: 11,
      });
      expect(second.rows.map((row) => row.poolId)).toEqual([111, 112]);
      expect(second.isDone).toBe(true);

      // ⚠️ ABSENCE SURVIVES THE ROUND TRIP. `takeoffUnit` absent, "" and "CY" are
      // three different answers to "does this phase have a takeoff", and only two
      // of them are visible if the projection coalesces on the way out.
      const phases = await seeded.t.query(internal.rateBookDiff.loadPoolPage, {
        bookId: seeded.draftBookId,
        pool: "phases",
        cursor: null,
        numItems: 10,
      });
      const phase = must(phases.rows[0], "a phase");
      expect(phase.description).toBe("CARBON STEEL - A106/A53 (SCH 10/40)");
      expect(phase.parentPoolId).toBe(WBS_ID);
      expect(phase.values.takeoffUnit).toBe("LF");
      expect("reservedPhaseNumber" in phase.values).toBe(true);
    })
  );

  it(
    "does not re-deliver the last page of the side that finished first",
    withTimers(async () => {
      // ⚠️ EVERY OTHER TEST IN THIS FILE FITS BOTH SIDES OF EVERY POOL IN ONE
      // PAGE, so both report `isDone` on the same step and the loop breaks
      // before a second one — which means the rule the join is built on, that a
      // page reaches `mergeJoinStep` exactly once, was never exercised at all.
      // Here the draft's labor pool is exactly one page and the parent's is one
      // row more, so the draft is exhausted while the parent still has a page to
      // go. A side that keeps handing over its last page once it is done puts
      // every still-buffered row in twice, and two rows at one id is
      // indistinguishable from the real duplicate G1 exists to catch — the run
      // reports a duplicate at the id the first page ended on, and the remedy it
      // names is discarding the draft.
      const { t, as } = await ownerHarness();
      const spans = await t.run(async (ctx) => {
        const parentBookId = await ctx.db.insert("rateBooks", {
          bookNumber: 1,
          name: "Original Rate Book",
          status: "published",
          isDefault: true,
          createdBy: "fixture",
          createdAt: 0,
          buildState: "ready",
          proposalCount: 0,
        });
        const draftBookId = await ctx.db.insert("rateBooks", {
          bookNumber: 2,
          name: "Wide Draft",
          status: "draft",
          parentBookId,
          isDefault: false,
          createdBy: "fixture",
          createdAt: 0,
          buildState: "ready",
          proposalCount: 0,
        });
        for (const bookId of [parentBookId, draftBookId]) {
          await ctx.db.insert("wbsPool", {
            bookId,
            datasetVersion: "v1",
            poolId: WBS_ID,
            name: "AG PIPING",
            sortOrder: 10,
            isCustom: false,
            isActive: true,
            rowRevision: 0,
          });
          await ctx.db.insert("phasePool", {
            bookId,
            datasetVersion: "v1",
            poolId: PHASE_A,
            wbsPoolId: WBS_ID,
            name: "CARBON STEEL - A106/A53 (SCH 10/40)",
            sortOrder: 10,
            takeoffUnit: "LF",
            reservedPhaseNumber: false,
            isCustom: false,
            isActive: true,
            rowRevision: 0,
          });
          // 1,000 is `DIFF_PAGE`; the parent's extra row is what forces it onto
          // a second page while the draft is already finished.
          const rows = bookId === parentBookId ? PAGE_SPAN + 1 : PAGE_SPAN;
          for (let index = 0; index < rows; index += 1) {
            await ctx.db.insert("laborPool", {
              bookId,
              datasetVersion: "v1",
              poolId: 1000 + index,
              phasePoolId: PHASE_A,
              description: `ITEM ${1000 + index}`,
              sortOrder: 1000 + index,
              craftConstant: 0.6,
              craftUnits: "LF",
              weldConstant: 0,
              weldUnits: "",
              countsTowardTakeoff: false,
              isCustom: false,
              isActive: true,
              rowRevision: 0,
            });
          }
        }
        return { parentBookId, draftBookId };
      });

      const { diffId } = await as.mutation(api.rateBookDiff.startDiff, {
        bookId: spans.draftBookId,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const run = must(await t.run(async (ctx) => ctx.db.get(diffId)), "the comparison");
      expect(run.state).toBe("ready");

      const labor = poolOf(must(run.summary, "the summary"), "labor");
      expect(labor.duplicatePoolIds).toEqual([]);
      // The parent's extra row is the only finding, which is what proves the
      // join read both pages of the parent rather than stopping with the draft.
      expect(labor.missingFromDraft).toEqual([1000 + PAGE_SPAN]);
      expect(labor.draftRowCount).toBe(PAGE_SPAN);
      expect(labor.parentRowCount).toBe(PAGE_SPAN + 1);
    })
  );
});
