/**
 * Working out what the next revision of a proposal should be called.
 *
 * Creating a revision by hand is InDemand's single most repeated action: 98
 * revision families account for 332 of 731 proposals, and one family runs to
 * 22 members. But there is no single naming scheme to automate — measured
 * across those families, the number suffix appears as `.01`, `.3`, `.R1`,
 * `.CO1` and `.CO1NR`, and zero-padding splits almost evenly (112 padded vs
 * 106 plain). Family 1602 alone runs `1602`, `1602.3`, `1602.04`, `1602.05`
 * with descriptions reading `(Rev #3)`, `(Rev #4)`, then `(R5)`.
 *
 * So nothing here imposes a house style. Every answer is derived from the
 * FAMILY the proposal already belongs to, and the result is a suggestion the
 * estimator confirms — which is why {@link deriveRevision} returns a proposal
 * rather than performing one.
 */

/** A proposal number split at the boundary between family and revision. */
export interface ParsedNumber {
  base: string;
  suffix: string;
}

export function parseNumber(raw: string): ParsedNumber | null {
  const match = /^\s*(\d+)(.*)$/.exec(raw ?? "");
  if (!match?.[1]) return null;
  return { base: match[1], suffix: (match[2] ?? "").trim() };
}

/**
 * A suffix this module is willing to increment.
 *
 * Deliberately strict: `.01`, `.3`, `.R1`, `.CO1`, `.CO1NR` all qualify, but
 * ` - 50% FACTOR (SHARED SAVINGS)` does not. Without the anchor, that suffix's
 * "50" would read as a revision number and the next proposal would be called
 * "51% FACTOR" — a wrong answer offered confidently.
 */
const INCREMENTABLE = /^\.(\D*)(\d+)(\D*)$/;

/** The dominant shape of a family's FIRST revision — 42 families to 32. */
const FIRST_REVISION_SUFFIX = ".01";

interface SuffixTemplate {
  lead: string;
  digits: string;
  trail: string;
  value: number;
}

/** Same revision series — case-insensitive, so `.R3` and `.r3NR` still pair. */
function sameSequence(a: SuffixTemplate, b: SuffixTemplate): boolean {
  return (
    a.lead.toLowerCase() === b.lead.toLowerCase() && a.trail.toLowerCase() === b.trail.toLowerCase()
  );
}

/**
 * Which of two templates should set the pattern.
 *
 * Higher number wins. ON A TIE THE PADDED ONE WINS, and that tie is real:
 * a family holding both `1956.01` and `1956.1` has two members of value 1.
 * Deciding by array position would let Convex's document order choose the
 * suggestion, so the same right-click could propose `.02` or `.2` depending
 * on which page load you were on.
 */
function betterTemplate(candidate: SuffixTemplate, current: SuffixTemplate): boolean {
  if (candidate.value !== current.value) return candidate.value > current.value;
  return candidate.digits.length > current.digits.length;
}

function parseSuffix(suffix: string): SuffixTemplate | null {
  const m = INCREMENTABLE.exec(suffix);
  if (!m) return null;
  return { lead: m[1] ?? "", digits: m[2] ?? "", trail: m[3] ?? "", value: Number(m[2]) };
}

/**
 * The next number for a revision of `sourceNumber`.
 *
 * `family` is every proposal number sharing the same base, the source
 * included. The highest incrementable suffix in it becomes the template, so
 * the answer inherits the family's own prefix and zero-padding: a family
 * ending `.05` yields `.06`, one ending `.R2` yields `.R3`. A family that has
 * never been revised gets `.01`.
 */
export function deriveRevisionNumber(sourceNumber: string, family: readonly string[]): string {
  const parsed = parseNumber(sourceNumber);
  if (!parsed) return sourceNumber;

  /**
   * ⚠️ A FAMILY CAN RUN SEVERAL SEQUENCES AT ONCE, and they must not be
   * compared by magnitude. Proposal 2049 holds `.R1`–`.R3` alongside `.CO1`–
   * `.CO12`; 2068 and 2055 do the same, 25 proposals in all. Taking the
   * family's global maximum meant revising `2049.R3` proposed `2049.CO13` —
   * filing a revision into the change-order sequence, jumping the counter
   * from 3 to 13, and burning the number the next real change order needs.
   * Only members sharing the SOURCE's own lead and trail are candidates.
   *
   * A source with no incrementable suffix of its own has no sequence to stay
   * in, so there every member counts and the family maximum wins — which is
   * what keeps right-clicking a bare original off a number already taken.
   */
  const own = parseSuffix(parsed.suffix);
  let best: SuffixTemplate | null = null;
  for (const member of family) {
    const memberParsed = parseNumber(member);
    if (!memberParsed || memberParsed.base !== parsed.base) continue;
    const template = parseSuffix(memberParsed.suffix);
    if (!template) continue;
    if (own && !sameSequence(template, own)) continue;
    if (!best || betterTemplate(template, best)) best = template;
  }

  best ??= own;
  if (!best) return `${parsed.base}${FIRST_REVISION_SUFFIX}`;

  const next = String(best.value + 1);
  // Match the template's width only when it was actually zero-padded, so a
  // family writing `.3` gets `.4` rather than `.04`.
  const padded =
    best.digits.length > 1 && best.digits.startsWith("0")
      ? next.padStart(best.digits.length, "0")
      : next;
  return `${parsed.base}.${best.lead}${padded}${best.trail}`;
}

