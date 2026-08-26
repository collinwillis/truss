import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { requirePrecisionAdmin } from "./model/precisionAccess";
import { requireDraftBook } from "./model/rateBookAccess";
import type { PoolKind } from "./model/rateBookCsv";
import {
  DEFAULT_DIFF_THRESHOLDS,
  detectShiftBands,
  diffPair,
  emptyMergeCursor,
  groupSystematic,
  indexParentKey,
  markShiftedRows,
  markTakeoffFlagBulk,
  mergeJoinStep,
  newDraftScanState,
  newPoolTally,
  observeDraftRow,
  poolIntegrity,
  renameObservations,
  summarizeDiff,
  tallyPair,
  type DiffRow,
  type DiffRowInput,
  type DiffSummary,
  type MergeCursor,
  type PoolIntegrity,
  type ShiftBand,
  type SystematicGroup,
} from "./model/rateBookDiff";
import { diffValuesOf } from "./model/rateBookShape";

/**
 * Running a draft-vs-parent comparison, and reading the result.
 *
 * `model/rateBookDiff.ts` decides what a change MEANS and holds no `ctx`; this
 * file is everything else — the paging, the batching, the lock, the checkpoint,
 * and the four tables the answer lands in. The split is the reason the
 * calibration tests can run in plain Node against the two real catalog files.
 *
 * ⚠️ THE PIPELINE ORDER IS A CORRECTNESS PROPERTY, NOT A STYLE. Per pool:
 * `renameObservations` -> `detectShiftBands` -> `markShiftedRows` ->
 * `groupSystematic` -> `markTakeoffFlagBulk`, and only then are the rows
 * flushed. Three of the twelve `DiffFlag`s — `shifted_payload`,
 * `description_swap` and `takeoff_flags_bulk` — exist nowhere until a marking
 * step stamps them, so a run that stored its raw rows would write a summary
 * reporting zero of each and a review screen that cannot list one. Marking after
 * grouping would be worse than useless: a shifted row's "before" is a different
 * item, so folding it into a systematic group of honest re-rates hides the only
 * fact about it that matters.
 *
 * ⚠️ WHY `summarizeDiff` IS HANDED THE ROWS OUT OF THE DATABASE. It runs in
 * {@link finishDiff}, over the documents this run actually stored, rather than
 * over an array carried in the action's memory. That is what makes
 * `summary.flagCounts.decimal_shift` and the length of the `by_diff_flag` list
 * the same number by construction instead of by agreement — and it is the only
 * reading that survives a resume, because a run that restarted at labor no
 * longer holds the wbs and phase rows it wrote an hour ago.
 *
 * ⚠️ THE RESUME UNIT IS A WHOLE POOL. `MergeCursor`'s JSDoc explains why three
 * integers are not enough: `DraftScanState` (a Map and two Sets) and `PoolTally`
 * (plain JSON) accumulate side by side, and checkpointing the half that
 * serializes produces a pool reporting complete row counts with
 * `keyCollisions: []` for everything before the restart, which G3 reads as a
 * clean catalog. So a pool that did not finish is restarted from its first row
 * with a fresh cursor, a fresh scan and a fresh tally, and the rows it already
 * flushed are DELETED first — that is what `by_diff_pool` is for. `poolIntegrity`
 * throws when the scan and the tally disagree, and that throw is deliberately not
 * caught anywhere below: it is the last line of defence against a half-honoured
 * resume, and a run that swallowed it would report a partial catalog as a whole
 * one.
 *
 * @module
 */

/**
 * The order the pools are walked, and it is the reference order, not an
 * alphabet.
 *
 * A phase's parent is a WBS and a labor row's parent is a phase, so walking
 * outward-in makes the previous pool's `present` set the next pool's
 * valid-parent set — the whole reference check for two `Set<number>` of 18 and
 * 228 entries and no extra read. Equipment has no parent and goes last.
 */
const POOL_ORDER: readonly PoolKind[] = ["wbs", "phases", "labor", "equipment"];

/** Which pool holds a pool's parents, or `null` where a pool has none. */
const PARENT_POOL_OF: Readonly<Record<PoolKind, PoolKind | null>> = {
  wbs: null,
  phases: "wbs",
  labor: "phases",
  equipment: null,
};

/**
 * Rows read per side per page.
 *
 * THE ARITHMETIC. {@link loadPoolPage} reads one page from ONE book, so a call is
 * 1,000 documents in one query transaction — 6% of Convex's 16,384-document read
 * ceiling — and a step of the join is two of them. The labor pool is 5,897 draft
 * rows against 5,968 parent rows, so six steps; all four pools together are
 * ~12,540 rows in nine.
 *
 * The two sides are separate calls because Convex allows exactly one `.paginate()`
 * per function execution. That limit costs a round trip and buys the property the
 * join depends on — see {@link loadPoolPage}.
 *
 * ⚠️ WHAT THE NUMBER IS GUARDING. Reading both sides of labor in ONE transaction
 * is 11,865 documents — 72% of the ceiling, the identical margin `stageImport`
 * refused to bet the catalog on, and the shape that killed the activity-link
 * repair: it reloaded a 5,897-row pool inside every batch and the runtime aborted
 * it with "timed out performing too many system operations", which is not an
 * error any catch can record. The run sat in `running` for ever.
 */
const DIFF_PAGE = 1000;

