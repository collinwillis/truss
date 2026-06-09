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
import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { api, components, internal } from "./_generated/api";
import { resolveUserScope } from "./projectAssignments";

// ============================================================================
// HELPERS
// ============================================================================

/** Activity types that contribute man-hours. */
const LABOR_TYPES = new Set(["labor", "custom_labor"]);

/**
 * Cost-relevant shape shared by `activities` (Precision) and
 * `momentumActivities` (Momentum). Helpers operate on either via this
 * structural type so the same math powers legacy and snapshot paths.
 */
type CostActivity = {
  type: string;
  quantity: number;
  labor?: {
    craftConstant: number;
    welderConstant: number;
    customCraftRate?: number;
    customSubsistenceRate?: number;
  };
};

/**
 * Calculate total estimated man-hours for a single activity.
 *
 * Formula: quantity × (craftConstant + welderConstant)
 */
function activityTotalMH(activity: CostActivity): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return activity.quantity * (activity.labor.craftConstant + activity.labor.welderConstant);
}

/** Calculate craft man-hours for a single activity. */
function activityCraftMH(activity: CostActivity): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return activity.quantity * activity.labor.craftConstant;
}

/** Calculate weld man-hours for a single activity. */
function activityWeldMH(activity: CostActivity): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return activity.quantity * activity.labor.welderConstant;
}

/**
 * Calculate earned man-hours for a given completed quantity.
 *
 * Uses the same constants as the estimate so progress is measured
 * in the same unit as the budget.
 */
function activityEarnedMH(activity: CostActivity, completedQty: number): number {
  if (!LABOR_TYPES.has(activity.type) || !activity.labor) return 0;
  return completedQty * (activity.labor.craftConstant + activity.labor.welderConstant);
}

/** Derive status string from a percentage. */
function statusFromPercent(pct: number): "not-started" | "in-progress" | "complete" {
  if (pct === 0) return "not-started";
  if (pct >= 100) return "complete";
  return "in-progress";
}

/** Safe percentage calculation — returns value with 2 decimal precision. */
function pct(earned: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((earned / total) * 10000) / 100;
}

/** Round to 2 decimals to eliminate floating-point noise (e.g. 2.77e-17 → 0). */
function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Build a completed-quantity-per-activity map keyed by momentum activity id.
 * Used by post-snapshot queries that operate on `momentumActivities`.
 */
function buildCompletedMapMomentum(entries: Doc<"progressEntries">[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.newActivityId) continue;
    const key = entry.newActivityId as string;
    map.set(key, (map.get(key) ?? 0) + entry.quantityCompleted);
  }
  return map;
}

/**
 * Progress totals bucketed by source-activity vs. individual split.
 *
 * The source bucket excludes quantities logged against splits, so adding
 * the source total plus every split total for an activity recovers the
 * activity-level completed quantity. The two buckets exist because a
 * split's progress is independent of the source's — they're tracked as
 * separate budgets and rendered as separate workbook rows.
 */
interface ProgressTotalsBuckets {
  /** Source-only completed (entries with no splitId), keyed by newActivityId. */
  bySource: Map<string, number>;
  /** Per-split completed, keyed by splitId. */
  bySplit: Map<string, number>;
}

/** Bucket Momentum progress entries into source-only and per-split totals. */
function buildProgressBuckets(entries: Doc<"progressEntries">[]): ProgressTotalsBuckets {
  const bySource = new Map<string, number>();
  const bySplit = new Map<string, number>();
  for (const entry of entries) {
    if (entry.splitId) {
      const key = entry.splitId as string;
      bySplit.set(key, (bySplit.get(key) ?? 0) + entry.quantityCompleted);
    } else if (entry.newActivityId) {
      const key = entry.newActivityId as string;
      bySource.set(key, (bySource.get(key) ?? 0) + entry.quantityCompleted);
    }
  }
  return { bySource, bySplit };
}

/**
 * Aggregated split totals per source activity. Reduces the source row's
 * effective budget when computing the workbook (source.quantity − sum).
 */
function buildSplitQuantityMap(splits: Doc<"activitySplits">[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of splits) {
    const key = s.sourceActivityId as string;
    map.set(key, (map.get(key) ?? 0) + s.quantity);
  }
  return map;
}

/**
 * WBS code shown for the Change Orders WBS. It has no estimate ancestor (no
 * `sourceWbsPoolId`); InDemand's convention numbers Change Orders 300000,
 * which — being higher than any estimate WBS code — also places it last under
 * numeric ordering.
 */
const CHANGE_ORDERS_WBS_CODE = "300000";

/** Leading numeric token of a string ("1255 - Nitron" → "1255"), or null. */
function leadingNumber(s: string): string | null {
  const m = s.match(/^\s*(\d+(?:\.\d+)?)/);
  return m ? m[1]! : null;
}

/** Full US state name → 2-letter abbreviation (source addresses store either). */
const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

/**
 * Format a proposal's structured address into a compact "City, ST" for the
 * project tile (#29). State is abbreviated when a full name is given; an empty
 * city or state is simply omitted.
 */
function formatCityState(addr?: { city?: string; state?: string }): string {
  const city = addr?.city?.trim() ?? "";
  let state = addr?.state?.trim() ?? "";
  if (state.length > 2) state = US_STATE_ABBR[state.toLowerCase()] ?? state;
  else state = state.toUpperCase();
  return [city, state].filter(Boolean).join(", ");
}

/**
 * The project number a user identifies a job by. The name is the canonical
 * place this number is shown (e.g. "1255 - Nitron 8000"), and it frequently
 * differs from the MCP `proposalNumber` — so we derive from the name first,
 * then fall back to the proposal number. Used to seed `projectNumber` on new
 * projects and to backfill legacy rows.
 */
function deriveProjectNumber(name: string, proposalNumber: string): string {
  return leadingNumber(name) ?? leadingNumber(proposalNumber) ?? proposalNumber;
}

/**
 * Derive the display code shown in the WBS pill (`10000`, `30000`, etc.).
 * Estimate WBS rows carry their original numeric `wbsPoolId`; the Change
 * Orders WBS has no pool ancestor and renders as `300000`.
 */
function wbsDisplayCode(wbs: Doc<"momentumWbs">): string {
  return wbs.sourceWbsPoolId !== undefined ? String(wbs.sourceWbsPoolId) : CHANGE_ORDERS_WBS_CODE;
}

/** Numeric form of a WBS display code, for numerical ordering. */
function wbsNumericCode(wbs: Doc<"momentumWbs">): number {
  return Number(wbsDisplayCode(wbs));
}

/**
 * Comparator that orders WBS rows for display by their numeric code ascending,
 * so the workbook tree always reads in numerical order (10000, 30000, …). The
 * Change Orders WBS (code 300000) sorts last by virtue of its code. Used by
 * every query that renders the tree.
 */
function compareWbsForDisplay(a: Doc<"momentumWbs">, b: Doc<"momentumWbs">): number {
  return wbsNumericCode(a) - wbsNumericCode(b);
}

/**
 * Comparator that orders phases for display by their numeric phase code
 * ascending, so phase codes read in numerical order within each WBS.
 */
function comparePhasesForDisplay(a: { phaseNumber: number }, b: { phaseNumber: number }): number {
  return a.phaseNumber - b.phaseNumber;
}

/**
 * Code shown in a phase pill. Phases added in Momentum carry an explicit
 * `phaseCode` (e.g. "300000-001" or "20020"); estimate phases fall back to
 * their numeric `phaseNumber`.
 */
function phaseDisplayCode(phase: { phaseCode?: string; phaseNumber: number }): string {
  return phase.phaseCode ?? String(phase.phaseNumber);
}

/**
 * Numeric sort key for a phase added in Momentum, derived from its code so it
 * orders correctly within its WBS: "300000-001" → 1 (change-order number),
 * "20020" → 20020. Non-numeric or absent codes fall back to `nextNumber`.
 */
function derivePhaseNumber(phaseCode: string | undefined, nextNumber: number): number {
  if (phaseCode) {
    const tail = phaseCode.includes("-")
      ? phaseCode.slice(phaseCode.lastIndexOf("-") + 1)
      : phaseCode;
    const parsed = Number(tail);
    if (Number.isFinite(parsed)) return parsed;
  }
  return nextNumber;
}

/**
 * Get the week-ending Sunday date string for a given date string.
 *
 * Reporting cycles run Mon–Sun per InDemand convention.
 */
function getWeekEndingSunday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  const diff = day === 0 ? 0 : 7 - day; // Sun stays, else forward to next Sun
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// VALIDATORS (shared with schema.ts and precision.ts)
// ============================================================================

const activityTypeValidator = v.union(
  v.literal("labor"),
  v.literal("material"),
  v.literal("equipment"),
  v.literal("subcontractor"),
  v.literal("cost_only"),
  v.literal("custom_labor")
);

const equipmentOwnershipValidator = v.union(
  v.literal("rental"),
  v.literal("owned"),
  v.literal("purchase")
);

const laborFieldsValidator = {
  craftConstant: v.number(),
  welderConstant: v.number(),
  customCraftRate: v.optional(v.number()),
  customSubsistenceRate: v.optional(v.number()),
};

const equipmentFieldsValidator = {
  ownership: equipmentOwnershipValidator,
  time: v.number(),
};

const subcontractorFieldsValidator = {
  laborCost: v.number(),
  materialCost: v.number(),
  equipmentCost: v.number(),
};

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get existing progress entries for a project and date, keyed by **row id**
 * — `splitId` if the entry belongs to a split, otherwise `newActivityId`.
 *
 * This matches the row id convention used by `getBrowseData`: split rows
 * carry the split's `_id` as their `WorkbookRow.id`, so the same key drives
 * both prefilling and saving without the frontend having to translate.
 *
 * Entries that haven't been remapped yet (no `newActivityId` and no
 * `splitId`) are skipped — the snapshot backfill is expected to have run.
 */
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
      const rowKey = (entry.splitId ?? entry.newActivityId) as string | undefined;
      if (!rowKey) continue;
      result[rowKey] = {
        quantity: entry.quantityCompleted,
        notes: entry.notes,
      };
    }
    return result;
  },
});

