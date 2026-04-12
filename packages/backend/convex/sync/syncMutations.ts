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

/** Create a new sync job. Prevents concurrent jobs. */
export const createSyncJob = internalMutation({
  args: { totalProposals: v.number() },
  handler: async (ctx, args) => {
    const running = await ctx.db
      .query("syncJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .first();
    if (running) throw new Error("Sync job already running");

    return ctx.db.insert("syncJobs", {
      status: "running",
      totalProposals: args.totalProposals,
      processedProposals: 0,
      insertedRecords: 0,
      updatedRecords: 0,
      errors: [],
      startedAt: Date.now(),
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

        const { fsProposalId, _fsId, ...wbsData } = wbs;
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
    for (const phase of args.phasesList) {
      const existing = await ctx.db
        .query("phases")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", phase.firestoreId))
        .first();

      const wbsId = wbsMap.get(phase.fsWbsId);
      if (!wbsId) {
        continue;
      }

      const { fsProposalId, fsWbsId, _fsId, ...phaseData } = phase;
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
        if (phase.firestoreId) phaseMap.set(phase.firestoreId, phase._id);
      }
    }

    for (const activity of args.activitiesList) {
      const existing = await ctx.db
        .query("activities")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", activity.firestoreId))
        .first();

      const wbsId = wbsMap.get(activity.fsWbsId);
      const phaseId = phaseMap.get(activity.fsPhaseId);
      if (!wbsId || !phaseId) {
        continue;
      }

      const { fsProposalId, fsWbsId, fsPhaseId, _fsId, ...activityData } = activity;
      if (existing) {
        await ctx.db.patch(existing._id, { ...activityData, proposalId, wbsId, phaseId });
        updated++;
      } else {
        await ctx.db.insert("activities", { ...activityData, proposalId, wbsId, phaseId });
        inserted++;
      }
    }

    return { inserted, updated };
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
