import { normalizeKey } from "./rateBookMatch";

/**
 * Repairing an estimate line's link to the catalog.
 *
 * ── WHAT WENT WRONG, measured rather than assumed ───────────────────────────
 * The legacy estimator's equipment catalog lived in two files that were EDITED
 * IN PLACE for three years. `equipment.json` went 135 → 135 → 128 → 129 rows;
 * `equipment_v2.json` went 122 → 133. Rows were inserted mid-list, so every id
 * below an insertion moved. Of the 122 rows in the July-2025 v2 file, exactly
 * ONE is still at its own id today. Of the 135 rows in the August-2024 file,
 * exactly one.
 *
 * An activity records the catalog id at the moment the estimator picked it, so
 * 713 production estimates hold ids from roughly four different numberings of
 * two filenames. Sampled across 30 proposals, all 46 distinct (id, description)
 * pairs resolve correctly — each against the revision current when its estimate
 * was written. Nothing is corrupt. The ids simply mean different things.
 *
 * ⚠️ THE MONEY WAS NEVER AT RISK and must not be touched. An activity snapshots
 * `labor.craftConstant`, `labor.welderConstant` and `unitPrice`, and
 * `costEngine` prices from those, never from the catalog. Every finished
 * estimate is correct and stays correct. What is broken is only the pointer
 * BACK to the catalog — which is why nothing ever visibly failed, and why this
 * repair rewrites links and nothing else.
 *
 * ── WHY THE NAME IS THE AUTHORITY ───────────────────────────────────────────
 * The same reasoning as `rateBookMatch.ts`: a row position is not an identity.
 * The activity's own description is what the estimator chose and what they read
 * on the printed bid, so it is the only durable statement of what the line is.
 * Rate books make this permanent going forward — an id is minted once per item
 * and never reused — and this module brings the existing data up to that rule.
 *
 * Pure and dependency-free so the rules can be tested against the real catalog
 * in plain Node.
 */

/** How strongly the catalog corroborates a name match. */
export type LinkConfidence =
  /** The name matches AND the numbers the line carries are the catalog's. */
  | "corroborated"
  /** The name matches; the numbers differ or cannot corroborate anything. */
  | "name_only";

export type LinkVerdict =
  /** The link already points at the item the line describes. */
  | "already_correct"
  /** One catalog item carries this name; the link should move to it. */
  | "relink"
  /** No catalog item carries this name. The link is left exactly as it is. */
  | "no_match"
  /** More than one does. Refused — see `matchRow`, a human decides. */
  | "ambiguous"
  /** Custom lines and non-catalog types have no catalog item by definition. */
  | "not_applicable";

/** A catalog item, from either pool, as the resolver needs to see it. */
export interface CatalogItem {
  poolId: number;
  description: string;
  /** Labor items are scoped to a phase; equipment is global. */
  phasePoolId?: number;
  /**
   * The values that corroborate a name. Labor carries the two constants;
   * equipment carries its four rates, of which a line uses exactly one.
   */
  numbers: readonly number[];
}

/** One estimate line, as the resolver needs to see it. */
export interface ActivityLink {
  type: string;
  description: string;
  /** The link as stored today. */
  currentPoolId?: number;
  /**
   * The phase this line sits in, taken from the PHASE document.
   *
   * Never from the activity's own denormalized fields — `syncMutations` already
   * learned that lesson for `wbsId`, where legacy's copy-between-phases wrote
   * only `phaseId` and carried the source line's `wbsId` along with it.
   */
  phasePoolId?: number;
  /** The numbers this line carries, to corroborate against the catalog's. */
  numbers: readonly number[];
}

export interface LinkResolution {
  verdict: LinkVerdict;
  /** The id the line should carry. Present only when the verdict is `relink`. */
  poolId?: number;
  confidence?: LinkConfidence;
  /** Whether the exact name matched, or only the relaxed equipment form. */
  matchedBy?: "name" | "name_relaxed";
  /** Plain English, for the report a person reads afterwards. */
  reason?: string;
}

/**
 * Two lookups over one book.
 *
 * `exact` is tried first and is the only one labor ever uses. `relaxed` folds
 * the plural off an equipment category prefix and is tried only when `exact`
 * misses — see {@link relaxedKey}. Both map to a LIST, so a name carried by two
 * items is refused rather than resolved to whichever was indexed first.
 */
export interface CatalogIndex {
  exact: ReadonlyMap<string, readonly CatalogItem[]>;
  relaxed: ReadonlyMap<string, readonly CatalogItem[]>;
}

/**
 * The key an item is found by.
 *
 * Scoped by phase for labor because the catalog scopes it that way: `CUT - 2`
 * under carbon steel and `CUT - 2` under stainless are different work with
 * different constants, and an unscoped key would make them collide and be
 * refused — turning a repairable link into a permanent unknown.
 */
export function linkKey(description: string, phasePoolId?: number): string {
  const name = normalizeKey(description);
  return phasePoolId === undefined ? name : `${phasePoolId}|${name}`;
}

/**
 * Fold the plural off an equipment category prefix.
 *
 * ⚠️ EQUIPMENT ONLY, and only as a fallback. The two legacy equipment files
 * disagreed about whether a category is singular or plural — the older list
 * says `LIFT - MANLIFT 60'` where today's says `LIFTS - MANLIFT 60'`, and
 * likewise GENERATOR/GENERATORS, MONITOR/MONITORS, IMPACT/IMPACTS. Measured
 * against the live data this recovers 667 of 2,196 unmatched equipment lines
 * with ZERO collisions in the catalog.
 *
 * It is NOT applied to labor. Labor descriptions lead with an operation code —
 * `CUT`, `OFF`, `BU`, `FSW` — not a pluralised category, so stripping a
 * trailing S there would be a guess with nothing behind it. `rateBookMatch.ts`
 * says why a normalizer is not the place for optimism.
 *
 * Only the text before the first ` - ` is touched, so `IMPACTS - DRIVE 3/4" HD`
 * and `IMPACT - DRIVE IMPACT 3/4` still differ — as they should, being
 * different wording of possibly different tools.
 */
