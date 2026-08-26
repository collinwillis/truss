import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { requirePrecisionAdmin } from "./model/precisionAccess";
import { isLockStale, requireDraftBook } from "./model/rateBookAccess";
import { round2 } from "./model/costEngine";
import {
  accumulateProposal,
  benchmarkProposal,
  emptyBenchmarkAccumulator,
  equipmentRateFacts,
  finalizeBenchmark,
  reviveAccumulator,
  serializeAccumulator,
  type BenchmarkAccumulatorSnapshot,
  type BenchmarkReport,
  type EquipmentCatalogRow,
  type LaborCatalogRow,
} from "./model/repriceBenchmark";

/**
 * The Convex layer that drives `model/repriceBenchmark.ts`: what the estimates
 * already priced from the parent book would have cost under this draft.
 *
 * The arithmetic is not here and must never be. This file loads documents,
 * hands them to the pure module, and stores what comes back — every dollar in
 * the result comes from `computeActivityCosts`/`rollUpProposal`, the same
 * functions the estimate screen and the cached proposal total run.
 *
 * ⚠️ THE POPULATION IS EVERY ESTIMATE ON THE PARENT BOOK, NOT A SAMPLE. Today
 * that is 713 of 736. A sampled benchmark makes "who chose these?" the first
 * question anybody asks of the number, and the honest answer — that coverage is
 * already thin — is the argument against sampling rather than for a cleverer
 * sample. Everything not on the parent book is named in
 * `BenchmarkReport.proposalsExcluded`, by number, never as a count alone.
 *
 * ⚠️ THE RESULT CARRIES ITS OWN COVERAGE, AND THAT IS THE POINT. No equipment
 * line is ever repriced — 81% of them pointed at an entirely different item
 * before the link repair and rewordings remain — and 16% of labor lines carry a
 * constant an estimator typed over. So `coveredDollars` and the eight
 * `carriedDollars` buckets partition every dollar of every estimate, and the
 * caveats say in words what fraction the headline is about. A confident total
 * over a silently partial set is the artifact that destroys trust the day
 * somebody finds out what it left out.
 *
 * ⚠️ THE RUN IS RESUMABLE AND ITS ACCUMULATOR IS CHECKPOINTED PER ESTIMATE.
 * `BenchmarkAccumulator` holds a `Set` and a `Map`, neither of which is a Convex
 * value: written as they live they come back as `{}`, and a run that died at
 * estimate 600 would resume reporting that no catalog item was exercised and no
 * item moved any money — every figure smaller than the truth and none of them
 * obviously wrong. `serializeAccumulator`/`reviveAccumulator` exist for exactly
 * that, and the SNAPSHOT is the contract with storage.
 *
 * ⚠️ THE ARITHMETIC, sized against the ceiling that aborted the link repair
 * mid-run with no way to record why ("timed out performing too many system
 * operations" is a hard runtime abort; no catch block gets to run).
 *
 *   PER TRANSACTION, against Convex's 16,384-document limit:
 *     catalog page      2,000 rows                              12%
 *     activity page     1,000 rows                               6%   the largest
 *                       live estimate is ~11,000 lines and is eleven pages,
 *                       never one transaction
 *     proposal page     50 estimates + 50 index probes          <1%
 *     reach batch       10 ids x at most 501 lines = 5,010      31%   twenty
 *                       would be 61%, the margin `stageImport` refused to bet
 *                       the catalog on
 *     one checkpoint    one insert and one patch
 *
 *   PER RUN (~713 estimates, ~200,000 activity lines):
 *     catalogs   5,897 x 2 labor + ~135 x 2 equipment = 12,064 documents,
 *                RELOADED once per action invocation. An action's memory does
 *                not survive a reschedule and 12,064 rows do not fit in a
 *                checkpoint, so reloading is the only option — and amortising
 *                that reload is the ONLY thing {@link SEGMENT_PROPOSALS} buys.
 *                At 250 estimates and 60,000 activity reads an invocation,
 *                today's population is four invocations and ~48,000 catalog
 *                reads, 24% on top of the walk. Rescheduling after every single
 *                estimate — which is what "checkpoint per estimate" would mean
 *                if the checkpoint and the hand-off were the same boundary —
 *                would be 713 reloads and 8.6 million reads. That is the shape
 *                of the mistake that killed the link repair.
 *     the walk   ~200,000 activity documents plus 713 proposals, every estimate
 *                its own transaction
 *     reach      bounded by the activities themselves, NOT by ids x 501: every
 *                line carries one `laborPoolId`, so the sum over any set of ids
 *                of min(501, lines) can never exceed the ~200,000 lines that
 *                exist
 *     exclusions one paginated pass over `proposals`, ~736 documents, once, in
 *                the invocation that finishes
 *
 *   ~450,000 document reads for a job that runs a handful of times a year.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Sizes, each against the ceiling
// ---------------------------------------------------------------------------

/** Catalog rows read per page while an invocation rebuilds its two book maps. */
const CATALOG_PAGE = 2000;

/** Activity lines read per page for one estimate. */
const ACTIVITY_PAGE = 1000;

/** Estimates named per page of the population walk. */
const PROPOSAL_PAGE = 50;

/** Estimates scanned per page of the exclusion roster. */
const EXCLUSION_PAGE = 2000;

/** Changed catalog ids whose reach is counted in one transaction. */
const REACH_BATCH = 10;

/**
 * Lines counted for one changed item before the answer becomes "500+".
 *
 * 501 rather than 500 so the cap is DETECTABLE: `finalizeBenchmark` stores the
 * count it is given, and a UI reading 501 knows it means "at least 500" while
 * 500 could be an exact 500.
 */
const REACH_CAP = 501;

/**
 * Estimates one action invocation prices before handing on to the next.
 *
 * NOT the checkpoint boundary, and the two are deliberately different sizes. The
 * accumulator is checkpointed after every estimate, so no estimate is ever
 * PRICED twice — a resume only re-reads the proposal documents of the page it
 * stopped inside, at most 49 of them, and skips each one before touching its
 * lines. This constant is only how often the 12,064-row catalog reload is paid.
 * See the arithmetic in the module header.
 */
const SEGMENT_PROPOSALS = 250;

/**
 * Activity documents one invocation reads before handing on.
 *
 * The second budget exists because estimates are not the same size: the largest
 * live one carries ~11,000 lines against a ~280 average, so 250 of the wrong
 * ones would be 2.75 million reads in a single invocation.
 */
const SEGMENT_ACTIVITY_READS = 60_000;

/**
 * What `proposalsExcluded` says about an estimate pinned to no rate book.
 *
 * A word rather than an empty string or a fabricated id: Convex ids are 32-odd
 * characters and this cannot be mistaken for one, while `""` renders as a bug.
 * G8 blocks publish on exactly this population, and the 6-hourly proposals sync
 * creates it — so it is expected, and it is named.
 */
const UNPINNED = "unpinned";

