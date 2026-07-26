/**
 * Sync mutations for upserting Firestore data into Convex.
 *
 * WHY: Actions fetch from Firestore but can't write to the DB directly.
 * These internalMutations handle the actual database writes with
 * firestoreId-based deduplication at every level of the hierarchy.
 *
 * @module
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// ============================================================================
// Job Management
// ============================================================================

/**
 * Reclaim window for a hung sync job. An action that is hard-killed (timeout,
 * eviction) dies before its `catch` can mark the job failed, leaving it stuck
 * in "running" forever. Without reclaim, that one zombie wedges every future
 * run via the concurrency guard — which is exactly how the daily proposals sync
 * silently froze for two weeks. A proposals-only sync finishes in seconds, and
 * the full-tree migration is run supervised and off-cron, so 30 minutes clears
 * a genuine hang without ever reclaiming a healthy run.
 */
const STALE_SYNC_JOB_MS = 30 * 60 * 1000;

/**
 * Create a new sync job. Refuses to start while another run is genuinely active,
 * but reclaims a stale (hung) "running" job first so a single dead run can never
 * block the pipeline indefinitely.
 */
export const createSyncJob = internalMutation({
  args: { totalProposals: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const running = await ctx.db
      .query("syncJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    for (const job of running) {
      if (now - (job.startedAt ?? job._creationTime) < STALE_SYNC_JOB_MS) {
        throw new Error("Sync job already running");
      }
      // Past the window with no completion — the run hung. Reclaim it.
      await ctx.db.patch(job._id, { status: "failed", completedAt: now });
    }

    return ctx.db.insert("syncJobs", {
      status: "running",
      totalProposals: args.totalProposals,
      processedProposals: 0,
      insertedRecords: 0,
      updatedRecords: 0,
      errors: [],
      startedAt: now,
    });
  },
});

/** Update sync job progress. */
export const updateSyncProgress = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    processedProposals: v.number(),
    insertedRecords: v.number(),
    updatedRecords: v.number(),
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
      lastProposalPageToken: args.lastProposalPageToken,
      errors,
    });
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
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status, completedAt: Date.now() };
    if (args.processedProposals !== undefined) patch.processedProposals = args.processedProposals;
    if (args.insertedRecords !== undefined) patch.insertedRecords = args.insertedRecords;
    if (args.updatedRecords !== undefined) patch.updatedRecords = args.updatedRecords;
    await ctx.db.patch(args.jobId, patch);
  },
});

// ============================================================================
// Hierarchy Upsert
// ============================================================================

/**
 * Upsert a proposal and its full hierarchy (WBS → phases → activities).
 *
 * WHY: Each Firestore proposal may have new children (phases, activities)
 * that weren't in the original migration. This mutation inserts missing
 * records at every level while building the ID map needed for child inserts.
 *
 * Returns insert/skip counts.
 */
