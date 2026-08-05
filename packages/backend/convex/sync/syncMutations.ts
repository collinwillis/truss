/**
 * The writing half of the Firestore mirror.
 *
 * WHY DIFFERENTIAL. Editing an activity in the MCP Estimator writes only to the
 * `activities` collection, so `proposal.updateTime` never moves, and activities
 * carry no `updatedAt` at all — Firestore cannot be asked what changed. So the
 * mirror reads everything and writes only what differs. Every verdict in this
 * file is reached by `model/syncDiff.ts`; nothing here decides for itself
 * whether a row moved, because two answers to that question is exactly how the
 * catalog-link rule would grow a second, wrong copy.
 *
 * ⚠️ NOTHING IN THIS FILE DELETES. `momentumActivities.sourceActivityId` is
 * `v.id("activities")`, so hard-deleting a mirrored row would dangle a live
 * reference inside a product people are using right now. A row Firestore no
 * longer returns gets `mirrorDeletedAt` and stays exactly where it is.
 *
 * @module
 */

import { v, type Infer } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { internalMutation, internalQuery, mutation, type MutationCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { invalidateProposalTotal } from "../model/proposalTotalCache";
import {
  diffRow,
  emptyLevelCounts,
  sumLevelCounts,
  type LevelCounts,
  type SyncLevel,
  type SyncRow,
} from "../model/syncDiff";

// ============================================================================
// Shared shapes
// ============================================================================

/**
 * The four levels a mirror pass can flag as gone upstream.
 *
 * `proposal` is separated from the other three by WHEN it is knowable: a child
 * orphan follows from one proposal's own query results, while a proposal orphan
 * is only knowable after a COMPLETE walk of the proposals collection.
 */
const mirrorLevel = v.union(
  v.literal("proposal"),
  v.literal("wbs"),
  v.literal("phase"),
  v.literal("activity")
);

const levelCountsValidator = v.object({
  insert: v.number(),
  patch: v.number(),
  unchanged: v.number(),
  orphaned: v.number(),
  localOnly: v.number(),
  duplicate: v.number(),
});

const byLevelValidator = v.object({
  proposal: levelCountsValidator,
  wbs: levelCountsValidator,
  phase: levelCountsValidator,
  activity: levelCountsValidator,
});

/**
 * Parent ids an earlier chunk of the same tree already resolved.
 *
 * ⚠️ THIS IS THE LINK-REPAIR LESSON, APPLIED BEFORE IT COULD BITE AGAIN.
 * Without it, every activity chunk of a large estimate re-collects that
 * proposal's entire phase list to rebuild the same map — five hundred reads per
 * chunk to answer a question the first chunk already answered. The repair
 * aborted mid-run on exactly that shape of waste, with a hard runtime abort that
 * no `catch` could record.
 */
const resolvedParents = v.object({
  proposalId: v.id("proposals"),
  wbs: v.array(v.object({ firestoreId: v.string(), wbsId: v.id("wbs") })),
  phases: v.array(
    v.object({ firestoreId: v.string(), phaseId: v.id("phases"), wbsId: v.id("wbs") })
  ),
  /**
   * Parents a DRY RUN decided it would create but did not.
   *
   * ⚠️ WITHOUT THESE A DRY RUN LIES ABOUT EXACTLY THE TREES IT IS RUN FOR. The
   * forecast sets are local to one mutation call, and a real id is the only
   * thing `wbs`/`phases` can carry — so a proposal that exists with no tree
   * (all 121 of them: the 6-hourly proposals cron creates the metadata, the
   * full pull never happened) forecasts its phases in the first chunk and then
   * has nothing to resolve against in the next. Every activity in the tree
   * counts unresolved and the forecast reports 0 inserts for a tree that a real
   * run would fill completely.
   *
   * Firestore ids only — there is no Convex id to carry, which is the point.
   */
  wbsForecast: v.optional(v.array(v.string())),
  phaseForecast: v.optional(v.array(v.string())),
});

type ResolvedParents = Infer<typeof resolvedParents>;

/** Why a whole tree was left alone. */
const treeSkipReason = v.union(
  v.literal("precision_owned"),
  v.literal("deleted_in_precision"),
  v.literal("missing_upstream")
);

type TreeSkip = Infer<typeof treeSkipReason>;

/** Per-level tallies for one tree, in the shape the run report stores. */
export interface ByLevelCounts {
  proposal: LevelCounts;
  wbs: LevelCounts;
  phase: LevelCounts;
  activity: LevelCounts;
}

/** What one call of {@link upsertProposalHierarchy} did. */
export interface HierarchyUpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  skipReason: TreeSkip | null;
  /** Catalog links the suppression rule withheld — see `model/syncDiff.ts`. */
  suppressedLinks: number;
  /** Incoming rows whose parent never resolved, so nothing was written. */
  unresolved: number;
  byLevel: ByLevelCounts;
  /**
   * Every parent this tree has resolved so far, to hand to the next chunk.
   *
   * CUMULATIVE, not per-call: it carries the `resolved` handed in plus whatever
   * this chunk added. A per-call answer forced the caller to merge the two, and
   * a caller that merged only the phases — the level that actually chunks —
   * silently dropped the WBS map, leaving every activity in the tree unresolved
   * and unwritten with nothing but a counter to say so.
   */
  resolved: ResolvedParents | null;
}

/**
 * A mutable tally, because a level is counted one row at a time.
 *
 * `LevelCounts` is readonly in the pure module on purpose — the differ hands out
 * finished answers. Accumulating one needs the opposite, so the loops build this
 * and it widens back into a `LevelCounts` on the way out.
 */
interface Tally {
  insert: number;
  patch: number;
  unchanged: number;
  orphaned: number;
  localOnly: number;
  duplicate: number;
}

function tally(): Tally {
  return { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 };
}

/** A zeroed per-level roster. */
function emptyByLevel(): ByLevelCounts {
  return {
    proposal: emptyLevelCounts(),
    wbs: emptyLevelCounts(),
    phase: emptyLevelCounts(),
    activity: emptyLevelCounts(),
  };
}

/** A result that touched nothing, optionally saying why. */
function noWork(skipReason: TreeSkip | null): HierarchyUpsertResult {
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: skipReason === null ? 0 : 1,
    skipReason,
    suppressedLinks: 0,
    unresolved: 0,
    byLevel: emptyByLevel(),
    resolved: null,
  };
}

