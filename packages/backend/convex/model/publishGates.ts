import type { PoolKind } from "./rateBookCsv";
import { CARRIED_BUCKET_PHRASES } from "./repriceBenchmark";
import type { CarriedBucket } from "./repriceBenchmark";

/**
 * Whether this draft may become a permanent book.
 *
 * ⚠️ THIS MODULE NEVER TOUCHES A `ctx`, AND THAT IS A PERMANENT CONSTRAINT
 * RATHER THAN AN IMPLEMENTATION NOTE. Every gate below is decided from facts
 * the caller has already gathered — integers, summaries, a handful of bounded
 * lists — so `publishBook` stays ONE transaction with ONE write to the book
 * document. The first gate somebody adds that scans 12,000 rows makes
 * publishing non-atomic, and a half-published book is the single state this
 * whole subsystem exists to make impossible.
 *
 * That constraint is why the per-row judgement calls below are expressed as
 * COUNTS rather than as a list of row ids: enumerating the 51 flagged rows
 * inside the publish mutation would mean reading them there. The admin ticks
 * them off one at a time on the review screen, which reports how many were
 * actually confirmed; publish only has to compare two integers.
 *
 * WHY THE FACT TYPES ARE DECLARED HERE. `DiffFacts` and `BenchmarkFacts` are
 * the exact — and only — fields the gates read. `DiffSummary` from
 * `model/rateBookDiff` and `BenchmarkReport` from `model/repriceBenchmark`
 * satisfy them structurally and are passed straight through by the caller; the
 * narrower shapes are what keeps a future report field from quietly becoming a
 * publish precondition nobody reviewed.
 *
 * The one exception is a VALUE import, `CARRIED_BUCKET_PHRASES`. The
 * acknowledgement sentence states the sum of every carried bucket and then names
 * them, and a hand-written list drifted from the object once already: the
 * eighth bucket reached the sum while the prose still named seven, so $4,000,000
 * of a stated $5,000,000 was money named nowhere and both files compiled.
 * Sharing the phrases means the sum and the list walk one object, so a ninth
 * bucket cannot reach one without the other. It still has to be TYPED once —
 * into `CARRIED_BUCKET_PHRASES` itself, where `Record<CarriedBucket, string>`
 * refuses to compile without it. Nothing in this file needs editing at all.
 *
 * Pure, so the whole gate matrix is unit-tested in plain Node.
 * `repriceBenchmark` and everything under it are Convex-free too, so the value
 * import costs nothing at the boundary.
 */

/** Gate numbers are permanent. G0 and G4 keep the meanings `publishBook` gave them. */
export type GateId = "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10";

/**
 * There is no "warn".
 *
 * A gate that reports a concern without stopping anything is a gate people
 * learn to scroll past, and the one thing this screen cannot afford is to
 * teach its reader that its own words are decoration.
 */
export type GateVerdict = "pass" | "block";

export interface GateResult {
  readonly id: GateId;
  readonly name: string;
  readonly verdict: GateVerdict;
  /** Written for the admin, naming numbers and the remedy. Never a stack trace. */
  readonly message?: string;
  /**
   * The same facts the message states, machine-readable.
   *
   * `boolean` is in here because G8's fact is an EXISTENCE rather than a count —
   * see {@link PublishFacts.unpinnedProposals}. Coercing it to 0/1 would put a
   * number in a detail whose message deliberately refuses to name one.
   */
  readonly detail?: Readonly<Record<string, number | string | boolean>>;
}

/** How much of the draft one signature covers. */
export type AckScope = "row" | "band" | "group" | "pool" | "run";

/**
 * The shapes of change a person is asked to put a name against.
 *
 * Mirrors `DiffFlag` in `model/rateBookDiff`. A flag that gains a member there
 * and not here is simply never asked about, so the two lists are meant to be
 * read side by side.
 */
export type DiffFlag =
  | "shifted_payload"
  | "description_swap"
  | "decimal_shift"
  | "implausible_magnitude"
  | "large_change"
  | "zeroed_constant"
  | "constant_activated"
  | "unit_changed"
  | "rate_tier_inversion"
  | "reparented"
  | "takeoff_flags_bulk"
  | "live_read_field";

/** How a field's change reaches an estimate. Mirrors `EffectClass` in `rateBookDiff`. */
export type EffectClass = "priced_at_creation" | "read_live";

export interface AckRequirement {
  /** Stable across re-runs of the same diff, so a signature survives a reload. */
  readonly key: string;
  readonly scope: AckScope;
  readonly flag?: DiffFlag;
  readonly poolId?: number;
  readonly pool?: PoolKind;
  /** How many catalog rows this one signature is being asked to cover. */
  readonly coveredRowCount: number;
  readonly requiresTypedReason: boolean;
  /** The sentence the admin is agreeing to, composed from what was measured. */
  readonly text: string;
}

export interface Acknowledgement {
  readonly key: string;
  readonly coveredRowCount: number;
  readonly atContentRevision: number;
  readonly by: string;
  readonly at: number;
  readonly reason?: string;
}

/** Per-pool integrity, as `rateBookDiff`'s `PoolIntegrity` reports it. */
export interface PoolIntegrityFacts {
  readonly pool: PoolKind;
  readonly draftRowCount: number;
  readonly parentRowCount: number;
  readonly duplicatePoolIds: readonly number[];
  readonly missingFromDraft: readonly number[];
  readonly keyCollisions: readonly string[];
  readonly danglingParentRefs: readonly {
    readonly poolId: number;
    readonly parentPoolId: number;
  }[];
  readonly addedCount: number;
  readonly deactivatedCount: number;
  /**
   * Rows this draft brought back. Counted here because a returning row reappears
   * in `by_book_active` and therefore in `loadTakeoffCatalog` on every estimate,
   * so 400 rows coming back is as large an event as 400 leaving — and
   * {@link DiffFacts.massChangePools} already counts it as one.
   */
  readonly reactivatedCount: number;
  readonly editedCount: number;
}

/** The two thresholds the gate text has to quote back. */
export interface DiffThresholdFacts {
  readonly largeChangeRatio: number;
  readonly massChangeFraction: number;
}

export interface ShiftBandFacts {
  /** `shift:<pool>:<offset>:<start>-<end>`, as `detectShiftBands` mints it. */
  readonly id: string;
  /**
   * Which catalog's ids 12–480 are. Equipment numbers its rows from 0 and stops
   * around 133, so "ids 12 to 480" without a pool in front of it names a range
   * that exists in two catalogs and identifies neither.
   */
  readonly pool: PoolKind;
  readonly offset: number;
  readonly startPoolId: number;
  readonly endPoolId: number;
  readonly rowCount: number;
}

export interface SystematicGroupFacts {
  readonly id: string;
  readonly parentPoolId?: number;
  readonly field: string;
  readonly ratio: number;
  readonly rowCount: number;
  readonly exampleDescriptions: readonly string[];
}

/** Everything the gates read out of a finished comparison. */
export interface DiffFacts {
  readonly pools: readonly PoolIntegrityFacts[];
  readonly changedRowCount: number;
  readonly unchangedRowCount: number;
  readonly flagCounts: Readonly<Record<DiffFlag, number>>;
  readonly effectCounts: Readonly<Record<EffectClass, number>>;
  readonly shiftBands: readonly ShiftBandFacts[];
  readonly systematicGroups: readonly SystematicGroupFacts[];
  readonly changedLaborPoolIds: readonly number[];
  readonly changedEquipmentPoolIds: readonly number[];
  readonly bulkEditPools: readonly PoolKind[];
  /**
   * `max(added, deactivated, reactivated) / parent` cleared the threshold —
   * WHICH of the three it was is not in here, so a gate that wants to talk
   * about additions has to check the pool's own `addedCount` before it says the
   * word, and one that says nothing about reactivations leaves a pool that
   * cleared the bar with no question against it at all.
   */
  readonly massChangePools: readonly PoolKind[];
  readonly takeoffFlagBulkPhases: readonly number[];
  readonly thresholds: DiffThresholdFacts;
}

