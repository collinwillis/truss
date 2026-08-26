import { computeActivityCosts, round2 } from "./costEngine";
import type { ActivityInput, ActivityType, ProposalRates } from "./costEngine";
import { rollUpProposal } from "./proposalTotals";
import type { ProposalRollup } from "./proposalTotals";
import { normalizeKey } from "./rateBookMatch";

/**
 * What the estimates we have already priced would have cost under a new book —
 * and, said just as loudly, how much of each estimate that answer is about.
 *
 * ⚠️ THIS RUNS THE ONE ENGINE. `rollUpProposal` and `computeActivityCosts` are
 * value imports on purpose: the benchmark is two passes of the same accumulator
 * the estimate screen and the cached proposal total already use, with exactly
 * one input changed. A second implementation of the math here is the failure
 * `costEngine.ts`'s header exists to prevent — legacy grew three copies and they
 * drifted until the bid sheet no longer tied to the screen. Nothing in this file
 * multiplies a constant by a quantity.
 *
 * `normalizeKey` is a value import for the same reason: the description test
 * below must be the same normalizer the matcher uses, or the benchmark and the
 * importer would disagree about whether two rows are the same item.
 *
 * WHAT IT REFUSES TO ANSWER, measured rather than assumed. Across 18 sampled
 * production proposals:
 *
 *   LABOR      4,015 lines. 3,689 (92%) point at a catalog row whose description
 *              matches the line; 326 (8%) do not. 3,375 (84%) still carry the
 *              catalog's craftConstant unchanged; the rest were typed over.
 *   EQUIPMENT  245 lines. 40 (16%) point at a row whose description matches;
 *              199 (81%) point at an entirely different item — "MANLIFT - 60'"
 *              at a forklift, "DRIVE IMPACT - 1" at a 130-ton crane. Across 419
 *              equipment lines only 42 carry a unitPrice equal to ANY rate on
 *              the row they name.
 *
 * So no equipment line is ever repriced, and a labor line is repriced only when
 * seven independent things agree. Everything excluded is carried as a dollar
 * figure rather than dropped, because a confident delta that quietly omits 81%
 * of equipment is the artifact that destroys trust the day somebody finds out.
 *
 * Pure and Convex-free, like `costEngine.ts`, so the whole rule set is testable
 * in plain Node. The caller loads the documents and hands them over.
 */

/**
 * The empty indirect-WBS set, shared.
 *
 * `rollUpProposal`'s own comment says the cost total is identical either way and
 * the split only decides which hour bucket a line lands in. Passing an empty set
 * matches `recomputeProposalTotal` exactly, which is what makes the self-check
 * below an equality rather than an approximation.
 */
const NO_INDIRECT_WBS: ReadonlySet<string> = new Set<string>();

/**
 * How many movers survive into the report, for two different jobs.
 *
 * Ten PER DIRECTION for the four proposal lists — up and down are ranked and
 * truncated separately, which is what keeps a decrease out of "the ten largest
 * increases". And ten IN TOTAL for `movers.byItem`, which has no direction at
 * all: `finalizeBenchmark` ranks catalog items by absolute cost movement, so the
 * ten it keeps are the ten that moved the most money either way.
 */
const MOVER_LIMIT = 10;

/**
 * The sampled proportion of labor lines whose catalog link corroborates: 3,689
 * of 4,015 across 18 proposals. Every rule in this file leans on it, so the
 * first full run measures its own and says whether the sample held.
 */
export const SAMPLED_DESCRIPTION_CORROBORATED = 0.92;

/**
 * The sampled proportion still carrying the catalog's craftConstant verbatim:
 * 3,375 of 4,015. The complement — 640 lines, 16% — is the estimator-override
 * population this benchmark will not touch.
 */
export const SAMPLED_CONSTANT_UNCHANGED = 0.84;

/**
 * How far the population may drift from the sample before the run says so.
 *
 * Ten points, because the two sampled conditions are not independent — a wrong
 * id is more likely to carry a different constant — so the repriceable fraction
 * is at most 84% and its real value is whatever the first full run measures. A
 * population at 60% rather than 92% means the labor rule needs revisiting, and
 * this is how we find out rather than being told by an estimator.
 */
export const SAMPLE_DIVERGENCE_TOLERANCE = 0.1;

// ---------------------------------------------------------------------------
// The catalogs
// ---------------------------------------------------------------------------

/**
 * A labor catalog row, projected from either book by the caller.
 *
 * The units are not decoration: a constant is man-hours PER UNIT, so a row
 * restated from LF to EA is a different item at the same id and the same
 * number. `classifyLeg` reads them for exactly that reason.
 */
export interface LaborCatalogRow {
  readonly poolId: number;
  readonly description: string;
  readonly craftConstant: number;
  readonly weldConstant: number;
  readonly craftUnits: string;
  readonly weldUnits: string;
  readonly isActive: boolean;
}

/** An equipment catalog row, projected from either book by the caller. */
export interface EquipmentCatalogRow {
  readonly poolId: number;
  readonly description: string;
  readonly hourRate: number;
  readonly dayRate: number;
  readonly weekRate: number;
  readonly monthRate: number;
  readonly isActive: boolean;
}

/** One book's labor pool, keyed by `poolId` — the key an activity stores. */
export type LaborCatalog = ReadonlyMap<number, LaborCatalogRow>;

/** One book's equipment pool, keyed by `poolId`. */
export type EquipmentCatalog = ReadonlyMap<number, EquipmentCatalogRow>;

/** The four period prices on an equipment row, cheapest first. */
export type EquipmentTier = "hour" | "day" | "week" | "month";

const EQUIPMENT_TIERS: readonly EquipmentTier[] = ["hour", "day", "week", "month"];

function tierRate(row: EquipmentCatalogRow, tier: EquipmentTier): number {
  if (tier === "hour") return row.hourRate;
  if (tier === "day") return row.dayRate;
  if (tier === "week") return row.weekRate;
  return row.monthRate;
}

/**
 * An estimate line as the benchmark sees it.
 *
 * A `Doc<"activities">` satisfies this as-is; the module never names the Doc, so
 * the rules run in a plain test process against hand-built fixtures.
 */
export interface BenchmarkActivity extends ActivityInput {
  readonly wbsId: unknown;
  readonly description: string;
  readonly laborPoolId?: number;
  readonly equipmentPoolId?: number;
}

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

/**
 * Precedence for the LINE bucket, worst first.
 *
 * A line takes the worst of its two legs, so the line accounting sums exactly to
 * the activity count while a line with one repriced leg and one overridden leg
 * is still counted in both leg buckets. The order runs from "this data is
 * broken" through "we do not know what this is" to "the book governs it and
 * nothing moved".
 *
 * A mixed line therefore counts entirely as carried even though one of its legs
 * did move. That understates coverage, which is the safe direction: the
 * alternative is claiming coverage over a line we can only half justify.
 *
 * ONLY FOUR OF THESE EVER MEET EACH OTHER IN `worstOf`. `classifyLeg` returns
 * `unit_redefined`, `estimator_override`, `repriced` and `repriced_no_delta`,
 * and their order here is the only ranking that decides anything. The other
 * four are verdicts about the whole LINE — `classifyLaborLine` reaches them
 * before either leg is classified and stamps them on both legs at once — so
 * their position is the order the report reads in, not a comparison. A line
 * whose description contradicts its own poolId is never also weighed as
 * `unit_redefined`: we do not know what item it is, and the units of an unknown
 * item say nothing.
 *
 * {@link LegDisposition} is DERIVED from this array rather than declared beside
 * it, so the two cannot drift. `addCounts` folds an estimate into the run by
 * walking these members: a disposition that existed in the union but not in
 * this list would have its count dropped somewhere between one estimate and the
 * report, and the line buckets would quietly stop summing to the line total.
 */
