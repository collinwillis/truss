/**
 * Phase numbering — D-phasenumber.
 *
 * The scheme is legacy's, confirmed by Collin: phase numbers appear on the
 * bid sheet and in every PM conversation, so Precision must produce the same
 * numbers the estimator expects.
 *
 *  - An ordinary phase under AG PIPING (70000) is numbered from the WBS code:
 *    the first is 70001, then 70002, …
 *  - RESERVED catalog phases carry their catalog id as the phase number
 *    verbatim, on every estimate: Hydrotesting is always 79996, Material is
 *    always 79999. The reserved set lives on the catalog
 *    (`phasePool.reservedPhaseNumber`, seeded from legacy's list).
 *  - Reserved numbers are EXCLUDED from the "highest existing" scan, so
 *    adding Hydrotesting does not push the next pipe phase to 79997.
 *
 * WHY THIS LIVES ON THE SERVER: legacy computed the number in a React dialog
 * and trusted whatever the client sent, which allowed silent duplicates and
 * verbatim-copied numbers on phase duplication. Here the server derives and
 * validates; the dialog only previews.
 *
 * @see docs/precision/DECISIONS.md D-phasenumber
 */

/** What the numbering rule needs to know about one existing phase. */
export interface ExistingPhaseNumber {
  phaseNumber: number;
}

/**
 * Derive the number for a new phase.
 *
 * `reservedNumbers` must contain every reserved catalog id for the dataset —
 * both to place a reserved phase at its fixed number and to exclude reserved
 * numbers from the sequential scan.
 *
 * More robust than legacy in one deliberate way: if the next sequential
 * number is already taken (legacy silently duplicated — e.g. when the
 * sequence reached a number a reserved phase already occupies), this skips
 * forward to the first free non-reserved number.
 */
export function nextPhaseNumber(options: {
  wbsCode: number;
  /** The catalog id of the phase type being added. */
  phasePoolId: number;
  /** True when the selected catalog phase carries a reserved number. */
  isReserved: boolean;
  existing: readonly ExistingPhaseNumber[];
  reservedNumbers: ReadonlySet<number>;
}): number {
  const { wbsCode, phasePoolId, isReserved, existing, reservedNumbers } = options;

  const taken = new Set(existing.map((phase) => phase.phaseNumber));

  // A reserved number identifies exactly one phase. Adding the same reserved
  // catalog phase a second time falls through to sequential numbering instead
  // of colliding on the fixed number (legacy silently duplicated).
  if (isReserved && !taken.has(phasePoolId)) return phasePoolId;
  let max = wbsCode;
  for (const phase of existing) {
    if (phase.phaseNumber > max && !reservedNumbers.has(phase.phaseNumber)) {
      max = phase.phaseNumber;
    }
  }

  let candidate = max + 1;
  while (taken.has(candidate) || reservedNumbers.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

/**
 * Whether an explicitly chosen number may be used for a new phase.
 *
 * The estimator may always type a number by hand (legacy allowed it, and the
 * field convention sometimes wants gaps) — but a duplicate within the WBS is
 * refused rather than silently created. Mirrored legacy data may already
 * contain duplicates; this validates NEW writes only and never judges stored
 * rows.
 */
export function phaseNumberConflict(
  requested: number,
  existing: readonly ExistingPhaseNumber[]
): boolean {
  return existing.some((phase) => phase.phaseNumber === requested);
}