/**
 * Revision markers seen in the wild, most common first.
 *
 * `(R5)` leads at 50 occurrences, then the `(Rev. 4)` family at 47 across six
 * spellings. Each pattern captures the number so the marker can be rewritten
 * in the family's own hand rather than normalised to one house style.
 */
const MARKER_PATTERNS: RegExp[] = [
  /\(\s*R\s*(\d+)\s*\)\s*$/i,
  /\(\s*REV\.?\s*#?\s*(\d+)\s*\)\s*$/i,
  /-\s*R\s*(\d+)\s*$/i,
];

interface MarkerMatch {
  /** The full marker text, e.g. "(Rev. 4)". */
  text: string;
  value: number;
  /** Where the marker starts, so it can be stripped. */
  index: number;
}

function findMarker(description: string): MarkerMatch | null {
  for (const pattern of MARKER_PATTERNS) {
    const m = pattern.exec(description);
    if (m?.[1]) return { text: m[0], value: Number(m[1]), index: m.index };
  }
  return null;
}

/** Strip a trailing revision marker, leaving the name of the work. */
export function stripMarker(description: string): string {
  const marker = findMarker(description);
  return (marker ? description.slice(0, marker.index) : description).trimEnd();
}

/**
 * The description for the new revision.
 *
 * If the family marks its revisions, the marker continues in that family's
 * exact spelling — `(Rev #4)` begets `(Rev #5)`, `(R5)` begets `(R6)`. If it
 * does not, the description is returned untouched: roughly half of all real
 * revisions carry no marker at all, so adding one would impose a convention
 * on the families that have never used it.
 */
export function deriveRevisionDescription(
  sourceDescription: string,
  family: readonly string[],
  nextValue: number
): string {
  let best: MarkerMatch | null = null;
  for (const description of family) {
    const marker = findMarker(description);
    if (!marker) continue;
    if (!best || marker.value >= best.value) best = marker;
  }
  if (!best) return sourceDescription;

  // Rewrite the winning marker's own text with the new number, so spelling,
  // spacing, capitalisation and punctuation all survive.
  /**
   * The marker counts up on its own, never from the number alone.
   *
   * The two series can be out of step — a family may mark its ORIGINAL
   * "(Rev. 2)" while its first numbered revision is only `.01`. Taking the
   * number's value would then rewrite the marker BACKWARDS, to "(Rev. 1)".
   * Measured over the live log, 34 of 133 marked proposals moved backwards or
   * not at all. Whichever series is further along decides.
   */
  const markerNumber = Math.max(nextValue, best.value + 1);
  const nextMarker = best.text.replace(/\d+/, String(markerNumber));
  const stem = stripMarker(sourceDescription);
  return `${stem} ${nextMarker.trim()}`;
}

export interface FamilyMember {
  proposalNumber: string;
  description: string;
}

export interface RevisionProposal {
  proposalNumber: string;
  description: string;
  /** True when something else already carries this number — 24 numbers do. */
  collides: boolean;
}

/**
 * Everything the Create Revision dialog needs, derived from the family.
 *
 * `allProposals` is the whole log; the family is selected here so callers
 * cannot accidentally pass a partial one and get a number that collides.
 */
export function deriveRevision(
  source: FamilyMember,
  allProposals: readonly FamilyMember[]
): RevisionProposal {
  const parsed = parseNumber(source.proposalNumber);
  const family = parsed
    ? allProposals.filter((p) => parseNumber(p.proposalNumber)?.base === parsed.base)
    : [source];

  const proposalNumber = deriveRevisionNumber(
    source.proposalNumber,
    family.map((p) => p.proposalNumber)
  );
  const nextValue = parseSuffix(parseNumber(proposalNumber)?.suffix ?? "")?.value ?? 1;
  const description = deriveRevisionDescription(
    source.description,
    family.map((p) => p.description),
    nextValue
  );

  const taken = new Set(allProposals.map((p) => p.proposalNumber.trim()));
  return { proposalNumber, description, collides: taken.has(proposalNumber.trim()) };
}