export function relaxedKey(description: string, phasePoolId?: number): string {
  const key = linkKey(description, phasePoolId);
  const separator = key.indexOf(" - ");
  if (separator < 0) return key;
  return key.slice(0, separator).replace(/S$/, "") + key.slice(separator);
}

/** Index one book's items for lookup by what they are called. */
export function buildCatalogIndex(items: readonly CatalogItem[]): CatalogIndex {
  const exact = new Map<string, CatalogItem[]>();
  const relaxed = new Map<string, CatalogItem[]>();
  const push = (map: Map<string, CatalogItem[]>, key: string, item: CatalogItem) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  };
  for (const item of items) {
    push(exact, linkKey(item.description, item.phasePoolId), item);
    push(relaxed, relaxedKey(item.description, item.phasePoolId), item);
  }
  return { exact, relaxed };
}

/** Types whose lines are picked from a catalog at all. */
const LINKED_TYPES = new Set(["labor", "equipment"]);

/**
 * Decide what one line's link should be.
 *
 * ⚠️ NEVER GUESSES. A name that matches nothing, or matches more than one
 * thing, leaves the stored id untouched and says so. Repairing 90% of the links
 * and reporting the rest is worth far more than repairing 100% and being
 * quietly wrong about some of them — that is the failure this whole subsystem
 * exists to end, and re-committing it while claiming to fix it would be worse
 * than leaving it alone.
 */
export function resolveActivityLink(activity: ActivityLink, index: CatalogIndex): LinkResolution {
  if (!LINKED_TYPES.has(activity.type)) {
    return { verdict: "not_applicable" };
  }
  // A custom line is the estimator writing their own item. There is nothing in
  // the catalog for it to point at, and inventing a link would be a claim about
  // their work that they never made.
  if (activity.currentPoolId === undefined) {
    return { verdict: "not_applicable" };
  }

  const key = linkKey(activity.description, activity.phasePoolId);
  let matches = index.exact.get(key) ?? [];
  let matchedBy: "name" | "name_relaxed" = "name";

  // The relaxed pass runs only when the exact name found nothing, and only for
  // equipment. It can turn a refusal into a match or into an ambiguity — never
  // into a different match, because it is not consulted when `exact` hits.
  if (matches.length === 0 && activity.type === "equipment") {
    matches = index.relaxed.get(relaxedKey(activity.description, activity.phasePoolId)) ?? [];
    matchedBy = "name_relaxed";
  }

  if (matches.length === 0) {
    return {
      verdict: "no_match",
      reason: `Nothing in this rate book is called "${activity.description}". The link was left as it is.`,
    };
  }
  if (matches.length > 1) {
    return {
      verdict: "ambiguous",
      reason: `${matches.length} catalog items are called "${activity.description}". Which one this line meant cannot be decided from the estimate.`,
    };
  }

  const match = matches[0] as CatalogItem;
  const confidence: LinkConfidence = numbersAgree(activity.numbers, match.numbers)
    ? "corroborated"
    : "name_only";

  if (match.poolId === activity.currentPoolId) {
    return { verdict: "already_correct", confidence, matchedBy };
  }
  return {
    verdict: "relink",
    poolId: match.poolId,
    confidence,
    matchedBy,
    reason: `"${activity.description}" is id ${match.poolId} in this rate book, not ${activity.currentPoolId}.`,
  };
}

/**
 * Whether the line's own numbers appear among the catalog item's.
 *
 * Deliberately "any", not "all": an equipment line carries ONE of the four
 * rates depending on whether it was taken by the hour, day, week or month, and
 * demanding all four would make corroboration impossible for every equipment
 * line in the system.
 *
 * Corroboration NEVER gates a relink — 16% of labor lines legitimately carry a
 * constant the estimator overrode, and refusing to fix their link because they
 * exercised a feature would be absurd. It is reported so a person can see how
 * much of the repair rests on names alone.
 */
function numbersAgree(line: readonly number[], item: readonly number[]): boolean {
  if (line.length === 0 || item.length === 0) return false;
  // Constants and rates are entered to at most four decimal places, so an exact
  // comparison of stored doubles would fail on values that are the same number.
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  return line.some((value) => value !== 0 && item.some((candidate) => near(value, candidate)));
}

/** What a repair pass did, for the report a person reads afterwards. */
export interface LinkRepairTally {
  examined: number;
  alreadyCorrect: number;
  relinked: number;
  corroborated: number;
  nameOnly: number;
  noMatch: number;
  ambiguous: number;
  notApplicable: number;
}

export function emptyTally(): LinkRepairTally {
  return {
    examined: 0,
    alreadyCorrect: 0,
    relinked: 0,
    corroborated: 0,
    nameOnly: 0,
    noMatch: 0,
    ambiguous: 0,
    notApplicable: 0,
  };
}

/** Fold one resolution into a running tally. */
export function countResolution(tally: LinkRepairTally, resolution: LinkResolution): void {
  tally.examined += 1;
  switch (resolution.verdict) {
    case "already_correct":
      tally.alreadyCorrect += 1;
      break;
    case "relink":
      tally.relinked += 1;
      if (resolution.confidence === "corroborated") tally.corroborated += 1;
      else tally.nameOnly += 1;
      break;
    case "no_match":
      tally.noMatch += 1;
      break;
    case "ambiguous":
      tally.ambiguous += 1;
      break;
    case "not_applicable":
      tally.notApplicable += 1;
      break;
  }
}
