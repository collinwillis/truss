/**
 * Cost engine — the single source of truth for Precision's estimating math.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `precision.ts`:
 * The legacy MCP Estimator's most expensive bug class was formula duplication.
 * It grew three implementations of the same math — `src/api/totals.ts` (live),
 * `src/utils/calculations.ts` (dead, and carrying a *different* welder formula),
 * and `src/api/data_dump.ts` (the Excel export) — which drifted until the bid
 * sheet no longer tied to the screen. Keeping the engine in one dependency-free
 * module, typed over plain inputs rather than `Doc<"activities">`, means it can
 * be unit-tested in plain Node and imported by every consumer (queries,
 * optimistic client updates, paste preview, export) without anyone being
 * tempted to write a second copy.
 *
 * ── REFERENCE HYGIENE — READ BEFORE "FIXING" A FORMULA ──────────────────────
 * The authoritative legacy engine is `mcp_estimator/src/api/totals.ts` together
 * with `calculateActivityData()` in `mcp_estimator/src/api/activity.ts`.
 *
 * `mcp_estimator/src/utils/calculations.ts` is DEAD CODE with zero importers and
 * a different welder formula. Do not use it as a reference. Two independent
 * audit passes "found" a `rigProfitRate` bug by reading it; acting on that would
 * have overstated every welder hour by `weldBaseRate x rigProfitRate / 100`.
 *
 * `work_log_items_library.txt` and `timesheet_*.txt` at the legacy repo root are
 * a fabricated phrase library for filling out billing timesheets. They describe
 * bugs that never existed. Never mine them for requirements.
 *
 * @see docs/precision/audit/ROADMAP.md §0 for the full correction record.
 */

/**
 * Version stamp for the cost engine's semantics.
 *
 * WHY: rates and formulas both affect historical bids. Stamping the version a
 * proposal was priced under means a future formula correction can be applied to
 * new estimates without silently re-pricing bids that were already submitted.
 *
 * Bump this whenever a change alters the number produced for any existing input.
 *
 * - v1: legacy MCP Estimator semantics with per-step rounding (pre-M0).
 * - v2: full-precision arithmetic, rounding only at the display boundary.
 * - v3: a per-activity rate override of `0` means $0.00/hr. Only absence
 *   inherits the proposal rate. Unobservable on data imported before this
 *   version — see {@link resolveRateOverride}.
 */
export const CALC_VERSION = 3;

/** The six activity types an estimate line can take. */
export type ActivityType =
  | "labor"
  | "custom_labor"
  | "material"
  | "equipment"
  | "subcontractor"
  | "cost_only";

/** How a piece of equipment is held, which determines whether markup applies. */
export type EquipmentOwnership = "rental" | "owned" | "purchase";

/**
 * The fifteen proposal-level rates that drive every cost in an estimate.
 *
 * Every dollar Precision reports is a pure function of these plus the activity's
 * own quantities, which is what makes rate preview (`previewProposalTotals`)
 * cheap: it is the same scan with a different second argument.
 */
export interface ProposalRates {
  craftBaseRate: number;
  weldBaseRate: number;
  rigRate: number;
  subsistenceRate: number;
  burdenRate: number;
  overheadRate: number;
  laborProfitRate: number;
  fuelRate: number;
  consumablesRate: number;
  salesTaxRate: number;
  useTaxRate: number;
  materialProfitRate: number;
  equipmentProfitRate: number;
  subcontractorProfitRate: number;
  rigProfitRate: number;
}

/** Labor constants and optional per-activity rate overrides. */
export interface ActivityLaborInput {
  craftConstant: number;
  welderConstant: number;
  /** Overrides the proposal's craftBaseRate. See {@link resolveRateOverride}. */
  customCraftRate?: number | null;
  /** Overrides the proposal's subsistenceRate. See {@link resolveRateOverride}. */
  customSubsistenceRate?: number | null;
}

/** Equipment holding and duration. */
export interface ActivityEquipmentInput {
  ownership: EquipmentOwnership;
  time: number;
}

/**
 * Subcontractor cost inputs.
 *
 * WHY `laborCost` rather than `craftCost`: legacy stored the sub's labor figure
 * in the activity's `craftCost` field and read it back in `getSubcontractorCost`,
 * relying on the fact that `craftCost` is only overwritten for non-subcontractor
 * types. `sync/fieldMapping.ts` maps `fs.craftCost -> subcontractor.laborCost`,
 * which preserves the semantics under an honest name.
 */
export interface ActivitySubcontractorInput {
  laborCost: number;
  materialCost: number;
  equipmentCost: number;
}

/**
 * The minimum shape the engine needs to price a line.
 *
 * Deliberately structural rather than `Doc<"activities">` so the engine has no
 * Convex dependency and runs in a plain test process. A `Doc<"activities">`
 * satisfies this interface as-is.
 */
