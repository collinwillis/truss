/**
 * Sorting the proposal log.
 *
 * Proposal numbers are not numbers. Measured across the 731 live proposals,
 * the suffix takes at least nine shapes: `.01` (125 rows), `.2` (56), `.R1`,
 * `.CO1`, `.CO1NR`, `.LA`, `.03.02`, and free text like
 * `2082 - 50% FACTOR (SHARED SAVINGS)`. Two carry an empty string.
 */

/** A number split into the part that sorts numerically and the rest. */
interface ParsedNumber {
  base: number;
  suffix: string;
}

function parseProposalNumber(raw: string): ParsedNumber | null {
  const trimmed = raw.trim();
  const match = /^(\d+)(.*)$/.exec(trimmed);
  if (!match?.[1]) return null;
  return { base: Number(match[1]), suffix: match[2] ?? "" };
}

/**
 * Order two proposal numbers the way an estimator reads them.
 *
 * ⚠️ THE SUFFIX IS COMPARED AS A STRING, NEVER PARSED AS A NUMBER. Both `.01`
 * and `.1` forms exist in volume, so `Number(".01") === Number(".1")` would
 * collide `1956.01` with `1956.1` — two different proposals. `localeCompare`
 * with `numeric` still orders `.2` before `.10` without inventing that
 * equivalence, and handles `.LA` and `.CO1NR` for free.
 *
 * This also fixes a real defect in the screen it replaces, which sorted on
 * `parseFloat(proposalNumber)`: `parseFloat("2112.R1")` is `2112`, so a
 * proposal and every one of its revisions compared EQUAL and landed in
 * whatever order the sort happened to leave them.
 *
 * Unparseable and empty numbers sort last in BOTH directions — they are
 * missing data, and missing data is not "smallest".
 */
export function compareProposalNumbers(a: string, b: string): number {
  const pa = parseProposalNumber(a);
  const pb = parseProposalNumber(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  if (pa.base !== pb.base) return pa.base - pb.base;
  const bySuffix = pa.suffix.localeCompare(pb.suffix, undefined, { numeric: true });
  // ⚠️ NUMERIC COLLATION ALONE STILL COLLIDES. It parses each digit run as an
  // integer, so `.01` and `.1` compare EQUAL — the very collision the note
  // above says to avoid, reintroduced by the collator rather than by
  // `Number()`. Verified in both V8 and JavaScriptCore (the engine the Tauri
  // build actually runs). A plain compare separates them, and because it only
  // runs on the tie, `.2` still precedes `.10`.
  return bySuffix !== 0 ? bySuffix : pa.suffix.localeCompare(pb.suffix);
}

/** The base number, for grouping a revision under the proposal it revises. */
export function proposalBase(raw: string): number | null {
  return parseProposalNumber(raw)?.base ?? null;
}

/** The `.01` / `.R1` tail, rendered quieter than the base it modifies. */
export function proposalSuffix(raw: string): string {
  return parseProposalNumber(raw)?.suffix ?? "";
}

/**
 * Order two dates.
 *
 * ⚠️ MISSING VALUES ARE NOT HANDLED HERE, DELIBERATELY. TanStack multiplies a
 * custom `sortingFn`'s result by −1 for a descending sort, so a "return +1 for
 * null" rule inverts with the direction and parks unknowns at the TOP of a
 * descending list. The only direction-independent hook is `sortUndefined`,
 * which the framework applies BEFORE that flip — so each column's accessor
 * returns `undefined` for a missing value and declares `sortUndefined: "last"`,
 * and these comparators only ever see values that exist.
 */
export function compareNullableNumbers(a: number, b: number): number {
  return a - b;
}

/** Case-insensitive text order. Missing values: see the note above. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