// ---------------------------------------------------------------------------
// Refusals a screen has to tell apart
// ---------------------------------------------------------------------------

/**
 * No current comparison exists, so coverage has no denominator.
 *
 * ⚠️ `ConvexError` with a `kind`, never a plain `Error`. Convex redacts a plain
 * error's message on a production deployment, so a client that recognises a
 * refusal by its wording works in development and degrades to "an error
 * occurred" in front of a customer — see `STALE_ROW` in
 * `model/rateBookAccess.ts`. This one has a remedy the UI can offer as a button.
 */
export const BENCHMARK_NEEDS_DIFF = "benchmark_needs_diff" as const;

/** Something already owns this draft. Distinct because waiting is the remedy. */
export const BENCHMARK_BUSY = "benchmark_busy" as const;

/**
 * The draft has moved since this benchmark priced it.
 *
 * A different sentence from every other refusal: nothing failed, the answer is
 * simply about a catalog that no longer exists, and the remedy is to run it
 * again rather than to retry the same thing.
 */
export const BENCHMARK_STALE = "benchmark_stale" as const;

// ---------------------------------------------------------------------------
// Stored shapes, taken from the schema rather than transcribed
// ---------------------------------------------------------------------------

/**
 * The benchmark tables' own validators, reused rather than copied.
 *
 * `schema.ts` spells the accumulator, the report and the per-estimate row out
 * field by field on purpose — a `v.record(...)` "accepts a bucket nobody added
 * and silently drops one nobody removed". A second transcription here, to
 * validate the arguments that carry those objects between the action and its
 * mutations, would reintroduce precisely that: a ninth `CarriedDollars` bucket
 * would reach the table and never reach the checkpoint, and a resumed run would
 * lose it. Deriving the argument validators from the table leaves ONE
 * declaration, so there is nothing left to drift.
 */
const benchmarkFields = schema.tables.rateBookBenchmarks.validator.fields;
const benchmarkProposalFields = schema.tables.rateBookBenchmarkProposals.validator.fields;

/** The checkpoint as an argument — the stored field without its `v.optional`. */
const checkpointValidator = v.object(benchmarkFields.checkpoint.fields);

/** The finished report as an argument. */
const reportValidator = v.object(benchmarkFields.report.fields);

const {
  benchmarkId: _runOwnsThis,
  proposalId: _passedSeparately,
  ...proposalRowFields
} = benchmarkProposalFields;

/** One estimate's row, minus the two ids the mutation fills in itself. */
const proposalRowValidator = v.object(proposalRowFields);

type StoredCheckpoint = Infer<typeof checkpointValidator>;
type StoredReport = Infer<typeof reportValidator>;
type StoredProposalRow = Infer<typeof proposalRowValidator>;
type StoredAccumulator = StoredCheckpoint["accumulator"];

/**
 * The snapshot as the checkpoint holds it.
 *
 * `readonly T[]` and `T[]` are the same array at runtime — the pure module
 * returns readonly everywhere and Convex generates `v.array(...)` as mutable —
 * so every copy below is one the compiler asks for and nothing else. The two
 * conversions that are NOT cosmetic happened already, inside
 * `serializeAccumulator`: a `Set` and a `Map` are not Convex values at all.
 */
function toStoredAccumulator(snapshot: BenchmarkAccumulatorSnapshot): StoredAccumulator {
  return {
    ...snapshot,
    byLine: { ...snapshot.byLine },
    byCraftLeg: { ...snapshot.byCraftLeg },
    byWeldLeg: { ...snapshot.byWeldLeg },
    carriedDollars: { ...snapshot.carriedDollars },
    exercisedLaborPoolIds: [...snapshot.exercisedLaborPoolIds],
    perItemDelta: snapshot.perItemDelta.map((item) => ({ ...item })),
    selfCheckFailures: snapshot.selfCheckFailures.map((failure) => ({ ...failure })),
    byDollarUp: snapshot.byDollarUp.map((mover) => ({ ...mover })),
    byDollarDown: snapshot.byDollarDown.map((mover) => ({ ...mover })),
    byPercentUp: snapshot.byPercentUp.map((mover) => ({ ...mover })),
    byPercentDown: snapshot.byPercentDown.map((mover) => ({ ...mover })),
  };
}

/** A zeroed accumulator in the shape the first checkpoint stores. */
function emptyStoredAccumulator(): StoredAccumulator {
  return toStoredAccumulator(serializeAccumulator(emptyBenchmarkAccumulator()));
}

/**
 * The finished report as the table holds it.
 *
 * ⚠️ `laborReach` and `equipmentReach` STAY TWO ARRAYS. Equipment numbers its
 * rows 0–133 and every one of those is also a labor id — 61 is "LIFTS - MANLIFT
 * 60'" in one pool and "8 CY TRUCK - 4 MILE" in the other — so one map keyed by
 * a bare poolId reports one item's line count under the other item's name.
 * Flattening them together here would undo the reason there are two indexes.
 */
function toStoredReport(report: BenchmarkReport): StoredReport {
  return {
    ...report,
    proposalsExcluded: report.proposalsExcluded.map((entry) => ({ ...entry })),
    selfCheckFailures: report.selfCheckFailures.map((failure) => ({ ...failure })),
    lines: {
      total: report.lines.total,
      byLine: { ...report.lines.byLine },
      byCraftLeg: { ...report.lines.byCraftLeg },
      byWeldLeg: { ...report.lines.byWeldLeg },
    },
    carriedDollars: { ...report.carriedDollars },
    coverage: { ...report.coverage, neverExercised: [...report.coverage.neverExercised] },
    measuredRates: { ...report.measuredRates },
    laborReach: [...report.laborReach].map(([poolId, lines]) => ({ poolId, lines })),
    equipmentReach: [...report.equipmentReach].map(([poolId, lines]) => ({ poolId, lines })),
    equipment: {
      ...report.equipment,
      facts: {
        ...report.equipment.facts,
        tierChangePct: { ...report.equipment.facts.tierChangePct },
        inversions: [...report.equipment.facts.inversions],
      },
    },
    movers: {
      byDollarUp: report.movers.byDollarUp.map((mover) => ({ ...mover })),
      byDollarDown: report.movers.byDollarDown.map((mover) => ({ ...mover })),
      byPercentUp: report.movers.byPercentUp.map((mover) => ({ ...mover })),
      byPercentDown: report.movers.byPercentDown.map((mover) => ({ ...mover })),
      byItem: report.movers.byItem.map((mover) => ({ ...mover })),
    },
    caveats: [...report.caveats],
  };
}

// ---------------------------------------------------------------------------
// The reads the action makes
// ---------------------------------------------------------------------------
//
// None of these authorises anybody, and that is deliberate rather than an
// omission. They are called from a SCHEDULED action, which carries no identity
// at all, so `requirePrecisionAdmin` here would refuse every run. Authorisation
// happens once, at `startBenchmark` and `resumeBenchmark`, exactly as
// `applyImportBatch` and `cloneBatch` are authorised by the mutations that
// schedule them.

