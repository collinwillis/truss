/**
 * The one rule for turning a legacy subcontractor line into a single quote.
 *
 * WHY ONE MODULE. Three writers decide what a subcontractor line looks like: the
 * conversion migration, the Firestore mirror, and an estimator's edit in
 * Precision. They held the rule in one place only, the migration, and the mirror
 * had no idea it existed. Its mapper kept emitting the three legacy buckets, the
 * differ saw a stored `cost` it was not supplying, and the next nightly pass
 * wrote every converted line on every mirrored estimate back to the old shape.
 * The migration's work lasted one day. Every writer now asks this module.
 *
 * PURE, with no Convex imports, for the same reason as `syncDiff.ts`: the mapper
 * and the differ tests run in plain Node.
 *
 * @module
 */

import type { ActivitySubcontractorInput } from "./costEngine";

/** Where a line stands against the single-quote rule. */
export type SubcontractorLineKind =
  /** Already carries `cost`. Nothing to decide. */
  | { readonly kind: "quoted" }
  /** One bucket holds the number, so a single cost prices it identically. */
  | { readonly kind: "convertible"; readonly cost: number; readonly addSalesTax: boolean }
  /**
   * More than one bucket holds money. One taxed leg beside untaxed ones has no
   * single-cost equivalent, so the line stays on the legacy pricing rule.
   */
  | { readonly kind: "mixed" }
  /** Every bucket is zero. There is no quote to carry over. */
  | { readonly kind: "blank" };

/**
 * Whether a legacy line's price carried the estimate's sales tax.
 *
 * Material was the taxed leg under the old rule, so any money in it means tax
 * was being applied. This is the default an unconverted line takes the first
 * time somebody types a single cost into it, which is why it is exported.
 */
export function legacyLineWasTaxed(sub: Pick<ActivitySubcontractorInput, "materialCost">): boolean {
  return (sub.materialCost ?? 0) !== 0;
}

/**
 * Classify one line.
 *
 * `convertible` carries the exact values to write. They come from the bucket
 * itself, not from arithmetic, so a converted line compares bit-identical to the
 * next Firestore read of the same document and the mirror stays quiet.
 */
export function classifySubcontractorLine(sub: ActivitySubcontractorInput): SubcontractorLineKind {
  if (sub.cost !== undefined) return { kind: "quoted" };
  const filled = [sub.laborCost, sub.materialCost, sub.equipmentCost].filter(
    (value) => (value ?? 0) !== 0
  );
  if (filled.length === 0) return { kind: "blank" };
  if (filled.length > 1) return { kind: "mixed" };
  return { kind: "convertible", cost: filled[0] as number, addSalesTax: legacyLineWasTaxed(sub) };
}

/**
 * The line as it should be stored: converted when that is free, untouched
 * otherwise.
 *
 * The three buckets are kept beside `cost` so nothing an estimator entered is
 * destroyed, and `costEngine` ignores them once `cost` is present.
 */
export function withQuotedCost<T extends ActivitySubcontractorInput>(sub: T): T {
  const line = classifySubcontractorLine(sub);
  if (line.kind !== "convertible") return sub;
  return { ...sub, cost: line.cost, addSalesTax: line.addSalesTax };
}
