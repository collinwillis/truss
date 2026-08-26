import type { PoolKind } from "./rateBookCsv";
import { naturalKey, normalizeKey } from "./rateBookMatch";

/**
 * Comparing a draft rate book against the book it was cloned from.
 *
 * WHAT THIS IS FOR. A draft is a full copy of its parent, so "what changed"
 * is not a question anybody can answer by looking. The one real version bump
 * InDemand ever performed moved 1,064 of 5,968 labor rows onto different ids
 * — three contiguous bands at offsets -4, -455 and +8 — and nobody noticed for
 * a version, because an id pointing at the wrong item still resolves. This
 * module is the machinery that would have said so out loud before anyone
 * published.
 *
 * WHAT IT COMPARES, AND WHY NOT `beforeOf`. The field ROSTER is
 * `Object.keys(beforeOf(pool, row))` plus `retiredInBookId`, and
 * `rateBookDiff.test.ts` asserts that equality, so the diff can never describe
 * a field the import audit cannot. The field VALUES are the raw stored ones,
 * because `beforeOf` writes `takeoffUnit: r.takeoffUnit ?? ""` and
 * `countsTowardTakeoff: r.countsTowardTakeoff ?? false`, and those two
 * coalesces are not equivalent:
 *
 *   - `takeoffUnit` — `loadTakeoffCatalog` tests `!== undefined`. Absent means
 *     "this phase type has no takeoff, show a dash"; `""` puts the phase in the
 *     map claiming a takeoff it does not have, on every estimate. Absent is a
 *     distinct third state and diffs as one.
 *   - `countsTowardTakeoff`, `reservedPhaseNumber` — read truthily. Absent IS
 *     false, and must normalize to false, or every row an import ever touched
 *     reads as changed forever: `shapeRow` always writes a defined boolean
 *     while a cloned untouched row leaves it absent.
 *
 * So absence semantics are declared per field, in {@link DIFF_FIELDS}, with the
 * reason attached to each entry.
 *
 * PURE, and with ZERO Convex imports of any kind — not even `import type`. The
 * caller projects stored documents into {@link DiffRowInput} before handing
 * them over, which is what lets the calibration tests run in plain Node against
 * the two real catalog files in `tests/fixtures/legacy-pools/`. The value
 * imports from `rateBookMatch` are permitted because that module is itself
 * pure, and are the point: the diff must decide that two rows are "the same
 * item" by exactly the rule the matcher uses, or the two subsystems disagree
 * about what an item is.
 *
 * `findKeyCollisions` is deliberately NOT used even though it is available:
 * the differ never holds a whole pool in memory, so collisions are detected
 * streaming, in {@link observeDraftRow}.
 */

/**
 * How a field's change reaches an estimate — the most useful sentence the diff
 * says about any row.
 *
 * `priced_at_creation` covers everything an activity copied onto itself when it
 * was created (constants, units, description, parent) and everything that
 * reaches no finished estimate at all (`sortOrder`). Changing one of those
 * moves no money on any existing bid; it changes what the NEXT estimate costs.
 *
 * `read_live` is the small set queried out of the catalog while an already
 * published estimate is rendered or exported. Those are the only fields whose
 * change is felt by work that is already done, which is why they are counted
 * separately: a draft whose only changes are display changes must not be waved
 * through on a $0.00 benchmark.
 *
 * There is no third member. The design had a `takeoff_display` class beside
 * these two, and it was collapsed into `read_live` deliberately: every field it
 * would have held is read out of the catalog by work that was already priced,
 * which is the whole of what `read_live` asks. `takeoffUnit` and
 * `countsTowardTakeoff` are read by `loadTakeoffCatalog` on every phase-list
 * render and in the export; `reservedPhaseNumber` is read by
 * `deriveNextPhaseNumber` the next time a phase is added to an estimate that
 * already exists. Split, the two would have to be added back together to print
 * the benchmark's one sentence about takeoff units, takeoff flags, reserved
 * phase numbers and active flags.
 */
export type EffectClass = "priced_at_creation" | "read_live";

/**
 * One field of one pool, with its absence semantics declared.
 *
 * The two absence answers differ and both are load-bearing — see the module
 * header. Getting one wrong is not a rounding error: `is_false` on
 * `takeoffUnit` would erase the single change that puts every estimate on a
 * phase into the takeoff map with a blank unit, and `is_distinct` on
 * `countsTowardTakeoff` would report every cloned row as edited forever.
 */
export interface DiffFieldSpec {
  readonly field: string;
  readonly effect: EffectClass;
  /**
   * Whether a ratio between two values of this field means anything.
   *
   * Only constants and rates qualify. `sortOrder` is a number and its ratio is
   * noise: 1,157 labor rows changed sort order across the real v1→v2 bump, and
   * treating 10→20 as a doubling would have buried the 583 genuine constant
   * moves under them.
   */
  readonly numeric: boolean;
  /** "is_false": absent ≡ false. "is_distinct": absent is its own value. */
  readonly absent: "is_false" | "is_distinct";
}

/**
 * Every field the diff compares, per pool.
 *
 * MUST stay in step with `beforeOf` in `rateBookShape.ts` — the test asserts
 * that `Object.keys(beforeOf(pool, row))` is covered here exactly, with
 * `retiredInBookId` the only permitted extra. `retiredInBookId` is here and not
 * there because no CSV column writes it, and a diff that could not see it would
 * report a retirement as a bare `isActive` flip.
 */