/** What one segment needs to know before it reads anything else. */
interface RunState {
  bookId: Id<"rateBooks">;
  parentBookId: Id<"rateBooks">;
  parentBookName: string;
  basedOnContentRevision: number;
  /** The draft's revision NOW. A mismatch means the catalog moved mid-run. */
  contentRevision: number;
  startedBy: string;
  startedAt: number;
  /**
   * The comparison this run measures its coverage against, or `null`.
   *
   * ⚠️ NULL RATHER THAN A THROW, because the segment has a better sentence for
   * the commonest cause. A draft edited mid-run moves BOTH facts at once — the
   * revision no longer matches and the comparison is no longer current — and
   * "the comparison is gone" would be the true statement that leaves an admin
   * looking for a comparison rather than for the import that landed. The segment
   * tests the revision first for that reason.
   */
  diff: { changedLaborPoolIds: number[]; changedEquipmentPoolIds: number[] } | null;
  checkpoint?: StoredCheckpoint;
  progress?: { done: number; total: number };
}

export const loadRunState = internalQuery({
  args: { benchmarkId: v.id("rateBookBenchmarks") },
  handler: async (ctx, args): Promise<RunState | null> => {
    const run = await ctx.db.get(args.benchmarkId);
    // Cancelled, reaped or already finished. A segment that finds this simply
    // stops: the reaper and `cancelBenchmark` have already released the lock and
    // written the state, and a second writer of that state is a second answer to
    // one question.
    if (!run || run.state !== "running") return null;

    const book = await ctx.db.get(run.bookId);
    const parent = await ctx.db.get(run.parentBookId);
    if (!book || !parent) return null;

    const diff = await currentDiff(ctx, run.bookId, book.contentRevision ?? 0);
    return {
      bookId: run.bookId,
      parentBookId: run.parentBookId,
      parentBookName: parent.name,
      basedOnContentRevision: run.basedOnContentRevision,
      contentRevision: book.contentRevision ?? 0,
      startedBy: run.startedBy,
      startedAt: run.startedAt,
      diff: diff
        ? {
            changedLaborPoolIds: [...diff.changedLaborPoolIds],
            changedEquipmentPoolIds: [...diff.changedEquipmentPoolIds],
          }
        : null,
      checkpoint: run.checkpoint,
      progress: run.progress,
    };
  },
});

/**
 * The comparison a benchmark is allowed to measure its coverage against.
 *
 * ⚠️ WHY THE BENCHMARK NEEDS ONE AT ALL. `coverage.changedLaborPoolIds` is the
 * denominator of the sentence the publish screen prints — "41 of 380 changed
 * labor items are used by any estimate" — and `neverExercised` is that list
 * spelled out. The benchmark could derive its own set from the two catalogs it
 * loads, and it would be a SMALLER set: it cannot see a row whose only change
 * was `sortOrder`. Two files answering "how many labor constants changed" with
 * two numbers is how a subsystem teaches its readers that its figures are
 * approximate, so there is one answer and the comparison owns it.
 *
 * Current AND untorn, the same test G5 makes: a summary produced across an
 * import describes a catalog that never existed at any moment, and a coverage
 * denominator taken from it is a denominator for a different book.
 */
async function currentDiff(
  ctx: { db: { query: MutationCtx["db"]["query"] } },
  bookId: Id<"rateBooks">,
  contentRevision: number
): Promise<Doc<"rateBookDiffs">["summary"] | null> {
  const ready = await ctx.db
    .query("rateBookDiffs")
    .withIndex("by_book_state", (q) => q.eq("bookId", bookId).eq("state", "ready"))
    .order("desc")
    .take(1);
  const diff = ready[0];
  if (!diff || !diff.summary) return null;
  if (diff.startedAtContentRevision !== contentRevision) return null;
  if (diff.finishedAtContentRevision !== contentRevision) return null;
  return diff.summary;
}

/**
 * One page of a book's labor pool, projected to what the benchmark reads.
 *
 * Projected at the query boundary rather than in the action: the action holds
 * two of these pools at once, and a `LaborCatalogRow` is seven fields against a
 * document's twenty.
 */
