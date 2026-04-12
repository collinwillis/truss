/**
 * Data migration functions for re-migrating Firestore activity data.
 *
 * WHY: The original Firestore → Convex migration dropped critical fields
 * (equipment prices, subcontractor costs, rate overrides). These functions
 * enable a corrected re-migration that patches existing documents in-place,
 * preserving Convex IDs to avoid breaking Momentum references.
 *
 * @module
 */

import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// ============================================================================
// ACTIVITY PATCHING
// ============================================================================

/**
 * Patch a batch of activities with corrected field mappings from Firestore.
 *
 * WHY secret auth: This is called from an external local script (not the
 * Convex client). The secret prevents unauthorized writes. Remove the
 * MIGRATION_SECRET env var after migration is complete.
 */
export const patchActivityBatch = mutation({
  args: {
    secret: v.string(),
    patches: v.array(
      v.object({
        firestoreId: v.string(),
        unitPrice: v.optional(v.number()),
        labor: v.optional(
          v.object({
            craftConstant: v.number(),
            welderConstant: v.number(),
            customCraftRate: v.optional(v.number()),
            customSubsistenceRate: v.optional(v.number()),
          })
        ),
        equipment: v.optional(
          v.object({
            ownership: v.union(v.literal("rental"), v.literal("owned"), v.literal("purchase")),
            time: v.number(),
          })
        ),
        subcontractor: v.optional(
          v.object({
            laborCost: v.number(),
            materialCost: v.number(),
            equipmentCost: v.number(),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Verify migration secret
    const expected = process.env.MIGRATION_SECRET;
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized: invalid migration secret");
    }

    let patched = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const patch of args.patches) {
      try {
        // Look up activity by Firestore ID
        const activity = await ctx.db
          .query("activities")
          .withIndex("by_firestore_id", (q) => q.eq("firestoreId", patch.firestoreId))
          .first();

        if (!activity) {
          skipped++;
          continue;
        }

        // Build the patch object — only include fields that have values
        const patchData: Record<string, unknown> = {};

        if (patch.unitPrice !== undefined) {
          patchData.unitPrice = patch.unitPrice;
        }

        if (patch.labor !== undefined) {
          patchData.labor = patch.labor;
        }

        if (patch.equipment !== undefined) {
          patchData.equipment = patch.equipment;
        }

        if (patch.subcontractor !== undefined) {
          patchData.subcontractor = patch.subcontractor;
        }

        if (Object.keys(patchData).length > 0) {
          await ctx.db.patch(activity._id, patchData);
          patched++;
        } else {
          skipped++;
        }
      } catch (error) {
        errors.push(`${patch.firestoreId}: ${error}`);
      }
    }

    return { patched, skipped, errors };
  },
});

// ============================================================================
// JOB MANAGEMENT
// ============================================================================

/** Create a new migration job for tracking progress. */
export const createMigrationJob = mutation({
  args: {
    secret: v.string(),
    type: v.string(),
    totalProposals: v.number(),
    totalActivities: v.number(),
  },
  handler: async (ctx, args) => {
    const expected = process.env.MIGRATION_SECRET;
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }

    // Check for existing running job
    const running = await ctx.db
      .query("migrationJobs")
      .withIndex("by_type_status", (q) => q.eq("type", args.type).eq("status", "running"))
      .first();

    if (running) {
      throw new Error("A migration job is already running");
    }

    return ctx.db.insert("migrationJobs", {
      type: args.type,
      status: "running",
      totalProposals: args.totalProposals,
      completedProposals: 0,
      totalActivities: args.totalActivities,
      patchedActivities: 0,
      skippedActivities: 0,
      errors: [],
      startedAt: Date.now(),
    });
  },
});

/** Update migration job progress. */
export const updateJobProgress = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("migrationJobs"),
    completedProposals: v.number(),
    patchedActivities: v.number(),
    skippedActivities: v.number(),
    lastProposalProcessed: v.optional(v.string()),
    newErrors: v.optional(
      v.array(
        v.object({
          firestoreId: v.string(),
          error: v.string(),
          timestamp: v.number(),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    const expected = process.env.MIGRATION_SECRET;
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }

    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");

    const existingErrors = job.errors ?? [];
    const allErrors = args.newErrors ? [...existingErrors, ...args.newErrors] : existingErrors;

    await ctx.db.patch(args.jobId, {
      completedProposals: args.completedProposals,
      patchedActivities: args.patchedActivities,
      skippedActivities: args.skippedActivities,
      lastProposalProcessed: args.lastProposalProcessed,
      errors: allErrors.slice(-100), // Keep last 100 errors
    });
  },
});

/** Mark migration job as completed or failed. */
export const completeMigrationJob = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("migrationJobs"),
    status: v.union(v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    const expected = process.env.MIGRATION_SECRET;
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.jobId, {
      status: args.status,
      completedAt: Date.now(),
    });
  },
});

// ============================================================================
// QUERIES (Admin UI)
// ============================================================================

/** Get the most recent migration job for the admin dashboard. */
export const getMigrationStatus = query({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db.query("migrationJobs").order("desc").take(5);
    return jobs;
  },
});

