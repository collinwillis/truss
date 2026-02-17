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

/** Calculate craft man-hours for a single activity. */
function activityCraftMH(activity: Doc<"activities">): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return activity.quantity * activity.labor.craftConstant;
}

/** Calculate weld man-hours for a single activity. */
function activityWeldMH(activity: Doc<"activities">): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return activity.quantity * activity.labor.welderConstant;
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

/**
 * Build a completed-quantity-per-activity map from progress entries.
 *
 * Reused across multiple queries to avoid duplication.
 */
function buildCompletedMap(entries: Doc<"progressEntries">[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.activityId as string;
    map.set(key, (map.get(key) ?? 0) + entry.quantityCompleted);
  }
  return map;
}

/**
 * Get the ISO week-ending Saturday date string for a given date string.
 *
 * ISO weeks run Mon–Sun; we use Saturday as the week-ending date
 * to match construction industry convention.
 */
function getWeekEndingSaturday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  const diff = day === 0 ? -1 : 6 - day; // Sun → previous Sat, else forward to Sat
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// QUERIES
// ============================================================================

/** Get existing progress entries for a specific project and date. */
export const getEntriesForDate = query({
  args: {
    projectId: v.id("momentumProjects"),
    entryDate: v.string(),
  },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity_date", (q) => q.eq("projectId", args.projectId))
      .filter((q) => q.eq(q.field("entryDate"), args.entryDate))
      .collect();

    const result: Record<string, number> = {};
    for (const entry of entries) {
      result[entry.activityId as string] = entry.quantityCompleted;
    }
    return result;
  },
});

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

        const completedByActivity = buildCompletedMap(entries);

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

    // Index activities by WBS for fast lookup
    const activitiesByWBS = new Map<string, Doc<"activities">[]>();
    for (const a of activities) {
      if (!LABOR_TYPES.has(a.type)) continue;
      const key = a.wbsId as string;
      const list = activitiesByWBS.get(key) ?? [];
      list.push(a);
      activitiesByWBS.set(key, list);
    }

    const completedByActivity = buildCompletedMap(entries);

    const wbsResults = wbsItems.map((wbs) => {
      const wbsActivities = activitiesByWBS.get(wbs._id as string) ?? [];
      const totalMH = wbsActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);
      const craftMH = wbsActivities.reduce((sum, a) => sum + activityCraftMH(a), 0);
      const weldMH = wbsActivities.reduce((sum, a) => sum + activityWeldMH(a), 0);
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
        craftMH,
        weldMH,
        earnedMH,
        percentComplete,
        status: statusFromPercent(percentComplete),
      };
    });

    // Project-level totals
    const allLabor = activities.filter((a) => LABOR_TYPES.has(a.type));
    const projectTotalMH = allLabor.reduce((sum, a) => sum + activityTotalMH(a), 0);
    const projectCraftMH = allLabor.reduce((sum, a) => sum + activityCraftMH(a), 0);
    const projectWeldMH = allLabor.reduce((sum, a) => sum + activityWeldMH(a), 0);
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
        craftMH: projectCraftMH,
        weldMH: projectWeldMH,
        earnedMH: projectEarnedMH,
        percentComplete: pct(projectEarnedMH, projectTotalMH),
      },
      wbsItems: wbsResults,
    };
  },
});

/**
 * Workbook-style flat table data for all labor activities in a project.
 *
 * Returns every activity row with parent WBS/Phase context embedded,
 * plus rollup summaries. Powers the main workbook/tabular view.
 */
