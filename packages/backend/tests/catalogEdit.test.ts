/**
 * The catalog screen's rules, against the catalog it will actually edit.
 *
 * Two of these tests exist to defend a NUMBER rather than a behaviour. The
 * rounding scale a percentage adjustment uses is the difference between "+3%
 * on 412 rows" being true and being a claim the run report makes falsely, and
 * the only way to know which is to run it over all 5,897 real labor rows and
 * all 129 real equipment rows and count what did not move.
 *
 * The other load-bearing one is the field-set cross-check. `CATALOG_FIELDS`
 * and `beforeOf` describe the same thing from two sides — what a row consists
 * of — and if they ever disagree the grid renders a cell nobody can save, or
 * refuses to save one the importer writes freely. Neither failure is visible
 * in a unit test of either function alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PoolKind } from "../convex/model/rateBookCsv";
import { beforeOf, type PoolRow } from "../convex/model/rateBookShape";
import {
  adjustByPercent,
  CATALOG_FIELDS,
  CATALOG_NAME_FIELD,
  CATALOG_PARENT_FIELD,
  checkAdjustPercent,
  checkFieldValue,
  checkNewRow,
  checkRowInvariants,
  CONSTANT_DECIMALS,
  editableField,
  isAdjustable,
  matchesCatalogFilter,
  MONEY_DECIMALS,
} from "../convex/model/catalogEdit";

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const read = (file: string) =>
  JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Array<Record<string, unknown>>;

/** One representative stored row per pool, for the `beforeOf` cross-check. */
const SAMPLE: Record<PoolKind, PoolRow> = {
  wbs: {
    _id: "wbs1",
    _creationTime: 0,
    datasetVersion: "v1",
    poolId: 70000,
    name: "AG PIPING",
    sortOrder: 10,
    isCustom: false,
    isActive: true,
  } as unknown as PoolRow,
  phases: {
    _id: "phase1",
    _creationTime: 0,
    datasetVersion: "v1",
    poolId: 70001,
    wbsPoolId: 70000,
    name: "CARBON STEEL - A106/A53 (SCH 10/40)",
    sortOrder: 10,
    takeoffUnit: "LF",
    reservedPhaseNumber: false,
    isCustom: false,
    isActive: true,
  } as unknown as PoolRow,
  labor: {
    _id: "labor1",
    _creationTime: 0,
    datasetVersion: "v1",
    poolId: 2738,
    phasePoolId: 70001,
    description: "FSW - ≤.75",
    sortOrder: 10,
    craftConstant: 0.6,
    craftUnits: "LF",
    weldConstant: 0.6,
    weldUnits: "EA",
    countsTowardTakeoff: false,
    isCustom: false,
    isActive: true,
  } as unknown as PoolRow,
  equipment: {
    _id: "equip1",
    _creationTime: 0,
    datasetVersion: "v1",
    poolId: 1,
    description: "AIR TOOLS - AIR COMPRESSOR 0-185 CFM",
    hourRate: 8,
    dayRate: 64,
    weekRate: 256,
    monthRate: 768,
    sortOrder: 10,
    isCustom: false,
    isActive: true,
  } as unknown as PoolRow,
};

const POOLS: PoolKind[] = ["wbs", "phases", "labor", "equipment"];

