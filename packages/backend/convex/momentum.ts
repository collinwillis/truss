/**
 * Convex functions for the Momentum progress tracking app.
 *
 * Queries compute progress at read time by joining activities (estimates)
 * with progressEntries (actuals). Nothing is pre-aggregated — totals roll up
 * from activity → phase → WBS → project on every query.
 *
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================================
// HELPERS
// ============================================================================

/** Activity types that contribute man-hours. */
const LABOR_TYPES = new Set(["labor", "custom_labor"]);

/**
 * Calculate total estimated man-hours for a single activity.
 *
 * Formula: quantity × (craftConstant + welderConstant)
 */
function activityTotalMH(activity: Doc<"activities">): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return activity.quantity * (activity.labor.craftConstant + activity.labor.welderConstant);
}

/**
 * Calculate earned man-hours for a given completed quantity.
 *
 * Uses the same constants as the estimate so progress is measured
 * in the same unit as the budget.
 */
function activityEarnedMH(activity: Doc<"activities">, completedQty: number): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return completedQty * (activity.labor.craftConstant + activity.labor.welderConstant);
}

/** Derive status string from a percentage. */
function statusFromPercent(pct: number): "not-started" | "in-progress" | "complete" {
  if (pct === 0) return "not-started";
  if (pct >= 100) return "complete";
  return "in-progress";
}

/** Safe percentage calculation. */
function pct(earned: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((earned / total) * 100);
}

// ============================================================================
// QUERIES
// ============================================================================

/** List all momentum projects with computed progress metrics. */
export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("momentumProjects").collect();

    return Promise.all(
      projects.map(async (proj) => {
        const activities = await ctx.db
          .query("activities")
          .withIndex("by_proposal", (q) => q.eq("proposalId", proj.proposalId))
          .collect();

        const laborActivities = activities.filter((a) => LABOR_TYPES.has(a.type));
        const totalMH = laborActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);

        const entries = await ctx.db
          .query("progressEntries")
          .withIndex("by_project_activity", (q) => q.eq("projectId", proj._id))
          .collect();

        // Sum completed qty per activity
        const completedByActivity = new Map<string, number>();
        for (const entry of entries) {
          const key = entry.activityId as string;
          completedByActivity.set(
            key,
            (completedByActivity.get(key) ?? 0) + entry.quantityCompleted
          );
        }

        // Calculate earned MH
        let earnedMH = 0;
        for (const activity of laborActivities) {
          const completed = completedByActivity.get(activity._id as string) ?? 0;
          earnedMH += activityEarnedMH(activity, completed);
        }

        return {
          id: proj._id as string,
          proposalNumber: proj.proposalNumber,
          jobNumber: proj.jobNumber ?? "",
          name: proj.name,
          description: proj.description ?? "",
          owner: proj.ownerName,
          location: proj.location ?? "",
          startDate: proj.actualStartDate
            ? new Date(proj.actualStartDate).toISOString().slice(0, 10)
            : "",
          status: proj.status,
          totalMH,
          earnedMH,
          percentComplete: pct(earnedMH, totalMH),
          lastUpdated: proj.lastEntryDate ?? new Date(proj._creationTime).toISOString(),
        };
      })
    );
  },
});

/** Get WBS items with progress rollups for a project dashboard. */
export const getProjectWBS = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Index activities and entries for fast lookup
    const activitiesByWBS = new Map<string, Doc<"activities">[]>();
    for (const a of activities) {
      if (!LABOR_TYPES.has(a.type)) continue;
      const key = a.wbsId as string;
      const list = activitiesByWBS.get(key) ?? [];
      list.push(a);
      activitiesByWBS.set(key, list);
    }

    const completedByActivity = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.activityId as string;
      completedByActivity.set(key, (completedByActivity.get(key) ?? 0) + entry.quantityCompleted);
    }

    const wbsResults = wbsItems.map((wbs) => {
      const wbsActivities = activitiesByWBS.get(wbs._id as string) ?? [];
      const totalMH = wbsActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);
      let earnedMH = 0;
      for (const a of wbsActivities) {
        const completed = completedByActivity.get(a._id as string) ?? 0;
        earnedMH += activityEarnedMH(a, completed);
      }
      const percentComplete = pct(earnedMH, totalMH);

      return {
        id: wbs._id as string,
        code: String(wbs.wbsPoolId),
        description: wbs.name,
        totalMH,
        earnedMH,
        percentComplete,
        status: statusFromPercent(percentComplete),
      };
    });

    // Also compute project-level totals
    const allLabor = activities.filter((a) => LABOR_TYPES.has(a.type));
    const projectTotalMH = allLabor.reduce((sum, a) => sum + activityTotalMH(a), 0);
    let projectEarnedMH = 0;
    for (const a of allLabor) {
      const completed = completedByActivity.get(a._id as string) ?? 0;
      projectEarnedMH += activityEarnedMH(a, completed);
    }

    return {
      project: {
        id: project._id as string,
        name: project.name,
        proposalNumber: project.proposalNumber,
        jobNumber: project.jobNumber ?? "",
        owner: project.ownerName,
        location: project.location ?? "",
        status: project.status,
        totalMH: projectTotalMH,
        earnedMH: projectEarnedMH,
        percentComplete: pct(projectEarnedMH, projectTotalMH),
      },
      wbsItems: wbsResults,
    };
  },
});