/**
 * Hand an open field map to `ctx.db`.
 *
 * The differ speaks in open field maps and the database speaks in table shapes,
 * and nothing at compile time can bridge them here: these rows arrive through
 * `v.any()` arguments that a Firestore document filled, so the compiler has
 * never had a shape to check. The schema validator is what checks them — on
 * write, where a bad row is rejected rather than silently stored. Admitted once,
 * in one place, instead of smeared across every call site.
 */
function asInsert<T extends TableNames>(
  fields: Readonly<Record<string, unknown>>
): WithoutSystemFields<Doc<T>> {
  return fields as unknown as WithoutSystemFields<Doc<T>>;
}

/** The patch counterpart of {@link asInsert}. */
function asPatch<T extends TableNames>(fields: Readonly<Record<string, unknown>>): Partial<Doc<T>> {
  return fields as unknown as Partial<Doc<T>>;
}

/**
 * One child row's verdict and the exact field map to write for it.
 *
 * The `mirrorDeletedAt` clear is folded into `changed` rather than patched
 * separately so that "did this row move" and "what do we write" stay a single
 * decision: a row that only needs its stale orphan flag lifted is a patch, and
 * a row that needs nothing is not written at all.
 */
function decideRow(
  level: SyncLevel,
  incoming: SyncRow,
  existing: SyncRow | null
): {
  verdict: "insert" | "patch" | "unchanged";
  changed: Record<string, unknown>;
  suppressed: number;
} {
  const diff = diffRow(level, incoming, existing);
  const changed: Record<string, unknown> = { ...diff.changed };
  // Firestore is answering for this row again, so an orphan flag from an earlier
  // pass is stale. Clearing on sight is what makes one bad read self-healing
  // instead of leaving the row condemned.
  if (existing && existing.mirrorDeletedAt !== undefined) changed.mirrorDeletedAt = undefined;
  return {
    verdict: !existing ? "insert" : Object.keys(changed).length > 0 ? "patch" : "unchanged",
    changed,
    suppressed: diff.suppressed.length,
  };
}

// ============================================================================
// Job Management
// ============================================================================

/**
 * How long a run may go without a heartbeat before it counts as dead.
 *
 * ARITHMETIC, not a round number. The slowest single hop is one 10K-activity
 * estimate — a Firestore `runQuery` pull, ten write transactions and an orphan
 * scan — which the ~100s action ceiling caps at under two minutes by
 * construction. Ten minutes is five times that: a healthy run is never
 * reclaimed, and a chain killed by a hard runtime abort (the kind that dies
 * before its own `catch`) is provably dead ten minutes later instead of wedging
 * the pipeline for ever.
 *
 * This used to be measured from `startedAt` with a 30-minute window, which was
 * right when the only sync finished in seconds and would have reclaimed a
 * perfectly healthy full pass halfway through.
 */
const SYNC_STALL_AFTER_MS = 10 * 60 * 1000;

/**
 * Attempts one proposal gets before the run gives up on it and walks on.
 *
 * WHY A LIMIT AT ALL — this is the wedge the heartbeat alone does not prevent.
 * `recordProposalOutcome` is what advances the cursor, and a hop killed by the
 * ~100s action ceiling never reaches it, so the cursor stays pointing at the
 * proposal that did the killing. Every resume then starts at exactly that
 * proposal and dies at exactly the same place, and the 400 proposals behind it
 * never sync again. That is not hypothetical: an estimate large enough that its
 * Firestore read plus its write chunks exceed the ceiling is permanently large.
 *
 * THREE, because the failures worth surviving are transient (a Firestore 503, a
 * cold start, one unlucky hop) and the failure worth quarantining is not — a
 * proposal that cannot be read three times cannot be read. The quarantine is
 * loud: a report row and a job error naming the id, so "the mirror gave up on
 * this one" is something a person can read rather than something they deduce
 * from a total that never reaches 736.
 */
const MAX_PROPOSAL_ATTEMPTS = 3;

/**
 * Create a sync job, or decline because one is genuinely in flight.
 *
 * RETURNS `null` RATHER THAN THROWING when a healthy run holds the lane. The
 * proposals-only cron ticks every 6 hours and a full pass runs for tens of
 * minutes, so an overlap is expected operation rather than an incident —
 * throwing would file an error every time the two lined up and train everyone
 * to ignore the ones that matter.
 *
 * A stale run is reclaimed first, so one dead pass can never wedge the pipeline.
 */
export const createSyncJob = internalMutation({
  args: {
    totalProposals: v.number(),
    mode: v.optional(v.union(v.literal("proposals"), v.literal("full"))),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"syncJobs"> | null> => {
    const now = Date.now();
    const running = await ctx.db
      .query("syncJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    for (const job of running) {
      const idleFor = now - (job.lastProgressAt ?? job.startedAt ?? job._creationTime);
      if (idleFor < SYNC_STALL_AFTER_MS) return null;
      await ctx.db.patch(job._id, {
        status: "failed",
        completedAt: now,
        error: `Reclaimed: no progress for ${Math.round(idleFor / 1000)}s.`,
      });
    }

    return ctx.db.insert("syncJobs", {
      status: "running",
      mode: args.mode ?? "proposals",
      dryRun: args.dryRun,
      totalProposals: args.totalProposals,
      processedProposals: 0,
      insertedRecords: 0,
      updatedRecords: 0,
      unchangedRecords: 0,
      orphanedRecords: 0,
      suppressedLinks: 0,
      skippedProposals: 0,
      unresolvedRecords: 0,
      errors: [],
      startedAt: now,
      lastProgressAt: now,
    });
  },
});

/**
 * Hand a full pass the list of proposals it intends to visit.
 *
 * The queue is written ONCE and never shrinks — `processedProposals` is the
 * cursor into it. Keeping the whole list is what lets the final step flag
 * proposals that vanished from Firestore, a set difference a shrinking queue
 * would have thrown away, and 736 ids is about 15 KB against a 1 MiB document.
 */
export const setSyncJobQueue = internalMutation({
  args: { jobId: v.id("syncJobs"), proposalQueue: v.array(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      proposalQueue: args.proposalQueue,
      totalProposals: args.proposalQueue.length,
      lastProgressAt: Date.now(),
    });
  },
});

