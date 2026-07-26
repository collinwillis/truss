/**
 * Who may carry a per-activity rate override.
 *
 * An activity can override the proposal's `craftBaseRate` and `subsistenceRate`
 * only when the person doing the work is not craft. Confirmed with Collin as real
 * business policy, not accidental legacy behaviour — see docs/precision/DECISIONS.md D6.
 *
 * WHY THE RULE READS AS THREE ARBITRARY CONDITIONS: it isn't arbitrary once the
 * pool ids are resolved to names. Every eligible case is a labor-standby or
 * support role paid at a different rate than a pipefitter:
 *
 *   - `custom_labor`        — hand-entered line; the estimator is already
 *                            specifying the work, so they specify the rate too
 *   - WBS 200000            — SUPPORT
 *   - phase pool 180002     — FIREWATCH
 *   - phase pool 180003     — MANWATCH
 *   - phase pool 180004     — TOOLS & EQUIPMENT RUNNER
 *
 * WHY THIS LIVES IN ITS OWN MODULE: the rule is a domain constraint, so it must
 * be enforced on the server and merely *reflected* in the UI. Legacy implemented
 * it twice — `activity_data_grid.tsx:552` and `edit_base_rate_dialog.tsx:46` —
 * with no server-side check at all, so the restriction was advisory and a client
 * could ignore it. One tested predicate, imported by both the mutation and the
 * read that feeds the grid.
 */

/** The SUPPORT work breakdown structure. Any activity under it may override. */
export const SUPPORT_WBS_POOL_ID = 200000;

/**
 * Phase types whose activities may override, by pool id.
 *
 * All three sit under WBS 180000 (SPECIALTY SERVICES) and all three are standby
 * roles rather than craft work.
 */
export const OVERRIDE_ELIGIBLE_PHASE_POOL_IDS: ReadonlySet<number> = new Set([
  180002, // FIREWATCH
  180003, // MANWATCH
  180004, // TOOLS & EQUIPMENT RUNNER
]);

/** The minimum context needed to decide eligibility. */
export interface RateOverrideContext {
  /** The activity's own type. */
  activityType: string;
  /** `wbsPoolId` of the WBS the activity's phase belongs to. */
  wbsPoolId: number;
  /** `phasePoolId` of the phase the activity belongs to. */
  phasePoolId: number;
}

/**
 * Whether this activity may carry `customCraftRate` / `customSubsistenceRate`.
 *
 * Eligibility is a property of the activity *in its position* — the type is the
 * activity's own, but the other two conditions come from its phase and WBS, so
 * moving an activity can change whether its override is legal. Callers that move
 * activities between phases must re-check.
 */
export function canOverrideRates(context: RateOverrideContext): boolean {
  return (
    context.activityType === "custom_labor" ||
    context.wbsPoolId === SUPPORT_WBS_POOL_ID ||
    OVERRIDE_ELIGIBLE_PHASE_POOL_IDS.has(context.phasePoolId)
  );
}

/**
 * A human-readable reason an activity is ineligible, for an error message.
 *
 * Returns `null` when the activity IS eligible, so a caller can use it directly
 * as the guard's message.
 */
export function rateOverrideRejection(context: RateOverrideContext): string | null {
  if (canOverrideRates(context)) return null;
  return (
    "Per-activity rate overrides are only allowed on custom labor lines, " +
    "activities under the SUPPORT work breakdown, or Firewatch / Manwatch / " +
    "Tools & Equipment Runner phases."
  );
}

/**
 * Whether a multi-row override edit should be offered a single shared value.
 *
 * WHY THIS IS SEPARATE FROM {@link canOverrideRates}: legacy required that a
 * multi-select all share the same current base rate before it would open the
 * override dialog. That is a UI affordance — the dialog shows one input and needs
 * one current value to seed it — NOT a data constraint. The server has no
 * business knowing how many rows a user selected, so this is exported for the
 * grid to call and is deliberately not enforced in any mutation.
 */
export function shareSameOverrideBasis(
  activities: ReadonlyArray<{
    customCraftRate?: number | null;
    customSubsistenceRate?: number | null;
  }>
): boolean {
  const [first, ...rest] = activities;
  if (!first) return false;
  return rest.every(
    (a) =>
      a.customCraftRate === first.customCraftRate &&
      a.customSubsistenceRate === first.customSubsistenceRate
  );
}
