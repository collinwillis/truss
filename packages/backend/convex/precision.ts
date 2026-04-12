/**
 * Convex functions for the Precision estimation app.
 *
 * Queries compute costs at read time from raw activity data + proposal rates.
 * Nothing is pre-aggregated — costs roll up from activity → phase → WBS →
 * proposal on every query, matching the Momentum pattern.
 *
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================================
// SHARED VALIDATORS (matching schema.ts definitions)
// ============================================================================

const dataVersion = v.union(v.literal("v1"), v.literal("v2"));

const bidType = v.union(
  v.literal("lump_sum"),
  v.literal("time_and_materials"),
  v.literal("budgetary"),
  v.literal("rates"),
  v.literal("cost_plus")
);

const proposalStatus = v.union(
  v.literal("bidding"),
  v.literal("submitted"),
  v.literal("awarded"),
  v.literal("rejected"),
  v.literal("declined"),
  v.literal("open"),
  v.literal("closed")
);

const addressFields = {
  street: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zipCode: v.optional(v.string()),
};

const rateFields = {
  craftBaseRate: v.number(),
  weldBaseRate: v.number(),
  subsistenceRate: v.number(),
  burdenRate: v.number(),
  overheadRate: v.number(),
  consumablesRate: v.number(),
  fuelRate: v.number(),
  rigRate: v.number(),
  useTaxRate: v.number(),
  salesTaxRate: v.number(),
  laborProfitRate: v.number(),
  materialProfitRate: v.number(),
  equipmentProfitRate: v.number(),
  subcontractorProfitRate: v.number(),
  rigProfitRate: v.number(),
};

const pipingSpecFields = {
  size: v.optional(v.string()),
  spec: v.optional(v.string()),
  flc: v.optional(v.string()),
  system: v.optional(v.string()),
  insulation: v.optional(v.string()),
  insulationSize: v.optional(v.number()),
};

const activityType = v.union(
  v.literal("labor"),
  v.literal("material"),
  v.literal("equipment"),
  v.literal("subcontractor"),
  v.literal("cost_only"),
  v.literal("custom_labor")
);

const equipmentOwnership = v.union(v.literal("rental"), v.literal("owned"), v.literal("purchase"));

const laborFields = {
  craftConstant: v.number(),
  welderConstant: v.number(),
  customCraftRate: v.optional(v.number()),
  customSubsistenceRate: v.optional(v.number()),
};

const equipmentFields = {
  ownership: equipmentOwnership,
  time: v.number(),
};

const subcontractorFields = {
  laborCost: v.number(),
  materialCost: v.number(),
  equipmentCost: v.number(),
};

// ============================================================================
// TYPES
// ============================================================================

/** Proposal rate fields extracted for calculation. */
interface ProposalRates {
  craftBaseRate: number;
  weldBaseRate: number;
  subsistenceRate: number;
  burdenRate: number;
  overheadRate: number;
  consumablesRate: number;
  fuelRate: number;
  rigRate: number;
  useTaxRate: number;
  salesTaxRate: number;
  laborProfitRate: number;
  materialProfitRate: number;
  equipmentProfitRate: number;
  subcontractorProfitRate: number;
  rigProfitRate: number;
}

