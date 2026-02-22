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
import { authComponent } from "./auth";

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
      .withIndex("by_project_date", (q) =>
        q.eq("projectId", args.projectId).eq("entryDate", args.entryDate)
      )
      .collect();

    const result: Record<string, { quantity: number; notes?: string }> = {};
    for (const entry of entries) {
      result[entry.activityId as string] = {
        quantity: entry.quantityCompleted,
        notes: entry.notes,
      };
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

    // Fetch phase overrides for this project
    const overrides = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const overrideMap = new Map(overrides.map((o) => [o.activityId as string, o]));

    // Build phase lookup by ID
    const phaseById = new Map(allPhases.map((p) => [p._id as string, p]));

    // Group activities by effective phase (applying overrides)
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const a of laborActivities) {
      const override = overrideMap.get(a._id as string);
      const effectivePhaseId = override
        ? (override.overridePhaseId as string)
        : (a.phaseId as string);
      const list = activitiesByPhase.get(effectivePhaseId) ?? [];
      list.push(a);
      activitiesByPhase.set(effectivePhaseId, list);
    }

    const phasesByWBS = new Map<string, Doc<"phases">[]>();
    for (const p of allPhases) {
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }

    // Build phasesByWbs for the UI phase picker
    const phasesByWbsResult: Record<
      string,
      Array<{ id: string; code: string; description: string }>
    > = {};
    for (const [wbsId, phases] of phasesByWBS) {
      phasesByWbsResult[wbsId] = phases.map((p) => ({
        id: p._id as string,
        code: String(p.phasePoolId),
        description: p.description ?? String(p.phasePoolId),
      }));
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
      isOverridden: boolean;
      originalPhaseId?: string;
      originalPhaseCode?: string;
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

          // Check for phase override
          const override = overrideMap.get(a._id as string);
          const isOverridden = !!override;
          const originalPhase = isOverridden
            ? phaseById.get(override.originalPhaseId as string)
            : undefined;

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
            isOverridden,
            originalPhaseId: isOverridden ? (override.originalPhaseId as string) : undefined,
            originalPhaseCode: originalPhase ? String(originalPhase.phasePoolId) : undefined,
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

    // Project-level totals from WBS summaries
    let browseTotalMH = 0;
    let browseEarnedMH = 0;
    let browseCraftMH = 0;
    let browseWeldMH = 0;
    for (const s of Object.values(wbsSummaries)) {
      browseTotalMH += s.totalMH;
      browseEarnedMH += s.earnedMH;
      browseCraftMH += s.craftMH;
      browseWeldMH += s.weldMH;
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
        totalMH: browseTotalMH,
        earnedMH: browseEarnedMH,
        craftMH: browseCraftMH,
        weldMH: browseWeldMH,
        percentComplete: pct(browseEarnedMH, browseTotalMH),
      },
      rows,
      wbsSummaries,
      phaseSummaries,
      phasesByWbs: phasesByWbsResult,
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

    const proposal = await ctx.db.get(project.proposalId);

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
    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    // Build weekly data
    const weekSet = new Set<string>();
    const weeklyByActivity = new Map<string, Map<string, { qty: number; earnedMH: number }>>();

    // Build daily quantity map per activity
    const dailyByActivity = new Map<string, Record<string, number>>();

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

      // Daily quantities
      if (!dailyByActivity.has(actKey)) dailyByActivity.set(actKey, {});
      const actDaily = dailyByActivity.get(actKey)!;
      actDaily[entry.entryDate] = (actDaily[entry.entryDate] ?? 0) + entry.quantityCompleted;
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
      dailyQty: Record<string, number>;
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
        dailyQty: {},
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
          dailyQty: {},
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
            dailyQty: dailyByActivity.get(a._id as string) ?? {},
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

    // Sum WBS summaries for project-level totals
    let projectTotalMH = 0;
    let projectEarnedMH = 0;
    let projectCraftMH = 0;
    let projectWeldMH = 0;
    for (const wbs of sortedWBS) {
      const s = rows.find((r) => r.rowType === "wbs" && r.id === (wbs._id as string));
      if (s) {
        projectTotalMH += s.totalMH;
        projectEarnedMH += s.earnedMH;
        projectCraftMH += s.craftMH;
        projectWeldMH += s.weldMH;
      }
    }

    return {
      project: {
        id: project._id as string,
        name: project.name,
        proposalNumber: project.proposalNumber,
        jobNumber: project.jobNumber ?? "",
        changeNumber: proposal?.changeOrderNumber ?? "",
        description: proposal?.description ?? project.description ?? "",
        owner: project.ownerName,
        location: project.location ?? "",
        startDate: project.actualStartDate
          ? new Date(project.actualStartDate).toISOString().slice(0, 10)
          : "",
        status: project.status,
        totalMH: projectTotalMH,
        earnedMH: projectEarnedMH,
        craftMH: projectCraftMH,
        weldMH: projectWeldMH,
        percentComplete: pct(projectEarnedMH, projectTotalMH),
      },
      rows,
      weekEndings,
    };
  },
});