export const getBrowseData = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

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

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    const completedByActivity = buildCompletedMap(entries);

    // Index lookups
    const wbsById = new Map(wbsItems.map((w) => [w._id as string, w]));
    const phaseById = new Map(allPhases.map((p) => [p._id as string, p]));

    // Group activities by phase, then phases by WBS
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const a of laborActivities) {
      const key = a.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(a);
      activitiesByPhase.set(key, list);
    }

    const phasesByWBS = new Map<string, Doc<"phases">[]>();
    for (const p of allPhases) {
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }

    // Build flat rows sorted by WBS → Phase → Activity sortOrder
    const rows: Array<{
      id: string;
      wbsId: string;
      phaseId: string;
      wbsCode: string;
      phaseCode: string;
      size: string;
      flc: string;
      description: string;
      spec: string;
      insulation: string;
      insulationSize: number | null;
      sheet: number | null;
      quantity: number;
      unit: string;
      craftMH: number;
      weldMH: number;
      totalMH: number;
      quantityComplete: number;
      quantityRemaining: number;
      earnedMH: number;
      remainingMH: number;
      percentComplete: number;
      sortOrder: number;
    }> = [];

    // Summary accumulators
    const wbsSummaries: Record<
      string,
      {
        description: string;
        totalMH: number;
        earnedMH: number;
        craftMH: number;
        weldMH: number;
        percentComplete: number;
      }
    > = {};
    const phaseSummaries: Record<
      string,
      {
        description: string;
        totalMH: number;
        earnedMH: number;
        craftMH: number;
        weldMH: number;
        percentComplete: number;
      }
    > = {};

    // Sort WBS by sortOrder
    const sortedWBS = [...wbsItems].sort((a, b) => a.sortOrder - b.sortOrder);

    for (const wbs of sortedWBS) {
      let wbsTotalMH = 0;
      let wbsEarnedMH = 0;
      let wbsCraftMH = 0;
      let wbsWeldMH = 0;

      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder
      );

      for (const phase of wbsPhases) {
        let pTotalMH = 0;
        let pEarnedMH = 0;
        let pCraftMH = 0;
        let pWeldMH = 0;

        const phaseActs = (activitiesByPhase.get(phase._id as string) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder
        );

        for (const a of phaseActs) {
          const completedQty = completedByActivity.get(a._id as string) ?? 0;
          const totalMH = activityTotalMH(a);
          const craftMH = activityCraftMH(a);
          const weldMH = activityWeldMH(a);
          const earnedMH = activityEarnedMH(a, completedQty);

          rows.push({
            id: a._id as string,
            wbsId: wbs._id as string,
            phaseId: phase._id as string,
            wbsCode: String(wbs.wbsPoolId),
            phaseCode: String(phase.phasePoolId),
            size: phase.pipingSpec?.size ?? "",
            flc: phase.pipingSpec?.flc ?? "",
            description: a.description,
            spec: phase.pipingSpec?.spec ?? "",
            insulation: phase.pipingSpec?.insulation ?? "",
            insulationSize: phase.pipingSpec?.insulationSize ?? null,
            sheet: phase.sheet ?? null,
            quantity: a.quantity,
            unit: a.unit,
            craftMH,
            weldMH,
            totalMH,
            quantityComplete: completedQty,
            quantityRemaining: Math.max(0, a.quantity - completedQty),
            earnedMH,
            remainingMH: Math.max(0, totalMH - earnedMH),
            percentComplete: pct(earnedMH, totalMH),
            sortOrder: a.sortOrder,
          });

          pTotalMH += totalMH;
          pEarnedMH += earnedMH;
          pCraftMH += craftMH;
          pWeldMH += weldMH;
        }

        phaseSummaries[phase._id as string] = {
          description: phase.description ?? String(phase.phasePoolId),
          totalMH: pTotalMH,
          earnedMH: pEarnedMH,
          craftMH: pCraftMH,
          weldMH: pWeldMH,
          percentComplete: pct(pEarnedMH, pTotalMH),
        };

        wbsTotalMH += pTotalMH;
        wbsEarnedMH += pEarnedMH;
        wbsCraftMH += pCraftMH;
        wbsWeldMH += pWeldMH;
      }

      wbsSummaries[wbs._id as string] = {
        description: wbs.name ?? String(wbs.wbsPoolId),
        totalMH: wbsTotalMH,
        earnedMH: wbsEarnedMH,
        craftMH: wbsCraftMH,
        weldMH: wbsWeldMH,
        percentComplete: pct(wbsEarnedMH, wbsTotalMH),
      };
    }

    return {
      project: {
        id: project._id as string,
        name: project.name,
        proposalNumber: project.proposalNumber,
        jobNumber: project.jobNumber ?? "",
        owner: project.ownerName,
        location: project.location ?? "",
      },
      rows,
      wbsSummaries,
      phaseSummaries,
    };
  },
});