/** Computed costs for a single activity. */
interface ActivityCosts {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

// ============================================================================
// CALCULATION HELPERS (pure functions, not exported to Convex API)
// ============================================================================

/** Round to 2 decimal places for currency precision. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the loaded hourly rate for craft labor.
 *
 * Formula: craftBase + (craftBase × (burden + overhead + laborProfit + fuel + consumables) / 100) + subsistence
 */
function computeCraftLoadedRate(
  rates: ProposalRates,
  customCraftRate?: number,
  customSubsistenceRate?: number
): number {
  const craftBase = customCraftRate ?? rates.craftBaseRate;
  const subsistence = customSubsistenceRate ?? rates.subsistenceRate;
  const rateMultiplier =
    (rates.burdenRate +
      rates.overheadRate +
      rates.laborProfitRate +
      rates.fuelRate +
      rates.consumablesRate) /
    100;
  return craftBase + craftBase * rateMultiplier + subsistence;
}

/**
 * Compute the loaded hourly rate for welder labor.
 *
 * Formula: weldBase + (weldBase × (burden+overhead+laborProfit+fuel+consumables)/100) + subsistence + rig + (rig × rigProfit/100)
 *
 * WHY: rigProfitRate is NOT included in the weldBase markup — it is ONLY
 * applied to the rigRate separately. This matches the legacy MCP Estimator
 * exactly. The craft markup rates are: burden, overhead, laborProfit, fuel,
 * consumables — identical for both craft and welder base calculations.
 */
function computeWelderLoadedRate(rates: ProposalRates): number {
  // Same 5 markup rates as craft — NO rigProfitRate in this multiplier
  const rateMultiplier =
    (rates.burdenRate +
      rates.overheadRate +
      rates.laborProfitRate +
      rates.fuelRate +
      rates.consumablesRate) /
    100;
  return (
    rates.weldBaseRate +
    rates.weldBaseRate * rateMultiplier +
    rates.subsistenceRate +
    rates.rigRate +
    (rates.rigRate * rates.rigProfitRate) / 100
  );
}

/**
 * Compute all cost fields for a single activity based on its type.
 *
 * WHY: The legacy MCP Estimator calculates craft and welder costs for ALL
 * activity types except subcontractor. Material items, equipment items, and
 * cost-only items that have craft/welder constants will accrue labor costs
 * in addition to their type-specific costs. The totalCost for non-subcontractor
 * items is the sum of ALL cost components. For subcontractor items, totalCost
 * equals only the subcontractor cost.
 *
 * This EXACTLY matches the legacy calculateActivityData() dispatch logic.
 */
function computeActivityCosts(activity: Doc<"activities">, rates: ProposalRates): ActivityCosts {
  const costs: ActivityCosts = {
    craftManHours: 0,
    welderManHours: 0,
    craftCost: 0,
    welderCost: 0,
    materialCost: 0,
    equipmentCost: 0,
    subcontractorCost: 0,
    costOnlyCost: 0,
    totalCost: 0,
  };

  const qty = activity.quantity;

  // ── Step 1: Man-hours (from labor constants, applies to all types with labor data) ──
  const craftConstant = activity.labor?.craftConstant ?? 0;
  const welderConstant = activity.labor?.welderConstant ?? 0;
  costs.craftManHours = round2(qty * craftConstant);
  costs.welderManHours = round2(qty * welderConstant);

  // ── Step 2: Loaded rates ──
  const craftLoaded = computeCraftLoadedRate(
    rates,
    activity.labor?.customCraftRate ?? undefined,
    activity.labor?.customSubsistenceRate ?? undefined
  );
  const welderLoaded = computeWelderLoadedRate(rates);

  // ── Step 3: Craft cost — ALL types except subcontractor ──
  if (activity.type !== "subcontractor") {
    costs.craftCost = round2(costs.craftManHours * craftLoaded);
  }

  // ── Step 4: Welder cost — ALWAYS calculated (even subcontractor in legacy) ──
  costs.welderCost = round2(costs.welderManHours * welderLoaded);

  // ── Step 5: Type-specific costs ──
  switch (activity.type) {
    case "material": {
      const price = activity.unitPrice ?? 0;
      const markup = 1 + (rates.materialProfitRate + rates.salesTaxRate) / 100;
      costs.materialCost = round2(qty * price * markup);
      break;
    }

    case "equipment": {
      const price = activity.unitPrice ?? 0;
      const time = activity.equipment?.time ?? 0;
      const ownership = activity.equipment?.ownership ?? "rental";

      if (ownership === "owned") {
        costs.equipmentCost = round2(qty * time * price);
      } else {
        const markup = 1 + (rates.equipmentProfitRate + rates.useTaxRate) / 100;
        costs.equipmentCost = round2(qty * time * price * markup);
      }
      break;
    }

    case "subcontractor": {
      const subLabor = activity.subcontractor?.laborCost ?? 0;
      const subMaterial = activity.subcontractor?.materialCost ?? 0;
      const subEquipment = activity.subcontractor?.equipmentCost ?? 0;
      const subProfit = rates.subcontractorProfitRate / 100;
      const salesTax = rates.salesTaxRate / 100;

      costs.subcontractorCost = round2(
        qty *
          (subLabor * (1 + subProfit) +
            subMaterial * (1 + subProfit + salesTax) +
            subEquipment * (1 + subProfit))
      );
      break;
    }

    case "cost_only": {
      const price = activity.unitPrice ?? 0;
      costs.costOnlyCost = round2(qty * price);
      break;
    }

    // labor and custom_labor have no additional type-specific costs
  }

  // ── Step 6: Total cost ──
  if (activity.type === "subcontractor") {
    // Subcontractor: total = subcontractor cost ONLY (legacy behavior)
    costs.totalCost = costs.subcontractorCost;
  } else {
    // All others: sum of ALL cost components
    costs.totalCost = round2(
      costs.craftCost +
        costs.welderCost +
        costs.materialCost +
        costs.equipmentCost +
        costs.subcontractorCost +
        costs.costOnlyCost
    );
  }

  return costs;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * List all proposals with metadata for the estimates dashboard.
 *
 * WHY: Does not compute costs — keeps the list query fast.
 * Cost rollups happen when drilling into a specific proposal.
 */
export const listProposals = query({
  args: {},
  handler: async (ctx) => {
    const proposals = await ctx.db.query("proposals").collect();

    return proposals.map((p) => ({
      _id: p._id,
      proposalNumber: p.proposalNumber,
      description: p.description,
      ownerName: p.ownerName,
      status: p.status ?? null,
      bidType: p.bidType ?? null,
      dateDue: p.dateDue ?? null,
      dateReceived: p.dateReceived ?? null,
      jobNumber: p.jobNumber ?? null,
      estimators: p.estimators ?? [],
      datasetVersion: p.datasetVersion,
    }));
  },
});

/**
 * Get a single proposal with all fields including rates.
 *
 * WHY: The overview screen needs full proposal details and rates
 * for editing. Does not load activities — cost rollups are separate queries.
 */
export const getProposal = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    // Count WBS and phases for the summary
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    return {
      ...proposal,
      wbsCount: wbsItems.length,
      phaseCount: phases.length,
    };
  },
});

/**
 * Get the WBS list for a proposal with basic metadata.
 *
 * WHY: The sidebar and overview screen need WBS items without full cost rollups.
 * Cost rollups are computed by getWBSListWithCosts (Phase 2).
 */
export const getWBSForProposal = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    return wbsItems.map((w) => ({
      _id: w._id,
      name: w.name,
      wbsPoolId: w.wbsPoolId,
      sortOrder: w.sortOrder,
    }));
  },
});

