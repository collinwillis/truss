/**
 * String manipulation and formatting functions.
 */

/**
 * Capitalize first letter of a string.
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert string to title case.
 */
export function titleCase(str: string): string {
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => capitalize(word))
    .join(" ");
}

/** Words that stay lowercase inside a title, but not at its start. */
const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "via",
  "vs",
  "with",
]);

/**
 * Whether a token carries meaning in its exact casing and must not be touched.
 *
 * Industrial estimate text is full of these — equipment tags (`CP-009B`,
 * `TK-9963`), unit numbers (`U1`, `5500`), revision markers (`(R1)`), and
 * short acronyms (`PGS`, `ASU`, `ADM`, `WWT`, `BEPC`, `D&E`). Title-casing
 * them produces `Cp-009b` and `D&e`, which reads as a bug.
 *
 * The length bound is deliberate: it keeps genuine acronyms fixed while
 * letting SHOUTED WORDS like `REPLACE` or `CONSTRUCTION` come back down.
 */
function isFixedToken(token: string): boolean {
  const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!core) return true;
  // Equipment tags and unit numbers: CP-009B, TK-9963, U1, 5500, (R1).
  if (/\d/.test(core)) return true;
  // Ampersand forms are compounds, not words: D&E, R&D.
  if (core.includes("&")) return true;
  // Deliberate internal capitals are somebody's spelling: SpaceX, McDermott.
  if (/\p{Ll}\p{Lu}/u.test(core)) return true;
  // Short all-caps runs are acronyms: PGS, ASU, ADM, BEPC.
  return core.length <= 4 && core === core.toUpperCase() && /\p{Lu}/u.test(core);
}

/**
 * Capitalize a run, including after inner hyphens and slashes.
 *
 * The leading match skips any opening punctuation, so "(extraction)" becomes
 * "(Extraction)" rather than being left alone because its first character is
 * a bracket.
 */
function capitalizeParts(word: string): string {
  return word
    .replace(/(^[^\p{L}]*|[-/])(\p{L})/u, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/([-/])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Normalize human-entered text for display, whatever case it was typed in.
 *
 * The same client appears as `cargill`, `MARATHON` and `Basin Electric`
 * across one dataset — 115 of 731 records are fully upper-case and 29 fully
 * lower-case — so a list of them reads as noise until they agree. This makes
 * them agree WITHOUT destroying the tokens whose casing is information; see
 * {@link isFixedToken}.
 *
 * Display-only: it never changes what is stored, so a value typed by a person
 * is still theirs to correct.
 */
export function displayCase(str: string): string {
  const words = str.trim().split(/\s+/);
  return words
    .map((word, index) => {
      if (isFixedToken(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && MINOR_WORDS.has(lower.replace(/[^\p{L}]/gu, ""))) return lower;
      return capitalizeParts(lower);
    })
    .join(" ");
}

/**
 * Truncate string with ellipsis.
 */
export function truncate(str: string, maxLength: number, suffix = "..."): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Convert string to slug format.
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Remove extra whitespace.
 */
export function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Check if string is empty or only whitespace.
 */
export function isEmpty(str: string | null | undefined): boolean {
  return !str || str.trim().length === 0;
}

/**
 * Generate random string.
 */
export function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Mask sensitive string.
 */
export function mask(str: string, visibleChars = 4, maskChar = "*"): string {
  if (str.length <= visibleChars) return str;
  const visible = str.slice(-visibleChars);
  const masked = maskChar.repeat(str.length - visibleChars);
  return masked + visible;
}

/**
 * Extract initials from name.
 */
export function getInitials(name: string, maxLength = 2): string {
  return name
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase())
    .slice(0, maxLength)
    .join("");
}