/**
 * Weekly breakdown of earned MH grouped by ISO week.
 *
 * Used for progress summary reports and weekly earned MH tables.
 */
export const getWeeklyBreakdown = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const allActivities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Accumulate by week
    const weekMap = new Map<string, { totalQuantity: number; totalEarnedMH: number }>();
    // Also per-activity per-week
    const byActivity = new Map<string, Map<string, { quantity: number; earnedMH: number }>>();

    for (const entry of entries) {
      const weekEnding = getWeekEndingSaturday(entry.entryDate);
      const activity = activityById.get(entry.activityId as string);
      if (!activity) continue;

      const earnedMH = activityEarnedMH(activity, entry.quantityCompleted);

      // Weekly totals
      const week = weekMap.get(weekEnding) ?? { totalQuantity: 0, totalEarnedMH: 0 };
      week.totalQuantity += entry.quantityCompleted;
      week.totalEarnedMH += earnedMH;
      weekMap.set(weekEnding, week);

      // Per-activity weekly
      const actKey = entry.activityId as string;
      if (!byActivity.has(actKey)) byActivity.set(actKey, new Map());
      const actWeekMap = byActivity.get(actKey)!;
      const actWeek = actWeekMap.get(weekEnding) ?? { quantity: 0, earnedMH: 0 };
      actWeek.quantity += entry.quantityCompleted;
      actWeek.earnedMH += earnedMH;
      actWeekMap.set(weekEnding, actWeek);
    }

    // Sort weeks chronologically
    const weeks = [...weekMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekEnding, data]) => ({
        weekEnding,
        totalQuantity: data.totalQuantity,
        totalEarnedMH: data.totalEarnedMH,
      }));

    // Convert byActivity map to serializable record
    const byActivityRecord: Record<
      string,
      Array<{ weekEnding: string; quantity: number; earnedMH: number }>
    > = {};
    for (const [actId, weekData] of byActivity) {
      byActivityRecord[actId] = [...weekData.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekEnding, data]) => ({ weekEnding, ...data }));
    }

    return { weeks, byActivity: byActivityRecord };
  },
});

/**
 * Complete export data for Excel workbook generation.
 *
 * Combines browse data, weekly breakdown, and entry-level detail
 * into a single payload for client-side Excel generation.
 */