/** List momentum projects visible to the current user. */
export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const allProjects = await ctx.db.query("momentumProjects").collect();
    const currentUser = await authComponent.safeGetAuthUser(ctx);

    // Determine if the current user is an org admin (owner or admin role).
    // WHY: Admins see every project. Non-admins only see projects
    // they have explicit assignments on.
    let isOrgAdmin = false;
    if (currentUser) {
      const memberResult = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "member",
        where: [{ field: "userId", value: currentUser._id }],
        paginationOpts: { cursor: null, numItems: 50 },
      });
      const memberRecords = memberResult?.page ?? [];
      isOrgAdmin = memberRecords.some((m: Record<string, unknown>) => {
        const role = m.role as string | undefined;
        return role === "owner" || role === "admin";
      });
    }

    // Filter projects: admins see all, non-admins only see assigned projects
    let visibleProjects = allProjects;
    if (!isOrgAdmin && currentUser) {
      const userAssignments = await ctx.db
        .query("projectAssignments")
        .withIndex("by_user", (q) => q.eq("userId", currentUser._id))
        .collect();
      const assignedProjectIds = new Set(userAssignments.map((a) => a.projectId as string));
      visibleProjects = allProjects.filter((p) => assignedProjectIds.has(p._id as string));
    } else if (!currentUser) {
      visibleProjects = [];
    }

    return Promise.all(
      visibleProjects.map(async (proj) => {
        // City/State for the tile comes from the source proposal's structured
        // address (the project's own `location` holds a street address). Display
        // metadata only, so a live read here is fine (#29).
        const proposal = await ctx.db.get(proj.proposalId);

        const activities = await ctx.db
          .query("momentumActivities")
          .withIndex("by_project", (q) => q.eq("projectId", proj._id))
          .collect();

        const laborActivities = activities.filter((a) => !a.removedAt && LABOR_TYPES.has(a.type));
        const totalMH = laborActivities.reduce((sum, a) => sum + activityTotalMH(a), 0);

        const entries = await ctx.db
          .query("progressEntries")
          .withIndex("by_project_new_activity", (q) => q.eq("projectId", proj._id))
          .collect();

        const completedByActivity = buildCompletedMapMomentum(entries);

        let earnedMH = 0;
        for (const activity of laborActivities) {
          const completed = completedByActivity.get(activity._id as string) ?? 0;
          earnedMH += activityEarnedMH(activity, completed);
        }

        return {
          id: proj._id as string,
          proposalNumber: proj.proposalNumber,
          projectNumber: proj.projectNumber ?? deriveProjectNumber(proj.name, proj.proposalNumber),
          jobNumber: proj.jobNumber ?? "",
          name: proj.name,
          description: proj.description ?? "",
          owner: proj.ownerName,
          location: proj.location ?? "",
          cityState: formatCityState(proposal?.projectAddress),
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

/**
 * Get WBS items with progress rollups for a project dashboard.
 *
 * Reads from Momentum tables — includes change-order WBS and field-added
 * activities in the totals.
 */
export const getProjectWBS = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const wbsItems = await ctx.db
      .query("momentumWbs")
      .withIndex("by_project_sort", (q) => q.eq("projectId", args.projectId))
      .collect();

    const activities = await ctx.db
      .query("momentumActivities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    // ── Scope resolution (opt-in; mirrors the workbook query). Without this the
    // WBS dashboard would leak every WBS — including Change Orders (300000) — to
    // a foreman scoped to a single WBS (#39). Only enforced once a project has
    // any assignment; otherwise everyone has full access.
    const currentUser = await authComponent.safeGetAuthUser(ctx);
    let allowedPhaseIds: Set<string> | "all" = "all";
    let allowedWbsIds: Set<string> | "all" = "all";
    if (currentUser) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .first();
      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, args.projectId, currentUser._id);
        allowedPhaseIds = scope.hasAccess ? scope.allowedPhaseIds : new Set();
        allowedWbsIds = scope.hasAccess ? scope.allowedWbsIds : new Set();
      }
    }
    const phaseVisible = (phaseId: string) =>
      allowedPhaseIds === "all" || allowedPhaseIds.has(phaseId);

    // A WBS is visible if scoped directly, or it holds a phase in scope.
    let wbsVisible: (wbsId: string) => boolean;
    if (allowedPhaseIds === "all") {
      wbsVisible = () => true;
    } else {
      const projectPhases = await ctx.db
        .query("momentumPhases")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect();
      const visibleWbsSet = new Set<string>();
      if (allowedWbsIds !== "all") for (const id of allowedWbsIds) visibleWbsSet.add(id);
      for (const p of projectPhases) {
        if (allowedPhaseIds.has(p._id as string)) visibleWbsSet.add(p.wbsId as string);
      }
      wbsVisible = (wbsId: string) => visibleWbsSet.has(wbsId);
    }

    const activitiesByWBS = new Map<string, Doc<"momentumActivities">[]>();
    for (const a of activities) {
      if (a.removedAt || !LABOR_TYPES.has(a.type)) continue;
      if (!phaseVisible(a.phaseId as string)) continue;
      const key = a.wbsId as string;
      const list = activitiesByWBS.get(key) ?? [];
      list.push(a);
      activitiesByWBS.set(key, list);
    }

    const completedByActivity = buildCompletedMapMomentum(entries);

    const visibleWbs = wbsItems
      .filter((w) => !w.removedAt && wbsVisible(w._id as string))
      .sort(compareWbsForDisplay);
    const wbsResults = visibleWbs.map((wbs) => {
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
        code: wbsDisplayCode(wbs),
        description: wbs.name,
        totalMH,
        craftMH,
        weldMH,
        earnedMH,
        percentComplete,
        status: statusFromPercent(percentComplete),
        source: wbs.source,
      };
    });

    const allLabor = activities.filter(
      (a) => !a.removedAt && LABOR_TYPES.has(a.type) && phaseVisible(a.phaseId as string)
    );
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
        projectNumber:
          project.projectNumber ?? deriveProjectNumber(project.name, project.proposalNumber),
        jobNumber: project.jobNumber ?? "",
        owner: project.ownerName,
        location: project.location ?? "",
        status: project.status,
        workCalendar: project.workCalendar ?? "5x10",
        actualStartDate: project.actualStartDate,
        projectedEndDate: project.projectedEndDate,
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
 * Workbook-style flat table data for a Momentum project.
 *
 * Reads exclusively from Momentum-owned snapshot tables (`momentumWbs`,
 * `momentumPhases`, `momentumActivities`) so Precision edits never leak in.
 * Rows include `source` so the UI can style Change Orders rows and badge
 * field-added activities, plus `addedByUserId`/`addedAt` for attribution.
 *
 * IDs in the response (`id`, `wbsId`, `phaseId`, `originalPhaseId`) are
 * Momentum IDs. Mutations called from this view (`saveProgressEntries`,
 * `reassignActivityPhase`, etc.) must accept Momentum IDs as a result.
 */
export const getBrowseData = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    // ── Scope resolution (opt-in access control) ──
    const currentUser = await authComponent.safeGetAuthUser(ctx);
    const scopeInfo = {
      isScoped: false,
      hasAccess: true,
      effectiveRole: null as string | null,
    };
    let allowedPhaseIds: Set<string> | "all" = "all";

    if (currentUser) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, args.projectId, currentUser._id);
        scopeInfo.isScoped = true;
        scopeInfo.hasAccess = scope.hasAccess;
        scopeInfo.effectiveRole = scope.effectiveRole;
        allowedPhaseIds = scope.hasAccess ? scope.allowedPhaseIds : new Set();
      }
    }

    const wbsItems = await ctx.db
      .query("momentumWbs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allPhases = await ctx.db
      .query("momentumPhases")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allActivities = await ctx.db
      .query("momentumActivities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const laborActivities = allActivities.filter((a) => !a.removedAt && LABOR_TYPES.has(a.type));

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    const progressBuckets = buildProgressBuckets(entries);

    const overrides = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const overrideMap = new Map<string, Doc<"activityPhaseOverrides">>();
    for (const o of overrides) {
      if (o.newActivityId) overrideMap.set(o.newActivityId as string, o);
    }

    // Splits — pulled in bulk and indexed by source activity AND by target
    // phase. The first map drives source-row budget reduction; the second
    // drives virtual split-row rendering inside each phase.
    const splits = await ctx.db
      .query("activitySplits")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const splitQtyBySource = buildSplitQuantityMap(splits);
    const splitsByPhase = new Map<string, Doc<"activitySplits">[]>();
    for (const s of splits) {
      const key = s.targetPhaseId as string;
      const list = splitsByPhase.get(key) ?? [];
      list.push(s);
      splitsByPhase.set(key, list);
    }
    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    const phaseById = new Map(allPhases.map((p) => [p._id as string, p]));

    // Group activities by effective phase (applying overrides)
    const activitiesByPhase = new Map<string, Doc<"momentumActivities">[]>();
    for (const a of laborActivities) {
      const override = overrideMap.get(a._id as string);
      const effectivePhaseId =
        override?.newOverridePhaseId !== undefined
          ? (override.newOverridePhaseId as string)
          : (a.phaseId as string);
      const list = activitiesByPhase.get(effectivePhaseId) ?? [];
      list.push(a);
      activitiesByPhase.set(effectivePhaseId, list);
    }

    const phasesByWBS = new Map<string, Doc<"momentumPhases">[]>();
    for (const p of allPhases) {
      if (p.removedAt) continue;
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }

    // Build phasesByWbs for the UI phase picker. Sorted by `sortOrder` so
    // the workbook tree renders phases in the same order regardless of
    // whether they currently have any activity rows — without this, an
    // empty phase falls back to insertion order and appears out of place.
    const phasesByWbsResult: Record<
      string,
      Array<{
        id: string;
        code: string;
        description: string;
        source: "estimate" | "change_order" | "field_added";
      }>
    > = {};
    for (const [wbsId, phases] of phasesByWBS) {
      const visiblePhases = (
        allowedPhaseIds === "all"
          ? phases
          : phases.filter((p) => (allowedPhaseIds as Set<string>).has(p._id as string))
      )
        .slice()
        .sort(comparePhasesForDisplay);
      if (visiblePhases.length > 0) {
        phasesByWbsResult[wbsId] = visiblePhases.map((p) => ({
          id: p._id as string,
          code: phaseDisplayCode(p),
          description: p.description ?? phaseDisplayCode(p),
          source: p.source,
        }));
      }
    }

    type Row = {
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
      source: "estimate" | "change_order" | "field_added";
      addedByUserId?: string;
      addedAt?: number;
      // Split-row metadata. When isSplit is true, `id` is the split's _id
      // (not the source activity's) and `sourceActivityId` points back at
      // the row whose budget this slice came from.
      isSplit?: boolean;
      splitId?: string;
      sourceActivityId?: string;
      sourceDescription?: string;
      sourcePhaseCode?: string;
    };
    const rows: Row[] = [];

    type Summary = {
      description: string;
      code?: string;
      totalMH: number;
      earnedMH: number;
      craftMH: number;
      weldMH: number;
      percentComplete: number;
      source?: "estimate" | "change_order";
    };
    const wbsSummaries: Record<string, Summary> = {};
    const phaseSummaries: Record<string, Summary> = {};

    // Display order: Change Orders WBS is *always* visually last regardless
    // of its stored sortOrder, since otherwise a brand-new project could
    // shuffle it ahead of empty estimate WBS rows that happen to have a
    // higher sortOrder.
    const sortedWBS = [...wbsItems].filter((w) => !w.removedAt).sort(compareWbsForDisplay);

    for (const wbs of sortedWBS) {
      let wbsTotalMH = 0;
      let wbsEarnedMH = 0;
      let wbsCraftMH = 0;
      let wbsWeldMH = 0;
      let hasVisiblePhases = false;

      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(comparePhasesForDisplay);

      for (const phase of wbsPhases) {
        if (
          allowedPhaseIds !== "all" &&
          !(allowedPhaseIds as Set<string>).has(phase._id as string)
        ) {
          continue;
        }
        hasVisiblePhases = true;
        let pTotalMH = 0;
        let pEarnedMH = 0;
        let pCraftMH = 0;
        let pWeldMH = 0;

        const phaseActs = (activitiesByPhase.get(phase._id as string) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder
        );

        const wbsCode = wbsDisplayCode(wbs);

        for (const a of phaseActs) {
          const activityId = a._id as string;
          // Source row's effective quantity is whatever's left after every
          // split has claimed its slice. MH math scales linearly with that
          // reduced quantity. Completed quantity uses the source bucket
          // only (split entries don't count against the source row).
          const splitTotal = splitQtyBySource.get(activityId) ?? 0;
          const sourceQuantity = round2(a.quantity - splitTotal);
          const completedQty = progressBuckets.bySource.get(activityId) ?? 0;

          const mhPerUnit = a.quantity > 0 ? activityTotalMH(a) / a.quantity : 0;
          const craftPerUnit = a.quantity > 0 ? activityCraftMH(a) / a.quantity : 0;
          const weldPerUnit = a.quantity > 0 ? activityWeldMH(a) / a.quantity : 0;

          const totalMH = round2(sourceQuantity * mhPerUnit);
          const craftMH = round2(sourceQuantity * craftPerUnit);
          const weldMH = round2(sourceQuantity * weldPerUnit);
          const earnedMH = round2(completedQty * mhPerUnit);

          const override = overrideMap.get(activityId);
          const isOverridden = !!override?.newOverridePhaseId;
          const originalPhase =
            isOverridden && override?.newOriginalPhaseId
              ? phaseById.get(override.newOriginalPhaseId as string)
              : undefined;

          rows.push({
            id: activityId,
            wbsId: wbs._id as string,
            phaseId: phase._id as string,
            wbsCode,
            phaseCode: phaseDisplayCode(phase),
            size: phase.pipingSpec?.size ?? "",
            flc: phase.pipingSpec?.flc ?? "",
            description: a.description,
            spec: phase.pipingSpec?.spec ?? "",
            insulation: phase.pipingSpec?.insulation ?? "",
            insulationSize: phase.pipingSpec?.insulationSize ?? null,
            sheet: phase.sheet ?? null,
            quantity: sourceQuantity,
            unit: a.unit,
            craftMH,
            weldMH,
            totalMH,
            quantityComplete: completedQty,
            quantityRemaining: Math.max(0, round2(sourceQuantity - completedQty)),
            earnedMH,
            remainingMH: Math.max(0, round2(totalMH - earnedMH)),
            percentComplete: pct(earnedMH, totalMH),
            sortOrder: a.sortOrder,
            isOverridden,
            originalPhaseId:
              isOverridden && override?.newOriginalPhaseId
                ? (override.newOriginalPhaseId as string)
                : undefined,
            originalPhaseCode: originalPhase ? phaseDisplayCode(originalPhase) : undefined,
            source: a.source,
            addedByUserId: a.addedByUserId,
            addedAt: a.addedAt,
            isSplit: false,
          });

          pTotalMH += totalMH;
          pEarnedMH += earnedMH;
          pCraftMH += craftMH;
          pWeldMH += weldMH;
        }

        // Virtual split rows landing in this phase. The source activity
        // may live anywhere — only the slice's quantity belongs here.
        const phaseSplits = (splitsByPhase.get(phase._id as string) ?? [])
          .slice()
          .sort((x, y) => x.createdAt - y.createdAt);

        for (const s of phaseSplits) {
          const sourceActivity = activityById.get(s.sourceActivityId as string);
          if (
            !sourceActivity ||
            sourceActivity.removedAt ||
            !LABOR_TYPES.has(sourceActivity.type)
          ) {
            continue;
          }
          const sourcePhase = phaseById.get(sourceActivity.phaseId as string);
          const splitId = s._id as string;
          const completedQty = progressBuckets.bySplit.get(splitId) ?? 0;

          const mhPerUnit =
            sourceActivity.quantity > 0
              ? activityTotalMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const craftPerUnit =
            sourceActivity.quantity > 0
              ? activityCraftMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const weldPerUnit =
            sourceActivity.quantity > 0
              ? activityWeldMH(sourceActivity) / sourceActivity.quantity
              : 0;

          const totalMH = round2(s.quantity * mhPerUnit);
          const craftMH = round2(s.quantity * craftPerUnit);
          const weldMH = round2(s.quantity * weldPerUnit);
          const earnedMH = round2(completedQty * mhPerUnit);

          rows.push({
            id: splitId,
            wbsId: wbs._id as string,
            phaseId: phase._id as string,
            wbsCode,
            phaseCode: phaseDisplayCode(phase),
            size: phase.pipingSpec?.size ?? "",
            flc: phase.pipingSpec?.flc ?? "",
            description: sourceActivity.description,
            spec: phase.pipingSpec?.spec ?? "",
            insulation: phase.pipingSpec?.insulation ?? "",
            insulationSize: phase.pipingSpec?.insulationSize ?? null,
            sheet: phase.sheet ?? null,
            quantity: s.quantity,
            unit: sourceActivity.unit,
            craftMH,
            weldMH,
            totalMH,
            quantityComplete: completedQty,
            quantityRemaining: Math.max(0, round2(s.quantity - completedQty)),
            earnedMH,
            remainingMH: Math.max(0, round2(totalMH - earnedMH)),
            percentComplete: pct(earnedMH, totalMH),
            // Sort offset keeps split rows after source rows of the same
            // phase; ties resolve by creation order.
            sortOrder: sourceActivity.sortOrder + 1_000_000 + s.createdAt,
            isOverridden: false,
            source: sourceActivity.source,
            isSplit: true,
            splitId,
            sourceActivityId: sourceActivity._id as string,
            sourceDescription: sourceActivity.description,
            sourcePhaseCode: sourcePhase ? phaseDisplayCode(sourcePhase) : undefined,
          });

          pTotalMH += totalMH;
          pEarnedMH += earnedMH;
          pCraftMH += craftMH;
          pWeldMH += weldMH;
        }

        phaseSummaries[phase._id as string] = {
          description: phase.description ?? phaseDisplayCode(phase),
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

      // Include the Change Orders WBS even when empty so the UI can render it at
      // the bottom — but ONLY for full-access users. A scoped foreman must not
      // see Change Orders unless a CO phase is explicitly in their scope (#39).
      if (hasVisiblePhases || (wbs.source === "change_order" && allowedPhaseIds === "all")) {
        wbsSummaries[wbs._id as string] = {
          description: wbs.name,
          code: wbsDisplayCode(wbs),
          totalMH: wbsTotalMH,
          earnedMH: wbsEarnedMH,
          craftMH: wbsCraftMH,
          weldMH: wbsWeldMH,
          percentComplete: pct(wbsEarnedMH, wbsTotalMH),
          source: wbs.source,
        };
      }
    }

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
        workCalendar: project.workCalendar ?? "5x10",
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
      scopeInfo,
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
      .query("momentumActivities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    const weekMap = new Map<string, { totalQuantity: number; totalEarnedMH: number }>();
    const byActivity = new Map<string, Map<string, { quantity: number; earnedMH: number }>>();

    for (const entry of entries) {
      if (!entry.newActivityId) continue;
      const weekEnding = getWeekEndingSunday(entry.entryDate);
      const activity = activityById.get(entry.newActivityId as string);
      if (!activity) continue;

      const earnedMH = activityEarnedMH(activity, entry.quantityCompleted);

      const week = weekMap.get(weekEnding) ?? { totalQuantity: 0, totalEarnedMH: 0 };
      week.totalQuantity += entry.quantityCompleted;
      week.totalEarnedMH += earnedMH;
      weekMap.set(weekEnding, week);

      const actKey = entry.newActivityId as string;
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
      .query("momentumWbs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allPhases = await ctx.db
      .query("momentumPhases")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allActivities = await ctx.db
      .query("momentumActivities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const laborActivities = allActivities.filter((a) => !a.removedAt && LABOR_TYPES.has(a.type));

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    const progressBuckets = buildProgressBuckets(entries);
    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    // Weekly / daily maps keyed by **row id** — splitId for split entries,
    // newActivityId for source entries. Matches the row-id convention used
    // by getBrowseData so the export's row[idx].weeklyQty[week] maps cleanly
    // back to a workbook row.
    const weekSet = new Set<string>();
    const weeklyByRow = new Map<string, Map<string, { qty: number; earnedMH: number }>>();
    const dailyByRow = new Map<string, Record<string, number>>();

    for (const entry of entries) {
      const rowKey = (entry.splitId ?? entry.newActivityId) as string | undefined;
      if (!rowKey) continue;
      const weekEnding = getWeekEndingSunday(entry.entryDate);
      weekSet.add(weekEnding);

      const activity = entry.newActivityId
        ? activityById.get(entry.newActivityId as string)
        : undefined;

      if (!weeklyByRow.has(rowKey)) weeklyByRow.set(rowKey, new Map());
      const w = weeklyByRow.get(rowKey)!.get(weekEnding) ?? { qty: 0, earnedMH: 0 };
      w.qty += entry.quantityCompleted;
      if (activity) w.earnedMH += activityEarnedMH(activity, entry.quantityCompleted);
      weeklyByRow.get(rowKey)!.set(weekEnding, w);

      if (!dailyByRow.has(rowKey)) dailyByRow.set(rowKey, {});
      const actDaily = dailyByRow.get(rowKey)!;
      actDaily[entry.entryDate] = (actDaily[entry.entryDate] ?? 0) + entry.quantityCompleted;
    }

    const weekEndings = [...weekSet].sort();

    // Splits indexed by source and target phase, same as getBrowseData.
    const splits = await ctx.db
      .query("activitySplits")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const splitQtyBySource = buildSplitQuantityMap(splits);
    const splitsByPhase = new Map<string, Doc<"activitySplits">[]>();
    for (const s of splits) {
      const key = s.targetPhaseId as string;
      const list = splitsByPhase.get(key) ?? [];
      list.push(s);
      splitsByPhase.set(key, list);
    }

    const sortedWBS = [...wbsItems].filter((w) => !w.removedAt).sort(compareWbsForDisplay);
    const phasesByWBS = new Map<string, Doc<"momentumPhases">[]>();
    for (const p of allPhases) {
      if (p.removedAt) continue;
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }
    const activitiesByPhase = new Map<string, Doc<"momentumActivities">[]>();
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

      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(comparePhasesForDisplay);

      const wbsRowIndex = rows.length;
      const wbsCode = wbsDisplayCode(wbs);
      rows.push({
        rowType: "wbs",
        id: wbs._id as string,
        wbsCode,
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
        rows.push({
          rowType: "phase",
          id: phase._id as string,
          wbsCode,
          phaseCode: phaseDisplayCode(phase),
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

        // Source rows (with reduced quantity per any active splits).
        for (const a of phaseActs) {
          const activityId = a._id as string;
          const splitTotal = splitQtyBySource.get(activityId) ?? 0;
          const sourceQuantity = round2(a.quantity - splitTotal);
          const completedQty = progressBuckets.bySource.get(activityId) ?? 0;
          const mhPerUnit = a.quantity > 0 ? activityTotalMH(a) / a.quantity : 0;
          const craftPerUnit = a.quantity > 0 ? activityCraftMH(a) / a.quantity : 0;
          const weldPerUnit = a.quantity > 0 ? activityWeldMH(a) / a.quantity : 0;
          const totalMH = round2(sourceQuantity * mhPerUnit);
          const craftMH = round2(sourceQuantity * craftPerUnit);
          const weldMH = round2(sourceQuantity * weldPerUnit);
          const earnedMH = round2(completedQty * mhPerUnit);

          const rowWeeks = weeklyByRow.get(activityId);
          const rowWeeklyQty: Record<string, number> = {};
          const rowWeeklyEarned: Record<string, number> = {};
          if (rowWeeks) {
            for (const [we, data] of rowWeeks) {
              rowWeeklyQty[we] = data.qty;
              rowWeeklyEarned[we] = data.earnedMH;
              pWeeklyQty[we] = (pWeeklyQty[we] ?? 0) + data.qty;
              pWeeklyEarned[we] = (pWeeklyEarned[we] ?? 0) + data.earnedMH;
            }
          }

          rows.push({
            rowType: "detail",
            id: activityId,
            wbsCode,
            phaseCode: phaseDisplayCode(phase),
            description: a.description,
            size: phase.pipingSpec?.size ?? "",
            flc: phase.pipingSpec?.flc ?? "",
            spec: phase.pipingSpec?.spec ?? "",
            insulation: phase.pipingSpec?.insulation ?? "",
            insulationSize: phase.pipingSpec?.insulationSize ?? null,
            sheet: phase.sheet ?? null,
            quantity: sourceQuantity,
            unit: a.unit,
            craftMH,
            weldMH,
            totalMH,
            quantityComplete: completedQty,
            quantityRemaining: Math.max(0, round2(sourceQuantity - completedQty)),
            earnedMH,
            remainingMH: Math.max(0, round2(totalMH - earnedMH)),
            percentComplete: pct(earnedMH, totalMH),
            weeklyQty: rowWeeklyQty,
            weeklyEarnedMH: rowWeeklyEarned,
            dailyQty: dailyByRow.get(activityId) ?? {},
          });

          pTotalMH += totalMH;
          pEarnedMH += earnedMH;
          pCraftMH += craftMH;
          pWeldMH += weldMH;
        }

        // Virtual split rows landing in this phase.
        const phaseSplits = (splitsByPhase.get(phase._id as string) ?? [])
          .slice()
          .sort((x, y) => x.createdAt - y.createdAt);
        for (const s of phaseSplits) {
          const sourceActivity = activityById.get(s.sourceActivityId as string);
          if (
            !sourceActivity ||
            sourceActivity.removedAt ||
            !LABOR_TYPES.has(sourceActivity.type)
          ) {
            continue;
          }
          const splitId = s._id as string;
          const completedQty = progressBuckets.bySplit.get(splitId) ?? 0;
          const mhPerUnit =
            sourceActivity.quantity > 0
              ? activityTotalMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const craftPerUnit =
            sourceActivity.quantity > 0
              ? activityCraftMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const weldPerUnit =
            sourceActivity.quantity > 0
              ? activityWeldMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const totalMH = round2(s.quantity * mhPerUnit);
          const craftMH = round2(s.quantity * craftPerUnit);
          const weldMH = round2(s.quantity * weldPerUnit);
          const earnedMH = round2(completedQty * mhPerUnit);

          const rowWeeks = weeklyByRow.get(splitId);
          const rowWeeklyQty: Record<string, number> = {};
          const rowWeeklyEarned: Record<string, number> = {};
          if (rowWeeks) {
            for (const [we, data] of rowWeeks) {
              rowWeeklyQty[we] = data.qty;
              rowWeeklyEarned[we] = data.earnedMH;
              pWeeklyQty[we] = (pWeeklyQty[we] ?? 0) + data.qty;
              pWeeklyEarned[we] = (pWeeklyEarned[we] ?? 0) + data.earnedMH;
            }
          }

          rows.push({
            rowType: "detail",
            id: splitId,
            wbsCode,
            phaseCode: phaseDisplayCode(phase),
            description: sourceActivity.description,
            size: phase.pipingSpec?.size ?? "",
            flc: phase.pipingSpec?.flc ?? "",
            spec: phase.pipingSpec?.spec ?? "",
            insulation: phase.pipingSpec?.insulation ?? "",
            insulationSize: phase.pipingSpec?.insulationSize ?? null,
            sheet: phase.sheet ?? null,
            quantity: s.quantity,
            unit: sourceActivity.unit,
            craftMH,
            weldMH,
            totalMH,
            quantityComplete: completedQty,
            quantityRemaining: Math.max(0, round2(s.quantity - completedQty)),
            earnedMH,
            remainingMH: Math.max(0, round2(totalMH - earnedMH)),
            percentComplete: pct(earnedMH, totalMH),
            weeklyQty: rowWeeklyQty,
            weeklyEarnedMH: rowWeeklyEarned,
            dailyQty: dailyByRow.get(splitId) ?? {},
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
        rows[phaseRowIndex]!.remainingMH = Math.max(0, round2(pTotalMH - pEarnedMH));
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
      rows[wbsRowIndex]!.remainingMH = Math.max(0, round2(wbsTotalMH - wbsEarnedMH));
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
        workCalendar: project.workCalendar ?? "5x10",
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
      .withIndex("by_project_new_activity", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(limit + 1);

    const hasMore = entries.length > limit;
    const trimmed = hasMore ? entries.slice(0, limit) : entries;

    // Batch-fetch Momentum activities + their phases (one round-trip per id).
    const activityIds = [
      ...new Set(
        trimmed
          .map((e) => e.newActivityId as Id<"momentumActivities"> | undefined)
          .filter((id): id is Id<"momentumActivities"> => !!id)
      ),
    ];
    const activityMap = new Map<string, Doc<"momentumActivities">>();
    for (const id of activityIds) {
      const activity = await ctx.db.get(id);
      if (activity) activityMap.set(id as string, activity);
    }

    // Resolve the phase code from the entry's own denormalized phase
    // (`newPhaseId`) rather than the activity's home phase — split entries
    // and overridden entries both rewrite phaseId to their target, so this
    // reflects where the work was logged, not where the estimator placed
    // the activity.
    const entryPhaseIds = [
      ...new Set(
        trimmed
          .map((e) => e.newPhaseId as Id<"momentumPhases"> | undefined)
          .filter((id): id is Id<"momentumPhases"> => !!id)
      ),
    ];
    const phaseMap = new Map<string, Doc<"momentumPhases">>();
    for (const id of entryPhaseIds) {
      const phase = await ctx.db.get(id);
      if (phase) phaseMap.set(id as string, phase);
    }

    const dateMap = new Map<
      string,
      {
        totalQuantity: number;
        entries: Array<{
          activityId: string;
          activityDescription: string;
          unit: string;
          quantityCompleted: number;
          phaseCode: string;
          enteredBy?: string;
          notes?: string;
        }>;
      }
    >();

    for (const entry of trimmed) {
      const activityId = entry.newActivityId as string | undefined;
      if (!activityId) continue;
      const activity = activityMap.get(activityId);
      const phase = entry.newPhaseId ? phaseMap.get(entry.newPhaseId as string) : undefined;
      const group = dateMap.get(entry.entryDate) ?? { totalQuantity: 0, entries: [] };

      group.totalQuantity += entry.quantityCompleted;
      group.entries.push({
        activityId,
        activityDescription: activity?.description ?? "Unknown activity",
        unit: activity?.unit ?? "",
        quantityCompleted: entry.quantityCompleted,
        phaseCode: phase ? phaseDisplayCode(phase) : "",
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
      .query("momentumWbs")
      .withIndex("by_project_sort", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allPhases = await ctx.db
      .query("momentumPhases")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allActivities = await ctx.db
      .query("momentumActivities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const laborActivities = allActivities.filter((a) => !a.removedAt && LABOR_TYPES.has(a.type));

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) => q.eq("projectId", args.projectId))
      .collect();

    const progressBuckets = buildProgressBuckets(entries);

    // Splits — same shape as getBrowseData. Splits contribute to the
    // target phase's totals, while the source phase's total is reduced
    // by the split's quantity-derived MH.
    const splits = await ctx.db
      .query("activitySplits")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const splitQtyBySource = buildSplitQuantityMap(splits);
    const splitsByPhase = new Map<string, Doc<"activitySplits">[]>();
    for (const s of splits) {
      const key = s.targetPhaseId as string;
      const list = splitsByPhase.get(key) ?? [];
      list.push(s);
      splitsByPhase.set(key, list);
    }
    const activityById = new Map(allActivities.map((a) => [a._id as string, a]));

    const activitiesByPhase = new Map<string, Doc<"momentumActivities">[]>();
    for (const a of laborActivities) {
      const key = a.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(a);
      activitiesByPhase.set(key, list);
    }

    const phasesByWBS = new Map<string, Doc<"momentumPhases">[]>();
    for (const p of allPhases) {
      if (p.removedAt) continue;
      const key = p.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(p);
      phasesByWBS.set(key, list);
    }

    const sortedWBS = [...wbsItems].filter((w) => !w.removedAt).sort(compareWbsForDisplay);

    let projectTotalMH = 0;
    let projectEarnedMH = 0;
    let projectCraftMH = 0;
    let projectWeldMH = 0;

    const wbsResults = sortedWBS.map((wbs) => {
      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(comparePhasesForDisplay);

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
        let pActivityCount = 0;

        // Source rows (with budget reduced by their splits).
        for (const a of phaseActs) {
          const activityId = a._id as string;
          const splitTotal = splitQtyBySource.get(activityId) ?? 0;
          const sourceQuantity = round2(a.quantity - splitTotal);
          const completedQty = progressBuckets.bySource.get(activityId) ?? 0;
          const mhPerUnit = a.quantity > 0 ? activityTotalMH(a) / a.quantity : 0;
          const craftPerUnit = a.quantity > 0 ? activityCraftMH(a) / a.quantity : 0;
          const weldPerUnit = a.quantity > 0 ? activityWeldMH(a) / a.quantity : 0;
          pTotalMH += round2(sourceQuantity * mhPerUnit);
          pCraftMH += round2(sourceQuantity * craftPerUnit);
          pWeldMH += round2(sourceQuantity * weldPerUnit);
          pEarnedMH += round2(completedQty * mhPerUnit);
          pActivityCount++;
        }

        // Split rows that landed in this phase contribute to *this* phase's
        // totals, not their source phase's.
        const phaseSplits = splitsByPhase.get(phase._id as string) ?? [];
        for (const s of phaseSplits) {
          const sourceActivity = activityById.get(s.sourceActivityId as string);
          if (
            !sourceActivity ||
            sourceActivity.removedAt ||
            !LABOR_TYPES.has(sourceActivity.type)
          ) {
            continue;
          }
          const completedQty = progressBuckets.bySplit.get(s._id as string) ?? 0;
          const mhPerUnit =
            sourceActivity.quantity > 0
              ? activityTotalMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const craftPerUnit =
            sourceActivity.quantity > 0
              ? activityCraftMH(sourceActivity) / sourceActivity.quantity
              : 0;
          const weldPerUnit =
            sourceActivity.quantity > 0
              ? activityWeldMH(sourceActivity) / sourceActivity.quantity
              : 0;
          pTotalMH += round2(s.quantity * mhPerUnit);
          pCraftMH += round2(s.quantity * craftPerUnit);
          pWeldMH += round2(s.quantity * weldPerUnit);
          pEarnedMH += round2(completedQty * mhPerUnit);
          pActivityCount++;
        }

        wbsTotalMH += pTotalMH;
        wbsEarnedMH += pEarnedMH;
        wbsCraftMH += pCraftMH;
        wbsWeldMH += pWeldMH;

        const phasePercent = pct(pEarnedMH, pTotalMH);
        return {
          id: phase._id as string,
          code: phaseDisplayCode(phase),
          description: phase.description ?? phaseDisplayCode(phase),
          activityCount: pActivityCount,
          totalMH: pTotalMH,
          craftMH: pCraftMH,
          weldMH: pWeldMH,
          earnedMH: pEarnedMH,
          remainingMH: Math.max(0, round2(pTotalMH - pEarnedMH)),
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
        code: wbsDisplayCode(wbs),
        description: wbs.name,
        totalMH: wbsTotalMH,
        craftMH: wbsCraftMH,
        weldMH: wbsWeldMH,
        earnedMH: wbsEarnedMH,
        remainingMH: Math.max(0, round2(wbsTotalMH - wbsEarnedMH)),
        percentComplete: wbsPercent,
        status: statusFromPercent(wbsPercent),
        source: wbs.source,
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
        workCalendar: project.workCalendar ?? "5x10",
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

    // How many Momentum projects already exist per proposal. Estimates with a
    // count > 0 are hidden from the New Project list by default; the dialog can
    // reveal them so a user can deliberately spin up a revision/copy.
    const projectCounts = new Map<string, number>();
    for (const mp of momentumProjects) {
      const pid = mp.proposalId as string;
      projectCounts.set(pid, (projectCounts.get(pid) ?? 0) + 1);
    }

    return proposals.map((p) => ({
      id: p._id as string,
      proposalNumber: p.proposalNumber,
      description: p.description,
      ownerName: p.ownerName,
      jobNumber: p.jobNumber ?? "",
      location: p.jobSiteAddress ?? "",
      status: p.status ?? "open",
      existingProjectCount: projectCounts.get(p._id as string) ?? 0,
    }));
  },
});

/**
 * Return the labor pool entries available to a Momentum phase.
 *
 * For estimate phases this filters by the phase's `sourcePhasePoolId` so
 * the dialog only shows labor items relevant to that phase type — matching
 * Precision's behavior. For change-order phases the filter is dropped: the
 * user can pick any labor item at the project's dataset version, since
 * change orders aren't tied to an estimate phase type.
 *
 * Defaults the project's `datasetVersion` to `"v1"` if it hasn't been
 * snapshotted yet (legacy projects pre-backfill), then falls back to v1
 * data when the requested version returns empty — mirroring the Precision
 * query.
 */
/**
 * Phase pool (available phase types) for a WBS — powers the Add Phase dialog's
 * "From catalog" mode. Returns the WBS's catalog entries (code + name) ordered
 * by code. Empty for the Change Orders WBS, which has no estimate pool ancestor.
 */
export const getPhasePoolForWbs = query({
  args: { wbsId: v.id("momentumWbs") },
  handler: async (ctx, args) => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs || wbs.sourceWbsPoolId === undefined) return [];
    const project = await ctx.db.get(wbs.projectId);
    const version = project?.datasetVersion ?? "v1";
    const types = await ctx.db
      .query("phasePool")
      .withIndex("by_version_wbs_active", (q) =>
        q.eq("datasetVersion", version).eq("wbsPoolId", wbs.sourceWbsPoolId!).eq("isActive", true)
      )
      .collect();
    return types
      .sort((a, b) => a.poolId - b.poolId)
      .map((t) => ({ poolId: t.poolId, name: t.name }));
  },
});

/**
 * Map of userId → display name for everyone who added an activity in this
 * project. Powers the admin provenance tooltip's "Added by …" attribution
 * without resolving Better Auth users per row in the workbook hot path.
 */
export const getProjectContributors = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const activities = await ctx.db
      .query("momentumActivities")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const userIds = new Set<string>();
    for (const a of activities) {
      if (!a.removedAt && a.addedByUserId) userIds.add(a.addedByUserId);
    }

    const result: Record<string, string> = {};
    for (const userId of userIds) {
      try {
        const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", value: userId }],
        })) as { name?: string; email?: string } | null;
        if (user) result[userId] = user.name || user.email || "Unknown";
      } catch {
        // Unresolvable user — tooltip falls back to a generic label.
      }
    }
    return result;
  },
});

export const getLaborPoolForProject = query({
  args: {
    projectId: v.id("momentumProjects"),
    phaseId: v.id("momentumPhases"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found.");

    const version = project.datasetVersion ?? "v1";

    /** All active labor for a dataset version. */
    const allLaborForVersion = (ver: "v1" | "v2") =>
      ctx.db
        .query("laborPool")
        .withIndex("by_version", (q) => q.eq("datasetVersion", ver))
        .filter((q) => q.eq(q.field("isActive"), true))
        .collect();

    // ── Case 1: phase anchored to a phasePool type → that type's curated labor.
    if (phase.sourcePhasePoolId !== undefined) {
      const byType = (ver: "v1" | "v2") =>
        ctx.db
          .query("laborPool")
          .withIndex("by_version_phase_active", (q) =>
            q
              .eq("datasetVersion", ver)
              .eq("phasePoolId", phase.sourcePhasePoolId!)
              .eq("isActive", true)
          )
          .collect();
      const results = await byType(version);
      if (results.length > 0 || version === "v1") return results;
      return byType("v1");
    }

    // ── Case 2: custom phase under an estimate WBS → labor scoped to the WBS.
    // A WBS is a bundle of phasePool types, so "labor for the WBS" is the union
    // of every type's labor under it. Keeps Add Activity relevant for a
    // free-form phase that has no single type, instead of dumping the whole
    // catalog.
    const wbs = await ctx.db.get(phase.wbsId);
    if (wbs?.sourceWbsPoolId !== undefined) {
      const typesForWbs = (ver: "v1" | "v2") =>
        ctx.db
          .query("phasePool")
          .withIndex("by_version_wbs_active", (q) =>
            q.eq("datasetVersion", ver).eq("wbsPoolId", wbs.sourceWbsPoolId!).eq("isActive", true)
          )
          .collect();
      let poolTypes = await typesForWbs(version);
      let effectiveVersion = version;
      if (poolTypes.length === 0 && version !== "v1") {
        poolTypes = await typesForWbs("v1");
        effectiveVersion = "v1";
      }
      const poolIds = new Set(poolTypes.map((p) => p.poolId));
      const labor = await allLaborForVersion(effectiveVersion);
      return labor.filter((l) => poolIds.has(l.phasePoolId));
    }

    // ── Case 3: change order / no WBS pool → full active catalog.
    const results = await allLaborForVersion(version);
    if (results.length > 0 || version === "v1") return results;
    return allLaborForVersion("v1");
  },
});

/**
 * Return the equipment pool entries available to a Momentum project at its
 * dataset version. Equipment isn't phase-scoped so a project-level query
 * is sufficient. Falls back to v1 if the requested version is empty.
 */
export const getEquipmentPoolForProject = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const version = project.datasetVersion ?? "v1";
    const results = await ctx.db
      .query("equipmentPool")
      .withIndex("by_version_active", (q) => q.eq("datasetVersion", version).eq("isActive", true))
      .collect();
    if (results.length > 0 || version === "v1") return results;
    return ctx.db
      .query("equipmentPool")
      .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
      .collect();
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a Momentum project as a deep-copy snapshot of a Precision proposal.
 *
 * WHY snapshot: Momentum and Precision are bounded contexts. Once a project
 * starts in the field, the estimate should not shift underneath it. The deep
 * copy freezes wbs/phases/activities into Momentum-owned tables and snapshots
 * the proposal's rates and dataset version onto the project row, so all of
 * Momentum's downstream math is self-contained.
 *
 * Each copied row stamps a `source*` ID pointing back at its estimate
 * ancestor. These pointers are dormant in v1 but enable a future
 * "Sync from estimate" diff/merge flow with no additional migration.
 *
 * Also seeds a Change Orders WBS at the bottom of the new project with a
 * default "Change Order 1" phase, so field teams can capture out-of-scope
 * work without ever writing back to Precision's tables.
 *
 * By default this is one-project-per-proposal: it throws if a project already
 * exists, guarding against accidental duplicates. Pass `allowDuplicate` to
 * deliberately create a revision/copy — the new project's name is suffixed
 * `(Copy)`, `(Copy 2)`, … so the snapshots stay distinguishable.
 */
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
    // Opt-in escape hatch for creating a second+ project from the same estimate.
    allowDuplicate: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"momentumProjects">> => {
    const existingForProposal = await ctx.db
      .query("momentumProjects")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    if (existingForProposal.length > 0 && !args.allowDuplicate) {
      throw new Error("A momentum project already exists for this proposal.");
    }

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) {
      throw new Error("Proposal not found.");
    }

    // Distinguish revision copies: the first project keeps the bare name, the
    // Nth (N>1) is suffixed so a list of same-estimate projects stays legible.
    const copyIndex = existingForProposal.length;
    const baseName = `${proposal.proposalNumber} - ${proposal.description}`;
    const projectName =
      copyIndex === 0 ? baseName : `${baseName} (Copy${copyIndex > 1 ? ` ${copyIndex}` : ""})`;

    // Guard: a Firestore-sourced proposal must have its estimate tree imported
    // before we can snapshot it. The daily sync only refreshes the proposals
    // list; trees are pulled on demand by `createProjectFromProposal`. Calling
    // this mutation directly (older app builds) on a not-yet-imported proposal
    // would otherwise produce an empty project — fail loudly instead.
    if (proposal.firestoreId) {
      const hasTree = await ctx.db
        .query("wbs")
        .withIndex("by_proposal", (q) => q.eq("proposalId", proposal._id))
        .first();
      if (!hasTree) {
        throw new Error(
          "This estimate hasn't been imported yet — update Momentum to the latest version to create this project."
        );
      }
    }

    const now = Date.now();

    const projectId = await ctx.db.insert("momentumProjects", {
      proposalId: args.proposalId,
      name: projectName,
      proposalNumber: proposal.proposalNumber,
      projectNumber: deriveProjectNumber(projectName, proposal.proposalNumber),
      jobNumber: proposal.jobNumber ?? undefined,
      ownerName: proposal.ownerName,
      location: proposal.jobSiteAddress ?? undefined,
      description: proposal.description,
      status: args.status ?? "active",
      actualStartDate: proposal.projectStartDate ?? undefined,
      projectedEndDate: proposal.projectEndDate ?? undefined,

      // Frozen snapshot — Precision edits never leak in
      datasetVersion: proposal.datasetVersion,
      rates: proposal.rates,
      proposalSyncedAt: now,
    });

    await snapshotProposalIntoProject(ctx, projectId, args.proposalId);

    return projectId;
  },
});

/** Proposal fields needed to drive the on-demand import (tree pull + UI). */
export const getProposalImportInfo = internalQuery({
  args: { proposalId: v.id("proposals") },
  handler: async (
    ctx,
    args
  ): Promise<{
    firestoreId: string | null;
    proposalNumber: string;
    description: string;
  } | null> => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) return null;
    return {
      firestoreId: proposal.firestoreId ?? null,
      proposalNumber: proposal.proposalNumber,
      description: proposal.description,
    };
  },
});

/**
 * Create a Momentum project from a proposal, pulling that proposal's latest
 * tree from Firestore first.
 *
 * WHY an action: the daily sync keeps only the proposals *list* fresh (cheap);
 * a proposal's full wbs/phase/activity tree is fetched on demand here so the
 * snapshot reflects the current estimate. Mutations can't `fetch()`, so the
 * create flow is an action — pull the tree, then run `createProject`. Proposals
 * with no Firestore id (e.g. Precision-native) already have their tree in
 * Convex, so the pull is skipped.
 *
 * When the client supplies an `importToken`, the action narrates its progress
 * into `momentumImportJobs` so the New Project dialog can render a live
 * importing indicator — the tree pull is slow for large estimates, so the user
 * gets staged feedback instead of a frozen spinner.
 */
export const createProjectFromProposal = action({
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
    // Opt-in: allow creating a project from an already-imported estimate.
    allowDuplicate: v.optional(v.boolean()),
    // Client-generated id linking this run to a live progress subscription.
    importToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"momentumProjects">> => {
    const token = args.importToken;
    const info = await ctx.runQuery(internal.momentum.getProposalImportInfo, {
      proposalId: args.proposalId,
    });

    if (token && info) {
      await ctx.runMutation(internal.momentum.createImportJob, {
        token,
        proposalId: args.proposalId,
        proposalNumber: info.proposalNumber,
        proposalDescription: info.description,
      });
    }

    try {
      if (info?.firestoreId) {
        if (token) {
          await ctx.runMutation(internal.momentum.updateImportJob, {
            token,
            status: "fetching",
            stage: "Pulling estimate from Precision",
          });
        }
        await ctx.runAction(internal.sync.syncEngine.syncProposalTree, {
          proposalFsId: info.firestoreId,
          importToken: token,
        });
      }

      if (token) {
        await ctx.runMutation(internal.momentum.updateImportJob, {
          token,
          status: "finalizing",
          stage: "Building your workbook",
        });
      }

      const projectId = await ctx.runMutation(api.momentum.createProject, {
        proposalId: args.proposalId,
        status: args.status,
        allowDuplicate: args.allowDuplicate,
      });

      if (token) {
        await ctx.runMutation(internal.momentum.updateImportJob, {
          token,
          status: "completed",
          stage: "Done",
          projectId,
        });
      }

      return projectId;
    } catch (error) {
      if (token) {
        await ctx.runMutation(internal.momentum.updateImportJob, {
          token,
          status: "error",
          stage: "Import failed",
          error: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
      throw error;
    }
  },
});

// ============================================================================
// IMPORT PROGRESS (on-demand estimate pull)
// ============================================================================

/** Retain import-job rows for an hour before they're eligible for pruning. */
const IMPORT_JOB_TTL_MS = 60 * 60 * 1000;

/**
 * Create (or reset) the import-progress row for a create-project run, and prune
 * stale rows so the table never accumulates. Keyed by the client's token.
 */
export const createImportJob = internalMutation({
  args: {
    token: v.string(),
    proposalId: v.id("proposals"),
    proposalNumber: v.string(),
    proposalDescription: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Opportunistic cleanup — drop finished rows older than the TTL.
    const stale = await ctx.db
      .query("momentumImportJobs")
      .filter((q) => q.lt(q.field("updatedAt"), now - IMPORT_JOB_TTL_MS))
      .collect();
    for (const row of stale) await ctx.db.delete(row._id);

    // Replace any prior row for this token (retry on the same dialog session).
    const prior = await ctx.db
      .query("momentumImportJobs")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (prior) await ctx.db.delete(prior._id);

    await ctx.db.insert("momentumImportJobs", {
      token: args.token,
      proposalId: args.proposalId,
      proposalNumber: args.proposalNumber,
      proposalDescription: args.proposalDescription,
      status: "preparing",
      stage: "Preparing import",
      wbsCount: 0,
      phaseCount: 0,
      activityCount: 0,
      processed: 0,
      total: 0,
      startedAt: now,
      updatedAt: now,
    });
  },
});

/** Patch an import-job row by token. No-op if the row was already pruned. */
export const updateImportJob = internalMutation({
  args: {
    token: v.string(),
    status: v.optional(
      v.union(
        v.literal("preparing"),
        v.literal("fetching"),
        v.literal("importing"),
        v.literal("finalizing"),
        v.literal("completed"),
        v.literal("error")
      )
    ),
    stage: v.optional(v.string()),
    wbsCount: v.optional(v.number()),
    phaseCount: v.optional(v.number()),
    activityCount: v.optional(v.number()),
    processed: v.optional(v.number()),
    total: v.optional(v.number()),
    projectId: v.optional(v.id("momentumProjects")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("momentumImportJobs")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!job) return;

    const { token: _token, ...patch } = args;
    await ctx.db.patch(job._id, { ...patch, updatedAt: Date.now() });
  },
});

/** Live import-progress for the New Project dialog. Null until the job starts. */
export const getImportJob = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("momentumImportJobs")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
  },
});

/**
 * Deep-copy a proposal's WBS / phases / activities into a Momentum project
 * and append the Change Orders WBS. Shared by `createProject` and by
 * `backfillMomentumSnapshots` so the import logic stays in one place.
 *
 * Returns the ID maps it built — used by the backfill to remap legacy
 * `progressEntries` / `activityPhaseOverrides` / `projectAssignments`.
 */
async function snapshotProposalIntoProject(
  ctx: MutationCtx,
  projectId: Id<"momentumProjects">,
  proposalId: Id<"proposals">
): Promise<{
  wbsMap: Map<Id<"wbs">, Id<"momentumWbs">>;
  phaseMap: Map<Id<"phases">, Id<"momentumPhases">>;
  activityMap: Map<Id<"activities">, Id<"momentumActivities">>;
}> {
  const wbsRows = await ctx.db
    .query("wbs")
    .withIndex("by_proposal_sort", (q) => q.eq("proposalId", proposalId))
    .collect();

  const wbsMap = new Map<Id<"wbs">, Id<"momentumWbs">>();
  let maxWbsSort = 0;
  for (const row of wbsRows) {
    const newId = await ctx.db.insert("momentumWbs", {
      projectId,
      sourceWbsId: row._id,
      sourceWbsPoolId: row.wbsPoolId,
      name: row.name,
      sortOrder: row.sortOrder,
      source: "estimate",
      customQuantity: row.customQuantity,
      customUnit: row.customUnit,
    });
    wbsMap.set(row._id, newId);
    if (row.sortOrder > maxWbsSort) maxWbsSort = row.sortOrder;
  }

  const phaseRows = await ctx.db
    .query("phases")
    .withIndex("by_proposal_sort", (q) => q.eq("proposalId", proposalId))
    .collect();

  const phaseMap = new Map<Id<"phases">, Id<"momentumPhases">>();
  for (const row of phaseRows) {
    const newWbsId = wbsMap.get(row.wbsId);
    if (!newWbsId) {
      // Orphan phase whose WBS wasn't in the proposal — skip and let
      // verification surface it. Shouldn't happen with healthy data.
      continue;
    }
    const newId = await ctx.db.insert("momentumPhases", {
      projectId,
      wbsId: newWbsId,
      sourcePhaseId: row._id,
      sourcePhasePoolId: row.phasePoolId,
      poolName: row.poolName,
      phaseNumber: row.phaseNumber,
      description: row.description,
      area: row.area,
      sheet: row.sheet,
      pipingSpec: row.pipingSpec,
      status: row.status,
      isCompleted: row.isCompleted,
      sortOrder: row.sortOrder,
      customQuantity: row.customQuantity,
      customUnit: row.customUnit,
      source: "estimate",
    });
    phaseMap.set(row._id, newId);
  }

  const activityRows = await ctx.db
    .query("activities")
    .withIndex("by_proposal", (q) => q.eq("proposalId", proposalId))
    .collect();

  const activityMap = new Map<Id<"activities">, Id<"momentumActivities">>();
  for (const row of activityRows) {
    const newWbsId = wbsMap.get(row.wbsId);
    const newPhaseId = phaseMap.get(row.phaseId);
    if (!newWbsId || !newPhaseId) continue;
    const newId = await ctx.db.insert("momentumActivities", {
      projectId,
      wbsId: newWbsId,
      phaseId: newPhaseId,
      sourceActivityId: row._id,
      type: row.type,
      description: row.description,
      quantity: row.quantity,
      unit: row.unit,
      sortOrder: row.sortOrder,
      laborPoolId: row.laborPoolId,
      equipmentPoolId: row.equipmentPoolId,
      labor: row.labor,
      equipment: row.equipment,
      subcontractor: row.subcontractor,
      unitPrice: row.unitPrice,
      source: "estimate",
    });
    activityMap.set(row._id, newId);
  }

  // Append Change Orders WBS at the bottom + default phase. Names are ALL CAPS
  // to match the MCP-sourced WBS/phase convention (#35).
  const changeOrdersWbsId = await ctx.db.insert("momentumWbs", {
    projectId,
    name: "CHANGE ORDERS",
    sortOrder: maxWbsSort + 1,
    source: "change_order",
  });

  await ctx.db.insert("momentumPhases", {
    projectId,
    wbsId: changeOrdersWbsId,
    poolName: "CHANGE ORDER",
    phaseNumber: 1,
    phaseCode: `${CHANGE_ORDERS_WBS_CODE}-001`,
    description: "CHANGE ORDER 1",
    isCompleted: false,
    sortOrder: 1,
    source: "change_order",
  });

  return { wbsMap, phaseMap, activityMap };
}

// ============================================================================
// BACKFILL & VERIFY (one-shot migration to Momentum-owned snapshot tables)
// ============================================================================

/**
 * Migrate existing Momentum projects to the new bounded-context architecture.
 *
 * Idempotent per project: a project that already has `momentumWbs` rows is
 * skipped. Run repeatedly without harm. Designed to be called from the
 * Convex dashboard; `dryRun: true` reports what *would* happen without
 * writing.
 *
 * For each unmigrated project this:
 *   1. Patches `momentumProjects` with the proposal's `datasetVersion`/`rates`
 *      snapshot and a `proposalSyncedAt` timestamp.
 *   2. Deep-copies the proposal's WBS / phases / activities into the new
 *      tables via `snapshotProposalIntoProject`.
 *   3. Populates the bridge columns (`newActivityId`, `newWbsId`,
 *      `newPhaseId`) on `progressEntries`, `activityPhaseOverrides`, and
 *      `projectAssignments` using the in-memory ID map from the copy.
 *   4. Appends the Change Orders WBS + default "Change Order 1" phase.
 *
 * `limit` caps how many projects one invocation processes so a single
 * mutation stays well below Convex's per-call write budget — large
 * deployments call this repeatedly until `report.migrated === 0`.
 */
type PerProjectReport = {
  projectId: Id<"momentumProjects">;
  projectName: string;
  status: "already_migrated" | "missing_proposal" | "migrated" | "would_migrate";
  sourceCounts?: { wbs: number; phases: number; activities: number };
  remapped?: {
    progressEntries: number;
    progressEntriesOrphaned: number;
    overrides: number;
    overridesOrphaned: number;
    assignments: number;
    assignmentsOrphaned: number;
  };
};

/**
 * Internal — list candidate Momentum projects for migration.
 * Used by the `backfillMomentumSnapshots` action which iterates per-project.
 */
export const _listMigrationCandidates = internalQuery({
  args: { projectId: v.optional(v.id("momentumProjects")) },
  handler: async (ctx, args) => {
    if (args.projectId) {
      const p = await ctx.db.get(args.projectId);
      return p ? [{ _id: p._id, name: p.name }] : [];
    }
    const all = await ctx.db.query("momentumProjects").collect();
    return all.map((p) => ({ _id: p._id, name: p.name }));
  },
});

/**
 * Internal — perform the migration for a single project (or dry-run it).
 *
 * Stays well under Convex's 1-second / 16k-write per-mutation budget for any
 * realistic project size. The outer action invokes this once per project so
 * the overall migration scales linearly without blowing past per-mutation
 * limits.
 */
export const _backfillSingleProject = internalMutation({
  args: {
    projectId: v.id("momentumProjects"),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args): Promise<PerProjectReport> => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      return {
        projectId: args.projectId,
        projectName: "(missing)",
        status: "missing_proposal",
      };
    }

    const existingWbs = await ctx.db
      .query("momentumWbs")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .first();
    if (existingWbs) {
      return {
        projectId: project._id,
        projectName: project.name,
        status: "already_migrated",
      };
    }

    const proposal = await ctx.db.get(project.proposalId);
    if (!proposal) {
      return {
        projectId: project._id,
        projectName: project.name,
        status: "missing_proposal",
      };
    }

    if (args.dryRun) {
      const [sourceWbs, sourcePhases, sourceActivities] = await Promise.all([
        ctx.db
          .query("wbs")
          .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
          .collect(),
        ctx.db
          .query("phases")
          .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
          .collect(),
        ctx.db
          .query("activities")
          .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
          .collect(),
      ]);
      return {
        projectId: project._id,
        projectName: project.name,
        status: "would_migrate",
        sourceCounts: {
          wbs: sourceWbs.length,
          phases: sourcePhases.length,
          activities: sourceActivities.length,
        },
      };
    }

    await ctx.db.patch(project._id, {
      datasetVersion: proposal.datasetVersion,
      rates: proposal.rates,
      proposalSyncedAt: Date.now(),
    });

    const { wbsMap, phaseMap, activityMap } = await snapshotProposalIntoProject(
      ctx,
      project._id,
      project.proposalId
    );

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_activity", (q) => q.eq("projectId", project._id))
      .collect();
    let remappedEntries = 0;
    let orphanedEntries = 0;
    for (const entry of entries) {
      if (!entry.activityId || !entry.wbsId || !entry.phaseId) continue;
      const newActivityId = activityMap.get(entry.activityId);
      const newWbsId = wbsMap.get(entry.wbsId);
      const newPhaseId = phaseMap.get(entry.phaseId);
      if (!newActivityId || !newWbsId || !newPhaseId) {
        orphanedEntries++;
        continue;
      }
      await ctx.db.patch(entry._id, { newActivityId, newWbsId, newPhaseId });
      remappedEntries++;
    }

    const overrides = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    let remappedOverrides = 0;
    let orphanedOverrides = 0;
    for (const ov of overrides) {
      if (!ov.activityId || !ov.overridePhaseId || !ov.originalPhaseId || !ov.originalWbsId) {
        continue;
      }
      const newActivityId = activityMap.get(ov.activityId);
      const newOverridePhaseId = phaseMap.get(ov.overridePhaseId);
      const newOriginalPhaseId = phaseMap.get(ov.originalPhaseId);
      const newOriginalWbsId = wbsMap.get(ov.originalWbsId);
      if (!newActivityId || !newOverridePhaseId || !newOriginalPhaseId || !newOriginalWbsId) {
        orphanedOverrides++;
        continue;
      }
      await ctx.db.patch(ov._id, {
        newActivityId,
        newOverridePhaseId,
        newOriginalPhaseId,
        newOriginalWbsId,
      });
      remappedOverrides++;
    }

    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    let remappedAssignments = 0;
    let orphanedAssignments = 0;
    for (const a of assignments) {
      if (a.scopeType === "project" || !a.scopeId) continue;
      let newScopeId: Id<"momentumWbs"> | Id<"momentumPhases"> | undefined;
      if (a.scopeType === "wbs") {
        newScopeId = wbsMap.get(a.scopeId as Id<"wbs">);
      } else if (a.scopeType === "phase") {
        newScopeId = phaseMap.get(a.scopeId as Id<"phases">);
      }
      if (newScopeId) {
        await ctx.db.patch(a._id, { newScopeId: newScopeId as string });
        remappedAssignments++;
      } else {
        orphanedAssignments++;
      }
    }

    return {
      projectId: project._id,
      projectName: project.name,
      status: "migrated",
      remapped: {
        progressEntries: remappedEntries,
        progressEntriesOrphaned: orphanedEntries,
        overrides: remappedOverrides,
        overridesOrphaned: orphanedOverrides,
        assignments: remappedAssignments,
        assignmentsOrphaned: orphanedAssignments,
      },
    };
  },
});

/**
 * Migrate existing Momentum projects to the new bounded-context architecture.
 *
 * Runs as an action so the migration can call a separate transactional
 * mutation per project (each well below Convex's 1-second / 16k-write per-
 * mutation budget). The action itself has up to 10 minutes — plenty for any
 * realistic project count.
 *
 * Idempotent: projects with existing `momentumWbs` rows are skipped.
 * Set `dryRun: true` to see counts without writing anything.
 * `limit` caps how many projects this action processes in a single run.
 */
export const backfillMomentumSnapshots = action({
  args: {
    dryRun: v.optional(v.boolean()),
    projectId: v.optional(v.id("momentumProjects")),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    limit: number;
    scannedProjects: number;
    alreadyMigrated: number;
    missingProposal: number;
    migrated: number;
    remaining: number;
    perProject: PerProjectReport[];
  }> => {
    const dryRun = args.dryRun ?? false;
    const limit = args.limit ?? 1000;

    const candidates = await ctx.runQuery(internal.momentum._listMigrationCandidates, {
      projectId: args.projectId,
    });

    const report = {
      dryRun,
      limit,
      scannedProjects: candidates.length,
      alreadyMigrated: 0,
      missingProposal: 0,
      migrated: 0,
      remaining: 0,
      perProject: [] as PerProjectReport[],
    };

    let processed = 0;
    for (const candidate of candidates) {
      if (processed >= limit) {
        report.remaining++;
        continue;
      }
      const result: PerProjectReport = await ctx.runMutation(
        internal.momentum._backfillSingleProject,
        { projectId: candidate._id, dryRun }
      );
      report.perProject.push(result);
      if (result.status === "already_migrated") {
        report.alreadyMigrated++;
      } else if (result.status === "missing_proposal") {
        report.missingProposal++;
        processed++;
      } else if (result.status === "migrated" || result.status === "would_migrate") {
        report.migrated++;
        processed++;
      }
    }

    return report;
  },
});

/**
 * Read-only integrity check for the snapshot migration. Run from the Convex
 * dashboard before and after `backfillMomentumSnapshots` to confirm shape.
 *
 * For each project the query reports:
 *   - whether a snapshot exists (any `momentumWbs` rows)
 *   - source vs Momentum row counts at WBS / phase / activity granularity
 *     (Momentum should be ≥ source — equal for estimate data plus the
 *     Change Orders WBS and its default phase)
 *   - counts of bridge-column population on progressEntries / overrides /
 *     assignments, plus any rows still unmapped after migration
 */
export const verifyMigration = query({
  args: { projectId: v.optional(v.id("momentumProjects")) },
  handler: async (ctx, args) => {
    let projects: Doc<"momentumProjects">[];
    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (!project) throw new Error("Project not found.");
      projects = [project];
    } else {
      projects = await ctx.db.query("momentumProjects").collect();
    }

    const perProject = await Promise.all(
      projects.map(async (project) => {
        const [
          momentumWbsRows,
          momentumPhaseRows,
          momentumActivityRows,
          sourceWbsRows,
          sourcePhaseRows,
          sourceActivityRows,
          entries,
          overrides,
          assignments,
        ] = await Promise.all([
          ctx.db
            .query("momentumWbs")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect(),
          ctx.db
            .query("momentumPhases")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect(),
          ctx.db
            .query("momentumActivities")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect(),
          ctx.db
            .query("wbs")
            .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
            .collect(),
          ctx.db
            .query("phases")
            .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
            .collect(),
          ctx.db
            .query("activities")
            .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
            .collect(),
          ctx.db
            .query("progressEntries")
            .withIndex("by_project_activity", (q) => q.eq("projectId", project._id))
            .collect(),
          ctx.db
            .query("activityPhaseOverrides")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect(),
          ctx.db
            .query("projectAssignments")
            .withIndex("by_project", (q) => q.eq("projectId", project._id))
            .collect(),
        ]);

        const hasSnapshotFields =
          project.datasetVersion !== undefined &&
          project.rates !== undefined &&
          project.proposalSyncedAt !== undefined;

        const entriesUnmapped = entries.filter((e) => !e.newActivityId).length;
        const overridesUnmapped = overrides.filter((o) => !o.newActivityId).length;
        const assignmentsRequiringRemap = assignments.filter(
          (a) => (a.scopeType === "wbs" || a.scopeType === "phase") && a.scopeId
        );
        const assignmentsUnmapped = assignmentsRequiringRemap.filter((a) => !a.newScopeId).length;

        const changeOrderWbsCount = momentumWbsRows.filter(
          (w) => w.source === "change_order"
        ).length;

        return {
          projectId: project._id,
          projectName: project.name,
          isMigrated: momentumWbsRows.length > 0,
          hasSnapshotFields,
          counts: {
            sourceWbs: sourceWbsRows.length,
            sourcePhases: sourcePhaseRows.length,
            sourceActivities: sourceActivityRows.length,
            momentumWbs: momentumWbsRows.length,
            momentumPhases: momentumPhaseRows.length,
            momentumActivities: momentumActivityRows.length,
            changeOrderWbs: changeOrderWbsCount,
            progressEntries: entries.length,
            overrides: overrides.length,
            assignments: assignments.length,
          },
          unmapped: {
            progressEntries: entriesUnmapped,
            overrides: overridesUnmapped,
            assignments: assignmentsUnmapped,
          },
        };
      })
    );

    return {
      totalProjects: perProject.length,
      migratedProjects: perProject.filter((p) => p.isMigrated).length,
      perProject,
    };
  },
});

/** Update momentum project fields. */
export const updateProject = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    name: v.optional(v.string()),
    projectNumber: v.optional(v.string()),
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
    workCalendar: v.optional(v.union(v.literal("5x10"), v.literal("6x10"), v.literal("7x10"))),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    // Date inputs arrive as "YYYY-MM-DD"; the schema stores Unix ms. Convert
    // (UTC midnight, matching the read path's `new Date(ms).toISOString()`), and
    // treat an empty string as an explicit clear (patching undefined removes it).
    const dateInputToMs = (s: string): number | undefined => {
      if (!s) return undefined;
      const ms = new Date(`${s}T00:00:00.000Z`).getTime();
      return Number.isNaN(ms) ? undefined : ms;
    };

    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.projectNumber !== undefined)
      updates.projectNumber = args.projectNumber.trim() || undefined;
    if (args.status !== undefined) updates.status = args.status;
    if (args.actualStartDate !== undefined)
      updates.actualStartDate = dateInputToMs(args.actualStartDate);
    if (args.projectedEndDate !== undefined)
      updates.projectedEndDate = dateInputToMs(args.projectedEndDate);
    if (args.workCalendar !== undefined) updates.workCalendar = args.workCalendar;

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.projectId, updates);
    }
  },
});