/** Decimal places in a number's shortest round-tripping representation. */
function decimals(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

describe("the editable field set", () => {
  it("is exactly what a row consists of, minus what is not a cell edit", () => {
    for (const pool of POOLS) {
      const stored = Object.keys(beforeOf(pool, SAMPLE[pool])).sort();
      const notCells = new Set(["isActive", CATALOG_PARENT_FIELD[pool]]);
      const expected = stored.filter((field) => !notCells.has(field));
      expect(CATALOG_FIELDS[pool].map((spec) => spec.field).sort()).toEqual(expected);
    }
  });

  it("keeps retirement and re-parenting out of the grid", () => {
    for (const pool of POOLS) {
      expect(editableField(pool, "isActive")).toBeUndefined();
      const parent = CATALOG_PARENT_FIELD[pool];
      if (parent !== null) expect(editableField(pool, parent)).toBeUndefined();
    }
  });

  it("names the field each pool actually stores its name in", () => {
    for (const pool of POOLS) {
      expect(Object.keys(beforeOf(pool, SAMPLE[pool]))).toContain(CATALOG_NAME_FIELD[pool]);
    }
  });

  it("lets a percentage move constants and rates, and nothing else", () => {
    expect(isAdjustable("labor", "craftConstant")).toBe(true);
    expect(isAdjustable("labor", "weldConstant")).toBe(true);
    expect(isAdjustable("equipment", "monthRate")).toBe(true);
    expect(isAdjustable("labor", "sortOrder")).toBe(false);
    expect(isAdjustable("labor", "craftUnits")).toBe(false);
    expect(isAdjustable("wbs", "sortOrder")).toBe(false);
  });
});

describe("checkFieldValue", () => {
  const craft = editableField("labor", "craftConstant");
  const units = editableField("labor", "craftUnits");
  const takeoff = editableField("labor", "countsTowardTakeoff");
  const sortOrder = editableField("labor", "sortOrder");

  it("refuses a number that is not one", () => {
    expect(craft && checkFieldValue(craft, "0.6")).toEqual({
      ok: false,
      error: "craftConstant must be a number.",
    });
    expect(craft && checkFieldValue(craft, Number.NaN).ok).toBe(false);
    expect(craft && checkFieldValue(craft, Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("refuses a negative constant, because a minus sign is a typo", () => {
    expect(craft && checkFieldValue(craft, -0.6)).toEqual({
      ok: false,
      error: "craftConstant cannot be negative.",
    });
    expect(craft && checkFieldValue(craft, 0)).toEqual({ ok: true, value: 0 });
  });

  it("refuses a fractional sort order", () => {
    expect(sortOrder && checkFieldValue(sortOrder, 2.5).ok).toBe(false);
    expect(sortOrder && checkFieldValue(sortOrder, 20)).toEqual({ ok: true, value: 20 });
  });

  it("trims text and hands back what it checked", () => {
    expect(units && checkFieldValue(units, "  LF  ")).toEqual({ ok: true, value: "LF" });
  });

  it("refuses text that lost a character on the way in", () => {
    const description = editableField("labor", "description");
    const result = description && checkFieldValue(description, "FSW - �.75");
    expect(result && result.ok).toBe(false);
  });

  it("refuses text past the field's length", () => {
    const description = editableField("labor", "description");
    const result = description && checkFieldValue(description, "X".repeat(201));
    expect(result && result.ok).toBe(false);
  });

  it("refuses a flag that is not one", () => {
    expect(takeoff && checkFieldValue(takeoff, "TRUE").ok).toBe(false);
    expect(takeoff && checkFieldValue(takeoff, true)).toEqual({ ok: true, value: true });
  });
});

describe("checkRowInvariants", () => {
  it("refuses a weld constant with no unit to multiply", () => {
    const errors = checkRowInvariants("labor", {
      description: "FSW",
      weldConstant: 0.6,
      weldUnits: "",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("weld unit");
  });

  it("allows a blank weld unit when there is no weld constant", () => {
    expect(
      checkRowInvariants("labor", { description: "FSW", weldConstant: 0, weldUnits: "" })
    ).toEqual([]);
  });

  it("refuses a row with no name", () => {
    expect(checkRowInvariants("equipment", { description: "   " })).toHaveLength(1);
    expect(checkRowInvariants("phases", { name: "CARBON STEEL" })).toEqual([]);
  });
});

describe("checkNewRow", () => {
  const laborRow = {
    description: "  FSW - NEW  ",
    craftConstant: 0.5,
    craftUnits: "LF",
    weldConstant: 0,
    weldUnits: "",
    countsTowardTakeoff: false,
  };

  it("refuses a missing number rather than writing a zero", () => {
    const result = checkNewRow("labor", { ...laborRow, craftConstant: undefined as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("craftConstant is required");
  });

  it("treats blank text and an unticked flag as real answers", () => {
    const result = checkNewRow("labor", {
      description: "FSW - NEW",
      craftConstant: 0.5,
      craftUnits: "LF",
      weldConstant: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.weldUnits).toBe("");
      expect(result.values.countsTowardTakeoff).toBe(false);
    }
  });

  it("lets the server place the row, so sortOrder may be absent", () => {
    const result = checkNewRow("labor", laborRow);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.sortOrder).toBeUndefined();
  });

  it("refuses a column the pool does not have", () => {
    const result = checkNewRow("equipment", {
      description: "TRENCHER",
      hourRate: 1,
      dayRate: 8,
      weekRate: 32,
      monthRate: 96,
      craftConstant: 0.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("craftConstant");
  });

  it("hands back the trimmed values it checked", () => {
    const result = checkNewRow("labor", laborRow);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.description).toBe("FSW - NEW");
  });
});

describe("checkAdjustPercent", () => {
  it("refuses a percentage that would do nothing or everything", () => {
    expect(checkAdjustPercent(0).ok).toBe(false);
    expect(checkAdjustPercent(-100).ok).toBe(false);
    expect(checkAdjustPercent(1001).ok).toBe(false);
    expect(checkAdjustPercent(Number.NaN).ok).toBe(false);
  });

  it("allows a rate change somebody would actually make", () => {
    expect(checkAdjustPercent(3).ok).toBe(true);
    expect(checkAdjustPercent(-5.5).ok).toBe(true);
  });
});

describe("adjustByPercent", () => {
  it("does not leave binary noise in the catalog", () => {
    // 0.6 * 1.03 is 0.6180000000000001 before it is rounded.
    expect(adjustByPercent(0.6, 3, CONSTANT_DECIMALS)).toBe(0.618);
  });

  it("moves the smallest constant in the catalog", () => {
    expect(adjustByPercent(0.01, 3, CONSTANT_DECIMALS)).toBe(0.0103);
  });

  it("lands money on the cent", () => {
    expect(adjustByPercent(8, 3, MONEY_DECIMALS)).toBe(8.24);
    expect(adjustByPercent(6.25, 3, MONEY_DECIMALS)).toBe(6.44);
    expect(adjustByPercent(7.5, -10, MONEY_DECIMALS)).toBe(6.75);
  });

  it("leaves a zero at zero, whatever the percentage", () => {
    expect(adjustByPercent(0, 3, MONEY_DECIMALS)).toBe(0);
    expect(adjustByPercent(0, -50, CONSTANT_DECIMALS)).toBe(0);
  });
});

describe("the rounding scales, measured on the real catalog", () => {
  const labor = read("labor_v1.json");
  const equipment = read("equipment_v1.json");

  it("moves every non-zero constant in all 5,897 labor rows at +3%", () => {
    const constants = labor
      .flatMap((row) => [Number(row.craftConstant), Number(row.weldConstant)])
      .filter((value) => Number.isFinite(value) && value > 0);
    expect(constants.length).toBeGreaterThan(5000);

    const stuck = constants.filter(
      (value) => adjustByPercent(value, 3, CONSTANT_DECIMALS) === value
    );
    expect(stuck).toEqual([]);
  });

  it("is why the scale is four places and not two", () => {
    // The catalog stores constants at two decimals, so rounding an adjustment
    // back to two would move nothing at all below 0.167 — and there are real
    // rows down at 0.01. A run reporting "+3% on 412 rows" would be lying
    // about every one of them.
    const constants = labor
      .flatMap((row) => [Number(row.craftConstant), Number(row.weldConstant)])
      .filter((value) => Number.isFinite(value) && value > 0);
    const stuckAtTwo = constants.filter((value) => adjustByPercent(value, 3, 2) === value);
    expect(stuckAtTwo.length).toBeGreaterThan(0);
  });

  it("moves every non-zero equipment rate at +3% and leaves zeroes alone", () => {
    const rates = equipment.flatMap((row) =>
      ["hourRate", "dayRate", "weekRate", "monthRate"].map((key) => Number(row[key]))
    );
    expect(rates.length).toBe(129 * 4);

    for (const rate of rates) {
      const next = adjustByPercent(rate, 3, MONEY_DECIMALS);
      if (rate === 0) expect(next).toBe(0);
      else expect(next).toBeGreaterThan(rate);
      expect(decimals(next)).toBeLessThanOrEqual(MONEY_DECIMALS);
    }
  });

  it("never writes a constant with more precision than the scale allows", () => {
    for (const row of labor) {
      const craft = Number(row.craftConstant);
      if (!Number.isFinite(craft)) continue;
      expect(decimals(adjustByPercent(craft, 3, CONSTANT_DECIMALS))).toBeLessThanOrEqual(
        CONSTANT_DECIMALS
      );
    }
  });
});

describe("matchesCatalogFilter", () => {
  const row = { description: "FSW - ≤.75", poolId: 2738 };

  it("matches everything when nothing is typed", () => {
    expect(matchesCatalogFilter(row, "")).toBe(true);
    expect(matchesCatalogFilter(row, "   ")).toBe(true);
  });

  it("ignores case", () => {
    expect(matchesCatalogFilter(row, "fsw")).toBe(true);
  });

  it("finds a row somebody cannot type the character for", () => {
    // `≤` is on 509 real descriptions and on nobody's keyboard, so the ASCII
    // spelling has to reach it. The en-dash case is Excel's autocorrect
    // turning " - " into " – " in whatever the admin pasted from.
    expect(matchesCatalogFilter(row, "<=.75")).toBe(true);
    expect(matchesCatalogFilter(row, "FSW – ≤.75")).toBe(true);
    expect(matchesCatalogFilter(row, "fsw - <=.75")).toBe(true);
  });

  it("answers 'what is 2738' exactly, and not with two hundred rows", () => {
    expect(matchesCatalogFilter(row, "2738")).toBe(true);
    expect(matchesCatalogFilter(row, "27")).toBe(false);
  });

  it("says no when it means no", () => {
    expect(matchesCatalogFilter(row, "BUTT WELD")).toBe(false);
  });
});