export const DISPOSITION_PRECEDENCE = [
  "dangling_reference",
  "retired_under_draft",
  "unit_redefined",
  "description_mismatch",
  "estimator_override",
  "repriced",
  "repriced_no_delta",
  "no_catalog_reference",
] as const;

/** Why a leg of a line was, or was not, repriced. */
export type LegDisposition = (typeof DISPOSITION_PRECEDENCE)[number];

function worstOf(a: LegDisposition, b: LegDisposition): LegDisposition {
  return DISPOSITION_PRECEDENCE.indexOf(a) <= DISPOSITION_PRECEDENCE.indexOf(b) ? a : b;
}

/**
 * The two line types a rate book can move.
 *
 * `dollarBucketOf` already files every dollar of a material, equipment,
 * subcontractor or cost_only line as carried, on the grounds that those lines
 * carry their own prices. Without this test the two halves of the module
 * disagree: `activities` permits any type to hold a `labor` object — "only one
 * should be populated" is a comment on the table, not a validator — so an
 * equipment line carrying a labor snapshot would have its constants substituted
 * into the headline delta while all of its dollars sat in the carried column.
 * The delta would then no longer be bounded by the money the report says it is
 * about, which is the one claim this whole design exists to keep true.
 */
const REPRICEABLE_TYPES: ReadonlySet<ActivityType> = new Set<ActivityType>([
  "labor",
  "custom_labor",
]);

/** How one line was classified, and the constants that would replace it. */
export interface LineDisposition {
  readonly craft: LegDisposition;
  readonly weld: LegDisposition;
  readonly line: LegDisposition;
  /** Present only where the craft leg may be repriced. */
  readonly draftCraftConstant?: number;
  /** Present only where the welder leg may be repriced. */
  readonly draftWelderConstant?: number;
}

function bothLegs(disposition: LegDisposition): LineDisposition {
  return { craft: disposition, weld: disposition, line: disposition };
}

function classifyLeg(
  snapshot: number,
  parentValue: number,
  draftValue: number,
  parentUnits: string,
  draftUnits: string
): { disposition: LegDisposition; draft?: number } {
  // A REDEFINED UNIT IS NOT AN UNCHANGED PRICE. 0.7 per LF and 0.7 per EA are
  // different items, and the estimate's quantity was typed in the old one with
  // nothing here able to restate it in the new one. Reporting that as
  // `repriced_no_delta` — "the book governs this line and nothing moved" — is
  // the strongest false statement this module is capable of making, and the
  // sheet has an editable `craftUnits` column, so it is one cell away.
  //
  // Tested before the override below because it is a fact about the DRAFT,
  // true whatever the estimator typed, and gated on the leg carrying hours
  // because 4,149 of the 5,897 labor rows hold a blank `weldUnits` beside a
  // zero `weldConstant`. A draft that merely fills those in moves no number at
  // all; flagging it would report near-zero coverage on a book that did nothing.
  if (
    (parentValue !== 0 || draftValue !== 0) &&
    normalizeKey(parentUnits) !== normalizeKey(draftUnits)
  ) {
    return { disposition: "unit_redefined" };
  }
  // Exact equality, never an epsilon. The value was copied verbatim from the
  // catalog at creation, so an exact match is proof of provenance; a tolerance
  // would launder a deliberate 0.61-over-0.60 override into a repricing.
  if (snapshot !== parentValue) return { disposition: "estimator_override" };
  return {
    disposition: draftValue === parentValue ? "repriced_no_delta" : "repriced",
    draft: draftValue,
  };
}

/**
 * Decide, per leg, whether a line may be repriced.
 *
 * SEVEN TESTS, and a leg is repriced only if it survives all of them.
 *
 *  1. The line's type is `labor` or `custom_labor` — see {@link REPRICEABLE_TYPES}.
 *  2. `laborPoolId` present AND a labor snapshot to compare, or the line is
 *     `no_catalog_reference` — materials, subcontractor, cost_only, and most
 *     custom_labor. Nothing about a rate book can move those.
 *  3. The PARENT book has a row at that poolId, or `dangling_reference`. A live
 *     estimate pointing at an id its own book does not contain is a fact worth
 *     seeing rather than a crash.
 *  4. The DRAFT still offers a row at that poolId, or `retired_under_draft`.
 *     Deleted and deactivated are the same event here: every picker and
 *     `loadTakeoffCatalog` query `by_book_phase_active`, so an inactive row is
 *     as gone as a missing one. That is the population that breaks on the next
 *     re-pick, and it is a headline number rather than a footnote.
 *  5. `normalizeKey(activity.description) === normalizeKey(parentRow.description)`,
 *     or `description_mismatch`. This is the measured 8%: 326 of 4,015 sampled
 *     labor lines fail it. The id points at something whose name does not match
 *     the line, so we do not know what item it is and will not invent a number.
 *  6. The draft states the leg's constant in the SAME UNIT, or `unit_redefined`.
 *  7. The snapshot equals the parent's constant EXACTLY, or `estimator_override`.
 *     This is the measured 16%: 640 of 4,015.
 *
 * The legs are tested INDEPENDENTLY, and the pairing is the trap:
 * `activities.labor.craftConstant` against `laborPool.craftConstant`, and
 * `activities.labor.welderConstant` against `laborPool.weldConstant`. Those two
 * are the same quantity under different names, and `weldUnits` pairs with the
 * welder leg for the same reason. Getting it wrong makes every welder delta
 * exactly zero while every other number still looks plausible, which is why it
 * carries its own fixture test.
 */
export function classifyLaborLine(
  activity: BenchmarkActivity,
  parent: LaborCatalog,
  draft: LaborCatalog
): LineDisposition {
  const snapshot = activity.labor;
  const poolId = activity.laborPoolId;
  if (!REPRICEABLE_TYPES.has(activity.type) || poolId === undefined || !snapshot) {
    return bothLegs("no_catalog_reference");
  }

  const parentRow = parent.get(poolId);
  if (!parentRow) return bothLegs("dangling_reference");

  const draftRow = draft.get(poolId);
  if (!draftRow || !draftRow.isActive) return bothLegs("retired_under_draft");

  if (normalizeKey(activity.description) !== normalizeKey(parentRow.description)) {
    return bothLegs("description_mismatch");
  }

  const craft = classifyLeg(
    snapshot.craftConstant,
    parentRow.craftConstant,
    draftRow.craftConstant,
    parentRow.craftUnits,
    draftRow.craftUnits
  );
  const weld = classifyLeg(
    snapshot.welderConstant,
    parentRow.weldConstant,
    draftRow.weldConstant,
    parentRow.weldUnits,
    draftRow.weldUnits
  );

  return {
    craft: craft.disposition,
    weld: weld.disposition,
    line: worstOf(craft.disposition, weld.disposition),
    draftCraftConstant: craft.draft,
    draftWelderConstant: weld.draft,
  };
}

/**
 * The same line with the draft's constants substituted and NOTHING else moved.
 *
 * Quantity, unit, `customCraftRate`, `customSubsistenceRate`, `unitPrice` and
 * all fifteen proposal rates are held exactly as stored. The rate book carries
 * no rates — the fifteen `ProposalRates` are per-estimate — so a book change can
 * only move constants, and mixing anything else in would confound the one
 * variable being measured.
 *
 * Returns the SAME OBJECT when nothing moves. That is not a micro-optimisation:
 * this runs over ~200,000 lines, and identity is also how the caller tells a
 * substituted line from an untouched one without re-deriving the disposition.
 */
export function counterfactualActivity(
  activity: BenchmarkActivity,
  disposition: LineDisposition
): BenchmarkActivity {
  const snapshot = activity.labor;
  if (!snapshot) return activity;

  const craftConstant = disposition.draftCraftConstant ?? snapshot.craftConstant;
  const welderConstant = disposition.draftWelderConstant ?? snapshot.welderConstant;
  if (craftConstant === snapshot.craftConstant && welderConstant === snapshot.welderConstant) {
    return activity;
  }
  return { ...activity, labor: { ...snapshot, craftConstant, welderConstant } };
}