/**
 * One-time backfill: populate `projectNumber` on existing projects from the
 * leading number of their name (falling back to the proposal number). Idempotent
 * — skips rows that already have one. Pass `dryRun` to preview.
 */
export const backfillProjectNumbers = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const projects = await ctx.db.query("momentumProjects").collect();
    const planned: Array<{ name: string; projectNumber: string }> = [];
    for (const p of projects) {
      if (p.projectNumber) continue;
      const projectNumber = deriveProjectNumber(p.name, p.proposalNumber);
      planned.push({ name: p.name, projectNumber });
      if (!args.dryRun) await ctx.db.patch(p._id, { projectNumber });
    }
    return { total: projects.length, updated: planned.length, dryRun: !!args.dryRun, planned };
  },
});

/**
 * One-time backfill: uppercase the names of Momentum-created Change Orders WBS
 * rows and Momentum-added phases (change_order / field_added) so they match the
 * ALL CAPS convention of MCP-sourced data (#35). MCP estimate rows are already
 * caps and are left untouched. Pass `dryRun` to preview.
 */
export const backfillUppercaseAddedNames = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    let wbsUpdated = 0;
    let phasesUpdated = 0;

    const coWbs = await ctx.db
      .query("momentumWbs")
      .filter((q) => q.eq(q.field("source"), "change_order"))
      .collect();
    for (const w of coWbs) {
      const upper = w.name.toUpperCase();
      if (upper !== w.name) {
        wbsUpdated++;
        if (!args.dryRun) await ctx.db.patch(w._id, { name: upper });
      }
    }

    const addedPhases = await ctx.db
      .query("momentumPhases")
      .filter((q) =>
        q.or(q.eq(q.field("source"), "change_order"), q.eq(q.field("source"), "field_added"))
      )
      .collect();
    for (const p of addedPhases) {
      const poolName = p.poolName.toUpperCase();
      const description = p.description.toUpperCase();
      if (poolName !== p.poolName || description !== p.description) {
        phasesUpdated++;
        if (!args.dryRun) await ctx.db.patch(p._id, { poolName, description });
      }
    }

    return { wbsUpdated, phasesUpdated, dryRun: !!args.dryRun };
  },
});

