import { describe, expect, it } from "vitest";
import {
  deriveTotalsView,
  formatPercent,
  formatPrecisePercent,
  formatShares,
  ratio,
  rawValue,
  type EstimateSummary,
  type ScopeCosts,
  type TotalsInput,
} from "./derive";

const ZERO: ScopeCosts = {
  craftManHours: 0,
  welderManHours: 0,
  craftCost: 0,
  welderCost: 0,
  materialCost: 0,
  equipmentCost: 0,
  subcontractorCost: 0,
  costOnlyCost: 0,
  totalCost: 0,
};

/** A phase of pipe: 1,500 craft hours, 500 weld hours, $200,000 all in. */
const PHASE: ScopeCosts = {
  craftManHours: 1500,
  welderManHours: 500,
  craftCost: 90_000,
  welderCost: 50_000,
  materialCost: 40_000,
  equipmentCost: 15_000,
  subcontractorCost: 5_000,
  costOnlyCost: 0,
  totalCost: 200_000,
};

const SUMMARY: EstimateSummary = {
  ...PHASE,
  craftManHours: 60_000,
  welderManHours: 20_000,
  totalCost: 4_000_000,
  totalHours: 80_000,
  directHours: 64_000,
  indirectHours: 16_000,
  wbsCount: 14,
  phaseCount: 120,
  activityCount: 2340,
  completedPhaseCount: 23,
  indirectHoursByKind: { mobilization: 4_000, support: 10_000, specialty: 2_000 },
  hiddenWbsCount: 0,
  hiddenCost: 0,
};

function view(overrides: Partial<TotalsInput> = {}) {
  return deriveTotalsView({
    depth: "phase",
    costs: PHASE,
    summary: SUMMARY,
    takeoff: { kind: "measured", quantity: 400, unit: "LF", isOverridden: false },
    formatCount: (n) => n.toLocaleString("en-US"),
    ...overrides,
  });
}

const estimateView = (overrides: Partial<TotalsInput> = {}) =>
  view({ depth: "estimate", costs: SUMMARY, takeoff: undefined, ...overrides });

describe("ratio", () => {
  it("answers null, never 0, NaN or Infinity, when there is nothing to divide by", () => {
    expect(ratio(100, 0)).toBeNull();
    expect(ratio(100, -5)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(Number.NaN, 10)).toBeNull();
    expect(ratio(50, 200)).toBe(0.25);
  });
});

