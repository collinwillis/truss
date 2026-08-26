/**
 * Column-visibility rules.
 *
 * These encode InDemand's own template plus the data gate, and they shipped a
 * real defect: an OR where an AND belonged, which showed Material, Equipment
 * and the rate columns on a labor-only phase — a wall of dashes pushing the
 * numbers that matter off screen. Every case below is one an estimator can
 * actually land on.
 */
import { describe, expect, it } from "vitest";
import { autoVisibility, mergeVisibility, pruneOverrides, summarizeContents } from "./visibility";

const AG_PIPING = 70000;
const SUPPORT = 200000;

const rows = (...types: Array<[string, boolean?]>) =>
  summarizeContents(
    types.map(([type, eligible]) => ({
      type: type as Parameters<typeof summarizeContents>[0][number]["type"],
      canOverrideRates: eligible ?? false,
    }))
  );

describe("the data gate", () => {
  it("hides every type column a labor-only phase has no lines for", () => {
    const v = autoVisibility(AG_PIPING, rows(["labor"], ["labor"]));

    // The exact phase from the bug report.
    expect(v.materialCost).toBe(false);
    expect(v.equipmentCost).toBe(false);
    expect(v.subcontractorCost).toBe(false);
    expect(v.costOnlyCost).toBe(false);
    expect(v.time).toBe(false);
    expect(v.price).toBe(false);
    expect(v.ownership).toBe(false);
    // Labor columns are exactly what it DOES need.
    expect(v.craftConstant).toBe(true);
    expect(v.craftCost).toBe(true);
  });

  it("keeps the derivable and the constant columns quiet by default", () => {
    const v = autoVisibility(AG_PIPING, rows(["labor"], ["labor"]));
    // Man-hours are quantity x the constant two columns left; Weld Rate has
    // no per-line override, so it prints one value down the whole column;
    // Type is in neither the template nor the legacy grid. All recoverable
    // from the column menu — see the override tests below.
    expect(v.craftManHours).toBe(false);
    expect(v.welderManHours).toBe(false);
    expect(v.welderRate).toBe(false);
    expect(v.type).toBe(false);
  });

  it("reveals equipment columns as soon as the phase holds one equipment line", () => {
    const v = autoVisibility(AG_PIPING, rows(["labor"], ["equipment"]));

    // The template hides these for AG PIPING, but a line that needs them
    // outranks that — otherwise its duration would be unreachable.
    expect(v.time).toBe(true);
    expect(v.ownership).toBe(true);
    expect(v.equipmentCost).toBe(true);
    expect(v.price).toBe(true);
    expect(v.materialCost).toBe(false);
  });

  it("treats a subcontractor line as needing the material and equipment buckets", () => {
    const v = autoVisibility(AG_PIPING, rows(["subcontractor"]));
    expect(v.materialCost).toBe(true);
    expect(v.equipmentCost).toBe(true);
    expect(v.subcontractorCost).toBe(true);
  });

  it("shows the rate columns only where D6 makes a line eligible", () => {
    expect(autoVisibility(AG_PIPING, rows(["labor", false])).craftRate).toBe(false);
    expect(autoVisibility(SUPPORT, rows(["custom_labor", true])).craftRate).toBe(true);
    expect(autoVisibility(SUPPORT, rows(["custom_labor", true])).subsistenceRate).toBe(true);
  });
});

describe("the template layer", () => {
  it("hides welder on SUPPORT even though its lines are labor", () => {
    // The one rule the data cannot derive: SUPPORT is standby roles, and
    // nobody welds. (Legacy had this on 20000 — a missing zero.)
    const v = autoVisibility(SUPPORT, rows(["custom_labor", true]));
    expect(v.welderConstant).toBe(false);
    expect(v.welderManHours).toBe(false);
    expect(v.welderCost).toBe(false);
    expect(v.welderRate).toBe(false);
  });

  it("keeps welder on SITE PREPARATION, where legacy's typo hid it", () => {
    const v = autoVisibility(20000, rows(["labor"]));
    expect(v.welderConstant).toBe(true);
    expect(v.welderCost).toBe(true);
  });
});

describe("the estimator's overrides", () => {
  it("wins over the automatic answer in both directions", () => {
    const auto = autoVisibility(AG_PIPING, rows(["labor"]));
    const merged = mergeVisibility(auto, { materialCost: true, craftConstant: false });
    expect(merged.materialCost).toBe(true);
    expect(merged.craftConstant).toBe(false);
    // A quiet-by-default column is one click from coming back.
    expect(mergeVisibility(auto, { craftManHours: true }).craftManHours).toBe(true);
  });

  it("stores only what disagrees, so untouched columns keep following the data", () => {
    const auto = autoVisibility(AG_PIPING, rows(["labor"]));
    // The user turned Material ON and left everything else alone.
    const pruned = pruneOverrides(auto, mergeVisibility(auto, { materialCost: true }));
    expect(pruned).toEqual({ materialCost: true });

    // Later an equipment line arrives: Equipment must appear on its own,
    // which it can only do because it was never "chosen".
    const withEquipment = autoVisibility(AG_PIPING, rows(["labor"], ["equipment"]));
    expect(mergeVisibility(withEquipment, pruned).equipmentCost).toBe(true);
  });

  it("drops an override once the automatic answer agrees with it", () => {
    const auto = autoVisibility(AG_PIPING, rows(["labor"], ["material"]));
    // Material is already shown by the data, so choosing "show" is not a choice.
    expect(pruneOverrides(auto, mergeVisibility(auto, { materialCost: true }))).toEqual({});
  });
});