/**
 * Delete a Momentum project and all of its derived data.
 *
 * Cleans up every Momentum-owned table: snapshot rows, progress entries,
 * phase overrides, assignments, and the recent-views / pinned entries.
 * Precision's tables are never touched — the proposal stays exactly as it
 * was, ready to back a re-imported project later if needed.
 */
export const deleteProject = mutation({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const [entries, overrides, assignments, activities, phases, wbsRows, recentViews, pinned] =
      await Promise.all([
        ctx.db
          .query("progressEntries")
          .withIndex("by_project_activity", (q) => q.eq("projectId", args.projectId))
          .collect(),
        ctx.db
          .query("activityPhaseOverrides")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect(),
        ctx.db
          .query("projectAssignments")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect(),
        ctx.db
          .query("momentumActivities")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect(),
        ctx.db
          .query("momentumPhases")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect(),
        ctx.db
          .query("momentumWbs")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect(),
        ctx.db.query("momentumRecentViews").collect(),
        ctx.db.query("momentumPinnedProjects").collect(),
      ]);

    for (const row of entries) await ctx.db.delete(row._id);
    for (const row of overrides) await ctx.db.delete(row._id);
    for (const row of assignments) await ctx.db.delete(row._id);
    for (const row of activities) await ctx.db.delete(row._id);
    for (const row of phases) await ctx.db.delete(row._id);
    for (const row of wbsRows) await ctx.db.delete(row._id);
    for (const row of recentViews) {
      if (row.projectId === args.projectId) await ctx.db.delete(row._id);
    }
    for (const row of pinned) {
      if (row.projectId === args.projectId) await ctx.db.delete(row._id);
    }

    await ctx.db.delete(args.projectId);
  },
});