export const DIFF_FIELDS: Readonly<Record<PoolKind, readonly DiffFieldSpec[]>> = {
  wbs: [
    { field: "name", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "sortOrder", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    // A retired WBS drops out of `by_book_active`, which is what every picker
    // reads. Nothing on a finished estimate re-reads it, but the next one cannot
    // find it, so it is the honest boundary case of `read_live`.
    { field: "isActive", effect: "read_live", numeric: false, absent: "is_distinct" },
    { field: "retiredInBookId", effect: "read_live", numeric: false, absent: "is_distinct" },
  ],
  phases: [
    { field: "name", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "sortOrder", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    // ⚠️ `loadTakeoffCatalog` tests `takeoffUnit !== undefined` on every
    // phase-list render and inside the export. Absent, "" and "CY" are three
    // different answers to "does this phase have a takeoff", and only two of
    // them are visible if absence is coalesced.
    { field: "takeoffUnit", effect: "read_live", numeric: false, absent: "is_distinct" },
    // Read truthily by `deriveNextPhaseNumber`, which takes a boolean: absent
    // IS false here, and normalizing it is what keeps a cloned row quiet.
    { field: "reservedPhaseNumber", effect: "read_live", numeric: false, absent: "is_false" },
    { field: "isActive", effect: "read_live", numeric: false, absent: "is_distinct" },
    { field: "wbsPoolId", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "retiredInBookId", effect: "read_live", numeric: false, absent: "is_distinct" },
  ],
  labor: [
    { field: "description", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "sortOrder", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "craftConstant", effect: "priced_at_creation", numeric: true, absent: "is_distinct" },
    { field: "craftUnits", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "weldConstant", effect: "priced_at_creation", numeric: true, absent: "is_distinct" },
    { field: "weldUnits", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    // Read live by `loadTakeoffCatalog` (`if (item.countsTowardTakeoff)`), and
    // absent is false there, so absence must normalize or every cloned row
    // reads as an edit against every imported one.
    {
      field: "countsTowardTakeoff",
      effect: "read_live",
      numeric: false,
      absent: "is_false",
    },
    { field: "isActive", effect: "read_live", numeric: false, absent: "is_distinct" },
    { field: "phasePoolId", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "retiredInBookId", effect: "read_live", numeric: false, absent: "is_distinct" },
  ],
  equipment: [
    { field: "description", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "hourRate", effect: "priced_at_creation", numeric: true, absent: "is_distinct" },
    { field: "dayRate", effect: "priced_at_creation", numeric: true, absent: "is_distinct" },
    { field: "weekRate", effect: "priced_at_creation", numeric: true, absent: "is_distinct" },
    { field: "monthRate", effect: "priced_at_creation", numeric: true, absent: "is_distinct" },
    { field: "sortOrder", effect: "priced_at_creation", numeric: false, absent: "is_distinct" },
    { field: "isActive", effect: "read_live", numeric: false, absent: "is_distinct" },
    { field: "retiredInBookId", effect: "read_live", numeric: false, absent: "is_distinct" },
  ],
};

/** Every value a catalog field can hold once it has left the database. */
export type DiffValue = string | number | boolean;

/**
 * One catalog row as the differ sees it, from either book.
 *
 * `values` is verbatim: absence stays absence. Interpreting it is
 * {@link classifyFieldChange}'s job and happens in exactly one place, so the
 * caller cannot accidentally decide what a blank `takeoffUnit` means.
 */
export interface DiffRowInput {
  readonly poolId: number;
  /** `phasePoolId` for labor, `wbsPoolId` for phases; absent for wbs and equipment. */
  readonly parentPoolId?: number;
  /** `description` for labor and equipment, `name` for wbs and phases. */
  readonly description: string;
  readonly rowRevision: number;
  readonly values: Readonly<Record<string, DiffValue | undefined>>;
}

/**
 * What happened to one `(pool, poolId)` between the two books.
 *
 * `deactivated` and `reactivated` are first-class rather than a field change
 * on `isActive`, because they are the one edit that removes work from a
 * catalog, and a reader scanning a list of "edited" rows will not see it.
 */
export type DiffRowKind =
  | "edited"
  | "added"
  | "deactivated"
  | "reactivated"
  | "missing_in_draft"
  | "duplicate_in_draft";

/** Every reason a change is worth a second look, as a value rather than prose. */
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

/** One field of one row, before and after, with what is odd about it. */
export interface FieldChange {
  readonly field: string;
  readonly effect: EffectClass;
  /** Absent key means the field was ABSENT on that side, not that it was empty. */
  readonly before?: DiffValue;
  readonly after?: DiffValue;
  /** `after / before`, only for a numeric field with a non-zero before. */
  readonly ratio?: number;
  readonly deltaPct?: number;
  readonly flags: readonly DiffFlag[];
}

/** One row of the comparison. Never produced for a row that did not move. */
export interface DiffRow {
  readonly pool: PoolKind;
  readonly poolId: number;
  readonly kind: DiffRowKind;
  readonly parentDescription?: string;
  readonly draftDescription?: string;
  /**
   * True when the two descriptions fold to the same `normalizeKey`, so a
   * "rename" that is only whitespace or an autocorrected en-dash is visible as
   * what it is. False when there is nothing to compare — an addition, or a row
   * missing from the draft.
   */
  readonly descriptionsNormalizeEqual: boolean;
  /**
   * True when a `duplicate_in_draft` row's second copy holds different values
   * from the first, over the same {@link DIFF_FIELDS} walk. False when there is
   * no second copy at all, the same convention as `descriptionsNormalizeEqual`.
   *
   * G1 blocks on the duplicate either way, so nothing dangerous ships on this.
   * It is here because "id 7 appears twice" is two different incidents: two
   * identical copies is `retryDraftBuild` replaying a range it already wrote,
   * and two copies that disagree is something else writing a different row at
   * that id — and only one of those is fixed by deleting the extra.
   */
  readonly duplicateDiffers: boolean;
  readonly parentParentPoolId?: number;
  readonly draftParentPoolId?: number;
  readonly changes: readonly FieldChange[];
  readonly flags: readonly DiffFlag[];
  readonly shiftBandId?: string;
  readonly systematicGroupId?: string;
  readonly parentRowRevision?: number;
  readonly draftRowRevision?: number;
}

/**
 * Where each rule draws its line, and why it draws it there.
 *
 * Every number below is anchored to something measured on the real catalog.
 * Only `largeChangeRatio` is a convention, and the screen says so in those
 * words.
 */
export interface DiffThresholds {
  /** 0.005. A decimal point moved is EXACTLY a power of ten — 10x or 100x, and their
   *  reciprocals, which is the set {@link isDecimalShift} tests. A re-rate landing
   *  within half a percent of one of those is not a re-rate anybody argues for. */
  readonly decimalShiftTolerance: number;
  /** 10. The smallest possible decimal slip (0.6 -> 6.0) is exactly 10x, so anything
   *  at or past it is at least as large as a typo. Productivity revisions are
   *  single-digit percent to at most 2x. */
  readonly implausibleRatio: number;
  /** 2. A CONVENTION, and the screen says so in those words. Set at a doubling
   *  because that is where a person should have to say out loud that they meant it;
   *  set lower, a 5,897-row catalog produces hundreds of decisions and the gate
   *  becomes a click-through. The only adjustable threshold. */
  readonly largeChangeRatio: number;
  /** 5. Rows under one parent moving by an identical ratio are one policy, not N
   *  judgements — the same reasoning BlockKind.id_disagrees already encodes. */
  readonly systematicGroupMin: number;
  /** 3. normalizeKey produces ZERO collisions across all 5,897 v1 and 5,968 v2 labor
   *  rows and both equipment files (rateBookMatch.test.ts asserts it), so a
   *  description reappearing at a new id is a moved payload, never a coincidence.
   *  One or two could be a deliberate swap; three at a constant offset cannot be
   *  hand-typed. Calibrated against the real bands at -4, -455 and +8. */
  readonly shiftBandMin: number;
  /** 0.20. Measured against `editedCount / parentRowCount`, which on the one real
   *  change event is 1,199 edits over a 5,897-row parent: 20.3%, and every one of
   *  them was an accident nobody noticed for a version. The margin over the
   *  threshold is a third of a percent, so this bar is set exactly where the only
   *  catastrophe on record sits — not comfortably above it. */
  readonly bulkEditFraction: number;
  /** 0.05. The one real bump ADDED 71 rows (+1.2%); this is ~4x the only measured
   *  addition. The failure it targets — an id column deleted in Excel, which turns
   *  every row into an addition — sits at 100%. */
  readonly massChangeFraction: number;
  /** 3. The InDemand phase-maintenance workbook names one to three exact lines per
   *  phase. More means the flag was applied by pattern, which is legacy's
   *  description matching (2x on concrete, up to 28x on foundation phases)
   *  arriving through a new door. */
  readonly takeoffFlagsPerPhaseMax: number;
}

/** The calibrated defaults. `missingFromDraft` deliberately has no threshold: one is a failure. */
export const DEFAULT_DIFF_THRESHOLDS: DiffThresholds = {
  decimalShiftTolerance: 0.005,
  implausibleRatio: 10,
  largeChangeRatio: 2,
  systematicGroupMin: 5,
  shiftBandMin: 3,
  bulkEditFraction: 0.2,
  massChangeFraction: 0.05,
  takeoffFlagsPerPhaseMax: 3,
};

// ── Field-name sets ─────────────────────────────────────────────────────────
// Keyed by field NAME rather than by pool because these names are unique across
// pools; the names that repeat (`description`, `sortOrder`, `isActive`) are in
// none of them.

/** The fields that carry hours or money, where a zero deletes real work. */
const CONSTANT_FIELDS: ReadonlySet<string> = new Set([
  "craftConstant",
  "weldConstant",
  "hourRate",
  "dayRate",
  "weekRate",
  "monthRate",
]);

/** The fields that decide what a constant is multiplied by. */
const UNIT_FIELDS: ReadonlySet<string> = new Set(["craftUnits", "weldUnits", "takeoffUnit"]);

/** The fields whose change moves a row to a different parent, keeping its id. */
const PARENT_FIELDS: ReadonlySet<string> = new Set(["phasePoolId", "wbsPoolId"]);

/** Cumulative period prices, in the order they must ascend. */
const RATE_TIERS: readonly string[] = ["hourRate", "dayRate", "weekRate", "monthRate"];

/**
 * Six decimals, so float noise does not shatter a systematic group.
 *
 * 1.1 computed as 0.66/0.6 is 1.0999999999999999; a group keyed on the raw
 * quotient would report two policies where a person made one decision. The
 * sixth decimal is orders of magnitude below every threshold here.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Project a stored catalog document onto the fields the diff compares.
 *
 * The caller hands over a plain record — this module never names a Convex
 * `Doc`. Absence is preserved verbatim rather than coalesced; the whole point
 * of the roster is that `takeoffUnit: undefined` and `takeoffUnit: ""` are
 * different facts, and a projection that decided between them here would put
 * that decision somewhere nobody reviewing the diff can see it.
 *
 * A field holding anything other than a string, number or boolean projects as
 * absent. The schema permits none, and inventing a rendering for one would put
 * a fiction in an audit trail whose entire justification is that it is not
 * fiction.
 */
export function projectDiffValues(
  pool: PoolKind,
  doc: Readonly<Record<string, unknown>>
): Record<string, DiffValue | undefined> {
  const values: Record<string, DiffValue | undefined> = {};
  for (const spec of DIFF_FIELDS[pool]) {
    const value = doc[spec.field];
    values[spec.field] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : undefined;
  }
  return values;
}

// ── The streaming merge join ────────────────────────────────────────────────

/**
 * Both books' rows at one `poolId`.
 *
 * `duplicateDraft` is compared against `draft` — see `DiffRow.duplicateDiffers`.
 * It exists because Convex has no unique constraint and
 * `cloneBatch` can genuinely produce two rows at one id: it wraps its insert
 * loop in try/catch, so a throw part-way through COMMITS the inserts that
 * preceded it while leaving `buildCursor` unpatched, and `retryDraftBuild` then
 * replays the same range. Everything else in this subsystem assumes
 * `(book, poolId)` names one row; this is where that assumption is checked
 * rather than inherited.
 */
export interface RowPair {
  readonly poolId: number;
  readonly parent?: DiffRowInput;
  readonly draft?: DiffRowInput;
  readonly duplicateDraft?: DiffRowInput;
}

/**
 * The join's position between pages. In memory only.
 *
 * ⚠️ THE RESUME UNIT IS A WHOLE POOL, NOT A ROW, and the checkpoint is
 * `poolIndex` alone. This cursor is one of four things a run accumulates across
 * pages — the others are {@link DraftScanState}, {@link PoolTally} and the
 * parent key index {@link indexParentKey} fills — and only some of them are
 * Convex values. That is the trap: `PoolTally` is numbers and arrays and
 * persists cleanly, while `seenKeys`, `present` and `newTakeoffFlagsByPhase`
 * are a Map and two Sets and do not. So a checkpoint of three integers
 * (`poolIndex`, `draftLastPoolId`, `parentLastPoolId`) looks sufficient and is
 * not: a run that dies at labor row 3,000 and picks up there reports
 * `keyCollisions: []` and `missingFromDraft: []` for the first 3,000 rows and a
 * `parentRowCount` short by 3,000, and G1, G2 and G3 then pass on half a
 * catalog. G3's collision check is the premise the entire matcher rests on.
 *
 * So a pool that did not finish is restarted from its first row with a fresh
 * cursor, a fresh scan and a fresh tally, and the diff rows already flushed for
 * that pool are discarded with it. Serializing the accumulators instead was
 * rejected on size and on count: `seenKeys` is 5,897 entries for labor and the
 * parent key index the shift check needs is another 5,897 — roughly half a
 * megabyte rewritten on every page, against Convex's 1 MiB document limit, and
 * growing with the catalog. That is the margin `stageImport` already refused to
 * bet the catalog on, and it would have to be got right four times over: a
 * checkpoint that carries three of the four accumulators fails in exactly the
 * way the three-integer one does, one level further down. Re-reading labor
 * costs 11,794 documents in twelve paged queries — seconds, and only after a
 * crash.
 *
 * {@link poolIntegrity} refuses to close a pool whose scan and tally disagree
 * about how many draft rows went past, because that disagreement is what a
 * half-honoured checkpoint looks like from the inside.
 */
export interface MergeCursor {
  readonly lastEmittedPoolId: number;
  readonly pendingDraft: readonly DiffRowInput[];
  readonly pendingParent: readonly DiffRowInput[];
}

/** A join that has emitted nothing. `poolId` 0 is real (equipment starts there). */
export function emptyMergeCursor(): MergeCursor {
  return {
    lastEmittedPoolId: Number.MIN_SAFE_INTEGER,
    pendingDraft: [],
    pendingParent: [],
  };
}

function byPoolId(a: DiffRowInput, b: DiffRowInput): number {
  return a.poolId - b.poolId;
}

/**
 * One step of the two-sided merge join.
 *
 * A pair is emitted only when both sides have advanced PAST its poolId, or when
 * the side that would supply the partner is exhausted — which is what makes the
 * join correct across page boundaries and resumable after a redeploy. Emitting
 * at the frontier instead would call the last row of every page an addition,
 * and a duplicate straddling a page boundary would never be seen.
 *
 * Both pages must be ascending by `poolId`; both `by_book_pool_id` indexes
 * return them that way. The buffers are re-sorted anyway, because the failure
 * mode of an out-of-order page is silently dropped rows, and silently dropping
 * rows is the thing this whole subsystem exists to prevent.
 *
 * ⚠️ EACH PAGE MUST BE HANDED OVER EXACTLY ONCE PER CURSOR. Re-delivering a page
 * whose rows are still buffered puts every one of them in twice, and two rows at
 * one `poolId` is indistinguishable from the real duplicate this join exists to
 * catch — `DiffRowInput` carries nothing else to tell them apart by. Rows at or
 * below `lastEmittedPoolId` are dropped, which covers a paged query re-issued
 * after a transient failure and written with `gte` rather than `gt`; it cannot
 * cover a buffered page arriving twice. Anything worse than that restarts the
 * pool — see {@link MergeCursor}.
 */
export function mergeJoinStep(args: {
  readonly draftPage: readonly DiffRowInput[];
  readonly parentPage: readonly DiffRowInput[];
  readonly draftExhausted: boolean;
  readonly parentExhausted: boolean;
  readonly cursor: MergeCursor;
}): { pairs: readonly RowPair[]; cursor: MergeCursor } {
  const last = args.cursor.lastEmittedPoolId;
  // A row at or below the last emitted id is a replayed page after a resume.
  const fresh = (row: DiffRowInput): boolean => row.poolId > last;
  const draft = [...args.cursor.pendingDraft, ...args.draftPage].filter(fresh).sort(byPoolId);
  const parent = [...args.cursor.pendingParent, ...args.parentPage].filter(fresh).sort(byPoolId);

  const stall = (): { pairs: readonly RowPair[]; cursor: MergeCursor } => ({
    pairs: [],
    cursor: { lastEmittedPoolId: last, pendingDraft: draft, pendingParent: parent },
  });

  // The largest id that is still uncertain. Everything strictly below it is
  // settled on both sides.
  let frontier = Number.POSITIVE_INFINITY;
  if (!args.draftExhausted) {
    const tail = draft[draft.length - 1];
    if (!tail) return stall();
    frontier = Math.min(frontier, tail.poolId);
  }
  if (!args.parentExhausted) {
    const tail = parent[parent.length - 1];
    if (!tail) return stall();
    frontier = Math.min(frontier, tail.poolId);
  }

  const settled = (row: DiffRowInput): boolean => row.poolId < frontier;
  const emitDraft = draft.filter(settled);
  const emitParent = parent.filter(settled);

  const pairs: RowPair[] = [];
  const seen = new Map<
    number,
    { parent?: DiffRowInput; draft?: DiffRowInput; dup?: DiffRowInput }
  >();
  const order: number[] = [];
  const slot = (poolId: number) => {
    let entry = seen.get(poolId);
    if (!entry) {
      entry = {};
      seen.set(poolId, entry);
      order.push(poolId);
    }
    return entry;
  };
  // A second parent row at one id is a pre-existing condition of a published
  // book, not something this draft did; G1 is a statement about the draft, so
  // the first parent row wins and the extra is not mistaken for a draft change.
  for (const row of emitParent) {
    const entry = slot(row.poolId);
    if (!entry.parent) entry.parent = row;
  }
  for (const row of emitDraft) {
    const entry = slot(row.poolId);
    if (!entry.draft) entry.draft = row;
    else if (!entry.dup) entry.dup = row;
  }
  order.sort((a, b) => a - b);
  for (const poolId of order) {
    const entry = seen.get(poolId);
    if (!entry) continue;
    pairs.push({
      poolId,
      parent: entry.parent,
      draft: entry.draft,
      duplicateDraft: entry.dup,
    });
  }

  const emitted = order[order.length - 1] ?? last;
  return {
    pairs,
    cursor: {
      lastEmittedPoolId: emitted,
      pendingDraft: draft.filter((row) => !settled(row)),
      pendingParent: parent.filter((row) => !settled(row)),
    },
  };
}

// ── Field classification ────────────────────────────────────────────────────

function isDecimalShift(ratio: number, tolerance: number): boolean {
  for (const power of [0.01, 0.1, 10, 100]) {
    if (Math.abs(ratio / power - 1) <= tolerance) return true;
  }
  return false;
}

/**
 * One field, classified.
 *
 * The flags come out in descending order of how confident the rule is that
 * something is wrong, and three suppressions matter:
 *
 *  - `decimal_shift` suppresses `implausible_magnitude` and `large_change`. A
 *    decimal point is a SHAPE of typo, not a size of change, and it must never
 *    be swallowed into a systematic group of honest re-rates.
 *  - `zeroed_constant` suppresses both as well. "This constant is now zero" is
 *    the finding; "it moved by more than 2x" is a weaker way of saying it.
 *  - Only a numeric field with a non-zero before produces a ratio at all, so a
 *    0 -> 0.6 activation is reported as `constant_activated` and nothing else.
 *    That asymmetry is deliberate: ->0 destroys hours invisibly in every future
 *    estimate, while 0-> creates hours the benchmark will show.
 */
export function classifyFieldChange(
  spec: DiffFieldSpec,
  before: DiffValue | undefined,
  after: DiffValue | undefined,
  thresholds: DiffThresholds
): FieldChange | null {
  const from: DiffValue | undefined = spec.absent === "is_false" ? (before ?? false) : before;
  const to: DiffValue | undefined = spec.absent === "is_false" ? (after ?? false) : after;
  if (from === to) return null;

  let ratio: number | undefined;
  let deltaPct: number | undefined;
  if (spec.numeric && typeof from === "number" && typeof to === "number" && from !== 0) {
    ratio = round6(to / from);
    deltaPct = round4(((to - from) / Math.abs(from)) * 100);
  }

  const constantLike = CONSTANT_FIELDS.has(spec.field);
  const decimal = ratio !== undefined && isDecimalShift(ratio, thresholds.decimalShiftTolerance);
  const zeroed = constantLike && typeof from === "number" && from !== 0 && to === 0;
  const activated = constantLike && from === 0 && typeof to === "number" && to !== 0;

  const flags: DiffFlag[] = [];
  if (decimal) flags.push("decimal_shift");
  if (zeroed) flags.push("zeroed_constant");
  if (activated) flags.push("constant_activated");
  // ⚠️ A units flip with the number untouched is 10x on a ten-foot spool and
  // nothing else in the diff would see it: 0.6 LF and 0.6 EA look identical in
  // every numeric comparison. 268 labor rows changed craft units across the one
  // real bump.
  if (UNIT_FIELDS.has(spec.field)) flags.push("unit_changed");
  if (!decimal && !zeroed && ratio !== undefined) {
    if (ratio >= thresholds.implausibleRatio || ratio <= 1 / thresholds.implausibleRatio) {
      flags.push("implausible_magnitude");
    }
    if (ratio >= thresholds.largeChangeRatio || ratio <= 1 / thresholds.largeChangeRatio) {
      flags.push("large_change");
    }
  }
  // The one edit that makes an id and its meaning disagree by construction: the
  // row keeps its id and changes its natural key.
  if (PARENT_FIELDS.has(spec.field)) flags.push("reparented");
  if (spec.effect === "read_live") flags.push("live_read_field");

  // The keys are omitted rather than set to undefined: "this field was absent"
  // and "this field was empty" are the two answers `takeoffUnit` turns on, and
  // a present-but-undefined key reads as the second one on every screen and in
  // every stored document.
  return {
    field: spec.field,
    effect: spec.effect,
    ...(from !== undefined ? { before: from } : {}),
    ...(to !== undefined ? { after: to } : {}),
    ...(ratio !== undefined ? { ratio } : {}),
    ...(deltaPct !== undefined ? { deltaPct } : {}),
    flags,
  };
}

/**
 * Equipment rates that do not ascend.
 *
 * They are cumulative period prices — book #1 id 5 is 7/56/224/672 — so an
 * inversion is wrong on its face with no history needed. Zero tiers are
 * excluded: a missing tier is legitimate and 129 of 129 real rows are ordered.
 */
function tiersInverted(values: Readonly<Record<string, DiffValue | undefined>>): boolean {
  const present: number[] = [];
  for (const tier of RATE_TIERS) {
    const value = values[tier];
    if (typeof value === "number" && value !== 0) present.push(value);
  }
  for (let i = 1; i < present.length; i += 1) {
    const previous = present[i - 1];
    const current = present[i];
    if (previous !== undefined && current !== undefined && previous > current) return true;
  }
  return false;
}

/**
 * Classify one pair. Null for an unchanged pair.
 *
 * The ~4,700 labor rows that did not move between v1 and v2 are counted and
 * never stored: 12,000 documents to say nothing happened is not an audit trail,
 * it is a way to make the 1,270 that did move unreadable.
 *
 * `kind` is a single value and the precedence is worst-first —
 * `duplicate_in_draft`, then `missing_in_draft`, then `added`, then
 * de/reactivation, then `edited` — while `changes` still carries every field
 * that moved. A row that was deactivated AND re-rated says both.
 */
export function diffPair(
  pool: PoolKind,
  pair: RowPair,
  thresholds: DiffThresholds
): DiffRow | null {
  const { parent, draft, duplicateDraft } = pair;
  const changes: FieldChange[] = [];
  if (parent && draft) {
    for (const spec of DIFF_FIELDS[pool]) {
      const change = classifyFieldChange(
        spec,
        parent.values[spec.field],
        draft.values[spec.field],
        thresholds
      );
      if (change) changes.push(change);
    }
  }

  // The second copy is compared against the first over the same roster, and
  // reported as one boolean rather than as a second `changes` list: the row's
  // finding is "there are two of these", and a duplicate that also disagrees
  // with itself is a different incident from one that does not. Without it the
  // two copies are described by a single `DiffRow` that quotes only the first,
  // so an admin reading "id 7 appears twice" cannot tell a replayed range from
  // something writing a different row at that id.
  const duplicateDiffers =
    draft !== undefined &&
    duplicateDraft !== undefined &&
    DIFF_FIELDS[pool].some(
      (spec) =>
        classifyFieldChange(
          spec,
          draft.values[spec.field],
          duplicateDraft.values[spec.field],
          thresholds
        ) !== null
    );

  let kind: DiffRowKind;
  if (duplicateDraft) kind = "duplicate_in_draft";
  else if (!draft) kind = "missing_in_draft";
  else if (!parent) kind = "added";
  else {
    const active = changes.find((change) => change.field === "isActive");
    if (active?.before === true && active.after === false) kind = "deactivated";
    else if (active?.before === false && active.after === true) kind = "reactivated";
    else if (changes.length === 0) return null;
    else kind = "edited";
  }

  const flags = new Set<DiffFlag>();
  for (const change of changes) for (const flag of change.flags) flags.add(flag);
  // Checked on every row this draft wrote — edited OR added. An inversion
  // inherited unchanged from the parent is not a change and does not appear
  // here; the foundation book, which was never gated, is the one place that
  // needs reading by hand. A NEW row is entirely the draft's doing, so leaving
  // additions out would let 7/56/224/12 into a book through the one door nobody
  // is watching — and equipment additions are not hypothetical: the real v1→v2
  // bump added four rows.
  if (
    pool === "equipment" &&
    draft &&
    (changes.length > 0 || !parent) &&
    tiersInverted(draft.values)
  ) {
    flags.add("rate_tier_inversion");
  }

  return {
    pool,
    poolId: pair.poolId,
    kind,
    parentDescription: parent?.description,
    draftDescription: draft?.description,
    descriptionsNormalizeEqual:
      parent !== undefined &&
      draft !== undefined &&
      normalizeKey(parent.description) === normalizeKey(draft.description),
    duplicateDiffers,
    parentParentPoolId: parent?.parentPoolId,
    draftParentPoolId: draft?.parentPoolId,
    changes,
    flags: [...flags],
    parentRowRevision: parent?.rowRevision,
    draftRowRevision: draft?.rowRevision,
  };
}

// ── Shift detection ─────────────────────────────────────────────────────────

/**
 * A description that now sits at a different id than it did in the parent.
 *
 * `pool` is not decoration, for the same reason `publishGates` gives: a poolId
 * names one row within its pool and nowhere else. Equipment ids run 0–133, so
 * every one of them is also a labor id, and an observation that travelled
 * without its pool would let equipment's 60-row band stamp `shifted_payload` on
 * sixty labor rows nobody touched.
 */
export interface RenameObservation {
  readonly pool: PoolKind;
  readonly draftPoolId: number;
  readonly parentPoolIdOfKey: number;
}

/** One run of moved descriptions sharing a constant offset, within one pool. */
export interface ShiftBand {
  /** `shift:<pool>:<offset>:<start>-<end>`. The review screen signs against this. */
  readonly id: string;
  readonly pool: PoolKind;
  /** `draftPoolId - parentPoolIdOfKey`. Negative means the payload moved up the sheet. */
  readonly offset: number;
  readonly startPoolId: number;
  readonly endPoolId: number;
  readonly rowCount: number;
  readonly poolIds: readonly number[];
}

/** The natural key the diff pairs on — the matcher's rule, not a second one. */
export function diffRowKey(row: DiffRowInput): string {
  return naturalKey({ description: row.description, parentPoolId: row.parentPoolId });
}

/**
 * Add one parent row to the key map the shift check reads.
 *
 * First writer wins, exactly as `buildMatchIndex` does: a silent overwrite here
 * would hide a key collision instead of reporting one, and the collision check
 * is the premise the whole match rule rests on.
 */
export function indexParentKey(index: Map<string, number>, row: DiffRowInput): void {
  const key = diffRowKey(row);
  if (!index.has(key)) index.set(key, row.poolId);
}

/**
 * Which of the kept rows carry a description that lived at a different id.
 *
 * Run at the pool boundary, when the parent key map is complete, over the
 * changed and added rows only — the ~4,700 untouched labor rows cannot have
 * moved, by definition.
 */
export function renameObservations(
  parentKeys: ReadonlyMap<string, number>,
  rows: readonly DiffRow[]
): RenameObservation[] {
  const observations: RenameObservation[] = [];
  for (const row of rows) {
    if (row.draftDescription === undefined) continue;
    const key = naturalKey({
      description: row.draftDescription,
      parentPoolId: row.draftParentPoolId,
    });
    const parentPoolIdOfKey = parentKeys.get(key);
    if (parentPoolIdOfKey === undefined || parentPoolIdOfKey === row.poolId) continue;
    observations.push({ pool: row.pool, draftPoolId: row.poolId, parentPoolIdOfKey });
  }
  return observations;
}

/**
 * Group moved descriptions into bands.
 *
 * "Contiguous" means adjacent in the observations sorted by draft poolId, NOT
 * literally n, n+1, n+2 — catalog ids are sparse (equipment starts at 0, labor
 * has gaps) and a literal reading would shatter the real bands into dozens of
 * fragments, each below any threshold, and report a catastrophe as noise.
 *
 * A run never spans two pools, whatever order the observations arrive in. Ids
 * 0–133 exist in both equipment and labor, so a run that crossed the boundary
 * would read two unrelated catalogs as one slipped spreadsheet.
 *
 * CALIBRATION: run against labor_v1/v2.json this must return exactly three
 * bands at offsets -4, -455 and +8 totalling 1,064 rows, with nothing left
 * over. If it cannot find that, it is wrong, and we would rather learn it here
 * than after an admin has published.
 */
export function detectShiftBands(
  observations: readonly RenameObservation[],
  minBand: number
): { bands: readonly ShiftBand[]; unbanded: readonly RenameObservation[] } {
  const sorted = [...observations].sort((a, b) =>
    a.pool === b.pool ? a.draftPoolId - b.draftPoolId : a.pool < b.pool ? -1 : 1
  );
  const runs: { pool: PoolKind; offset: number; items: RenameObservation[] }[] = [];
  for (const observation of sorted) {
    const offset = observation.draftPoolId - observation.parentPoolIdOfKey;
    const current = runs[runs.length - 1];
    if (current && current.offset === offset && current.pool === observation.pool) {
      current.items.push(observation);
    } else runs.push({ pool: observation.pool, offset, items: [observation] });
  }

  const bands: ShiftBand[] = [];
  const unbanded: RenameObservation[] = [];
  for (const run of runs) {
    if (run.items.length < minBand) {
      unbanded.push(...run.items);
      continue;
    }
    const poolIds = run.items.map((item) => item.draftPoolId);
    const start = poolIds[0];
    const end = poolIds[poolIds.length - 1];
    if (start === undefined || end === undefined) continue;
    bands.push({
      id: `shift:${run.pool}:${run.offset}:${start}-${end}`,
      pool: run.pool,
      offset: run.offset,
      startPoolId: start,
      endPoolId: end,
      rowCount: poolIds.length,
      poolIds,
    });
  }
  return { bands, unbanded };
}

/**
 * Stamp the shift findings onto the rows they describe.
 *
 * Must run before {@link groupSystematic}: a shifted row's "before" is a
 * different item, so its numeric changes are a comparison against something
 * else entirely, and folding one into a systematic group of honest re-rates
 * would hide the only fact about it that matters. Nothing is discarded — a run
 * too short to be a band becomes a per-row `description_swap`, which is the
 * case a person must confirm individually because a threshold of three is
 * structurally blind to a deliberate two-item swap.
 */
export function markShiftedRows(
  rows: readonly DiffRow[],
  bands: readonly ShiftBand[],
  unbanded: readonly RenameObservation[]
): DiffRow[] {
  // Keyed by pool AND id: labor and equipment both number their rows from
  // single digits, so a bare poolId would let one pool's findings land on the
  // other's rows the moment a caller marks more than one pool's rows at once.
  const at = (pool: PoolKind, poolId: number): string => `${pool}:${poolId}`;
  const bandOf = new Map<string, string>();
  for (const band of bands) {
    for (const poolId of band.poolIds) bandOf.set(at(band.pool, poolId), band.id);
  }
  const swapped = new Set(
    unbanded.map((observation) => at(observation.pool, observation.draftPoolId))
  );
  return rows.map((row) => {
    const bandId = bandOf.get(at(row.pool, row.poolId));
    if (bandId) {
      const flags: DiffFlag[] = [...new Set<DiffFlag>([...row.flags, "shifted_payload"])];
      return { ...row, shiftBandId: bandId, flags };
    }
    if (swapped.has(at(row.pool, row.poolId))) {
      const flags: DiffFlag[] = [...new Set<DiffFlag>([...row.flags, "description_swap"])];
      return { ...row, flags };
    }
    return row;
  });
}

// ── Systematic grouping ─────────────────────────────────────────────────────

/** One decision covering N rows that moved by an identical ratio under one parent. */
export interface SystematicGroup {
  readonly id: string;
  readonly parentPoolId?: number;
  readonly field: string;
  readonly ratio: number;
  readonly rowCount: number;
  readonly exampleDescriptions: readonly string[];
}

/** The flags that mean "this is a shape of error", which never group. */
const UNGROUPABLE: ReadonlySet<DiffFlag> = new Set<DiffFlag>([
  "decimal_shift",
  "zeroed_constant",
  "unit_changed",
  "description_swap",
  "shifted_payload",
  "reparented",
  "rate_tier_inversion",
]);

/**
 * Collapse an honest bulk re-rate into one decision.
 *
 * "All 43 lines under CARBON STEEL - A106/A53 moved by exactly 1.10x" is one
 * fact a person can act on. 43 checkboxes is how you teach somebody to click.
 *
 * A row qualifies only if exactly ONE of its fields is a `large_change` and it
 * carries no error-shape flag: two independently large moves on one row is not
 * one policy, and a row that is also a decimal shift or a moved payload has a
 * finding of its own that a group would swallow.
 */
export function groupSystematic(
  rows: readonly DiffRow[],
  minGroup: number
): { groups: readonly SystematicGroup[]; rows: readonly DiffRow[] } {
  const buckets = new Map<
    string,
    { field: string; ratio: number; parentPoolId?: number; rows: DiffRow[] }
  >();

  for (const row of rows) {
    if (row.kind !== "edited") continue;
    if (row.flags.some((flag) => UNGROUPABLE.has(flag))) continue;
    const large = row.changes.filter((change) => change.flags.includes("large_change"));
    const only = large.length === 1 ? large[0] : undefined;
    if (!only || only.ratio === undefined) continue;
    const parentPoolId = row.draftParentPoolId ?? row.parentParentPoolId;
    // The ratio the row already reports, not a second rounding of it: a group
    // whose headline ratio differs from the ratio printed on its own rows is a
    // group nobody will trust twice.
    const ratio = only.ratio;
    // Pool-qualified, and so is `groupOf` below. `group:<id>` is the key an
    // admin's signature is stored against, and equipment id 12 is also a labor
    // id — one signature must never cover two pools' rows.
    const key = `${row.pool}|${parentPoolId ?? "-"}|${only.field}|${ratio}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(key, { field: only.field, ratio, parentPoolId, rows: [row] });
  }

  const groups: SystematicGroup[] = [];
  const groupOf = new Map<string, string>();
  for (const [key, bucket] of buckets) {
    if (bucket.rows.length < minGroup) continue;
    const id = `systematic:${key}`;
    groups.push({
      id,
      parentPoolId: bucket.parentPoolId,
      field: bucket.field,
      ratio: bucket.ratio,
      rowCount: bucket.rows.length,
      exampleDescriptions: bucket.rows
        .slice(0, 3)
        .map((row) => row.draftDescription ?? row.parentDescription ?? ""),
    });
    for (const row of bucket.rows) groupOf.set(`${row.pool}:${row.poolId}`, id);
  }

  return {
    groups,
    rows: rows.map((row) => {
      const id = groupOf.get(`${row.pool}:${row.poolId}`);
      return id ? { ...row, systematicGroupId: id } : row;
    }),
  };
}

// ── Integrity, computed by the same pass ────────────────────────────────────

/**
 * What the walk over the draft side learned on its way past.
 *
 * All of it is free: the pools are walked in order wbs -> phases -> labor ->
 * equipment, so `present` from an earlier pool is the valid-parent set for the
 * next one, and the whole check costs two `Set<number>` of 18 and 228 entries.
 */
export interface DraftScanState {
  readonly seenKeys: Map<string, number>;
  readonly collisions: string[];
  /** poolIds present in the draft, per pool, for the next pool's reference check. */
  readonly present: Set<number>;
  /** phasePoolId -> count of labor rows NEWLY flagged countsTowardTakeoff. */
  readonly newTakeoffFlagsByPhase: Map<number, number>;
  /** Draft rows whose parent id does not exist in this draft. */
  readonly danglingParentRefs: { poolId: number; parentPoolId: number }[];
  /** The previous pool's `present` set; absent for wbs and equipment. */
  readonly validParentIds?: ReadonlySet<number>;
}

/**
 * A fresh scan.
 *
 * `validParentIds` is the previous pool's `present` set. Omit it for wbs and
 * equipment, which have no parent.
 */
export function newDraftScanState(validParentIds?: ReadonlySet<number>): DraftScanState {
  return {
    seenKeys: new Map(),
    collisions: [],
    present: new Set(),
    newTakeoffFlagsByPhase: new Map(),
    danglingParentRefs: [],
    validParentIds,
  };
}

/**
 * Observe one draft row.
 *
 * `parent` is the same row in the parent book, when the merge join has it.
 * Without it "newly flagged for takeoff" cannot be distinguished from "was
 * already flagged", and the difference is the whole point of the check: the
 * threshold is about flags this draft ADDED, because legacy's description
 * matching flagged up to 28 lines on a foundation phase and that is the failure
 * arriving through a new door.
 *
 * ⚠️ Mutates `state` in place, like `addCosts` and for the same reason: this
 * runs over 12,000 rows a pool at a time.
 */
export function observeDraftRow(
  state: DraftScanState,
  pool: PoolKind,
  row: DiffRowInput,
  parent?: DiffRowInput
): void {
  state.present.add(row.poolId);

  const key = diffRowKey(row);
  const first = state.seenKeys.get(key);
  if (first === undefined) state.seenKeys.set(key, row.poolId);
  else if (!state.collisions.includes(key)) state.collisions.push(key);

  const validParentIds = state.validParentIds;
  if (validParentIds && row.parentPoolId !== undefined && !validParentIds.has(row.parentPoolId)) {
    // `shapeRow` parses phase_code but never checks the phase exists, `matchRow`
    // cannot match against a nonexistent parent so the row becomes an addition,
    // and `insertPoolRow` writes it at a dangling phasePoolId. The row then
    // exists, counts toward rowCounts, and is invisible everywhere — every
    // picker and `loadTakeoffCatalog` query `by_book_phase_active` under phases
    // that DO exist.
    state.danglingParentRefs.push({ poolId: row.poolId, parentPoolId: row.parentPoolId });
  }

  if (pool !== "labor") return;
  const flagged = row.values.countsTowardTakeoff === true;
  const wasFlagged = parent?.values.countsTowardTakeoff === true;
  if (!flagged || wasFlagged || row.parentPoolId === undefined) return;
  const phase = row.parentPoolId;
  state.newTakeoffFlagsByPhase.set(phase, (state.newTakeoffFlagsByPhase.get(phase) ?? 0) + 1);
}

/**
 * Running counts for one pool, accumulated as pairs are classified.
 *
 * Plain JSON, unlike {@link DraftScanState} — which is exactly why it must not
 * be checkpointed on its own. See {@link MergeCursor}.
 */
export interface PoolTally {
  draftRowCount: number;
  parentRowCount: number;
  addedCount: number;
  deactivatedCount: number;
  reactivatedCount: number;
  editedCount: number;
  missingFromDraft: number[];
  duplicatePoolIds: number[];
}

/** A pool nobody has counted yet. */
export function newPoolTally(): PoolTally {
  return {
    draftRowCount: 0,
    parentRowCount: 0,
    addedCount: 0,
    deactivatedCount: 0,
    reactivatedCount: 0,
    editedCount: 0,
    missingFromDraft: [],
    duplicatePoolIds: [],
  };
}

/**
 * Count one pair.
 *
 * Counting lives here rather than in the action because the action is where a
 * second, subtly different definition of "edited" would grow — and the first
 * screen to disagree with the gate about how many rows changed is the screen
 * that teaches an admin the gate is arbitrary.
 */
export function tallyPair(tally: PoolTally, pair: RowPair, row: DiffRow | null): void {
  if (pair.parent) tally.parentRowCount += 1;
  if (pair.draft) tally.draftRowCount += 1;
  if (pair.duplicateDraft) {
    tally.draftRowCount += 1;
    tally.duplicatePoolIds.push(pair.poolId);
  }
  if (!pair.draft && pair.parent) tally.missingFromDraft.push(pair.poolId);
  if (!row) return;
  if (row.kind === "added") tally.addedCount += 1;
  else if (row.kind === "deactivated") tally.deactivatedCount += 1;
  else if (row.kind === "reactivated") tally.reactivatedCount += 1;
  else if (row.kind === "edited" || row.kind === "duplicate_in_draft") tally.editedCount += 1;
}

/** Everything that must be true of a draft before it can be a book. */
export interface PoolIntegrity {
  readonly pool: PoolKind;
  readonly draftRowCount: number;
  readonly parentRowCount: number;
  readonly duplicatePoolIds: readonly number[];
  /** No threshold: ONE is a failure. Nothing in the subsystem deletes a cloned row. */
  readonly missingFromDraft: readonly number[];
  readonly keyCollisions: readonly string[];
  readonly danglingParentRefs: readonly { poolId: number; parentPoolId: number }[];
  readonly addedCount: number;
  readonly deactivatedCount: number;
  /**
   * Rows this draft brought BACK. Retirement's mirror, and it needs its own
   * number for the same reason retirement does: a row returning to `isActive`
   * reappears in every picker that reads `by_book_active` and in
   * `loadTakeoffCatalog`, on every estimate on the book, and a wave of them has
   * the same cause as a wave of retirements — a file whose id column moved.
   * Counted into `massChangePools` alongside the other two.
   */
  readonly reactivatedCount: number;
  readonly editedCount: number;
}

/**
 * Close one pool: the counts and the scan, in the shape the gates read.
 *
 * ⚠️ THROWS when the scan and the tally disagree about how many draft rows went
 * past. The two accumulate side by side over the same pairs, so
 * `present.size === draftRowCount - duplicatePoolIds.length` holds for every
 * run that walked its pool end to end — a duplicate adds two to the count and
 * one id to the set. It fails when a run carried one accumulator across a
 * restart and rebuilt the other, which is the one shape of resume this module
 * cannot survive and cannot otherwise see: `PoolTally` is a Convex value and
 * `DraftScanState` is not, so persisting the half that serializes is the
 * natural mistake. Its result is a pool reporting complete row counts with
 * `keyCollisions: []` for everything before the restart, which G3 reads as a
 * clean catalog. See {@link MergeCursor} for the resume rule this defends.
 */
export function poolIntegrity(
  pool: PoolKind,
  tally: PoolTally,
  scan: DraftScanState
): PoolIntegrity {
  const observed = scan.present.size;
  const counted = tally.draftRowCount - tally.duplicatePoolIds.length;
  if (observed !== counted) {
    throw new Error(
      `The ${pool} scan observed ${observed} draft rows while its tally counted ${counted}. ` +
        `A pool is scanned end to end in one run or restarted from its first row; ` +
        `this one was resumed with half its state, and its collision and reference ` +
        `checks describe only part of the pool.`
    );
  }
  return {
    pool,
    draftRowCount: tally.draftRowCount,
    parentRowCount: tally.parentRowCount,
    duplicatePoolIds: tally.duplicatePoolIds,
    missingFromDraft: tally.missingFromDraft,
    keyCollisions: scan.collisions,
    danglingParentRefs: scan.danglingParentRefs,
    addedCount: tally.addedCount,
    deactivatedCount: tally.deactivatedCount,
    reactivatedCount: tally.reactivatedCount,
    editedCount: tally.editedCount,
  };
}

// ── Takeoff-flag marking ────────────────────────────────────────────────────

/**
 * The phases where this draft added more takeoff flags than the maintenance
 * workbook ever names for one phase.
 *
 * Private, and read by both {@link markTakeoffFlagBulk} and
 * {@link summarizeDiff}, so the rows carrying the flag and the phases named in
 * the summary can never come from two different readings of the threshold.
 */
function bulkFlaggedPhases(byPhase: ReadonlyMap<number, number>, max: number): number[] {
  return [...byPhase.entries()]
    .filter(([, count]) => count > max)
    .map(([phase]) => phase)
    .sort((a, b) => a - b);
}

/**
 * Stamp `takeoff_flags_bulk` on the rows the finding is about.
 *
 * A separate step for the same reason {@link markShiftedRows} is one: the
 * verdict is about a whole phase and can only be reached once the pool has been
 * walked, but it has to land on rows, because `rateBookDiffRows` is read per
 * flag class through `by_diff_flag` and a flag that lives only in a counter
 * names four rows the review screen cannot list.
 *
 * The rows are the ones an edit newly flagged — an added row carries no field
 * changes, so a phase whose flags all arrived on new rows reaches the summary
 * with the phase named and no rows marked, which is the honest reading of it.
 */
export function markTakeoffFlagBulk(args: {
  readonly rows: readonly DiffRow[];
  readonly takeoffFlagsByPhase: ReadonlyMap<number, number>;
  readonly thresholds: DiffThresholds;
}): DiffRow[] {
  const phases = new Set(
    bulkFlaggedPhases(args.takeoffFlagsByPhase, args.thresholds.takeoffFlagsPerPhaseMax)
  );
  if (phases.size === 0) return [...args.rows];
  return args.rows.map((row) => {
    if (row.draftParentPoolId === undefined || !phases.has(row.draftParentPoolId)) return row;
    const newlyFlagged = row.changes.some(
      (change) => change.field === "countsTowardTakeoff" && change.after === true
    );
    if (!newlyFlagged) return row;
    const flags: DiffFlag[] = [...new Set<DiffFlag>([...row.flags, "takeoff_flags_bulk"])];
    return { ...row, flags };
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────

/** Everything the publish gates and the review screen read about one run. */
export interface DiffSummary {
  readonly pools: readonly PoolIntegrity[];
  readonly changedRowCount: number;
  readonly unchangedRowCount: number;
  /** Rows carrying each flag — always rows, never fields, so the numbers add up. */
  readonly flagCounts: Readonly<Record<DiffFlag, number>>;
  /** Rows carrying a change of each effect class. Row-denominated for the same reason. */
  readonly effectCounts: Readonly<Record<EffectClass, number>>;
  readonly shiftBands: readonly ShiftBand[];
  readonly systematicGroups: readonly SystematicGroup[];
  readonly changedLaborPoolIds: readonly number[];
  readonly changedEquipmentPoolIds: readonly number[];
  readonly deactivatedPoolIds: Readonly<Record<PoolKind, readonly number[]>>;
  readonly bulkEditPools: readonly PoolKind[];
  readonly massChangePools: readonly PoolKind[];
  readonly takeoffFlagBulkPhases: readonly number[];
  readonly thresholds: DiffThresholds;
}

function emptyFlagCounts(): Record<DiffFlag, number> {
  return {
    shifted_payload: 0,
    description_swap: 0,
    decimal_shift: 0,
    implausible_magnitude: 0,
    large_change: 0,
    zeroed_constant: 0,
    constant_activated: 0,
    unit_changed: 0,
    rate_tier_inversion: 0,
    reparented: 0,
    takeoff_flags_bulk: 0,
    live_read_field: 0,
  };
}

/**
 * One summary from the per-pool tallies and the rows the run kept.
 *
 * Called ONCE, with the accumulated counters and the changed rows — never with
 * 12,000 rows in memory. `unchangedRowCount` is a subtraction, not a list.
 *
 * `rows` must be what the marking steps produced, in order:
 * {@link markShiftedRows} -> {@link groupSystematic} -> {@link markTakeoffFlagBulk}.
 * Every flag count here is read off `row.flags`, so a run that summarizes its
 * raw rows reports zeros for the three findings only the marking steps stamp:
 * `shifted_payload`, `description_swap` and `takeoff_flags_bulk`.
 */
export function summarizeDiff(args: {
  readonly pools: readonly PoolIntegrity[];
  readonly rows: readonly DiffRow[];
  readonly bands: readonly ShiftBand[];
  readonly groups: readonly SystematicGroup[];
  readonly takeoffFlagsByPhase: ReadonlyMap<number, number>;
  readonly thresholds: DiffThresholds;
}): DiffSummary {
  const { pools, rows, thresholds } = args;
  const flagCounts = emptyFlagCounts();
  const effectCounts: Record<EffectClass, number> = { priced_at_creation: 0, read_live: 0 };
  const deactivatedPoolIds: Record<PoolKind, number[]> = {
    wbs: [],
    phases: [],
    labor: [],
    equipment: [],
  };
  const changedLaborPoolIds: number[] = [];
  const changedEquipmentPoolIds: number[] = [];

  const takeoffFlagBulkPhases = bulkFlaggedPhases(
    args.takeoffFlagsByPhase,
    thresholds.takeoffFlagsPerPhaseMax
  );

  for (const row of rows) {
    // `takeoff_flags_bulk` included: counting it here rather than re-deriving it
    // is what keeps the tally and the rows `by_diff_flag` returns the same set.
    for (const flag of row.flags) flagCounts[flag] += 1;
    const effects = new Set(row.changes.map((change) => change.effect));
    for (const effect of effects) effectCounts[effect] += 1;
    if (row.kind === "deactivated") deactivatedPoolIds[row.pool].push(row.poolId);
    if (row.pool === "labor") changedLaborPoolIds.push(row.poolId);
    if (row.pool === "equipment") changedEquipmentPoolIds.push(row.poolId);
  }

  // Every pair the join produced: one per parent row, plus the draft rows that
  // had no parent. NOT `max(draft, parent)` — a pool that lost five rows and
  // gained five has the same max as one that changed nothing, and the five it
  // lost would be reported to an admin as five rows that were left alone.
  const totalRows = pools.reduce((sum, pool) => sum + pool.parentRowCount + pool.addedCount, 0);

  return {
    pools,
    changedRowCount: rows.length,
    unchangedRowCount: Math.max(0, totalRows - rows.length),
    flagCounts,
    effectCounts,
    shiftBands: args.bands,
    systematicGroups: args.groups,
    changedLaborPoolIds,
    changedEquipmentPoolIds,
    deactivatedPoolIds,
    bulkEditPools: pools
      .filter(
        (pool) =>
          pool.parentRowCount > 0 &&
          pool.editedCount / pool.parentRowCount >= thresholds.bulkEditFraction
      )
      .map((pool) => pool.pool),
    // Additions, deactivations and reactivations share a threshold because they
    // share a cause: a file whose id column moved. Which one it was is on the
    // PoolIntegrity, as three separate counts, and the gate has to read them
    // before it names one — 400 rows coming back is not 400 rows leaving, and a
    // requirement that says the wrong one of those is a requirement nobody
    // believes twice.
    massChangePools: pools
      .filter(
        (pool) =>
          pool.parentRowCount > 0 &&
          Math.max(pool.addedCount, pool.deactivatedCount, pool.reactivatedCount) /
            pool.parentRowCount >=
            thresholds.massChangeFraction
      )
      .map((pool) => pool.pool),
    takeoffFlagBulkPhases,
    thresholds,
  };
}
