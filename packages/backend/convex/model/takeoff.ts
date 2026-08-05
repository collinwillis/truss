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

/**
 * Roll a WBS's takeoff up from the phases beneath it.
 *
 * ⚠️ REFUSES WHEN THE UNITS DISAGREE, and that refusal is the whole design.
 * A breakdown spans phases measured in different things — measured on
 * production, 111 of 115 WBS carrying takeoff-bearing phases use ONE unit and
 * 4 mix (every one of them `CY + EA`). Adding cubic yards to each is not a
 * quantity, it is a number with no meaning, and a screen showing it would be
 * read as a takeoff by somebody pricing work.
 *
 * Same discipline as {@link computePhaseTakeoff}, which returns null rather
 * than zero when a phase type has no takeoff at all: a dash says "there is no
 * answer here", and a zero says "the answer is none". They are different
 * statements and only one of them is true.
 *
 * `isOverridden` rides up when ANY contributing phase was overridden by hand,
 * because the total is then partly somebody's judgement rather than wholly
 * derived, and the screen owes the reader that.
 */
export function rollUpWbsTakeoff(
  phaseTakeoffs: readonly (PhaseTakeoff | null)[]
): (PhaseTakeoff & { readonly mixedUnits: boolean }) | null {
  const present = phaseTakeoffs.filter((t): t is PhaseTakeoff => t !== null);
  if (present.length === 0) return null;

  const units = new Set(present.map((t) => t.unit));
  if (units.size > 1) {
    // Named rather than silently dropped: the screen says "mixed" so nobody
    // wonders whether the breakdown simply has no takeoff.
    return { quantity: 0, unit: "", isOverridden: false, mixedUnits: true };
  }

  let quantity = 0;
  let isOverridden = false;
  for (const t of present) {
    quantity += t.quantity;
    if (t.isOverridden) isOverridden = true;
  }
  return { quantity, unit: present[0]!.unit, isOverridden, mixedUnits: false };
}