/** Everything the gates read out of a finished benchmark. */
export interface BenchmarkFacts {
  readonly parentBookName: string;
  readonly proposalsCompared: number;
  readonly selfCheckFailures: readonly {
    readonly proposalNumber: string;
    readonly cached?: number;
    readonly computed: number;
  }[];
  readonly cost: { readonly delta: number };
  readonly deltaPctOfRepricedLabor: number;
  readonly deltaPctOfGrandTotal: number;
  /**
   * EVERY bucket `CarriedDollars` carries, because the sentence built from them
   * claims to be the money the headline does not cover.
   *
   * Keyed off `CarriedBucket` rather than written out, because writing it out is
   * what failed: the seven-key literal that stood here stayed assignable when
   * `unitRedefinedLabor` was added, so the sum grew by $4,000,000 while the
   * prose still named seven categories. A `Record` of the union makes the same
   * omission a compile error in this file.
   */
  readonly carriedDollars: Readonly<Record<CarriedBucket, number>>;
  readonly estimatesUnmoved: number;
  readonly coverage: {
    readonly changedLaborPoolIds: number;
    readonly exercisedLaborPoolIds: number;
  };
  readonly equipment: {
    readonly linesTotal: number;
    readonly linesCorroborated: number;
  };
  readonly caveats: readonly string[];
  /** The run measured no money at all, and saying "$0.00" would be a lie of shape. */
  readonly measuredNothing: boolean;
}

export interface PublishFacts {
  readonly book: {
    readonly name: string;
    readonly bookNumber: number;
    readonly parentBookName: string;
    readonly status: "draft" | "published" | "archived";
    readonly buildState: "building" | "ready" | "failed";
    /**
     * `rateBooks.lock.op`, and the caller owes this field three things.
     *
     * The diff and benchmark actions must TAKE the lock while they compute and
     * RELEASE it before anyone reads the result — an admin reading a diff must
     * not block the import that diff told them to run. `applyImport` must take
     * it too, or G0 means nothing while a file is being written.
     *
     * And a stale lock must be reaped. `heartbeatAt` exists on `rateBooks.lock`
     * and `cloneBatch` refreshes it, but nothing reads it: an action that dies
     * to a deploy leaves the lock set, G0 blocks publish forever, and the
     * at-most-one-open-draft rule means the admin cannot even start over. A cron
     * clearing any lock older than 10 minutes and marking the owning job failed
     * is a prerequisite of this gate, not a nice-to-have.
     */
    readonly lockOp?: string;
    /**
     * `rateBooks.contentRevision`, incremented once per transaction that writes
     * any pool row — `writePoolRow`, `insertPoolRow` and `revertImportBatch`'s
     * delete path, all through one `touchDraft` helper. Convex coalesces
     * repeated writes to one document, so a 300-row apply costs one increment.
     *
     * THIS INTEGER IS THE WHOLE STALENESS STORY. G5 compares it against the
     * diff's start and finish stamps, G7 against the benchmark's, G10 against
     * the revision the publish screen rendered, and every acknowledgement is
     * void the moment it moves. If one writer forgets to bump it, all three
     * gates start passing on a comparison of a catalog that no longer exists,
     * and this file becomes decoration that looks like a control.
     */
    readonly contentRevision: number;
    /** What the UI told the admin to type — the book's own name. */
    readonly confirmName: string;
    /** What they actually typed. */
    readonly typedName: string;
    /**
     * What they typed into the release-notes box, and only that.
     *
     * NOT `rateBooks.notes`: what the book keeps is
     * {@link composePublishNotes}'s output, which is this text plus the numbers
     * that were on the screen. Named `typedNotes` beside `typedName` so one word
     * cannot mean the form field before publish and the stored record after it.
     */
    readonly typedNotes: string;
    /** `rateBooks.rowCounts`, absent on books written before it existed. */
    readonly recordedRowCounts?: Readonly<Record<PoolKind, number>>;
    /** The revision the publish screen was rendered from. */
    readonly expectedContentRevision?: number;
  };
  readonly diff?: {
    readonly state: "running" | "ready" | "failed";
    readonly summary: DiffFacts;
    readonly startedAtContentRevision: number;
    readonly finishedAtContentRevision: number;
    readonly reviewedBy?: string;
    readonly reviewedAtContentRevision?: number;
  };
  readonly benchmark?: {
    readonly state: "running" | "ready" | "failed";
    readonly report: BenchmarkFacts;
    readonly basedOnContentRevision: number;
    readonly acknowledgedBy?: string;
    readonly acknowledgedAtContentRevision?: number;
  };
  readonly acknowledgements: readonly Acknowledgement[];
  /**
   * WHETHER any estimate is pinned to no rate book, not how many.
   *
   * Read LIVE inside the publish mutation, never carried on a summary — the
   * 6-hourly proposals sync creates unpinned estimates on its own, so any
   * precomputed figure is wrong within six hours of being written. The live read
   * is `.withIndex(q => q.eq("bookId", undefined)).take(1)`: one document,
   * exact, impossible to be stale. A boolean is what that read returns, and it
   * is also the whole decision — the remedy is "pin them" whether there is one
   * or four thousand, and this gate is not the place to spend 500 reads inside
   * the publish transaction to put a number on a sentence nobody acts on
   * differently.
   */
  readonly unpinnedProposals: boolean;
  readonly unpinnedProjects: boolean;
  /**
   * Every import on this book in one of the FIVE unfinished states —
   * `staging`, `review`, `applying`, `reverting`, `failed` — read from
   * `by_book_state`.
   *
   * The other three states in the schema (`applied`, `reverted`, `discarded`)
   * are finished and belong to nobody's decision. G9 filters them out rather
   * than trusting the caller, because handing one over used to produce
   * `"labor.csv" is still being read (applied)` — a sentence about a file that
   * finished, printed by the gate whose job is to be believed.
   */
  readonly openImports: readonly {
    readonly fileName: string;
    readonly state: string;
    readonly pool: string;
  }[];
  /**
   * Deactivated draft rows whose poolId still has live activity lines, capped at
   * {@link DEACTIVATED_WITH_LIVE_LINES_CAP}.
   *
   * THE ONE FIELD HERE THAT IS NOT FREE. Every other member of `PublishFacts` is
   * an integer, a bounded list or a stored summary; this one costs an index read
   * per deactivated row plus a document read for each `description`, INSIDE the
   * publish transaction. A draft that retires 400 rows at once is a designed-for
   * case — `massChangePools` exists for it — so an uncapped read here is how the
   * no-`ctx` rule at the top of this file gets broken from the outside.
   *
   * `pool` is not decoration: a poolId names one row within its pool and
   * nowhere else. Equipment ids start at 0 and stop around 129, so every one of
   * them also exists in labor, and a signature keyed on the number alone would
   * let one confirmation retire two unrelated items.
   */
  readonly deactivatedWithLiveLines: readonly DeactivatedWithLiveLines[];
  /**
   * How many more there were past the cap. 0 when the list above is whole.
   *
   * The caller counts them — that is cheap, it is one index read per deactivated
   * row — and stops reading descriptions at the cap, which is the expensive
   * half. Without this number the gate asks about 60 retirements out of 400 and
   * says nothing about the other 340.
   */
  readonly deactivatedWithLiveLinesBeyondCap: number;
}

/**
 * How many retirements are confirmed one at a time before the rest become one
 * decision.
 *
 * 50, and the reason is the read budget rather than taste: past this the publish
 * mutation is doing hundreds of document reads to compose a list nobody reads
 * one at a time. A retirement large enough to be a policy is already covered —
 * `massChangeFraction` is 0.05, so 7 equipment rows or 295 labor rows trip the
 * pool-scoped `mass_deactivation` requirement, which is the decision at that
 * size. The per-row questions exist for the small deliberate case, and the
 * remainder is named out loud rather than dropped.
 */
export const DEACTIVATED_WITH_LIVE_LINES_CAP = 50;

/**
 * The five import states that are still somebody's decision.
 *
 * The other three the schema allows — `applied`, `reverted`, `discarded` — are
 * finished and belong to nobody's. G9 filters on this rather than trusting its
 * caller to have queried `by_book_state` correctly, because one finished import
 * arriving in the list produced `"labor.csv" is still being read (applied)`: a
 * confident sentence about a file that completed, printed by the gate whose
 * entire job is to be believed.
 */
const OPEN_IMPORT_STATES: ReadonlySet<string> = new Set([
  "staging",
  "review",
  "applying",
  "reverting",
  "failed",
]);

