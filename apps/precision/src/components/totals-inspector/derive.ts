/**
 * What the totals panel prints, decided once and away from React.
 *
 * WHY A VIEW MODEL. The panel is mostly arithmetic with rules attached: a share
 * needs a whole that is not zero, a unit rate needs a takeoff that exists, an
 * empty scope says one sentence instead of twenty dashes. Rules like those go
 * wrong quietly inside JSX, and a panel an estimator checks a bid against cannot
 * be wrong quietly. Here every rule is a plain function of plain numbers, so the
 * test file beside this one can state each of them.
 *
 * ⚠️ A DASH IS NEVER A ZERO. `null` means "there is no answer here" — no hours to
 * divide by, no takeoff to measure against — and the panel prints a dash with
 * the reason nearby. `0` is an answer. Every ratio below returns `null` rather
 * than `0`, `NaN` or `Infinity` when its denominator is missing.
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

/** One printed line. */
export interface Figure {
  /** Stable across renders and depths, so a flash belongs to a line, not a slot. */
  id: string;
  label: string;
  kind: FigureKind;
  /** `null` prints a dash. See the module note. */
  value: number | null;
  /** Fraction of the section's whole, or `null` where a share means nothing. */
  share: number | null;
  /** Explains the line above it: its parts, not its peers. */
  indent: boolean;
  /** Carries the currency symbol. Only totals do, as in every grid of the app. */
  isTotal: boolean;
  /** Whether an edit moving this figure should flash it. Ratios stay still. */
  flashes: boolean;
  /** One sentence defining the line, for the tooltip and for screen readers. */
  hint?: string;
  /**
   * Starts a second partition of the same whole, so it is set apart.
   *
   * Craft and weld split the hours by trade; direct and indirect split the SAME
   * hours by kind of work. Run together they read as four parts of one whole,
   * with shares adding to 200%.
   */
  startsGroup?: boolean;
}

/** A headed group of lines. */
export interface FigureSection {
  id: "cost" | "hours" | "rates";
  heading: string;
  /** Right-aligned, quiet: what the share column is a share OF, or why a rate is missing. */
  caption: string | null;
  figures: Figure[];
}

/** Everything the panel prints for one scope. */
export interface TotalsView {
  /** Nothing is priced here: no money and no hours. The body is one sentence. */
  isEmpty: boolean;
  total: number;
  hours: number;
  /** "480 LF", or `null` where there is no measured quantity to state. */
  takeoffText: string | null;
  takeoffIsOverridden: boolean;
  sections: FigureSection[];
  /** The bid this scope belongs to. `null` until the summary has loaded. */
  estimate: Figure[] | null;
  /** Cost sitting in hidden breakdowns, when there is any. */
  hidden: { count: number; cost: number } | null;
  /** "14 breakdowns · 120 phases · 2,340 activities", at estimate depth only. */
  contents: string | null;
}

export interface TotalsInput {
  depth: TotalsDepth;
  costs: ScopeCosts;
  summary: EstimateSummary | undefined;
  /** Absent at estimate depth, where quantities in different units cannot add. */
  takeoff?: TakeoffState;
  /** Formats a takeoff quantity. Injected so this module imports no formatter. */
  formatQuantity: (value: number) => string;
  /** Formats a count with grouping. */
  formatCount: (value: number) => string;
}

/** `part / whole`, or `null` when there is no whole to be a part of. */
export function ratio(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return part / whole;
}

/**
 * A share for a line that holds `part` of `whole`.
 *
 * A line worth nothing has no share worth printing: "0.0%" beside a dash is two
 * marks for one absence. A NEGATIVE part (a cost-only deduct) keeps its share,
 * because a deduct is a real part of the price.
 */
function shareOf(part: number, whole: number): number | null {
  if (part === 0) return null;
  return ratio(part, whole);
}

function money(id: string, label: string, value: number, whole: number | null): Figure {
  return {
    id,
    label,
    kind: "money",
    value: value === 0 ? null : value,
    share: whole === null ? null : shareOf(value, whole),
    indent: false,
    isTotal: false,
    flashes: true,
  };
}

