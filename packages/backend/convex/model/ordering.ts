/**
 * Display ordering for the estimate tree, shared by every function that
 * returns WBS or phases — Precision's queries and Momentum's scope tree alike.
 *
 * WHY THIS LIVES IN ONE PLACE: display order is a domain rule, not a storage
 * detail. It was previously re-derived (differently) in five Precision queries
 * and then not at all in `projectAssignments.getProjectScopeTree`, which is how
 * the two apps came to disagree on WBS order (#17).
 *
 * CONVEX GOTCHA that applies everywhere: a query that returns a
 * `Record<string, T>` arrives on the client sorted lexicographically by key, so
 * display order must come from an explicit array or a client-side sort on a
 * real field. Never rely on object key order.
 *
 * @module
 */

/**
 * Order WBS rows by their WBS code.
 *
 * WHY NOT `sortOrder`: `wbsPool.sortOrder` was populated from the array index
 * of a legacy JSON blob that was itself ordered lexicographically by stringified
 * id, so natively-created estimates inherit a nonsense order (MOBILIZE,
 * INSULATION, PAINTING, DISMANTLING…). `wbsPoolId` IS the numeric WBS code the
 * business uses (10000, 70000, 300000…), so ordering by it is correct for both
 * synced and natively-created estimates and needs no data migration.
 *
 * WHY AN EXPLICIT SORT: the `by_proposal_sort` index orders by `sortOrder`,
 * which would silently reintroduce the bug at every call site. Collecting on
 * `by_proposal` and sorting here keeps the rule visible.
 */
export function byWBSCode<T extends { wbsPoolId: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.wbsPoolId - b.wbsPoolId);
}

/**
 * Order phases by their phase number.
 *
 * WHY NOT `sortOrder`: `phaseNumber` is what appears on the bid sheet and in
 * every PM conversation, so it is the only phase ordering the field recognizes.
 * `sortOrder` is an internal append counter that drifts from the phase numbers
 * as soon as a phase is renumbered or inserted out of sequence.
 */
export function byPhaseNumber<T extends { phaseNumber: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.phaseNumber - b.phaseNumber);
}