/** Get activities with missing data for diagnostics. */
export const getActivitiesWithMissingData = query({
  args: { proposalId: v.optional(v.id("proposals")) },
  handler: async (ctx, args) => {
    const activities = args.proposalId
      ? await ctx.db
          .query("activities")
          .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId!))
          .collect()
      : await ctx.db.query("activities").take(1000);

    const issues: Array<{
      _id: string;
      firestoreId?: string;
      type: string;
      description: string;
      issue: string;
    }> = [];

    for (const a of activities) {
      // Equipment with no price
      if (a.type === "equipment" && (!a.unitPrice || a.unitPrice === 0)) {
        issues.push({
          _id: a._id,
          firestoreId: a.firestoreId,
          type: a.type,
          description: a.description,
          issue: "Missing unitPrice",
        });
      }

      // Subcontractor with all-zero costs
      if (
        a.type === "subcontractor" &&
        (!a.subcontractor ||
          (a.subcontractor.laborCost === 0 &&
            a.subcontractor.materialCost === 0 &&
            a.subcontractor.equipmentCost === 0))
      ) {
        issues.push({
          _id: a._id,
          firestoreId: a.firestoreId,
          type: a.type,
          description: a.description,
          issue: "All subcontractor costs are zero",
        });
      }

      // Labor/custom_labor with zero constants but non-zero quantity
      if (
        (a.type === "labor" || a.type === "custom_labor") &&
        a.quantity > 0 &&
        (!a.labor || (a.labor.craftConstant === 0 && a.labor.welderConstant === 0))
      ) {
        issues.push({
          _id: a._id,
          firestoreId: a.firestoreId,
          type: a.type,
          description: a.description,
          issue: "Zero craft+welder constants with non-zero quantity",
        });
      }
    }

    return { total: activities.length, issueCount: issues.length, issues: issues.slice(0, 50) };
  },
});

// ============================================================================
// INSERT MISSING ACTIVITIES
// ============================================================================

/**
 * Resolve Firestore parent IDs to Convex IDs.
 *
 * WHY: Missing activities need their proposal/WBS/phase Convex IDs.
 * This query maps Firestore IDs → Convex IDs using the by_firestore_id indexes.
 */
export const resolveParentIds = query({
  args: {
    proposalFirestoreId: v.string(),
    wbsFirestoreId: v.string(),
    phaseFirestoreId: v.string(),
  },
  handler: async (ctx, args) => {
    const proposal = await ctx.db
      .query("proposals")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.proposalFirestoreId))
      .first();

    const wbs = await ctx.db
      .query("wbs")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.wbsFirestoreId))
      .first();

    const phase = await ctx.db
      .query("phases")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.phaseFirestoreId))
      .first();

    return {
      proposalId: proposal?._id ?? null,
      wbsId: wbs?._id ?? null,
      phaseId: phase?._id ?? null,
    };
  },
});

/**
 * Check if an activity with a given firestoreId already exists.
 */
export const activityExistsByFirestoreId = query({
  args: { firestoreId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("activities")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.firestoreId))
      .first();
    return !!existing;
  },
});

/**
 * Get activity count and a sample of firestoreIds for a proposal.
 *
 * WHY: Fast count comparison. If counts match, no detailed check needed.
 */
export const getActivityCountForProposal = query({
  args: { proposalFirestoreId: v.string() },
  handler: async (ctx, args) => {
    const proposal = await ctx.db
      .query("proposals")
      .withIndex("by_firestore_id", (q) => q.eq("firestoreId", args.proposalFirestoreId))
      .first();

    if (!proposal) return { proposalId: null, count: 0 };

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
      .collect();

    return {
      proposalId: proposal._id as string,
      count: activities.length,
    };
  },
});

/**
 * Check which Firestore IDs exist in Convex (batch).
 *
 * WHY: For proposals with count mismatches, check a batch of IDs
 * to find which ones are missing. Returns the missing IDs.
 */
export const findMissingFirestoreIds = query({
  args: { firestoreIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const missing: string[] = [];
    for (const fsId of args.firestoreIds) {
      const exists = await ctx.db
        .query("activities")
        .withIndex("by_firestore_id", (q) => q.eq("firestoreId", fsId))
        .first();
      if (!exists) missing.push(fsId);
    }
    return missing;
  },
});

/**
 * Insert a batch of missing activities into Convex.
 *
 * WHY: The original migration skipped ~17,833 activities. This mutation
 * inserts them with proper Convex parent IDs and corrected field mappings.
 */
export const insertMissingActivityBatch = mutation({
  args: {
    secret: v.string(),
    activities: v.array(
      v.object({
        firestoreId: v.string(),
        proposalId: v.id("proposals"),
        wbsId: v.id("wbs"),
        phaseId: v.id("phases"),
        type: v.union(
          v.literal("labor"),
          v.literal("material"),
          v.literal("equipment"),
          v.literal("subcontractor"),
          v.literal("cost_only"),
          v.literal("custom_labor")
        ),
        description: v.string(),
        quantity: v.number(),
        unit: v.string(),
        sortOrder: v.number(),
        laborPoolId: v.optional(v.number()),
        equipmentPoolId: v.optional(v.number()),
        labor: v.optional(
          v.object({
            craftConstant: v.number(),
            welderConstant: v.number(),
            customCraftRate: v.optional(v.number()),
            customSubsistenceRate: v.optional(v.number()),
          })
        ),
        equipment: v.optional(
          v.object({
            ownership: v.union(v.literal("rental"), v.literal("owned"), v.literal("purchase")),
            time: v.number(),
          })
        ),
        subcontractor: v.optional(
          v.object({
            laborCost: v.number(),
            materialCost: v.number(),
            equipmentCost: v.number(),
          })
        ),
        unitPrice: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const expected = process.env.MIGRATION_SECRET;
    if (!expected || args.secret !== expected) {
      throw new Error("Unauthorized");
    }

    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const activity of args.activities) {
      try {
        // Dedup check
        const existing = await ctx.db
          .query("activities")
          .withIndex("by_firestore_id", (q) => q.eq("firestoreId", activity.firestoreId))
          .first();

        if (existing) {
          skipped++;
          continue;
        }

        await ctx.db.insert("activities", activity);
        inserted++;
      } catch (error) {
        errors.push(`${activity.firestoreId}: ${error}`);
      }
    }

    return { inserted, skipped, errors };
  },
});