/**
 * Changed rows written per flush mutation.
 *
 * Each row is one insert into `rateBookDiffRows` plus one into
 * `rateBookDiffRowFlags` per flag it carries, and a row can in principle carry
 * the whole twelve-member `DiffFlag` union. So the ceiling case is
 * 250 x 13 = 3,250 writes, 40% of Convex's 8,192-document write ceiling, while
 * the real 1,064-row shift band's rows carry two apiece and land nearer 750.
 * `stageImport` proved 500 rows a mutation at ONE insert each; this is the same
 * budget spent on rows that fan out.
 *
 * Reads per flush: one, the run document. No pool is loaded here.
 */
const FLUSH_BATCH = 250;

/** Rows discarded per call when a pool restarts. Read then deleted, so 1,000 operations. */
const DISCARD_BATCH = 500;

/**
 * Join steps one pool may take before the run gives up on itself.
 *
 * The largest pool is 5,968 rows, six steps at {@link DIFF_PAGE}, so this is
 * sixteen times the largest real pool. It exists because the failure it catches
 * is the worst one available: a paging loop that never terminates holds the
 * draft's lock while refreshing its own heartbeat, so the stale-lock reaper never
 * fires, G0 blocks publish for ever, and the at-most-one-open-draft rule means
 * the admin cannot start again either. Failing loudly at step 101 is strictly
 * better than that.
 */
const MAX_JOIN_STEPS_PER_POOL = 100;

/**
 * How long a `running` comparison may go without progress before
 * {@link resumeDiff} will take it over.
 *
 * A page is a query and a flush is a mutation — seconds. Two minutes of silence
 * means the chain is broken rather than slow, and the same number
 * `activityLinks.resumeLinkRepair` already uses. It is deliberately far shorter
 * than `STALE_LOCK_MS`: the reaper is the backstop that runs unattended, this is
 * the button an admin watching a wedged run can press.
 */
const STALL_AFTER_MS = 120_000;

/**
 * The stored shapes, taken from the schema rather than transcribed.
 *
 * ⚠️ WHY NOT A SECOND SET OF VALIDATORS IN THIS FILE. `rateBookDiffs.checkpoint`
 * and `rateBookDiffRows` are already one transcription of the pure module's
 * interfaces, and `schema.ts`'s own header says the three lists — the module,
 * the schema and `publishGates` — are meant to be read side by side. A third
 * copy here would be a place for them to drift silently, and the drift would
 * show up as a field the action computes and the database never stores. Reading
 * the validators back off the schema makes a new field storable the moment it is
 * declared, and unstorable the moment it is not.
 */
const { diffId: _diffIdField, ...DIFF_ROW_FIELDS } =
  schema.tables.rateBookDiffRows.validator.fields;
const CHECKPOINT_FIELDS = schema.tables.rateBookDiffs.validator.fields.checkpoint.fields;
const POOL_KIND_VALIDATOR = schema.tables.rateBookDiffRows.validator.fields.pool;
const DIFF_FLAG_VALIDATOR = schema.tables.rateBookDiffRowFlags.validator.fields.flag;

/** Everything the finished pools produced, as it is stored between reschedules. */
type DiffCheckpoint = NonNullable<Doc<"rateBookDiffs">["checkpoint"]>;

/** One changed row as `flushDiffRows` receives it — the document minus its parent id. */
type StoredDiffRow = Omit<Doc<"rateBookDiffRows">, "_id" | "_creationTime" | "diffId">;

/** A run that has compared nothing yet. */
function emptyCheckpoint(): DiffCheckpoint {
  return {
    poolIndex: 0,
    pools: [],
    bands: [],
    groups: [],
    takeoffFlagsByPhase: [],
    validParentIds: [],
  };
}

// ============================================================================
// THE READONLY -> MUTABLE ADAPTERS
// ============================================================================

/**
 * The conversion every caller of these tables owes them, written out once.
 *
 * The pure modules return `readonly` arrays everywhere, on purpose: nothing
 * downstream may mutate a summary somebody is about to sign. Convex generates
 * `v.array(...)` as a mutable `T[]`, so the two are the same array at runtime
 * and different types at the boundary. Copying is what the compiler is asking
 * for and nothing more — unlike the benchmark's `Map`s, which are not Convex
 * values at all and come back as `{}` if written as they live.
 */
function storedIntegrity(pool: PoolIntegrity): DiffCheckpoint["pools"][number] {
  return {
    ...pool,
    duplicatePoolIds: [...pool.duplicatePoolIds],
    missingFromDraft: [...pool.missingFromDraft],
    keyCollisions: [...pool.keyCollisions],
    danglingParentRefs: pool.danglingParentRefs.map((ref) => ({ ...ref })),
  };
}

function storedBand(band: ShiftBand): DiffCheckpoint["bands"][number] {
  return { ...band, poolIds: [...band.poolIds] };
}

function storedGroup(group: SystematicGroup): DiffCheckpoint["groups"][number] {
  return { ...group, exampleDescriptions: [...group.exampleDescriptions] };
}

/**
 * One changed row, ready to store.
 *
 * The spread copies only the keys the row actually has, which is the point:
 * `FieldChange.before` being ABSENT means the field was absent on that side,
 * and `loadTakeoffCatalog` tests `takeoffUnit !== undefined`, so rebuilding the
 * object field by field would write `before: undefined` and turn "this phase has
 * no takeoff" into "this phase has a blank one" in the audit trail.
 */
function storedRow(row: DiffRow): StoredDiffRow {
  return {
    ...row,
    changes: row.changes.map((change) => ({ ...change, flags: [...change.flags] })),
    flags: [...row.flags],
  };
}