/**
 * Get WBS items with their phases for sidebar tree navigation.
 *
 * WHY: The sidebar tree needs to show WBS → Phase hierarchy for direct
 * navigation. Returns lightweight data (no cost rollups) to keep the
 * reactive query fast.
 */
export const getWBSWithPhasesForNav = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Group phases by WBS
    const phasesByWbs = new Map<string, typeof phases>();
    for (const phase of phases) {
      const key = phase.wbsId as string;
      const list = phasesByWbs.get(key) ?? [];
      list.push(phase);
      phasesByWbs.set(key, list);
    }

    return wbsItems.map((w) => ({
      _id: w._id,
      name: w.name,
      sortOrder: w.sortOrder,
      phases: (phasesByWbs.get(w._id as string) ?? [])
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => ({
          _id: p._id,
          phaseNumber: p.phaseNumber,
          description: p.description,
        })),
    }));
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new proposal with rates and initialize its WBS structure.
 *
 * WHY: Proposal creation is a compound operation — it inserts the proposal
 * and initializes the standard WBS set from the pool in a single transaction.
 */
export const createProposal = mutation({
  args: {
    proposalNumber: v.string(),
    description: v.string(),
    ownerName: v.string(),
    rates: v.object(rateFields),
    datasetVersion: dataVersion,
    status: v.optional(proposalStatus),
    bidType: v.optional(bidType),
    projectAddress: v.optional(v.object(addressFields)),
    jobSiteAddress: v.optional(v.string()),
    estimators: v.optional(v.array(v.string())),
    dateReceived: v.optional(v.number()),
    dateDue: v.optional(v.number()),
    projectStartDate: v.optional(v.number()),
    projectEndDate: v.optional(v.number()),
    jobNumber: v.optional(v.string()),
    changeOrderNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Insert the proposal
    const proposalId = await ctx.db.insert("proposals", {
      proposalNumber: args.proposalNumber,
      description: args.description,
      ownerName: args.ownerName,
      rates: args.rates,
      datasetVersion: args.datasetVersion,
      status: args.status,
      bidType: args.bidType,
      projectAddress: args.projectAddress,
      jobSiteAddress: args.jobSiteAddress,
      estimators: args.estimators,
      dateReceived: args.dateReceived,
      dateDue: args.dateDue,
      projectStartDate: args.projectStartDate,
      projectEndDate: args.projectEndDate,
      jobNumber: args.jobNumber,
      changeOrderNumber: args.changeOrderNumber,
    });

    // Initialize WBS from pool — try requested version, fall back to v1 if empty
    let wbsPoolItems = await ctx.db
      .query("wbsPool")
      .withIndex("by_version_active", (q) =>
        q.eq("datasetVersion", args.datasetVersion).eq("isActive", true)
      )
      .collect();
    if (wbsPoolItems.length === 0 && args.datasetVersion !== "v1") {
      wbsPoolItems = await ctx.db
        .query("wbsPool")
        .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
        .collect();
    }

    for (const poolItem of wbsPoolItems) {
      await ctx.db.insert("wbs", {
        proposalId,
        wbsPoolId: poolItem.poolId,
        name: poolItem.name,
        sortOrder: poolItem.sortOrder,
      });
    }

    return proposalId;
  },
});

/**
 * Update proposal metadata fields (not rates).
 *
 * WHY: Metadata and rates are edited in separate UI sections.
 * This mutation handles info fields; updateProposalRates handles rates.
 */
export const updateProposal = mutation({
  args: {
    proposalId: v.id("proposals"),
    proposalNumber: v.optional(v.string()),
    description: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    status: v.optional(proposalStatus),
    bidType: v.optional(bidType),
    projectAddress: v.optional(v.object(addressFields)),
    jobSiteAddress: v.optional(v.string()),
    estimators: v.optional(v.array(v.string())),
    dateReceived: v.optional(v.number()),
    dateDue: v.optional(v.number()),
    projectStartDate: v.optional(v.number()),
    projectEndDate: v.optional(v.number()),
    jobNumber: v.optional(v.string()),
    changeOrderNumber: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
  },
  handler: async (ctx, args) => {
    const { proposalId, ...fields } = args;

    const existing = await ctx.db.get(proposalId);
    if (!existing) throw new Error("Proposal not found");

    // Build patch object with only provided fields
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(proposalId, patch);
    }
  },
});

/**
 * Update proposal rate configuration.
 *
 * WHY: Rates are the full 15-field object that drives all cost calculations.
 * Separating this from metadata makes the intent clear and allows the UI
 * to debounce rate changes independently.
 */
export const updateProposalRates = mutation({
  args: {
    proposalId: v.id("proposals"),
    rates: v.object(rateFields),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.proposalId);
    if (!existing) throw new Error("Proposal not found");

    await ctx.db.patch(args.proposalId, { rates: args.rates });
  },
});

/**
 * Delete a proposal and all associated data.
 *
 * WHY: Cascading delete is necessary because WBS, phases, and activities
 * all hold foreign key references to the proposal. Deleting in reverse
 * order (activities → phases → WBS → proposal) ensures no orphans.
 */
export const deleteProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.proposalId);
    if (!existing) throw new Error("Proposal not found");

    // Delete all activities for this proposal
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }

    // Delete all phases for this proposal
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    for (const phase of phases) {
      await ctx.db.delete(phase._id);
    }

    // Delete all WBS for this proposal
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    for (const wbs of wbsItems) {
      await ctx.db.delete(wbs._id);
    }

    // Delete the proposal itself
    await ctx.db.delete(args.proposalId);
  },
});

