/**
 * What the Firestore mirror actually has to write, decided per row.
 *
 * WHY THIS EXISTS. Editing an activity in the MCP Estimator writes only to the
 * `activities` collection, so `proposal.updateTime` never moves, and activities
 * carry no `updatedAt` field at all — Firestore cannot be asked what changed.
 * The mirror therefore reads everything and writes only what differs, which
 * makes "differs" the load-bearing word: a comparison that reports a change
 * where none exists turns a 352,969-row estate into 352,969 writes on every
 * pass and throws away the whole economic case for the design.
 *
 * So the rule is deliberately narrow. A row is UNCHANGED unless one of the
 * fields the caller is actually going to write moved. Everything else Convex
 * holds — `bookId`, `precisionOwnedAt`, `costTotal`, `contactId`, `isHidden`,
 * `countsTowardTakeoff`, the repaired `laborPoolId`/`equipmentPoolId`, every
 * Momentum-side column — is invisible here and must stay that way.
 *
 * PURE, with ZERO Convex imports of any kind, not even `import type`. Callers
 * project stored documents and mapper output into {@link SyncRow}s, which is
 * what lets the tests run in plain Node against the real legacy catalog files
 * in `tests/fixtures/legacy-pools/`.
 *
 * ⚠️ ORPHANED IS A REPORT, NOT AN INSTRUCTION. `momentumActivities.sourceActivityId`
 * is `v.id("activities")`, so hard-deleting a mirrored activity would dangle a
 * live reference inside a product people are using right now. Nothing in this
 * module emits a deletion and nothing downstream may infer one from an orphan.
 *
 * @module
 */

/** The four tables the mirror is allowed to touch. */
export type SyncLevel = "proposal" | "wbs" | "phase" | "activity";

/** What the differ concluded about one row. */
export type DiffVerdict = "insert" | "patch" | "unchanged" | "orphaned";

/** Why a whole tree was left alone. */
export type TreeSkipReason = "precision_owned" | "deleted_in_precision";

/**
 * A row on either side of the comparison, flattened to plain fields.
 *
 * Both a stored Convex document and a field-mapper result satisfy this, which
 * is the point: the differ never needs to know which side it is holding.
 */
export type SyncRow = { readonly [field: string]: unknown };

/**
 * Field names that exist only to carry a Firestore parent id between the fetch
 * and the mutation, and are destructured away before any write.
 *
 * One set covers all four levels because none of these names is a stored column
 * on any of the four tables — a per-level set would be four places to forget.
 *
 * ⚠️ Excluding them means a row whose PARENT moved in MCP reads as unchanged
 * unless the caller also supplies the resolved Convex parent id. See
 * {@link diffRow}.
 */
export const MIRROR_TRANSPORT_FIELDS: ReadonlySet<string> = new Set([
  "_fsId",
  "fsProposalId",
  "fsWbsId",
  "fsPhaseId",
]);

/**
 * The two fields the mirror is only allowed to move when the estimator re-picked
 * the item — see {@link changedMirroredFields} for the rule and why it lives here.
 */
export const CATALOG_LINK_FIELDS: readonly string[] = ["laborPoolId", "equipmentPoolId"];

/** One row's verdict, with the exact work it implies. */
export interface RowDiff {
  readonly level: SyncLevel;
  /** The Firestore document id both sides are keyed by. */
  readonly firestoreId: string;
  readonly verdict: DiffVerdict;
  /**
   * The minimal field subset to write. Empty for `unchanged` and `orphaned`;
   * the full comparable field set for `insert`; only what moved for `patch`.
   *
   * A key may be present with the value `undefined`, which means "clear this
   * field" — Firestore stopped supplying it and `ctx.db.patch` removes a field
   * given `undefined`.
   */
  readonly changed: Readonly<Record<string, unknown>>;
  /**
   * Fields that differed but were withheld by the catalog-link rule. Report
   * only — never write these.
   */
  readonly suppressed: readonly string[];
  /** The mapped row, when there is one (`insert`, `patch`, `unchanged`). */
  readonly incoming?: SyncRow;
  /** The stored row, when there is one (`patch`, `unchanged`, `orphaned`). */
  readonly existing?: SyncRow;
}

/**
 * Per-level tallies for the run report.
 *
 * `localOnly` and `duplicate` are not verdicts; they are the two ways a stored
 * row drops out of the comparison, counted rather than silently discarded so a
 * report can never present "we ignored 8,000 rows" as "nothing happened".
 */
export interface LevelCounts {
  readonly insert: number;
  readonly patch: number;
  readonly unchanged: number;
  readonly orphaned: number;
  /** Stored rows with no `firestoreId`: born in Precision, never mirrored. */
  readonly localOnly: number;
  /** Stored rows sharing a `firestoreId` with an earlier one. */
  readonly duplicate: number;
}

