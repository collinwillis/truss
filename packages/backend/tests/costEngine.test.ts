/**
 * Golden-number and parity tests for the Precision cost engine.
 *
 * THE CONTRACT THIS FILE ENFORCES: for every input, Precision produces the same
 * number as the live legacy MCP Estimator. Precision cannot replace the
 * estimator until that is true, and a wrong dollar amount is worse than a
 * missing feature — so parity is asserted *exactly*, not approximately.
 * Operation order is part of the contract.
 *
 * Three layers:
 *  1. DIFFERENTIAL PARITY — the engine against an independent transcription of
 *     legacy (`legacyReference.ts`), across a generated matrix covering all six
 *     activity types, both equipment ownership branches, override cases, and
 *     numeric edges. This is what catches the corners nobody enumerated.
 *  2. PINNED GOLDEN VALUES — hand-computed expectations under real production
 *     rate sets, so a refactor that breaks both implementations the same way
 *     still fails.
 *  3. BEHAVIOURAL LOCKS — the quirks that look like bugs and are load-bearing.
 *     Each names what breaks if it is "fixed".
 */

import { describe, expect, it } from "vitest";

import {
  CALC_VERSION,
  addCosts,
  computeActivityCosts,
  computeCraftLoadedRate,
  computeWelderLoadedRate,
  emptyCosts,
  round2,
  roundCosts,
  type ActivityInput,
  type ActivityType,
  type EquipmentOwnership,
  type ProposalRates,
} from "../convex/model/costEngine";
import {
  legacyComputeActivityCosts,
  legacyCraftLoadedRate,
  legacyWelderLoadedRate,
} from "./legacyReference";

// ---------------------------------------------------------------------------
// Fixtures — real rate sets pulled from production (focused-civet-250).
// Deliberately NOT the 36 proposals with craftBaseRate = weldBaseRate = 0, where
// both engines return $0.00 and prove nothing, and not proposal 1734, whose
// rigRate/fuelRate/consumablesRate/weldBaseRate are all 0 so it exercises almost
// no markup path despite being the largest estimate.
// ---------------------------------------------------------------------------

/** Proposal 2020 — "Tank 8 installation". All fifteen rates non-zero. */
const RATES_2020: ProposalRates = {
  craftBaseRate: 35.98,
  weldBaseRate: 40.7,
  rigRate: 15,
  subsistenceRate: 10,
  burdenRate: 19.53,
  overheadRate: 10,
  laborProfitRate: 10,
  fuelRate: 3.5,
  consumablesRate: 10,
  salesTaxRate: 9.25,
  useTaxRate: 9.25,
  materialProfitRate: 7,
  equipmentProfitRate: 7,
  subcontractorProfitRate: 7,
  rigProfitRate: 10,
};

/** Proposal 2069 — "KM Pipe Supports". Median of the all-rates-populated set. */
const RATES_2069: ProposalRates = {
  craftBaseRate: 43.17,
  weldBaseRate: 47.83,
  rigRate: 15,
  subsistenceRate: 12.5,
  burdenRate: 22.15,
  overheadRate: 10,
  laborProfitRate: 10,
  fuelRate: 4,
  consumablesRate: 12,
  salesTaxRate: 8.5,
  useTaxRate: 8.5,
  materialProfitRate: 10,
  equipmentProfitRate: 10,
  subcontractorProfitRate: 10,
  rigProfitRate: 10,
};

/** Proposal 1605 — "2024 Unit 1 Scrubber/Baghouse". */
const RATES_1605: ProposalRates = {
  craftBaseRate: 34.45,
  weldBaseRate: 46.67,
  rigRate: 15,
  subsistenceRate: 11.67,
  burdenRate: 22.75,
  overheadRate: 10,
  laborProfitRate: 10,
  fuelRate: 2,
  consumablesRate: 13,
  salesTaxRate: 7,
  useTaxRate: 7,
  materialProfitRate: 7.5,
  equipmentProfitRate: 7.5,
  subcontractorProfitRate: 7.5,
  rigProfitRate: 10,
};

