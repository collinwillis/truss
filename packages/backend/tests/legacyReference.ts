/**
 * A faithful transcription of the LIVE legacy MCP Estimator cost engine.
 *
 * WHY THIS EXISTS: pinning a handful of expected numbers proves the engine
 * matches legacy on the inputs someone thought to write down. Transcribing
 * legacy independently and differential-testing the two across a generated input
 * space proves it matches everywhere — including the corners nobody enumerated.
 * That is the difference between a regression test and a parity proof.
 *
 * SOURCES — transcribed line for line, deliberately keeping legacy's structure
 * and its quirks rather than tidying them:
 *   - `mcp_estimator/src/api/totals.ts`   (getCraftLoadedRate, getWelderLoadedRate,
 *                                          getMaterialCost, getEquipmentCost,
 *                                          getSubcontractorCost, getCostOnlyCost,
 *                                          getTotalCost)
 *   - `mcp_estimator/src/api/activity.ts` (calculateActivityData, lines 470-567)
 *
 * NOT a source: `mcp_estimator/src/utils/calculations.ts`. It has zero importers
 * and carries a different welder formula. See the note in `../costEngine.ts`.
 *
 * TEST-ONLY. Never import this from production code.
 */

import type { ActivityInput, ActivityCosts, ProposalRates } from "../convex/model/costEngine";

/**
 * Legacy `getCraftLoadedRate`.
 *
 * Note the `||` on both overrides — this is why a stored `0` inherits the
 * proposal rate rather than meaning "$0/hr".
 */
function legacyCraftLoadedRate(
  rates: ProposalRates,
  customCraftBaseRate = 0,
  customSubsistenceRate = 0
): number {
  const craftBase = customCraftBaseRate || rates.craftBaseRate;
  const subsistence = customSubsistenceRate || rates.subsistenceRate;

  return (
    craftBase +
    (craftBase *
      (rates.burdenRate +
        rates.overheadRate +
        rates.laborProfitRate +
        rates.fuelRate +
        rates.consumablesRate)) /
      100 +
    subsistence
  );
}

/**
 * Legacy `getWelderLoadedRate`.
 *
 * `rigProfitRate` multiplies `rigRate` only — it is absent from the base markup.
 */
function legacyWelderLoadedRate(rates: ProposalRates): number {
  return (
    rates.weldBaseRate +
    (rates.weldBaseRate *
      (rates.burdenRate +
        rates.overheadRate +
        rates.laborProfitRate +
        rates.fuelRate +
        rates.consumablesRate)) /
      100 +
    rates.subsistenceRate +
    rates.rigRate +
    (rates.rigRate * rates.rigProfitRate) / 100
  );
}

/**
 * Legacy `calculateActivityData`, reduced to the cost fields.
 *
 * The ordering of the guards below is legacy's, not a tidied version of it:
 * craft cost is skipped for subcontractor lines, welder cost is computed for
 * every type unconditionally, and only a subcontractor line's total departs from
 * the sum of components.
 */
export function legacyComputeActivityCosts(
  activity: ActivityInput,
  rates: ProposalRates
): ActivityCosts {
  const quantity = activity.quantity ?? 0;
  const craftConstant = activity.labor?.craftConstant ?? 0;
  const welderConstant = activity.labor?.welderConstant ?? 0;

  const cmh = quantity * craftConstant;
  const wmh = quantity * welderConstant;

  // calculateActivityData:514-518 — `??` at the model layer, so a stored 0
  // survives to the rate layer, where `||` turns it into "inherit".
  const activityCraftBaseRate = activity.labor?.customCraftRate ?? rates.craftBaseRate;
  const activitySubsistenceRate = activity.labor?.customSubsistenceRate ?? rates.subsistenceRate;

  const craftLoadedRate = legacyCraftLoadedRate(
    rates,
    activityCraftBaseRate ?? 0,
    activitySubsistenceRate ?? 0
  );
  const welderLoadedRate = legacyWelderLoadedRate(rates);

  const costs: ActivityCosts = {
    craftManHours: cmh,
    welderManHours: wmh,
    craftCost: 0,
    welderCost: 0,
    materialCost: 0,
    equipmentCost: 0,
    subcontractorCost: 0,
    costOnlyCost: 0,
    totalCost: 0,
  };

  // activity.ts:533-535
  if (activity.type !== "subcontractor") {
    costs.craftCost = cmh * craftLoadedRate;
  }

  // activity.ts:536-541 — getEquipmentCost
  if (activity.type === "equipment") {
    const quantityTimePrice =
      quantity * (activity.equipment?.time ?? 0) * (activity.unitPrice ?? 0);
    costs.equipmentCost =
      activity.equipment?.ownership === "owned"
        ? quantityTimePrice
        : quantityTimePrice * (1 + (rates.equipmentProfitRate + rates.useTaxRate) / 100);
  }

  // activity.ts:542-547 — getMaterialCost
  if (activity.type === "material") {
    costs.materialCost =
      quantity *
      (activity.unitPrice ?? 0) *
      (1 + (rates.materialProfitRate + rates.salesTaxRate) / 100);
  }

  // activity.ts:548 — unconditional, every type
  costs.welderCost = wmh * welderLoadedRate;

  // activity.ts:550-554 — getCostOnlyCost
  if (activity.type === "cost_only") {
    costs.costOnlyCost = quantity * (activity.unitPrice ?? 0);
  }

  // activity.ts:555-560 — getSubcontractorCost.
  // Legacy reads the activity's raw craftCost/materialCost/equipmentCost fields;
  // `sync/fieldMapping.ts` maps those onto `subcontractor.{labor,material,equipment}Cost`.
  if (activity.type === "subcontractor") {
    const subProfit = rates.subcontractorProfitRate / 100;
    const salesTax = rates.salesTaxRate / 100;
    costs.subcontractorCost =
      quantity *
      ((activity.subcontractor?.laborCost ?? 0) * (1 + subProfit) +
        (activity.subcontractor?.materialCost ?? 0) * (1 + subProfit + salesTax) +
        (activity.subcontractor?.equipmentCost ?? 0) * (1 + subProfit));
  }

  // activity.ts:561-565 — getTotalCost, except for subcontractor
  if (activity.type !== "subcontractor") {
    costs.totalCost =
      costs.craftCost +
      costs.welderCost +
      costs.materialCost +
      costs.equipmentCost +
      costs.subcontractorCost +
      costs.costOnlyCost;
  } else {
    costs.totalCost = costs.subcontractorCost;
  }

  return costs;
}

export { legacyCraftLoadedRate, legacyWelderLoadedRate };