/** Get phases with progress rollups for a WBS drill-down view. */
export const getWBSPhases = query({
  args: {
    projectId: v.id("momentumProjects"),
    wbsId: v.id("wbs"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) return null;

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_wbs", (q) => q.eq("projectId", args.projectId).eq("wbsId", args.wbsId))
      .collect();

    // Index by phase
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const a of activities) {
      if (!LABOR_TYPES.has(a.type)) continue;
      const key = a.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(a);
      activitiesByPhase.set(key, list);
    }

    const completedByActivity = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.activityId as string;
      completedByActivity.set(key, (completedByActivity.get(key) ?? 0) + entry.quantityCompleted);
    }

    // WBS-level totals
    const allLabor = activities.filter((a) => LABOR_TYPES.has(a.type));
    const wbsTotalMH = allLabor.reduce((sum, a) => sum + activityTotalMH(a), 0);
    let wbsEarnedMH = 0;
    for (const a of allLabor) {
      const completed = completedByActivity.get(a._id as string) ?? 0;
      wbsEarnedMH += activityEarnedMH(a, completed);
    }

    const phaseResults = phases.map((phase) => {
      const phaseActivities = activitiesByPhase.get(phase._id as string) ?? [];
      const totalMH = phaseActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);
      let earnedMH = 0;
      for (const a of phaseActivities) {
        const completed = completedByActivity.get(a._id as string) ?? 0;
        earnedMH += activityEarnedMH(a, completed);
      }
      const percentComplete = pct(earnedMH, totalMH);

      return {
        id: phase._id as string,
        wbsId: phase.wbsId as string,
        code: String(phase.phasePoolId),
        description: phase.description,
        totalMH,
        earnedMH,
        percentComplete,
        status: statusFromPercent(percentComplete),
      };
    });

    return {
      project: {
        id: project._id as string,
        name: project.name,
      },
      wbs: {
        id: wbs._id as string,
        code: String(wbs.wbsPoolId),
        description: wbs.name,
        totalMH: wbsTotalMH,
        earnedMH: wbsEarnedMH,
        percentComplete: pct(wbsEarnedMH, wbsTotalMH),
        status: statusFromPercent(pct(wbsEarnedMH, wbsTotalMH)),
      },
      phases: phaseResults,
    };
  },
});

/** Get activities with individual progress for a phase detail view. */
export const getPhaseDetails = query({
  args: {
    projectId: v.id("momentumProjects"),
    phaseId: v.id("phases"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const phase = await ctx.db.get(args.phaseId);
    if (!phase) return null;

    const wbs = await ctx.db.get(phase.wbsId);

    // Only labor activities tracked in Momentum
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_phase", (q) => q.eq("phaseId", args.phaseId))
      .collect();

    const laborActivities = activities.filter((a) => LABOR_TYPES.has(a.type));

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_phase", (q) =>
        q.eq("projectId", args.projectId).eq("phaseId", args.phaseId)
      )
      .collect();

    const completedByActivity = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.activityId as string;
      completedByActivity.set(key, (completedByActivity.get(key) ?? 0) + entry.quantityCompleted);
    }

    // Phase-level totals
    const phaseTotalMH = laborActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);
    let phaseEarnedMH = 0;
    for (const a of laborActivities) {
      const completed = completedByActivity.get(a._id as string) ?? 0;
      phaseEarnedMH += activityEarnedMH(a, completed);
    }

    const details = laborActivities.map((a) => {
      const completedQty = completedByActivity.get(a._id as string) ?? 0;
      const totalMH = activityTotalMH(a);
      const earnedMH = activityEarnedMH(a, completedQty);
      const percentComplete = pct(earnedMH, totalMH);

      return {
        id: a._id as string,
        wbsId: a.wbsId as string,
        phaseId: a.phaseId as string,
        description: a.description,
        quantity: a.quantity,
        unit: a.unit,
        quantityComplete: completedQty,
        quantityRemaining: Math.max(0, a.quantity - completedQty),
        totalMH,
        earnedMH,
        percentComplete,
      };
    });

    return {
      project: { id: project._id as string, name: project.name },
      wbs: wbs
        ? { id: wbs._id as string, code: String(wbs.wbsPoolId), description: wbs.name }
        : null,
      phase: {
        id: phase._id as string,
        wbsId: phase.wbsId as string,
        code: String(phase.phasePoolId),
        description: phase.description,
        totalMH: phaseTotalMH,
        earnedMH: phaseEarnedMH,
        percentComplete: pct(phaseEarnedMH, phaseTotalMH),
        status: statusFromPercent(pct(phaseEarnedMH, phaseTotalMH)),
      },
      details,
    };
  },
});

