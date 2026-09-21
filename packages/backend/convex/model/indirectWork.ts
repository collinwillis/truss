/**
 * Which breakdowns are indirect work, and what kind.
 *
 * WHY A MODULE. "Indirect" is a fact about a WBS code, and three readers need
 * it: the estimate summary that splits hours, the WBS list that tells a screen
 * whether the breakdown it is showing is indirect, and the totals panel that
 * names the split. The rule lived as a private set inside `precision.ts`, so a
 * second reader could only have copied it.
 *
 * The four codes and their grouping are the legacy MCP Estimator's, which is
 * what the estimators' own bid reviews are built on: mobilize and demobilize
 * are read together, support and specialty services each stand alone.
 *
 * PURE, with no Convex imports, so it runs in a plain test process.
 *
 * @module
 */

/** The kinds of indirect work the summary reports hours for. */
export type IndirectKind = "mobilization" | "support" | "specialty";

const INDIRECT_KIND_BY_POOL_ID: ReadonlyMap<number, IndirectKind> = new Map([
  [10000, "mobilization"], // MOBILIZE
  [190000, "mobilization"], // DEMOBILIZE
  [200000, "support"], // SUPPORT
  [180000, "specialty"], // SPECIALTY SERVICES
]);

/** The kind of indirect work a WBS code carries, or `null` for direct work. */
export function indirectKindOf(wbsPoolId: number): IndirectKind | null {
  return INDIRECT_KIND_BY_POOL_ID.get(wbsPoolId) ?? null;
}

/** Whether a WBS code is indirect work. */
export function isIndirectWbs(wbsPoolId: number): boolean {
  return INDIRECT_KIND_BY_POOL_ID.has(wbsPoolId);
}

/** Hours per kind, zeroed. The summary accumulates into one of these. */
export function emptyIndirectHours(): Record<IndirectKind, number> {
  return { mobilization: 0, support: 0, specialty: 0 };
}