/** One retired row that estimates are still pointing at. */
export interface DeactivatedWithLiveLines {
  readonly pool: PoolKind;
  readonly poolId: number;
  readonly description: string;
  readonly lines: number;
}

export interface PublishReadiness {
  readonly canPublish: boolean;
  readonly gates: readonly GateResult[];
  readonly blocking: readonly GateResult[];
  readonly outstandingAcknowledgements: readonly AckRequirement[];
}

/**
 * The one requirement G7 owns rather than G6.
 *
 * It is generated here so the sentence a person agrees to is composed in
 * exactly one place, from what the run actually measured — but it is satisfied
 * by the stamp on the benchmark header, not by a row in the acknowledgement
 * table, so there is one source of truth for "this benchmark was read".
 */
export const BENCHMARK_ACK_KEY = "benchmark:read";

// ── Formatting ──────────────────────────────────────────────────────────────
// Hand-rolled rather than Intl: these strings end up in a book's permanent
// `notes`, and a number that renders differently depending on where the
// mutation ran would make two books' notes incomparable.

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function int(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${group(String(Math.round(Math.abs(value))))}`;
}

function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [whole = "0", cents = "00"] = Math.abs(value).toFixed(2).split(".");
  return `${sign}$${group(whole)}.${cents}`;
}

/** Signed, because "labor moved 4%" and "labor moved -4%" are different news. */
function signedPct(value: number): string {
  return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(1)}%`;
}