function hoursLine(id: string, label: string, value: number, whole: number | null): Figure {
  return {
    id,
    label,
    kind: "hours",
    value: value === 0 ? null : value,
    share: whole === null ? null : shareOf(value, whole),
    indent: false,
    isTotal: false,
    flashes: true,
  };
}

function indented(figure: Figure, hint?: string): Figure {
  return { ...figure, indent: true, share: null, hint: hint ?? figure.hint };
}

function computed(
  id: string,
  label: string,
  kind: "rate" | "hoursPerUnit" | "percent",
  value: number | null,
  hint: string
): Figure {
  return {
    id,
    label,
    kind,
    value,
    share: null,
    indent: false,
    isTotal: false,
    flashes: false,
    hint,
  };
}

const NOUN: Record<Exclude<TotalsDepth, "estimate">, string> = {
  wbs: "breakdown",
  phase: "phase",
};

/** Build the panel's content for one scope. */
export function deriveTotalsView(input: TotalsInput): TotalsView {
  const { depth, costs, summary, takeoff, formatQuantity, formatCount } = input;

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

  // ── Cost: what the price is made of ──
  const cost: FigureSection = {
    id: "cost",
    heading: "Cost",
    caption: depth === "estimate" ? "of bid" : `of ${NOUN[depth]}`,
    figures: [
      money("labor", "Labor", laborCost, costs.totalCost),
      // The legacy panel split these, and "Weld & rig" is its name for the
      // figure: the welder's loaded rate carries the rig.
      indented(money("craftCost", "Craft", costs.craftCost, null)),
      indented(money("welderCost", "Weld & rig", costs.welderCost, null)),
      money("material", "Material", costs.materialCost, costs.totalCost),
      money("equipment", "Equipment", costs.equipmentCost, costs.totalCost),
      money("subcontractor", "Subcontractor", costs.subcontractorCost, costs.totalCost),
      money("costOnly", "Cost only", costs.costOnlyCost, costs.totalCost),
    ],
  };

  // ── Hours: by trade, and at estimate depth by kind of work ──
  const hourFigures: Figure[] = [
    hoursLine("craftHours", "Craft", costs.craftManHours, hours),
    hoursLine("welderHours", "Weld", costs.welderManHours, hours),
  ];
  if (depth === "estimate" && summary) {
    /**
     * A SECOND PARTITION OF THE SAME HOURS, which is why it follows the first
     * rather than interleaving with it: craft and weld split the hours by TRADE,
     * these split them by whether the breakdown carrying them is direct work.
     * It exists only here because "indirect" is a fact about which breakdown the
     * hours sit in, and inside one phase it means nothing.
     */
    hourFigures.push(
      {
        ...hoursLine("directHours", "Direct", summary.directHours, summary.totalHours),
        hint: "Hours in breakdowns that build the job itself.",
        startsGroup: true,
      },
      {
        ...hoursLine("indirectHours", "Indirect", summary.indirectHours, summary.totalHours),
        hint: "Hours in Mobilize, Demobilize, Support and Specialty Services.",
      }
    );
    const kinds = summary.indirectHoursByKind;
    if (kinds) {
      hourFigures.push(
        indented(hoursLine("supportHours", "Support", kinds.support, null)),
        indented(hoursLine("mobilizationHours", "Mobe / demobe", kinds.mobilization, null)),
        indented(hoursLine("specialtyHours", "Specialty", kinds.specialty, null))
      );
    }
  }
  const hoursSection: FigureSection = {
    id: "hours",
    heading: "Man-hours",
    caption: "of hours",
    figures: hourFigures,
  };

  // ── Unit rates: is the price sane ──
  const measured = takeoff?.kind === "measured" && takeoff.quantity > 0 ? takeoff : null;
  const unit = measured ? measured.unit || "unit" : "unit";
  const rateFigures: Figure[] = [
    computed(
      "laborPerHour",
      "Labor $ / MH",
      "rate",
      ratio(laborCost, hours),
      "Labor cost divided by man-hours: the composite labor rate."
    ),
    computed(
      "allInPerHour",
      "All-in $ / MH",
      "rate",
      ratio(costs.totalCost, hours),
      "Total cost divided by man-hours."
    ),
  ];
  let ratesCaption: string | null = null;
  if (depth !== "estimate") {
    // ALWAYS two lines at these depths, answered or not. Estimators page sibling
    // phases with [ and ], and a panel whose lines come and go under the eye is
    // one where "the third number down" stops meaning anything.
    rateFigures.push(
      computed(
        "hoursPerUnit",
        `MH / ${unit}`,
        "hoursPerUnit",
        measured ? ratio(hours, measured.quantity) : null,
        depth === "wbs"
          ? "This breakdown's man-hours divided by its takeoff quantity. Phases with no takeoff still count toward the hours."
          : "Man-hours divided by the takeoff quantity."
      ),
      computed(
        "costPerUnit",
        `$ / ${unit}`,
        "rate",
        measured ? ratio(costs.totalCost, measured.quantity) : null,
        depth === "wbs"
          ? "This breakdown's total cost divided by its takeoff quantity. Phases with no takeoff still count toward the cost."
          : "Total cost divided by the takeoff quantity."
      )
    );
    if (takeoff?.kind === "none") ratesCaption = "no takeoff";
    else if (takeoff?.kind === "mixed") ratesCaption = "mixed units";
    else if (takeoff?.kind === "measured" && takeoff.quantity <= 0) ratesCaption = "no quantity";
    else if (takeoff?.kind === "measured" && (takeoff.unquantifiedPhases ?? 0) > 0) {
      const n = takeoff.unquantifiedPhases ?? 0;
      ratesCaption =
        n === 1 ? "1 phase has no quantity" : `${formatCount(n)} phases have no quantity`;
    }
  }
  const rates: FigureSection = {
    id: "rates",
    heading: "Unit rates",
    caption: ratesCaption,
    figures: rateFigures,
  };

  // ── The bid this belongs to ──
  let estimate: Figure[] | null = null;
  if (summary) {
    const indirectRatio = computed(
      "indirectRatio",
      "Indirect ÷ direct MH",
      "percent",
      ratio(summary.indirectHours, summary.directHours),
      "Indirect hours as a percentage of direct hours, for the whole estimate."
    );
    estimate =
      depth === "estimate"
        ? [indirectRatio]
        : [
            // A total states itself whatever it is, the way the foot of a grid
            // does: a bid that totals zero has still been totalled.
            {
              ...money("estimateTotal", "Total", summary.totalCost, null),
              value: summary.totalCost,
              isTotal: true,
            },
            computed(
              "scopeShare",
              `This ${NOUN[depth]}`,
              "percent",
              ratio(costs.totalCost, summary.totalCost),
              `This ${NOUN[depth]}'s cost as a percentage of the estimate.`
            ),
            hoursLine("estimateHours", "Man-hours", summary.totalHours, null),
            indirectRatio,
          ];
  }

  const hiddenCount = summary?.hiddenWbsCount ?? 0;
  const hidden = hiddenCount > 0 ? { count: hiddenCount, cost: summary?.hiddenCost ?? 0 } : null;

  const contents =
    depth === "estimate" && summary
      ? [
          plural(summary.wbsCount, "breakdown", formatCount),
          plural(summary.phaseCount, "phase", formatCount),
          plural(summary.activityCount, "activity", formatCount, "activities"),
        ].join(" · ")
      : null;

  return {
    isEmpty,
    total: costs.totalCost,
    hours,
    takeoffText:
      takeoff?.kind === "measured"
        ? `${formatQuantity(takeoff.quantity)}${takeoff.unit ? ` ${takeoff.unit}` : ""}`
        : null,
    takeoffIsOverridden: takeoff?.kind === "measured" && takeoff.isOverridden,
    sections: [cost, hoursSection, rates],
    estimate,
    hidden,
    contents,
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
 * A share as the panel prints it.
 *
 * One decimal, because the lines it sits beside are worth millions and a whole
 * percent of a $12M bid is $120,000. Exactly 100 drops the decimal; a sliver
 * says "<0.1%" rather than rounding to a "0.0%" that reads as nothing.
 */
export function formatPercent(fraction: number): string {
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
  // panel shows as "<0.1%" copied as "0.0". `Number()` drops padding zeros and
  // turns a negative zero into "0".
  if (kind === "percent") return String(Number((value * 100).toFixed(4)));
  if (kind === "hoursPerUnit") return value.toFixed(4);
  return value.toFixed(2);
}