// ---------------------------------------------------------------------------
// Equipment — traced, never repriced
// ---------------------------------------------------------------------------

/** What could be established about an equipment line's price, if anything. */
export interface EquipmentTrace {
  readonly poolId: number;
  readonly descriptionCorroborated: boolean;
  /** The single non-zero tier equal to `unitPrice`, when exactly one is. */
  readonly tier?: EquipmentTier;
  /** `unitPrice` matches two or more tiers: the tier is unknown, so it is excluded. */
  readonly ambiguous: boolean;
}

/**
 * Establish what an equipment line was priced from, or admit that we cannot.
 *
 * `null` means the line carries no traceable reference at all, which is the
 * majority answer and must never be read as "traced, and unchanged".
 *
 * `equipment.time` is a bare number with no unit, so which of the four tiers a
 * line was priced from is stored nowhere. Recovering it by matching `unitPrice`
 * against the row's rates is the only evidence available, and it works for 42 of
 * 419 lines. Two tiers matching means the tier is unknown, and an unknown tier
 * cannot be substituted.
 */
export function traceEquipmentLine(
  activity: BenchmarkActivity,
  parent: EquipmentCatalog
): EquipmentTrace | null {
  const poolId = activity.equipmentPoolId;
  if (poolId === undefined) return null;
  const row = parent.get(poolId);
  if (!row) return null;

  const price = activity.unitPrice ?? 0;
  const matches = EQUIPMENT_TIERS.filter((tier) => {
    const rate = tierRate(row, tier);
    return rate !== 0 && rate === price;
  });

  return {
    poolId,
    descriptionCorroborated: normalizeKey(activity.description) === normalizeKey(row.description),
    tier: matches.length === 1 ? matches[0] : undefined,
    ambiguous: matches.length > 1,
  };
}

