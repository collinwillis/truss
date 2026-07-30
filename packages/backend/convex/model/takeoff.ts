/**
 * Phase takeoff quantities — the "86 CY" / "1,200 LF" headline on a phase.
 *
 * D-takeoff: the quantity DERIVES from lines flagged in the labor catalog
 * (`laborPool.countsTowardTakeoff`, seeded from InDemand's phase-maintenance
 * workbook), and the estimator may ALWAYS override it per phase.
 *
 * WHY flags instead of legacy's description matching: measured on production
 * proposal 2020, summing every same-unit line double-counts concrete 2×
 * (pour + clean-up both carry CY) and up to 28× on foundation phases, while
 * `.includes("HE")` matched unrelated words. The business's own workbook
 * names exact catalog lines per phase; flags are that knowledge as data.
 *
 * WHY `customQuantity` is the override slot: it is the legacy override field,
 * already synced from Firestore and populated on ~10% of production phases —
 * estimators actively use it. D3 semantics apply: absent = derived, any
 * present value (including 0) = an explicit override, clearing writes the
 * field away.
 *
 * @module
 */

/** The fields of a phase this module reads. */
export interface TakeoffPhase {
  phasePoolId: number;
  customQuantity?: number;
  customUnit?: string;
}

/** The fields of an activity this module reads. */
export interface TakeoffActivity {
  laborPoolId?: number;
  countsTowardTakeoff?: boolean;
  quantity: number;
}

/** Catalog knowledge needed to derive takeoffs, prefetched by the caller. */
export interface TakeoffCatalog {
  /** `phasePool.poolId` → takeoff unit, for pools that have one. */
  unitByPhasePool: ReadonlyMap<number, string>;
  /** `laborPool.poolId`s flagged `countsTowardTakeoff`. */
  flaggedLaborPoolIds: ReadonlySet<number>;
}

/** A phase's takeoff as displayed; `null` means "no takeoff — show a dash". */
export interface PhaseTakeoff {
  quantity: number;
  unit: string;
  /** True when `customQuantity` is set — the UI renders overrides distinctly. */
  isOverridden: boolean;
}

/**
 * Whether one activity's quantity counts toward its phase's takeoff.
 *
 * The activity's own flag wins when present (the estimator's explicit call,
 * and the only mechanism custom lines have); otherwise the catalog decides.
 */
export function activityCountsTowardTakeoff(
  activity: TakeoffActivity,
  catalog: TakeoffCatalog
): boolean {
  if (activity.countsTowardTakeoff !== undefined) return activity.countsTowardTakeoff;
  if (activity.laborPoolId === undefined) return false;
  return catalog.flaggedLaborPoolIds.has(activity.laborPoolId);
}

/**
 * Compute a phase's takeoff.
 *
 * Precedence: explicit override (`customQuantity`) → derived sum of flagged
 * lines → `null` when the phase's pool has no takeoff unit and nothing was
 * overridden. `customUnit` is honoured when present (legacy escape hatch;
 * unused in production today) and otherwise the unit comes from the catalog.
 */
export function computePhaseTakeoff(
  phase: TakeoffPhase,
  activities: readonly TakeoffActivity[],
  catalog: TakeoffCatalog
): PhaseTakeoff | null {
  const catalogUnit = catalog.unitByPhasePool.get(phase.phasePoolId);
  const unit = phase.customUnit ?? catalogUnit ?? "";

  if (phase.customQuantity !== undefined) {
    return { quantity: phase.customQuantity, unit, isOverridden: true };
  }

  if (catalogUnit === undefined && phase.customUnit === undefined) return null;

  let quantity = 0;
  for (const activity of activities) {
    if (activityCountsTowardTakeoff(activity, catalog)) quantity += activity.quantity;
  }
  return { quantity, unit, isOverridden: false };
}
