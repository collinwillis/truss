/**
 * Turning a spreadsheet line into a validated change.
 *
 * The blank rule is the one worth reading twice, because it is asymmetric and
 * the asymmetry is deliberate: on an EXISTING row a blank number means "leave
 * it alone", matching the absence-inherits rule the per-line rate overrides
 * already use; on a NEW row it is an error, because there is nothing to
 * inherit and silently writing 0 would price real work at nothing.
 */
import { describe, expect, it } from "vitest";
import { shapeRow, toRawRows, changedFields, type RawRow } from "../convex/model/rateBookRows";

const laborRow = (cells: Record<string, string>): RawRow => ({
  rowNumber: 2,
  cells: {
    id: "",
    phase_code: "70001",
    description: "FSW - ≤.75",
    sort_order: "10",
    craft_constant: "0.6",
    craft_units: "LF",
    weld_constant: "0.6",
    weld_units: "LF",
    counts_toward_takeoff: "FALSE",
    active: "TRUE",
    ...cells,
  },
});

describe("the blank rule", () => {
  it("keeps the stored value when a number is blank on an existing row", () => {
    const shaped = shapeRow("labor", laborRow({ id: "2738", craft_constant: "" }), false);
    expect(shaped.errors).toEqual([]);
    // Not written at all, so the stored value survives untouched.
    expect(shaped.values.craftConstant).toBeUndefined();
    // And it is REPORTED, because the failure mode is otherwise invisible —
    // someone who clears a cell with Delete gets nothing and concludes the
    // tool is broken.
    expect(shaped.keptBlank).toContain("craft_constant");
  });

  it("refuses a blank number on a new row, and says to type 0", () => {
    const shaped = shapeRow("labor", laborRow({ id: "", craft_constant: "" }), true);
    expect(shaped.errors.join(" ")).toContain("Type 0");
  });

  it("treats an explicit 0 as a real value on both", () => {
    for (const isNew of [true, false]) {
      const shaped = shapeRow("labor", laborRow({ craft_constant: "0" }), isNew);
      expect(shaped.values.craftConstant).toBe(0);
      expect(shaped.keptBlank).not.toContain("craft_constant");
    }
  });

  it("keeps blank TEXT as empty text, because that is a real value", () => {
    // weld_units is legitimately empty on 4,149 of 5,897 rows.
    const shaped = shapeRow("labor", laborRow({ weld_constant: "0", weld_units: "" }), false);
    expect(shaped.values.weldUnits).toBe("");
    expect(shaped.errors).toEqual([]);
  });
});

describe("what it refuses", () => {
  it("blocks a description mangled by saving as plain CSV", () => {
    const shaped = shapeRow("labor", laborRow({ description: "FSW - �.75" }), false);
    expect(shaped.errors.join(" ")).toContain("CSV UTF-8");
  });

  it("blocks a weld constant with no weld unit", () => {
    const shaped = shapeRow("labor", laborRow({ weld_constant: "0.6", weld_units: "" }), false);
    expect(shaped.errors.join(" ")).toContain("weld unit");
  });

  it("blocks a negative rate", () => {
    const shaped = shapeRow(
      "equipment",
      {
        rowNumber: 2,
        cells: {
          id: "5",
          description: "AIR BREAKER",
          hour_rate: "7",
          day_rate: "-56",
          week_rate: "224",
          month_rate: "672",
          sort_order: "1",
          active: "TRUE",
        },
      },
      false
    );
    expect(shaped.errors.join(" ")).toContain("cannot be negative");
  });

  it("requires a name, and caps a runaway one", () => {
    expect(shapeRow("labor", laborRow({ description: "" }), false).errors.join(" ")).toContain(
      "required"
    );
    expect(
      shapeRow("labor", laborRow({ description: "X".repeat(201) }), false).errors.join(" ")
    ).toContain("longer than");
  });

  it("requires the parent scope, so a row cannot land nowhere", () => {
    expect(shapeRow("labor", laborRow({ phase_code: "" }), false).errors.join(" ")).toContain(
      "phase_code is required"
    );
  });

  it("refuses a non-integer id rather than rounding it", () => {
    expect(shapeRow("labor", laborRow({ id: "27.5" }), false).errors.join(" ")).toContain(
      "whole number"
    );
  });
});

describe("reading the sheet", () => {
  it("keys cells by normalized header and numbers rows as Excel does", () => {
    const { headers, rows } = toRawRows([
      ["id", "Craft Constant", "ref_wbs_name"],
      ["1", "0.6", "AG PIPING"],
    ]);
    expect(headers).toEqual(["id", "craft_constant", "ref_wbs_name"]);
    // Row 2 is the first body line, because row 1 is the header — that is
    // what the admin sees in Excel's gutter.
    expect(rows[0]?.rowNumber).toBe(2);
    expect(rows[0]?.cells.craft_constant).toBe("0.6");
    // Decoration is dropped rather than carried into the values.
    expect(rows[0]?.cells.ref_wbs_name).toBeUndefined();
  });

  it("treats a blank id as an addition", () => {
    expect(shapeRow("labor", laborRow({ id: "" }), true).declaredId).toBeUndefined();
    expect(shapeRow("labor", laborRow({ id: "2738" }), false).declaredId).toBe(2738);
  });
});

describe("what actually changed", () => {
  it("reports only the fields that differ", () => {
    const changed = changedFields(
      { craftConstant: 0.7, craftUnits: "LF", isActive: true },
      { craftConstant: 0.6, craftUnits: "LF", isActive: true }
    );
    expect(changed).toEqual(["craftConstant"]);
  });

  it("reports nothing for an untouched row", () => {
    const values = { craftConstant: 0.6, craftUnits: "LF" };
    expect(changedFields(values, { ...values })).toEqual([]);
  });
});