/** A zero-rate proposal, matching the 36 that exist in production. */
const RATES_ALL_ZERO: ProposalRates = {
  craftBaseRate: 0,
  weldBaseRate: 0,
  rigRate: 0,
  subsistenceRate: 0,
  burdenRate: 0,
  overheadRate: 0,
  laborProfitRate: 0,
  fuelRate: 0,
  consumablesRate: 0,
  salesTaxRate: 0,
  useTaxRate: 0,
  materialProfitRate: 0,
  equipmentProfitRate: 0,
  subcontractorProfitRate: 0,
  rigProfitRate: 0,
};

const RATE_SETS: ReadonlyArray<readonly [string, ProposalRates]> = [
  ["2020", RATES_2020],
  ["2069", RATES_2069],
  ["1605", RATES_1605],
  ["all-zero", RATES_ALL_ZERO],
];

// ---------------------------------------------------------------------------
// Matrix generation
// ---------------------------------------------------------------------------

const ALL_TYPES: readonly ActivityType[] = [
  "labor",
  "custom_labor",
  "material",
  "equipment",
  "subcontractor",
  "cost_only",
];

const OWNERSHIPS: readonly EquipmentOwnership[] = ["rental", "owned", "purchase"];

/**
 * Quantities chosen for numeric awkwardness, not realism: a repeating decimal, a
 * value that makes `qty x constant` non-terminating, a negative (credit lines
 * exist in real estimates), and zero.
 */
const QUANTITIES = [0, 1, 3, 7.5, 0.333, 1234.56, -12, 100000];
const CONSTANTS = [0, 0.55, 8, 1.7777, 0.001];
const PRICES = [0, 12.5, 999.99, 0.07];
const TIMES = [0, 1, 2.5, 13];

/**
 * Override values where Precision and legacy agree exactly.
 *
 * `0` is deliberately absent: it is the single input where the engine diverges
 * from legacy on purpose (decision D3 — zero is a real $0.00/hr override rather
 * than a sentinel meaning "inherit"). That divergence gets its own explicit test
 * below rather than being smuggled past the parity suite.
 */
const OVERRIDES: ReadonlyArray<number | null | undefined> = [undefined, null, 52.75, 0.01];

function buildMatrix(): ActivityInput[] {
  const activities: ActivityInput[] = [];

  for (const type of ALL_TYPES) {
    for (const quantity of QUANTITIES) {
      for (const craftConstant of CONSTANTS) {
        for (const welderConstant of CONSTANTS) {
          const labor = { craftConstant, welderConstant };

          if (type === "equipment") {
            for (const ownership of OWNERSHIPS) {
              for (const time of TIMES) {
                for (const unitPrice of PRICES) {
                  activities.push({
                    type,
                    quantity,
                    unitPrice,
                    labor,
                    equipment: { ownership, time },
                  });
                }
              }
            }
          } else if (type === "subcontractor") {
            for (const laborCost of PRICES) {
              for (const materialCost of PRICES) {
                activities.push({
                  type,
                  quantity,
                  labor,
                  subcontractor: {
                    laborCost,
                    materialCost,
                    equipmentCost: 42.42,
                  },
                });
              }
            }
          } else {
            for (const unitPrice of PRICES) {
              activities.push({ type, quantity, unitPrice, labor });
            }
          }
        }
      }
    }
  }

  return activities;
}

const MATRIX = buildMatrix();

/** Override-specific matrix — labor lines are the only type that reads them. */
function buildOverrideMatrix(): ActivityInput[] {
  const activities: ActivityInput[] = [];
  for (const type of ["labor", "custom_labor"] as const) {
    for (const customCraftRate of OVERRIDES) {
      for (const customSubsistenceRate of OVERRIDES) {
        for (const quantity of [1, 7.5, 0.333]) {
          activities.push({
            type,
            quantity,
            labor: {
              craftConstant: 0.55,
              welderConstant: 1.7777,
              customCraftRate,
              customSubsistenceRate,
            },
          });
        }
      }
    }
  }
  return activities;
}

const OVERRIDE_MATRIX = buildOverrideMatrix();

const COST_FIELDS = [
  "craftManHours",
  "welderManHours",
  "craftCost",
  "welderCost",
  "materialCost",
  "equipmentCost",
  "subcontractorCost",
  "costOnlyCost",
  "totalCost",
] as const;

function describeActivity(a: ActivityInput): string {
  return JSON.stringify(a);
}

// ---------------------------------------------------------------------------
// 1. Differential parity
// ---------------------------------------------------------------------------