/**
 * Recent entry history for a project, grouped by date.
 *
 * Powers the history panel — shows who entered what, when.
 */
export const getEntryHistory = query({
  args: {
    projectId: v.id("momentumProjects"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const limit = args.limit ?? 500;
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(limit + 1);

    const hasMore = entries.length > limit;
    const trimmed = hasMore ? entries.slice(0, limit) : entries;

    // Batch-fetch activity descriptions
    const activityIds = [...new Set(trimmed.map((e) => e.activityId as string))];
    const activityMap = new Map<string, Doc<"activities">>();
    for (const id of activityIds) {
      const activity = await ctx.db.get(id as Id<"activities">);
      if (activity) activityMap.set(id, activity);
    }

    // Group by date
    const dateMap = new Map<
      string,
      {
        totalQuantity: number;
        entries: Array<{
          activityId: string;
          activityDescription: string;
          unit: string;
          quantityCompleted: number;
          enteredBy?: string;
          notes?: string;
        }>;
      }
    >();

    for (const entry of trimmed) {
      const activity = activityMap.get(entry.activityId as string);
      const group = dateMap.get(entry.entryDate) ?? { totalQuantity: 0, entries: [] };

      group.totalQuantity += entry.quantityCompleted;
      group.entries.push({
        activityId: entry.activityId as string,
        activityDescription: activity?.description ?? "Unknown activity",
        unit: activity?.unit ?? "",
        quantityCompleted: entry.quantityCompleted,
        enteredBy: entry.enteredBy,
        notes: entry.notes,
      });

      dateMap.set(entry.entryDate, group);
    }

    // Sort dates descending
    const days = [...dateMap.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, data]) => ({
        date,
        totalQuantity: data.totalQuantity,
        entryCount: data.entries.length,
        entries: data.entries,
      }));

    return { days, hasMore };
  },
});

/**
 * WBS items with nested phase-level progress breakdown.
 *
 * Separate from getProjectWBS to keep existing consumers lean.
 * Powers the expanded reports table.
 */
export const getPhaseBreakdown = query({
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

    // Index activities by phase
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const a of laborActivities) {
      const key = a.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(a);
      activitiesByPhase.set(key, list);
    }

    // Index phases by WBS
    const phasesByWBS = new Map<string, Doc<"phases">[]>();
    for (const p of allPhases) {
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }

    const sortedWBS = [...wbsItems].sort((a, b) => a.sortOrder - b.sortOrder);

    let projectTotalMH = 0;
    let projectEarnedMH = 0;
    let projectCraftMH = 0;
    let projectWeldMH = 0;

    const wbsResults = sortedWBS.map((wbs) => {
      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder
      );

      let wbsTotalMH = 0;
      let wbsEarnedMH = 0;
      let wbsCraftMH = 0;
      let wbsWeldMH = 0;

      const phases = wbsPhases.map((phase) => {
        const phaseActs = (activitiesByPhase.get(phase._id as string) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder
        );

        let pTotalMH = 0;
        let pEarnedMH = 0;
        let pCraftMH = 0;
        let pWeldMH = 0;

        for (const a of phaseActs) {
          const completedQty = completedByActivity.get(a._id as string) ?? 0;
          pTotalMH += activityTotalMH(a);
          pCraftMH += activityCraftMH(a);
          pWeldMH += activityWeldMH(a);
          pEarnedMH += activityEarnedMH(a, completedQty);
        }

        wbsTotalMH += pTotalMH;
        wbsEarnedMH += pEarnedMH;
        wbsCraftMH += pCraftMH;
        wbsWeldMH += pWeldMH;

        const phasePercent = pct(pEarnedMH, pTotalMH);
        return {
          id: phase._id as string,
          code: String(phase.phasePoolId),
          description: phase.description ?? String(phase.phasePoolId),
          activityCount: phaseActs.length,
          totalMH: pTotalMH,
          craftMH: pCraftMH,
          weldMH: pWeldMH,
          earnedMH: pEarnedMH,
          remainingMH: Math.max(0, pTotalMH - pEarnedMH),
          percentComplete: phasePercent,
          status: statusFromPercent(phasePercent),
        };
      });

      projectTotalMH += wbsTotalMH;
      projectEarnedMH += wbsEarnedMH;
      projectCraftMH += wbsCraftMH;
      projectWeldMH += wbsWeldMH;

      const wbsPercent = pct(wbsEarnedMH, wbsTotalMH);
      return {
        id: wbs._id as string,
        code: String(wbs.wbsPoolId),
        description: wbs.name,
        totalMH: wbsTotalMH,
        craftMH: wbsCraftMH,
        weldMH: wbsWeldMH,
        earnedMH: wbsEarnedMH,
        remainingMH: Math.max(0, wbsTotalMH - wbsEarnedMH),
        percentComplete: wbsPercent,
        status: statusFromPercent(wbsPercent),
        phases,
      };
    });

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

    const user = await authComponent.safeGetAuthUser(ctx);
    const enteredBy = user?.name ?? user?.email ?? undefined;

    for (const entry of args.entries) {
      const activity = await ctx.db.get(entry.activityId);
      if (!activity) continue;

      // Validate quantity won't exceed estimated total
      if (entry.quantityCompleted > 0) {
        const otherEntries = await ctx.db
          .query("progressEntries")
          .withIndex("by_project_activity_date", (q) =>
            q.eq("projectId", args.projectId).eq("activityId", entry.activityId)
          )
          .collect();

        const completedOtherDays = otherEntries
          .filter((e) => e.entryDate !== args.entryDate)
          .reduce((sum, e) => sum + e.quantityCompleted, 0);

        if (completedOtherDays + entry.quantityCompleted > activity.quantity) {
          throw new Error(
            `Exceeds estimated quantity for "${activity.description}". ` +
              `Max remaining: ${activity.quantity - completedOtherDays}`
          );
        }
      }

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
            enteredBy,
          });
        }
      } else if (entry.quantityCompleted > 0) {
        // Check for phase override to use effective phase/wbs
        const override = await ctx.db
          .query("activityPhaseOverrides")
          .withIndex("by_project_activity", (q) =>
            q.eq("projectId", args.projectId).eq("activityId", entry.activityId)
          )
          .first();

        const effectivePhaseId = override ? override.overridePhaseId : activity.phaseId;
        const effectiveWbsId = override
          ? ((await ctx.db.get(override.overridePhaseId))?.wbsId ?? activity.wbsId)
          : activity.wbsId;

        await ctx.db.insert("progressEntries", {
          projectId: args.projectId,
          activityId: entry.activityId,
          wbsId: effectiveWbsId,
          phaseId: effectivePhaseId,
          entryDate: args.entryDate,
          quantityCompleted: entry.quantityCompleted,
          notes: entry.notes,
          enteredBy,
        });
      }
    }

    await ctx.db.patch(args.projectId, { lastEntryDate: args.entryDate });
  },
});