/**
 * Batch upsert daily progress entries (one per activity+date).
 *
 * Activity IDs are Momentum IDs. The mutation writes the canonical
 * Momentum bridge columns (`newActivityId`, `newWbsId`, `newPhaseId`) and
 * mirrors them into the legacy columns when the activity has a
 * `sourceActivityId` — keeping legacy queries that haven't been migrated
 * yet correct for estimate-derived data. Field-added and change-order
 * activities have no estimate ancestor, so their entries carry only the
 * Momentum-side IDs.
 */
export const saveProgressEntries = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    entryDate: v.string(),
    entries: v.array(
      v.object({
        activityId: v.id("momentumActivities"),
        quantityCompleted: v.number(),
        notes: v.optional(v.string()),
        // When present, the entry is logged against a specific split row
        // rather than the source activity's effective phase. Source and
        // split entries coexist for the same (activity, date) pair.
        splitId: v.optional(v.id("activitySplits")),
      })
    ),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const user = await authComponent.safeGetAuthUser(ctx);
    const enteredBy = user?.name ?? user?.email ?? undefined;

    // ── Scope validation ──
    if (user) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, args.projectId, user._id);

        if (!scope.hasAccess) {
          throw new Error("You do not have access to enter data for this project.");
        }
        if (scope.effectiveRole === "viewer") {
          throw new Error("Viewer role does not have permission to enter data.");
        }

        if (scope.allowedPhaseIds !== "all") {
          for (const entry of args.entries) {
            if (entry.quantityCompleted === 0) continue;

            const activity = await ctx.db.get(entry.activityId);
            if (!activity) continue;

            // Split rows use the split's target phase for scope checks; a
            // foreman scoped to phase B can log a split landing in B even
            // if the source activity lives in phase A.
            let effectivePhaseId: string;
            if (entry.splitId) {
              const split = await ctx.db.get(entry.splitId);
              if (!split) throw new Error("Split not found.");
              effectivePhaseId = split.targetPhaseId as string;
            } else {
              const override = await ctx.db
                .query("activityPhaseOverrides")
                .withIndex("by_project_new_activity", (q) =>
                  q.eq("projectId", args.projectId).eq("newActivityId", entry.activityId)
                )
                .first();
              effectivePhaseId = (override?.newOverridePhaseId ?? activity.phaseId) as string;
            }

            if (!scope.allowedPhaseIds.has(effectivePhaseId)) {
              throw new Error(`Activity "${activity.description}" is outside your assigned scope.`);
            }
          }
        }
      }
    }

    for (const entry of args.entries) {
      const activity = await ctx.db.get(entry.activityId);
      if (!activity) continue;

      // Resolve the split (if any) so we can validate it belongs to this
      // activity and denormalize phase/wbs against it instead of the
      // activity's effective phase.
      const split = entry.splitId ? await ctx.db.get(entry.splitId) : null;
      if (entry.splitId && !split) {
        throw new Error("Split not found.");
      }
      if (split && split.sourceActivityId !== entry.activityId) {
        throw new Error("Split does not belong to this activity.");
      }

      // Validate quantity stays within the BUCKET budget:
      //   • Split bucket: bounded by split.quantity
      //   • Source bucket: bounded by activity.quantity − sum(splits)
      // We tally completedOtherDays from the same bucket only — split and
      // source entries on this activity are independent ledgers.
      if (entry.quantityCompleted > 0) {
        const bucketBudget = split
          ? split.quantity
          : round2(
              activity.quantity -
                (
                  await ctx.db
                    .query("activitySplits")
                    .withIndex("by_project_source_activity", (q) =>
                      q.eq("projectId", args.projectId).eq("sourceActivityId", entry.activityId)
                    )
                    .collect()
                ).reduce((sum, s) => sum + s.quantity, 0)
            );

        const otherEntries = await ctx.db
          .query("progressEntries")
          .withIndex("by_project_new_activity_date", (q) =>
            q.eq("projectId", args.projectId).eq("newActivityId", entry.activityId)
          )
          .collect();

        const completedOtherDays = otherEntries
          .filter(
            (e) =>
              e.entryDate !== args.entryDate && (split ? e.splitId === entry.splitId : !e.splitId)
          )
          .reduce((sum, e) => sum + e.quantityCompleted, 0);

        if (round2(completedOtherDays + entry.quantityCompleted) > bucketBudget) {
          throw new Error(
            `Exceeds estimated quantity for "${activity.description}". ` +
              `Max remaining: ${round2(bucketBudget - completedOtherDays)}`
          );
        }
      }

      // Upsert is scoped to (project, activity, date, splitId) so source
      // and split rows on the same activity/date stay independent.
      const candidateEntries = await ctx.db
        .query("progressEntries")
        .withIndex("by_project_new_activity_date", (q) =>
          q
            .eq("projectId", args.projectId)
            .eq("newActivityId", entry.activityId)
            .eq("entryDate", args.entryDate)
        )
        .collect();

      const existing =
        candidateEntries.find((e) => (entry.splitId ? e.splitId === entry.splitId : !e.splitId)) ??
        null;

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
        // Resolve effective phase/wbs. Splits override everything else —
        // their target is where the work lives, regardless of any override
        // on the source activity.
        let effectiveMomentumPhaseId: Id<"momentumPhases">;
        let effectiveMomentumWbsId: Id<"momentumWbs">;

        if (split) {
          effectiveMomentumPhaseId = split.targetPhaseId;
          effectiveMomentumWbsId = split.targetWbsId;
        } else {
          const override = await ctx.db
            .query("activityPhaseOverrides")
            .withIndex("by_project_new_activity", (q) =>
              q.eq("projectId", args.projectId).eq("newActivityId", entry.activityId)
            )
            .first();
          const overridePhaseId = override?.newOverridePhaseId;
          effectiveMomentumPhaseId = overridePhaseId ?? activity.phaseId;
          effectiveMomentumWbsId = activity.wbsId;
          if (overridePhaseId) {
            const overridePhase = await ctx.db.get(overridePhaseId);
            if (overridePhase) effectiveMomentumWbsId = overridePhase.wbsId;
          }
        }

        // Mirror to legacy columns when the activity has an estimate
        // ancestor so unmigrated downstream queries stay consistent.
        const legacyActivityId = activity.sourceActivityId;
        let legacyWbsId: Id<"wbs"> | undefined;
        let legacyPhaseId: Id<"phases"> | undefined;
        if (legacyActivityId) {
          const effectivePhase = await ctx.db.get(effectiveMomentumPhaseId);
          legacyPhaseId = effectivePhase?.sourcePhaseId;
          const effectiveWbs = await ctx.db.get(effectiveMomentumWbsId);
          legacyWbsId = effectiveWbs?.sourceWbsId;
        }

        await ctx.db.insert("progressEntries", {
          projectId: args.projectId,
          activityId: legacyActivityId,
          wbsId: legacyWbsId,
          phaseId: legacyPhaseId,
          newActivityId: entry.activityId,
          newWbsId: effectiveMomentumWbsId,
          newPhaseId: effectiveMomentumPhaseId,
          entryDate: args.entryDate,
          quantityCompleted: entry.quantityCompleted,
          notes: entry.notes,
          enteredBy,
          splitId: entry.splitId,
        });
      }
    }

    await ctx.db.patch(args.projectId, { lastEntryDate: args.entryDate });
  },
});