// ============================================================================
// COST QUERIES (Phase 2 — Server-Side Calculation Engine)
// ============================================================================

/** WBS pool IDs classified as indirect (non-productive) hours. */
const INDIRECT_WBS_POOL_IDS = new Set([
  10000, // MOBILIZE
  180000, // SPECIALTY SERVICES
  190000, // DEMOBILIZE
  200000, // SUPPORT
]);

/** Activity types that contribute man-hours. */
const LABOR_TYPES = new Set(["labor", "custom_labor"]);

/**
 * Accumulator for rolling up costs across activities.
 *
 * WHY: Single-pass accumulation avoids intermediate array allocations
 * and handles 10K+ activities efficiently.
 */
interface CostAccumulator {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

/** Create a zero-initialized cost accumulator. */
function zeroCosts(): CostAccumulator {
  return {
    craftManHours: 0,
    welderManHours: 0,
    craftCost: 0,
    welderCost: 0,
    materialCost: 0,
    equipmentCost: 0,
    subcontractorCost: 0,
    costOnlyCost: 0,
    totalCost: 0,
  };
}

/** Add computed activity costs into an accumulator (mutates acc). */
function accumulateCosts(acc: CostAccumulator, costs: ActivityCosts): void {
  acc.craftManHours += costs.craftManHours;
  acc.welderManHours += costs.welderManHours;
  acc.craftCost += costs.craftCost;
  acc.welderCost += costs.welderCost;
  acc.materialCost += costs.materialCost;
  acc.equipmentCost += costs.equipmentCost;
  acc.subcontractorCost += costs.subcontractorCost;
  acc.costOnlyCost += costs.costOnlyCost;
  acc.totalCost += costs.totalCost;
}

/** Round all fields in a cost accumulator to 2 decimal places. */
function roundAccumulator(acc: CostAccumulator): CostAccumulator {
  return {
    craftManHours: round2(acc.craftManHours),
    welderManHours: round2(acc.welderManHours),
    craftCost: round2(acc.craftCost),
    welderCost: round2(acc.welderCost),
    materialCost: round2(acc.materialCost),
    equipmentCost: round2(acc.equipmentCost),
    subcontractorCost: round2(acc.subcontractorCost),
    costOnlyCost: round2(acc.costOnlyCost),
    totalCost: round2(acc.totalCost),
  };
}

/**
 * Get all activities for a phase with individually computed costs.
 *
 * WHY: This is the data that powers the activity data grid.
 * Typically 5-50 activities per phase — efficient and fast.
 */
export const getActivitiesWithCosts = query({
  args: { phaseId: v.id("phases") },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    const proposal = await ctx.db.get(phase.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.phaseId))
      .collect();

    return activities.map((activity) => {
      const costs = computeActivityCosts(activity, rates);
      return {
        ...activity,
        costs,
      };
    });
  },
});

/**
 * Get phases for a WBS with cost rollups.
 *
 * WHY: The WBS detail screen shows a phase list with aggregated costs.
 * Loads activities for the WBS once, groups by phase, then sums.
 */
export const getPhaseListWithCosts = query({
  args: { wbsId: v.id("wbs") },
  handler: async (ctx, args) => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    const proposal = await ctx.db.get(wbs.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    // Load all phases for this WBS (sorted)
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    // Load all activities for this WBS in a single query
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    // Group activities by phase
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const activity of activities) {
      const key = activity.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(activity);
      activitiesByPhase.set(key, list);
    }

    // Compute rollups per phase
    return phases.map((phase) => {
      const phaseActivities = activitiesByPhase.get(phase._id as string) ?? [];
      const acc = zeroCosts();

      for (const activity of phaseActivities) {
        accumulateCosts(acc, computeActivityCosts(activity, rates));
      }

      return {
        _id: phase._id,
        phasePoolId: phase.phasePoolId,
        poolName: phase.poolName,
        phaseNumber: phase.phaseNumber,
        description: phase.description,
        area: phase.area ?? null,
        sheet: phase.sheet ?? null,
        pipingSpec: phase.pipingSpec ?? null,
        isCompleted: phase.isCompleted,
        sortOrder: phase.sortOrder,
        activityCount: phaseActivities.length,
        costs: roundAccumulator(acc),
      };
    });
  },
});

/**
 * Get WBS list for a proposal with cost rollups per WBS.
 *
 * WHY: The estimate overview shows each WBS category with aggregated costs.
 * Loads ALL activities for the proposal once, groups by WBS, sums costs.
 * For a 10K-activity proposal, this runs server-side in <100ms.
 */