describe("parity with the live legacy engine", () => {
  it("covers a non-trivial input space", () => {
    // Guards against a refactor silently collapsing the matrix to nothing.
    expect(MATRIX.length).toBeGreaterThan(2000);
    // 96 = 2 labor types x 4 craft overrides x 4 subsistence overrides x 3
    // quantities. Was 150 before `0` left OVERRIDES for its own divergence
    // test (D3); the floor moved with it deliberately, not by attrition.
    expect(OVERRIDE_MATRIX.length).toBeGreaterThan(90);
  });

  for (const [label, rates] of RATE_SETS) {
    it(`matches legacy exactly across the full matrix under rates ${label}`, () => {
      const mismatches: string[] = [];

      for (const activity of MATRIX) {
        const actual = computeActivityCosts(activity, rates);
        const expected = legacyComputeActivityCosts(activity, rates);

        for (const field of COST_FIELDS) {
          if (!Object.is(actual[field], expected[field])) {
            mismatches.push(
              `${field}: got ${actual[field]}, legacy ${expected[field]} for ${describeActivity(activity)}`
            );
          }
        }
      }

      expect(mismatches.slice(0, 10)).toEqual([]);
      expect(mismatches).toHaveLength(0);
    });

    it(`matches legacy exactly on rate overrides under rates ${label}`, () => {
      for (const activity of OVERRIDE_MATRIX) {
        const actual = computeActivityCosts(activity, rates);
        const expected = legacyComputeActivityCosts(activity, rates);
        expect(actual, describeActivity(activity)).toEqual(expected);
      }
    });

    it(`loaded rates match legacy exactly under rates ${label}`, () => {
      expect(computeWelderLoadedRate(rates)).toBe(legacyWelderLoadedRate(rates));

      for (const craft of OVERRIDES) {
        for (const subsistence of OVERRIDES) {
          expect(
            computeCraftLoadedRate(rates, craft, subsistence),
            `craft=${craft} subsistence=${subsistence}`
          ).toBe(
            legacyCraftLoadedRate(
              rates,
              craft ?? rates.craftBaseRate,
              subsistence ?? rates.subsistenceRate
            )
          );
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Pinned golden values
// ---------------------------------------------------------------------------

describe("pinned golden values (proposal 2020 rates)", () => {
  // markup = burden 19.53 + overhead 10 + laborProfit 10 + fuel 3.5 + consumables 10 = 53.03%
  const MARKUP_PERCENT = 53.03;

  it("craft loaded rate", () => {
    // 35.98 + (35.98 x 53.03)/100 + 10 = 35.98 + 19.079... + 10
    const expected = 35.98 + (35.98 * MARKUP_PERCENT) / 100 + 10;
    expect(computeCraftLoadedRate(RATES_2020)).toBe(expected);
    expect(round2(computeCraftLoadedRate(RATES_2020))).toBe(65.06);
  });

  it("welder loaded rate — rigProfitRate applies to the rig leg only", () => {
    // 40.7 + (40.7 x 53.03)/100 + 10 + 15 + (15 x 10)/100
    const expected = 40.7 + (40.7 * MARKUP_PERCENT) / 100 + 10 + 15 + (15 * 10) / 100;
    expect(computeWelderLoadedRate(RATES_2020)).toBe(expected);
    expect(round2(computeWelderLoadedRate(RATES_2020))).toBe(88.78);

    // The regression this pins: had rigProfitRate been folded into the base
    // markup (as the dead calculations.ts does), every welder hour would gain
    // weldBaseRate x rigProfitRate / 100 = $4.07.
    const ifRigProfitWereInTheBaseMarkup =
      40.7 + (40.7 * (MARKUP_PERCENT + RATES_2020.rigProfitRate)) / 100 + 10 + 15 + (15 * 10) / 100;
    expect(round2(ifRigProfitWereInTheBaseMarkup - computeWelderLoadedRate(RATES_2020))).toBe(4.07);
  });

  it("a labor line", () => {
    const costs = computeActivityCosts(
      {
        type: "labor",
        quantity: 100,
        labor: { craftConstant: 0.55, welderConstant: 0 },
      },
      RATES_2020
    );
    // 100 x 0.55 is not exactly 55 in IEEE-754 — this is precisely the value
    // the old policy rounded away before costing.
    expect(costs.craftManHours).toBe(55.00000000000001);
    expect(round2(costs.craftManHours)).toBe(55);
    expect(round2(costs.craftCost)).toBe(3578.31);
    expect(costs.welderCost).toBe(0);
    expect(costs.totalCost).toBe(costs.craftCost);
  });

  it("a material line takes materialProfit + salesTax", () => {
    const costs = computeActivityCosts(
      { type: "material", quantity: 10, unitPrice: 100, labor: null },
      RATES_2020
    );
    // 10 x 100 x (1 + (7 + 9.25)/100) = 1000 x 1.1625
    expect(costs.materialCost).toBe(1162.5);
    expect(costs.totalCost).toBe(1162.5);
  });

  it("owned equipment takes no profit and no use tax", () => {
    const owned = computeActivityCosts(
      {
        type: "equipment",
        quantity: 2,
        unitPrice: 500,
        labor: null,
        equipment: { ownership: "owned", time: 3 },
      },
      RATES_2020
    );
    expect(owned.equipmentCost).toBe(3000);

    const rental = computeActivityCosts(
      {
        type: "equipment",
        quantity: 2,
        unitPrice: 500,
        labor: null,
        equipment: { ownership: "rental", time: 3 },
      },
      RATES_2020
    );
    // 3000 x (1 + (7 + 9.25)/100). The raw product carries float noise; the
    // engine keeps it and the display boundary resolves it.
    expect(rental.equipmentCost).toBe(3487.5000000000005);
    expect(round2(rental.equipmentCost)).toBe(3487.5);
  });

  it("a subcontractor line taxes the material leg only", () => {
    const costs = computeActivityCosts(
      {
        type: "subcontractor",
        quantity: 1,
        labor: null,
        subcontractor: {
          laborCost: 1000,
          materialCost: 1000,
          equipmentCost: 1000,
        },
      },
      RATES_2020
    );
    // labor 1000 x 1.07 + material 1000 x (1 + .07 + .0925) + equipment 1000 x 1.07
    expect(costs.subcontractorCost).toBe(1070 + 1162.5 + 1070);
    expect(costs.totalCost).toBe(costs.subcontractorCost);
  });

  it("a cost-only line is quantity x price, untouched by any rate", () => {
    const costs = computeActivityCosts(
      { type: "cost_only", quantity: 3, unitPrice: 250, labor: null },
      RATES_2020
    );
    expect(costs.costOnlyCost).toBe(750);
    expect(costs.totalCost).toBe(750);
  });
});

// ---------------------------------------------------------------------------
// 3. Behavioural locks
// ---------------------------------------------------------------------------

describe("load-bearing behaviours that look like bugs", () => {
  it("welder cost accrues on subcontractor lines but is excluded from the total", () => {
    // Legacy computes welder cost unconditionally (activity.ts:548) and then
    // discards it from a subcontractor line's total (activity.ts:563-564).
    // It still counts toward man-hour rollups, which is why the engine must not
    // "simplify" this away.
    const costs = computeActivityCosts(
      {
        type: "subcontractor",
        quantity: 10,
        labor: { craftConstant: 2, welderConstant: 3 },
        subcontractor: { laborCost: 100, materialCost: 0, equipmentCost: 0 },
      },
      RATES_2020
    );

    expect(costs.welderManHours).toBe(30);
    expect(costs.welderCost).toBeGreaterThan(0);
    expect(costs.craftCost).toBe(0); // craft is the one component legacy skips
    expect(costs.totalCost).toBe(costs.subcontractorCost);
    expect(costs.totalCost).not.toBe(costs.subcontractorCost + costs.welderCost);
  });

  it("every non-subcontractor total is the exact sum of its components", () => {
    for (const [, rates] of RATE_SETS) {
      for (const activity of MATRIX) {
        if (activity.type === "subcontractor") continue;
        const c = computeActivityCosts(activity, rates);
        expect(c.totalCost).toBe(
          c.craftCost +
            c.welderCost +
            c.materialCost +
            c.equipmentCost +
            c.subcontractorCost +
            c.costOnlyCost
        );
      }
    }
  });

  it("a rate override of 0 means $0.00/hr, diverging from legacy on purpose (D3)", () => {
    // THE ONLY DELIBERATE BEHAVIOURAL DIFFERENCE FROM LEGACY.
    //
    // Legacy composed `??` at the model layer with `||` at the rate layer, so a
    // stored 0 fell through to the proposal rate — making $0.00/hr impossible to
    // express. Precision treats absence as "inherit" and 0 as a real value.
    //
    // Unobservable on existing data: fieldMapping only stores non-zero
    // overrides, so no stored zero exists in the 713 production proposals. If
    // this ever needs to change back, bump CALC_VERSION — do not edit quietly.
    const inherited = computeCraftLoadedRate(RATES_2020);
    const zeroOverride = computeCraftLoadedRate(RATES_2020, 0, 0);

    // Craft base 0 and subsistence 0 zero out the whole loaded rate.
    expect(zeroOverride).toBe(0);
    expect(zeroOverride).not.toBe(inherited);

    // And this is precisely where legacy disagrees. Pin both sides so the
    // divergence stays visible to the next reader.
    expect(legacyCraftLoadedRate(RATES_2020, 0, 0)).toBe(inherited);
    expect(legacyCraftLoadedRate(RATES_2020, 0, 0)).not.toBe(zeroOverride);

    // A zero override on one field only affects that field.
    const zeroSubsistenceOnly = computeCraftLoadedRate(RATES_2020, undefined, 0);
    expect(zeroSubsistenceOnly).toBe(inherited - RATES_2020.subsistenceRate);

    // An activity priced with a 0 craft override accrues no craft cost.
    const costs = computeActivityCosts(
      {
        type: "labor",
        quantity: 100,
        labor: {
          craftConstant: 0.55,
          welderConstant: 0,
          customCraftRate: 0,
          customSubsistenceRate: 0,
        },
      },
      RATES_2020
    );
    expect(costs.craftManHours).toBe(55.00000000000001);
    expect(costs.craftCost).toBe(0);
    expect(costs.totalCost).toBe(0);
  });

  it("absence, not zero, is what inherits the proposal rate (decision D3)", () => {
    const noOverride = computeCraftLoadedRate(RATES_2020);

    // Both spellings of "absent" inherit.
    expect(computeCraftLoadedRate(RATES_2020, undefined, undefined)).toBe(noOverride);
    expect(computeCraftLoadedRate(RATES_2020, null, null)).toBe(noOverride);

    // A real override replaces only the field it names.
    const explicit = computeCraftLoadedRate(RATES_2020, 52.75, null);
    expect(explicit).toBeGreaterThan(noOverride);

    // Mixed: override the base, inherit subsistence.
    const mixed = computeCraftLoadedRate(RATES_2020, 52.75, undefined);
    expect(mixed).toBe(explicit);
  });

  it("null and undefined overrides behave identically to no override", () => {
    const base = computeCraftLoadedRate(RATES_2020);
    expect(computeCraftLoadedRate(RATES_2020, null, null)).toBe(base);
    expect(computeCraftLoadedRate(RATES_2020, undefined, undefined)).toBe(base);
  });

  it("prices a zero-rate proposal at zero without throwing", () => {
    // 36 such proposals exist in production. Both engines return 0; the value of
    // this test is that neither throws and neither produces NaN.
    for (const activity of MATRIX) {
      const c = computeActivityCosts(activity, RATES_ALL_ZERO);
      for (const field of COST_FIELDS) {
        expect(Number.isNaN(c[field])).toBe(false);
      }
    }
  });

  it("handles missing type-specific data without producing NaN", () => {
    const bare: ActivityInput[] = ALL_TYPES.map((type) => ({
      type,
      quantity: 5,
    }));
    for (const activity of bare) {
      const c = computeActivityCosts(activity, RATES_2020);
      for (const field of COST_FIELDS) {
        expect(Number.isNaN(c[field]), `${activity.type}.${field}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Rounding policy (decision D2)
// ---------------------------------------------------------------------------

describe("rounding policy", () => {
  it("does not round man-hours before costing", () => {
    // The pre-M0 engine did `round2(qty x constant)` before multiplying by the
    // loaded rate. Legacy rounds nowhere. This input makes the difference visible.
    const activity: ActivityInput = {
      type: "labor",
      quantity: 0.333,
      labor: { craftConstant: 1.7777, welderConstant: 0 },
    };

    const costs = computeActivityCosts(activity, RATES_2020);
    const rawManHours = 0.333 * 1.7777;

    expect(costs.craftManHours).toBe(rawManHours);
    expect(costs.craftManHours).not.toBe(round2(rawManHours));

    // What the old policy would have produced, for the record.
    const preM0 = round2(rawManHours) * computeCraftLoadedRate(RATES_2020);
    expect(costs.craftCost).not.toBe(preM0);
  });

  it("rounds only at the display boundary", () => {
    const costs = computeActivityCosts(
      {
        type: "labor",
        quantity: 0.333,
        labor: { craftConstant: 1.7777, welderConstant: 0.001 },
      },
      RATES_2020
    );
    const display = roundCosts(costs);
    for (const field of COST_FIELDS) {
      expect(display[field]).toBe(round2(costs[field]));
    }
  });

  it("accumulates in full precision, so rollups do not drift", () => {
    // Rounding each line before summing is how a 1,000-line WBS ends up cents
    // away from the sum of its phases. Accumulate raw; round once at the end.
    const line: ActivityInput = {
      type: "labor",
      quantity: 1,
      labor: { craftConstant: 0.005, welderConstant: 0 },
    };

    const total = emptyCosts();
    for (let i = 0; i < 1000; i++) {
      addCosts(total, computeActivityCosts(line, RATES_2020));
    }

    const single = computeActivityCosts(line, RATES_2020);
    expect(total.craftManHours).toBeCloseTo(single.craftManHours * 1000, 10);

    const roundedThenSummed = round2(single.craftCost) * 1000;
    expect(round2(total.craftCost)).not.toBe(round2(roundedThenSummed));
  });

  it("round2 half-cent behaviour follows the float, not the decimal literal", () => {
    // Pinned deliberately, because the intuitive rule ("halves round up") is
    // FALSE here and someone will eventually try to "fix" it.
    //
    // `Math.round(n * 100) / 100` rounds the double that `n * 100` actually is.
    // A decimal literal ending in 5 at the third place is usually not
    // representable, so it lands just below the .5 boundary and rounds down:
    //
    //   1.005 * 100 === 100.49999999999999  -> 1.00
    //   1.015 * 100 === 101.49999999999999  -> 1.01
    //   0.145 * 100 ===  14.499999999999998 -> 0.14
    //
    // but 2.675 * 100 is exactly 267.5, so it rounds up:
    //
    //   2.675 * 100 === 267.5               -> 2.68
    //
    // This is acceptable because round2 is a *display* helper only: it is never
    // called between engine steps, and derived costs are products of many
    // factors, so exact half-cents essentially do not occur. If a report ever
    // needs banker's rounding or decimal-exact currency, add a separate function
    // rather than changing this one — every pinned value above depends on it.
    expect(round2(1.005)).toBe(1);
    expect(round2(1.015)).toBe(1.01);
    expect(round2(0.145)).toBe(0.14);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0)).toBe(0);
    expect(round2(-1.005)).toBe(-1);

    // Math.round breaks ties toward +Infinity, so negative halves round "up".
    expect(round2(-2.505)).toBe(-2.5);
  });
});

// ---------------------------------------------------------------------------
// 5. Accumulator and version stamp
// ---------------------------------------------------------------------------

describe("accumulators", () => {
  it("emptyCosts is all zeros and independent per call", () => {
    const a = emptyCosts();
    const b = emptyCosts();
    a.totalCost = 99;
    expect(b.totalCost).toBe(0);
    for (const field of COST_FIELDS) expect(b[field]).toBe(0);
  });

  it("addCosts sums every field", () => {
    const target = emptyCosts();
    const one = computeActivityCosts(
      {
        type: "labor",
        quantity: 10,
        labor: { craftConstant: 1, welderConstant: 2 },
      },
      RATES_2020
    );
    addCosts(target, one);
    addCosts(target, one);
    for (const field of COST_FIELDS) {
      expect(target[field]).toBe(one[field] * 2);
    }
  });
});

describe("CALC_VERSION", () => {
  it("is stamped so a future formula change cannot silently re-price old bids", () => {
    // Bumped to 3 when a rate override of 0 stopped meaning "inherit" (D3).
    // Changing this number is the deliberate act that says "prices computed
    // under an older version are not reproducible under this one".
    expect(CALC_VERSION).toBe(3);
  });
});