export const getExportData = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

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

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    const completedByActivity = buildCompletedMap(entries);

    // Index lookups
    const phaseById = new Map(allPhases.map((p) => [p._id as string, p]));
    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    // Build weekly data
    const weekSet = new Set<string>();
    const weeklyByActivity = new Map<string, Map<string, { qty: number; earnedMH: number }>>();

    for (const entry of entries) {
      const weekEnding = getWeekEndingSaturday(entry.entryDate);
      weekSet.add(weekEnding);

      const actKey = entry.activityId as string;
      if (!weeklyByActivity.has(actKey)) weeklyByActivity.set(actKey, new Map());
      const actWeeks = weeklyByActivity.get(actKey)!;
      const w = actWeeks.get(weekEnding) ?? { qty: 0, earnedMH: 0 };
      const activity = activityById.get(actKey);
      w.qty += entry.quantityCompleted;
      if (activity) w.earnedMH += activityEarnedMH(activity, entry.quantityCompleted);
      actWeeks.set(weekEnding, w);
    }

    const weekEndings = [...weekSet].sort();

    // Build flat rows
    const sortedWBS = [...wbsItems].sort((a, b) => a.sortOrder - b.sortOrder);
    const phasesByWBS = new Map<string, Doc<"phases">[]>();
    for (const p of allPhases) {
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const a of laborActivities) {
      const key = a.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(a);
      activitiesByPhase.set(key, list);
    }

    const rows: Array<{
      rowType: "wbs" | "phase" | "detail";
      id: string;
      wbsCode: string;
      phaseCode: string;
      description: string;
      size: string;
      flc: string;
      spec: string;
      insulation: string;
      insulationSize: number | null;
      sheet: number | null;
      quantity: number;
      unit: string;
      craftMH: number;
      weldMH: number;
      totalMH: number;
      quantityComplete: number;
      quantityRemaining: number;
      earnedMH: number;
      remainingMH: number;
      percentComplete: number;
      weeklyQty: Record<string, number>;
      weeklyEarnedMH: Record<string, number>;
    }> = [];

    for (const wbs of sortedWBS) {
      let wbsTotalMH = 0;
      let wbsEarnedMH = 0;
      let wbsCraftMH = 0;
      let wbsWeldMH = 0;
      const wbsWeeklyQty: Record<string, number> = {};
      const wbsWeeklyEarned: Record<string, number> = {};

      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder
      );

      const wbsRowIndex = rows.length;
      // Placeholder WBS row — filled in after children
      rows.push({
        rowType: "wbs",
        id: wbs._id as string,
        wbsCode: String(wbs.wbsPoolId),
        phaseCode: "",
        description: wbs.name,
        size: "",
        flc: "",
        spec: "",
        insulation: "",
        insulationSize: null,
        sheet: null,
        quantity: 0,
        unit: "",
        craftMH: 0,
        weldMH: 0,
        totalMH: 0,
        quantityComplete: 0,
        quantityRemaining: 0,
        earnedMH: 0,
        remainingMH: 0,
        percentComplete: 0,
        weeklyQty: {},
        weeklyEarnedMH: {},
      });

      for (const phase of wbsPhases) {
        let pTotalMH = 0;
        let pEarnedMH = 0;
        let pCraftMH = 0;
        let pWeldMH = 0;
        const pWeeklyQty: Record<string, number> = {};
        const pWeeklyEarned: Record<string, number> = {};

        const phaseActs = (activitiesByPhase.get(phase._id as string) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder
        );

        const phaseRowIndex = rows.length;
        // Placeholder phase row
        rows.push({
          rowType: "phase",
          id: phase._id as string,
          wbsCode: String(wbs.wbsPoolId),
          phaseCode: String(phase.phasePoolId),
          description: phase.description,
          size: phase.pipingSpec?.size ?? "",
          flc: phase.pipingSpec?.flc ?? "",
          spec: phase.pipingSpec?.spec ?? "",
          insulation: phase.pipingSpec?.insulation ?? "",
          insulationSize: phase.pipingSpec?.insulationSize ?? null,
          sheet: phase.sheet ?? null,
          quantity: 0,
          unit: "",
          craftMH: 0,
          weldMH: 0,
          totalMH: 0,
          quantityComplete: 0,
          quantityRemaining: 0,
          earnedMH: 0,
          remainingMH: 0,
          percentComplete: 0,
          weeklyQty: {},
          weeklyEarnedMH: {},
        });

        for (const a of phaseActs) {
          const completedQty = completedByActivity.get(a._id as string) ?? 0;
          const totalMH = activityTotalMH(a);
          const craftMH = activityCraftMH(a);
          const weldMH = activityWeldMH(a);
          const earnedMH = activityEarnedMH(a, completedQty);

          // Weekly data for this activity
          const actWeeks = weeklyByActivity.get(a._id as string);
          const rowWeeklyQty: Record<string, number> = {};
          const rowWeeklyEarned: Record<string, number> = {};
          if (actWeeks) {
            for (const [we, data] of actWeeks) {
              rowWeeklyQty[we] = data.qty;
              rowWeeklyEarned[we] = data.earnedMH;
              pWeeklyQty[we] = (pWeeklyQty[we] ?? 0) + data.qty;
              pWeeklyEarned[we] = (pWeeklyEarned[we] ?? 0) + data.earnedMH;
            }
          }

          rows.push({
            rowType: "detail",
            id: a._id as string,
            wbsCode: String(wbs.wbsPoolId),
            phaseCode: String(phase.phasePoolId),
            description: a.description,
            size: phase.pipingSpec?.size ?? "",
            flc: phase.pipingSpec?.flc ?? "",
            spec: phase.pipingSpec?.spec ?? "",
            insulation: phase.pipingSpec?.insulation ?? "",
            insulationSize: phase.pipingSpec?.insulationSize ?? null,
            sheet: phase.sheet ?? null,
            quantity: a.quantity,
            unit: a.unit,
            craftMH,
            weldMH,
            totalMH,
            quantityComplete: completedQty,
            quantityRemaining: Math.max(0, a.quantity - completedQty),
            earnedMH,
            remainingMH: Math.max(0, totalMH - earnedMH),
            percentComplete: pct(earnedMH, totalMH),
            weeklyQty: rowWeeklyQty,
            weeklyEarnedMH: rowWeeklyEarned,
          });

          pTotalMH += totalMH;
          pEarnedMH += earnedMH;
          pCraftMH += craftMH;
          pWeldMH += weldMH;
        }

        // Fill phase summary row
        rows[phaseRowIndex]!.craftMH = pCraftMH;
        rows[phaseRowIndex]!.weldMH = pWeldMH;
        rows[phaseRowIndex]!.totalMH = pTotalMH;
        rows[phaseRowIndex]!.earnedMH = pEarnedMH;
        rows[phaseRowIndex]!.remainingMH = Math.max(0, pTotalMH - pEarnedMH);
        rows[phaseRowIndex]!.percentComplete = pct(pEarnedMH, pTotalMH);
        rows[phaseRowIndex]!.weeklyQty = pWeeklyQty;
        rows[phaseRowIndex]!.weeklyEarnedMH = pWeeklyEarned;

        wbsTotalMH += pTotalMH;
        wbsEarnedMH += pEarnedMH;
        wbsCraftMH += pCraftMH;
        wbsWeldMH += pWeldMH;
        for (const [we, q] of Object.entries(pWeeklyQty)) {
          wbsWeeklyQty[we] = (wbsWeeklyQty[we] ?? 0) + q;
        }
        for (const [we, e] of Object.entries(pWeeklyEarned)) {
          wbsWeeklyEarned[we] = (wbsWeeklyEarned[we] ?? 0) + e;
        }
      }

      // Fill WBS summary row
      rows[wbsRowIndex]!.craftMH = wbsCraftMH;
      rows[wbsRowIndex]!.weldMH = wbsWeldMH;
      rows[wbsRowIndex]!.totalMH = wbsTotalMH;
      rows[wbsRowIndex]!.earnedMH = wbsEarnedMH;
      rows[wbsRowIndex]!.remainingMH = Math.max(0, wbsTotalMH - wbsEarnedMH);
      rows[wbsRowIndex]!.percentComplete = pct(wbsEarnedMH, wbsTotalMH);
      rows[wbsRowIndex]!.weeklyQty = wbsWeeklyQty;
      rows[wbsRowIndex]!.weeklyEarnedMH = wbsWeeklyEarned;
    }

    return {
      project: {
        id: project._id as string,
        name: project.name,
        proposalNumber: project.proposalNumber,
        jobNumber: project.jobNumber ?? "",
        owner: project.ownerName,
        location: project.location ?? "",
        startDate: project.actualStartDate ?? "",
      },
      rows,
      weekEndings,
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

/** Update momentum project fields. */
export const updateProject = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    name: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("on-hold"),
        v.literal("completed"),
        v.literal("archived")
      )
    ),
    actualStartDate: v.optional(v.string()),
    projectedEndDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.status !== undefined) updates.status = args.status;
    if (args.actualStartDate !== undefined) updates.actualStartDate = args.actualStartDate;
    if (args.projectedEndDate !== undefined) updates.projectedEndDate = args.projectedEndDate;

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.projectId, updates);
    }
  },
});

/** Delete a momentum project and all its progress entries. */
export const deleteProject = mutation({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    // Delete all progress entries for this project
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    await ctx.db.delete(args.projectId);
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
      const activity = await ctx.db.get(entry.activityId);
      if (!activity) continue;

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