/** Every row of one level, sorted into the work it implies. */
export interface LevelDiff {
  readonly level: SyncLevel;
  /** Rows Firestore has that Convex does not. */
  readonly inserts: readonly RowDiff[];
  /** Rows whose mirrored content moved, each with its minimal field subset. */
  readonly patches: readonly RowDiff[];
  /**
   * Rows Convex mirrors that this Firestore read did not return — deleted in
   * MCP, or hidden by a partial read. ⚠️ REPORT ONLY: see the module note.
   */
  readonly orphans: readonly RowDiff[];
  readonly counts: LevelCounts;
}

/** The report's count roster: each level, plus the roll-up. */
export interface TreeCounts {
  readonly proposal: LevelCounts;
  readonly wbs: LevelCounts;
  readonly phase: LevelCounts;
  readonly activity: LevelCounts;
  readonly total: LevelCounts;
}

/** One proposal's tree as Firestore returned it and as Convex holds it. */
export interface ProposalTreeInput {
  readonly incoming: {
    /** `mapProposal` output. */
    readonly proposal: SyncRow;
    /** `mapWBS` output, each merged with its resolved `proposalId`. */
    readonly wbs: readonly SyncRow[];
    /** `mapPhase` output, each merged with its resolved `proposalId`/`wbsId`. */
    readonly phases: readonly SyncRow[];
    /** `mapActivity` output, each merged with its resolved parent ids. */
    readonly activities: readonly SyncRow[];
  };
  readonly existing: {
    /** `null` when this proposal has never been mirrored. */
    readonly proposal: SyncRow | null;
    readonly wbs: readonly SyncRow[];
    readonly phases: readonly SyncRow[];
    readonly activities: readonly SyncRow[];
  };
  /**
   * A `proposalTombstones` row exists for this proposal. Deletion in Precision
   * wins over the mirror, or re-inserting silently reverses it.
   */
  readonly deletedInPrecision?: boolean;
}

/** One proposal's decision, ready to hand to the writer. */
export interface TreeDiff {
  /** Non-null when the tree must be left entirely alone. */
  readonly skipped: TreeSkipReason | null;
  readonly proposal: LevelDiff;
  readonly wbs: LevelDiff;
  readonly phases: LevelDiff;
  readonly activities: LevelDiff;
  readonly counts: TreeCounts;
}

// ============================================================================
// Value comparison
// ============================================================================

/** Objects the mirror carries: `rates`, `labor`, `pipingSpec` and friends. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An object's keys with the explicitly-undefined ones dropped.
 *
 * Convex drops an undefined field on write and returns the key absent, while
 * the mappers emit the key with `undefined` — so counting raw keys would report
 * every nested optional as a difference for ever.
 */
function definedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter((key) => obj[key] !== undefined);
}

/**
 * Are these two mirrored values the same statement?
 *
 * NUMBERS ARE COMPARED EXACTLY, with no tolerance. Nothing in the path does
 * arithmetic — `num()` is `Number(v)` and `parseDate()` is `Date#getTime` — and
 * JSON is lossless for float64 in both directions, so a rate that round-trips
 * Firestore REST → Convex → back is bit-identical rather than merely close. An
 * epsilon would be wrong in the expensive direction: these constants multiply
 * across 352,969 rows, so a burden rate moving from 0.35 to 0.3500001 is an
 * edit an estimator made and the mirror owes them, not noise to swallow. That
 * leaves only the two IEEE-754 degenerates, handled by name instead of by
 * tolerance — `NaN` equals itself (or a row that ever acquired one rewrites on
 * every pass for ever) and `-0` equals `0` (already true of `===`, and wanted:
 * a sign-of-zero flip is the same number).
 *
 * ABSENT AND EXPLICITLY-UNDEFINED ARE THE SAME; `null` AND `""` ARE NOT.
 * The mappers emit `undefined` for every optional they decline to fill while
 * Convex returns the key absent, so folding those two is what stops the whole
 * estate rewriting itself. `null` is folded into neither: no mapper emits it
 * and no validator on these four tables accepts it, so a stored `null` is a
 * fault worth surfacing as a difference. `""` is a value, not an absence —
 * that is the takeoff lesson (`catalog.ts` has to translate a submitted empty
 * `takeoffUnit` into `undefined` precisely because `loadTakeoffCatalog` tests
 * `!== undefined`, and an empty string claims a takeoff the phase does not
 * have). `0` and `false` are likewise values.
 *
 * WHY NOT `JSON.stringify`: object key order is not guaranteed to survive a
 * round trip, so a stringify comparison reports changes that did not happen.
 * This is the same predicate `precision.ts`'s private `isSameValue` applies to
 * mutation arguments, reimplemented rather than shared because that one is
 * unexported, lives in a module full of Convex server imports this one may not
 * take, and lacks the `NaN` fold that a repeating batch job needs.
 */