export const loadLaborCatalogPage = internalQuery({
  args: {
    bookId: v.id("rateBooks"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ rows: LaborCatalogRow[]; continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db
      .query("laborPool")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      rows: page.page.map((row) => ({
        poolId: row.poolId,
        description: row.description,
        craftConstant: row.craftConstant,
        weldConstant: row.weldConstant,
        craftUnits: row.craftUnits,
        weldUnits: row.weldUnits,
        isActive: row.isActive,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** One page of a book's equipment pool, projected the same way. */
export const loadEquipmentCatalogPage = internalQuery({
  args: {
    bookId: v.id("rateBooks"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ rows: EquipmentCatalogRow[]; continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db
      .query("equipmentPool")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      rows: page.page.map((row) => ({
        poolId: row.poolId,
        description: row.description,
        hourRate: row.hourRate,
        dayRate: row.dayRate,
        weekRate: row.weekRate,
        monthRate: row.monthRate,
        isActive: row.isActive,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** One page of the population, counted so progress can read "600 of 713". */
export const countPopulationPage = internalQuery({
  args: {
    parentBookId: v.id("rateBooks"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ counted: number; continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db
      .query("proposals")
      .withIndex("by_book", (q) => q.eq("bookId", args.parentBookId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return { counted: page.page.length, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** One estimate of the population, with everything pricing it needs but its lines. */
interface PopulationEntry {
  proposalId: Id<"proposals">;
  proposalNumber: string;
  rates: Doc<"proposals">["rates"];
  costTotal?: number;
  /** Already folded into the accumulator by an earlier segment. */
  recorded: boolean;
}

/**
 * One page of the estimates this draft's parent book priced.
 *
 * THE POPULATION RULE, in one index read: `bookId === parentBookId`. Nothing is
 * sampled and nothing is filtered — an estimate with no lines, a zero-rate
 * estimate and a mirror-flagged estimate are all priced, because every one of
 * them is an estimate the parent book governs.
 *
 * `recorded` is what makes a resume idempotent. The checkpoint's cursor only
 * moves at a page boundary, so a run that died on estimate 7 of 50 re-reads all
 * fifty; the seven already in `rateBookBenchmarkProposals` are skipped rather
 * than folded into the accumulator a second time.
 */
export const nextProposalPage = internalQuery({
  args: {
    benchmarkId: v.id("rateBookBenchmarks"),
    parentBookId: v.id("rateBooks"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ proposals: PopulationEntry[]; continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db
      .query("proposals")
      .withIndex("by_book", (q) => q.eq("bookId", args.parentBookId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    const proposals: PopulationEntry[] = [];
    for (const proposal of page.page) {
      const already = await ctx.db
        .query("rateBookBenchmarkProposals")
        .withIndex("by_benchmark_proposal", (q) =>
          q.eq("benchmarkId", args.benchmarkId).eq("proposalId", proposal._id)
        )
        .first();
      proposals.push({
        proposalId: proposal._id,
        proposalNumber: proposal.proposalNumber,
        rates: proposal.rates,
        costTotal: proposal.costTotal,
        recorded: already !== null,
      });
    }
    return { proposals, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * One page of one estimate's lines, as the app itself reads them.
 *
 * ⚠️ NOTHING IS FILTERED AND NOTHING IS REORDERED, AND THE SELF-CHECK IS WHY.
 * `recomputeProposalTotal` — the only writer of `proposals.costTotal` — collects
 * `by_proposal` and hands the result to `rollUpProposal` with an empty indirect
 * set; `benchmarkProposal` makes the identical call, and `roundCosts(costs)
 * .totalCost` is `round2(costs.totalCost)` on the same line. That is what makes
 * the self-check an equality rather than an approximation. Skipping
 * `mirrorDeletedAt` lines, or sorting these into a friendlier order, would break
 * the equality on every estimate that has one — and the run would then report
 * hundreds of self-check failures that are really a difference of opinion about
 * which lines an estimate has.
 */
export const loadProposalActivities = internalQuery({
  args: {
    proposalId: v.id("proposals"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ activities: Doc<"activities">[]; continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      activities: page.page,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * How many live lines point at each of a handful of changed catalog items.
 *
 * TWO INDEXES, NEVER ONE. `by_labor_pool` and `by_equipment_pool` exist
 * separately because equipment ids 0–133 are all labor ids too; asking one index
 * about id 61 cannot say which item was meant.
 *
 * `.take(501)` per id is what bounds this: the answer a reader needs is "a
 * handful", "dozens" or "more than we can list", and counting all 4,000 lines on
 * a hot item to print "4,000" costs 4,000 reads to say the same thing as "500+".
 */
export const countReachBatch = internalQuery({
  args: {
    pool: v.union(v.literal("labor"), v.literal("equipment")),
    poolIds: v.array(v.number()),
  },
  handler: async (ctx, args): Promise<{ poolId: number; lines: number }[]> => {
    const entries: { poolId: number; lines: number }[] = [];
    for (const poolId of args.poolIds) {
      const lines =
        args.pool === "labor"
          ? await ctx.db
              .query("activities")
              .withIndex("by_labor_pool", (q) => q.eq("laborPoolId", poolId))
              .take(REACH_CAP)
          : await ctx.db
              .query("activities")
              .withIndex("by_equipment_pool", (q) => q.eq("equipmentPoolId", poolId))
              .take(REACH_CAP);
      entries.push({ poolId, lines: lines.length });
    }
    return entries;
  },
});

/**
 * One page of the estimates this run did NOT price, by name.
 *
 * ⚠️ EVERY EXCLUSION IS NAMED. "713 of 736" with no list is a number nobody can
 * check, and the whole reason the population is not sampled is that "who chose
 * these?" must have an answer. So this is a full pass over `proposals` rather
 * than an index read: the index answers "who is on the parent book", and the
 * question here is the complement.
 *
 * It runs ONCE, in the invocation that finishes the run, for a reason worth
 * writing down: the roster has nowhere to live between segments — the checkpoint
 * holds the accumulator and nothing else — and gathering it at the end means the
 * roster and the report are one snapshot rather than two taken hours apart.
 *
 * SIZE, uncapped and exact for the same reason `PoolIntegrity`'s four lists are:
 * one entry per estimate not on the parent book, so at most the proposals table
 * — 736 today, about 66 KB — held in one place only, because the checkpoint is
 * cleared in the same transaction that writes the report. Past ~10,000 estimates
 * this needs a cap and a truncation flag, and neither exists yet.
 */
export const listExcludedProposalsPage = internalQuery({
  args: {
    parentBookId: v.id("rateBooks"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    excluded: { proposalNumber: string; bookId: string }[];
    continueCursor: string;
    isDone: boolean;
  }> => {
    const page = await ctx.db
      .query("proposals")
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    const excluded = page.page
      .filter((proposal) => proposal.bookId !== args.parentBookId)
      .map((proposal) => ({
        proposalNumber: proposal.proposalNumber,
        bookId: proposal.bookId === undefined ? UNPINNED : String(proposal.bookId),
      }));
    return { excluded, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

// ---------------------------------------------------------------------------
// The writes the action makes
// ---------------------------------------------------------------------------

/** Hand the draft back, but only if the lock is still this run's. */
async function releaseBenchmarkLock(ctx: MutationCtx, bookId: Id<"rateBooks">): Promise<void> {
  const book = await ctx.db.get(bookId);
  if (book?.lock?.op === "benchmark") await ctx.db.patch(bookId, { lock: undefined });
}

/**
 * One estimate priced, its row written and the checkpoint advanced with it.
 *
 * ⚠️ THE CHECKPOINT MOVES IN THE SAME TRANSACTION AS THE ROW, and that is the
 * whole resumability story. A Convex mutation commits or it does not, so an
 * invocation killed part-way leaves an accumulator that matches exactly the set
 * of `rateBookBenchmarkProposals` rows that exist. An estimate can therefore
 * never be folded in twice and never be dropped.
 *
 * The row is upserted rather than inserted so this table can never hold two rows
 * for one estimate — but the guard against double-counting is the ACTION, which
 * skips an estimate `nextProposalPage` reports as already recorded. This one is
 * about the table's shape; that one is about the arithmetic.
 *
 * The heartbeat is refreshed here because this is the only thing a healthy run
 * does regularly. `reapStaleLocks` reaps a lock unrefreshed for ten minutes
 * whether or not the job is alive — refreshing per batch is the contract, and a
 * batch here is one estimate.
 */
export const recordProposal = internalMutation({
  args: {
    benchmarkId: v.id("rateBookBenchmarks"),
    proposalId: v.id("proposals"),
    row: proposalRowValidator,
    checkpoint: checkpointValidator,
    progress: v.object({ done: v.number(), total: v.number() }),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.benchmarkId);
    if (!run || run.state !== "running") return { recorded: false };

    const existing = await ctx.db
      .query("rateBookBenchmarkProposals")
      .withIndex("by_benchmark_proposal", (q) =>
        q.eq("benchmarkId", args.benchmarkId).eq("proposalId", args.proposalId)
      )
      .first();
    if (existing) await ctx.db.patch(existing._id, args.row);
    else {
      await ctx.db.insert("rateBookBenchmarkProposals", {
        benchmarkId: args.benchmarkId,
        proposalId: args.proposalId,
        ...args.row,
      });
    }

    const now = Date.now();
    await ctx.db.patch(args.benchmarkId, {
      checkpoint: args.checkpoint,
      progress: args.progress,
      lastProgressAt: now,
    });

    const book = await ctx.db.get(run.bookId);
    if (book?.lock?.op === "benchmark") {
      await ctx.db.patch(run.bookId, { lock: { ...book.lock, heartbeatAt: now } });
    }
    return { recorded: true };
  },
});

/**
 * Write the report and give the draft back.
 *
 * The checkpoint is cleared in the same transaction, so the accumulator and the
 * report — the same numbers in two shapes — never sit on the document at once.
 * That is also what keeps the peak document size honest: the arithmetic in
 * `schema.ts` assumes exactly one of them is present.
 */
export const finishBenchmark = internalMutation({
  args: { benchmarkId: v.id("rateBookBenchmarks"), report: reportValidator },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.benchmarkId);
    if (!run || run.state !== "running") return { finished: false };

    const now = Date.now();
    await ctx.db.patch(args.benchmarkId, {
      state: "ready",
      report: args.report,
      checkpoint: undefined,
      finishedAt: now,
      lastProgressAt: now,
      error: undefined,
    });
    await releaseBenchmarkLock(ctx, run.bookId);
    return { finished: true };
  },
});

/**
 * Record that a run stopped, and give the draft back.
 *
 * The checkpoint is deliberately LEFT ALONE: a failed run is resumed from it,
 * and clearing it would turn a recoverable stop into a re-run of everything.
 */
export const failBenchmark = internalMutation({
  args: { benchmarkId: v.id("rateBookBenchmarks"), error: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.benchmarkId);
    if (!run || run.state !== "running") return { failed: false };

    const now = Date.now();
    await ctx.db.patch(args.benchmarkId, {
      state: "failed",
      error: args.error,
      finishedAt: now,
      lastProgressAt: now,
    });
    await releaseBenchmarkLock(ctx, run.bookId);
    return { failed: true };
  },
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Page a book's labor pool into the map `benchmarkProposal` reads. */
async function loadLaborCatalog(
  ctx: ActionCtx,
  bookId: Id<"rateBooks">
): Promise<Map<number, LaborCatalogRow>> {
  const rows = new Map<number, LaborCatalogRow>();
  let cursor: string | null = null;
  for (;;) {
    const page: { rows: LaborCatalogRow[]; continueCursor: string; isDone: boolean } =
      await ctx.runQuery(internal.rateBookBenchmark.loadLaborCatalogPage, {
        bookId,
        cursor,
        numItems: CATALOG_PAGE,
      });
    for (const row of page.rows) rows.set(row.poolId, row);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

/** Page a book's equipment pool into the map `benchmarkProposal` reads. */
async function loadEquipmentCatalog(
  ctx: ActionCtx,
  bookId: Id<"rateBooks">
): Promise<Map<number, EquipmentCatalogRow>> {
  const rows = new Map<number, EquipmentCatalogRow>();
  let cursor: string | null = null;
  for (;;) {
    const page: { rows: EquipmentCatalogRow[]; continueCursor: string; isDone: boolean } =
      await ctx.runQuery(internal.rateBookBenchmark.loadEquipmentCatalogPage, {
        bookId,
        cursor,
        numItems: CATALOG_PAGE,
      });
    for (const row of page.rows) rows.set(row.poolId, row);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

/** Every line of one estimate, in the order the app itself reads them. */
async function loadActivities(
  ctx: ActionCtx,
  proposalId: Id<"proposals">
): Promise<Doc<"activities">[]> {
  const activities: Doc<"activities">[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: {
      activities: Doc<"activities">[];
      continueCursor: string;
      isDone: boolean;
    } = await ctx.runQuery(internal.rateBookBenchmark.loadProposalActivities, {
      proposalId,
      cursor,
      numItems: ACTIVITY_PAGE,
    });
    activities.push(...page.activities);
    if (page.isDone) return activities;
    cursor = page.continueCursor;
  }
}

/** How many estimates the population holds, so progress has a denominator. */
async function countPopulation(ctx: ActionCtx, parentBookId: Id<"rateBooks">): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { counted: number; continueCursor: string; isDone: boolean } = await ctx.runQuery(
      internal.rateBookBenchmark.countPopulationPage,
      { parentBookId, cursor, numItems: CATALOG_PAGE }
    );
    total += page.counted;
    if (page.isDone) return total;
    cursor = page.continueCursor;
  }
}

/** Every estimate on another book, or on none, named. */
async function loadExcludedProposals(
  ctx: ActionCtx,
  parentBookId: Id<"rateBooks">
): Promise<{ proposalNumber: string; bookId: string }[]> {
  const excluded: { proposalNumber: string; bookId: string }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: {
      excluded: { proposalNumber: string; bookId: string }[];
      continueCursor: string;
      isDone: boolean;
    } = await ctx.runQuery(internal.rateBookBenchmark.listExcludedProposalsPage, {
      parentBookId,
      cursor,
      numItems: EXCLUSION_PAGE,
    });
    excluded.push(...page.excluded);
    if (page.isDone) return excluded;
    cursor = page.continueCursor;
  }
}

/**
 * Reach for both pools, or an honest admission that it could not be counted.
 *
 * ⚠️ `reachAvailable: false` IS NOT A DETAIL. "Reach unavailable" and
 * "referenced by 0 activities" are opposite statements that render identically,
 * and a re-rate waved through because nothing appeared to use the changed rows
 * is the failure this flag exists to prevent. So the whole phase is caught: a
 * reach count that cannot be produced — a background index build, a read limit,
 * anything — leaves both maps empty and says so, rather than reporting zeros
 * that read as a finding.
 *
 * Caught rather than fatal because reach is the cheapest thing in the report to
 * lose: failing the run here would throw away ~200,000 activity reads to
 * recover a number that qualifies the result rather than producing it.
 */
async function countReach(
  ctx: ActionCtx,
  changedLaborPoolIds: readonly number[],
  changedEquipmentPoolIds: readonly number[]
): Promise<{
  laborReach: Map<number, number>;
  equipmentReach: Map<number, number>;
  reachAvailable: boolean;
}> {
  const laborReach = new Map<number, number>();
  const equipmentReach = new Map<number, number>();
  try {
    for (const [pool, poolIds, into] of [
      ["labor", changedLaborPoolIds, laborReach],
      ["equipment", changedEquipmentPoolIds, equipmentReach],
    ] as const) {
      for (let start = 0; start < poolIds.length; start += REACH_BATCH) {
        const entries: { poolId: number; lines: number }[] = await ctx.runQuery(
          internal.rateBookBenchmark.countReachBatch,
          { pool, poolIds: poolIds.slice(start, start + REACH_BATCH) }
        );
        for (const entry of entries) into.set(entry.poolId, entry.lines);
      }
    }
    return { laborReach, equipmentReach, reachAvailable: true };
  } catch {
    return { laborReach: new Map(), equipmentReach: new Map(), reachAvailable: false };
  }
}

/**
 * One estimate's row, in the four expressions `accumulateProposal` uses.
 *
 * ⚠️ THE ARITHMETIC IS COPIED FROM `accumulateProposal`'s `ProposalMover` ON
 * PURPOSE, and it is the one place in this file that reproduces the module's
 * work. The module keeps ten movers in each of four directions and returns no
 * per-estimate figure at all, so an estimate outside the top forty would
 * otherwise have no delta anywhere. Copying it means an estimate that appears in
 * both reads the same in both — note `deltaPct` divides by the UNROUNDED
 * baseline, exactly as the module does, because rounding it first would rank two
 * near-identical movers differently in the two places.
 */
function proposalRow(
  proposalNumber: string,
  result: ReturnType<typeof benchmarkProposal>
): StoredProposalRow {
  const rawBaseline = result.baseline.costs.totalCost;
  const baselineCost = round2(rawBaseline);
  const repricedCost = round2(result.counterfactual.costs.totalCost);
  const delta = round2(repricedCost - baselineCost);
  return {
    proposalNumber,
    baselineCost,
    repricedCost,
    delta,
    deltaPct: rawBaseline === 0 ? 0 : (delta / rawBaseline) * 100,
    selfCheckMatches: result.selfCheck.matches,
    selfCheckCached: result.selfCheck.cached,
    selfCheckComputed: result.selfCheck.computed,
    lines: { total: result.lines.total, byLine: { ...result.lines.byLine } },
    coveredDollars: result.coveredDollars,
    carriedDollars: { ...result.carriedDollars },
  };
}

/**
 * One invocation's worth of the run, then either a hand-off or the report.
 *
 * WHY AN ACTION AND NOT A CHAIN OF MUTATIONS. Both labor pools together are
 * 11,794 documents, and with phases, WBS and equipment the whole catalog is
 * 12,544 — 77% of Convex's per-transaction ceiling, the identical margin
 * `stageImport` already refused to bet the catalog on. So the catalogs are paged
 * into the action's memory, the pure module runs there, and the database only
 * ever sees bounded reads and one small write per estimate.
 *
 * WHY THE DRAFT'S REVISION IS RE-CHECKED AT THE TOP OF EVERY INVOCATION. The
 * catalogs are re-read per invocation, so a draft edited between two of them
 * would produce a report describing a catalog that never existed at any moment —
 * the torn read G5 blocks on, arriving through the benchmark's own resume path.
 * The lock makes it nearly unreachable; the reaper, which releases a lock while
 * the run's own state says `running`, is why "nearly" is not enough.
 */
export const runBenchmarkSegment = internalAction({
  args: { benchmarkId: v.id("rateBookBenchmarks") },
  handler: async (ctx, args): Promise<{ done: boolean; priced: number }> => {
    let priced = 0;
    try {
      // Inside the try, and every read after it too. An action that throws
      // records nothing of its own, so a failure raised before the catch is a
      // run left sitting in `running` until the reaper notices ten minutes
      // later — with the draft locked the whole time.
      const state: RunState | null = await ctx.runQuery(internal.rateBookBenchmark.loadRunState, {
        benchmarkId: args.benchmarkId,
      });
      if (!state) return { done: true, priced: 0 };

      if (state.contentRevision !== state.basedOnContentRevision) {
        throw new Error(
          `This draft changed while the benchmark was running — it was revision ` +
            `${state.basedOnContentRevision} when the run started and is ${state.contentRevision} ` +
            `now. The figures would describe a catalog that never existed. Run it again.`
        );
      }
      // Tested second on purpose: an edit invalidates both, and the sentence
      // above names the thing that actually happened.
      if (!state.diff) {
        throw new Error(
          "The comparison this benchmark measures its coverage against is gone or is no longer " +
            "current. Run the comparison again, then the benchmark."
        );
      }
      const { changedLaborPoolIds, changedEquipmentPoolIds } = state.diff;

      const parentLabor = await loadLaborCatalog(ctx, state.parentBookId);
      const draftLabor = await loadLaborCatalog(ctx, state.bookId);
      const parentEquipment = await loadEquipmentCatalog(ctx, state.parentBookId);
      const draftEquipment = await loadEquipmentCatalog(ctx, state.bookId);

      const checkpoint = state.checkpoint ?? {
        cursor: null,
        activityDocumentsRead: 0,
        accumulator: emptyStoredAccumulator(),
      };
      const accumulator = reviveAccumulator(checkpoint.accumulator);
      let activityDocumentsRead = checkpoint.activityDocumentsRead;
      let cursor = checkpoint.cursor;
      let done = state.progress?.done ?? 0;
      const total = state.progress?.total ?? (await countPopulation(ctx, state.parentBookId));
      let readThisSegment = 0;

      for (;;) {
        const page: {
          proposals: PopulationEntry[];
          continueCursor: string;
          isDone: boolean;
        } = await ctx.runQuery(internal.rateBookBenchmark.nextProposalPage, {
          benchmarkId: args.benchmarkId,
          parentBookId: state.parentBookId,
          cursor,
          numItems: PROPOSAL_PAGE,
        });

        for (let index = 0; index < page.proposals.length; index += 1) {
          const entry = page.proposals[index];
          if (!entry || entry.recorded) continue;

          const activities = await loadActivities(ctx, entry.proposalId);
          activityDocumentsRead += activities.length;
          readThisSegment += activities.length;

          const result = benchmarkProposal({
            proposalNumber: entry.proposalNumber,
            cachedCostTotal: entry.costTotal,
            rates: entry.rates,
            activities,
            parentLabor,
            draftLabor,
            parentEquipment,
            draftEquipment,
          });
          accumulateProposal(accumulator, result);
          done += 1;
          priced += 1;

          // The cursor only advances at a PAGE boundary, so a resume re-reads
          // this page and skips whatever it already recorded. Advancing it per
          // estimate would need a cursor Convex does not mint.
          await ctx.runMutation(internal.rateBookBenchmark.recordProposal, {
            benchmarkId: args.benchmarkId,
            proposalId: entry.proposalId,
            row: proposalRow(entry.proposalNumber, result),
            checkpoint: {
              cursor: index === page.proposals.length - 1 ? page.continueCursor : cursor,
              activityDocumentsRead,
              accumulator: toStoredAccumulator(serializeAccumulator(accumulator)),
            },
            // `total` was counted before the walk began and the population can
            // grow under it — the six-hourly sync inserts estimates. "714 of
            // 713" is a number that reads as a bug; the denominator gives way.
            progress: { done, total: Math.max(total, done) },
          });

          if (priced >= SEGMENT_PROPOSALS || readThisSegment >= SEGMENT_ACTIVITY_READS) {
            // Handed on from inside the page: the persisted cursor is whatever
            // the last checkpoint wrote, so the next invocation re-reads this
            // page and picks up at the estimate after this one.
            await ctx.scheduler.runAfter(0, internal.rateBookBenchmark.runBenchmarkSegment, {
              benchmarkId: args.benchmarkId,
            });
            return { done: false, priced };
          }
        }

        if (page.isDone) break;
        cursor = page.continueCursor;
      }

      const reach = await countReach(ctx, changedLaborPoolIds, changedEquipmentPoolIds);
      const report = finalizeBenchmark({
        acc: accumulator,
        changedLaborPoolIds,
        changedEquipmentPoolIds,
        equipmentFacts: equipmentRateFacts(parentEquipment, draftEquipment),
        laborReach: reach.laborReach,
        equipmentReach: reach.equipmentReach,
        reachAvailable: reach.reachAvailable,
        excludedProposals: await loadExcludedProposals(ctx, state.parentBookId),
        parentBookName: state.parentBookName,
        basedOnContentRevision: state.basedOnContentRevision,
        triggeredBy: state.startedBy,
        startedAt: state.startedAt,
        finishedAt: Date.now(),
        activityDocumentsRead,
      });

      await ctx.runMutation(internal.rateBookBenchmark.finishBenchmark, {
        benchmarkId: args.benchmarkId,
        report: toStoredReport(report),
      });
      return { done: true, priced };
    } catch (error) {
      // An action that throws records nothing of its own, and a run left sitting
      // in `running` holds the draft's lock until the reaper notices. The
      // estimates already recorded stay recorded and the checkpoint stays put,
      // so `resumeBenchmark` picks up at the one that never landed.
      await ctx.runMutation(internal.rateBookBenchmark.failBenchmark, {
        benchmarkId: args.benchmarkId,
        error: error instanceof Error ? error.message : "The benchmark stopped.",
      });
      return { done: true, priced };
    }
  },
});

// ---------------------------------------------------------------------------
// What an admin can do
// ---------------------------------------------------------------------------

/**
 * Reprice every estimate on this draft's parent book, in the background.
 *
 * Takes `lock.op = "benchmark"` for the duration and releases it the moment the
 * report is written — an admin reading a benchmark must not block the import
 * that benchmark told them to run.
 *
 * ⚠️ IT REFUSES WITHOUT A CURRENT COMPARISON. See {@link currentDiff}: the
 * coverage denominator every sentence of this report leans on belongs to the
 * comparison, and taking it from anywhere else would give the subsystem two
 * answers to "how many labor constants changed".
 */
export const startBenchmark = mutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);

    // ⚠️ THE LOCK IS READ BEFORE THE SHARED GUARD, and the order is the whole
    // point. `requireDraftBook` refuses any lock whose op is not this one with a
    // plain `Error`, whose message Convex REDACTS on a production deployment —
    // so the commonest reason to refuse a benchmark, that the comparison this
    // workflow requires first is still running, would reach the screen as "an
    // error occurred" while `resumeBenchmark` answers the identical condition
    // with a kind the UI can act on. Two doors into one job must not disagree
    // about what a refusal is. The guard still owns status and existence, which
    // is why it is called rather than reimplemented.
    const held = await ctx.db.get(args.bookId);
    if (held?.status === "draft" && held.lock) {
      throw new ConvexError({
        kind: BENCHMARK_BUSY,
        message: `"${held.name}" is busy (${held.lock.op}). Wait for that to finish, or clear it if it has stalled.`,
      });
    }
    const book = await requireDraftBook(ctx, args.bookId, "benchmark");

    if (book.buildState !== "ready") {
      throw new Error(`"${book.name}" is still being built. Wait for it to finish.`);
    }
    if (!book.parentBookId) {
      throw new Error(
        `"${book.name}" was not cloned from another rate book, so there are no estimates priced ` +
          "under a baseline to reprice."
      );
    }

    const revision = book.contentRevision ?? 0;
    if (!(await currentDiff(ctx, args.bookId, revision))) {
      throw new ConvexError({
        kind: BENCHMARK_NEEDS_DIFF,
        message:
          "Run the comparison against the parent book first. The benchmark reports how many of " +
          "the changed catalog items any estimate actually uses, and the comparison is what " +
          "decides which items those are.",
      });
    }

    const now = Date.now();
    const benchmarkId = await ctx.db.insert("rateBookBenchmarks", {
      bookId: args.bookId,
      parentBookId: book.parentBookId,
      state: "running",
      startedBy: access.userId,
      startedAt: now,
      lastProgressAt: now,
      basedOnContentRevision: revision,
      checkpoint: {
        cursor: null,
        activityDocumentsRead: 0,
        accumulator: emptyStoredAccumulator(),
      },
    });
    await ctx.db.patch(args.bookId, {
      lock: { op: "benchmark", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });
    await ctx.scheduler.runAfter(0, internal.rateBookBenchmark.runBenchmarkSegment, {
      benchmarkId,
    });

    return { benchmarkId, basedOnContentRevision: revision };
  },
});

/**
 * Pick up a run that stopped part-way.
 *
 * ⚠️ IT ACCEPTS A STALLED `running` RUN, NOT ONLY A `failed` ONE. An action
 * killed by a deploy, and a mutation killed by a runtime limit, both record
 * nothing at all — the run sits in `running` with a `lastProgressAt` that has
 * stopped moving. A resume that only accepted `failed` would leave those
 * permanently unresumable, holding the single draft slot, which is precisely how
 * the link repair wedged.
 *
 * It refuses when the draft has moved: the estimates already priced were priced
 * against the old catalog, and finishing the rest against a new one produces a
 * report that is half of each.
 */
export const resumeBenchmark = mutation({
  args: { benchmarkId: v.id("rateBookBenchmarks") },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.benchmarkId);
    if (!run) throw new Error("That benchmark is not on record.");
    if (run.state === "ready") throw new Error("That benchmark already finished.");

    const now = Date.now();
    const stalled =
      run.state === "running" && isLockStale(run.lastProgressAt ?? run.startedAt, now);
    if (run.state === "running" && !stalled) {
      throw new ConvexError({
        kind: BENCHMARK_BUSY,
        message: "That benchmark is still running. Its last estimate landed moments ago.",
      });
    }

    const book = await ctx.db.get(run.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "draft") {
      throw new Error(`"${book.name}" is ${book.status}; the rest of the benchmark cannot run.`);
    }
    if (book.lock && book.lock.op !== "benchmark") {
      throw new ConvexError({
        kind: BENCHMARK_BUSY,
        message: `"${book.name}" is busy (${book.lock.op}). Wait for that to finish.`,
      });
    }
    if ((book.contentRevision ?? 0) !== run.basedOnContentRevision) {
      throw new ConvexError({
        kind: BENCHMARK_STALE,
        message:
          `This draft has changed since that benchmark started — it priced revision ` +
          `${run.basedOnContentRevision} and the draft is now at ${book.contentRevision ?? 0}. ` +
          "Finishing it would mix two catalogs. Start a new one.",
      });
    }

    await ctx.db.patch(args.benchmarkId, {
      state: "running",
      error: undefined,
      finishedAt: undefined,
      lastProgressAt: now,
    });
    await ctx.db.patch(run.bookId, {
      lock: { op: "benchmark", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });
    await ctx.scheduler.runAfter(0, internal.rateBookBenchmark.runBenchmarkSegment, {
      benchmarkId: args.benchmarkId,
    });

    return { pricedSoFar: run.progress?.done ?? 0, of: run.progress?.total ?? 0 };
  },
});

/**
 * Stop a run and give the draft back.
 *
 * The estimates already priced STAY priced — they are a partial answer, plainly
 * labelled as one by the run's state — and a new run starts from zero rather
 * than inheriting them, because a benchmark is a statement about one catalog at
 * one moment.
 */
export const cancelBenchmark = mutation({
  args: { benchmarkId: v.id("rateBookBenchmarks") },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.benchmarkId);
    if (!run) throw new Error("That benchmark is not on record.");
    if (run.state === "ready") throw new Error("That benchmark already finished.");

    const now = Date.now();
    await ctx.db.patch(args.benchmarkId, {
      state: "failed",
      error: `Stopped by ${access.userId} after ${run.progress?.done ?? 0} of ${run.progress?.total ?? 0} estimates.`,
      finishedAt: now,
      lastProgressAt: now,
    });
    await releaseBenchmarkLock(ctx, run.bookId);

    return { priced: run.progress?.done ?? 0 };
  },
});

/**
 * Put a name against a benchmark, at the revision it describes.
 *
 * THE ONE ACKNOWLEDGEMENT THAT IS NOT A `rateBookAcknowledgements` ROW.
 * `publishGates` composes the sentence so it is written in one place, and
 * satisfies G7 from this stamp, so there is exactly one source of truth for
 * "this benchmark was read".
 *
 * It refuses a run whose self-check failed. G7 blocks on that too, but a
 * signature is a person saying they read a number, and if the harness could not
 * reproduce the total the app itself records for an estimate then every figure
 * in the report is about something other than these estimates. Letting somebody
 * sign it first and be told afterwards is the wrong order.
 */
export const acknowledgeBenchmark = mutation({
  args: { benchmarkId: v.id("rateBookBenchmarks") },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.benchmarkId);
    if (!run) throw new Error("That benchmark is not on record.");
    if (run.state !== "ready" || !run.report) {
      throw new Error("That benchmark has not finished, so there is nothing to read yet.");
    }

    const book = await ctx.db.get(run.bookId);
    if (!book) throw new Error("Rate book not found.");
    const revision = book.contentRevision ?? 0;
    if (revision !== run.basedOnContentRevision) {
      throw new ConvexError({
        kind: BENCHMARK_STALE,
        message:
          `That benchmark priced revision ${run.basedOnContentRevision} and this draft is now at ` +
          `${revision}. Run it again before signing it — a signature is about specific numbers.`,
      });
    }
    if (run.report.selfCheckFailures.length > 0) {
      throw new Error(
        `${run.report.selfCheckFailures.length} of ${run.report.proposalsCompared} estimates did ` +
          "not reproduce the total the app itself recorded for them, so every figure in this run " +
          "is measuring something else. Run the totals backfill, then run the benchmark again."
      );
    }

    await ctx.db.patch(args.benchmarkId, {
      acknowledgedBy: access.userId,
      acknowledgedAtContentRevision: revision,
    });
    return { atContentRevision: revision };
  },
});

// ---------------------------------------------------------------------------
// What a screen reads
// ---------------------------------------------------------------------------

/**
 * A run without its checkpoint.
 *
 * `checkpoint.accumulator` peaks around 175 KB — 5,897 exercised ids and up to
 * ~1,270 per-item deltas — and a progress indicator polling it would move more
 * data every second than the whole run writes. The same reasoning keeps
 * `rowIds` off `catalogBulkRuns`' summary.
 */
function summarizeRun(run: Doc<"rateBookBenchmarks">) {
  return {
    _id: run._id,
    bookId: run.bookId,
    parentBookId: run.parentBookId,
    state: run.state,
    startedBy: run.startedBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    lastProgressAt: run.lastProgressAt ?? null,
    error: run.error ?? null,
    basedOnContentRevision: run.basedOnContentRevision,
    progress: run.progress ?? null,
    acknowledgedBy: run.acknowledgedBy ?? null,
    acknowledgedAtContentRevision: run.acknowledgedAtContentRevision ?? null,
  };
}

/**
 * The newest benchmark for a draft, with its report if it has one.
 *
 * `contentRevision` travels with it because every reader of this has to answer
 * the same question first — is this about the draft as it stands? — and a screen
 * that has to fetch the book separately to find out is a screen that will
 * sometimes not bother.
 */
export const getBenchmark = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const runs = await ctx.db
      .query("rateBookBenchmarks")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .order("desc")
      .take(1);
    const run = runs[0];
    if (!run) return null;

    const book = await ctx.db.get(args.bookId);
    return {
      ...summarizeRun(run),
      report: run.report ?? null,
      contentRevision: book?.contentRevision ?? 0,
      current: (book?.contentRevision ?? 0) === run.basedOnContentRevision,
    };
  },
});

/** Every benchmark ever run against a draft, newest first. */
export const listBenchmarks = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const runs = await ctx.db
      .query("rateBookBenchmarks")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .order("desc")
      .take(25);
    return runs.map(summarizeRun);
  },
});

/**
 * One page of "what this run did to each estimate".
 *
 * The report keeps ten movers in each of four directions, so on a 713-estimate
 * run everything outside the top forty exists only as a sum. "Why did MY
 * estimate not move" is the question an estimator actually asks, and `byLine` is
 * the answer — an estimate can be still because nothing it uses changed, or
 * because every line on it was an override, and those are opposite findings.
 */
export const listBenchmarkProposals = query({
  args: {
    benchmarkId: v.id("rateBookBenchmarks"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    return await ctx.db
      .query("rateBookBenchmarkProposals")
      .withIndex("by_benchmark", (q) => q.eq("benchmarkId", args.benchmarkId))
      .paginate(args.paginationOpts);
  },
});

/**
 * The estimates whose baseline did not reproduce their own recorded total.
 *
 * Read as their OWN class through `by_benchmark_self_check`, never as a capped
 * slice of a mixed list — the same rule `by_diff_flag` exists for. Three real
 * failures hidden under a hundred healthy estimates is the one thing this list
 * must never do, because it is the finding that invalidates every other number
 * in the run.
 */
export const listSelfCheckFailures = query({
  args: { benchmarkId: v.id("rateBookBenchmarks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const failures = await ctx.db
      .query("rateBookBenchmarkProposals")
      .withIndex("by_benchmark_self_check", (q) =>
        q.eq("benchmarkId", args.benchmarkId).eq("selfCheckMatches", false)
      )
      .take(100);
    return failures.map((row) => ({
      proposalId: row.proposalId,
      proposalNumber: row.proposalNumber,
      cached: row.selfCheckCached ?? null,
      computed: row.selfCheckComputed,
    }));
  },
});