function storedSummary(summary: DiffSummary): NonNullable<Doc<"rateBookDiffs">["summary"]> {
  return {
    ...summary,
    pools: summary.pools.map(storedIntegrity),
    shiftBands: summary.shiftBands.map(storedBand),
    systematicGroups: summary.systematicGroups.map(storedGroup),
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

// ============================================================================
// STARTING, RESUMING, STOPPING
// ============================================================================

/** Hand the draft back, but only if the lock is still this run's. */
async function releaseDiffLock(ctx: MutationCtx, bookId: Id<"rateBooks">): Promise<void> {
  const book = await ctx.db.get(bookId);
  if (book?.lock?.op === "diff") await ctx.db.patch(bookId, { lock: undefined });
}

/**
 * Compare this draft against the book it was cloned from.
 *
 * ⚠️ `startedAtContentRevision` IS STAMPED HERE, BEFORE THE FIRST ROW IS READ,
 * and {@link finishDiff} stamps the revision again after the last. Two stamps
 * rather than one, because a single end-of-run stamp cannot see a torn read: the
 * comparison walks WBS and phases before an import lands and labor after, and
 * the result then describes a catalog that never existed at any one moment. G5
 * blocks when the two differ, and it can only do that if both are recorded.
 *
 * The draft is LOCKED for the duration and released before anybody reads the
 * result — an admin reading a comparison must not block the import that
 * comparison told them to run.
 *
 * Each run is its own record with its own rows, so a superseded run is not
 * confusing, it is simply not the one anybody reads: every read below is scoped
 * by `diffId`.
 */
export const startDiff = mutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args): Promise<{ diffId: Id<"rateBookDiffs"> }> => {
    const access = await requirePrecisionAdmin(ctx);
    const book = await requireDraftBook(ctx, args.bookId, "diff");

    if (book.buildState !== "ready") {
      throw new Error(`"${book.name}" is still being built. Wait for it to finish.`);
    }
    // `requireDraftBook` tolerates a lock whose op matches, because the BATCHES
    // of a long operation have to get past their own lock. A second comparison
    // is not a batch of the first one.
    if (book.lock) {
      throw new Error(
        book.lock.op === "diff"
          ? `A comparison of "${book.name}" is already running.`
          : `"${book.name}" is busy (${book.lock.op}). Wait for that to finish.`
      );
    }
    if (!book.parentBookId) {
      throw new Error(
        `"${book.name}" was not cloned from another rate book, so there is nothing to compare it against.`
      );
    }

    const now = Date.now();
    const diffId = await ctx.db.insert("rateBookDiffs", {
      bookId: args.bookId,
      parentBookId: book.parentBookId,
      state: "running",
      startedBy: access.userId,
      startedAt: now,
      lastProgressAt: now,
      startedAtContentRevision: book.contentRevision ?? 0,
    });
    await ctx.db.patch(args.bookId, {
      lock: { op: "diff", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });
    await ctx.scheduler.runAfter(0, internal.rateBookDiff.runDiff, { diffId });

    return { diffId };
  },
});

/**
 * Pick a comparison back up from the pool it stopped in.
 *
 * ACCEPTS A STALLED RUN, NOT ONLY A FAILED ONE. An action killed by a deploy and
 * a query aborted by a runtime limit both die without reaching any error
 * handler, so the run they belonged to is still marked `running` — and a resume
 * that only accepted `failed` would refuse it for ever while doing nothing,
 * which is the exact wedge the link repair shipped with.
 *
 * It restarts the pool it stopped in from that pool's first row. Everything the
 * finished pools produced is on the checkpoint; everything the unfinished pool
 * produced is discarded, because half a `DraftScanState` is worse than none.
 */
export const resumeDiff = mutation({
  args: { diffId: v.id("rateBookDiffs") },
  handler: async (ctx, args): Promise<{ resumingFrom: PoolKind | "summary" }> => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.diffId);
    if (!run) throw new Error("That comparison is not on record.");
    if (run.state === "ready") throw new Error("That comparison already finished.");

    const idleFor = Date.now() - (run.lastProgressAt ?? run.startedAt);
    const stalled = run.state === "running" && idleFor > STALL_AFTER_MS;
    if (run.state !== "failed" && !stalled) {
      throw new Error(
        `That comparison is still working — it made progress ${Math.round(idleFor / 1000)}s ago.`
      );
    }

    const book = await ctx.db.get(run.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "draft") {
      throw new Error(`"${book.name}" is ${book.status}; the comparison cannot be finished.`);
    }
    if (book.lock && book.lock.op !== "diff") {
      throw new Error(`"${book.name}" is busy (${book.lock.op}). Wait for that to finish.`);
    }

    const now = Date.now();
    await ctx.db.patch(args.diffId, {
      state: "running",
      error: undefined,
      finishedAt: undefined,
      lastProgressAt: now,
    });
    await ctx.db.patch(run.bookId, {
      lock: { op: "diff", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });
    await ctx.scheduler.runAfter(0, internal.rateBookDiff.runDiff, { diffId: args.diffId });

    // "summary" rather than a pool when every pool was already closed and the run
    // died in {@link finishDiff}: naming a pool it is not going to walk again
    // would be the interface's first lie about what is happening.
    return { resumingFrom: POOL_ORDER[run.checkpoint?.poolIndex ?? 0] ?? "summary" };
  },
});

/**
 * Stop a comparison and give the draft back.
 *
 * This exists for the same reason `cancelBulkAdjust` does: a run whose action
 * died holds the lock until the reaper notices, and ten minutes of a wedged
 * draft is ten minutes an admin cannot import, edit or publish. Cancelling is
 * always safe — a comparison writes nothing to the catalog, and the rows it had
 * already flushed belong to a run that is now `failed`, which nothing reads as a
 * result.
 */