export function isMirroredValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => isMirroredValueEqual(item, b[i]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const left = definedKeys(a);
    const right = definedKeys(b);
    return (
      left.length === right.length && left.every((key) => isMirroredValueEqual(a[key], b[key]))
    );
  }

  return false;
}

/**
 * The fields of `incoming` that are candidates for comparison: everything but
 * the transport keys the mutation destructures away.
 *
 * Driven by the incoming row's own keys rather than a hard-coded roster, so a
 * field added to a mapper enters the diff on the same commit instead of being
 * silently un-mirrored until somebody notices.
 */
function comparableKeys(incoming: SyncRow): string[] {
  return Object.keys(incoming).filter((key) => !MIRROR_TRANSPORT_FIELDS.has(key));
}

/**
 * What actually has to be written for one row, and what was withheld.
 *
 * THE CATALOG-LINK RULE LIVES HERE, not in the mutation, because this is where
 * the next person looking at "why did this row not update" will read. An
 * activity's `laborPoolId`/`equipmentPoolId` is DERIVED, not mirrored: legacy's
 * catalogs were edited in place for three years with rows inserted mid-list, so
 * Firestore's stored id means whatever the list said the day the line was
 * written, and 8,944 links were re-pointed at the item each line actually
 * describes on 2026-08-05. Firestore still holds the stale ids. Mirroring them
 * back would undo that repair, for ever, at the next tick.
 *
 * The one exception is a changed description: the estimator re-picked, so the
 * incoming id is the current list's — which is the list this deployment's rate
 * books were built from. Identical rule to `syncMutations.upsertProposalHierarchy`.
 *
 * Suppression happens BEFORE the verdict, which is the point: without it every
 * repaired activity patches on every pass and never settles.
 */
export function changedMirroredFields(
  level: SyncLevel,
  incoming: SyncRow,
  existing: SyncRow
): { changed: Record<string, unknown>; suppressed: string[] } {
  const differing = comparableKeys(incoming).filter(
    (key) => !isMirroredValueEqual(existing[key], incoming[key])
  );

  const rePicked = differing.includes("description");
  const suppressed =
    level === "activity" && !rePicked
      ? differing.filter((key) => CATALOG_LINK_FIELDS.includes(key))
      : [];

  const changed: Record<string, unknown> = {};
  for (const key of differing) {
    if (suppressed.includes(key)) continue;
    changed[key] = incoming[key];
  }
  return { changed, suppressed };
}

/** Every comparable field of a row, for the insert case where all of it is new. */
function fieldsToInsert(incoming: SyncRow): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of comparableKeys(incoming)) fields[key] = incoming[key];
  return fields;
}

// ============================================================================
// Row and level diffs
// ============================================================================

/** A row's `firestoreId`, or `null` when it was never mirrored. */
function mirrorKey(row: SyncRow): string | null {
  return typeof row.firestoreId === "string" ? row.firestoreId : null;
}

/**
 * Decide one row.
 *
 * `incoming` must be exactly the object the caller intends to write: mapper
 * output merged with the parent ids the caller resolved (`proposalId`,
 * `wbsId`, `phaseId`). Those are stored columns the mappers cannot produce,
 * because only the caller holds the firestoreId → Convex id maps — and leaving
 * them out means an activity moved to a different phase in MCP reads as
 * UNCHANGED and never moves in the mirror.
 */
export function diffRow(level: SyncLevel, incoming: SyncRow, existing: SyncRow | null): RowDiff {
  const firestoreId = mirrorKey(incoming) ?? "";

  if (!existing) {
    return {
      level,
      firestoreId,
      verdict: "insert",
      changed: fieldsToInsert(incoming),
      suppressed: [],
      incoming,
    };
  }

  const { changed, suppressed } = changedMirroredFields(level, incoming, existing);
  return {
    level,
    firestoreId,
    verdict: Object.keys(changed).length > 0 ? "patch" : "unchanged",
    changed,
    suppressed,
    incoming,
    existing,
  };
}

/** A zeroed tally, for accumulating or for a level with nothing in it. */
export function emptyLevelCounts(): LevelCounts {
  return { insert: 0, patch: 0, unchanged: 0, orphaned: 0, localOnly: 0, duplicate: 0 };
}

/** Add tallies together, for the tree roll-up and for whole-run reports. */
export function sumLevelCounts(...parts: readonly LevelCounts[]): LevelCounts {
  return parts.reduce<LevelCounts>(
    (acc, part) => ({
      insert: acc.insert + part.insert,
      patch: acc.patch + part.patch,
      unchanged: acc.unchanged + part.unchanged,
      orphaned: acc.orphaned + part.orphaned,
      localOnly: acc.localOnly + part.localOnly,
      duplicate: acc.duplicate + part.duplicate,
    }),
    emptyLevelCounts()
  );
}