export const getWBSListWithCosts = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    // Load WBS items sorted by display order
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Load ALL activities for this proposal (single indexed query)
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Load phases to count per WBS
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Index activities by WBS
    const activitiesByWBS = new Map<string, Doc<"activities">[]>();
    for (const activity of activities) {
      const key = activity.wbsId as string;
      const list = activitiesByWBS.get(key) ?? [];
      list.push(activity);
      activitiesByWBS.set(key, list);
    }

    // Count phases per WBS
    const phaseCountByWBS = new Map<string, number>();
    for (const phase of phases) {
      const key = phase.wbsId as string;
      phaseCountByWBS.set(key, (phaseCountByWBS.get(key) ?? 0) + 1);
    }

    return wbsItems.map((wbs) => {
      const wbsActivities = activitiesByWBS.get(wbs._id as string) ?? [];
      const acc = zeroCosts();

      for (const activity of wbsActivities) {
        accumulateCosts(acc, computeActivityCosts(activity, rates));
      }

      return {
        _id: wbs._id,
        name: wbs.name,
        wbsPoolId: wbs.wbsPoolId,
        sortOrder: wbs.sortOrder,
        phaseCount: phaseCountByWBS.get(wbs._id as string) ?? 0,
        activityCount: wbsActivities.length,
        costs: roundAccumulator(acc),
      };
    });
  },
});

/**
 * Full proposal cost summary with direct/indirect hour classification.
 *
 * WHY: The totals panel needs a complete cost picture. This loads ALL
 * activities and computes everything in a single pass. The heavy lifting
 * runs server-side where Convex is optimized for large `.collect()` calls.
 */
export const getProposalSummary = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    // Load all WBS to classify direct/indirect
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Build a set of indirect WBS IDs
    const indirectWBSIds = new Set<string>();
    for (const wbs of wbsItems) {
      if (INDIRECT_WBS_POOL_IDS.has(wbs.wbsPoolId)) {
        indirectWBSIds.add(wbs._id as string);
      }
    }

    // Load all activities
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Load phases count
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Single-pass accumulation
    const total = zeroCosts();
    let directCraftHours = 0;
    let directWelderHours = 0;
    let indirectHours = 0;

    for (const activity of activities) {
      const costs = computeActivityCosts(activity, rates);
      accumulateCosts(total, costs);

      // Classify hours
      const isIndirect = indirectWBSIds.has(activity.wbsId as string);
      const activityHours = costs.craftManHours + costs.welderManHours;

      if (isIndirect) {
        indirectHours += activityHours;
      } else {
        directCraftHours += costs.craftManHours;
        directWelderHours += costs.welderManHours;
      }
    }

    const directHours = directCraftHours + directWelderHours;
    const totalHours = directHours + indirectHours;

    return {
      ...roundAccumulator(total),
      directCraftHours: round2(directCraftHours),
      directWelderHours: round2(directWelderHours),
      directHours: round2(directHours),
      indirectHours: round2(indirectHours),
      totalHours: round2(totalHours),
      wbsCount: wbsItems.length,
      phaseCount: phases.length,
      activityCount: activities.length,
    };
  },
});

/** Get a single WBS document. */
export const getWBS = query({
  args: { wbsId: v.id("wbs") },
  handler: async (ctx, args) => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");
    return wbs;
  },
});

/** Get a single phase document. */
export const getPhase = query({
  args: { phaseId: v.id("phases") },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");
    return phase;
  },
});

// ============================================================================
// POOL QUERIES (Reference Data Catalogs)
// ============================================================================

/**
 * Get active WBS pool entries for a dataset version.
 *
 * WHY fallback: v2 pool data is incomplete (WBS/phase/labor only exist in v1).
 * If the requested version returns 0 results, we fall back to v1 automatically.
 */
export const getWBSPool = query({
  args: { datasetVersion: dataVersion },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("wbsPool")
      .withIndex("by_version_active", (q) =>
        q.eq("datasetVersion", args.datasetVersion).eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("wbsPool")
      .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
      .collect();
  },
});

/**
 * Get phase pool entries for a specific WBS category.
 *
 * WHY fallback: Phase pool only has v1 data currently. Falls back to v1
 * when the requested version returns empty.
 */
export const getPhasePool = query({
  args: {
    datasetVersion: dataVersion,
    wbsPoolId: v.number(),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("phasePool")
      .withIndex("by_version_wbs_active", (q) =>
        q
          .eq("datasetVersion", args.datasetVersion)
          .eq("wbsPoolId", args.wbsPoolId)
          .eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("phasePool")
      .withIndex("by_version_wbs_active", (q) =>
        q.eq("datasetVersion", "v1").eq("wbsPoolId", args.wbsPoolId).eq("isActive", true)
      )
      .collect();
  },
});

/**
 * Get labor pool entries for a specific phase type.
 *
 * WHY fallback: Labor pool only has v1 data currently. Falls back to v1
 * when the requested version returns empty.
 */
export const getLaborPool = query({
  args: {
    datasetVersion: dataVersion,
    phasePoolId: v.number(),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("laborPool")
      .withIndex("by_version_phase_active", (q) =>
        q
          .eq("datasetVersion", args.datasetVersion)
          .eq("phasePoolId", args.phasePoolId)
          .eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("laborPool")
      .withIndex("by_version_phase_active", (q) =>
        q.eq("datasetVersion", "v1").eq("phasePoolId", args.phasePoolId).eq("isActive", true)
      )
      .collect();
  },
});

/**
 * Get all active equipment pool entries.
 *
 * WHY fallback: Equipment pool has both v1 and v2 data, but falls back
 * to v1 for consistency if the requested version is empty.
 */
export const getEquipmentPool = query({
  args: { datasetVersion: dataVersion },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("equipmentPool")
      .withIndex("by_version_active", (q) =>
        q.eq("datasetVersion", args.datasetVersion).eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("equipmentPool")
      .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
      .collect();
  },
});

// ============================================================================
// WBS MUTATIONS
// ============================================================================

/** Add a single WBS category to a proposal from the pool. */
export const addWBS = mutation({
  args: {
    proposalId: v.id("proposals"),
    wbsPoolId: v.number(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    // Check for duplicate WBS pool ID on this proposal
    const existing = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_pool", (q) =>
        q.eq("proposalId", args.proposalId).eq("wbsPoolId", args.wbsPoolId)
      )
      .first();
    if (existing) throw new Error("WBS category already exists on this proposal");

    // Determine sort order (append after last)
    const allWbs = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    const maxSort = allWbs.length > 0 ? Math.max(...allWbs.map((w) => w.sortOrder)) : 0;

    return ctx.db.insert("wbs", {
      proposalId: args.proposalId,
      wbsPoolId: args.wbsPoolId,
      name: args.name,
      sortOrder: maxSort + 1,
    });
  },
});

/**
 * Delete a WBS and all its phases and activities.
 *
 * WHY: Cascade delete ensures no orphaned phases or activities.
 */
export const deleteWBS = mutation({
  args: { wbsId: v.id("wbs") },
  handler: async (ctx, args) => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    // Delete activities under this WBS
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();
    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }

    // Delete phases under this WBS
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();
    for (const phase of phases) {
      await ctx.db.delete(phase._id);
    }

    await ctx.db.delete(args.wbsId);
  },
});

