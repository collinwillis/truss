import { describe, expect, it } from "vitest";
import {
  deriveTotalsView,
  formatPercent,
  ratio,
  rawValue,
  type EstimateSummary,
  type Figure,
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
    formatQuantity: (n) => n.toLocaleString("en-US"),
    formatCount: (n) => n.toLocaleString("en-US"),
    ...overrides,
  });
}

function figure(figures: readonly Figure[] | null | undefined, id: string): Figure {
  const found = figures?.find((f) => f.id === id);
  if (!found) throw new Error(`no figure "${id}"`);
  return found;
}

function section(v: ReturnType<typeof view>, id: "cost" | "hours" | "rates") {
  const found = v.sections.find((s) => s.id === id);
  if (!found) throw new Error(`no section "${id}"`);
  return found;
}

describe("ratio", () => {
  it("answers null, never 0, NaN or Infinity, when there is nothing to divide by", () => {
    expect(ratio(100, 0)).toBeNull();
    expect(ratio(100, -5)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(Number.NaN, 10)).toBeNull();
    expect(ratio(50, 200)).toBe(0.25);
  });
});

describe("cost", () => {
  it("prints each part with its share of the scope, and the parts are the whole", () => {
    const cost = section(view(), "cost");
    expect(figure(cost.figures, "labor").value).toBe(140_000);
    expect(figure(cost.figures, "labor").share).toBe(0.7);
    expect(figure(cost.figures, "material").share).toBe(0.2);

    const shares = cost.figures.filter((f) => !f.indent).map((f) => f.share ?? 0);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("splits labor into craft and weld & rig, as parts of the line above", () => {
    const cost = section(view(), "cost");
    const craft = figure(cost.figures, "craftCost");
    const weld = figure(cost.figures, "welderCost");
    expect([craft.indent, weld.indent]).toEqual([true, true]);
    expect((craft.value ?? 0) + (weld.value ?? 0)).toBe(figure(cost.figures, "labor").value);
    // A part of a part carries no share: two percent columns would not add up.
    expect([craft.share, weld.share]).toEqual([null, null]);
  });

  it("prints a dash and no share for a line worth nothing", () => {
    const costOnly = figure(section(view(), "cost").figures, "costOnly");
    expect(costOnly.value).toBeNull();
    expect(costOnly.share).toBeNull();
  });

  it("keeps the share of a deduct", () => {
    const costs = { ...PHASE, costOnlyCost: -10_000, totalCost: 190_000 };
    const costOnly = figure(section(view({ costs }), "cost").figures, "costOnly");
    expect(costOnly.value).toBe(-10_000);
    expect(costOnly.share).toBeCloseTo(-10_000 / 190_000, 10);
  });

  it("names what the share column is a share of", () => {
    expect(section(view({ depth: "phase" }), "cost").caption).toBe("of phase");
    expect(section(view({ depth: "wbs" }), "cost").caption).toBe("of breakdown");
    expect(section(view({ depth: "estimate", takeoff: undefined }), "cost").caption).toBe("of bid");
  });
});

describe("unit rates", () => {
  it("computes the composite rates and the per-unit rates", () => {
    const rates = section(view(), "rates").figures;
    expect(figure(rates, "laborPerHour").value).toBe(70); // 140,000 / 2,000
    expect(figure(rates, "allInPerHour").value).toBe(100); // 200,000 / 2,000
    expect(figure(rates, "hoursPerUnit").value).toBe(5); // 2,000 / 400
    expect(figure(rates, "costPerUnit").value).toBe(500); // 200,000 / 400
    expect(figure(rates, "hoursPerUnit").label).toBe("MH / LF");
    expect(figure(rates, "costPerUnit").label).toBe("$ / LF");
  });

  it("keeps both per-unit lines when there is no takeoff, and says why", () => {
    const rates = section(view({ takeoff: { kind: "none" } }), "rates");
    expect(rates.figures.map((f) => f.id)).toEqual([
      "laborPerHour",
      "allInPerHour",
      "hoursPerUnit",
      "costPerUnit",
    ]);
    expect(figure(rates.figures, "hoursPerUnit").value).toBeNull();
    expect(figure(rates.figures, "hoursPerUnit").label).toBe("MH / unit");
    expect(rates.caption).toBe("no takeoff");
    expect(section(view({ takeoff: { kind: "mixed" } }), "rates").caption).toBe("mixed units");
  });

  it("refuses to divide by a takeoff of zero", () => {
    const rates = section(
      view({ takeoff: { kind: "measured", quantity: 0, unit: "LF", isOverridden: true } }),
      "rates"
    );
    expect(figure(rates.figures, "costPerUnit").value).toBeNull();
    expect(rates.caption).toBe("no quantity");
  });

  it("says when a breakdown's rates divide by an incomplete quantity", () => {
    const measured = { kind: "measured" as const, quantity: 400, unit: "LF", isOverridden: false };
    const one = section(
      view({ depth: "wbs", takeoff: { ...measured, unquantifiedPhases: 1 } }),
      "rates"
    );
    expect(one.caption).toBe("1 phase has no quantity");
    // The rates still print: an all-in rate that reads high beats no rate.
    expect(figure(one.figures, "costPerUnit").value).toBe(500);

    const many = view({ depth: "wbs", takeoff: { ...measured, unquantifiedPhases: 3 } });
    expect(section(many, "rates").caption).toBe("3 phases have no quantity");
    expect(section(view({ depth: "wbs", takeoff: measured }), "rates").caption).toBeNull();
  });

  it("says nothing while the takeoff is still resolving", () => {
    const v = view({ takeoff: { kind: "pending" } });
    expect(section(v, "rates").caption).toBeNull();
    expect(v.takeoffText).toBeNull();
  });

  it("has no per-unit lines at estimate depth, where units cannot add", () => {
    const rates = section(view({ depth: "estimate", takeoff: undefined }), "rates");
    expect(rates.figures.map((f) => f.id)).toEqual(["laborPerHour", "allInPerHour"]);
  });

  it("answers null for hourly rates on a scope with no hours", () => {
    const costs = { ...ZERO, materialCost: 5_000, totalCost: 5_000 };
    const rates = section(view({ costs }), "rates").figures;
    expect(figure(rates, "laborPerHour").value).toBeNull();
    expect(figure(rates, "allInPerHour").value).toBeNull();
  });

  it("never flashes a ratio", () => {
    expect(section(view(), "rates").figures.every((f) => !f.flashes)).toBe(true);
  });
});

describe("hours", () => {
  it("adds the direct and indirect outline at estimate depth only", () => {
    const ids = (depth: TotalsInput["depth"]) =>
      section(view({ depth, costs: SUMMARY, takeoff: undefined }), "hours").figures.map(
        (f) => f.id
      );
    expect(ids("phase")).toEqual(["craftHours", "welderHours"]);
    expect(ids("estimate")).toEqual([
      "craftHours",
      "welderHours",
      "directHours",
      "indirectHours",
      "supportHours",
      "mobilizationHours",
      "specialtyHours",
    ]);
  });

  it("survives a backend that does not send the indirect kinds yet", () => {
    const { indirectHoursByKind: _kinds, ...older } = SUMMARY;
    const figures = section(
      view({ depth: "estimate", costs: older, summary: older, takeoff: undefined }),
      "hours"
    ).figures;
    expect(figures.map((f) => f.id)).toEqual([
      "craftHours",
      "welderHours",
      "directHours",
      "indirectHours",
    ]);
  });
});

describe("the bid it belongs to", () => {
  it("states the bid, this scope's share of it, its hours and the indirect ratio", () => {
    const estimate = view().estimate;
    expect(figure(estimate, "estimateTotal").value).toBe(4_000_000);
    expect(figure(estimate, "estimateTotal").isTotal).toBe(true);
    expect(figure(estimate, "scopeShare").value).toBe(0.05);
    expect(figure(estimate, "scopeShare").label).toBe("This phase");
    expect(figure(estimate, "indirectRatio").value).toBe(0.25);
    expect(figure(view({ depth: "wbs" }).estimate, "scopeShare").label).toBe("This breakdown");
  });

  it("states a bid of zero as a total, not as an absence", () => {
    const estimate = view({ summary: { ...SUMMARY, totalCost: 0 } }).estimate;
    expect(figure(estimate, "estimateTotal").value).toBe(0);
    // Nothing can be a share of nothing.
    expect(figure(estimate, "scopeShare").value).toBeNull();
  });

  it("does not restate the bid under itself at estimate depth", () => {
    const v = view({ depth: "estimate", costs: SUMMARY, takeoff: undefined });
    expect(v.estimate?.map((f) => f.id)).toEqual(["indirectRatio"]);
    expect(v.contents).toBe("14 breakdowns · 120 phases · 2,340 activities");
  });

  it("is absent, not zeroed, while the summary loads", () => {
    const v = view({ summary: undefined });
    expect(v.estimate).toBeNull();
    expect(v.hidden).toBeNull();
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
    expect(figure(section(v, "cost").figures, "material").value).toBe(1000);
    // No whole to be a share of.
    expect(figure(section(v, "cost").figures, "material").share).toBeNull();
  });
});

describe("the takeoff line", () => {
  it("states quantity and unit, and whether somebody typed it", () => {
    const v = view({
      takeoff: { kind: "measured", quantity: 17_500, unit: "LF", isOverridden: true },
    });
    expect(v.takeoffText).toBe("17,500 LF");
    expect(v.takeoffIsOverridden).toBe(true);
  });

  it("states a unitless quantity without a trailing space", () => {
    const v = view({ takeoff: { kind: "measured", quantity: 12, unit: "", isOverridden: false } });
    expect(v.takeoffText).toBe("12");
  });
});

describe("formatPercent", () => {
  it("prints one decimal, drops it at exactly 100, and never rounds a sliver to nothing", () => {
    expect(formatPercent(0.765)).toBe("76.5%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.0003)).toBe("<0.1%");
    expect(formatPercent(-0.052)).toBe("−5.2%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});

describe("rawValue", () => {
  it("is what a spreadsheet cell accepts as a number", () => {
    expect(rawValue("money", 98_240.371)).toBe("98240.37");
    expect(rawValue("money", -1200)).toBe("-1200.00");
    expect(rawValue("hours", 1872.5)).toBe("1872.50");
    expect(rawValue("percent", 0.2843)).toBe("28.43");
    expect(rawValue("percent", 1)).toBe("100");
    // Printed as "<0.1%", and still a number once pasted.
    expect(rawValue("percent", 0.0004)).toBe("0.04");
    expect(rawValue("percent", -0.0004)).toBe("-0.04");
    expect(rawValue("percent", -1e-9)).toBe("0");
    expect(rawValue("hoursPerUnit", 0.045123)).toBe("0.0451");
  });
});