/**
 * Add an activity to a phase from Momentum.
 *
 * Inserts into `momentumActivities`. Precision's tables are never written
 * to — that's the whole point of the bounded-context separation.
 *
 * `source` is derived from the parent phase: change-order phases produce
 * `"change_order"` activities; estimate phases produce `"field_added"`
 * activities. The latter get a subtle "Field" badge in the workbook so
 * supervisors can tell at a glance which work was scope-of-record vs added
 * later.
 *
 * Scope check: when assignments exist for the project, the caller must
 * have write access to the parent phase. Estimate phases check
 * `sourcePhaseId` against the user's allowed phases; change-order phases
 * require project-level scope since they aren't part of the estimate.
 */
export const addActivity = mutation({
  args: {
    phaseId: v.id("momentumPhases"),
    type: activityTypeValidator,
    description: v.string(),
    quantity: v.number(),
    unit: v.string(),
    laborPoolId: v.optional(v.number()),
    equipmentPoolId: v.optional(v.number()),
    labor: v.optional(v.object(laborFieldsValidator)),
    equipment: v.optional(v.object(equipmentFieldsValidator)),
    subcontractor: v.optional(v.object(subcontractorFieldsValidator)),
    unitPrice: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"momentumActivities">> => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found.");

    const user = await authComponent.safeGetAuthUser(ctx);

    // Scope validation — only enforced when the project has any assignments
    if (user) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", phase.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, phase.projectId, user._id);
        if (!scope.hasAccess) {
          throw new Error("You do not have access to this project.");
        }
        if (scope.effectiveRole === "viewer") {
          throw new Error("Viewer role does not have permission to add activities.");
        }

        if (scope.allowedPhaseIds !== "all") {
          if (phase.source !== "estimate") {
            // Change-order and field-added phases have no estimate ancestor,
            // so phase-level assignments can't cover them — require project
            // scope.
            throw new Error("Adding activities to added phases requires project-level access.");
          }
          // Estimate phase — check legacy sourcePhaseId against allowed set
          const legacyPhaseId = phase.sourcePhaseId as string | undefined;
          if (!legacyPhaseId || !scope.allowedPhaseIds.has(legacyPhaseId)) {
            throw new Error("This phase is outside your assigned scope.");
          }
        }
      }
    }

    // Compute sortOrder = max in phase + 1
    const existing = await ctx.db
      .query("momentumActivities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.phaseId))
      .collect();
    const maxSort = existing.length > 0 ? Math.max(...existing.map((a) => a.sortOrder)) : 0;

    const source: "change_order" | "field_added" =
      phase.source === "change_order" ? "change_order" : "field_added";

    return ctx.db.insert("momentumActivities", {
      projectId: phase.projectId,
      wbsId: phase.wbsId,
      phaseId: args.phaseId,
      type: args.type,
      description: args.description,
      quantity: args.quantity,
      unit: args.unit,
      sortOrder: maxSort + 1,
      laborPoolId: args.laborPoolId,
      equipmentPoolId: args.equipmentPoolId,
      labor: args.labor,
      equipment: args.equipment,
      subcontractor: args.subcontractor,
      unitPrice: args.unitPrice,
      source,
      addedByUserId: user?._id,
      addedAt: Date.now(),
    });
  },
});

