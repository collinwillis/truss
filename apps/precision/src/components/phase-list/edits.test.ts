import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  buildPhaseEdit,
  isPhaseCellEditable,
  readPhaseRefusal,
  type PhaseEdit,
  type PhasePatch,
} from "./edits";

/**
 * The rules an estimator's keystrokes are read by.
 *
 * Two of these encode defects that already cost this codebase a fix: a blank
 * stored as `""` instead of clearing the field (4749a03, where a stored empty
 * takeoff unit made an unmeasured phase report a quantity of 0), and a spec
 * edit that carried the five members beside it along.
 */

/** The patch a successful edit produced; fails the test on a refusal. */
function patchOf(edit: PhaseEdit): PhasePatch {
  if (edit.outcome !== "patch") throw new Error(`Expected a patch, got: ${edit.message}`);
  return edit.patch;
}

describe("buildPhaseEdit", () => {
  it("clears a text attribute when the cell is emptied", () => {
    expect(patchOf(buildPhaseEdit("area", ""))).toEqual({ area: null });
    expect(patchOf(buildPhaseEdit("status", ""))).toEqual({ status: null });
  });

  it("reads a whitespace-only cell as a clear, never as a value", () => {
    expect(patchOf(buildPhaseEdit("area", "   "))).toEqual({ area: null });
    expect(patchOf(buildPhaseEdit("unit", " \t "))).toEqual({ takeoffUnit: null });
  });

  it("trims what it stores", () => {
    expect(patchOf(buildPhaseEdit("area", "  NORTH YARD "))).toEqual({ area: "NORTH YARD" });
  });

  it("clears the takeoff unit rather than storing a blank one", () => {
    // The 4749a03 defect: a stored "" makes computePhaseTakeoff report 0 on a
    // phase that has no takeoff at all.
    expect(patchOf(buildPhaseEdit("unit", ""))).toEqual({ takeoffUnit: null });
    expect(patchOf(buildPhaseEdit("unit", "LF"))).toEqual({ takeoffUnit: "LF" });
  });

  it("sends only the spec member that was edited", () => {
    expect(patchOf(buildPhaseEdit("spec", "A106-B"))).toEqual({ pipingSpec: { spec: "A106-B" } });
    expect(patchOf(buildPhaseEdit("sys", "STEAM"))).toEqual({ pipingSpec: { system: "STEAM" } });
    expect(patchOf(buildPhaseEdit("insulation", ""))).toEqual({ pipingSpec: { insulation: null } });
  });

  it("keeps zero as a value and only an empty cell as a clear", () => {
    expect(patchOf(buildPhaseEdit("sheet", "0"))).toEqual({ sheet: 0 });
    expect(patchOf(buildPhaseEdit("sheet", ""))).toEqual({ sheet: null });
    expect(patchOf(buildPhaseEdit("quantity", "0"))).toEqual({ takeoffQuantity: 0 });
    expect(patchOf(buildPhaseEdit("quantity", ""))).toEqual({ takeoffQuantity: null });
    expect(patchOf(buildPhaseEdit("insulationSize", "2.5"))).toEqual({
      pipingSpec: { insulationSize: 2.5 },
    });
    expect(patchOf(buildPhaseEdit("insulationSize", ""))).toEqual({
      pipingSpec: { insulationSize: null },
    });
  });

  it("refuses an empty phase number and an empty description", () => {
    // Neither has an absent state to fall back to, so an emptied cell would
    // store a blank name rather than clear anything.
    expect(buildPhaseEdit("phase", "").outcome).toBe("refused");
    expect(buildPhaseEdit("description", "  ").outcome).toBe("refused");
  });

  it("refuses input a number cell could not read, rather than clearing", () => {
    const rejected = buildPhaseEdit("quantity", "", true);
    expect(rejected.outcome).toBe("refused");
    expect(buildPhaseEdit("sheet", "twelve").outcome).toBe("refused");
    expect(buildPhaseEdit("phase", "abc").outcome).toBe("refused");
  });

  it("sets a phase number and a description", () => {
    expect(patchOf(buildPhaseEdit("phase", "70004"))).toEqual({ phaseNumber: 70004 });
    expect(patchOf(buildPhaseEdit("description", ' 6" CS LINE '))).toEqual({
      description: '6" CS LINE',
    });
  });
});

describe("isPhaseCellEditable", () => {
  const writable = { canEdit: true, hasTakeoff: true };

  it("accepts every attribute the estimator states", () => {
    for (const column of [
      "phase",
      "description",
      "area",
      "status",
      "sheet",
      "size",
      "flc",
      "spec",
      "insulation",
      "insulationSize",
      "sys",
    ]) {
      expect(isPhaseCellEditable(column, writable)).toBe(true);
    }
  });

  it("refuses every column that rolls up from the activities", () => {
    for (const column of [
      "craftHours",
      "craftCost",
      "welderHours",
      "welderCost",
      "laborTotal",
      "materialCost",
      "equipmentCost",
      "subcontractorCost",
      "costOnlyCost",
      "totalCost",
    ]) {
      expect(isPhaseCellEditable(column, writable)).toBe(false);
    }
  });

  it("needs a takeoff before quantity or unit accept typing", () => {
    expect(isPhaseCellEditable("quantity", { canEdit: true, hasTakeoff: false })).toBe(false);
    expect(isPhaseCellEditable("unit", { canEdit: true, hasTakeoff: false })).toBe(false);
    expect(isPhaseCellEditable("quantity", writable)).toBe(true);
    expect(isPhaseCellEditable("unit", writable)).toBe(true);
  });

  it("refuses everything below write permission", () => {
    expect(isPhaseCellEditable("description", { canEdit: false, hasTakeoff: true })).toBe(false);
    expect(isPhaseCellEditable("quantity", { canEdit: false, hasTakeoff: true })).toBe(false);
  });
});

describe("readPhaseRefusal", () => {
  it("names the phase cell when the number is taken", () => {
    const refusal = readPhaseRefusal(
      new ConvexError({
        kind: "phase_number_taken",
        phaseNumber: 70004,
        message: "Phase 70004 already exists in this breakdown. Pick another number.",
      })
    );
    expect(refusal.column).toBe("phase");
    expect(refusal.message).toContain("Pick another number");
  });

  it("names the cell a rejected value came from", () => {
    const refusal = readPhaseRefusal(
      new ConvexError({
        kind: "phase_field_invalid",
        field: "sheet",
        message: "A sheet number cannot be negative, so nothing was saved.",
      })
    );
    expect(refusal.column).toBe("sheet");
    expect(refusal.message).toContain("cannot be negative");
  });

  it("relays anything else without claiming to know a cell", () => {
    const refusal = readPhaseRefusal(new Error("Network request failed"));
    expect(refusal.column).toBeUndefined();
    expect(refusal.message).toBe("Network request failed");
    expect(readPhaseRefusal("not an error").message).toBe("An unexpected error occurred.");
  });
});