export interface ActivityInput {
  type: ActivityType;
  quantity: number;
  unitPrice?: number | null;
  labor?: ActivityLaborInput | null;
  equipment?: ActivityEquipmentInput | null;
  subcontractor?: ActivitySubcontractorInput | null;
}

/** Every cost component the engine produces for a single activity. */
export interface ActivityCosts {
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

/**
 * Round to two decimal places.
 *
 * WHY THIS IS NOT USED INSIDE THE ENGINE: the legacy engine rounds nowhere, and
 * rounding intermediates changes the answer. Precision previously rounded at
 * nine separate points, including man-hours *before* costing — and man-hours are
 * themselves a displayed and reported quantity, so that introduced a visible
 * divergence from legacy independent of any cost difference.
 *
 * Call this at the display or accumulator boundary, never between steps.
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolve a per-activity rate override against the proposal-level rate.
 *
 * ABSENT means inherit. `0` is a real override worth $0.00/hr.
 *
 * WHY THIS DIVERGES FROM LEGACY — the one deliberate behavioural difference in
 * this engine. Legacy composed `??` at the model layer (`calculateActivityData`
 * line 514) with `||` at the rate layer (`getCraftLoadedRate` line 26), so a
 * stored `0` silently fell through to the proposal rate. That makes zero
 * unrepresentable: legacy cannot express "labor on this line is free", which is a
 * real situation — warranty rework, donated labor, labor carried on another line.
 *
 * A sentinel inside the valid data range is the anti-pattern. "Inherit" is a
 * distinct state, so it gets a distinct representation — absence — rather than
 * stealing a number the user might legitimately want to type.
 *
 * Safe to change because it is unobservable on existing data:
 * `sync/fieldMapping.ts` only stores an override when the source value is
 * non-zero, so no stored zero exists across the 713 production proposals.
 *
 * CONTRACT FOR THE M4 OVERRIDE COLUMNS:
 * - render the inherited proposal rate as a placeholder, visually distinct from a
 *   typed value, so "inherited" is never something the user has to guess at;
 * - an explicit reset (clearing the field) writes `null`, never `0`;
 * - the mutation arg must be `v.union(v.number(), v.null())` so "clear the
 *   override" is distinguishable from "leave this field alone".
 *
 * @see docs/precision/DECISIONS.md D3
 */
function resolveRateOverride(override: number | null | undefined, proposalRate: number): number {
  return override ?? proposalRate;
}

/**
 * Compute the fully loaded hourly rate for craft labor.
 *
 * `craftBase + craftBase x (burden + overhead + laborProfit + fuel + consumables) / 100 + subsistence`
 *
 * Both the base rate and subsistence accept per-activity overrides.
 */
export function computeCraftLoadedRate(
  rates: ProposalRates,
  customCraftRate?: number | null,
  customSubsistenceRate?: number | null
): number {
  const craftBase = resolveRateOverride(customCraftRate, rates.craftBaseRate);
  const subsistence = resolveRateOverride(customSubsistenceRate, rates.subsistenceRate);
  return craftBase + (craftBase * markupPercent(rates)) / 100 + subsistence;
}

/**
 * Compute the fully loaded hourly rate for welder labor.
 *
 * `weldBase + weldBase x (burden + overhead + laborProfit + fuel + consumables) / 100
 *  + subsistence + rig + rig x rigProfit / 100`
 *
 * WHY `rigProfitRate` is absent from the base markup: it applies only to the rig
 * leg. This matches `getWelderLoadedRate` in the live legacy engine. The dead
 * `calculations.ts` disagrees; it is wrong. See the reference-hygiene note at the
 * top of this file before changing anything here.
 *
 * Welder labor takes no per-activity overrides — legacy offers none.
 */
export function computeWelderLoadedRate(rates: ProposalRates): number {
  return (
    rates.weldBaseRate +
    (rates.weldBaseRate * markupPercent(rates)) / 100 +
    rates.subsistenceRate +
    rates.rigRate +
    (rates.rigRate * rates.rigProfitRate) / 100
  );
}

/**
 * The five markup rates applied to both craft and welder base rates, summed as a
 * percentage.
 *
 * WHY A PERCENTAGE RATHER THAN A MULTIPLIER: callers must compute
 * `(base * percent) / 100`, not `base * (percent / 100)`. Those are not the same
 * in IEEE-754 — they differ in the last bits — and legacy uses the former. The
 * golden suite asserts *exact* equality with the legacy engine, so operation
 * order is part of the contract, not an implementation detail.
 */
function markupPercent(rates: ProposalRates): number {
  return (
    rates.burdenRate +
    rates.overheadRate +
    rates.laborProfitRate +
    rates.fuelRate +
    rates.consumablesRate
  );
}

/**
 * Price a single activity.
 *
 * Mirrors legacy `calculateActivityData()` exactly, including two behaviours that
 * look like bugs but are load-bearing:
 *
 * 1. **Welder cost accrues on every type, including subcontractor.** Legacy
 *    computes it unconditionally. It is excluded from a subcontractor line's
 *    total by rule 2, but it still counts toward man-hour rollups.
 * 2. **A subcontractor line's total is its subcontractor cost alone**, not the
 *    sum of components — unlike every other type, which sums all six.
 *
 * Craft cost is the one component legacy skips for subcontractor lines.
 *
 * No value is rounded. See {@link round2}.
 */
export function computeActivityCosts(activity: ActivityInput, rates: ProposalRates): ActivityCosts {
  const qty = activity.quantity;
  const isSubcontractor = activity.type === "subcontractor";

  const craftManHours = qty * (activity.labor?.craftConstant ?? 0);
  const welderManHours = qty * (activity.labor?.welderConstant ?? 0);

  const craftLoaded = computeCraftLoadedRate(
    rates,
    activity.labor?.customCraftRate,
    activity.labor?.customSubsistenceRate
  );

  const costs: ActivityCosts = {
    craftManHours,
    welderManHours,
    craftCost: isSubcontractor ? 0 : craftManHours * craftLoaded,
    welderCost: welderManHours * computeWelderLoadedRate(rates),
    materialCost: 0,
    equipmentCost: 0,
    subcontractorCost: 0,
    costOnlyCost: 0,
    totalCost: 0,
  };

  switch (activity.type) {
    case "material": {
      const markup = 1 + (rates.materialProfitRate + rates.salesTaxRate) / 100;
      costs.materialCost = qty * (activity.unitPrice ?? 0) * markup;
      break;
    }

    case "equipment": {
      const base = qty * (activity.equipment?.time ?? 0) * (activity.unitPrice ?? 0);
      // Owned equipment carries no profit and no use tax — the company already
      // owns it, so there is nothing to mark up and nothing to tax.
      costs.equipmentCost =
        activity.equipment?.ownership === "owned"
          ? base
          : base * (1 + (rates.equipmentProfitRate + rates.useTaxRate) / 100);
      break;
    }

    case "subcontractor": {
      const sub = activity.subcontractor;
      const profit = rates.subcontractorProfitRate / 100;
      const salesTax = rates.salesTaxRate / 100;
      // Only the material leg is taxed; labor and equipment take profit alone.
      costs.subcontractorCost =
        qty *
        ((sub?.laborCost ?? 0) * (1 + profit) +
          (sub?.materialCost ?? 0) * (1 + profit + salesTax) +
          (sub?.equipmentCost ?? 0) * (1 + profit));
      break;
    }

    case "cost_only": {
      costs.costOnlyCost = qty * (activity.unitPrice ?? 0);
      break;
    }

    case "labor":
    case "custom_labor":
      // Labor lines carry no type-specific cost beyond craft and welder.
      break;
  }

  costs.totalCost = isSubcontractor
    ? costs.subcontractorCost
    : costs.craftCost +
      costs.welderCost +
      costs.materialCost +
      costs.equipmentCost +
      costs.subcontractorCost +
      costs.costOnlyCost;

  return costs;
}

/** A zeroed cost struct, for accumulator seeds. */
export function emptyCosts(): ActivityCosts {
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

/**
 * Accumulate one activity's costs into a running total, in place.
 *
 * WHY IN PLACE: rollups run over every activity in a proposal — up to ~11k on the
 * largest live estimate — and allocating a fresh struct per line is measurable.
 */
export function addCosts(target: ActivityCosts, source: ActivityCosts): void {
  target.craftManHours += source.craftManHours;
  target.welderManHours += source.welderManHours;
  target.craftCost += source.craftCost;
  target.welderCost += source.welderCost;
  target.materialCost += source.materialCost;
  target.equipmentCost += source.equipmentCost;
  target.subcontractorCost += source.subcontractorCost;
  target.costOnlyCost += source.costOnlyCost;
  target.totalCost += source.totalCost;
}

/**
 * Round every field of a cost struct for display.
 *
 * Call once, at the boundary where numbers leave the engine for a screen or a
 * report — never between accumulation steps.
 */
export function roundCosts(costs: ActivityCosts): ActivityCosts {
  return {
    craftManHours: round2(costs.craftManHours),
    welderManHours: round2(costs.welderManHours),
    craftCost: round2(costs.craftCost),
    welderCost: round2(costs.welderCost),
    materialCost: round2(costs.materialCost),
    equipmentCost: round2(costs.equipmentCost),
    subcontractorCost: round2(costs.subcontractorCost),
    costOnlyCost: round2(costs.costOnlyCost),
    totalCost: round2(costs.totalCost),
  };
}