export const cancelDiff = mutation({
  args: { diffId: v.id("rateBookDiffs") },
  handler: async (ctx, args): Promise<{ cancelled: boolean }> => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.diffId);
    if (!run) throw new Error("That comparison is not on record.");
    if (run.state !== "running") throw new Error(`That comparison is ${run.state}.`);

    await ctx.db.patch(args.diffId, {
      state: "failed",
      error: `Stopped by ${access.userId} before it finished. Nothing was written to the catalog.`,
      finishedAt: Date.now(),
    });
    await releaseDiffLock(ctx, run.bookId);
    return { cancelled: true };
  },
});

// ============================================================================
// THE RUN
// ============================================================================

/** One page of one pool, from one book, already projected for the differ. */
interface DiffPage {
  readonly rows: DiffRowInput[];
  readonly cursor: string | null;
  readonly isDone: boolean;
}

/**
 * One page of a pool, projected through `diffValuesOf`.
 *
 * ⚠️ THE PROJECTION IS NOT OPTIONAL AND IS NOT SPELLED OUT HERE ON PURPOSE.
 * `laborPool` and `equipmentPool` store `description` while `wbsPool` and
 * `phasePool` store `name`, and reaching for the wrong one hands `naturalKey`
 * the string `"undefined"` for every row in the pool — one key for all 228
 * phases, which is a collision on every one of them, blocks G3 for ever, and can
 * produce a shift band claiming the whole catalog moved. `diffValuesOf` lives in
 * `rateBookShape.ts` beside the four other mappings precisely so this file
 * cannot hold a fifth, subtly different, answer.
 *
 * Written out per pool rather than reached through a cast, for the reason
 * `insertPoolRow` gives: these are four tables with four shapes, and a cast that
 * silenced the compiler would be the compiler telling us we had picked the wrong
 * index.
 */