/** Get hierarchical entry form data for a project on a given date. */
export const getEntryFormData = query({
  args: {
    projectId: v.id("momentumProjects"),
    entryDate: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    // Fetch all estimate data for the proposal
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const allPhases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const allActivities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const laborActivities = allActivities.filter((a) => LABOR_TYPES.has(a.type));

    // All entries for this project (for cumulative totals)
    const allEntries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Total completed per activity (all dates)
    const totalCompletedByActivity = new Map<string, number>();
    // Today's entries per activity
    const todaysEntryByActivity = new Map<string, number>();

    for (const entry of allEntries) {
      const key = entry.activityId as string;
      totalCompletedByActivity.set(
        key,
        (totalCompletedByActivity.get(key) ?? 0) + entry.quantityCompleted
      );
      if (entry.entryDate === args.entryDate) {
        todaysEntryByActivity.set(key, entry.quantityCompleted);
      }
    }

    // Build WBS items for tree (status is mutable — updated below after phase rollup)
    const wbsResult = wbsItems.map((wbs) => ({
      id: wbs._id as string,
      code: String(wbs.wbsPoolId),
      description: wbs.name,
      totalMH: 0,
      earnedMH: 0,
      percentComplete: 0,
      status: "not-started" as "not-started" | "in-progress" | "complete",
    }));

    // Build phases grouped by WBS
    const phasesByWBS: Record<
      string,
      Array<{
        id: string;
        wbsId: string;
        code: string;
        description: string;
        totalMH: number;
        earnedMH: number;
        percentComplete: number;
        status: "not-started" | "in-progress" | "complete";
      }>
    > = {};

    for (const phase of allPhases) {
      const wbsKey = phase.wbsId as string;
      if (!phasesByWBS[wbsKey]) phasesByWBS[wbsKey] = [];

      // Phase-level totals
      const phaseActivities = laborActivities.filter(
        (a) => (a.phaseId as string) === (phase._id as string)
      );
      const totalMH = phaseActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);
      let earnedMH = 0;
      for (const a of phaseActivities) {
        const completed = totalCompletedByActivity.get(a._id as string) ?? 0;
        earnedMH += activityEarnedMH(a, completed);
      }

      phasesByWBS[wbsKey].push({
        id: phase._id as string,
        wbsId: wbsKey,
        code: String(phase.phasePoolId),
        description: phase.description,
        totalMH,
        earnedMH,
        percentComplete: pct(earnedMH, totalMH),
        status: statusFromPercent(pct(earnedMH, totalMH)),
      });
    }

    // Build details grouped by phase
    const detailsByPhase: Record<
      string,
      Array<{
        id: string;
        wbsId: string;
        phaseId: string;
        description: string;
        quantity: number;
        unit: string;
        quantityComplete: number;
        quantityRemaining: number;
        totalMH: number;
        earnedMH: number;
        percentComplete: number;
      }>
    > = {};

    // Metrics and today's entries for the form
    const metricsById: Record<
      string,
      {
        previousTotal: number;
        todaysEntry: number;
        newTotal: number;
        remaining: number;
        percentComplete: number;
      }
    > = {};

    const todaysEntries: Record<string, number> = {};

    for (const activity of laborActivities) {
      const phaseKey = activity.phaseId as string;
      if (!detailsByPhase[phaseKey]) detailsByPhase[phaseKey] = [];

      const totalCompleted = totalCompletedByActivity.get(activity._id as string) ?? 0;
      const todayQty = todaysEntryByActivity.get(activity._id as string) ?? 0;
      const previousTotal = totalCompleted - todayQty;
      const totalMH = activityTotalMH(activity);
      const earnedMH = activityEarnedMH(activity, totalCompleted);

      detailsByPhase[phaseKey].push({
        id: activity._id as string,
        wbsId: activity.wbsId as string,
        phaseId: phaseKey,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        quantityComplete: totalCompleted,
        quantityRemaining: Math.max(0, activity.quantity - totalCompleted),
        totalMH,
        earnedMH,
        percentComplete: pct(earnedMH, totalMH),
      });

      metricsById[activity._id as string] = {
        previousTotal,
        todaysEntry: todayQty,
        newTotal: totalCompleted,
        remaining: Math.max(0, activity.quantity - totalCompleted),
        percentComplete: pct(earnedMH, totalMH),
      };

      if (todayQty > 0) {
        todaysEntries[activity._id as string] = todayQty;
      }
    }

    // Compute WBS-level totals
    for (const wbs of wbsResult) {
      const phases = phasesByWBS[wbs.id] ?? [];
      wbs.totalMH = phases.reduce((sum, p) => sum + p.totalMH, 0);
      wbs.earnedMH = phases.reduce((sum, p) => sum + p.earnedMH, 0);
      wbs.percentComplete = pct(wbs.earnedMH, wbs.totalMH);
      wbs.status = statusFromPercent(wbs.percentComplete);
    }

    return {
      wbsItems: wbsResult,
      phasesByWBS,
      detailsByPhase,
      metricsById,
      todaysEntries,
    };
  },
});