/**
 * Add a new phase under the project's Change Orders WBS.
 *
 * The Change Orders WBS is the only place users add phases directly in
 * Momentum, so the validator enforces `source === "change_order"` on the
 * target WBS. Phase number and sort order are assigned automatically as
 * "next available", giving the user a one-click flow.
 */
export const addChangeOrderPhase = mutation({
  args: {
    wbsId: v.id("momentumWbs"),
    description: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"momentumPhases">> => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found.");
    if (wbs.source !== "change_order") {
      throw new Error("Phases can only be added directly to the Change Orders WBS.");
    }

    const user = await authComponent.safeGetAuthUser(ctx);
    if (user) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", wbs.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, wbs.projectId, user._id);
        if (!scope.hasAccess) throw new Error("You do not have access to this project.");
        if (scope.effectiveRole === "viewer") {
          throw new Error("Viewer role cannot add phases.");
        }
        if (scope.allowedPhaseIds !== "all") {
          throw new Error("Adding change-order phases requires project-level access.");
        }
      }
    }

    const existing = await ctx.db
      .query("momentumPhases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", args.wbsId))
      .collect();
    const maxSort = existing.length > 0 ? Math.max(...existing.map((p) => p.sortOrder)) : 0;
    const maxNumber = existing.length > 0 ? Math.max(...existing.map((p) => p.phaseNumber)) : 0;

    return ctx.db.insert("momentumPhases", {
      projectId: wbs.projectId,
      wbsId: args.wbsId,
      poolName: "CHANGE ORDER",
      phaseNumber: maxNumber + 1,
      // ALL CAPS for WBS/phase consistency (#35).
      description: (args.description.trim() || `Change Order ${maxNumber + 1}`).toUpperCase(),
      isCompleted: false,
      sortOrder: maxSort + 1,
      source: "change_order",
    });
  },
});

/**
 * Add a phase under any WBS.
 *
 * Phases added under the Change Orders WBS are tagged `change_order`; phases
 * added under an estimate WBS are tagged `field_added`. Both are deletable
 * (unlike `estimate` phases from the MCP import). The optional `phaseCode`
 * (e.g. "300000-001" or "20020") is the display code; `phaseNumber` is derived
 * from it as the numeric sort key so the phase orders correctly within its WBS.
 *
 * Supersedes `addChangeOrderPhase`, which is kept for older deployed clients.
 */
export const addPhase = mutation({
  args: {
    wbsId: v.id("momentumWbs"),
    description: v.string(),
    phaseCode: v.optional(v.string()),
    // Catalog mode: the phasePool type this phase instantiates. Sets
    // `sourcePhasePoolId` so Add Activity offers that type's curated labor.
    // Omitted for a custom phase (labor falls back to WBS-scoped).
    phasePoolId: v.optional(v.number()),
    poolName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"momentumPhases">> => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found.");

    const user = await authComponent.safeGetAuthUser(ctx);
    if (user) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", wbs.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, wbs.projectId, user._id);
        if (!scope.hasAccess) throw new Error("You do not have access to this project.");
        if (scope.effectiveRole === "viewer") {
          throw new Error("Viewer role cannot add phases.");
        }
        if (scope.allowedPhaseIds !== "all") {
          throw new Error("Adding phases requires project-level access.");
        }
      }
    }

    const existing = (
      await ctx.db
        .query("momentumPhases")
        .withIndex("by_wbs_sort", (q) => q.eq("wbsId", args.wbsId))
        .collect()
    ).filter((p) => !p.removedAt);
    const maxSort = existing.length > 0 ? Math.max(...existing.map((p) => p.sortOrder)) : 0;
    const maxNumber = existing.length > 0 ? Math.max(...existing.map((p) => p.phaseNumber)) : 0;

    const source: "change_order" | "field_added" =
      wbs.source === "change_order" ? "change_order" : "field_added";
    const code = args.phaseCode?.trim() || undefined;
    const phaseNumber = derivePhaseNumber(code, maxNumber + 1);

    // ALL CAPS for WBS/phase consistency with the MCP-sourced data (#35).
    const poolName = (
      args.poolName?.trim() || (source === "change_order" ? "Change Order" : wbs.name)
    ).toUpperCase();

    return ctx.db.insert("momentumPhases", {
      projectId: wbs.projectId,
      wbsId: args.wbsId,
      // Catalog mode anchors the phase to a real phasePool type; custom mode
      // leaves it unset (labor then scopes to the whole WBS).
      sourcePhasePoolId: args.phasePoolId,
      poolName,
      phaseNumber,
      phaseCode: code,
      description: (args.description.trim() || code || `Phase ${phaseNumber}`).toUpperCase(),
      isCompleted: false,
      sortOrder: maxSort + 1,
      source,
    });
  },
});

/**
 * Delete a phase that was added in Momentum.
 *
 * Only `change_order` and `field_added` phases can be deleted — `estimate`
 * phases come from the MCP import and are protected. Deletion is blocked while
 * the phase still holds work (logged progress, or splits/overrides pointing at
 * it) so field data is never silently destroyed. Soft-deletes via `removedAt`
 * (consistent with the snapshot tombstone pattern) and tombstones the phase's
 * own activities.
 */