async function pagePool(
  ctx: QueryCtx,
  bookId: Id<"rateBooks">,
  pool: PoolKind,
  cursor: string | null,
  numItems: number
): Promise<DiffPage> {
  const opts = { cursor, numItems };
  if (pool === "labor") {
    const page = await ctx.db
      .query("laborPool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
      .paginate(opts);
    return {
      rows: page.page.map((row) => diffValuesOf(pool, row)),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  }
  if (pool === "phases") {
    const page = await ctx.db
      .query("phasePool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
      .paginate(opts);
    return {
      rows: page.page.map((row) => diffValuesOf(pool, row)),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  }
  if (pool === "wbs") {
    const page = await ctx.db
      .query("wbsPool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
      .paginate(opts);
    return {
      rows: page.page.map((row) => diffValuesOf(pool, row)),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  }
  const page = await ctx.db
    .query("equipmentPool")
    .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
    .paginate(opts);
  return {
    rows: page.page.map((row) => diffValuesOf(pool, row)),
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Where the run stands, and how big the pools are.
 *
 * `totals` come from `rateBooks.rowCounts` and feed the progress line only, so a
 * book that predates them reports 0 and the screen is expected to render that as
 * "unknown" rather than as a confident denominator — the same rule
 * `getCatalogSummary` states about absent counts.
 */
export const loadDiffContext = internalQuery({
  args: { diffId: v.id("rateBookDiffs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.diffId);
    if (!run || run.state !== "running") return null;
    const book = await ctx.db.get(run.bookId);
    if (!book) return null;
    return {
      bookId: run.bookId,
      parentBookId: run.parentBookId,
      checkpoint: run.checkpoint ?? null,
      totals: book.rowCounts ?? { wbs: 0, phases: 0, labor: 0, equipment: 0 },
    };
  },
});

/**
 * One page of one pool, from one book.
 *
 * ⚠️ ONE BOOK PER CALL BECAUSE CONVEX ALLOWS ONE `.paginate()` PER FUNCTION, and
 * the pagination cursor is what makes the join's central rule structural: EACH
 * PAGE MUST REACH `mergeJoinStep` EXACTLY ONCE. Re-delivering a page whose rows
 * are still buffered puts every one of them in twice, and two rows at one
 * `poolId` is indistinguishable from the real duplicate this whole join exists to
 * catch — `DiffRowInput` carries nothing else to tell them apart by. A cursor
 * returns every document from exactly one page, including at a boundary that
 * falls inside a duplicated id, which a `poolId > last` keyset cursor cannot do:
 * it would skip the second copy of an id the page ended on.
 *
 * The cursor is never persisted, because a run that stops restarts its whole
 * pool — so the exactly-once rule holds across a resume by having nothing to
 * resume from.
 */
export const loadPoolPage = internalQuery({
  args: {
    bookId: v.id("rateBooks"),
    pool: POOL_KIND_VALIDATOR,
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<DiffPage> =>
    await pagePool(ctx, args.bookId, args.pool, args.cursor, args.numItems),
});

/**
 * Throw away whatever a previous attempt at this pool flushed.
 *
 * Called before a pool is walked, every time, including the first — an empty
 * delete costs two index reads. It is what makes a restart honest rather than
 * additive: the rows a half-finished pool wrote describe a scan whose collision
 * and reference checks covered only part of the pool, and leaving them beside
 * the rows of the completed second attempt would double every count the summary
 * reads off them.
 */
export const discardPoolRows = internalMutation({
  args: { diffId: v.id("rateBookDiffs"), pool: POOL_KIND_VALIDATOR },
  handler: async (ctx, args): Promise<{ done: boolean; deleted: number }> => {
    const flags = await ctx.db
      .query("rateBookDiffRowFlags")
      .withIndex("by_diff_pool", (q) => q.eq("diffId", args.diffId).eq("pool", args.pool))
      .take(DISCARD_BATCH);
    for (const entry of flags) await ctx.db.delete(entry._id);

    const rows = await ctx.db
      .query("rateBookDiffRows")
      .withIndex("by_diff_pool", (q) => q.eq("diffId", args.diffId).eq("pool", args.pool))
      .take(DISCARD_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);

    return {
      done: flags.length < DISCARD_BATCH && rows.length < DISCARD_BATCH,
      deleted: flags.length + rows.length,
    };
  },
});

/** Refuse to write into a run somebody has cancelled or superseded. */
async function requireRunning(
  ctx: MutationCtx,
  diffId: Id<"rateBookDiffs">
): Promise<Doc<"rateBookDiffs">> {
  const run = await ctx.db.get(diffId);
  if (!run) throw new Error("That comparison is not on record.");
  if (run.state !== "running") {
    throw new Error(`This comparison is ${run.state}; it was cancelled or superseded.`);
  }
  return run;
}

/**
 * Keep the heartbeat and the progress line moving.
 *
 * ⚠️ A JOB THAT TAKES THE LOCK AND NEVER REFRESHES `heartbeatAt` IS REAPED WHILE
 * HEALTHY at ten minutes; refreshing per unit of work is the contract, and a
 * pool with no changed rows flushes nothing, so the page is the unit here rather
 * than the flush. `lastProgressAt` is the other half: a run aborted by a runtime
 * limit records nothing at all, so "stalled" has to be provable from the outside
 * or {@link resumeDiff} can never take it over.
 */
async function beat(ctx: MutationCtx, run: Doc<"rateBookDiffs">, now: number): Promise<void> {
  const book = await ctx.db.get(run.bookId);
  if (book?.lock?.op === "diff") {
    await ctx.db.patch(run.bookId, { lock: { ...book.lock, heartbeatAt: now } });
  }
}

export const recordProgress = internalMutation({
  args: {
    diffId: v.id("rateBookDiffs"),
    pool: POOL_KIND_VALIDATOR,
    done: v.number(),
    total: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    const run = await requireRunning(ctx, args.diffId);
    const now = Date.now();
    await ctx.db.patch(args.diffId, {
      progress: { pool: args.pool, done: args.done, total: args.total },
      lastProgressAt: now,
    });
    await beat(ctx, run, now);
    return null;
  },
});

/**
 * Store one batch of changed rows, and one flag entry per flag they carry.
 *
 * ⚠️ THE FLAG ENTRIES ARE NOT A DENORMALISATION, THEY ARE THE ONLY WAY TO READ
 * THIS. Convex indexes a field's value and an array's value is the whole array,
 * so there is no index over `rateBookDiffRows.flags` — without a row per
 * (row, flag) the review screen can only take a capped slice of a mixed list,
 * and a cap over a mixed list shows a hundred rows of the systematic band and
 * hides the three real renames underneath it.
 */
export const flushDiffRows = internalMutation({
  args: {
    diffId: v.id("rateBookDiffs"),
    rows: v.array(v.object(DIFF_ROW_FIELDS)),
  },
  handler: async (ctx, args): Promise<{ stored: number }> => {
    const run = await requireRunning(ctx, args.diffId);
    for (const row of args.rows) {
      const rowId = await ctx.db.insert("rateBookDiffRows", { diffId: args.diffId, ...row });
      for (const flag of row.flags) {
        await ctx.db.insert("rateBookDiffRowFlags", {
          diffId: args.diffId,
          rowId,
          flag,
          pool: row.pool,
          poolId: row.poolId,
        });
      }
    }
    const now = Date.now();
    await ctx.db.patch(args.diffId, { lastProgressAt: now });
    await beat(ctx, run, now);
    return { stored: args.rows.length };
  },
});

/** Record that a pool is closed, and everything closing it produced. */
export const checkpointPool = internalMutation({
  args: { diffId: v.id("rateBookDiffs"), checkpoint: v.object(CHECKPOINT_FIELDS) },
  handler: async (ctx, args): Promise<null> => {
    const run = await requireRunning(ctx, args.diffId);
    const now = Date.now();
    await ctx.db.patch(args.diffId, { checkpoint: args.checkpoint, lastProgressAt: now });
    await beat(ctx, run, now);
    return null;
  },
});

/**
 * Close the run: summarize what was stored, stamp the revision, let the lock go.
 *
 * ⚠️ THE SUMMARY IS COMPUTED FROM THE STORED ROWS, IN THIS TRANSACTION. That is
 * what makes `flagCounts` and the lists `by_diff_flag` serves the same set by
 * construction — a summary folded up in the action's memory would agree with
 * them only as long as nobody changed one of the two paths.
 *
 * THE ARITHMETIC. The read is bounded by how much CHANGED, never by the catalog:
 * 1,270 rows on the largest real change event, and ~6,272 in the pathological
 * case where an id column was deleted in Excel and every row reads as an
 * addition — 38% of the 16,384-document read ceiling, against one document
 * written. The ~4,700 rows that did not move were counted and never stored, so
 * they cost nothing here either.
 *
 * `checkpoint` is cleared in the same patch that writes `summary`, so the
 * per-pool lists — `missingFromDraft` and `danglingParentRefs` are uncapped and
 * peak around 250 KB — never sit on the document twice.
 */
export const finishDiff = internalMutation({
  args: { diffId: v.id("rateBookDiffs") },
  handler: async (
    ctx,
    args
  ): Promise<{
    changedRowCount: number;
    startedAtContentRevision: number;
    finishedAtContentRevision: number;
  }> => {
    const run = await requireRunning(ctx, args.diffId);
    const checkpoint = run.checkpoint;
    if (!checkpoint || checkpoint.poolIndex < POOL_ORDER.length) {
      throw new Error(
        "This comparison was asked to finish before every pool had been compared. " +
          "A summary over some of the pools would report a clean catalog for the rest."
      );
    }

    const book = await ctx.db.get(run.bookId);
    if (!book) {
      throw new Error("The draft was discarded while the comparison was running.");
    }

    const rows = await ctx.db
      .query("rateBookDiffRows")
      .withIndex("by_diff", (q) => q.eq("diffId", args.diffId))
      .collect();

    const summary = summarizeDiff({
      pools: checkpoint.pools,
      rows,
      bands: checkpoint.bands,
      groups: checkpoint.groups,
      // The LABOR scan's map. Nothing else populates it — `observeDraftRow`
      // returns early for the other three pools — and it is the only input that
      // decides which phases were flagged by pattern rather than by hand.
      takeoffFlagsByPhase: new Map(
        checkpoint.takeoffFlagsByPhase.map((entry) => [entry.phasePoolId, entry.newlyFlagged])
      ),
      thresholds: DEFAULT_DIFF_THRESHOLDS,
    });

    const now = Date.now();
    await ctx.db.patch(args.diffId, {
      state: "ready",
      finishedAt: now,
      lastProgressAt: now,
      finishedAtContentRevision: book.contentRevision ?? 0,
      summary: storedSummary(summary),
      checkpoint: undefined,
      progress: undefined,
    });
    await releaseDiffLock(ctx, run.bookId);

    return {
      changedRowCount: summary.changedRowCount,
      startedAtContentRevision: run.startedAtContentRevision,
      finishedAtContentRevision: book.contentRevision ?? 0,
    };
  },
});

/**
 * Record that a comparison stopped, and give the draft back.
 *
 * A no-op on a run that is not `running`, so a cancel that raced the action is
 * not overwritten with a less honest sentence.
 */
export const failDiff = internalMutation({
  args: { diffId: v.id("rateBookDiffs"), error: v.string() },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const run = await ctx.db.get(args.diffId);
    if (!run || run.state !== "running") return { recorded: false };
    const now = Date.now();
    await ctx.db.patch(args.diffId, { state: "failed", error: args.error, finishedAt: now });
    await releaseDiffLock(ctx, run.bookId);
    return { recorded: true };
  },
});

/**
 * Compare one pool end to end, and return the checkpoint that closes it.
 *
 * The action holds, for the length of one pool: two page windows, the draft's
 * natural-key map, the parent's key index, and the pool's CHANGED rows. The
 * first four are bounded by catalog size (5,968 short strings apiece); the last
 * is bounded by how much moved, and is held rather than streamed because the
 * marking steps are verdicts about a whole pool that have to land on individual
 * rows. Nothing is flushed until they have.
 */
async function comparePool(
  ctx: ActionCtx,
  input: {
    diffId: Id<"rateBookDiffs">;
    bookId: Id<"rateBooks">;
    parentBookId: Id<"rateBooks">;
    totals: Readonly<Record<PoolKind, number>>;
    carried: DiffCheckpoint;
  }
): Promise<DiffCheckpoint> {
  const index = input.carried.poolIndex;
  const pool = POOL_ORDER[index];
  if (!pool) throw new Error(`There is no pool at position ${index}.`);

  // Annotated rather than inferred, here and below: this module's functions call
  // each other through `internal.rateBookDiff`, so an inferred result type would
  // be defined in terms of the module whose type it is part of.
  for (;;) {
    const discarded: { done: boolean; deleted: number } = await ctx.runMutation(
      internal.rateBookDiff.discardPoolRows,
      { diffId: input.diffId, pool }
    );
    if (discarded.done) break;
  }

  // Absent for wbs and equipment rather than an empty set: an empty set would
  // read every parent reference as dangling, and those two pools have none.
  const scan = newDraftScanState(
    PARENT_POOL_OF[pool] === null ? undefined : new Set(input.carried.validParentIds)
  );
  const tally = newPoolTally();
  const parentKeys = new Map<string, number>();
  const rows: DiffRow[] = [];

  let joinCursor: MergeCursor = emptyMergeCursor();
  let draft: DiffPage = { rows: [], cursor: null, isDone: false };
  let parent: DiffPage = { rows: [], cursor: null, isDone: false };
  let steps = 0;

  // A side that has already reported `isDone` is not queried again — feeding
  // `mergeJoinStep` an exhausted side is how it knows to release what it has
  // buffered rather than call the last row of the last page an addition.
  const advance = async (bookId: Id<"rateBooks">, page: DiffPage): Promise<DiffPage> =>
    page.isDone
      ? { rows: [], cursor: page.cursor, isDone: true }
      : await ctx.runQuery(internal.rateBookDiff.loadPoolPage, {
          bookId,
          pool,
          cursor: page.cursor,
          numItems: DIFF_PAGE,
        });

  for (;;) {
    steps += 1;
    if (steps > MAX_JOIN_STEPS_PER_POOL) {
      throw new Error(
        `The ${pool} comparison took ${MAX_JOIN_STEPS_PER_POOL} passes without reaching the end ` +
          `of either book. It was stopped rather than left holding the draft's lock.`
      );
    }

    draft = await advance(input.bookId, draft);
    parent = await advance(input.parentBookId, parent);

    const step = mergeJoinStep({
      draftPage: draft.rows,
      parentPage: parent.rows,
      draftExhausted: draft.isDone,
      parentExhausted: parent.isDone,
      cursor: joinCursor,
    });
    joinCursor = step.cursor;

    for (const pair of step.pairs) {
      // First writer wins, exactly as `buildMatchIndex` does, and the merge join
      // has already dropped a second parent row at one id: a duplicate the
      // PARENT book carries is a pre-existing condition of a published book, not
      // something this draft did.
      if (pair.parent) indexParentKey(parentKeys, pair.parent);
      // Only the first copy is observed. The second is G1's finding, and running
      // it through the scan would report a replayed clone batch as a key
      // collision too — whose remedy, renaming one of them, is wrong. The
      // integrity assertion is stated in distinct ids for the same reason.
      if (pair.draft) observeDraftRow(scan, pool, pair.draft, pair.parent);
      const row = diffPair(pool, pair, DEFAULT_DIFF_THRESHOLDS);
      tallyPair(tally, pair, row);
      if (row) rows.push(row);
    }

    await ctx.runMutation(internal.rateBookDiff.recordProgress, {
      diffId: input.diffId,
      pool,
      done: tally.draftRowCount,
      total: input.totals[pool],
    });

    if (draft.isDone && parent.isDone) break;
  }

  // ── The marking steps, in the one order that is correct ──
  const observations = renameObservations(parentKeys, rows);
  const { bands, unbanded } = detectShiftBands(observations, DEFAULT_DIFF_THRESHOLDS.shiftBandMin);
  const shifted = markShiftedRows(rows, bands, unbanded);
  const grouped = groupSystematic(shifted, DEFAULT_DIFF_THRESHOLDS.systematicGroupMin);
  const marked = markTakeoffFlagBulk({
    rows: grouped.rows,
    takeoffFlagsByPhase: scan.newTakeoffFlagsByPhase,
    thresholds: DEFAULT_DIFF_THRESHOLDS,
  });

  // ⚠️ THROWS when the scan and the tally disagree about how many draft rows
  // went past, and the throw is left to escape on purpose: that disagreement is
  // what a half-honoured resume looks like from the inside, and its result is a
  // pool reporting complete row counts with an empty collision list. Catching it
  // here would turn the one check that can see a partial scan into a log line.
  const integrity = poolIntegrity(pool, tally, scan);

  for (let at = 0; at < marked.length; at += FLUSH_BATCH) {
    await ctx.runMutation(internal.rateBookDiff.flushDiffRows, {
      diffId: input.diffId,
      rows: marked.slice(at, at + FLUSH_BATCH).map(storedRow),
    });
  }

  // Only handed forward when the NEXT pool's parents live in this one. Labor's
  // 5,897 ids have no consumer — equipment has no parent — and carrying them
  // would put 50 KB on the document to be read once and ignored.
  const next = POOL_ORDER[index + 1];
  const handOn = next !== undefined && PARENT_POOL_OF[next] === pool;

  const checkpoint: DiffCheckpoint = {
    poolIndex: index + 1,
    pools: [...input.carried.pools, storedIntegrity(integrity)],
    bands: [...input.carried.bands, ...bands.map(storedBand)],
    groups: [...input.carried.groups, ...grouped.groups.map(storedGroup)],
    takeoffFlagsByPhase: [
      ...input.carried.takeoffFlagsByPhase,
      ...[...scan.newTakeoffFlagsByPhase].map(([phasePoolId, newlyFlagged]) => ({
        phasePoolId,
        newlyFlagged,
      })),
    ],
    validParentIds: handOn ? [...scan.present] : [],
  };
  await ctx.runMutation(internal.rateBookDiff.checkpointPool, {
    diffId: input.diffId,
    checkpoint,
  });

  return checkpoint;
}

/**
 * The whole comparison, one pool at a time.
 *
 * ONE ACTION FOR THE WHOLE RUN, unlike `applyBulkAdjustBatch`, and the
 * difference is not stylistic: a mutation reschedules itself because a
 * transaction has a ceiling, while an action's work here is about eighteen paged
 * queries and a couple of dozen small mutations — seconds, and nowhere near an
 * action's limits. The checkpoint is still written per pool, because what it
 * protects against is the action dying, not the action running long.
 *
 * A failure is RECORDED and then RETHROWN. Recording first is what stops a
 * wedged run from being indistinguishable from a slow one; rethrowing is what
 * puts the reason in the function log, which matters most for the one throw this
 * file deliberately does not handle — `poolIntegrity`'s.
 */
export const runDiff = internalAction({
  args: { diffId: v.id("rateBookDiffs") },
  handler: async (ctx, args): Promise<{ done: boolean; changedRowCount: number }> => {
    const context = await ctx.runQuery(internal.rateBookDiff.loadDiffContext, {
      diffId: args.diffId,
    });
    // Cancelled, superseded, or its draft discarded, between the schedule and
    // the run. Nothing to do and nothing to complain about.
    if (!context) return { done: true, changedRowCount: 0 };

    try {
      let carried: DiffCheckpoint = context.checkpoint ?? emptyCheckpoint();
      while (carried.poolIndex < POOL_ORDER.length) {
        carried = await comparePool(ctx, {
          diffId: args.diffId,
          bookId: context.bookId,
          parentBookId: context.parentBookId,
          totals: context.totals,
          carried,
        });
      }
      const finished: {
        changedRowCount: number;
        startedAtContentRevision: number;
        finishedAtContentRevision: number;
      } = await ctx.runMutation(internal.rateBookDiff.finishDiff, { diffId: args.diffId });
      return { done: true, changedRowCount: finished.changedRowCount };
    } catch (error) {
      await ctx.runMutation(internal.rateBookDiff.failDiff, {
        diffId: args.diffId,
        error: error instanceof Error ? error.message : "The comparison stopped.",
      });
      throw error;
    }
  },
});

// ============================================================================
// READING THE RESULT
// ============================================================================

/**
 * The newest comparison of a draft, with the revision it can be judged against.
 *
 * The three stamps are returned raw and no verdict is derived from them here.
 * `publishGates` decides what "current", "torn" and "reviewed" mean, and a
 * second implementation on the read side is how a screen comes to disagree with
 * the gate about whether somebody may publish.
 */
export const getLatestDiff = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) return null;

    const run = await ctx.db
      .query("rateBookDiffs")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .order("desc")
      .first();
    if (!run) return null;

    return {
      _id: run._id,
      state: run.state,
      startedBy: run.startedBy,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      lastProgressAt: run.lastProgressAt ?? null,
      error: run.error ?? null,
      progress: run.progress ?? null,
      startedAtContentRevision: run.startedAtContentRevision,
      finishedAtContentRevision: run.finishedAtContentRevision ?? null,
      reviewedBy: run.reviewedBy ?? null,
      reviewedAtContentRevision: run.reviewedAtContentRevision ?? null,
      /** The draft's revision as it stands now — the number the two stamps are compared against. */
      bookContentRevision: book.contentRevision ?? 0,
      summary: run.summary ?? null,
    };
  },
});

/**
 * The rows carrying one flag.
 *
 * THE READ THIS WHOLE SUBSYSTEM IS SHAPED AROUND. A capped slice of a mixed list
 * shows a hundred rows of the systematic band and hides the three real renames
 * under it, which is the same reasoning `rateBookImportRows.by_import_block_kind`
 * already encodes — except that `flags` is an array, so the class has to be a
 * row in its own table before an index can exist at all.
 */
export const listDiffRowsByFlag = query({
  args: {
    diffId: v.id("rateBookDiffs"),
    flag: DIFF_FLAG_VALIDATOR,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const page = await ctx.db
      .query("rateBookDiffRowFlags")
      .withIndex("by_diff_flag", (q) => q.eq("diffId", args.diffId).eq("flag", args.flag))
      .paginate(args.paginationOpts);

    const rows: Doc<"rateBookDiffRows">[] = [];
    for (const entry of page.page) {
      const row = await ctx.db.get(entry.rowId);
      if (row) rows.push(row);
    }
    // Spread first so `splitCursor` and `pageStatus` survive — dropping them
    // would break the client's own splitting on a page it found too large.
    return { ...page, page: rows };
  },
});

/** One pool's changed rows, in `poolId` order, for the screen that walks a catalog. */
export const listDiffRowsByPool = query({
  args: {
    diffId: v.id("rateBookDiffs"),
    pool: POOL_KIND_VALIDATOR,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    return await ctx.db
      .query("rateBookDiffRows")
      .withIndex("by_diff_pool", (q) => q.eq("diffId", args.diffId).eq("pool", args.pool))
      .paginate(args.paginationOpts);
  },
});

/**
 * Record that a named person read this comparison, at the revision they read it.
 *
 * ⚠️ IT REFUSES TO RECORD A STATEMENT THAT WOULD NOT BE TRUE. "Reviewed at
 * revision 51" about a comparison of revision 47 is not a stale signature, it is
 * a false one — they read a different catalog. G5 is the gate and would block
 * either way; this is the write-side guard that keeps the record honest, exactly
 * as `writePoolRow`'s revision check keeps a "before" value from being one that
 * was never current.
 *
 * A torn comparison is refused for the stronger version of the same reason: it
 * describes a catalog that never existed at any one moment, so there is no
 * revision at which reading it means anything.
 */
export const markDiffReviewed = mutation({
  args: { diffId: v.id("rateBookDiffs") },
  handler: async (ctx, args): Promise<{ reviewedAtContentRevision: number }> => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.diffId);
    if (!run) throw new Error("That comparison is not on record.");
    if (run.state !== "ready") {
      throw new Error(
        run.state === "running"
          ? "That comparison is still running. Wait for it to finish."
          : "That comparison stopped before it finished; run it again."
      );
    }

    const book = await ctx.db.get(run.bookId);
    if (!book) throw new Error("Rate book not found.");
    const revision = book.contentRevision ?? 0;

    if (run.startedAtContentRevision !== run.finishedAtContentRevision) {
      throw new Error(
        `That comparison started at revision ${run.startedAtContentRevision} and finished at ` +
          `${run.finishedAtContentRevision}, so the catalog changed while it was running and it ` +
          `describes a state that never existed. Run it again.`
      );
    }
    if (run.finishedAtContentRevision !== revision) {
      throw new Error(
        `That comparison is of revision ${run.finishedAtContentRevision}; this draft is at ` +
          `${revision}. Run it again and read the current one.`
      );
    }

    await ctx.db.patch(args.diffId, {
      reviewedBy: access.userId,
      reviewedAtContentRevision: revision,
    });
    return { reviewedAtContentRevision: revision };
  },
});
