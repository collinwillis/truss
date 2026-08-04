/**
 * Matching a spreadsheet row to a catalog item.
 *
 * THE PROBLEM THIS EXISTS FOR, measured rather than imagined. InDemand's
 * catalog ids were row positions in a spreadsheet, so inserting a row silently
 * re-pointed every id below it at a different item. Across the single real
 * version bump (v1 -> v2) that produced:
 *
 *   labor      1,064 of 5,968 rows carrying their payload at a different id,
 *              in three contiguous bands at offsets -4, -455 and +8
 *   equipment  only 3 of 129 descriptions surviving at their own id
 *
 * None of it was ever noticed, because an id that points at the wrong item
 * still resolves. The estimates that used it would simply have been priced
 * against someone else's numbers.
 *
 * So: THE ID COLUMN IN A FILE IS NEVER AUTHORITATIVE. Every row is matched by
 * what it says it is — a natural key, corroborated by its values — and if that
 * match disagrees with the id in the file, the row is a blocking conflict at
 * any confidence. A human decides.
 *
 * Pure and dependency-free, like `costEngine.ts`, so it can be tested in plain
 * Node against the two real JSON files it was calibrated on.
 */

export type PoolKind = "wbs" | "phases" | "labor" | "equipment";

/**
 * Normalize a description into a comparison key.
 *
 * ⚠️ DELIBERATELY CONSERVATIVE, AND THE PUNCTUATION IS LOAD-BEARING. `≤` and
 * `≥` carry the pipe-size distinction across 509 labor rows, so the obvious
 * "strip all punctuation" version collapses `FSW - ≤.75` and `FSW - ≥.75`
 * into one key — 28 self-collisions inside labor v1 alone. This normalizer
 * produces ZERO collisions across all 5,897 v1 and all 5,968 v2 labor rows and
 * both equipment files, and `rateBookMatch.test.ts` asserts exactly that.
 * Do not "improve" it without re-running those tests.
 */