// ============================================================================
// PHASE MUTATIONS
// ============================================================================

/** Add a new phase to a WBS. */
export const addPhase = mutation({
  args: {
    wbsId: v.id("wbs"),
    phasePoolId: v.number(),
    poolName: v.string(),
    phaseNumber: v.number(),
    description: v.string(),
    area: v.optional(v.string()),
    sheet: v.optional(v.number()),
    pipingSpec: v.optional(v.object(pipingSpecFields)),
  },
  handler: async (ctx, args) => {
    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    // Determine sort order
    const existingPhases = await ctx.db
      .query("phases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", args.wbsId))
      .collect();
    const maxSort =
      existingPhases.length > 0 ? Math.max(...existingPhases.map((p) => p.sortOrder)) : 0;

    return ctx.db.insert("phases", {
      proposalId: wbs.proposalId,
      wbsId: args.wbsId,
      phasePoolId: args.phasePoolId,
      poolName: args.poolName,
      phaseNumber: args.phaseNumber,
      description: args.description,
      area: args.area,
      sheet: args.sheet,
      pipingSpec: args.pipingSpec,
      isCompleted: false,
      sortOrder: maxSort + 1,
    });
  },
});

/** Update phase metadata. */
export const updatePhase = mutation({
  args: {
    phaseId: v.id("phases"),
    description: v.optional(v.string()),
    phaseNumber: v.optional(v.number()),
    area: v.optional(v.string()),
    sheet: v.optional(v.number()),
    pipingSpec: v.optional(v.object(pipingSpecFields)),
    isCompleted: v.optional(v.boolean()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { phaseId, ...fields } = args;
    const existing = await ctx.db.get(phaseId);
    if (!existing) throw new Error("Phase not found");

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(phaseId, patch);
    }
  },
});

/**
 * Delete a phase and all its activities.
 *
 * WHY: Activities hold a phaseId foreign key; deleting the phase
 * without cleaning up activities would create orphans.
 */
export const deletePhase = mutation({
  args: { phaseId: v.id("phases") },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_phase", (q) => q.eq("phaseId", args.phaseId))
      .collect();
    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }

    await ctx.db.delete(args.phaseId);
  },
});

/**
 * Duplicate a phase and all its activities.
 *
 * WHY: Estimators frequently need to create similar phases with the same
 * activity structure. Deep-copying avoids re-entering all line items.
 */
export const duplicatePhase = mutation({
  args: {
    sourcePhaseId: v.id("phases"),
    newPhaseNumber: v.number(),
    newDescription: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sourcePhase = await ctx.db.get(args.sourcePhaseId);
    if (!sourcePhase) throw new Error("Source phase not found");

    // Determine sort order for the new phase
    const existingPhases = await ctx.db
      .query("phases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", sourcePhase.wbsId))
      .collect();
    const maxSort =
      existingPhases.length > 0 ? Math.max(...existingPhases.map((p) => p.sortOrder)) : 0;

    // Create the new phase
    const newPhaseId = await ctx.db.insert("phases", {
      proposalId: sourcePhase.proposalId,
      wbsId: sourcePhase.wbsId,
      phasePoolId: sourcePhase.phasePoolId,
      poolName: sourcePhase.poolName,
      phaseNumber: args.newPhaseNumber,
      description: args.newDescription ?? sourcePhase.description,
      area: sourcePhase.area,
      sheet: sourcePhase.sheet,
      pipingSpec: sourcePhase.pipingSpec,
      isCompleted: false,
      sortOrder: maxSort + 1,
      customQuantity: sourcePhase.customQuantity,
      customUnit: sourcePhase.customUnit,
    });

    // Copy all activities from source phase
    const sourceActivities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.sourcePhaseId))
      .collect();

    for (const activity of sourceActivities) {
      await ctx.db.insert("activities", {
        proposalId: sourcePhase.proposalId,
        wbsId: sourcePhase.wbsId,
        phaseId: newPhaseId,
        type: activity.type,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        sortOrder: activity.sortOrder,
        laborPoolId: activity.laborPoolId,
        equipmentPoolId: activity.equipmentPoolId,
        labor: activity.labor,
        equipment: activity.equipment,
        subcontractor: activity.subcontractor,
        unitPrice: activity.unitPrice,
      });
    }

    return newPhaseId;
  },
});