describe("where the money goes", () => {
  it("lists each part with its share, and the parts are the whole", () => {
    const { cost } = view();
    expect(cost.map((line) => line.id)).toEqual([
      "labor",
      "material",
      "equipment",
      "subcontractor",
    ]);
    expect(cost[0]).toMatchObject({
      label: "Labor",
      value: 140_000,
      share: 0.7,
      percentText: "70%",
    });
    expect(cost.reduce((sum, line) => sum + (line.share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it("leaves out a line worth nothing, instead of printing a dash for it", () => {
    expect(view().cost.some((line) => line.id === "costOnly")).toBe(false);
  });

  it("keeps a deduct, with its negative share", () => {
    const costs = { ...PHASE, costOnlyCost: -10_000, totalCost: 190_000 };
    const line = view({ costs }).cost.find((l) => l.id === "costOnly");
    expect(line?.value).toBe(-10_000);
    expect(line?.share).toBeCloseTo(-10_000 / 190_000, 10);
  });
});

describe("the proportion bar", () => {
  it("has one segment per positive part, and they fill it", () => {
    const { bar } = view();
    expect(bar.map((segment) => segment.id)).toEqual([
      "labor",
      "material",
      "equipment",
      "subcontractor",
    ]);
    expect(bar.reduce((sum, segment) => sum + segment.fraction, 0)).toBeCloseTo(1, 10);
    expect(bar[0]?.fraction).toBe(0.7);
  });

  it("gives a deduct no width, and the rest still fill the bar", () => {
    const costs = { ...PHASE, costOnlyCost: -10_000, totalCost: 190_000 };
    const { bar } = view({ costs });
    expect(bar.some((segment) => segment.id === "costOnly")).toBe(false);
    expect(bar.reduce((sum, segment) => sum + segment.fraction, 0)).toBeCloseTo(1, 10);
  });

  it("is not drawn when nothing adds to the price", () => {
    expect(view({ costs: ZERO }).bar).toEqual([]);
    expect(view({ costs: { ...ZERO, costOnlyCost: -500, totalCost: -500 } }).bar).toEqual([]);
  });
});

describe("the headline rates", () => {
  it("states cost per hour and cost per unit of takeoff", () => {
    const v = view();
    expect(v.costPerHour).toBe(100); // 200,000 / 2,000
    expect(v.takeoff).toEqual({
      quantity: 400,
      unit: "LF",
      isOverridden: false,
      hoursPerUnit: 5, // 2,000 / 400
      costPerUnit: 500, // 200,000 / 400
    });
  });

  it("says nothing about a takeoff that does not exist, is pending, or is zero", () => {
    expect(view({ takeoff: { kind: "none" } }).takeoff).toBeNull();
    expect(view({ takeoff: { kind: "pending" } }).takeoff).toBeNull();
    expect(
      view({ takeoff: { kind: "measured", quantity: 0, unit: "LF", isOverridden: true } }).takeoff
    ).toBeNull();
    expect(view({ takeoff: { kind: "none" } }).takeoffNote).toBeNull();
    expect(estimateView().takeoff).toBeNull();
  });

  it("explains why a breakdown in mixed units has no per-unit rate", () => {
    const v = view({ depth: "wbs", takeoff: { kind: "mixed" } });
    expect(v.takeoff).toBeNull();
    expect(v.takeoffNote).toMatch(/different units/);
  });

  it("warns when a breakdown's rates divide by an incomplete quantity", () => {
    const measured = { kind: "measured" as const, quantity: 400, unit: "LF", isOverridden: false };
    const one = view({ depth: "wbs", takeoff: { ...measured, unquantifiedPhases: 1 } });
    expect(one.takeoffNote).toMatch(/^1 priced phase has no quantity/);
    // The rates still print: a rate that reads high beats no rate.
    expect(one.takeoff?.costPerUnit).toBe(500);
    const many = view({ depth: "wbs", takeoff: { ...measured, unquantifiedPhases: 3 } });
    expect(many.takeoffNote).toMatch(/^3 priced phases have no quantity/);
    expect(view({ depth: "wbs", takeoff: measured }).takeoffNote).toBeNull();
  });

  it("has no cost per hour on a scope with no hours", () => {
    const costs = { ...ZERO, materialCost: 5_000, totalCost: 5_000 };
    expect(view({ costs }).costPerHour).toBeNull();
  });
});

describe("hours", () => {
  it("lists craft and weld, and drops whichever is zero", () => {
    expect(view().hoursLines.map((line) => line.id)).toEqual(["craft", "weld"]);
    const craftOnly = view({ costs: { ...PHASE, welderManHours: 0 } });
    expect(craftOnly.hoursLines.map((line) => line.id)).toEqual(["craft"]);
  });

  it("keeps craft and weld as the whole, and indirect as a slice of them", () => {
    const v = estimateView();
    // Indirect is NOT a third peer: a column reading 60,000 / 20,000 / 16,000
    // under "80,000 man-hours" adds to the wrong number.
    expect(v.hoursLines.map((line) => line.id)).toEqual(["craft", "weld"]);
    expect(v.hoursLines.reduce((sum, line) => sum + line.value, 0)).toBe(v.hours);
    // Over DIRECT hours, the ratio estimators quote, with its denominator alongside
    // so the sentence can be checked by eye. Not a second ratio over all hours.
    expect(v.indirect).toEqual({ hours: 16_000, directHours: 64_000, ratio: 0.25 });
    expect(view().indirect).toBeNull();
    expect(view({ depth: "wbs" }).indirect).toBeNull();
  });

  it("says nothing about indirect when the estimate has none", () => {
    const v = estimateView({ summary: { ...SUMMARY, indirectHours: 0 } });
    expect(v.indirect).toBeNull();
  });

  it("prints whole hours once there are a hundred, and tenths below that", () => {
    expect(view().hoursDecimals).toBe(0);
    expect(view({ costs: { ...ZERO, craftManHours: 0.4 } }).hoursDecimals).toBe(1);
  });
});

describe("more detail", () => {
  it("holds the labor split and the labor rate", () => {
    expect(view().detail).toEqual([
      { id: "craftCost", label: "Craft labor", kind: "money", value: 90_000 },
      { id: "welderCost", label: "Weld & rig labor", kind: "money", value: 50_000 },
      { id: "laborPerHour", label: "Labor per hour", kind: "rate", value: 70 },
    ]);
  });

  it("adds the direct and indirect breakdown at estimate depth", () => {
    expect(estimateView().detail.map((line) => line.id)).toEqual([
      "craftCost",
      "welderCost",
      "laborPerHour",
      "supportHours",
      "mobilizationHours",
      "specialtyHours",
    ]);
  });

  it("survives a backend that does not send the indirect kinds yet", () => {
    const { indirectHoursByKind: _kinds, ...older } = SUMMARY;
    const ids = estimateView({ costs: older, summary: older }).detail.map((line) => line.id);
    expect(ids).toEqual(["craftCost", "welderCost", "laborPerHour"]);
  });

  it("lists nothing it has nothing to say about", () => {
    const costs = { ...ZERO, materialCost: 5_000, totalCost: 5_000 };
    expect(view({ costs }).detail).toEqual([]);
  });

  it("counts what the estimate holds", () => {
    expect(estimateView().contents).toBe("14 breakdowns · 120 phases · 2,340 activities");
    expect(view().contents).toBeNull();
  });
});

describe("the bid it belongs to", () => {
  it("states the bid and this scope's share of it", () => {
    expect(view().estimate).toEqual({ total: 4_000_000, share: 0.05 });
  });

  it("is not restated under itself at estimate depth", () => {
    expect(estimateView().estimate).toBeNull();
  });

  it("is undefined, not zeroed, while the summary loads", () => {
    expect(view({ summary: undefined }).estimate).toBeUndefined();
    expect(view({ summary: undefined }).hidden).toBeNull();
  });

  it("has no share of a bid that totals nothing", () => {
    expect(view({ summary: { ...SUMMARY, totalCost: 0 } }).estimate).toEqual({
      total: 0,
      share: null,
    });
  });

  it("states no share for a scope with nothing priced", () => {
    expect(view({ costs: ZERO }).estimate).toEqual({ total: 4_000_000, share: null });
  });

  it("still states a share of zero for priced lines that cancel", () => {
    const costs = { ...ZERO, materialCost: 1000, costOnlyCost: -1000, totalCost: 0 };
    expect(view({ costs }).estimate?.share).toBe(0);
  });

  it("reports hidden cost only when some exists", () => {
    expect(view().hidden).toBeNull();
    const v = view({ summary: { ...SUMMARY, hiddenWbsCount: 2, hiddenCost: 48_200 } });
    expect(v.hidden).toEqual({ count: 2, cost: 48_200 });
  });
});

describe("an empty scope", () => {
  it("is empty only when there is no money AND no hours", () => {
    expect(view({ costs: ZERO }).isEmpty).toBe(true);
    expect(view({ costs: { ...ZERO, craftManHours: 4 } }).isEmpty).toBe(false);
    expect(view({ costs: { ...ZERO, materialCost: 1, totalCost: 1 } }).isEmpty).toBe(false);
  });

  it("is not empty when priced lines cancel to the dollar", () => {
    // A material line and a cost-only deduct. Worth nothing, and not nothing.
    const costs = { ...ZERO, materialCost: 1000, costOnlyCost: -1000, totalCost: 0 };
    const v = view({ costs });
    expect(v.isEmpty).toBe(false);
    expect(v.cost.map((line) => [line.id, line.value, line.share, line.percentText])).toEqual([
      ["material", 1000, null, null],
      ["costOnly", -1000, null, null],
    ]);
  });
});

describe("formatPercent", () => {
  it("prints whole percents, and never rounds a sliver to nothing", () => {
    expect(formatPercent(0.879)).toBe("88%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.003)).toBe("<1%");
    expect(formatPercent(-0.052)).toBe("−5%");
    expect(formatPercent(0)).toBe("0%");
  });
});

describe("formatShares", () => {
  const whole = (texts: (string | null)[]) =>
    texts.reduce((sum, text) => sum + (text && /^\d+%$/.test(text) ? parseInt(text, 10) : 0), 0);

  it("makes the column add up where rounding each part would not", () => {
    // 45.4 + 30.4 + 24.2: rounded one by one that is 45 + 30 + 24 = 99.
    const printed = formatShares([0.454, 0.304, 0.242]);
    expect(printed).toEqual(["46%", "30%", "24%"]);
    expect(whole(printed)).toBe(100);
  });

  it("gives a tied leftover point to the larger part", () => {
    expect(formatShares([0.7, 0.2, 0.075, 0.025])).toEqual(["70%", "20%", "8%", "2%"]);
  });

  it("keeps a sliver as a sliver, and the rest still add up", () => {
    expect(formatShares([0.876, 0.121, 0.003])).toEqual(["88%", "12%", "<1%"]);
    // The leftover points go to the two large parts; 0.6 is never "0%".
    expect(formatShares([0.497, 0.497, 0.006])).toEqual(["50%", "50%", "<1%"]);
  });

  it("rounds each share on its own when a deduct is listed", () => {
    expect(formatShares([0.8, 0.3, -0.1])).toEqual(["80%", "30%", "−10%"]);
  });

  it("prints nothing where there is no whole to share", () => {
    expect(formatShares([null, null])).toEqual([null, null]);
  });
});

describe("formatPrecisePercent", () => {
  it("keeps one decimal for the ratios an estimator quotes", () => {
    expect(formatPrecisePercent(0.1231)).toBe("12.3%");
    expect(formatPrecisePercent(0.043)).toBe("4.3%");
    expect(formatPrecisePercent(1)).toBe("100%");
    expect(formatPrecisePercent(0.0003)).toBe("<0.1%");
  });
});

describe("rawValue", () => {
  it("is what a spreadsheet cell accepts as a number", () => {
    expect(rawValue("money", 98_240.371)).toBe("98240.37");
    expect(rawValue("money", -1200)).toBe("-1200.00");
    expect(rawValue("hours", 1872.5)).toBe("1872.50");
    expect(rawValue("percent", 0.2843)).toBe("28.43");
    expect(rawValue("percent", 1)).toBe("100");
    // Printed as "<1%", and still a number once pasted.
    expect(rawValue("percent", 0.0004)).toBe("0.04");
    expect(rawValue("percent", -1e-9)).toBe("0");
    expect(rawValue("hoursPerUnit", 0.045123)).toBe("0.0451");
  });
});
