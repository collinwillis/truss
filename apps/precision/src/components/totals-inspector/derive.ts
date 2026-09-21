/**
 * What the totals panel prints, decided once and away from React.
 *
 * WHY A VIEW MODEL. The panel is mostly arithmetic with rules attached: a share
 * needs a whole that is not zero, a unit rate needs a takeoff that exists, a
 * line worth nothing is not drawn. Rules like those go wrong quietly inside JSX,
 * and a panel an estimator checks a bid against cannot be wrong quietly. Here
 * every rule is a plain function of plain numbers, so the test file beside this
 * one can state each of them.
 *
 * ⚠️ FEWER NUMBERS, ON PURPOSE. The version before this one printed about
 * twenty-two figures at one weight, with a percentage beside most of them, and
 * the owner's verdict was "almost more confusing now". A reader could not tell
 * which numbers mattered, and two of them disagreed about what share of the job
 * was indirect (11.0% of all hours, 12.3% of direct hours: both right, one too
 * many). So the panel answers three questions and stops: what does this cost,
 * where does the money go, how many hours is it. Everything else an estimator
 * reviews a bid by is one click away under "More detail", which is how the
 * legacy app they came from did it: five figures showing, the rest on request.
 *
 * ⚠️ `null` MEANS THERE IS NO ANSWER, never zero: no hours to divide by, no
 * takeoff to measure against. Every ratio returns `null` rather than `0`, `NaN`
 * or `Infinity`, and the panel leaves the sentence out instead of printing it.
 *
 * @module
 */