export const deletePhase = mutation({
  args: { phaseId: v.id("momentumPhases") },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found.");
    if (phase.source === "estimate") {
      throw new Error("Phases from the MCP import can't be deleted.");
    }

    const user = await authComponent.safeGetAuthUser(ctx);
    if (user) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", phase.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, phase.projectId, user._id);
        if (!scope.hasAccess) throw new Error("You do not have access to this project.");
        if (scope.effectiveRole === "viewer") {
          throw new Error("Viewer role cannot delete phases.");
        }
        if (scope.allowedPhaseIds !== "all") {
          throw new Error("Deleting phases requires project-level access.");
        }
      }
    }

    const activities = (
      await ctx.db
        .query("momentumActivities")
        .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.phaseId))
        .collect()
    ).filter((a) => !a.removedAt);

    // Guard: any logged progress on this phase's activities. Split entries
    // carry the source activity's newActivityId, so this catches them too.
    for (const a of activities) {
      const entry = await ctx.db
        .query("progressEntries")
        .withIndex("by_project_new_activity", (q) =>
          q.eq("projectId", phase.projectId).eq("newActivityId", a._id)
        )
        .first();
      if (entry) {
        throw new Error(
          "This phase has logged progress and can't be deleted. Clear its entries first."
        );
      }
    }

    // Guard: activities split *into* this phase — their work lives here.
    const splitIn = await ctx.db
      .query("activitySplits")
      .withIndex("by_project_target_phase", (q) =>
        q.eq("projectId", phase.projectId).eq("targetPhaseId", args.phaseId)
      )
      .first();
    if (splitIn) {
      throw new Error("Activities have been split into this phase. Unsplit them first.");
    }

    // Guard: estimate activities reassigned *into* this phase via an override.
    const overrides = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project", (q) => q.eq("projectId", phase.projectId))
      .collect();
    if (overrides.some((o) => o.newOverridePhaseId === args.phaseId)) {
      throw new Error("Activities have been moved into this phase. Move them out first.");
    }

    // Clean up progress-free splits sourced from this phase's activities.
    for (const a of activities) {
      const sourced = await ctx.db
        .query("activitySplits")
        .withIndex("by_project_source_activity", (q) =>
          q.eq("projectId", phase.projectId).eq("sourceActivityId", a._id)
        )
        .collect();
      for (const s of sourced) await ctx.db.delete(s._id);
    }

    const now = Date.now();
    for (const a of activities) {
      await ctx.db.patch(a._id, { removedAt: now });
    }
    await ctx.db.patch(args.phaseId, { removedAt: now });
  },
});

/**
 * Rename a change-order phase. Only change-order phases can be renamed
 * directly — estimate phases inherit their description from Precision and
 * shouldn't be edited in Momentum.
 */
export const renameChangeOrderPhase = mutation({
  args: {
    phaseId: v.id("momentumPhases"),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found.");
    if (phase.source !== "change_order") {
      throw new Error("Only change-order phases can be renamed.");
    }

    const user = await authComponent.safeGetAuthUser(ctx);
    if (user) {
      const anyAssignment = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", phase.projectId))
        .first();

      if (anyAssignment) {
        const scope = await resolveUserScope(ctx, phase.projectId, user._id);
        if (!scope.hasAccess) throw new Error("You do not have access to this project.");
        if (scope.effectiveRole === "viewer") {
          throw new Error("Viewer role cannot rename phases.");
        }
        if (scope.allowedPhaseIds !== "all") {
          throw new Error("Renaming change-order phases requires project-level access.");
        }
      }
    }

    const trimmed = args.description.trim();
    if (!trimmed) throw new Error("Description cannot be empty.");
    await ctx.db.patch(args.phaseId, { description: trimmed });
  },
});

/**
 * Reassign a Momentum activity to a different phase within the same WBS.
 *
 * Same-WBS-only is a v1 constraint, preserved from the legacy mutation —
 * cross-WBS moves require more careful UX (the activity's pool context is
 * tied to its WBS type). Works on `momentumActivities` IDs throughout;
 * legacy bridge columns on `progressEntries` are mirrored when the
 * activity has an estimate ancestor.
 */
export const reassignActivityPhase = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    activityId: v.id("momentumActivities"),
    targetPhaseId: v.id("momentumPhases"),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found.");

    const targetPhase = await ctx.db.get(args.targetPhaseId);
    if (!targetPhase) throw new Error("Target phase not found.");

    if (targetPhase.projectId !== project._id) {
      throw new Error("Target phase does not belong to this project.");
    }

    const existingOverride = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project_new_activity", (q) =>
        q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
      )
      .first();

    const originalMomentumPhaseId = existingOverride?.newOriginalPhaseId ?? activity.phaseId;
    const originalMomentumWbsId = existingOverride?.newOriginalWbsId ?? activity.wbsId;

    if (targetPhase.wbsId !== activity.wbsId) {
      throw new Error("Cross-WBS moves are not supported yet.");
    }

    // Reverting to the original phase deletes the override and rewinds
    // denormalized phase/wbs on existing progress entries. Split entries
    // stay tied to their own target phase regardless — splits are
    // independent of source-activity overrides by design.
    if (args.targetPhaseId === originalMomentumPhaseId) {
      if (existingOverride) {
        const entries = await ctx.db
          .query("progressEntries")
          .withIndex("by_project_new_activity", (q) =>
            q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
          )
          .collect();
        const originalWbs = await ctx.db.get(originalMomentumWbsId);
        const originalPhase = await ctx.db.get(originalMomentumPhaseId);
        for (const entry of entries) {
          if (entry.splitId) continue;
          await ctx.db.patch(entry._id, {
            newPhaseId: originalMomentumPhaseId,
            newWbsId: originalMomentumWbsId,
            phaseId: originalPhase?.sourcePhaseId,
            wbsId: originalWbs?.sourceWbsId,
          });
        }
        await ctx.db.delete(existingOverride._id);
      }
      return;
    }

    // Update denormalized phase/wbs on existing source-bucket progress
    // entries. Split entries are untouched.
    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) =>
        q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
      )
      .collect();
    for (const entry of entries) {
      if (entry.splitId) continue;
      await ctx.db.patch(entry._id, {
        newPhaseId: args.targetPhaseId,
        newWbsId: targetPhase.wbsId,
        phaseId: targetPhase.sourcePhaseId,
        wbsId: (await ctx.db.get(targetPhase.wbsId))?.sourceWbsId,
      });
    }

    // Mirror legacy IDs when the activity/phase have estimate ancestors
    const legacyActivityId = activity.sourceActivityId;
    const legacyTargetPhaseId = targetPhase.sourcePhaseId;
    const legacyOriginalPhase = await ctx.db.get(originalMomentumPhaseId);
    const legacyOriginalWbs = await ctx.db.get(originalMomentumWbsId);

    if (existingOverride) {
      await ctx.db.patch(existingOverride._id, {
        newOverridePhaseId: args.targetPhaseId,
        overridePhaseId: legacyTargetPhaseId,
      });
    } else {
      await ctx.db.insert("activityPhaseOverrides", {
        projectId: args.projectId,
        // Legacy mirrors (best-effort — null for field_added/change_order)
        activityId: legacyActivityId,
        overridePhaseId: legacyTargetPhaseId,
        originalPhaseId: legacyOriginalPhase?.sourcePhaseId,
        originalWbsId: legacyOriginalWbs?.sourceWbsId,
        // Canonical Momentum IDs
        newActivityId: args.activityId,
        newOverridePhaseId: args.targetPhaseId,
        newOriginalPhaseId: activity.phaseId,
        newOriginalWbsId: activity.wbsId,
        createdAt: Date.now(),
      });
    }
  },
});

/** Revert an activity's phase override back to the original phase. */
export const revertActivityPhase = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    activityId: v.id("momentumActivities"),
  },
  handler: async (ctx, args) => {
    const override = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project_new_activity", (q) =>
        q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
      )
      .first();

    if (!override?.newOriginalPhaseId || !override.newOriginalWbsId) return;

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) =>
        q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
      )
      .collect();

    const originalPhase = await ctx.db.get(override.newOriginalPhaseId);
    const originalWbs = await ctx.db.get(override.newOriginalWbsId);

    // Rewind source-bucket entries only. Split entries stay on their
    // own target phase regardless of whether the source was overridden.
    for (const entry of entries) {
      if (entry.splitId) continue;
      await ctx.db.patch(entry._id, {
        newPhaseId: override.newOriginalPhaseId,
        newWbsId: override.newOriginalWbsId,
        phaseId: originalPhase?.sourcePhaseId,
        wbsId: originalWbs?.sourceWbsId,
      });
    }

    await ctx.db.delete(override._id);
  },
});

/**
 * Split a portion of an activity's quantity into a different phase.
 *
 * The source activity's row is untouched — its effective quantity is
 * reduced at read time by the sum of its splits. A virtual row appears
 * in the target phase for the split quantity. Both halves track progress
 * independently via `progressEntries.splitId`.
 *
 * Why a side-table instead of duplicating the activity row: leaving the
 * source `momentumActivities.quantity` immutable keeps a future
 * Sync-from-estimate flow mathematically clean (no need to track which
 * deltas came from estimator edits vs. local splits) and makes splits
 * queryable as a first-class relationship (lists, retrospectives, etc.).
 *
 * Throws if the target phase is outside the source's effective WBS,
 * if quantity is non-positive, or if splitting would drop the source's
 * remaining budget below already-completed quantity on the source bucket.
 */
export const splitActivityToPhase = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    activityId: v.id("momentumActivities"),
    targetPhaseId: v.id("momentumPhases"),
    quantity: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"activitySplits">> => {
    if (!Number.isFinite(args.quantity) || args.quantity <= 0) {
      throw new Error("Split quantity must be greater than zero.");
    }

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found.");
    if (activity.projectId !== args.projectId) {
      throw new Error("Activity does not belong to this project.");
    }

    const targetPhase = await ctx.db.get(args.targetPhaseId);
    if (!targetPhase) throw new Error("Target phase not found.");
    if (targetPhase.projectId !== args.projectId) {
      throw new Error("Target phase does not belong to this project.");
    }

    // Resolve the source's effective phase/WBS (honor any active override).
    const override = await ctx.db
      .query("activityPhaseOverrides")
      .withIndex("by_project_new_activity", (q) =>
        q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
      )
      .first();

    const effectivePhaseId =
      override?.newOverridePhaseId !== undefined
        ? (override.newOverridePhaseId as Id<"momentumPhases">)
        : activity.phaseId;
    let effectiveWbsId: Id<"momentumWbs"> = activity.wbsId;
    if (override?.newOverridePhaseId) {
      const overridePhase = await ctx.db.get(override.newOverridePhaseId);
      if (overridePhase) effectiveWbsId = overridePhase.wbsId;
    }

    if (targetPhase.wbsId !== effectiveWbsId) {
      throw new Error("Cross-WBS splits are not supported yet.");
    }
    if (args.targetPhaseId === effectivePhaseId) {
      throw new Error("Target phase is the same as the current phase.");
    }

    // Existing splits cap how much budget is still splittable.
    const existingSplits = await ctx.db
      .query("activitySplits")
      .withIndex("by_project_source_activity", (q) =>
        q.eq("projectId", args.projectId).eq("sourceActivityId", args.activityId)
      )
      .collect();
    const existingSplitTotal = existingSplits.reduce((sum, s) => sum + s.quantity, 0);

    // Source-only completed quantity — progress logged before any split.
    const sourceEntries = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_new_activity", (q) =>
        q.eq("projectId", args.projectId).eq("newActivityId", args.activityId)
      )
      .collect();
    const completedOnSource = sourceEntries
      .filter((e) => !e.splitId)
      .reduce((sum, e) => sum + e.quantityCompleted, 0);

    const maxSplittable = round2(activity.quantity - existingSplitTotal - completedOnSource);
    if (args.quantity > maxSplittable) {
      throw new Error(
        `Split exceeds available quantity for "${activity.description}". ` +
          `Max splittable: ${maxSplittable} ${activity.unit}.`
      );
    }

    return ctx.db.insert("activitySplits", {
      projectId: args.projectId,
      sourceActivityId: args.activityId,
      targetPhaseId: args.targetPhaseId,
      targetWbsId: targetPhase.wbsId,
      quantity: args.quantity,
      createdAt: Date.now(),
    });
  },
});

/**
 * Revert a split, returning its quantity to the source activity.
 *
 * Refuses if any progress has been logged against the split — those
 * entries represent real field work, so the operator must explicitly
 * clear them first rather than have them silently disappear or get
 * reattributed to the source bucket.
 */
export const revertActivitySplit = mutation({
  args: { splitId: v.id("activitySplits") },
  handler: async (ctx, args) => {
    const split = await ctx.db.get(args.splitId);
    if (!split) return;

    const entries = await ctx.db
      .query("progressEntries")
      .withIndex("by_split", (q) => q.eq("splitId", args.splitId))
      .collect();

    if (entries.length > 0) {
      throw new Error(
        "Cannot unsplit — progress has been entered on this split. Delete those entries first."
      );
    }

    await ctx.db.delete(args.splitId);
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

// ============================================================================
// RECENT VIEWS & PINNED PROJECTS
// ============================================================================

/**
 * Record that the current user opened a project.
 *
 * Upserts a single row per user+project so the "Recent Projects" section
 * always reflects the latest access time.
 */
export const recordProjectView = mutation({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return;

    const existing = await ctx.db
      .query("momentumRecentViews")
      .withIndex("by_user_project", (q) => q.eq("userId", user._id).eq("projectId", args.projectId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { lastAccessedAt: Date.now() });
    } else {
      await ctx.db.insert("momentumRecentViews", {
        userId: user._id,
        projectId: args.projectId,
        lastAccessedAt: Date.now(),
      });
    }
  },
});

/**
 * Get the current user's recently viewed project IDs, most recent first.
 *
 * Returns up to 4 IDs — the frontend joins these against the full project
 * list to avoid duplicating the heavy progress computation.
 */
export const getRecentProjectIds = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];

    const views = await ctx.db
      .query("momentumRecentViews")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    return views
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, 4)
      .map((v) => v.projectId as string);
  },
});

/** Toggle a project's pinned status for the current user. */
export const togglePinnedProject = mutation({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return;

    const existing = await ctx.db
      .query("momentumPinnedProjects")
      .withIndex("by_user_project", (q) => q.eq("userId", user._id).eq("projectId", args.projectId))
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.insert("momentumPinnedProjects", {
        userId: user._id,
        projectId: args.projectId,
        pinnedAt: Date.now(),
      });
    }
  },
});

/**
 * Get the current user's pinned project IDs, oldest pin first.
 *
 * Returns IDs only — the frontend joins against the full project list.
 */
export const getPinnedProjectIds = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];

    const pins = await ctx.db
      .query("momentumPinnedProjects")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    return pins.sort((a, b) => a.pinnedAt - b.pinnedAt).map((p) => p.projectId as string);
  },
});