/** The proposal a full pass should visit next, and whether it should bother. */
export const nextQueuedProposal = internalQuery({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running")
      return { active: false, dryRun: false, index: 0, total: 0, proposalFsId: null };
    const queue = job.proposalQueue ?? [];
    return {
      active: true,
      dryRun: job.dryRun === true,
      index: job.processedProposals,
      total: queue.length,
      proposalFsId: queue[job.processedProposals] ?? null,
    };
  },
});

/** Every proposal id a full pass set out to visit — the orphan sweep's authority. */
export const getSyncJobQueue = internalQuery({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    return { proposalQueue: job?.proposalQueue ?? [], dryRun: job?.dryRun === true };
  },
});

/** Update sync job progress. */
export const updateSyncProgress = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    processedProposals: v.number(),
    insertedRecords: v.number(),
    updatedRecords: v.number(),
    unchangedRecords: v.optional(v.number()),
    skippedProposals: v.optional(v.number()),
    lastProposalPageToken: v.optional(v.string()),
    newErrors: v.optional(
      v.array(
        v.object({
          firestoreId: v.string(),
          collection: v.string(),
          error: v.string(),
          timestamp: v.number(),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;

    const errors = args.newErrors
      ? [...(job.errors ?? []), ...args.newErrors].slice(-200)
      : job.errors;

    await ctx.db.patch(args.jobId, {
      processedProposals: args.processedProposals,
      insertedRecords: args.insertedRecords,
      updatedRecords: args.updatedRecords,
      unchangedRecords: args.unchangedRecords ?? job.unchangedRecords,
      skippedProposals: args.skippedProposals ?? job.skippedProposals,
      lastProposalPageToken: args.lastProposalPageToken,
      lastProgressAt: Date.now(),
      errors,
    });
  },
});

/**
 * Record one proposal's outcome and advance the run's cursor.
 *
 * ONE CALL PER PROPOSAL, unconditionally, even when nothing was written —
 * because this call IS the heartbeat. A run that only reported when it had news
 * would be indistinguishable from a dead one across a long stretch of unchanged
 * estimates, which is precisely the state the link repair could not prove it was
 * not in.
 *
 * The report ROW, by contrast, is written only when the pass actually did
 * something. A healthy steady-state pass therefore leaves 736 heartbeats and
 * almost no report rows, and the table reads as a change log rather than a log
 * of having been alive.
 *
 * ⚠️ THE CURSOR MOVES ONLY FROM WHERE THE CALLER THOUGHT IT WAS. `atIndex` makes
 * this a compare-and-swap rather than a blind `+ 1`, because `+ 1` is only safe
 * while exactly one chain is alive and nothing enforces that: a hop the
 * scheduler ran twice, or a zombie chain from a run that was reclaimed and then
 * resumed, would each add one and step the cursor over a proposal NOBODY
 * visited. Skipping a proposal is the one failure this design cannot detect
 * afterwards — the pass reports 736 processed and the estimate nobody read stays
 * silently stale for ever.
 */
export const recordProposalOutcome = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    /** The queue index the caller claimed. The write is dropped if it moved. */
    atIndex: v.number(),
    firestoreId: v.string(),
    proposalNumber: v.string(),
    proposalId: v.optional(v.id("proposals")),
    skipped: v.optional(treeSkipReason),
    byLevel: byLevelValidator,
    suppressedLinks: v.number(),
    unresolved: v.number(),
    orphanScanIncomplete: v.optional(v.boolean()),
    orphanScanRefused: v.optional(v.boolean()),
    error: v.optional(v.string()),
    durationMs: v.number(),
  },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return { applied: false };

    // Somebody else already moved past this proposal. The tree work itself was
    // differential and idempotent, so dropping the bookkeeping loses a report
    // row and nothing else — where applying it would lose a whole proposal.
    if (job.processedProposals !== args.atIndex) {
      console.warn(
        `[sync] dropping a stale outcome for ${args.firestoreId}: claimed index ${args.atIndex}, cursor is at ${job.processedProposals}.`
      );
      return { applied: false };
    }

    const now = Date.now();
    const counts = sumLevelCounts(
      args.byLevel.proposal,
      args.byLevel.wbs,
      args.byLevel.phase,
      args.byLevel.activity
    );

    // A REFUSAL IS THE LOUDEST THING A PASS CAN FIND, so it has to be in this
    // list. `orphanScanRefused` means a level read back EMPTY while Convex holds
    // rows for it — a whole estimate's lines apparently gone. The scan is right
    // to refuse rather than condemn them, but the report row is the only place
    // that fact is written down: none of the counters move, because refusing is
    // precisely the decision not to move any. Leaving it out made a suspected
    // bad read against a live estimate the one event the change log never
    // mentions. `orphanScanIncomplete` is here for the same reason, one notch
    // quieter: it says the pass did not finish looking.
    //
    // `duplicate` is here and `localOnly` deliberately is not. A second stored
    // row sharing one mirror key is a standing fault that never resolves itself
    // — the upsert updates one copy for ever and the other drifts — so it is
    // worth repeating every pass until somebody fixes it. A Precision-born row
    // is ordinary, and reporting one daily for ever would turn the change log
    // back into the heartbeat log this table exists not to be.
    const notable =
      counts.insert > 0 ||
      counts.patch > 0 ||
      counts.orphaned > 0 ||
      counts.duplicate > 0 ||
      args.unresolved > 0 ||
      args.orphanScanRefused === true ||
      args.orphanScanIncomplete === true ||
      args.skipped !== undefined ||
      args.error !== undefined;

    if (notable) {
      // ⚠️ THE ROWS THAT ARRIVE NAMELESS ARE THE ROWS PEOPLE READ. A proposal
      // whose tree read threw, or whose document 404ed, never got as far as
      // being mapped, so the caller has no number to pass and the report row
      // would identify a live estimate by nothing but a Firestore id — on
      // exactly the rows somebody is trying to look up. One indexed read, and
      // only on rows that already went wrong, buys the number back.
      let proposalNumber = args.proposalNumber;
      if (proposalNumber === "") {
        const stored = await ctx.db
          .query("proposals")
          .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.firestoreId))
          .first();
        proposalNumber = stored?.proposalNumber ?? "";
      }

      await ctx.db.insert("syncProposalReports", {
        jobId: args.jobId,
        proposalId: args.proposalId,
        firestoreId: args.firestoreId,
        proposalNumber,
        skipped: args.skipped,
        byLevel: args.byLevel,
        counts,
        suppressedLinks: args.suppressedLinks,
        unresolved: args.unresolved,
        orphanScanIncomplete: args.orphanScanIncomplete,
        orphanScanRefused: args.orphanScanRefused,
        error: args.error?.slice(0, 300),
        at: now,
        durationMs: args.durationMs,
      });
    }

    const errors = args.error
      ? [
          ...(job.errors ?? []),
          {
            firestoreId: args.firestoreId,
            collection: "tree",
            error: args.error.slice(0, 300),
            timestamp: now,
          },
        ].slice(-200)
      : job.errors;

    await ctx.db.patch(args.jobId, {
      processedProposals: args.atIndex + 1,
      insertedRecords: job.insertedRecords + counts.insert,
      updatedRecords: (job.updatedRecords ?? 0) + counts.patch,
      unchangedRecords: (job.unchangedRecords ?? 0) + counts.unchanged,
      orphanedRecords: (job.orphanedRecords ?? 0) + counts.orphaned,
      suppressedLinks: (job.suppressedLinks ?? 0) + args.suppressedLinks,
      unresolvedRecords: (job.unresolvedRecords ?? 0) + args.unresolved,
      skippedProposals: (job.skippedProposals ?? 0) + (args.skipped === undefined ? 0 : 1),
      lastProgressAt: now,
      errors,
    });
    return { applied: true };
  },
});