/**
 * Decide every row of one level.
 *
 * Stored rows are keyed first-wins on `firestoreId`, matching the mutation's
 * `.first()` lookup, so a duplicate is counted rather than reported as deleted
 * upstream — nobody should be handed "8,000 rows vanished from MCP" when the
 * truth is that Convex holds two copies of each.
 */
export function diffLevel(
  level: SyncLevel,
  incoming: readonly SyncRow[],
  existing: readonly SyncRow[]
): LevelDiff {
  const inserts: RowDiff[] = [];
  const patches: RowDiff[] = [];
  const orphans: RowDiff[] = [];
  let unchanged = 0;
  let localOnly = 0;
  let duplicate = 0;

  const storedById = new Map<string, SyncRow>();
  for (const row of existing) {
    const key = mirrorKey(row);
    if (key === null) {
      localOnly++;
    } else if (storedById.has(key)) {
      duplicate++;
    } else {
      storedById.set(key, row);
    }
  }

  const matched = new Set<string>();
  for (const row of incoming) {
    const key = mirrorKey(row) ?? "";
    const stored = storedById.get(key);
    if (stored) matched.add(key);
    const diff = diffRow(level, row, stored ?? null);
    if (diff.verdict === "insert") inserts.push(diff);
    else if (diff.verdict === "patch") patches.push(diff);
    else unchanged++;
  }

  for (const [key, row] of storedById) {
    if (matched.has(key)) continue;
    orphans.push({
      level,
      firestoreId: key,
      verdict: "orphaned",
      changed: {},
      suppressed: [],
      existing: row,
    });
  }

  return {
    level,
    inserts,
    patches,
    orphans,
    counts: {
      insert: inserts.length,
      patch: patches.length,
      unchanged,
      orphaned: orphans.length,
      localOnly,
      duplicate,
    },
  };
}

// ============================================================================
// Tree diff
// ============================================================================

/** A level with nothing in it, for a tree that is being skipped wholesale. */
function emptyLevelDiff(level: SyncLevel): LevelDiff {
  return { level, inserts: [], patches: [], orphans: [], counts: emptyLevelCounts() };
}

/**
 * Decide one proposal's whole tree.
 *
 * TWO TREES ARE NEVER TOUCHED, and both checks are here rather than only in the
 * writing mutation so that a differential sync cannot re-introduce the failure
 * they exist to prevent:
 *
 *   - `precisionOwnedAt` set — Precision has taken this estimate over, and the
 *     mirror patches blindly. Before the stamp existed, the cron reverted
 *     proposal metadata and all 15 rates and creating a Momentum project
 *     reverted the tree, so estimator work vanished with no error and no
 *     warning (DECISIONS.md D1). Copy-on-write, permanent.
 *   - deleted in Precision — the estimate still exists upstream, so re-inserting
 *     it silently reverses a deliberate deletion. Deletion wins.
 *
 * A skipped tree reports zero of everything, so a run report cannot present a
 * skip as work done.
 */
export function diffProposalTree(input: ProposalTreeInput): TreeDiff {
  const { incoming, existing } = input;
  const owned = existing.proposal?.precisionOwnedAt !== undefined;
  const skipped: TreeSkipReason | null = owned
    ? "precision_owned"
    : input.deletedInPrecision === true
      ? "deleted_in_precision"
      : null;

  if (skipped !== null) {
    const empty = emptyLevelCounts();
    return {
      skipped,
      proposal: emptyLevelDiff("proposal"),
      wbs: emptyLevelDiff("wbs"),
      phases: emptyLevelDiff("phase"),
      activities: emptyLevelDiff("activity"),
      counts: { proposal: empty, wbs: empty, phase: empty, activity: empty, total: empty },
    };
  }

  const proposal = diffLevel(
    "proposal",
    [incoming.proposal],
    existing.proposal ? [existing.proposal] : []
  );
  const wbs = diffLevel("wbs", incoming.wbs, existing.wbs);
  const phases = diffLevel("phase", incoming.phases, existing.phases);
  const activities = diffLevel("activity", incoming.activities, existing.activities);

  return {
    skipped: null,
    proposal,
    wbs,
    phases,
    activities,
    counts: {
      proposal: proposal.counts,
      wbs: wbs.counts,
      phase: phases.counts,
      activity: activities.counts,
      total: sumLevelCounts(proposal.counts, wbs.counts, phases.counts, activities.counts),
    },
  };
}

/**
 * Does this tree need a mutation at all?
 *
 * The differential's entire return is the calls it does NOT make, so the caller
 * is expected to branch on this before opening a write transaction. Orphans do
 * not count as work: nothing may be deleted.
 */
export function treeHasWork(diff: TreeDiff): boolean {
  const { total } = diff.counts;
  return total.insert > 0 || total.patch > 0;
}