export function normalizeKey(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toUpperCase()
      // Every dash Excel might produce collapses to one. Autocorrect silently
      // turns " - " into " – " as you type, which would otherwise make an
      // untouched row look like a different item on the next round trip.
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/≤+/g, "<=")
      .replace(/≥+/g, ">=")
      .replace(/[^A-Z0-9<>=./"#+-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** A catalog item as the matcher sees it, from either side of a comparison. */
export interface MatchCandidate {
  poolId: number;
  description: string;
  /** Labor items are scoped to a phase; equipment and WBS are global. */
  parentPoolId?: number;
  /** The values that must travel with the name for a match to corroborate. */
  payload: Readonly<Record<string, string | number>>;
}

/**
 * The natural key for an item.
 *
 * Scoped by parent where a parent exists: two phases under different WBS may
 * legitimately share a name, and a labor line's meaning depends on the phase
 * it sits in.
 */
export function naturalKey(item: Pick<MatchCandidate, "description" | "parentPoolId">): string {
  const description = normalizeKey(item.description);
  return item.parentPoolId === undefined ? description : `${item.parentPoolId}|${description}`;
}

/** Exact equality over the value fingerprint — the corroborating signal. */
export function payloadsMatch(
  a: Readonly<Record<string, string | number>>,
  b: Readonly<Record<string, string | number>>
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export type MatchMethod = "explicit_id" | "natural_key" | "payload" | "none";

export interface MatchResult {
  /** The item this row resolves to, or null when it is genuinely new. */
  matched: MatchCandidate | null;
  method: MatchMethod;
  /**
   * The row must not be applied without a human decision.
   *
   * Set whenever the evidence disagrees with itself — most importantly when
   * the match lands on an id other than the one written in the file, which is
   * precisely what a shifted spreadsheet looks like.
   */
  blocking: boolean;
  reason?: string;
}

export interface MatchIndex {
  byId: ReadonlyMap<number, MatchCandidate>;
  byNaturalKey: ReadonlyMap<string, MatchCandidate>;
  /** Payload fingerprint -> items. Built once; never a whole-pool scan. */
  byPayload: ReadonlyMap<string, readonly MatchCandidate[]>;
}

function payloadFingerprint(payload: Readonly<Record<string, string | number>>): string {
  return Object.keys(payload)
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join("");
}

/** Index one book's items for matching. Built once per import, in an action. */
export function buildMatchIndex(items: readonly MatchCandidate[]): MatchIndex {
  const byId = new Map<number, MatchCandidate>();
  const byNaturalKey = new Map<string, MatchCandidate>();
  const byPayload = new Map<string, MatchCandidate[]>();
  for (const item of items) {
    byId.set(item.poolId, item);
    // First writer wins: `assertNoKeyCollisions` guarantees there is no
    // second, and a silent overwrite here would hide that guarantee failing.
    const key = naturalKey(item);
    if (!byNaturalKey.has(key)) byNaturalKey.set(key, item);
    const fingerprint = payloadFingerprint(item.payload);
    const bucket = byPayload.get(fingerprint);
    if (bucket) bucket.push(item);
    else byPayload.set(fingerprint, [item]);
  }
  return { byId, byNaturalKey, byPayload };
}

/**
 * Every natural key that is not unique within a set.
 *
 * Run over a book before it can be a match target: the matcher's whole
 * premise is that a name plus a parent identifies one item, and this is the
 * assertion of that premise rather than a hope about it.
 */
export function findKeyCollisions(items: readonly MatchCandidate[]): string[] {
  const seen = new Map<string, number>();
  const collisions: string[] = [];
  for (const item of items) {
    const key = naturalKey(item);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) collisions.push(key);
  }
  return collisions;
}

/**
 * Resolve one incoming row against an existing book.
 *
 * The order is the point:
 *
 *  1. A natural-key hit is the answer, BUT if the file also carried an id and
 *     that id is not this item's, the row blocks. This is the barrier that
 *     catches a shifted sheet, an Excel fill-down, and a hand-typed id — 1,064
 *     times on the real labor file.
 *  2. Failing that, an exact payload match with a changed name is a possible
 *     RENAME, which no algorithm can distinguish from a shift. It blocks.
 *  3. An id with no corroboration at all cannot be trusted to mean what it
 *     says, so it blocks rather than silently overwriting an item.
 *  4. Nothing matched: genuinely new. Mint a fresh id — never at the id the
 *     file asked for, because caller-chosen ids are how ids get re-pointed.
 */
export function matchRow(
  row: MatchCandidate & { declaredId?: number },
  index: MatchIndex
): MatchResult {
  const declared = row.declaredId;
  const byKey = index.byNaturalKey.get(naturalKey(row));

  if (byKey) {
    if (declared !== undefined && declared !== byKey.poolId) {
      return {
        matched: byKey,
        method: "natural_key",
        blocking: true,
        reason: `The file gives this row id ${declared}, but "${row.description}" is id ${byKey.poolId}. One of them is wrong, and applying either silently would re-point an id that estimates already use.`,
      };
    }
    return {
      matched: byKey,
      method: declared === undefined ? "natural_key" : "explicit_id",
      blocking: false,
    };
  }

  const sameName = declared !== undefined ? index.byId.get(declared) : undefined;
  const byPayload = index.byPayload.get(payloadFingerprint(row.payload)) ?? [];

  if (sameName && payloadsMatch(sameName.payload, row.payload)) {
    return {
      matched: sameName,
      method: "explicit_id",
      blocking: true,
      reason: `Id ${declared} is "${sameName.description}" but the file calls it "${row.description}". If it was renamed, confirm it; if the rows moved, this id belongs to a different item.`,
    };
  }

  if (byPayload.length === 1 && byPayload[0]) {
    const candidate = byPayload[0];
    return {
      matched: candidate,
      method: "payload",
      blocking: true,
      reason: `These values exactly match id ${candidate.poolId} "${candidate.description}". This is either a rename or a shifted row, and the two are indistinguishable without a human.`,
    };
  }

  if (sameName) {
    return {
      matched: sameName,
      method: "explicit_id",
      blocking: true,
      reason: `Id ${declared} currently means "${sameName.description}" with different values. Nothing in the file corroborates that this is the same item.`,
    };
  }

  return { matched: null, method: "none", blocking: false };
}
