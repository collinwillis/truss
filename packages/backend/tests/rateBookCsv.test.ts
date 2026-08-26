/**
 * The spreadsheet round trip.
 *
 * The property that matters most is stated first and tested against the real
 * 5,897-row catalog: a file exported and re-imported UNTOUCHED must produce
 * exactly zero changes. Any drift between the writer and the reader shows up
 * as phantom edits on rows nobody opened — and an admin who sees 5,897
 * "changes" after touching nothing will never trust the preview again.
 *
 * Everything else here is a hazard Excel actually produces, not a hypothetical.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLUMNS,
  detectDelimiter,
  detectPool,
  hasReplacementChars,
  isIgnoredHeader,
  normalizeHeader,
  parseDelimited,
  parseSheetBoolean,
  parseSheetNumber,
  serialize,
} from "../convex/model/rateBookCsv";

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const laborRows = JSON.parse(readFileSync(join(FIXTURES, "labor_v1.json"), "utf8")) as Array<
  Record<string, unknown>
>;

describe("the round trip is lossless", () => {
  it("survives all 5,897 real labor rows unchanged", () => {
    const headers = COLUMNS.labor;
    const rows = laborRows.map((r) => [
      String(r.id),
      String(r.phaseDatabaseId),
      String(r.description),
      String(r.sortOrder),
      String(r.craftConstant),
      String(r.craftUnits ?? ""),
      String(r.weldConstant),
      String(r.weldUnits ?? ""),
      "FALSE",
      "TRUE",
      "70000",
      "CARBON STEEL",
    ]);

    const csv = serialize(headers, rows);
    const parsed = parseDelimited(csv);

    expect(parsed[0]).toEqual([...headers]);
    expect(parsed.length).toBe(rows.length + 1);
    // Every cell identical, including the 1,196 descriptions containing
    // commas and the ones carrying quotes and ≤ / ≥.
    expect(parsed.slice(1)).toEqual(rows);
  });

  it("preserves descriptions containing commas, quotes and newlines", () => {
    const nasty = [
      ["1", 'FSW - ≤.75", SCH 40'],
      ["2", "CUT, BEVEL & FIT"],
      ["3", "LINE 1\nLINE 2"],
      ["4", 'HE SAID ""HELLO""'],
    ];
    const parsed = parseDelimited(serialize(["id", "description"], nasty));
    expect(parsed.slice(1)).toEqual(nasty);
  });
});

describe("what Excel actually hands us", () => {
  it("strips the BOM rather than making it part of the first header", () => {
    const parsed = parseDelimited("\uFEFFid,name\r\n1,MOBILIZE\r\n");
    expect(parsed[0]).toEqual(["id", "name"]);
  });

  it("reads CRLF and lone CR as line breaks", () => {
    expect(parseDelimited("id,name\r\n1,A\r\n").length).toBe(2);
    expect(parseDelimited("id,name\r1,A\r").length).toBe(2);
  });

  it("finds the delimiter a European Excel used", () => {
    expect(detectDelimiter("id;name;sort_order")).toBe(";");
    expect(detectDelimiter("id,name,sort_order")).toBe(",");
    // A quoted comma inside a header must not win the vote for its own kind.
    expect(detectDelimiter('id;"name, long";sort')).toBe(";");
  });

  it("drops the trailing blank rows Excel appends, but keeps sparse ones", () => {
    const parsed = parseDelimited("id,name\n1,A\n,\n\n");
    // The `,` row is all-empty and goes; nothing else does.
    expect(parsed.length).toBe(2);
    const sparse = parseDelimited("id,name\n1,\n");
    expect(sparse.length).toBe(2);
    expect(sparse[1]).toEqual(["1", ""]);
  });

  it("matches headers however they were capitalised or spaced", () => {
    expect(normalizeHeader("Craft Constant")).toBe("craft_constant");
    expect(normalizeHeader(" CRAFT_CONSTANT ")).toBe("craft_constant");
    expect(normalizeHeader("craft-constant")).toBe("craft_constant");
  });

  it("routes a renamed sheet by its headers, not its filename", () => {
    expect(detectPool(["id", "phase_code", "craft_constant"])).toBe("labor");
    expect(detectPool(["id", "description", "hour_rate"])).toBe("equipment");
    expect(detectPool(["id", "wbs_code", "name", "takeoff_unit"])).toBe("phases");
    // The flag column is a boolean; naming it "reserved_phase_number" would
    // have invited someone to type a phase number into a true/false cell.
    expect(COLUMNS.phases).toContain("fixed_phase_number");
    expect(detectPool(["id", "name", "sort_order"])).toBe("wbs");
    expect(detectPool(["something", "else"])).toBeNull();
  });

  it("ignores decoration and the columns an error file added", () => {
    expect(isIgnoredHeader("ref_wbs_name")).toBe(true);
    expect(isIgnoredHeader("_error_messages")).toBe(true);
    expect(isIgnoredHeader("craft_constant")).toBe(false);
  });
});

describe("numbers as a spreadsheet writes them", () => {
  it("reads the ordinary cases", () => {
    expect(parseSheetNumber("0.6", "craft_constant")).toEqual({ ok: true, value: 0.6 });
    expect(parseSheetNumber(" 12 ", "day_rate")).toEqual({ ok: true, value: 12 });
    expect(parseSheetNumber("6.0E-01", "craft_constant")).toEqual({ ok: true, value: 0.6 });
  });

  it("handles currency, parenthesised negatives and valid thousands", () => {
    expect(parseSheetNumber("$1,234.00", "month_rate")).toEqual({ ok: true, value: 1234 });
    expect(parseSheetNumber("(5)", "day_rate")).toEqual({ ok: true, value: -5 });
  });

  it("REFUSES misgrouped thousands rather than silently dropping a comma", () => {
    // "1,23.00" becoming 123 would be a 10x pricing error nobody would catch.
    const result = parseSheetNumber("1,23.00", "day_rate");
    expect(result.ok).toBe(false);
  });

  it("names the letter-O typo specifically, because that is the real one", () => {
    const result = parseSheetNumber("O.6", "craft_constant");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("letter O");
  });

  it("treats blank as absent rather than zero", () => {
    // On an existing row this means "leave it alone" — the same
    // absence-inherits rule the rate overrides already use.
    expect(parseSheetNumber("", "craft_constant")).toEqual({ ok: true, value: null });
  });

  it("refuses percentages and stray text", () => {
    expect(parseSheetNumber("15%", "craft_constant").ok).toBe(false);
    expect(parseSheetNumber("n/a", "craft_constant").ok).toBe(false);
  });
});

describe("booleans and mangled text", () => {
  it("accepts every spelling a person types", () => {
    for (const yes of ["TRUE", "true", "1", "Yes", "y", "X", "✓"]) {
      expect(parseSheetBoolean(yes, false)).toBe(true);
    }
    for (const no of ["FALSE", "0", "no", "N"]) {
      expect(parseSheetBoolean(no, true)).toBe(false);
    }
  });

  it("falls back per column when the cell is blank", () => {
    // `active` defaults true; `counts_toward_takeoff` defaults false.
    expect(parseSheetBoolean("", true)).toBe(true);
    expect(parseSheetBoolean("", false)).toBe(false);
  });

  it("spots a file saved as plain CSV instead of CSV UTF-8", () => {
    // ≤ and ≥ both become the replacement char, so two different pipe sizes
    // collapse into one description. Invisible to whoever saved it.
    expect(hasReplacementChars("FSW - �.75")).toBe(true);
    expect(hasReplacementChars("FSW - ≤.75")).toBe(false);
  });
});