/** Reassign an activity to a different phase within the same WBS. */
export const reassignActivityPhase = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    activityId: v.id("activities"),
    targetPhaseId: v.id("phases"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found.");

    const targetPhase = await ctx.db.get(args.targetPhaseId);
    if (!targetPhase) throw new Error("Target phase not found.");

    // Ensure target phase belongs to the same proposal
    if (targetPhase.proposalId !== project.proposalId) {
      throw new Error("Target phase does not belong to this project's proposal.");
    }

    // Ensure same-WBS move (Phase 1 constraint)
    const existingOverride = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project_activity", (q) =>
        q.eq("projectId", args.projectId).eq("activityId", args.activityId)
      )
      .first();

    const originalPhaseId = existingOverride ? existingOverride.originalPhaseId : activity.phaseId;
    const originalWbsId = existingOverride ? existingOverride.originalWbsId : activity.wbsId;

    if (targetPhase.wbsId !== activity.wbsId) {
      throw new Error("Cross-WBS moves are not supported yet.");
    }

    // If reverting to original phase, delete the override
    if (args.targetPhaseId === originalPhaseId) {
      if (existingOverride) {
        // Revert progress entries to original phase/wbs
        const entries = await ctx.db
          .query("progressEntries")
          .withIndex("by_project_activity", (q) =>
            q.eq("projectId", args.projectId).eq("activityId", args.activityId)
          )
          .collect();

        for (const entry of entries) {
          await ctx.db.patch(entry._id, {
            phaseId: originalPhaseId,
            wbsId: originalWbsId,
          });
        }

        await ctx.db.delete(existingOverride._id);
      }
      return;
    }

    // Update denormalized phase/wbs on existing progress entries
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) =>
        q.eq("projectId", args.projectId).eq("activityId", args.activityId)
      )
      .collect();

    for (const entry of entries) {
      await ctx.db.patch(entry._id, {
        phaseId: args.targetPhaseId,
        wbsId: targetPhase.wbsId,
      });
    }

    // Upsert the override
    if (existingOverride) {
      await ctx.db.patch(existingOverride._id, {
        overridePhaseId: args.targetPhaseId,
      });
    } else {
      await ctx.db.insert("activityPhaseOverrides", {
        projectId: args.projectId,
        activityId: args.activityId,
        overridePhaseId: args.targetPhaseId,
        originalPhaseId: activity.phaseId,
        originalWbsId: activity.wbsId,
        createdAt: Date.now(),
      });
    }
  },
});

/** Revert an activity's phase override back to the original estimate phase. */
export const revertActivityPhase = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args) => {
    const override = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project_activity", (q) =>
        q.eq("projectId", args.projectId).eq("activityId", args.activityId)
      )
      .first();

    if (!override) return;

    // Restore progress entries to original phase/wbs
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) =>
        q.eq("projectId", args.projectId).eq("activityId", args.activityId)
      )
      .collect();

    for (const entry of entries) {
      await ctx.db.patch(entry._id, {
        phaseId: override.originalPhaseId,
        wbsId: override.originalWbsId,
      });
    }

    await ctx.db.delete(override._id);
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