/** The cost fields a scope must provide — matches the rollup queries. */
export interface ScopeCosts {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

/**
 * The estimate-wide fields the panel reads from `getProposalSummary`.
 *
 * The last five are optional on purpose: they arrived with a backend change, and
 * a panel talking to a backend that has not been deployed yet must print less,
 * not break.
 */
export interface EstimateSummary extends ScopeCosts {
  totalHours: number;
  directHours: number;
  indirectHours: number;
  wbsCount: number;
  phaseCount: number;
  activityCount: number;
  completedPhaseCount?: number;
  indirectHoursByKind?: { mobilization: number; support: number; specialty: number };
  hiddenWbsCount?: number;
  hiddenCost?: number;
}

/** How deep the screen showing the panel is. */
export type TotalsDepth = "estimate" | "wbs" | "phase";

/**
 * The scope's measured quantity, or why it has none.
 *
 * `pending` is its own state so the panel can tell "still resolving" (print
 * nothing yet) from "this phase type is not measured" (say so).
 */
export type TakeoffState =
  | {
      kind: "measured";
      quantity: number;
      unit: string;
      isOverridden: boolean;
      /**
       * At breakdown depth: phases of a MEASURED type that carry cost or hours
       * and state no quantity. Their cost is in the numerator of the per-unit
       * rates and their footage is missing from the denominator, so the rates
       * read high and the panel says why. Phases of a type with no takeoff at
       * all are not counted: their cost belongs in an all-in rate.
       */
      unquantifiedPhases?: number;
    }
  | { kind: "none" }
  | { kind: "mixed" }
  | { kind: "pending" };

/** How a figure is formatted, spoken and copied. */
export type FigureKind = "money" | "hours" | "rate" | "hoursPerUnit" | "percent";

/** The five places money goes, in the order the panel lists them. */
export type CostKey = "labor" | "material" | "equipment" | "subcontractor" | "costOnly";

/** One line of "where the money goes". Lines worth nothing are not in the list. */
export interface CostLine {
  id: CostKey;
  label: string;
  value: number;
  /** Fraction of the scope's total, or `null` when there is no total to share. */
  share: number | null;
  /** The share as printed. Decided for the LIST, so the column adds up. See {@link formatShares}. */
  percentText: string | null;
}

/** One segment of the proportion bar. Fractions sum to 1. */
export interface BarSegment {
  id: CostKey;
  fraction: number;
}

/**
 * One line of the hours list. The two lines are the split by TRADE and they sum
 * to the scope's hours, the way the cost lines above them sum to its total.
 */
export interface HoursLine {
  id: "craft" | "weld";
  label: string;
  value: number;
}

/** One line under "More detail". Only lines with something to say are listed. */
export interface DetailLine {
  id: string;
  label: string;
  kind: FigureKind;
  value: number;
}

/** The scope's measured quantity and what each unit of it costs. */
export interface TakeoffView {
  quantity: number;
  unit: string;
  /** Somebody typed the quantity rather than letting the lines add up to it. */
  isOverridden: boolean;
  hoursPerUnit: number | null;
  costPerUnit: number | null;
}

/** Everything the panel prints for one scope. */
export interface TotalsView {
  /** Nothing is priced here. The panel says one sentence. */
  isEmpty: boolean;
  total: number;
  hours: number;
  /**
   * Whole hours once there are a hundred of them, tenths below that.
   *
   * 6,388.0 beside $745,724 made every figure look like it had cents. A phase
   * of 0.4 hours still needs its tenth, so small scopes keep one decimal, and
   * the rule is per PANEL so a column never mixes the two.
   */
  hoursDecimals: 0 | 1;
  /** All-in cost per man-hour. */
  costPerHour: number | null;
  takeoff: TakeoffView | null;
  /** Said under the takeoff when its rates need a caveat, otherwise `null`. */
  takeoffNote: string | null;
  cost: CostLine[];
  /** Empty when there is nothing positive to draw. */
  bar: BarSegment[];
  hoursLines: HoursLine[];
  /**
   * Indirect hours, at estimate depth, when there are any.
   *
   * ⚠️ NOT A THIRD PART BESIDE CRAFT AND WELD. Those two already hold every hour;
   * this is the slice of them sitting in indirect breakdowns. Listed as a peer it
   * made a column that summed past the hours stated a line above (4,834 + 1,554 +
   * 700 under "6,388 man-hours"). `directHours` rides along so the sentence can
   * state what the ratio is a ratio OF, and a reader can check it by eye.
   */
  indirect: { hours: number; directHours: number; ratio: number | null } | null;
  detail: DetailLine[];
  /** "14 breakdowns · 120 phases · 2,340 activities", at estimate depth only. */
  contents: string | null;
  /**
   * The bid this scope belongs to, below estimate depth.
   *
   * `undefined` while the summary loads, `null` at estimate depth, where the
   * scope IS the bid and restating it under itself was one of the confusions.
   */
  estimate: { total: number; share: number | null } | null | undefined;
  /** Cost sitting in hidden breakdowns, when there is any. */
  hidden: { count: number; cost: number } | null;
}

export interface TotalsInput {
  depth: TotalsDepth;
  costs: ScopeCosts;
  summary: EstimateSummary | undefined;
  /** Absent at estimate depth, where quantities in different units cannot add. */
  takeoff?: TakeoffState;
  /** Formats a count with grouping. Injected so this module imports no formatter. */
  formatCount: (value: number) => string;
}

/**
 * How many decimals a sheet's hours print with, given the sheet's total hours.
 *
 * Exported because the floating selection bar prints a selection's hours beside
 * the panel's, and "2,437.1 MH" in one and "2,437 man-hours" in the other, an
 * inch apart, is two answers to one question.
 */
export function hoursDecimalsFor(scopeHours: number): 0 | 1 {
  return scopeHours >= 100 ? 0 : 1;
}

/** `part / whole`, or `null` when there is no whole to be a part of. */
export function ratio(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return part / whole;
}

const COST_LABELS: Record<CostKey, string> = {
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  subcontractor: "Subcontractor",
  costOnly: "Cost only",
};

/** Build the panel's content for one scope. */
export function deriveTotalsView(input: TotalsInput): TotalsView {
  const { depth, costs, summary, takeoff, formatCount } = input;

  const hours = costs.craftManHours + costs.welderManHours;
  const laborCost = costs.craftCost + costs.welderCost;

  // EVERY component, not the total. A material line and a cost-only deduct that
  // cancel to the dollar net to zero with no hours, and "nothing priced yet"
  // over a sheet holding two priced lines would hide exactly the breakdown an
  // estimator needs to see why the phase is worth nothing.
  const isEmpty =
    hours === 0 &&
    costs.totalCost === 0 &&
    costs.craftCost === 0 &&
    costs.welderCost === 0 &&
    costs.materialCost === 0 &&
    costs.equipmentCost === 0 &&
    costs.subcontractorCost === 0 &&
    costs.costOnlyCost === 0;

  // ── Where the money goes ──
  const parts: [CostKey, number][] = [
    ["labor", laborCost],
    ["material", costs.materialCost],
    ["equipment", costs.equipmentCost],
    ["subcontractor", costs.subcontractorCost],
    ["costOnly", costs.costOnlyCost],
  ];
  const listed = parts.filter(([, value]) => value !== 0);
  const shares = listed.map(([, value]) => ratio(value, costs.totalCost));
  const printed = formatShares(shares);
  const cost: CostLine[] = listed.map(([id, value], index) => ({
    id,
    label: COST_LABELS[id],
    value,
    share: shares[index] ?? null,
    percentText: printed[index] ?? null,
  }));

  // The bar draws what ADDS to the price. A deduct has no width to give, so it
  // is left out and the rest share the bar; its line and its negative share
  // still say what it did.
  const positive = parts.filter(([, value]) => value > 0);
  const positiveSum = positive.reduce((sum, [, value]) => sum + value, 0);
  const bar: BarSegment[] =
    positiveSum > 0 ? positive.map(([id, value]) => ({ id, fraction: value / positiveSum })) : [];

  // ── Hours ──
  const hoursLines: HoursLine[] = [];
  if (costs.craftManHours !== 0) {
    hoursLines.push({ id: "craft", label: "Craft", value: costs.craftManHours });
  }
  if (costs.welderManHours !== 0) {
    hoursLines.push({ id: "weld", label: "Weld", value: costs.welderManHours });
  }
  // "Indirect" is a fact about which BREAKDOWN hours sit in, so it means
  // something for the estimate and nothing inside one phase. ONE ratio for it:
  // the panel used to print indirect as a share of all hours AND over direct
  // hours, a line apart, and the two never match. Over direct hours is the one
  // estimators quote. And nothing at all when there are no indirect hours: a
  // sentence about a line that is not there is a figure for nothing.
  const atEstimate = depth === "estimate" && summary !== undefined;
  const indirect =
    atEstimate && summary.indirectHours !== 0
      ? {
          hours: summary.indirectHours,
          directHours: summary.directHours,
          ratio: ratio(summary.indirectHours, summary.directHours),
        }
      : null;

  // ── Takeoff ──
  const measured = takeoff?.kind === "measured" && takeoff.quantity > 0 ? takeoff : null;
  const takeoffView: TakeoffView | null = measured
    ? {
        quantity: measured.quantity,
        unit: measured.unit,
        isOverridden: measured.isOverridden,
        hoursPerUnit: ratio(hours, measured.quantity),
        costPerUnit: ratio(costs.totalCost, measured.quantity),
      }
    : null;
  let takeoffNote: string | null = null;
  if (takeoff?.kind === "mixed") {
    takeoffNote = "Phases here are measured in different units, so there is no per-unit rate.";
  } else if (measured && (measured.unquantifiedPhases ?? 0) > 0) {
    // The per-unit rates divide ALL of the breakdown's cost by the quantity of
    // only the phases that state one, so they read high. Say so.
    const n = measured.unquantifiedPhases ?? 0;
    takeoffNote =
      n === 1
        ? "1 priced phase has no quantity yet, so the per-unit rates read high."
        : `${formatCount(n)} priced phases have no quantity yet, so the per-unit rates read high.`;
  }

  // ── More detail ──
  const detail: DetailLine[] = [];
  const push = (id: string, label: string, kind: FigureKind, value: number | null) => {
    if (value !== null && value !== 0) detail.push({ id, label, kind, value });
  };
  // "Weld & rig" is the legacy panel's name for it: the welder's rate carries the rig.
  push("craftCost", "Craft labor", "money", costs.craftCost);
  push("welderCost", "Weld & rig labor", "money", costs.welderCost);
  // Named as the pair of the headline's "all-in per hour", which it sits under.
  push("laborPerHour", "Labor per hour", "rate", ratio(laborCost, hours));
  if (atEstimate) {
    // Direct hours are stated in the indirect sentence, so they are not repeated.
    const kinds = summary.indirectHoursByKind;
    if (kinds) {
      push("supportHours", "Support hours", "hours", kinds.support);
      push("mobilizationHours", "Mobe / demobe hours", "hours", kinds.mobilization);
      push("specialtyHours", "Specialty hours", "hours", kinds.specialty);
    }
  }

  const contents =
    depth === "estimate" && summary
      ? [
          plural(summary.wbsCount, "breakdown", formatCount),
          plural(summary.phaseCount, "phase", formatCount),
          plural(summary.activityCount, "activity", formatCount, "activities"),
        ].join(" · ")
      : null;

  const hiddenCount = summary?.hiddenWbsCount ?? 0;

  return {
    isEmpty,
    total: costs.totalCost,
    hours,
    hoursDecimals: hoursDecimalsFor(hours),
    costPerHour: ratio(costs.totalCost, hours),
    takeoff: takeoffView,
    takeoffNote,
    cost,
    bar,
    hoursLines,
    indirect,
    detail,
    contents,
    estimate:
      depth === "estimate"
        ? null
        : summary
          ? {
              total: summary.totalCost,
              // An empty scope has no share worth stating: "0.0% of it" under
              // "Nothing priced yet" is a figure for nothing.
              share: isEmpty ? null : ratio(costs.totalCost, summary.totalCost),
            }
          : undefined,
    hidden: hiddenCount > 0 ? { count: hiddenCount, cost: summary?.hiddenCost ?? 0 } : null,
  };
}

function plural(
  count: number,
  singular: string,
  formatCount: (value: number) => string,
  pluralForm = `${singular}s`
): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * A share, to the whole percent.
 *
 * "87.9%" beside "$655,293" was two precise numbers on one line and the eye
 * read neither. A share answers "roughly how much of it", and a whole number
 * answers that. A sliver says "<1%" rather than rounding to a "0%" that reads
 * as nothing. The exact value is what a click copies.
 */
export function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent !== 0 && Math.abs(percent) < 0.5) return percent > 0 ? "<1%" : ">−1%";
  const rounded = Math.round(percent);
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded)}%`;
}

/**
 * The cost shares as printed: whole percents that add to what the parts add to.
 *
 * WHY NOT ROUND EACH. 45.4 + 30.4 + 24.2 rounds to 45 + 30 + 24 = 99, and with
 * three to five parts that happens on a quarter to a third of sheets, under a
 * bar drawn as one whole, in front of readers who check bids by adding columns.
 * So the points are apportioned by largest remainder: floor each part, then hand
 * the leftover points to the largest fractions. No line moves a full point from
 * its true share.
 *
 * Only when every listed part ADDS to the price. With a deduct the shares run
 * past 100 and net back, so there is no whole to apportion and each share is
 * rounded on its own.
 */
export function formatShares(shares: readonly (number | null)[]): (string | null)[] {
  if (shares.some((share) => share === null || share <= 0)) {
    return shares.map((share) => (share === null ? null : formatPercent(share)));
  }
  const points = shares.map((share) => (share ?? 0) * 100);
  // A sliver prints "<1%" and takes no points. The rest share what THEY add to.
  const counted = points.map((point) => point >= 0.5);
  const whole = points.map((point, i) => (counted[i] ? Math.floor(point) : 0));
  const target = Math.round(points.reduce((sum, point, i) => (counted[i] ? sum + point : sum), 0));
  let left = target - whole.reduce((sum, w) => sum + w, 0);
  const order = points
    .map((point, i) => ({ i, point, remainder: point - Math.floor(point) }))
    .filter(({ i }) => counted[i])
    .sort((a, b) => b.remainder - a.remainder || b.point - a.point || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    whole[i] = (whole[i] ?? 0) + 1;
    left -= 1;
  }
  // A part just over half a point that won no leftover is still not "0%".
  return whole.map((w) => (w === 0 ? "<1%" : `${w}%`));
}

/**
 * A ratio worth a decimal: indirect over direct, this phase's share of the bid.
 *
 * One decimal, because 4.3% of a $6.5M bid and 4% of it are $20,000 apart.
 */
export function formatPrecisePercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent !== 0 && Math.abs(percent) < 0.05) return percent > 0 ? "<0.1%" : ">−0.1%";
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 100) return "100%";
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)}%`;
}

/**
 * The number a click puts on the clipboard.
 *
 * Bare, because its destination is a spreadsheet cell: no symbol, no grouping,
 * an ASCII hyphen for a negative. Excel reads "98240.37" as a number and
 * "$98,240" as text in half the locales it runs in.
 */
export function rawValue(kind: FigureKind, value: number): string {
  // Percent POINTS, as printed, but carried past display precision: a share the
  // panel shows as "<1%" still has to paste as a number. `Number()` drops
  // padding zeros and turns a negative zero into "0".
  if (kind === "percent") return String(Number((value * 100).toFixed(4)));
  if (kind === "hoursPerUnit") return value.toFixed(4);
  return value.toFixed(2);
}