/** A tier's movement across the whole equipment pool, in percent. */
export interface TierChangeSpread {
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

/** Catalog-side facts that need no join at all, and are therefore trustworthy. */
export interface EquipmentRateFacts {
  /**
   * Rows in BOTH books whose rates moved. A row the draft adds has no before to
   * compare against, so it is not a rate change and is not counted here — and
   * neither is a row the draft merely retires, whose four rates are untouched.
   *
   * `BenchmarkReport.equipment.linesExposedToChange` counts retirement as
   * exposure, so a draft that retires forty rows and re-rates none reports
   * `changedRows: 0` beside a non-zero exposure. The two numbers answer
   * different questions — what the catalog did, and what it did to a line — and
   * they are meant to disagree on exactly that draft.
   */
  readonly changedRows: number;
  readonly tierChangePct: Readonly<Record<EquipmentTier, TierChangeSpread | null>>;
  /** Draft poolIds whose non-zero tiers are out of order. */
  readonly inversions: readonly number[];
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * What the equipment pool did, without touching a single estimate.
 *
 * This is the only equipment number in the report that is not qualified, because
 * it is the only one that involves no join: it compares two catalogs to each
 * other. An equipment-heavy re-rate ships on somebody reading these rows.
 *
 * An inversion is wrong on its face with no history needed — the four rates are
 * cumulative period prices, and book #1 id 5 is 7/56/224/672. Zero tiers are
 * excluded from the check: a missing tier is legitimate.
 */
export function equipmentRateFacts(
  parent: EquipmentCatalog,
  draft: EquipmentCatalog
): EquipmentRateFacts {
  let changedRows = 0;
  const spreads = new Map<EquipmentTier, number[]>();
  for (const tier of EQUIPMENT_TIERS) spreads.set(tier, []);

  for (const [poolId, draftRow] of draft) {
    const parentRow = parent.get(poolId);
    if (!parentRow) continue;
    let changed = false;
    for (const tier of EQUIPMENT_TIERS) {
      const before = tierRate(parentRow, tier);
      const after = tierRate(draftRow, tier);
      if (before === after) continue;
      changed = true;
      // A percentage against a zero base is infinity dressed as a fact. A tier
      // that was priced at nothing and now is not shows up in `changedRows`.
      if (before !== 0) spreads.get(tier)?.push(((after - before) / before) * 100);
    }
    if (changed) changedRows += 1;
  }

  const inversions: number[] = [];
  for (const [poolId, row] of draft) {
    const ordered = EQUIPMENT_TIERS.map((tier) => tierRate(row, tier)).filter((rate) => rate !== 0);
    for (let i = 1; i < ordered.length; i += 1) {
      if ((ordered[i - 1] ?? 0) > (ordered[i] ?? 0)) {
        inversions.push(poolId);
        break;
      }
    }
  }

  const tierChangePct: Record<EquipmentTier, TierChangeSpread | null> = {
    hour: null,
    day: null,
    week: null,
    month: null,
  };
  for (const tier of EQUIPMENT_TIERS) {
    const values = (spreads.get(tier) ?? []).slice().sort((a, b) => a - b);
    // Rounded here because this IS the display boundary — the spread exists for
    // somebody to read, and a 10% re-rate reported as 10.000000000000002 reads
    // as a number the software does not understand.
    tierChangePct[tier] =
      values.length === 0
        ? null
        : {
            min: round2(values[0] ?? 0),
            median: round2(median(values)),
            max: round2(values[values.length - 1] ?? 0),
          };
  }

  return { changedRows, tierChangePct, inversions: inversions.sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// One proposal
// ---------------------------------------------------------------------------

/** Everything the benchmark needs about one estimate. The caller loads it. */
export interface ProposalBenchmarkInput {
  readonly proposalNumber: string;
  /**
   * `proposals.costTotal`, as the app itself recorded it. Absent means the
   * estimate has never been totalled, which the self-check reports rather than
   * waves through.
   */
  readonly cachedCostTotal?: number;
  readonly rates: ProposalRates;
  readonly activities: readonly BenchmarkActivity[];
  readonly parentLabor: LaborCatalog;
  readonly draftLabor: LaborCatalog;
  readonly parentEquipment: EquipmentCatalog;
  readonly draftEquipment: EquipmentCatalog;
}

/** Line counts by disposition. `byLine` sums to `total`; so does each leg. */
export interface LineAccounting {
  readonly total: number;
  readonly byLine: Readonly<Record<LegDisposition, number>>;
  readonly byCraftLeg: Readonly<Record<LegDisposition, number>>;
  readonly byWeldLeg: Readonly<Record<LegDisposition, number>>;
}

type DispositionCounts = Record<LegDisposition, number>;

function emptyDispositionCounts(): DispositionCounts {
  return {
    repriced: 0,
    repriced_no_delta: 0,
    estimator_override: 0,
    description_mismatch: 0,
    unit_redefined: 0,
    dangling_reference: 0,
    retired_under_draft: 0,
    no_catalog_reference: 0,
  };
}

/**
 * The money this run did NOT speak for, split by the reason it could not.
 *
 * Every dollar of an estimate lands in exactly one of these or in
 * `coveredDollars`, and the two together equal the estimate's own total. That
 * is what lets the report say "this figure is about NN% of the money" instead of
 * hoping nobody asks.
 *
 * `danglingLabor` and `unlinkedLabor` are here because the arithmetic does not
 * close without them: custom labor with no catalog link at all is real craft
 * cost no rate book can move, and pretending it is covered would overstate the
 * one number this whole design exists to keep honest.
 *
 * UNROUNDED, unlike `cost` and both {@link HourMovement}s. These eight, plus
 * `coveredDollars` and `ProposalMover.deltaPct`, cross the report boundary as
 * raw accumulator values and the render layer rounds them. Rounding each bucket
 * here would break the exact partition: eight independent roundings need not add
 * back to the total the estimate itself reports, and that partition closing to
 * the cent is the claim the whole report rests on.
 */
export interface CarriedDollars {
  readonly overriddenLabor: number;
  readonly mismatchedLabor: number;
  readonly retiredUnderDraftLabor: number;
  /** Labor on an item the draft restates in a different unit — same id, same
   *  number, different meaning. See {@link classifyLaborLine} test 6. */
  readonly unitRedefinedLabor: number;
  readonly danglingLabor: number;
  readonly unlinkedLabor: number;
  readonly equipment: number;
  /** Material, subcontractor and cost_only: they carry their own prices and no
   *  rate book has ever touched them. Said out loud so it does not read as a gap. */
  readonly materialAndSub: number;
}

/** One reason a dollar is not covered — the keys of {@link CarriedDollars}. */
export type CarriedBucket = keyof CarriedDollars;

/**
 * How each bucket is named in the sentence that introduces their sum.
 *
 * Both this module's coverage caveat and `publishGates`' benchmark
 * acknowledgement text state a total and then list what it is made of. The total
 * is computed by walking the object, so the LIST has to be walked too: a ninth
 * bucket added above is then a compile error here rather than money named
 * nowhere. It is not hypothetical — the eighth bucket, `unitRedefinedLabor`,
 * reached the sum before it reached either sentence, and $4,000,000 of a stated
 * $5,000,000 went unaccounted for while both files still compiled.
 *
 * Phrases read after a dollar figure and the word "of": "$4,000,000.00 of labor
 * on items this draft restates in another unit".
 */
export const CARRIED_BUCKET_PHRASES: Readonly<Record<CarriedBucket, string>> = {
  overriddenLabor: "overridden labor",
  mismatchedLabor: "labor whose catalog link does not corroborate",
  retiredUnderDraftLabor: "labor on items this draft retires",
  unitRedefinedLabor: "labor on items this draft restates in another unit",
  danglingLabor: "labor pointing at ids the parent book does not contain",
  unlinkedLabor: "labor with no catalog link at all",
  equipment: "equipment",
  materialAndSub: "material, subcontractor and cost-only",
};

/** The buckets in the order the sentence names them. */
const CARRIED_BUCKETS = Object.keys(CARRIED_BUCKET_PHRASES) as readonly CarriedBucket[];

function emptyCarried(): Record<CarriedBucket, number> {
  return {
    overriddenLabor: 0,
    mismatchedLabor: 0,
    retiredUnderDraftLabor: 0,
    unitRedefinedLabor: 0,
    danglingLabor: 0,
    unlinkedLabor: 0,
    equipment: 0,
    materialAndSub: 0,
  };
}

/**
 * Which dollar bucket a line's cost belongs to.
 *
 * Type decides first, and {@link REPRICEABLE_TYPES} is the other half of the
 * same rule: the types listed here are exactly the types that can never be
 * repriced, so no line is ever counted as carried money while its constants
 * move the headline.
 */
function dollarBucketOf(
  activity: BenchmarkActivity,
  line: LegDisposition
): CarriedBucket | "covered" {
  if (activity.type === "equipment") return "equipment";
  if (activity.type === "material" || activity.type === "subcontractor") return "materialAndSub";
  if (activity.type === "cost_only") return "materialAndSub";
  if (line === "repriced" || line === "repriced_no_delta") return "covered";
  if (line === "estimator_override") return "overriddenLabor";
  if (line === "description_mismatch") return "mismatchedLabor";
  if (line === "retired_under_draft") return "retiredUnderDraftLabor";
  if (line === "unit_redefined") return "unitRedefinedLabor";
  if (line === "dangling_reference") return "danglingLabor";
  return "unlinkedLabor";
}

/** One catalog item's contribution to the movement, with its name attached. */
export interface ItemDelta {
  /** A poolId with no name next to it is a number nobody can act on. */
  readonly description: string;
  readonly craftHours: number;
  readonly welderHours: number;
  readonly cost: number;
  readonly lines: number;
}

/** The population figures the sample claimed, measured for real. */
export interface MeasuredRates {
  /** The denominator. A proportion printed without one is how 92% from 18
   *  proposals became a load-bearing constant. */
  readonly laborLinesWithCatalogReference: number;
  readonly descriptionCorroborated: number;
  readonly constantUnchanged: number;
  readonly divergesFromSample: boolean;
}

/** What one estimate would have cost, and how much of it we can speak for. */
export interface ProposalBenchmarkResult {
  readonly proposalNumber: string;
  readonly baseline: ProposalRollup;
  readonly counterfactual: ProposalRollup;
  /**
   * BLOCKING. `round2(baseline.costs.totalCost)` must equal the proposal's own
   * cached `costTotal`. `recomputeProposalTotal` is the only writer of that
   * number and derives it from `rollUpProposal` with an empty indirect set and
   * `roundCosts` — the identical call this makes. A mismatch means the harness
   * is not reading these estimates the way the app does, and every figure it
   * prints is measuring something else while looking authoritative.
   *
   * An ABSENT cached total is also a failure, and `cached` then stays undefined
   * rather than becoming a zero somebody could read as a real recorded total.
   * We could not verify, so we do not claim we did; the remedy is running the
   * totals backfill, and the message says so.
   */
  readonly selfCheck: {
    readonly cached?: number;
    readonly computed: number;
    readonly matches: boolean;
  };
  readonly lines: LineAccounting;
  /** Labor cost on lines this run actually repriced. Unrounded, for the reason
   *  {@link CarriedDollars} gives — it is the other half of that partition. */
  readonly coveredDollars: number;
  readonly carriedDollars: CarriedDollars;
  /** Changed or not, the catalog items this estimate priced through. */
  readonly exercisedLaborPoolIds: readonly number[];
  readonly measured: Omit<MeasuredRates, "divergesFromSample">;
  readonly equipment: {
    readonly lines: number;
    readonly corroborated: number;
    readonly exposedToChange: number;
    /** NON-ADDITIVE. Over traceable lines only; never folded into the headline. */
    readonly corroboratedDelta: number;
  };
  readonly perItemDelta: ReadonlyMap<number, ItemDelta>;
}

/**
 * Two passes of `rollUpProposal` over the same activities, one input changed.
 *
 * The single walk below re-prices each activity through `computeActivityCosts`
 * — the same function the rollup calls — to split the total into the buckets
 * above. Summing those per-line totals reproduces the rollup's total exactly,
 * which is asserted rather than assumed.
 *
 * One loop rather than three parallel arrays addressed by a shared index: every
 * `[index]` read into a second array is a place a line can be dropped from the
 * accounting while `lines.total` still counts it, which would break the one
 * invariant the report presents as a guarantee.
 */
export function benchmarkProposal(input: ProposalBenchmarkInput): ProposalBenchmarkResult {
  const counterfactualActivities: BenchmarkActivity[] = [];

  const byLine = emptyDispositionCounts();
  const byCraftLeg = emptyDispositionCounts();
  const byWeldLeg = emptyDispositionCounts();
  const carried = emptyCarried();
  const perItemDelta = new Map<number, ItemDelta>();
  const exercised = new Set<number>();

  let coveredDollars = 0;
  let laborLinesWithCatalogReference = 0;
  let descriptionCorroborated = 0;
  let constantUnchanged = 0;
  let equipmentLines = 0;
  let equipmentCorroborated = 0;
  let equipmentExposed = 0;
  let equipmentCorroboratedDelta = 0;

  for (const activity of input.activities) {
    const disposition = classifyLaborLine(activity, input.parentLabor, input.draftLabor);
    const substituted = counterfactualActivity(activity, disposition);
    counterfactualActivities.push(substituted);

    byLine[disposition.line] += 1;
    byCraftLeg[disposition.craft] += 1;
    byWeldLeg[disposition.weld] += 1;

    const baseCosts = computeActivityCosts(activity, input.rates);
    const bucket = dollarBucketOf(activity, disposition.line);
    if (bucket === "covered") coveredDollars += baseCosts.totalCost;
    else carried[bucket] += baseCosts.totalCost;

    // ── The population versions of the sampled 92% and 84% ──
    if (activity.laborPoolId !== undefined && activity.labor) {
      laborLinesWithCatalogReference += 1;
      const parentRow = input.parentLabor.get(activity.laborPoolId);
      if (parentRow) {
        if (normalizeKey(activity.description) === normalizeKey(parentRow.description)) {
          descriptionCorroborated += 1;
        }
        if (activity.labor.craftConstant === parentRow.craftConstant) constantUnchanged += 1;
      }
    }

    // Exercised means REPRICED, not merely referenced: a line whose description
    // contradicts its own pointer names a poolId while telling us nothing about
    // it, and counting it as coverage would pad the one figure that is supposed
    // to admit how thin the evidence is.
    const repricedLeg = (leg: LegDisposition): boolean =>
      leg === "repriced" || leg === "repriced_no_delta";
    if (
      activity.laborPoolId !== undefined &&
      (repricedLeg(disposition.craft) || repricedLeg(disposition.weld))
    ) {
      exercised.add(activity.laborPoolId);
    }

    if (substituted !== activity && activity.laborPoolId !== undefined) {
      const cfCosts = computeActivityCosts(substituted, input.rates);
      const poolId = activity.laborPoolId;
      const existing = perItemDelta.get(poolId);
      const parentRow = input.parentLabor.get(poolId);
      perItemDelta.set(poolId, {
        description: existing?.description ?? parentRow?.description ?? activity.description,
        craftHours: (existing?.craftHours ?? 0) + (cfCosts.craftManHours - baseCosts.craftManHours),
        welderHours:
          (existing?.welderHours ?? 0) + (cfCosts.welderManHours - baseCosts.welderManHours),
        cost: (existing?.cost ?? 0) + (cfCosts.totalCost - baseCosts.totalCost),
        lines: (existing?.lines ?? 0) + 1,
      });
    }

    if (activity.type === "equipment") {
      equipmentLines += 1;
      const trace = traceEquipmentLine(activity, input.parentEquipment);
      if (trace?.descriptionCorroborated) equipmentCorroborated += 1;

      const poolId = activity.equipmentPoolId;
      const parentRow = poolId === undefined ? undefined : input.parentEquipment.get(poolId);
      const draftRow = poolId === undefined ? undefined : input.draftEquipment.get(poolId);
      if (parentRow) {
        // Retired and re-rated count as one exposure for the same reason they
        // are one disposition on the labor side: every equipment picker queries
        // `by_book_active`, so a row the draft deactivates is as gone as a row
        // it deletes, and either way this line no longer prices from what it
        // priced from. Counting only the rate move would report a draft that
        // retires half the yard as touching nothing.
        const retired = draftRow === undefined || !draftRow.isActive;
        const moved =
          draftRow !== undefined &&
          EQUIPMENT_TIERS.some((tier) => tierRate(parentRow, tier) !== tierRate(draftRow, tier));
        if (retired || moved) equipmentExposed += 1;

        // The one place a substitution is well defined: the row survives, the
        // description corroborates the link, and exactly one tier explains the
        // price. `trace.tier` is set only when the match is unambiguous.
        if (draftRow && !retired && trace?.descriptionCorroborated && trace.tier !== undefined) {
          const substitutedLine: BenchmarkActivity = {
            ...activity,
            unitPrice: tierRate(draftRow, trace.tier),
          };
          equipmentCorroboratedDelta +=
            computeActivityCosts(substitutedLine, input.rates).totalCost - baseCosts.totalCost;
        }
      }
    }
  }

  const baseline = rollUpProposal(input.activities, input.rates, NO_INDIRECT_WBS);
  const counterfactual = rollUpProposal(counterfactualActivities, input.rates, NO_INDIRECT_WBS);

  const computed = round2(baseline.costs.totalCost);
  const cached = input.cachedCostTotal;

  return {
    proposalNumber: input.proposalNumber,
    baseline,
    counterfactual,
    selfCheck: { cached, computed, matches: cached !== undefined && cached === computed },
    lines: { total: input.activities.length, byLine, byCraftLeg, byWeldLeg },
    coveredDollars,
    carriedDollars: carried,
    exercisedLaborPoolIds: [...exercised],
    measured: {
      laborLinesWithCatalogReference,
      descriptionCorroborated,
      constantUnchanged,
    },
    equipment: {
      lines: equipmentLines,
      corroborated: equipmentCorroborated,
      exposedToChange: equipmentExposed,
      corroboratedDelta: equipmentCorroboratedDelta,
    },
    perItemDelta,
  };
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/** One estimate, ranked by how far this book moved it. */
export interface ProposalMover {
  readonly proposalNumber: string;
  readonly baselineCost: number;
  readonly repricedCost: number;
  readonly delta: number;
  /** Unrounded, unlike the three figures above it — see {@link CarriedDollars}.
   *  Rounding it would also change the ranking of two near-identical movers. */
  readonly deltaPct: number;
}

/** One catalog item, ranked by how much of the movement it caused. */
export interface ItemMover extends ItemDelta {
  /**
   * A LABOR poolId, always: no equipment line is ever repriced, so no equipment
   * row can appear here. Resolved against the equipment pool it names a
   * different item — 61 is "8 CY TRUCK - 4 MILE" in one and "LIFTS - MANLIFT
   * 60'" in the other — which is why {@link BenchmarkReport.laborReach} and
   * {@link BenchmarkReport.equipmentReach} are two maps rather than one.
   */
  readonly poolId: number;
}

/**
 * The running state of a benchmark, mutated in place.
 *
 * Mutable and in place for the same reason `addCosts` is: this runs over
 * ~200,000 lines across ~713 estimates in a checkpointed action, and a fresh
 * struct per proposal is measurable.
 *
 * THIS shape is not the contract — read a finished run through
 * {@link finalizeBenchmark}, and store an interrupted one through
 * {@link BenchmarkAccumulatorSnapshot}, which is.
 */
export interface BenchmarkAccumulator {
  proposalsCompared: number;
  estimatesUnmoved: number;
  craftHoursBaseline: number;
  craftHoursRepriced: number;
  welderHoursBaseline: number;
  welderHoursRepriced: number;
  costBaseline: number;
  costRepriced: number;
  lineTotal: number;
  byLine: DispositionCounts;
  byCraftLeg: DispositionCounts;
  byWeldLeg: DispositionCounts;
  coveredDollars: number;
  carriedDollars: Record<CarriedBucket, number>;
  exercisedLaborPoolIds: Set<number>;
  perItemDelta: Map<number, ItemDelta>;
  selfCheckFailures: { proposalNumber: string; cached?: number; computed: number }[];
  laborLinesWithCatalogReference: number;
  descriptionCorroboratedLines: number;
  constantUnchangedLines: number;
  equipmentLines: number;
  equipmentCorroborated: number;
  equipmentExposed: number;
  equipmentCorroboratedDelta: number;
  byDollarUp: ProposalMover[];
  byDollarDown: ProposalMover[];
  byPercentUp: ProposalMover[];
  byPercentDown: ProposalMover[];
}

/**
 * The accumulator as a stored document — and THIS is the contract.
 *
 * The run walks ~713 estimates one at a time, checkpointing after each and
 * rescheduling itself, exactly as `applyImportBatch` and `cloneBatch` do. So the
 * accumulator has to survive between action invocations, and a `Set` and a `Map`
 * are not Convex values: written directly, `exercisedLaborPoolIds` and
 * `perItemDelta` come back as `{}`, and a run that died at estimate 600 would
 * resume reporting that no catalog item was exercised and no item moved any
 * money. Both are flattened to arrays here.
 *
 * It fits in a document with room to spare. `perItemDelta` is bounded by the
 * changed labor rows estimates actually exercise — at most ~1,270, the size of
 * the largest real change event, each a description and four numbers —
 * and `exercisedLaborPoolIds` by the labor pool's 5,897 rows.
 *
 * Every OTHER field is carried across by `Omit` and by the spread in
 * {@link serializeAccumulator}, so a counter added to the accumulator is
 * checkpointed without anyone remembering to. A third collection would not be:
 * it has to be flattened here and rebuilt in {@link reviveAccumulator}, and the
 * round-trip test is what says so out loud.
 */
export type BenchmarkAccumulatorSnapshot = Omit<
  BenchmarkAccumulator,
  "exercisedLaborPoolIds" | "perItemDelta"
> & {
  exercisedLaborPoolIds: readonly number[];
  perItemDelta: readonly (ItemDelta & { readonly poolId: number })[];
};

/** The accumulator as something the checkpoint can hold. */
export function serializeAccumulator(acc: BenchmarkAccumulator): BenchmarkAccumulatorSnapshot {
  return {
    ...acc,
    exercisedLaborPoolIds: [...acc.exercisedLaborPoolIds],
    perItemDelta: [...acc.perItemDelta].map(([poolId, item]) => ({ poolId, ...item })),
  };
}

/** The stored checkpoint, ready to be handed back to {@link accumulateProposal}. */
export function reviveAccumulator(snapshot: BenchmarkAccumulatorSnapshot): BenchmarkAccumulator {
  return {
    ...snapshot,
    exercisedLaborPoolIds: new Set(snapshot.exercisedLaborPoolIds),
    perItemDelta: new Map(
      snapshot.perItemDelta.map(({ poolId, ...item }): [number, ItemDelta] => [poolId, item])
    ),
  };
}

/** A zeroed accumulator, for the first checkpoint of a run. */
export function emptyBenchmarkAccumulator(): BenchmarkAccumulator {
  return {
    proposalsCompared: 0,
    estimatesUnmoved: 0,
    craftHoursBaseline: 0,
    craftHoursRepriced: 0,
    welderHoursBaseline: 0,
    welderHoursRepriced: 0,
    costBaseline: 0,
    costRepriced: 0,
    lineTotal: 0,
    byLine: emptyDispositionCounts(),
    byCraftLeg: emptyDispositionCounts(),
    byWeldLeg: emptyDispositionCounts(),
    coveredDollars: 0,
    carriedDollars: emptyCarried(),
    exercisedLaborPoolIds: new Set<number>(),
    perItemDelta: new Map<number, ItemDelta>(),
    selfCheckFailures: [],
    laborLinesWithCatalogReference: 0,
    descriptionCorroboratedLines: 0,
    constantUnchangedLines: 0,
    equipmentLines: 0,
    equipmentCorroborated: 0,
    equipmentExposed: 0,
    equipmentCorroboratedDelta: 0,
    byDollarUp: [],
    byDollarDown: [],
    byPercentUp: [],
    byPercentDown: [],
  };
}

function keepMover(
  list: ProposalMover[],
  mover: ProposalMover,
  score: (mover: ProposalMover) => number
): void {
  list.push(mover);
  list.sort((a, b) => score(b) - score(a));
  if (list.length > MOVER_LIMIT) list.length = MOVER_LIMIT;
}

function addCounts(target: DispositionCounts, source: Readonly<DispositionCounts>): void {
  for (const disposition of DISPOSITION_PRECEDENCE) target[disposition] += source[disposition];
}

/**
 * Fold one estimate into the run.
 *
 * Four mover lists rather than one, because a benchmark that only shows
 * increases is a benchmark somebody sorted — and because three estimates moving
 * 300% and 3,000 moving 0.3% produce the same aggregate and are completely
 * different risks.
 */
export function accumulateProposal(
  acc: BenchmarkAccumulator,
  result: ProposalBenchmarkResult
): void {
  acc.proposalsCompared += 1;

  const baselineCost = result.baseline.costs.totalCost;
  const repricedCost = result.counterfactual.costs.totalCost;
  acc.craftHoursBaseline += result.baseline.costs.craftManHours;
  acc.craftHoursRepriced += result.counterfactual.costs.craftManHours;
  acc.welderHoursBaseline += result.baseline.costs.welderManHours;
  acc.welderHoursRepriced += result.counterfactual.costs.welderManHours;
  acc.costBaseline += baselineCost;
  acc.costRepriced += repricedCost;

  // Rounded on both sides and again on the difference, so the estimate's own
  // delta is the one a reader could reproduce from the two figures beside it —
  // and so "unmoved" means unmoved to the cent rather than to the last bit.
  const delta = round2(round2(repricedCost) - round2(baselineCost));
  if (delta === 0) acc.estimatesUnmoved += 1;

  acc.lineTotal += result.lines.total;
  addCounts(acc.byLine, result.lines.byLine);
  addCounts(acc.byCraftLeg, result.lines.byCraftLeg);
  addCounts(acc.byWeldLeg, result.lines.byWeldLeg);

  acc.coveredDollars += result.coveredDollars;
  // Walked off the money object rather than off the phrase roster: the sentence
  // and the arithmetic answer to the same type, but a bucket must reach the
  // accumulator whether or not anyone has written a phrase for it yet.
  for (const bucket of Object.keys(acc.carriedDollars) as CarriedBucket[]) {
    acc.carriedDollars[bucket] += result.carriedDollars[bucket];
  }

  for (const poolId of result.exercisedLaborPoolIds) acc.exercisedLaborPoolIds.add(poolId);

  for (const [poolId, item] of result.perItemDelta) {
    const existing = acc.perItemDelta.get(poolId);
    acc.perItemDelta.set(poolId, {
      description: existing?.description ?? item.description,
      craftHours: (existing?.craftHours ?? 0) + item.craftHours,
      welderHours: (existing?.welderHours ?? 0) + item.welderHours,
      cost: (existing?.cost ?? 0) + item.cost,
      lines: (existing?.lines ?? 0) + item.lines,
    });
  }

  if (!result.selfCheck.matches) {
    acc.selfCheckFailures.push({
      proposalNumber: result.proposalNumber,
      cached: result.selfCheck.cached,
      computed: result.selfCheck.computed,
    });
  }

  acc.laborLinesWithCatalogReference += result.measured.laborLinesWithCatalogReference;
  acc.descriptionCorroboratedLines += result.measured.descriptionCorroborated;
  acc.constantUnchangedLines += result.measured.constantUnchanged;

  acc.equipmentLines += result.equipment.lines;
  acc.equipmentCorroborated += result.equipment.corroborated;
  acc.equipmentExposed += result.equipment.exposedToChange;
  acc.equipmentCorroboratedDelta += result.equipment.corroboratedDelta;

  if (delta !== 0) {
    // A percentage against a $0 baseline is infinity dressed as a fact. It is
    // NOT the 36 zero-rate estimates that land here — every rate they carry is
    // zero, so a constant change moves nothing and their delta never reaches
    // this branch at all. It is an estimate built entirely from the 134 labor
    // rows whose craftConstant is 0: a $0 labor baseline that becomes real
    // money the moment a draft gives those rows numbers, and "+∞%" is not a
    // rank, it is a division nobody checked.
    const deltaPct = baselineCost === 0 ? 0 : (delta / baselineCost) * 100;
    const mover: ProposalMover = {
      proposalNumber: result.proposalNumber,
      baselineCost: round2(baselineCost),
      repricedCost: round2(repricedCost),
      delta,
      deltaPct,
    };
    // Sorted into one direction only. Ranking every mover into both lists and
    // truncating would fill "the ten largest increases" with decreases whenever
    // fewer than ten estimates rose, which is the caption nobody re-reads
    // before forwarding it.
    if (delta > 0) {
      keepMover(acc.byDollarUp, mover, (m) => m.delta);
      if (baselineCost !== 0) keepMover(acc.byPercentUp, mover, (m) => m.deltaPct);
    } else {
      keepMover(acc.byDollarDown, mover, (m) => -m.delta);
      if (baselineCost !== 0) keepMover(acc.byPercentDown, mover, (m) => -m.deltaPct);
    }
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** A baseline/repriced pair with its movement, for hours. */
export interface HourMovement {
  readonly baseline: number;
  readonly repriced: number;
  readonly delta: number;
  readonly deltaPct: number;
}

/** The finished run, as data. Every caveat travels with the numbers. */
export interface BenchmarkReport {
  readonly parentBookName: string;
  readonly basedOnContentRevision: number;
  readonly proposalsCompared: number;
  readonly proposalsExcluded: readonly { proposalNumber: string; bookId: string }[];
  readonly selfCheckFailures: readonly {
    proposalNumber: string;
    cached?: number;
    computed: number;
  }[];

  readonly craftHours: HourMovement;
  readonly welderHours: HourMovement;
  readonly cost: { baseline: number; repriced: number; delta: number };
  /** Both denominators, labelled, never one alone. */
  readonly deltaPctOfRepricedLabor: number;
  readonly deltaPctOfGrandTotal: number;

  readonly lines: LineAccounting;
  readonly coveredDollars: number;
  readonly carriedDollars: CarriedDollars;
  /** Roughly 700 estimates should be dead still if three constants changed.
   *  Seeing those zeros is the evidence the machinery is not fabricating motion. */
  readonly estimatesUnmoved: number;

  readonly coverage: {
    readonly changedLaborPoolIds: number;
    readonly changedEquipmentPoolIds: number;
    readonly exercisedLaborPoolIds: number;
    /** Named, never averaged away: all 713 estimates cannot exercise 5,897 rows,
     *  and "41 of 380 changed rows measured" is the true state of the evidence. */
    readonly neverExercised: readonly number[];
  };
  readonly measuredRates: MeasuredRates;

  /**
   * Changed labor poolId -> activity lines referencing it, `501` meaning "500+".
   *
   * SEPARATE from {@link BenchmarkReport.equipmentReach} because the two id
   * spaces overlap completely rather than occasionally: equipment ids run 0–133
   * and every one of them is also a labor id — 61 is "LIFTS - MANLIFT 60'" in
   * one pool and "8 CY TRUCK - 4 MILE" in the other. One map keyed by a bare
   * poolId silently reports one item's line count against the other's name,
   * which is the same hazard `ShiftBand.id` and the `retire:` ack keys are pool-
   * qualified to avoid. The caller counts these through two indexes anyway.
   */
  readonly laborReach: ReadonlyMap<number, number>;
  /** Changed equipment poolId -> activity lines referencing it. Never merged
   *  with {@link BenchmarkReport.laborReach} — see there. */
  readonly equipmentReach: ReadonlyMap<number, number>;
  /** Covers BOTH maps: an index build makes neither readable. "reach
   *  unavailable — index still building" and "referenced by 0 activities" are
   *  opposite statements that look identical. */
  readonly reachAvailable: boolean;

  readonly equipment: {
    readonly facts: EquipmentRateFacts;
    readonly linesTotal: number;
    readonly linesCorroborated: number;
    /** Lines whose parent row the draft re-rated OR retired. Retirement counts
     *  because every equipment picker queries `by_book_active`, so a deactivated
     *  row is as gone as a deleted one and the line no longer prices from what it
     *  priced from. `facts.changedRows` counts rate movement alone, so on a
     *  draft that only retires rows these two disagree by design. */
    readonly linesExposedToChange: number;
    /** NON-ADDITIVE. Separate key so a UI cannot fold it into the headline. */
    readonly corroboratedDelta: number;
    readonly carriedDollars: number;
  };

  readonly movers: {
    readonly byDollarUp: readonly ProposalMover[];
    readonly byDollarDown: readonly ProposalMover[];
    readonly byPercentUp: readonly ProposalMover[];
    readonly byPercentDown: readonly ProposalMover[];
    readonly byItem: readonly ItemMover[];
  };

  /** Required, non-empty. Data, not UI decoration a redesign can drop. */
  readonly caveats: readonly string[];
  readonly measuredNothing: boolean;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly triggeredBy: string;
  readonly activityDocumentsRead: number;
}

/**
 * A baseline/repriced pair with its movement, rounded at the report boundary.
 *
 * Hours are a reported quantity, not an intermediate — `costEngine.ts` says so
 * in `round2`'s own note — and this is where the run stops accumulating and
 * starts being read. Unrounded, 3 EA at a 0.7 constant reports 2.0999999999999996
 * craft hours, and the cost total beside it was rounded, so one figure in the
 * pair reads as a number the software does not understand. Taking the delta from
 * the ROUNDED pair is what makes baseline plus delta equal repriced on the page.
 */
function movement(rawBaseline: number, rawRepriced: number): HourMovement {
  const baseline = round2(rawBaseline);
  const repriced = round2(rawRepriced);
  const delta = round2(repriced - baseline);
  return {
    baseline,
    repriced,
    delta,
    deltaPct: baseline === 0 ? 0 : (delta / baseline) * 100,
  };
}

/**
 * Turn a finished accumulator into the report, caveats included.
 *
 * The caveats are computed from the assembled figures and then attached, so a
 * number and the sentence qualifying it can never be separated by a caller that
 * forgot to ask for both.
 */
export function finalizeBenchmark(args: {
  readonly acc: BenchmarkAccumulator;
  readonly changedLaborPoolIds: readonly number[];
  readonly changedEquipmentPoolIds: readonly number[];
  readonly equipmentFacts: EquipmentRateFacts;
  readonly laborReach: ReadonlyMap<number, number>;
  readonly equipmentReach: ReadonlyMap<number, number>;
  readonly reachAvailable: boolean;
  readonly excludedProposals: readonly { proposalNumber: string; bookId: string }[];
  readonly parentBookName: string;
  readonly basedOnContentRevision: number;
  readonly triggeredBy: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly activityDocumentsRead: number;
}): BenchmarkReport {
  const acc = args.acc;

  // The same tie-out `movement` makes for hours: the three cost figures a
  // reader sees must be arithmetic on each other, not three independent
  // roundings of an accumulator.
  const costBaseline = round2(acc.costBaseline);
  const costRepriced = round2(acc.costRepriced);
  const costDelta = round2(costRepriced - costBaseline);
  const neverExercised = args.changedLaborPoolIds.filter(
    (poolId) => !acc.exercisedLaborPoolIds.has(poolId)
  );
  const exercisedChanged = args.changedLaborPoolIds.length - neverExercised.length;

  const denominator = acc.laborLinesWithCatalogReference;
  const descriptionCorroborated =
    denominator === 0 ? 0 : acc.descriptionCorroboratedLines / denominator;
  const constantUnchanged = denominator === 0 ? 0 : acc.constantUnchangedLines / denominator;

  const byItem: ItemMover[] = [...acc.perItemDelta.entries()]
    .map(([poolId, item]) => ({ poolId, ...item }))
    .sort((a, b) => Math.abs(b.cost) - Math.abs(a.cost))
    .slice(0, MOVER_LIMIT);

  // "It told you nothing" is a real outcome, and the only dangerous version of
  // it is a confident, correct, meaningless $0.00. An equipment-only draft lands
  // here too: no labor row changed, so nothing could be exercised.
  const measuredNothing = acc.proposalsCompared === 0 || exercisedChanged === 0;

  const report: BenchmarkReport = {
    parentBookName: args.parentBookName,
    basedOnContentRevision: args.basedOnContentRevision,
    proposalsCompared: acc.proposalsCompared,
    proposalsExcluded: args.excludedProposals,
    selfCheckFailures: acc.selfCheckFailures,

    craftHours: movement(acc.craftHoursBaseline, acc.craftHoursRepriced),
    welderHours: movement(acc.welderHoursBaseline, acc.welderHoursRepriced),
    cost: { baseline: costBaseline, repriced: costRepriced, delta: costDelta },
    deltaPctOfRepricedLabor: acc.coveredDollars === 0 ? 0 : (costDelta / acc.coveredDollars) * 100,
    deltaPctOfGrandTotal: costBaseline === 0 ? 0 : (costDelta / costBaseline) * 100,

    lines: {
      total: acc.lineTotal,
      byLine: acc.byLine,
      byCraftLeg: acc.byCraftLeg,
      byWeldLeg: acc.byWeldLeg,
    },
    coveredDollars: acc.coveredDollars,
    carriedDollars: acc.carriedDollars,
    estimatesUnmoved: acc.estimatesUnmoved,

    coverage: {
      changedLaborPoolIds: args.changedLaborPoolIds.length,
      changedEquipmentPoolIds: args.changedEquipmentPoolIds.length,
      exercisedLaborPoolIds: exercisedChanged,
      neverExercised,
    },
    measuredRates: {
      laborLinesWithCatalogReference: denominator,
      descriptionCorroborated,
      constantUnchanged,
      divergesFromSample:
        denominator > 0 &&
        (Math.abs(descriptionCorroborated - SAMPLED_DESCRIPTION_CORROBORATED) >
          SAMPLE_DIVERGENCE_TOLERANCE ||
          Math.abs(constantUnchanged - SAMPLED_CONSTANT_UNCHANGED) > SAMPLE_DIVERGENCE_TOLERANCE),
    },

    laborReach: args.laborReach,
    equipmentReach: args.equipmentReach,
    reachAvailable: args.reachAvailable,

    equipment: {
      facts: args.equipmentFacts,
      linesTotal: acc.equipmentLines,
      linesCorroborated: acc.equipmentCorroborated,
      linesExposedToChange: acc.equipmentExposed,
      corroboratedDelta: round2(acc.equipmentCorroboratedDelta),
      carriedDollars: acc.carriedDollars.equipment,
    },

    movers: {
      byDollarUp: acc.byDollarUp,
      byDollarDown: acc.byDollarDown,
      byPercentUp: acc.byPercentUp,
      byPercentDown: acc.byPercentDown,
      byItem,
    },

    caveats: [],
    measuredNothing,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    triggeredBy: args.triggeredBy,
    activityDocumentsRead: args.activityDocumentsRead,
  };

  return { ...report, caveats: benchmarkCaveats(report) };
}

/** Two decimals with thousands separators. Presentation, never arithmetic. */
function usd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const [whole = "0", cents = "00"] = Math.abs(amount).toFixed(2).split(".");
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * The sentences the report must carry about itself, in this order.
 *
 * Returned as required data on the response rather than as screen furniture, so
 * a figure pasted into an email still carries them. It does not solve somebody
 * cropping a screenshot — nothing does — but it means every path that renders
 * the number has the qualification in hand.
 *
 * The self-check sentence, when there is one, comes FIRST and out of order: a
 * run whose baseline does not reproduce the app's own recorded total is not a
 * report yet, and burying that under a counterfactual disclaimer would be the
 * one ordering that gets somebody hurt.
 */
export function benchmarkCaveats(report: BenchmarkReport): readonly string[] {
  const caveats: string[] = [];

  if (report.selfCheckFailures.length > 0) {
    const first = report.selfCheckFailures[0];
    const missing = report.selfCheckFailures.filter((f) => f.cached === undefined).length;
    caveats.push(
      `READ NOTHING BELOW YET. ${report.selfCheckFailures.length} of ${report.proposalsCompared} ` +
        `estimates did not reproduce the total the app itself recorded for them` +
        (first
          ? ` — estimate ${first.proposalNumber} computes ${usd(first.computed)} against a recorded ` +
            (first.cached === undefined ? "total that was never written" : usd(first.cached))
          : "") +
        `. ${missing > 0 ? `${missing} of them have never been totalled at all; run the totals backfill. ` : ""}` +
        `Until this is zero, every figure here is measuring something other than these estimates.`
    );
  }

  caveats.push(
    `This is a counterfactual. Nothing below happens to a finished estimate. All ` +
      `${report.proposalsCompared} are pinned to the book they were priced under, published books ` +
      `are frozen, and every activity carries its own copy of the constants it was priced with — ` +
      `the cost engine reads those, never the catalog. Publishing moves no money on any existing ` +
      `bid. This shows what these estimates WOULD have cost, because that is the closest available ` +
      `preview of what next month's estimates will do.`
  );

  // Walked, never hand-written. The reader adds these up against the covered
  // figure beside them, so the list has to be the object — a bucket named in one
  // and missing from the other is money that exists and is called nothing.
  const carried = report.carriedDollars;
  const notCovered = CARRIED_BUCKETS.filter((bucket) => carried[bucket] !== 0).map(
    (bucket) => `${usd(carried[bucket])} of ${CARRIED_BUCKET_PHRASES[bucket]}`
  );

  const grandTotal = report.cost.baseline;
  caveats.push(
    `This figure covers ${usd(report.coveredDollars)} of labor cost. It does not cover ` +
      `${notCovered.length > 0 ? notCovered.join(", ") : "nothing else — every dollar was repriceable"}. ` +
      `It is about ${grandTotal === 0 ? "0.0%" : pct(report.coveredDollars / grandTotal)} of the ` +
      `money in these estimates.`
  );

  caveats.push(
    `The repricing uses each estimate's own historical rates. A 2019 bid's craft base rate is not ` +
      `today's. The delta answers what the constants would have done to that bid, not what that job ` +
      `would cost today.`
  );

  // One linked line is not an exotic population: it is the first estimate of any
  // young book, and it is the state this caveat is most likely to be read in.
  // "100.0% of 1 linked labor lines corroborate" is the sentence that tells a
  // reader the software cannot count, in the one paragraph asking them to trust
  // a measured proportion.
  const linked = report.measuredRates.laborLinesWithCatalogReference;
  caveats.push(
    `The licence has a limit in both directions. "The snapshot equals the catalog constant" cannot ` +
      `distinguish an untouched line from an estimator who deliberately typed the value the catalog ` +
      `already held, which overstates the repriceable set; requiring the description to match ` +
      `understates it by excluding lines where the estimator merely retyped a label. Two errors ` +
      `pointing opposite ways, with no reason to believe they cancel. Measured here: ` +
      `${pct(report.measuredRates.descriptionCorroborated)} of ${linked} linked labor ` +
      `${linked === 1 ? "line corroborates" : "lines corroborate"}` +
      `${report.measuredRates.divergesFromSample ? ", which diverges from the 92%/84% sampled across 18 proposals — the labor rule needs revisiting" : ""}.`
  );

  caveats.push(
    `This run is a snapshot, taken ${new Date(report.finishedAt).toISOString()}. Activities change ` +
      `constantly; exposure, coverage and reach are true as of that moment and no later.`
  );

  if (report.measuredNothing) {
    caveats.push(
      report.proposalsCompared === 0
        ? `No estimate is pinned to "${report.parentBookName}" yet, so nothing could be repriced. ` +
            `What is above is a catalog delta profile, explicitly not a money figure.`
        : `This draft changes ${report.coverage.changedEquipmentPoolIds} equipment rows and ` +
            `${report.coverage.changedLaborPoolIds} labor constants, of which ` +
            `${report.coverage.exercisedLaborPoolIds} appear on any estimate. This benchmark cannot ` +
            `price equipment. It has told you nothing about this draft.`
    );
  }

  return caveats;
}