export const upsertProposalHierarchy = internalMutation({
  args: {
    proposal: v.any(),
    wbsList: v.array(v.any()),
    phasesList: v.array(v.any()),
    activitiesList: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    // 1. Upsert proposal
    const existingProposal = await ctx.db
      .query("proposals")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.proposal.firestoreId))
      .first();

    // Precision has taken ownership of this estimate, so the mirror stops here.
    // Continuing would revert the whole tree — metadata, all 15 rates, and every
    // WBS/phase/activity — to the estimator's version, silently destroying the
    // user's work. Returning before any write in THIS call keeps the mutation
    // itself all-or-nothing. See DECISIONS.md D1.
    //
    // NOT a whole-tree guarantee, and it cannot be one from here: for a large
    // estimate `fetchAndUpsertProposalTree` invokes this mutation once per chunk
    // (syncEngine.ts, PHASE_CHUNK / ACTIVITY_CHUNK). A Precision write landing
    // between chunks leaves the earlier chunks already reverted while later ones
    // return early. Narrow — it needs an edit during an active on-demand import
    // of a large estimate — but real. Closing it properly means checking
    // ownership once in the action before the first chunk, not only per chunk.
    if (existingProposal?.precisionOwnedAt !== undefined) {
      console.log(
        `[sync] skipping ${existingProposal.proposalNumber}: owned by Precision since ${new Date(existingProposal.precisionOwnedAt).toISOString()}`
      );
      return { inserted: 0, updated: 0, skipped: 1 };
    }

    let proposalId: Id<"proposals">;
    const { fsProposalId: _pFsId, _fsId: _pId, ...proposalData } = args.proposal;
    if (existingProposal) {
      proposalId = existingProposal._id;
      await ctx.db.patch(proposalId, proposalData);
      updated++;
    } else {
      proposalId = await ctx.db.insert("proposals", proposalData);
      inserted++;
    }

    // 2. Upsert WBS — build firestoreId → convexId map
    const wbsMap = new Map<string, Id<"wbs">>();

    if (args.wbsList.length > 0) {
      for (const wbs of args.wbsList) {
        const existing = await ctx.db
          .query("wbs")
          .withIndex("by_firestore_id", (q) => q.eq("firestoreId", wbs.firestoreId))
          .first();

        const { fsProposalId: _fsProposalId, _fsId, ...wbsData } = wbs;
        if (existing) {
          await ctx.db.patch(existing._id, { ...wbsData, proposalId });
          wbsMap.set(wbs.firestoreId, existing._id);
          updated++;
        } else {
          const id = await ctx.db.insert("wbs", { ...wbsData, proposalId });
          wbsMap.set(wbs.firestoreId, id);
          inserted++;
        }
      }
    } else if (args.phasesList.length > 0 || args.activitiesList.length > 0) {
      // WBS list empty but phases/activities need resolving — load existing WBS from DB
      const existingWbs = await ctx.db
        .query("wbs")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .collect();
      for (const wbs of existingWbs) {
        if (wbs.firestoreId) wbsMap.set(wbs.firestoreId, wbs._id);
      }
    }

    // 3. Upsert phases — resolve wbsId from map
    const phaseMap = new Map<string, Id<"phases">>();
    // Firestore phase id -> the WBS that phase belongs to. An activity's own
    // wbsId is NOT trustworthy (see the note at the activity loop below), so
    // this is the authority for denormalizing wbsId onto activities.
    const phaseWbsMap = new Map<string, Id<"wbs">>();
    for (const phase of args.phasesList) {
      const existing = await ctx.db
        .query("phases")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", phase.firestoreId))
        .first();

      const wbsId = wbsMap.get(phase.fsWbsId);
      if (!wbsId) {
        continue;
      }

      const { fsProposalId: _fsProposalId, fsWbsId: _fsWbsId, _fsId, ...phaseData } = phase;
      phaseWbsMap.set(phase.firestoreId, wbsId);
      if (existing) {
        await ctx.db.patch(existing._id, { ...phaseData, proposalId, wbsId });
        phaseMap.set(phase.firestoreId, existing._id);
        updated++;
      } else {
        const id = await ctx.db.insert("phases", { ...phaseData, proposalId, wbsId });
        phaseMap.set(phase.firestoreId, id);
        inserted++;
      }
    }

    // 4. Upsert activities — resolve wbsId + phaseId from maps
    // If phaseMap is empty but activities need resolving, load existing phases from DB
    if (phaseMap.size === 0 && args.activitiesList.length > 0) {
      const existingPhases = await ctx.db
        .query("phases")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
        .collect();
      for (const phase of existingPhases) {
        if (phase.firestoreId) {
          phaseMap.set(phase.firestoreId, phase._id);
          phaseWbsMap.set(phase.firestoreId, phase.wbsId);
        }
      }
    }

    // Counts activities whose Firestore wbsId disagrees with their phase's WBS.
    // Legacy's copy-activities-between-phases wrote only phaseId and carried
    // wbsId over from the SOURCE activity, so any activity copied into a phase
    // under a different WBS permanently claims the wrong one. Importing that
    // verbatim is worse in Precision than it was in legacy, because the rollups
    // group by different keys: the WBS table and the direct/indirect split group
    // by activity.wbsId, while the phase drill-down and the Excel export group
    // by phase. Four surfaces, three answers, no error raised.
    let wbsMismatches = 0;

    for (const activity of args.activitiesList) {
      const existing = await ctx.db
        .query("activities")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", activity.firestoreId))
        .first();

      const phaseId = phaseMap.get(activity.fsPhaseId);
      // The phase owns the WBS relationship — derive from it, never from the
      // activity's own wbsId.
      const wbsId = phaseWbsMap.get(activity.fsPhaseId);
      if (!wbsId || !phaseId) {
        continue;
      }

      if (wbsMap.get(activity.fsWbsId) !== wbsId) {
        wbsMismatches++;
      }

      const {
        fsProposalId: _fsProposalId,
        fsWbsId: _fsWbsId,
        fsPhaseId: _fsPhaseId,
        _fsId,
        ...activityData
      } = activity;
      if (existing) {
        await ctx.db.patch(existing._id, { ...activityData, proposalId, wbsId, phaseId });
        updated++;
      } else {
        await ctx.db.insert("activities", { ...activityData, proposalId, wbsId, phaseId });
        inserted++;
      }
    }

    if (wbsMismatches > 0) {
      // Observability for the repair migration: this is how many rows in this
      // proposal carried legacy's corrupted wbsId. They are written correctly
      // now, so the count should fall to 0 on a subsequent re-sync.
      console.warn(
        `[sync] proposal ${proposalId}: corrected ${wbsMismatches} activities whose Firestore wbsId disagreed with their phase's WBS.`
      );
    }

    // `skipped` is always 0 here: the Precision-ownership check returns early
    // above, before any write. Reported anyway so both sync mutations share one
    // result shape and a caller can sum them without a conditional.
    return { inserted, updated, skipped: 0 };
  },
});

/**
 * Upsert a batch of proposals only (no children).
 *
 * WHY: Powers the lightweight daily proposals-only sync that keeps the New
 * Project list fresh without reading every proposal's full wbs/phase/activity
 * tree. Each tree is pulled on demand when a project is actually created.
 */
export const upsertProposalsBatch = internalMutation({
  args: { proposals: v.array(v.any()) },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const proposal of args.proposals) {
      const existing = await ctx.db
        .query("proposals")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", proposal.firestoreId))
        .first();

      // Skipped per-proposal rather than aborting the batch: one Precision-owned
      // estimate must not stop the other ~622 from staying current. This patch
      // is the 6-hourly one that used to revert proposal metadata and all 15
      // rates out from under whoever was editing. See DECISIONS.md D1.
      if (existing?.precisionOwnedAt !== undefined) {
        skipped++;
        continue;
      }

      if (existing) {
        await ctx.db.patch(existing._id, proposal);
        updated++;
      } else {
        await ctx.db.insert("proposals", proposal);
        inserted++;
      }
    }
    if (skipped > 0) {
      console.log(`[sync] proposals batch: skipped ${skipped} Precision-owned estimate(s)`);
    }
    return { inserted, updated, skipped };
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