/** Mark sync job as completed or failed. */
export const completeSyncJob = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    processedProposals: v.optional(v.number()),
    insertedRecords: v.optional(v.number()),
    updatedRecords: v.optional(v.number()),
    /** Proposal-level orphans found by the final sweep, added to the running total. */
    addOrphanedRecords: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const now = Date.now();
    const patch: Partial<Doc<"syncJobs">> = {
      status: args.status,
      completedAt: now,
      lastProgressAt: now,
    };
    if (args.processedProposals !== undefined) patch.processedProposals = args.processedProposals;
    if (args.insertedRecords !== undefined) patch.insertedRecords = args.insertedRecords;
    if (args.updatedRecords !== undefined) patch.updatedRecords = args.updatedRecords;
    if (args.addOrphanedRecords !== undefined) {
      patch.orphanedRecords = (job.orphanedRecords ?? 0) + args.addOrphanedRecords;
    }
    if (args.error !== undefined) patch.error = args.error.slice(0, 500);
    await ctx.db.patch(args.jobId, patch);
  },
});

/**
 * Pick a broken full pass back up where it stopped.
 *
 * ACCEPTS A STALLED RUN, not only a failed one — the same rule, for the same
 * reason, as `resumeLinkRepair`. A chain killed by a runtime limit never reaches
 * its own error handler, so the job it belonged to is still marked `running`;
 * without this it would block every future pass for ever while doing nothing.
 * "Stalled" is a fact here rather than a guess, because every proposal writes
 * `lastProgressAt`.
 *
 * Resuming costs nothing that was already done. The cursor is the queue index,
 * and re-visiting a proposal that was already mirrored produces a pass of
 * UNCHANGED verdicts and zero writes — which is also why an over-eager resume is
 * harmless.
 *
 * ⚠️ THE ONE RESUME THAT IS NOT FREE is the third one at the same cursor. See
 * {@link MAX_PROPOSAL_ATTEMPTS}: a proposal that has already killed this run
 * three times is quarantined with an error and the walk moves on, because the
 * alternative is a run that re-attempts its largest estimate for ever and never
 * reaches the proposals behind it.
 */