function sharePct(part: number, whole: number): string {
  if (whole <= 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function list(values: readonly (string | number)[], max: number): string {
  const shown = values.slice(0, max).join(", ");
  return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

// ── Acknowledgement requirements ────────────────────────────────────────────

/**
 * Shapes of error, never sizes of change.
 *
 * Each of these says something is probably WRONG, and re-reading the row is
 * the whole decision — so they are confirmed one at a time with a reason
 * typed, and no grouping rule may ever collapse them. `implausible_magnitude`
 * and `rate_tier_inversion` are here even though the panel's scope list omits
 * them: the differ resolves flags worst-first, so a 40x move can arrive
 * carrying `implausible_magnitude` and NOT `large_change`, and would otherwise
 * pass through every gate without anyone deciding anything.
 */
type PerRowAckFlag =
  | "zeroed_constant"
  | "decimal_shift"
  | "unit_changed"
  | "rate_tier_inversion"
  | "implausible_magnitude"
  | "description_swap";

const PER_ROW_ACK_FLAGS: readonly PerRowAckFlag[] = [
  "zeroed_constant",
  "decimal_shift",
  "unit_changed",
  "rate_tier_inversion",
  "implausible_magnitude",
  "description_swap",
];

const PER_ROW_ACK_TEXT: Readonly<Record<PerRowAckFlag, (rows: number) => string>> = {
  zeroed_constant: (n) =>
    `${int(n)} ${n === 1 ? "constant that was a real number is now 0" : "constants that were real numbers are now 0"}. ` +
    `Every future estimate will price that work at nothing, and nothing on any screen will say so. ` +
    `Open each one and confirm the work really is free.`,
  decimal_shift: (n) =>
    `${int(n)} ${n === 1 ? "value" : "values"} changed by a factor of exactly ten. ` +
    `A decimal point moved is exactly 10x, and no re-rate anybody argues for lands within half a percent of ten-fold. ` +
    `Confirm each one is a rate decision and not a typo.`,
  unit_changed: (n) =>
    `${int(n)} ${n === 1 ? "row" : "rows"} changed craft, weld or takeoff units. ` +
    `0.6 LF and 0.6 EA differ by ten times on a ten-foot spool and the number itself looks untouched, ` +
    `so nothing else in this comparison would catch it.`,
  rate_tier_inversion: (n) =>
    `${int(n)} equipment ${n === 1 ? "row has" : "rows have"} period rates out of order — an hour dearer than a day, ` +
    `or a week dearer than a month. These are cumulative prices (book #1 id 5 is 7/56/224/672), ` +
    `so an inversion is wrong on its face with no history needed.`,
  implausible_magnitude: (n) =>
    `${int(n)} ${n === 1 ? "value moved" : "values moved"} by ten times or more without being an exact decimal slip. ` +
    `Productivity revisions run single-digit percent, at most a doubling. Confirm each one.`,
  description_swap: (n) =>
    `${int(n)} ${n === 1 ? "description now sits" : "descriptions now sit"} at a different id than in the parent book, ` +
    `with too few moving together to be a band. Either two items were deliberately swapped, or an id column slipped. ` +
    `Confirm each one by name.`,
};

function bandRequirement(band: ShiftBandFacts): AckRequirement {
  return {
    key: `band:${band.id}`,
    scope: "band",
    flag: "shifted_payload",
    coveredRowCount: band.rowCount,
    requiresTypedReason: true,
    text:
      `${int(band.rowCount)} descriptions moved by exactly ${band.offset > 0 ? "+" : ""}${band.offset} ids, ` +
      `between ${band.pool} ids ${band.startPoolId} and ${band.endPoolId}. ` +
      `This is the shape a spreadsheet makes when a row is inserted: it happened to 1,064 of 5,968 labor rows ` +
      `between v1 and v2, and nobody noticed for a whole version because an id pointing at the wrong item still resolves. ` +
      `Say why these ids moved.`,
  };
}

function groupRequirement(item: SystematicGroupFacts): AckRequirement {
  const under = item.parentPoolId === undefined ? "" : ` under parent ${item.parentPoolId}`;
  const examples = item.exampleDescriptions.length
    ? ` For example: ${list(item.exampleDescriptions, 3)}.`
    : "";
  return {
    key: `group:${item.id}`,
    scope: "group",
    flag: "large_change",
    coveredRowCount: item.rowCount,
    requiresTypedReason: false,
    text:
      `${int(item.rowCount)} rows${under} all moved ${item.field} by exactly ${item.ratio}x. ` +
      `That is one policy, not ${int(item.rowCount)} judgements.${examples}`,
  };
}

/**
 * Every acknowledgement this diff and this benchmark demand.
 *
 * Grouping is the difference between a gate and a click-through. One shift
 * band of 1,064 rows is ONE decision with the evidence in front of you, and a
 * systematic re-rate of 43 lines under one phase family is another; 400
 * checkboxes is how you teach somebody to click without reading. Shapes of
 * error stay per row, because those are the ones where re-reading is the point.
 *
 * `beyondCap` is how many retirements the caller counted past
 * {@link DEACTIVATED_WITH_LIVE_LINES_CAP} and did not hand over. The list is
 * capped again here rather than trusted, so a caller that reads all 400 gets 50
 * questions and one that says "and 350 more", not 400 questions inside a
 * transaction that is supposed to be one write.
 *
 * `diff` IS OPTIONAL, AND THE BENCHMARK REQUIREMENT IS OUTSIDE IT. G7 blocks on
 * an unread benchmark whether or not a comparison exists, so when this function
 * refused to produce anything without a diff, a failed comparison plus an unread
 * benchmark blocked publish with an EMPTY outstanding list — the screen telling
 * somebody to sign something it would not show them, which is the same defect
 * {@link named} was written to close. Retirements are outside it for the same
 * reason: they are gathered live from the draft, not read off the comparison.
 */
export function requiredAcknowledgements(
  diff: DiffFacts | undefined,
  benchmark: BenchmarkFacts | undefined,
  deactivatedWithLiveLines: readonly DeactivatedWithLiveLines[],
  beyondCap = 0
): readonly AckRequirement[] {
  const out: AckRequirement[] = [];

  if (diff) {
    // Worst first, so the review screen reads in the order a person should worry.
    for (const flag of PER_ROW_ACK_FLAGS) {
      const rows = diff.flagCounts[flag];
      if (rows > 0) {
        out.push({
          key: `flag:${flag}`,
          scope: "row",
          flag,
          coveredRowCount: rows,
          requiresTypedReason: true,
          text: PER_ROW_ACK_TEXT[flag](rows),
        });
      }
    }

    for (const band of diff.shiftBands) out.push(bandRequirement(band));
  }

  const listedRetirements = deactivatedWithLiveLines.slice(0, DEACTIVATED_WITH_LIVE_LINES_CAP);
  const unlistedRetirements =
    beyondCap + (deactivatedWithLiveLines.length - listedRetirements.length);
  for (const item of listedRetirements) {
    out.push({
      // Keyed by pool AND id. Labor and equipment number their rows
      // independently, so `retire:42` alone would be two different items
      // sharing one signature.
      key: `retire:${item.pool}:${item.poolId}`,
      scope: "row",
      pool: item.pool,
      poolId: item.poolId,
      coveredRowCount: 1,
      requiresTypedReason: true,
      text:
        `Retiring "${item.description}" (${item.pool} id ${item.poolId}) leaves ${int(item.lines)} live ` +
        `activity ${item.lines === 1 ? "line" : "lines"} pointing at an item this book no longer offers. ` +
        `Nothing reprices, but every one of them breaks the next time somebody re-picks it.`,
    });
  }

  if (unlistedRetirements > 0) {
    out.push({
      key: "retire:beyond_cap",
      scope: "run",
      coveredRowCount: unlistedRetirements,
      requiresTypedReason: true,
      text:
        `${int(listedRetirements.length)} retired rows with live activity lines are listed one at a time above, ` +
        `and ${int(unlistedRetirements)} more are not. Publishing does not reprice any of them; every one breaks ` +
        `the next time somebody re-picks it. At this size the question is no longer "is this item right" but ` +
        `"is this retirement right" — say what is being retired and why.`,
    });
  }

  if (diff) {
    // ── Pool-scoped facts: one policy each, not N judgements ──
    const reparented = diff.flagCounts.reparented;
    if (reparented > 0) {
      out.push({
        key: "flag:reparented",
        scope: "pool",
        flag: "reparented",
        coveredRowCount: reparented,
        requiresTypedReason: true,
        text:
          `${int(reparented)} ${reparented === 1 ? "row" : "rows"} moved to a different parent. Reparenting changes ` +
          `what a row MEANS while keeping its id, which is the one edit that makes an id and its meaning disagree ` +
          `by construction. Say which reorganisation this is.`,
      });
    }

    for (const pool of diff.pools) {
      if (diff.bulkEditPools.includes(pool.pool)) {
        out.push({
          key: `pool:${pool.pool}:bulk_edit`,
          scope: "pool",
          pool: pool.pool,
          coveredRowCount: pool.editedCount,
          requiresTypedReason: true,
          text:
            `${int(pool.editedCount)} of ${int(pool.parentRowCount)} ${pool.pool} rows changed — ` +
            `${sharePct(pool.editedCount, pool.parentRowCount)} of the pool. ` +
            // The same quantity this requirement divides, over the same
            // denominator: edits over the PARENT row count. Quoting the
            // shift-band figure here instead (1,064 of 5,968, 17.8%) put a third
            // percentage for one event on the screen, which teaches a reader that
            // the numbers on it are approximate.
            `The only real version bump this catalog has ever had edited 1,199 of 5,897 labor rows — 20.3% — ` +
            `and every one of those edits was an accident nobody noticed. Confirm this one is deliberate.`,
        });
      }
      // `massChangePools` membership is `max(added, deactivated, reactivated)`, so
      // a pool that retired 400 rows and added none is in it. Each of the three
      // therefore has to be read on its own before this file names one: asking for
      // a typed reason under "0 rows were added — 0.0% of the pool" is how a gate
      // teaches its reader that its sentences are generated rather than meant, and
      // asking for nothing at all is worse — a pool that cleared the threshold
      // with 400 reactivations produced no requirement whatsoever until the
      // branch below existed.
      const addedShare = pool.parentRowCount > 0 ? pool.addedCount / pool.parentRowCount : 0;
      if (
        diff.massChangePools.includes(pool.pool) &&
        pool.addedCount > 0 &&
        addedShare >= diff.thresholds.massChangeFraction
      ) {
        out.push({
          key: `pool:${pool.pool}:mass_addition`,
          scope: "pool",
          pool: pool.pool,
          coveredRowCount: pool.addedCount,
          requiresTypedReason: true,
          text:
            `${int(pool.addedCount)} ${pool.addedCount === 1 ? "row was" : "rows were"} added to ${pool.pool} — ` +
            `${sharePct(pool.addedCount, pool.parentRowCount)} of the pool. ` +
            `The only measured real addition was 71 rows, 1.2%. Deleting the id column in Excel turns every ` +
            `row in the file into an addition, and that failure sits at 100%.`,
        });
      }
      const retiredShare =
        pool.parentRowCount > 0 ? pool.deactivatedCount / pool.parentRowCount : 0;
      if (pool.deactivatedCount > 0 && retiredShare >= diff.thresholds.massChangeFraction) {
        out.push({
          key: `pool:${pool.pool}:mass_deactivation`,
          scope: "pool",
          pool: pool.pool,
          coveredRowCount: pool.deactivatedCount,
          requiresTypedReason: true,
          text:
            `${int(pool.deactivatedCount)} ${pool.pool} ${pool.deactivatedCount === 1 ? "row was" : "rows were"} ` +
            `retired — ${sharePct(pool.deactivatedCount, pool.parentRowCount)} of the pool. ` +
            `Retiring moves no money on any finished estimate and breaks every one of them at the next re-pick.`,
        });
      }
      const returnedShare =
        pool.parentRowCount > 0 ? pool.reactivatedCount / pool.parentRowCount : 0;
      if (pool.reactivatedCount > 0 && returnedShare >= diff.thresholds.massChangeFraction) {
        out.push({
          key: `pool:${pool.pool}:mass_reactivation`,
          scope: "pool",
          pool: pool.pool,
          coveredRowCount: pool.reactivatedCount,
          requiresTypedReason: true,
          text:
            `${int(pool.reactivatedCount)} ${pool.pool} ${pool.reactivatedCount === 1 ? "row was" : "rows were"} ` +
            `brought back — ${sharePct(pool.reactivatedCount, pool.parentRowCount)} of the pool. ` +
            `A returning row reappears in every picker and every phase list the moment this book is the one being ` +
            `read, so this is as large an event as the same number leaving, arriving in the direction nobody watches.`,
        });
      }
    }

    const bulkPhases = diff.takeoffFlagBulkPhases.length;
    if (bulkPhases > 0) {
      // Led by the phases, not by the row count, because the two come from
      // different passes and only the phases are always right: the scan counts
      // every newly flagged draft row, while `flagCounts` counts rows carrying a
      // `countsTowardTakeoff` FIELD CHANGE, and an added row has no field
      // changes at all. A file that adds ten flagged lines under one phase
      // therefore reaches this requirement with a row count of zero, and
      // "0 labor rows were newly flagged, across 1 phases" is a sentence that
      // discredits the gate printing it.
      const rows = diff.flagCounts.takeoff_flags_bulk;
      out.push({
        key: "pool:labor:takeoff_flags_bulk",
        scope: "pool",
        pool: "labor",
        flag: "takeoff_flags_bulk",
        coveredRowCount: rows,
        requiresTypedReason: true,
        text:
          `Labor rows were newly flagged as counting toward takeoff in ${int(bulkPhases)} ` +
          `${bulkPhases === 1 ? "phase" : "phases"}, more than three in each ` +
          `(${bulkPhases === 1 ? "phase" : "phases"} ${list(diff.takeoffFlagBulkPhases, 5)})` +
          (rows > 0 ? `, ${int(rows)} of them by an edit to an existing row` : "") +
          `. The maintenance workbook names one to three exact lines per phase, so more than that means the flag ` +
          `was applied by pattern — which is legacy's description matching, 2x on concrete and up to 28x on ` +
          `foundation phases, arriving through a new door. ` +
          `These are read LIVE by every estimate on this book, including finished ones.`,
      });
    }

    // ── Sizes of change: groupable, and no reason typed ──
    const grouped = diff.systematicGroups.reduce((sum, item) => sum + item.rowCount, 0);
    for (const item of diff.systematicGroups) out.push(groupRequirement(item));

    const ungrouped = Math.max(0, diff.flagCounts.large_change - grouped);
    if (ungrouped > 0) {
      out.push({
        key: "flag:large_change",
        scope: "row",
        flag: "large_change",
        coveredRowCount: ungrouped,
        requiresTypedReason: false,
        text:
          `${int(ungrouped)} ${ungrouped === 1 ? "value" : "values"} moved by ` +
          `${diff.thresholds.largeChangeRatio}x or more without belonging to any group that moved together. ` +
          `${diff.thresholds.largeChangeRatio}x is a CONVENTION, not a measurement: it is set at a doubling ` +
          `because that is where somebody should have to say out loud that they meant it.`,
      });
    }

    const activated = diff.flagCounts.constant_activated;
    if (activated > 0) {
      out.push({
        key: "flag:constant_activated",
        scope: "run",
        flag: "constant_activated",
        coveredRowCount: activated,
        requiresTypedReason: false,
        text:
          `${int(activated)} ${activated === 1 ? "constant went" : "constants went"} from 0 to a real number. ` +
          `One signature covers all of them, because hours appearing is visible in the benchmark, while hours ` +
          `disappearing is not — which is why the opposite change is confirmed one row at a time.`,
      });
    }
  }

  if (benchmark) {
    out.push({
      key: BENCHMARK_ACK_KEY,
      scope: "run",
      coveredRowCount: benchmark.proposalsCompared,
      requiresTypedReason: false,
      text: benchmarkAcknowledgementText(benchmark, diff),
    });
  }

  return out;
}

/**
 * What the admin is agreeing they have read, generated from the run's own
 * numbers so it cannot decay into muscle memory.
 *
 * Three different worlds, and the difference between them is the point. A
 * confident, correct, meaningless `$0.00` is the most dangerous thing this
 * screen could print, so the run that measured nothing says exactly that
 * instead of a number.
 */
export function benchmarkAcknowledgementText(
  benchmark: BenchmarkFacts,
  diff: DiffFacts | undefined
): string {
  // ROWS, not field changes. `effectCounts` folds a row's changes through a Set
  // before counting, exactly as `flagCounts` does, so a row that moved both its
  // takeoff unit and its takeoff flag is one. Calling them changes here would
  // print a number smaller than the thing it names.
  const liveReads = diff?.effectCounts.read_live ?? 0;
  const liveSentence =
    liveReads > 0
      ? ` Separately, ${int(liveReads)} ${liveReads === 1 ? "row" : "rows"} in this draft changed something read ` +
        `LIVE by estimates that are already finished — takeoff units, takeoff flags, reserved phase numbers, ` +
        `active flags — and no dollar figure here covers those.`
      : "";

  if (benchmark.measuredNothing) {
    const equipmentRates = diff?.changedEquipmentPoolIds.length ?? 0;
    const laborRates = diff?.changedLaborPoolIds.length ?? 0;
    return (
      `This draft changes ${int(equipmentRates)} equipment rates and ${int(laborRates)} labor constants. ` +
      `This benchmark cannot price equipment — only ${int(benchmark.equipment.linesCorroborated)} of ` +
      `${int(benchmark.equipment.linesTotal)} equipment lines have a catalog link their own description ` +
      `corroborates, and which of the four rate tiers a line was priced from is not stored anywhere. ` +
      `IT HAS TOLD YOU NOTHING ABOUT THIS DRAFT. This is not a zero; it is no answer.${liveSentence}`
    );
  }

  if (benchmark.proposalsCompared === 0) {
    return (
      `No estimate is pinned to "${benchmark.parentBookName}", so nothing could be repriced. ` +
      `What follows is a catalog delta profile, explicitly not a money figure.${liveSentence}`
    );
  }

  // BOTH the sum and the list are walked, over the same object, in one
  // expression each. A hand-written list cannot be kept honest: this sentence
  // introduces the sum as the money the headline does not cover, and the last
  // time the two were maintained separately a bucket reached the sum and never
  // reached the prose — $4,000,000 of a stated $5,000,000, with a reader who
  // added up the named categories arriving $4M short.
  const carried = benchmark.carriedDollars;
  const buckets = Object.keys(CARRIED_BUCKET_PHRASES) as readonly CarriedBucket[];
  const excluded = buckets.reduce((sum, bucket) => sum + carried[bucket], 0);
  // Each bucket carries its own figure, including the zeroes: the sum is over
  // all eight, so a reader must be able to check it against all eight.
  const named = buckets
    .map((bucket) => `${money(carried[bucket])} of ${CARRIED_BUCKET_PHRASES[bucket]}`)
    .join(", ");

  return (
    `Priced against ${int(benchmark.proposalsCompared)} estimates already built on "${benchmark.parentBookName}", ` +
    `these constants move labor cost by ${money(benchmark.cost.delta)} — ` +
    `${signedPct(benchmark.deltaPctOfRepricedLabor)} of the labor this run could reprice, ` +
    `${signedPct(benchmark.deltaPctOfGrandTotal)} of the grand total. ` +
    `${int(benchmark.estimatesUnmoved)} of those estimates do not move at all. ` +
    `The figure does not cover ${money(excluded)}: ${named}. ` +
    `${int(benchmark.coverage.exercisedLaborPoolIds)} of ${int(benchmark.coverage.changedLaborPoolIds)} changed ` +
    `labor items are used by any estimate at all. ` +
    `Nothing here happens to a finished estimate: this is what they WOULD have cost.${liveSentence}`
  );
}

/**
 * Whether a field that is supposed to hold a person actually holds one.
 *
 * Absent, empty and whitespace are ONE state — nobody — and the four places
 * that ask this question have to give the same answer. Where the gate and the
 * outstanding list disagree about a blank name, publish is blocked by a gate
 * whose remedy is missing from the list of things left to sign: a screen
 * telling somebody to fix something it will not show them.
 */
function named(value: string | undefined): boolean {
  return (value ?? "").trim() !== "";
}

/**
 * Whether a signature still covers what it was made about.
 *
 * TWO ways it stops counting, and both are the same idea. An acknowledgement
 * is a statement about specific numbers at a specific moment, not a permanent
 * property of the draft: a signature recorded over 47 rows does not launder
 * the 4 that arrived afterwards, and one made before an import landed says
 * nothing about the catalog that import produced.
 */
export function acknowledgementSatisfied(
  requirement: AckRequirement,
  acks: readonly Acknowledgement[],
  contentRevision: number
): boolean {
  return acks.some(
    (ack) =>
      ack.key === requirement.key &&
      ack.atContentRevision === contentRevision &&
      ack.coveredRowCount >= requirement.coveredRowCount &&
      named(ack.by) &&
      (!requirement.requiresTypedReason || (ack.reason ?? "").trim() !== "")
  );
}

// ── Gates ───────────────────────────────────────────────────────────────────

const pass = (id: GateId, name: string): GateResult => ({ id, name, verdict: "pass" });

const block = (
  id: GateId,
  name: string,
  message: string,
  detail?: GateResult["detail"]
): GateResult => ({ id, name, verdict: "block", message, ...(detail ? { detail } : {}) });

const NOT_COMPARED =
  "Nothing has been compared yet, so this has not been checked. Run the comparison.";

/** G0 — a half-built or busy book publishes a half-built state. */
function gateG0(facts: PublishFacts): GateResult {
  const name = "Built and unlocked";
  if (facts.book.buildState === "building") {
    return block("G0", name, "This draft is still being built. Wait for it to finish.");
  }
  if (facts.book.buildState === "failed") {
    // Deliberately NOT the original "wait for it to finish": a failed clone is
    // never going to finish, and `cloneBatch` commits the rows it inserted
    // before it threw, so this draft is a partial copy that will never
    // complete on its own.
    return block(
      "G0",
      name,
      "This draft's build failed part-way, so it is not a complete copy of its parent. " +
        "Retry the build, or discard the draft and start again."
    );
  }
  if (facts.book.lockOp) {
    return block(
      "G0",
      name,
      `"${facts.book.name}" is busy (${facts.book.lockOp}). Wait for that to finish.`,
      {
        lockOp: facts.book.lockOp,
      }
    );
  }
  return pass("G0", name);
}

/**
 * G1 — the draft is a faithful copy of its parent.
 *
 * `buildState: "ready"` only means the last scheduled `cloneBatch` ran.
 * `cloneBatch` wraps its body in try/catch, so a throw part-way through the
 * insert loop COMMITS the inserts that preceded it together with the catch
 * block's `buildState: "failed"` patch — while `buildCursor` was never
 * patched, because that line sits after the loop. `retryDraftBuild` then reads
 * the previous batch's cursor and replays the same poolId range, duplicating
 * up to 500 rows, and Convex has no unique constraint to stop it.
 *
 * Everything else in this design — the diff's pairing, the benchmark's parent
 * lookup, revert's targeting — assumes `(book, poolId)` names one row. This is
 * the gate that proves it rather than inheriting it. And a duplicate is not
 * cosmetic: `loadTakeoffCatalog` resolves a catalog phase with `.unique()`, so
 * the phase list would stop loading for every estimate on this book.
 */
function gateG1(facts: PublishFacts, diff: DiffFacts | undefined): GateResult {
  const name = "A faithful copy of its parent";
  if (!diff) return block("G1", name, NOT_COMPARED);

  for (const pool of diff.pools) {
    if (pool.duplicatePoolIds.length > 0) {
      return block(
        "G1",
        name,
        `${pool.pool} holds the same id twice: ${list(pool.duplicatePoolIds, 5)}. ` +
          `A retried build replays the range it already inserted, and nothing in Convex refuses the second copy. ` +
          `The phase list stops loading for every estimate on a book with a duplicate. Discard this draft and clone again.`,
        { pool: pool.pool, duplicates: pool.duplicatePoolIds.length }
      );
    }
  }

  for (const pool of diff.pools) {
    if (pool.missingFromDraft.length > 0) {
      // One is a failure. Nothing in this subsystem deletes a cloned row:
      // `revertImportBatch` deletes only rows an import added, and
      // `discardBatch` removes the whole book. A percentage would be the wrong
      // shape of question.
      return block(
        "G1",
        name,
        `${int(pool.missingFromDraft.length)} ${pool.pool} ${pool.missingFromDraft.length === 1 ? "row is" : "rows are"} ` +
          `in "${facts.book.parentBookName}" and not in this draft (${list(pool.missingFromDraft, 5)}). ` +
          `Nothing in this system deletes a cloned row, so this draft did not finish copying. Clone it again.`,
        { pool: pool.pool, missing: pool.missingFromDraft.length }
      );
    }
  }

  const recorded = facts.book.recordedRowCounts;
  if (recorded) {
    for (const pool of diff.pools) {
      const expected = recorded[pool.pool];
      if (expected !== pool.draftRowCount) {
        return block(
          "G1",
          name,
          `This book says it holds ${int(expected)} ${pool.pool} rows; ${int(pool.draftRowCount)} were counted. ` +
            `The count on the book is what every list and every coverage figure is drawn from, so one of the two ` +
            `is lying to somebody. Clone this draft again.`,
          { pool: pool.pool, recorded: expected, counted: pool.draftRowCount }
        );
      }
    }
  }

  return pass("G1", name);
}

/**
 * G2 — every reference inside the draft resolves.
 *
 * `shapeRow` parses `phase_code` but never checks the phase exists, `matchRow`
 * cannot match against a nonexistent parent so the row becomes an addition,
 * and `insertPoolRow` writes it at a dangling `phasePoolId`. The row then
 * exists, counts toward `rowCounts`, and is invisible everywhere — every
 * picker and `loadTakeoffCatalog` query `by_book_phase_active` under phases
 * that DO exist. An orphan is not a wrong number, which is why nothing else
 * catches it; it is work that silently disappeared from the catalog, and a
 * permanent book is the wrong place to discover that.
 */
function gateG2(diff: DiffFacts | undefined): GateResult {
  const name = "Every reference inside the draft resolves";
  if (!diff) return block("G2", name, NOT_COMPARED);

  for (const pool of diff.pools) {
    if (pool.danglingParentRefs.length > 0) {
      const first = pool.danglingParentRefs[0];
      return block(
        "G2",
        name,
        `${int(pool.danglingParentRefs.length)} ${pool.pool} ${pool.danglingParentRefs.length === 1 ? "row sits" : "rows sit"} ` +
          `under a parent this draft does not contain` +
          (first ? ` — id ${first.poolId} points at ${first.parentPoolId}` : "") +
          `. Those rows count toward the book's totals and appear in no picker, no phase list and no export. ` +
          `Fix the parent, or retire the rows, before this becomes permanent.`,
        { pool: pool.pool, dangling: pool.danglingParentRefs.length }
      );
    }
  }
  return pass("G2", name);
}

/**
 * G3 — natural keys are unique.
 *
 * The matcher's founding premise is that a description plus its parent
 * identifies exactly one item: `normalizeKey` produces ZERO collisions across
 * all 5,897 v1 and 5,968 v2 labor rows and both equipment files. That is a
 * property of the data, not of the code, and a bulk edit or a name-trusted
 * import can break it. Publish is the last moment fixing it is free.
 */
function gateG3(diff: DiffFacts | undefined): GateResult {
  const name = "Natural keys are unique";
  if (!diff) return block("G3", name, NOT_COMPARED);

  for (const pool of diff.pools) {
    if (pool.keyCollisions.length > 0) {
      return block(
        "G3",
        name,
        `${int(pool.keyCollisions.length)} ${pool.pool} ${pool.keyCollisions.length === 1 ? "name is" : "names are"} ` +
          `now shared by more than one item: ${list(pool.keyCollisions, 3)}. ` +
          `Every future import matches on that name, so from here on the importer cannot tell those items apart. ` +
          `Rename one of each pair.`,
        { pool: pool.pool, collisions: pool.keyCollisions.length }
      );
    }
  }
  return pass("G3", name);
}

/** G4 — typed confirmation and release notes. */
function gateG4(facts: PublishFacts): GateResult {
  const name = "Typed confirmation and release notes";
  if (facts.book.typedName.trim() !== facts.book.confirmName) {
    return block("G4", name, "The typed name does not match this rate book.");
  }
  if (!facts.book.typedNotes.trim()) {
    return block("G4", name, "Say what changed in this rate book before publishing it.");
  }
  return pass("G4", name);
}

/** G5 — a current, untorn, reviewed comparison exists over a non-empty change set. */
function gateG5(facts: PublishFacts): GateResult {
  const name = "A current, untorn, reviewed comparison";
  const record = facts.diff;
  if (!record) {
    return block(
      "G5",
      name,
      `Nothing has compared this draft to "${facts.book.parentBookName}". Run the comparison and read it.`
    );
  }
  if (record.state === "running") {
    return block(
      "G5",
      name,
      "The comparison is still running. A half-finished diff is not a finished one."
    );
  }
  if (record.state === "failed") {
    return block(
      "G5",
      name,
      "The comparison failed. Run it again — publishing on a diff that never completed is publishing blind."
    );
  }

  if (record.startedAtContentRevision !== record.finishedAtContentRevision) {
    // A single end-of-run stamp cannot see this: the diff reads wbs and phases
    // before an import lands and labor after, and the result describes a
    // catalog that never existed at any single moment.
    return block(
      "G5",
      name,
      `The draft changed while that comparison was running — it started at revision ` +
        `${record.startedAtContentRevision} and finished at ${record.finishedAtContentRevision}, ` +
        `so it describes a catalog that never existed at any one moment. Run it again.`,
      { startedAt: record.startedAtContentRevision, finishedAt: record.finishedAtContentRevision }
    );
  }

  if (record.finishedAtContentRevision !== facts.book.contentRevision) {
    const drift = facts.book.contentRevision - record.finishedAtContentRevision;
    return block(
      "G5",
      name,
      `You read a comparison of revision ${record.finishedAtContentRevision}. This draft is now at revision ` +
        `${facts.book.contentRevision} — it has been written to ${int(Math.abs(drift))} ` +
        `${Math.abs(drift) === 1 ? "time" : "times"} since you looked. Run the comparison again.`,
      {
        reviewedRevision: record.finishedAtContentRevision,
        currentRevision: facts.book.contentRevision,
      }
    );
  }

  if (
    !named(record.reviewedBy) ||
    record.reviewedAtContentRevision !== facts.book.contentRevision
  ) {
    return block(
      "G5",
      name,
      "Nobody has marked this comparison as read at its current revision. Open it, read it, then publish."
    );
  }

  if (record.summary.changedRowCount === 0) {
    return block(
      "G5",
      name,
      `This draft is identical to "${facts.book.parentBookName}". Publishing it would spend a book number on a ` +
        `book that changed nothing. If you only want new estimates to point somewhere else, set the default instead.`,
      { changedRows: 0 }
    );
  }

  return pass("G5", name);
}

/**
 * G6 — the judgement calls have a name against them.
 *
 * 1,064 rows changed meaning on the one real version bump and nobody ever had
 * to click anything. This makes the small set of changes that look like
 * accidents impossible to sleepwalk past, while grouping keeps an honest bulk
 * re-rate from becoming 400 checkboxes.
 *
 * IT TAKES THE DIFF ONLY TO REFUSE TO SPEAK WITHOUT ONE. Every judgement call
 * this gate counts is derived from the comparison, so with no comparison the
 * outstanding list is empty and an unqualified `pass` here reads as "somebody
 * looked at these and was content" about a draft nobody has looked at. G1, G2
 * and G3 all say NOT_COMPARED in that state; this was the one that went quiet.
 */
function gateG6(outstanding: readonly AckRequirement[], diff: DiffFacts | undefined): GateResult {
  const name = "The judgement calls have a name against them";
  if (!diff) return block("G6", name, NOT_COMPARED);
  // The benchmark's own signature is G7's, which reports it with the numbers
  // that earned it.
  const mine = outstanding.filter((item) => item.key !== BENCHMARK_ACK_KEY);
  if (mine.length === 0) return pass("G6", name);

  // Decisions are counted; the rows they cover are NOT summed. The requirements
  // overlap by construction — a pool-scoped bulk edit covering 1,064 rows
  // contains the 3 rows a zeroed-constant requirement asks about — so a total
  // would have read "1,067 rows" of a pool that only moved 1,064.
  const first = mine[0];
  return block(
    "G6",
    name,
    `${int(mine.length)} ${mine.length === 1 ? "decision has" : "decisions have"} nobody's name against ` +
      `${mine.length === 1 ? "it" : "them"}. ` +
      (first ? `Starting with: ${first.text}` : ""),
    { outstanding: mine.length }
  );
}

/**
 * G7 — a benchmark exists, is current, its self-check passed, and it was read.
 *
 * BLOCKING ON THE SELF-CHECK SPECIFICALLY, NEVER ON THE SIZE OF THE RESULT.
 * There is no correct answer to "how much may a rate book move a bid" — that
 * is a business call, and encoding a threshold would be the software inventing
 * an authority it does not have. But if the harness's baseline does not
 * reproduce the number the app itself records for an estimate, then every
 * figure the run prints is measuring something else while looking
 * authoritative.
 *
 * `diff` is the READY comparison or nothing — never `facts.diff.summary`
 * directly. The sentence below is the same one `requiredAcknowledgements`
 * composes for the outstanding list, and that one is built from the ready diff;
 * reading the raw record here would let a failed comparison's numbers appear in
 * one rendering of it and not the other.
 */
function gateG7(facts: PublishFacts, diff: DiffFacts | undefined): GateResult {
  const name = "A current benchmark that checked itself";
  const record = facts.benchmark;
  if (!record) {
    return block(
      "G7",
      name,
      `No benchmark has been run. The closest available preview of what next month's estimates will do is what ` +
        `the estimates on "${facts.book.parentBookName}" would have cost under this book. Run it.`
    );
  }
  if (record.state === "running") {
    return block(
      "G7",
      name,
      "The benchmark is still running. A run that has read 600 of 713 estimates is not a result."
    );
  }
  if (record.state === "failed") {
    return block(
      "G7",
      name,
      "The benchmark failed. Run it again — a failed run and a slow one must never look the same."
    );
  }
  if (record.basedOnContentRevision !== facts.book.contentRevision) {
    return block(
      "G7",
      name,
      `That benchmark priced revision ${record.basedOnContentRevision} of this draft; the draft is now at ` +
        `revision ${facts.book.contentRevision}. Run it again.`,
      {
        benchmarkRevision: record.basedOnContentRevision,
        currentRevision: facts.book.contentRevision,
      }
    );
  }

  const failures = record.report.selfCheckFailures;
  const firstFailure = failures[0];
  if (firstFailure) {
    return block(
      "G7",
      name,
      `The benchmark could not reproduce ${int(failures.length)} ${failures.length === 1 ? "estimate's" : "estimates'"} ` +
        `own recorded total — ${firstFailure.proposalNumber} is stored at ` +
        `${firstFailure.cached === undefined ? "no cached total" : money(firstFailure.cached)} and computed as ` +
        `${money(firstFailure.computed)}. The harness is not reading these estimates the way the app does, so ` +
        `every number it printed is about something else. Do not publish on it.`,
      { failures: failures.length, proposal: firstFailure.proposalNumber }
    );
  }

  if (
    !named(record.acknowledgedBy) ||
    record.acknowledgedAtContentRevision !== facts.book.contentRevision
  ) {
    return block(
      "G7",
      name,
      `Nobody has said they read this benchmark at its current revision. ` +
        benchmarkAcknowledgementText(record.report, diff)
    );
  }

  return pass("G7", name);
}

/**
 * G8 — nothing is riding on the default.
 *
 * NOT HYPOTHETICAL. `crons.ts` runs `proposals-sync` every 6 hours, and
 * `sync/syncMutations.ts` `upsertProposalsBatch` inserts proposals straight
 * from the payload with no `bookId`; only the full-tree path sets one. So
 * unpinned estimates appear on their own, every six hours.
 * `bookIdForProposal` resolves them through `defaultBookId`, `publishBook`
 * flips `isDefault`, and `phasePool.takeoffUnit` and
 * `laborPool.countsTowardTakeoff` are read live on every phase-list render and
 * inside the export. That is precisely the failure `rateBookAccess.ts`
 * declares impossible, arriving through the one door that guard does not
 * cover, with no write to those estimates and no trace anywhere.
 *
 * The message says whose bug it is, because otherwise this gate reads as the
 * rate book system being obstructive when it is reporting someone else's.
 *
 * IT NAMES NO NUMBER, because {@link PublishFacts.unpinnedProposals} does not
 * hold one. The documented read is `.take(1)`, so the honest rendering of it is
 * a subject and not a count — printing `int(...)` of that boolean told an admin
 * with four thousand unpinned estimates that there was "1 estimates".
 */
function gateG8(facts: PublishFacts): GateResult {
  const name = "Nothing is riding on the default";
  const subjects: string[] = [];
  if (facts.unpinnedProposals) subjects.push("Estimates");
  if (facts.unpinnedProjects) subjects.push("Momentum projects");
  const subject = subjects.join(" and ");
  if (subject === "") return pass("G8", name);

  return block(
    "G8",
    name,
    `${subject} are pinned to no rate book, so they resolve through whichever book is the default — ` +
      `and publishing changes the default. ` +
      `Their phase list and their export read takeoff units and takeoff flags live from that book, so publishing ` +
      `would change what those estimates display with no write to any of them and no trace anywhere. ` +
      `This is not the rate book's bug: the 6-hourly proposals sync inserts proposals without a bookId, and only ` +
      `the full-tree path sets one. Pin them to a book, then publish.`,
    { unpinnedProposals: facts.unpinnedProposals, unpinnedProjects: facts.unpinnedProjects }
  );
}

/**
 * G9 — no import is unfinished or unread.
 *
 * STRONGER THAN THE LOCK, and it has to be. `applyImport` patches the import
 * to `"applying"` and schedules `applyImportBatch`, but never takes
 * `book.lock`. So `requireDraftBook` sees no lock, G0 passes, `publishBook`
 * flips the status, and the next `applyImportBatch` calls `writePoolRow`,
 * which throws "This rate book is no longer a draft" and marks the import
 * failed — leaving a permanently frozen, half-applied book. Worse,
 * `insertPoolRow` is a raw `ctx.db.insert` with no draft check, so rows
 * already written stay inside the now-frozen book while the rest never arrive.
 * A half-applied file inside a permanent book is unfixable by construction.
 */
function gateG9(facts: PublishFacts): GateResult {
  const name = "No import is unfinished or unread";
  const open = facts.openImports.filter((i) => OPEN_IMPORT_STATES.has(i.state));
  if (open.length === 0) return pass("G9", name);

  const writing = open.find((i) => i.state === "applying" || i.state === "reverting");
  if (writing) {
    return block(
      "G9",
      name,
      `"${writing.fileName}" is still being written into this draft (${writing.state}). Publishing now freezes the ` +
        `book mid-file: the rows already written stay, the rest are refused, and a half-applied file inside a ` +
        `permanent book cannot be fixed. Wait for it to finish.`,
      { fileName: writing.fileName, state: writing.state }
    );
  }

  const failed = open.find((i) => i.state === "failed");
  if (failed) {
    return block(
      "G9",
      name,
      `"${failed.fileName}" failed part-way and it is not known what it did and did not write. ` +
        `Revert it or resolve it before freezing this book.`,
      { fileName: failed.fileName, state: failed.state }
    );
  }

  const waiting = open.find((i) => i.state === "review");
  if (waiting) {
    return block(
      "G9",
      name,
      `"${waiting.fileName}" is staged against ${waiting.pool} and still waiting for a decision about whether to ` +
        `trust the file's id column. Nothing from that file is in this book. Publishing makes that decision ` +
        `impossible forever — apply it, or discard it.`,
      { fileName: waiting.fileName, state: waiting.state }
    );
  }

  const first = open[0];
  return block(
    "G9",
    name,
    `"${first?.fileName ?? "An import"}" is still being read (${first?.state ?? "staging"}). ` +
      `Wait for it, then decide what to do with it.`,
    { fileName: first?.fileName ?? "", state: first?.state ?? "" }
  );
}

/**
 * G10 — the screen you clicked from is the draft that exists.
 *
 * Two clicks are already safe for the status flip — Convex mutations are
 * serializable and `requireDraftBook` refuses the second — but that refusal
 * currently reads as a failure when it was in fact a success, which teaches
 * people to distrust the button. Naming the revision turns both cases into a
 * sentence.
 */
function gateG10(facts: PublishFacts): GateResult {
  const name = "The screen you clicked from is the draft that exists";
  if (facts.book.status === "published") {
    return block(
      "G10",
      name,
      `"${facts.book.name}" was already published as book ${facts.book.bookNumber}. Nothing went wrong — ` +
        `the publish had already gone through.`,
      { bookNumber: facts.book.bookNumber }
    );
  }
  if (facts.book.status === "archived") {
    return block("G10", name, `"${facts.book.name}" has been archived and cannot be published.`);
  }
  if (facts.book.expectedContentRevision === undefined) {
    return block(
      "G10",
      name,
      "This publish screen did not say which revision of the draft it was showing. Reload it and try again."
    );
  }
  if (facts.book.expectedContentRevision !== facts.book.contentRevision) {
    return block(
      "G10",
      name,
      `This draft changed while the publish screen was open — you were looking at revision ` +
        `${facts.book.expectedContentRevision} and it is now at ${facts.book.contentRevision}. ` +
        `Reload, read the comparison again, then publish.`,
      { expected: facts.book.expectedContentRevision, actual: facts.book.contentRevision }
    );
  }
  return pass("G10", name);
}

/**
 * Every gate, in order, from facts already in memory.
 *
 * Gates are all evaluated rather than short-circuited: an admin who fixes one
 * thing and is shown the next one should be told all of it the first time,
 * because a screen that reveals its objections one at a time is a screen
 * people stop believing has finished objecting.
 */
export function evaluatePublishGates(facts: PublishFacts): PublishReadiness {
  const diff = facts.diff?.state === "ready" ? facts.diff.summary : undefined;
  const benchmark = facts.benchmark?.state === "ready" ? facts.benchmark.report : undefined;

  // Composed unconditionally: `requiredAcknowledgements` decides for itself what
  // survives a missing comparison, so the outstanding list and the gates cannot
  // disagree about whether a signature is being demanded.
  const requirements = requiredAcknowledgements(
    diff,
    benchmark,
    facts.deactivatedWithLiveLines,
    facts.deactivatedWithLiveLinesBeyondCap
  );

  const benchmarkRead =
    facts.benchmark !== undefined &&
    named(facts.benchmark.acknowledgedBy) &&
    facts.benchmark.acknowledgedAtContentRevision === facts.book.contentRevision;

  const outstanding = requirements.filter((item) =>
    item.key === BENCHMARK_ACK_KEY
      ? !benchmarkRead
      : !acknowledgementSatisfied(item, facts.acknowledgements, facts.book.contentRevision)
  );

  const gates: readonly GateResult[] = [
    gateG0(facts),
    gateG1(facts, diff),
    gateG2(diff),
    gateG3(diff),
    gateG4(facts),
    gateG5(facts),
    gateG6(outstanding, diff),
    gateG7(facts, diff),
    gateG8(facts),
    gateG9(facts),
    gateG10(facts),
  ];

  const blocking = gates.filter((gate) => gate.verdict === "block");
  return {
    canPublish: blocking.length === 0,
    gates,
    blocking,
    outstandingAcknowledgements: outstanding,
  };
}

/**
 * The release notes the book keeps forever.
 *
 * WHEN IT RUNS: `publishBook` calls it once every gate has passed, with
 * `book.typedNotes` as `typed`, and writes the RESULT — not `typedNotes` — into
 * `rateBooks.notes`. That is the whole reason the field on {@link PublishFacts}
 * is not called `notes`: before publish the string is what a person typed, after
 * publish it is that plus what was measured, and one name for both is how a
 * reader ends up believing the book recorded numbers nobody ever composed.
 *
 * WHY THE MEASUREMENT IS WELDED TO THE PROSE. The panel wanted a blocking gate
 * on the size of the movement and did not get one, because no threshold here
 * is anchored to anything measured. What it actually wanted is this: the
 * numbers that were on the screen when somebody decided to publish, written
 * into the book permanently, so the question "what did we know at the time"
 * has an answer that does not depend on anyone remembering.
 */
export function composePublishNotes(
  typed: string,
  diff: DiffFacts,
  benchmark: BenchmarkFacts | undefined
): string {
  const lines: string[] = [];

  const flags = (Object.keys(diff.flagCounts) as DiffFlag[])
    .filter((flag) => diff.flagCounts[flag] > 0)
    .map((flag) => `${int(diff.flagCounts[flag])} ${flag}`);

  lines.push(
    `- Catalog: ${int(diff.changedRowCount)} rows changed, ${int(diff.unchangedRowCount)} unchanged.` +
      (flags.length ? ` Flagged: ${flags.join(", ")}.` : "")
  );

  if (diff.shiftBands.length > 0) {
    const rows = diff.shiftBands.reduce((sum, band) => sum + band.rowCount, 0);
    const offsets = diff.shiftBands.map((band) =>
      band.offset > 0 ? `+${band.offset}` : band.offset
    );
    lines.push(
      `- Payload shifts: ${int(diff.shiftBands.length)} bands, ${int(rows)} rows, at offsets ${offsets.join(", ")}.`
    );
  }

  if (diff.effectCounts.read_live > 0) {
    lines.push(
      `- Read live by finished estimates: ${int(diff.effectCounts.read_live)} rows. These reach estimates that ` +
        `are already published, and no benchmark dollar covers them.`
    );
  }

  if (!benchmark) {
    lines.push("- Benchmark: none was run.");
  } else if (benchmark.measuredNothing) {
    lines.push(
      `- Benchmark against "${benchmark.parentBookName}": it measured nothing about this draft, and that was ` +
        `recorded rather than dressed up as a dollar figure.`
    );
  } else if (benchmark.proposalsCompared === 0) {
    lines.push(
      `- Benchmark against "${benchmark.parentBookName}": no estimate was pinned to it, so this is a catalog ` +
        `delta profile and not a money figure.`
    );
  } else {
    lines.push(
      `- Benchmark against "${benchmark.parentBookName}": ${int(benchmark.proposalsCompared)} estimates, labor cost ` +
        `${money(benchmark.cost.delta)} (${signedPct(benchmark.deltaPctOfRepricedLabor)} of repriced labor, ` +
        `${signedPct(benchmark.deltaPctOfGrandTotal)} of the grand total). ` +
        `${int(benchmark.estimatesUnmoved)} did not move at all.`
    );
    lines.push(
      `- Coverage: ${int(benchmark.coverage.exercisedLaborPoolIds)} of ` +
        `${int(benchmark.coverage.changedLaborPoolIds)} changed labor items are used by any estimate.`
    );
    const caveat = benchmark.caveats[0];
    lines.push(
      `- ${caveat ?? "This benchmark is a counterfactual. Nothing in it happened to a finished estimate."}`
    );
  }

  return `${typed.trim()}\n\nMeasured at publish:\n${lines.join("\n")}`;
}