/**
 * Copy activities from one phase to another.
 *
 * WHY: Enables reusing activity sets across phases without
 * duplicating the entire phase structure.
 */
export const copyActivitiesToPhase = mutation({
  args: {
    sourcePhaseId: v.id("phases"),
    targetPhaseId: v.id("phases"),
  },
  handler: async (ctx, args) => {
    const sourcePhase = await ctx.db.get(args.sourcePhaseId);
    if (!sourcePhase) throw new Error("Source phase not found");

    const targetPhase = await ctx.db.get(args.targetPhaseId);
    if (!targetPhase) throw new Error("Target phase not found");

    // Get existing activities in target to determine sortOrder offset
    const targetActivities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.targetPhaseId))
      .collect();
    const maxSort =
      targetActivities.length > 0 ? Math.max(...targetActivities.map((a) => a.sortOrder)) : 0;

    const sourceActivities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.sourcePhaseId))
      .collect();

    const insertedIds: Id<"activities">[] = [];
    for (let i = 0; i < sourceActivities.length; i++) {
      const activity = sourceActivities[i];
      const id = await ctx.db.insert("activities", {
        proposalId: targetPhase.proposalId,
        wbsId: targetPhase.wbsId,
        phaseId: args.targetPhaseId,
        type: activity.type,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        sortOrder: maxSort + i + 1,
        laborPoolId: activity.laborPoolId,
        equipmentPoolId: activity.equipmentPoolId,
        labor: activity.labor,
        equipment: activity.equipment,
        subcontractor: activity.subcontractor,
        unitPrice: activity.unitPrice,
      });
      insertedIds.push(id);
    }

    return insertedIds;
  },
});

// ============================================================================
// ACTIVITY MUTATIONS (Phase 4 — brought forward since validators are ready)
// ============================================================================

/** Add an activity to a phase. */
export const addActivity = mutation({
  args: {
    phaseId: v.id("phases"),
    type: activityType,
    description: v.string(),
    quantity: v.number(),
    unit: v.string(),
    laborPoolId: v.optional(v.number()),
    equipmentPoolId: v.optional(v.number()),
    labor: v.optional(v.object(laborFields)),
    equipment: v.optional(v.object(equipmentFields)),
    subcontractor: v.optional(v.object(subcontractorFields)),
    unitPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    // Determine sort order
    const existing = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.phaseId))
      .collect();
    const maxSort = existing.length > 0 ? Math.max(...existing.map((a) => a.sortOrder)) : 0;

    return ctx.db.insert("activities", {
      proposalId: phase.proposalId,
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
    });
  },
});

/** Update an activity's fields. */
export const updateActivity = mutation({
  args: {
    activityId: v.id("activities"),
    description: v.optional(v.string()),
    quantity: v.optional(v.number()),
    unit: v.optional(v.string()),
    labor: v.optional(v.object(laborFields)),
    equipment: v.optional(v.object(equipmentFields)),
    subcontractor: v.optional(v.object(subcontractorFields)),
    unitPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { activityId, ...fields } = args;
    const existing = await ctx.db.get(activityId);
    if (!existing) throw new Error("Activity not found");

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(activityId, patch);
    }
  },
});

/** Batch delete multiple activities. */
export const batchDeleteActivities = mutation({
  args: { activityIds: v.array(v.id("activities")) },
  handler: async (ctx, args) => {
    for (const activityId of args.activityIds) {
      const activity = await ctx.db.get(activityId);
      if (activity) {
        await ctx.db.delete(activityId);
      }
    }
  },
});

/** Reorder activities within a phase. */
export const reorderActivities = mutation({
  args: {
    phaseId: v.id("phases"),
    orderedActivityIds: v.array(v.id("activities")),
  },
  handler: async (ctx, args) => {
    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    for (let i = 0; i < args.orderedActivityIds.length; i++) {
      await ctx.db.patch(args.orderedActivityIds[i], { sortOrder: i + 1 });
    }
  },
});

// ============================================================================
// DUPLICATE PROPOSAL
// ============================================================================

/**
 * Deep-copy a proposal with all WBS, phases, and activities.
 *
 * WHY: Estimators frequently create new proposals based on existing ones.
 * This mutation copies the entire tree in a single transaction with
 * proper ID remapping at every level.
 */