export const resumeEstateSync = internalMutation({
  args: { jobId: v.optional(v.id("syncJobs")) },
  handler: async (ctx, args) => {
    const job = args.jobId
      ? await ctx.db.get(args.jobId)
      : ((
          await ctx.db
            .query("syncJobs")
            .withIndex("by_mode_started", (q) => q.eq("mode", "full"))
            .order("desc")
            .take(1)
        )[0] ?? null);
    if (!job) throw new Error("No full sync run to resume.");

    // Only a full pass carries a queue. Resuming a proposals-only run would
    // schedule the estate chain against an empty one, which walks straight to
    // the closing sweep and stamps a proposals job "completed" as if it had
    // mirrored 736 trees.
    if ((job.mode ?? "proposals") !== "full") {
      throw new Error("Only a full-estate pass has a queue to resume.");
    }

    const now = Date.now();
    const idleFor = now - (job.lastProgressAt ?? job.startedAt);
    const stalled = job.status === "running" && idleFor > SYNC_STALL_AFTER_MS;
    if (job.status !== "failed" && !stalled) {
      throw new Error(
        job.status === "running"
          ? `That run is still working — it made progress ${Math.round(idleFor / 1000)}s ago.`
          : `That run is ${job.status}; there is nothing to resume.`
      );
    }

    // ⚠️ A RESUME IS A SECOND WRITER unless this refuses. `createSyncJob` gives
    // one run the lane, but nothing routes through it here: a stalled run that
    // the 6-hourly tick already reclaimed can be resumed by hand while the run
    // that reclaimed it is still going, and then two chains walk the same queue,
    // each advancing the OTHER's cursor past a proposal nobody visited.
    const running = await ctx.db
      .query("syncJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    for (const other of running) {
      if (other._id === job._id) continue;
      const otherIdle = now - (other.lastProgressAt ?? other.startedAt ?? other._creationTime);
      if (otherIdle < SYNC_STALL_AFTER_MS) {
        throw new Error(
          `Another sync is in flight (${other.mode ?? "proposals"}, last progress ${Math.round(otherIdle / 1000)}s ago). Resume once it finishes.`
        );
      }
    }

    const queue = job.proposalQueue ?? [];
    let index = job.processedProposals;
    // A first attempt at this cursor unless the previous resume left its mark
    // here — which is the only evidence that survives a hop killed mid-flight.
    let attempt = job.attemptIndex === index ? (job.attemptCount ?? 1) + 1 : 1;
    const errors = [...(job.errors ?? [])];
    let quarantined: string | null = null;

    if (attempt > MAX_PROPOSAL_ATTEMPTS && index < queue.length) {
      quarantined = queue[index] ?? "";
      const message = `Quarantined after ${MAX_PROPOSAL_ATTEMPTS} attempts: no hop ever reported an outcome for this proposal.`;
      await ctx.db.insert("syncProposalReports", {
        jobId: job._id,
        firestoreId: quarantined,
        proposalNumber: "",
        byLevel: emptyByLevel(),
        counts: emptyLevelCounts(),
        suppressedLinks: 0,
        unresolved: 0,
        error: message,
        at: now,
        durationMs: 0,
      });
      errors.push({
        firestoreId: quarantined,
        collection: "tree",
        error: message,
        timestamp: now,
      });
      index += 1;
      attempt = 1;
    }

    await ctx.db.patch(job._id, {
      status: "running",
      error: undefined,
      completedAt: undefined,
      processedProposals: index,
      attemptIndex: index,
      attemptCount: attempt,
      errors: errors.slice(-200),
      lastProgressAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.sync.syncEngine.syncNextProposal, { jobId: job._id });
    return {
      jobId: job._id,
      resumedAt: index,
      total: job.totalProposals,
      attempt,
      quarantined,
    };
  },
});

// ============================================================================
// Orphan flagging — reported, never deleted
// ============================================================================

/** One stored row, reduced to what an orphan decision actually needs. */
export interface MirrorKey {
  id: string;
  /** `null` for a row born in Precision: it was never mirrored. */
  firestoreId: string | null;
  flagged: boolean;
}

/** One page of {@link MirrorKey}s, with the cursor to continue from. */
export interface MirrorKeyPage {
  keys: MirrorKey[];
  cursor: string | null;
  isDone: boolean;
}

/** Project a page of mirrored rows down to their keys. */
function asKeys(page: {
  page: readonly { _id: string; firestoreId?: string; mirrorDeletedAt?: number }[];
  continueCursor: string;
  isDone: boolean;
}): MirrorKeyPage {
  return {
    keys: page.page.map((row) => ({
      id: row._id,
      firestoreId: row.firestoreId ?? null,
      flagged: row.mirrorDeletedAt !== undefined,
    })),
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * The mirror keys of one page of stored rows.
 *
 * Deliberately returns keys rather than doing the set difference itself: the
 * complete incoming id set lives in the action that just read Firestore, and
 * shipping three small fields per stored row up to it is far cheaper than
 * shipping ten thousand ids down. `proposalId` is omitted only for the proposal
 * level, whose scope is the whole table.
 */
export const listMirrorKeys = internalQuery({
  args: {
    level: mirrorLevel,
    proposalId: v.optional(v.id("proposals")),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<MirrorKeyPage> => {
    const opts = { cursor: args.cursor, numItems: args.numItems };
    const proposalId = args.proposalId;
    const empty: MirrorKeyPage = { keys: [], cursor: null, isDone: true };

    switch (args.level) {
      case "proposal": {
        return asKeys(await ctx.db.query("proposals").paginate(opts));
      }
      case "wbs": {
        if (proposalId === undefined) return empty;
        return asKeys(
          await ctx.db
            .query("wbs")
            .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
            .paginate(opts)
        );
      }
      case "phase": {
        if (proposalId === undefined) return empty;
        return asKeys(
          await ctx.db
            .query("phases")
            .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
            .paginate(opts)
        );
      }
      case "activity": {
        if (proposalId === undefined) return empty;
        return asKeys(
          await ctx.db
            .query("activities")
            .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
            .paginate(opts)
        );
      }
    }
  },
});

/**
 * Set or clear one row's orphan flag.
 *
 * Written as an exhaustive switch rather than a table-name lookup so the
 * compiler checks each write against the table it lands in. The four branches
 * are worth more than the six lines they cost: this is the function that must
 * never write the wrong row.
 */
async function setMirrorFlag(
  ctx: MutationCtx,
  level: Infer<typeof mirrorLevel>,
  rawId: string,
  at: number | undefined
): Promise<boolean> {
  switch (level) {
    case "proposal": {
      const id = ctx.db.normalizeId("proposals", rawId);
      if (!id) return false;
      await ctx.db.patch(id, { mirrorDeletedAt: at });
      return true;
    }
    case "wbs": {
      const id = ctx.db.normalizeId("wbs", rawId);
      if (!id) return false;
      await ctx.db.patch(id, { mirrorDeletedAt: at });
      return true;
    }
    case "phase": {
      const id = ctx.db.normalizeId("phases", rawId);
      if (!id) return false;
      await ctx.db.patch(id, { mirrorDeletedAt: at });
      return true;
    }
    case "activity": {
      const id = ctx.db.normalizeId("activities", rawId);
      if (!id) return false;
      await ctx.db.patch(id, { mirrorDeletedAt: at });
      return true;
    }
  }
}

/**
 * Mark rows Firestore stopped returning, and unmark rows that came back.
 *
 * ⚠️ THE FLAG IS THE WHOLE ACTION. There is no delete here and there must never
 * be one: `momentumActivities.sourceActivityId` points at these rows from a
 * product people are using right now, and a dangling id is a crash on somebody's
 * field tablet, not a tidy database.
 *
 * Unflagging matters as much as flagging. The mirror finds a tree with a
 * `proposalId` equality query, so a line whose legacy parent pointer is briefly
 * wrong looks deleted for one pass; clearing on sight means that heals itself.
 */
export const flagMirrorOrphans = internalMutation({
  args: {
    level: mirrorLevel,
    flag: v.array(v.string()),
    clear: v.array(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    let flagged = 0;
    let cleared = 0;
    for (const rawId of args.flag) {
      if (await setMirrorFlag(ctx, args.level, rawId, args.at)) flagged++;
    }
    for (const rawId of args.clear) {
      if (await setMirrorFlag(ctx, args.level, rawId, undefined)) cleared++;
    }
    return { flagged, cleared };
  },
});

// ============================================================================
// Hierarchy Upsert
// ============================================================================

/**
 * Upsert a proposal and its hierarchy (WBS → phases → activities), writing only
 * the rows whose mirrored content actually moved.
 *
 * WHY DIFFERENTIAL AND NOT BLIND. Blind patching cost up to 352,969 writes a
 * pass and invalidated every estimate's cached total every pass, which is why
 * the full-tree sync sat on the shelf instead of on a cron. Every verdict here
 * comes from `diffRow`, including the catalog-link rule: a repaired
 * `laborPoolId` is withheld unless the description changed, so the 8,944 links
 * re-pointed on 2026-08-05 cost zero writes per pass instead of being undone by
 * the stale ids Firestore still holds. That rule now has exactly one
 * implementation, in `model/syncDiff.ts`, and this mutation defers to it.
 *
 * Call it once for a small tree, or chunk a large one and thread `resolved`
 * through so later chunks never re-derive the parent maps.
 */
export const upsertProposalHierarchy = internalMutation({
  args: {
    proposal: v.any(),
    wbsList: v.array(v.any()),
    phasesList: v.array(v.any()),
    activitiesList: v.array(v.any()),
    resolved: v.optional(resolvedParents),
    /**
     * A later chunk of a tree whose proposal row an earlier chunk already
     * decided. Redundant alongside `resolved`, and load-bearing without it: a
     * DRY RUN of a new estimate resolves no parent ids at all, so without this
     * every chunk would forecast the same proposal insert again and the run
     * report would claim six new estimates where there is one.
     */
    continuation: v.optional(v.boolean()),
    /** Diff and report exactly as a real pass would, and write nothing. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<HierarchyUpsertResult> => {
    const dryRun = args.dryRun === true;
    const proposalTally = tally();
    const wbsTally = tally();
    const phaseTally = tally();
    const activityTally = tally();
    let suppressedLinks = 0;
    let unresolved = 0;
    let ratesMoved = false;

    const incomingProposal: SyncRow = args.proposal;
    const firestoreId = String(incomingProposal.firestoreId ?? "");

    // ------------------------------------------------------------------
    // 1. The proposal, and the two rules that stop the whole tree
    // ------------------------------------------------------------------
    let proposalId: Id<"proposals"> | null = args.resolved?.proposalId ?? null;
    const existingProposal = proposalId
      ? await ctx.db.get(proposalId)
      : await ctx.db
          .query("proposals")
          .withIndex("by_firestore_id", (q) => q.eq("firestoreId", firestoreId))
          .first();

    // Precision has taken ownership of this estimate, so the mirror stops here.
    // Continuing would revert the whole tree — metadata, all 15 rates, and every
    // WBS/phase/activity — to the estimator's version, silently destroying the
    // user's work. Returning before any write in THIS call keeps the mutation
    // itself all-or-nothing. See DECISIONS.md D1.
    //
    // CHECKED ON EVERY CHUNK, INCLUDING LATER ONES. It used to be checked only
    // where the proposal was looked up, so a Precision write landing between
    // chunks of a large import left the earlier chunks already reverted while
    // the later ones returned early. Re-reading the proposal costs one document
    // per chunk and closes that window.
    if (existingProposal?.precisionOwnedAt !== undefined) {
      console.log(
        `[sync] skipping ${existingProposal.proposalNumber}: owned by Precision since ${new Date(existingProposal.precisionOwnedAt).toISOString()}`
      );
      return noWork("precision_owned");
    }

    // Deleted between chunks — there is nothing left to write into.
    if (proposalId !== null && !existingProposal) return noWork("deleted_in_precision");

    // Deliberately deleted in Precision: the estimate still exists in
    // Firestore, but re-inserting it would silently revert the deletion.
    // Deletion wins — see the proposalTombstones schema comment.
    if (!existingProposal) {
      const tombstone = await ctx.db
        .query("proposalTombstones")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", firestoreId))
        .first();
      if (tombstone) {
        console.log(
          `[sync] skipping ${tombstone.proposalNumber}: deleted in Precision at ${new Date(tombstone.deletedAt).toISOString()}`
        );
        return noWork("deleted_in_precision");
      }
    }

    if (!args.resolved && args.continuation !== true) {
      const decision = decideRow("proposal", incomingProposal, existingProposal);
      ratesMoved = "rates" in decision.changed;

      if (!existingProposal) {
        proposalTally.insert++;
        if (!dryRun) {
          // A mirrored estimate is priced with the constants the MCP Estimator
          // used, so it pins to the book those constants came from — not to
          // whatever book happens to be default now. Set on INSERT ONLY:
          // patching it would stomp a deliberate rebinding on every pass.
          const legacyBook = await ctx.db
            .query("rateBooks")
            .withIndex("by_status", (q) => q.eq("status", "published"))
            .filter((q) => q.eq(q.field("legacyDatasetVersion"), "v1"))
            .first();
          const fallbackBook = legacyBook
            ? null
            : await ctx.db
                .query("rateBooks")
                .withIndex("by_default", (q) => q.eq("isDefault", true))
                .first();
          proposalId = await ctx.db.insert(
            "proposals",
            asInsert<"proposals">({
              ...decision.changed,
              bookId: legacyBook?._id ?? fallbackBook?._id,
            })
          );
        }
      } else {
        proposalId = existingProposal._id;
        if (decision.verdict === "patch") {
          proposalTally.patch++;
          if (!dryRun) await ctx.db.patch(proposalId, asPatch<"proposals">(decision.changed));
        } else {
          proposalTally.unchanged++;
        }
      }
    }

    // A dry run against a proposal that does not exist yet cannot resolve any
    // parent id, because nothing was inserted to resolve to. Every child is
    // necessarily new, so report it as such rather than as unresolved — the
    // point of a dry run is an honest forecast, and "0 inserts, 11 unresolved"
    // forecasts the opposite of the truth.
    const forecastOnly = proposalId === null;

    // ------------------------------------------------------------------
    // 2. WBS
    // ------------------------------------------------------------------
    const wbsMap = new Map<string, Id<"wbs">>();
    const wbsForecast = new Set<string>(args.resolved?.wbsForecast ?? []);
    for (const entry of args.resolved?.wbs ?? []) wbsMap.set(entry.firestoreId, entry.wbsId);
    // Seeded with what was handed in, so the returned map is the tree's whole
    // answer rather than this chunk's. See {@link HierarchyUpsertResult.resolved}.
    const resolvedWbs: ResolvedParents["wbs"] = [...(args.resolved?.wbs ?? [])];

    for (const row of args.wbsList as SyncRow[]) {
      const rowFsId = String(row.firestoreId ?? "");
      if (forecastOnly) {
        wbsTally.insert++;
        wbsForecast.add(rowFsId);
        continue;
      }
      const existing = await ctx.db
        .query("wbs")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", rowFsId))
        .first();
      const decision = decideRow("wbs", { ...row, proposalId }, existing);
      if (!existing) {
        wbsTally.insert++;
        if (dryRun) {
          wbsForecast.add(rowFsId);
          continue;
        }
        const id = await ctx.db.insert("wbs", asInsert<"wbs">(decision.changed));
        wbsMap.set(rowFsId, id);
        resolvedWbs.push({ firestoreId: rowFsId, wbsId: id });
        continue;
      }
      if (decision.verdict === "patch") {
        wbsTally.patch++;
        if (!dryRun) await ctx.db.patch(existing._id, asPatch<"wbs">(decision.changed));
      } else {
        wbsTally.unchanged++;
      }
      wbsMap.set(rowFsId, existing._id);
      resolvedWbs.push({ firestoreId: rowFsId, wbsId: existing._id });
    }

    // No WBS in this chunk and no map handed down, but children need parents —
    // fall back to what the database already holds. This is the scan `resolved`
    // exists to avoid; it is kept only for callers that predate it.
    const treeProposalId = proposalId;
    if (
      treeProposalId !== null &&
      wbsMap.size === 0 &&
      (args.phasesList.length > 0 || args.activitiesList.length > 0)
    ) {
      const stored = await ctx.db
        .query("wbs")
        .withIndex("by_proposal", (q) => q.eq("proposalId", treeProposalId))
        .collect();
      for (const row of stored) if (row.firestoreId) wbsMap.set(row.firestoreId, row._id);
    }

    // ------------------------------------------------------------------
    // 3. Phases
    // ------------------------------------------------------------------
    const phaseMap = new Map<string, Id<"phases">>();
    const carriedPhaseForecast = new Set<string>(args.resolved?.phaseForecast ?? []);
    // Firestore phase id -> the WBS that phase belongs to. An activity's own
    // wbsId is NOT trustworthy (see the note at the activity loop below), so
    // this is the authority for denormalizing wbsId onto activities.
    const phaseWbsMap = new Map<string, Id<"wbs">>();
    const phaseForecast = new Set<string>(carriedPhaseForecast);
    for (const entry of args.resolved?.phases ?? []) {
      phaseMap.set(entry.firestoreId, entry.phaseId);
      phaseWbsMap.set(entry.firestoreId, entry.wbsId);
    }
    const resolvedPhases: ResolvedParents["phases"] = [...(args.resolved?.phases ?? [])];

    for (const row of args.phasesList as SyncRow[]) {
      const rowFsId = String(row.firestoreId ?? "");
      const fsWbsId = String(row.fsWbsId ?? "");
      const wbsId = wbsMap.get(fsWbsId);
      if (wbsId === undefined) {
        if (forecastOnly || wbsForecast.has(fsWbsId)) {
          phaseTally.insert++;
          phaseForecast.add(rowFsId);
        } else {
          unresolved++;
        }
        continue;
      }
      const existing = await ctx.db
        .query("phases")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", rowFsId))
        .first();
      const decision = decideRow("phase", { ...row, proposalId, wbsId }, existing);
      phaseWbsMap.set(rowFsId, wbsId);
      if (!existing) {
        phaseTally.insert++;
        if (dryRun) {
          phaseForecast.add(rowFsId);
          continue;
        }
        const id = await ctx.db.insert("phases", asInsert<"phases">(decision.changed));
        phaseMap.set(rowFsId, id);
        resolvedPhases.push({ firestoreId: rowFsId, phaseId: id, wbsId });
        continue;
      }
      if (decision.verdict === "patch") {
        phaseTally.patch++;
        if (!dryRun) await ctx.db.patch(existing._id, asPatch<"phases">(decision.changed));
      } else {
        phaseTally.unchanged++;
      }
      phaseMap.set(rowFsId, existing._id);
      resolvedPhases.push({ firestoreId: rowFsId, phaseId: existing._id, wbsId });
    }

    // Same fallback as WBS, for the same reason.
    if (treeProposalId !== null && phaseMap.size === 0 && args.activitiesList.length > 0) {
      const stored = await ctx.db
        .query("phases")
        .withIndex("by_proposal", (q) => q.eq("proposalId", treeProposalId))
        .collect();
      for (const row of stored) {
        if (row.firestoreId) {
          phaseMap.set(row.firestoreId, row._id);
          phaseWbsMap.set(row.firestoreId, row.wbsId);
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Activities
    // ------------------------------------------------------------------
    // Counts activities whose Firestore wbsId disagrees with their phase's WBS.
    // Legacy's copy-activities-between-phases wrote only phaseId and carried
    // wbsId over from the SOURCE activity, so any activity copied into a phase
    // under a different WBS permanently claims the wrong one. Importing that
    // verbatim is worse in Precision than it was in legacy, because the rollups
    // group by different keys: the WBS table and the direct/indirect split group
    // by activity.wbsId, while the phase drill-down and the Excel export group
    // by phase. Four surfaces, three answers, no error raised.
    let wbsMismatches = 0;

    for (const row of args.activitiesList as SyncRow[]) {
      const rowFsId = String(row.firestoreId ?? "");
      const fsPhaseId = String(row.fsPhaseId ?? "");
      const phaseId = phaseMap.get(fsPhaseId);
      // The phase owns the WBS relationship — derive from it, never from the
      // activity's own wbsId.
      const wbsId = phaseWbsMap.get(fsPhaseId);
      if (wbsId === undefined || phaseId === undefined) {
        if (forecastOnly || phaseForecast.has(fsPhaseId)) activityTally.insert++;
        else unresolved++;
        continue;
      }
      if (wbsMap.get(String(row.fsWbsId ?? "")) !== wbsId) wbsMismatches++;

      // Matched by firestoreId, NOT within the phase: a line moved to another
      // phase in MCP has to be RE-PARENTED in place. Matching within a phase
      // would insert a duplicate here and report the original as deleted.
      const existing = await ctx.db
        .query("activities")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", rowFsId))
        .first();
      const decision = decideRow("activity", { ...row, proposalId, wbsId, phaseId }, existing);
      suppressedLinks += decision.suppressed;

      if (!existing) {
        activityTally.insert++;
        if (!dryRun) await ctx.db.insert("activities", asInsert<"activities">(decision.changed));
      } else if (decision.verdict === "patch") {
        activityTally.patch++;
        if (!dryRun) await ctx.db.patch(existing._id, asPatch<"activities">(decision.changed));
      } else {
        activityTally.unchanged++;
      }
    }

    // The cached grand total is invalidated ONLY when this call could have moved
    // it. Doing it unconditionally would queue a full re-rollup of all 736
    // estimates on every pass, each re-reading every one of its activities —
    // the same "write regardless" instinct the diff exists to kill.
    const movedMoney = activityTally.insert + activityTally.patch > 0 || ratesMoved;
    if (proposalId !== null && movedMoney && !dryRun) {
      await invalidateProposalTotal(ctx, proposalId);
    }

    if (wbsMismatches > 0) {
      // Observability for the repair migration: this is how many rows in this
      // proposal carried legacy's corrupted wbsId. They are written correctly
      // now, so the count should fall to 0 on a subsequent re-sync.
      console.warn(
        `[sync] proposal ${proposalId}: corrected ${wbsMismatches} activities whose Firestore wbsId disagreed with their phase's WBS.`
      );
    }

    const byLevel: ByLevelCounts = {
      proposal: proposalTally,
      wbs: wbsTally,
      phase: phaseTally,
      activity: activityTally,
    };
    const totals = sumLevelCounts(proposalTally, wbsTally, phaseTally, activityTally);

    return {
      inserted: totals.insert,
      updated: totals.patch,
      unchanged: totals.unchanged,
      // Always 0: every reason to skip returns early, before any write.
      // Reported anyway so both sync mutations share one result shape.
      skipped: 0,
      skipReason: null,
      suppressedLinks,
      unresolved,
      byLevel,
      resolved:
        proposalId === null
          ? null
          : {
              proposalId,
              wbs: resolvedWbs,
              phases: resolvedPhases,
              // Only a dry run ever has these: a real run inserted the rows and
              // carries their ids above.
              wbsForecast: [...wbsForecast],
              phaseForecast: [...phaseForecast],
            },
    };
  },
});

/**
 * Upsert a batch of proposals only (no children).
 *
 * WHY: powers the 6-hourly proposals-only pass that keeps the New Project list
 * fresh between full passes. Differential for the same reason as the tree
 * upsert — 736 blind patches every six hours is 736 writes to say nothing.
 */
export const upsertProposalsBatch = internalMutation({
  args: { proposals: v.array(v.any()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun === true;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const proposal of args.proposals as SyncRow[]) {
      const firestoreId = String(proposal.firestoreId ?? "");
      const existing = await ctx.db
        .query("proposals")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", firestoreId))
        .first();

      // Skipped per-proposal rather than aborting the batch: one Precision-owned
      // estimate must not stop the other 735 from staying current. This patch
      // is the 6-hourly one that used to revert proposal metadata and all 15
      // rates out from under whoever was editing. See DECISIONS.md D1.
      if (existing?.precisionOwnedAt !== undefined) {
        skipped++;
        continue;
      }

      if (!existing) {
        // Deletion wins over the mirror — see the proposalTombstones schema
        // comment. Without this, the batch resurrects a deliberately deleted
        // estimate as a bare proposal row.
        const tombstone = await ctx.db
          .query("proposalTombstones")
          .withIndex("by_firestore_id", (q) => q.eq("firestoreId", firestoreId))
          .first();
        if (tombstone) {
          skipped++;
          continue;
        }
        inserted++;
        const decision = decideRow("proposal", proposal, null);
        if (!dryRun) await ctx.db.insert("proposals", asInsert<"proposals">(decision.changed));
        continue;
      }

      const decision = decideRow("proposal", proposal, existing);
      if (decision.verdict === "unchanged") {
        unchanged++;
        continue;
      }
      updated++;
      if (!dryRun) await ctx.db.patch(existing._id, asPatch<"proposals">(decision.changed));
    }

    if (skipped > 0) {
      console.log(
        `[sync] proposals batch: skipped ${skipped} Precision-owned or deleted estimate(s)`
      );
    }
    return { inserted, updated, unchanged, skipped };
  },
});

// ============================================================================
// Queries
// ============================================================================

/** Get the latest sync jobs for admin UI. */
export const getLatestSyncJobs = mutation({
  // Using mutation as a query wrapper accessible from public API
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("syncJobs").order("desc").take(10);
  },
});

/**
 * One run, with the proposals it actually changed.
 *
 * The report rows are the interesting half. "736 examined, 3 changed" is only
 * trustworthy if you can read which 3 and what moved inside them — the same
 * reason `getLinkRepair` returns its refusals rather than only its successes.
 */
export const getSyncJobReport = internalQuery({
  args: { jobId: v.id("syncJobs"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const reports = await ctx.db
      .query("syncProposalReports")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .take(args.limit ?? 100);
    return {
      job: {
        status: job.status,
        mode: job.mode ?? "proposals",
        dryRun: job.dryRun === true,
        totalProposals: job.totalProposals,
        processedProposals: job.processedProposals,
        insertedRecords: job.insertedRecords,
        updatedRecords: job.updatedRecords ?? 0,
        unchangedRecords: job.unchangedRecords ?? 0,
        orphanedRecords: job.orphanedRecords ?? 0,
        suppressedLinks: job.suppressedLinks ?? 0,
        skippedProposals: job.skippedProposals ?? 0,
        unresolvedRecords: job.unresolvedRecords ?? 0,
        startedAt: job.startedAt,
        lastProgressAt: job.lastProgressAt ?? null,
        completedAt: job.completedAt ?? null,
        error: job.error ?? null,
      },
      proposals: reports.map((r) => ({
        proposalNumber: r.proposalNumber,
        firestoreId: r.firestoreId,
        skipped: r.skipped ?? null,
        counts: r.counts,
        byLevel: r.byLevel,
        suppressedLinks: r.suppressedLinks,
        unresolved: r.unresolved,
        orphanScanIncomplete: r.orphanScanIncomplete ?? false,
        orphanScanRefused: r.orphanScanRefused ?? false,
        error: r.error ?? null,
      })),
    };
  },
});