/** List proposals not yet linked to a momentum project. */
export const listProposalsForImport = query({
  args: {},
  handler: async (ctx) => {
    const proposals = await ctx.db.query("proposals").collect();
    const momentumProjects = await ctx.db.query("momentumProjects").collect();

    const linkedProposalIds = new Set(momentumProjects.map((p) => p.proposalId as string));

    return proposals
      .filter((p) => !linkedProposalIds.has(p._id as string))
      .map((p) => ({
        id: p._id as string,
        proposalNumber: p.proposalNumber,
        description: p.description,
        ownerName: p.ownerName,
        jobNumber: p.jobNumber ?? "",
        location: p.jobSiteAddress ?? "",
        status: p.status ?? "open",
      }));
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/** Create a momentum project from a proposal (with duplicate check). */
export const createProject = mutation({
  args: {
    proposalId: v.id("proposals"),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("on-hold"),
        v.literal("completed"),
        v.literal("archived")
      )
    ),
  },
  handler: async (ctx, args) => {
    // Check for duplicate
    const existing = await ctx.db
      .query("momentumProjects")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .first();

    if (existing) {
      throw new Error("A momentum project already exists for this proposal.");
    }

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) {
      throw new Error("Proposal not found.");
    }

    const projectId = await ctx.db.insert("momentumProjects", {
      proposalId: args.proposalId,
      name: `${proposal.proposalNumber} - ${proposal.description}`,
      proposalNumber: proposal.proposalNumber,
      jobNumber: proposal.jobNumber ?? undefined,
      ownerName: proposal.ownerName,
      location: proposal.jobSiteAddress ?? undefined,
      description: proposal.description,
      status: args.status ?? "active",
      actualStartDate: proposal.projectStartDate ?? undefined,
      projectedEndDate: proposal.projectEndDate ?? undefined,
    });

    return projectId;
  },
});

/** Batch upsert daily progress entries (one per activity+date). */
export const saveProgressEntries = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    entryDate: v.string(),
    entries: v.array(
      v.object({
        activityId: v.id("activities"),
        quantityCompleted: v.number(),
        notes: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    for (const entry of args.entries) {
      // Look up activity to get denormalized parent refs
      const activity = await ctx.db.get(entry.activityId);
      if (!activity) continue;

      // Upsert: find existing entry for this activity+date
      const existing = await ctx.db
        .query("progressEntries")
        .withIndex("by_project_activity_date", (q) =>
          q
            .eq("projectId", args.projectId)
            .eq("activityId", entry.activityId)
            .eq("entryDate", args.entryDate)
        )
        .first();

      if (existing) {
        if (entry.quantityCompleted === 0) {
          // Delete the entry if quantity is zero
          await ctx.db.delete(existing._id);
        } else {
          await ctx.db.patch(existing._id, {
            quantityCompleted: entry.quantityCompleted,
            notes: entry.notes,
          });
        }
      } else if (entry.quantityCompleted > 0) {
        await ctx.db.insert("progressEntries", {
          projectId: args.projectId,
          activityId: entry.activityId,
          wbsId: activity.wbsId,
          phaseId: activity.phaseId,
          entryDate: args.entryDate,
          quantityCompleted: entry.quantityCompleted,
          notes: entry.notes,
        });
      }
    }

    // Update lastEntryDate on the project
    await ctx.db.patch(args.projectId, { lastEntryDate: args.entryDate });
  },
});

/** Delete a single progress entry. */
export const deleteProgressEntry = mutation({
  args: { entryId: v.id("progressEntries") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) throw new Error("Entry not found.");
    await ctx.db.delete(args.entryId);
  },
});