export const duplicateProposal = mutation({
  args: {
    sourceProposalId: v.id("proposals"),
    newProposalNumber: v.string(),
    newDescription: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceProposalId);
    if (!source) throw new Error("Source proposal not found");

    // Create the new proposal
    const newProposalId = await ctx.db.insert("proposals", {
      proposalNumber: args.newProposalNumber,
      description: args.newDescription ?? source.description,
      ownerName: source.ownerName,
      contactId: source.contactId,
      status: "bidding",
      bidType: source.bidType,
      projectAddress: source.projectAddress,
      jobSiteAddress: source.jobSiteAddress,
      estimators: source.estimators,
      dateReceived: source.dateReceived,
      dateDue: source.dateDue,
      projectStartDate: source.projectStartDate,
      projectEndDate: source.projectEndDate,
      jobNumber: source.jobNumber,
      changeOrderNumber: source.changeOrderNumber,
      rates: source.rates,
      datasetVersion: source.datasetVersion,
      customQuantity: source.customQuantity,
      customUnit: source.customUnit,
    });

    // Copy WBS items — build ID mapping
    const sourceWBS = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.sourceProposalId))
      .collect();

    const wbsIdMap = new Map<string, Id<"wbs">>();
    for (const wbs of sourceWBS) {
      const newWbsId = await ctx.db.insert("wbs", {
        proposalId: newProposalId,
        wbsPoolId: wbs.wbsPoolId,
        name: wbs.name,
        sortOrder: wbs.sortOrder,
        customQuantity: wbs.customQuantity,
        customUnit: wbs.customUnit,
      });
      wbsIdMap.set(wbs._id as string, newWbsId);
    }

    // Copy phases — build ID mapping
    const sourcePhases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.sourceProposalId))
      .collect();

    const phaseIdMap = new Map<string, Id<"phases">>();
    for (const phase of sourcePhases) {
      const newWbsId = wbsIdMap.get(phase.wbsId as string);
      if (!newWbsId) continue;

      const newPhaseId = await ctx.db.insert("phases", {
        proposalId: newProposalId,
        wbsId: newWbsId,
        phasePoolId: phase.phasePoolId,
        poolName: phase.poolName,
        phaseNumber: phase.phaseNumber,
        description: phase.description,
        area: phase.area,
        sheet: phase.sheet,
        pipingSpec: phase.pipingSpec,
        status: phase.status,
        isCompleted: false,
        sortOrder: phase.sortOrder,
        customQuantity: phase.customQuantity,
        customUnit: phase.customUnit,
      });
      phaseIdMap.set(phase._id as string, newPhaseId);
    }

    // Copy all activities with remapped IDs
    const sourceActivities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.sourceProposalId))
      .collect();

    for (const activity of sourceActivities) {
      const newWbsId = wbsIdMap.get(activity.wbsId as string);
      const newPhaseId = phaseIdMap.get(activity.phaseId as string);
      if (!newWbsId || !newPhaseId) continue;

      await ctx.db.insert("activities", {
        proposalId: newProposalId,
        wbsId: newWbsId,
        phaseId: newPhaseId,
        type: activity.type,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        sortOrder: activity.sortOrder,
        laborPoolId: activity.laborPoolId,
        equipmentPoolId: activity.equipmentPoolId,
        labor: activity.labor,
        equipment: activity.equipment,
        subcontractor: activity.subcontractor,
        unitPrice: activity.unitPrice,
      });
    }

    return newProposalId;
  },
});

// ============================================================================
// EXPORT QUERY
// ============================================================================

/**
 * Get complete export data for a proposal with all computed costs.
 *
 * WHY: The Excel export needs every activity with its costs, organized
 * by WBS and phase. This single query provides the entire payload
 * with server-side computation to keep the export accurate.
 */
export const getExportData = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Build lookup maps
    const phasesByWBS = new Map<string, Doc<"phases">[]>();
    for (const phase of phases) {
      const key = phase.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(phase);
      phasesByWBS.set(key, list);
    }

    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const activity of activities) {
      const key = activity.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(activity);
      activitiesByPhase.set(key, list);
    }

    // Build hierarchical export structure with computed costs
    const exportWBS = wbsItems.map((wbs) => {
      const wbsPhases = (phasesByWBS.get(wbs._id as string) ?? []).sort(
        (a, b) => a.sortOrder - b.sortOrder
      );

      const wbsAcc = zeroCosts();

      const exportPhases = wbsPhases.map((phase) => {
        const phaseActivities = (activitiesByPhase.get(phase._id as string) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder
        );

        const phaseAcc = zeroCosts();

        const exportActivities = phaseActivities.map((activity) => {
          const costs = computeActivityCosts(activity, rates);
          accumulateCosts(phaseAcc, costs);
          return {
            _id: activity._id,
            type: activity.type,
            description: activity.description,
            quantity: activity.quantity,
            unit: activity.unit,
            costs: roundAccumulator({
              ...costs,
              craftManHours: costs.craftManHours,
              welderManHours: costs.welderManHours,
              craftCost: costs.craftCost,
              welderCost: costs.welderCost,
              materialCost: costs.materialCost,
              equipmentCost: costs.equipmentCost,
              subcontractorCost: costs.subcontractorCost,
              costOnlyCost: costs.costOnlyCost,
              totalCost: costs.totalCost,
            }),
          };
        });

        accumulateCosts(wbsAcc, phaseAcc);

        return {
          _id: phase._id,
          phaseNumber: phase.phaseNumber,
          description: phase.description,
          poolName: phase.poolName,
          activities: exportActivities,
          costs: roundAccumulator(phaseAcc),
        };
      });

      return {
        _id: wbs._id,
        name: wbs.name,
        wbsPoolId: wbs.wbsPoolId,
        phases: exportPhases,
        costs: roundAccumulator(wbsAcc),
      };
    });

    // Grand totals
    const grandTotal = zeroCosts();
    for (const wbs of exportWBS) {
      accumulateCosts(grandTotal, wbs.costs);
    }

    return {
      proposal: {
        proposalNumber: proposal.proposalNumber,
        description: proposal.description,
        ownerName: proposal.ownerName,
        status: proposal.status,
        bidType: proposal.bidType,
        rates: proposal.rates,
      },
      wbs: exportWBS,
      totals: roundAccumulator(grandTotal),
      activityCount: activities.length,
      phaseCount: phases.length,
      wbsCount: wbsItems.length,
    };
  },
});
