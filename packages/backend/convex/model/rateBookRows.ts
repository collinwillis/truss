import {
  hasReplacementChars,
  isIgnoredHeader,
  normalizeHeader,
  parseSheetBoolean,
  parseSheetNumber,
  type PoolKind,
} from "./rateBookCsv";

/**
 * Turning one spreadsheet line into a validated catalog change.
 *
 * Pure, so every rule below is testable without a database — and the rules are
 * where the money is:
 *
 *  - **Blank in a number column means KEEP on an existing row.** The same
 *    absence-inherits rule the per-line rate overrides already use, so the app
 *    has one rule rather than two. On a NEW row blank is an error, because
 *    there is nothing to inherit from and silently writing 0 would price real
 *    work at nothing.
 *  - **A blank id means "add this".** An id that was never issued is refused
 *    rather than created at the caller's chosen number, because caller-chosen
 *    ids are exactly how ids get re-pointed.
 *  - **Replacement characters block.** A file saved as plain CSV instead of
 *    CSV UTF-8 turns `≤` and `≥` into the same `?`, collapsing two different
 *    pipe sizes into one description, invisibly to whoever saved it.
 */

export interface RawRow {
  /** 1-based line number in their file, header excluded. */
  rowNumber: number;
  cells: Record<string, string>;
}

export type FieldValue = string | number | boolean;

export interface ShapedRow {
  rowNumber: number;
  declaredId?: number;
  description: string;
  /** Parent scope: phase code for labor, wbs code for phases. */
  parentPoolId?: number;
  values: Record<string, FieldValue>;
  /** Numeric columns intentionally left blank on an existing row. */
  keptBlank: string[];
  errors: string[];
}

/** Map a parsed sheet into cell dictionaries keyed by normalized header. */
export function toRawRows(rows: readonly (readonly string[])[]): {
  headers: string[];
  rows: RawRow[];
} {
  const [headerRow = [], ...body] = rows;
  const headers = headerRow.map(normalizeHeader);
  return {
    headers,
    rows: body.map((cells, index) => {
      const record: Record<string, string> = {};
      headers.forEach((header, i) => {
        if (!isIgnoredHeader(header)) record[header] = cells[i] ?? "";
      });
      return { rowNumber: index + 2, cells: record };
    }),
  };
}

interface NumericSpec {
  column: string;
  field: string;
  /** Rates and constants are never negative; a minus sign is a typo. */
  nonNegative?: boolean;
}

const NUMERIC: Record<PoolKind, NumericSpec[]> = {
  wbs: [{ column: "sort_order", field: "sortOrder" }],
  phases: [{ column: "sort_order", field: "sortOrder" }],
  labor: [
    { column: "sort_order", field: "sortOrder" },
    { column: "craft_constant", field: "craftConstant", nonNegative: true },
    { column: "weld_constant", field: "weldConstant", nonNegative: true },
  ],
  equipment: [
    { column: "sort_order", field: "sortOrder" },
    { column: "hour_rate", field: "hourRate", nonNegative: true },
    { column: "day_rate", field: "dayRate", nonNegative: true },
    { column: "week_rate", field: "weekRate", nonNegative: true },
    { column: "month_rate", field: "monthRate", nonNegative: true },
  ],
};

const TEXT: Record<PoolKind, Array<{ column: string; field: string }>> = {
  wbs: [{ column: "name", field: "name" }],
  phases: [
    { column: "name", field: "name" },
    { column: "takeoff_unit", field: "takeoffUnit" },
  ],
  labor: [
    { column: "description", field: "description" },
    { column: "craft_units", field: "craftUnits" },
    { column: "weld_units", field: "weldUnits" },
  ],
  equipment: [{ column: "description", field: "description" }],
};

/** The column carrying the row's own name, per pool. */
const NAME_COLUMN: Record<PoolKind, string> = {
  wbs: "name",
  phases: "name",
  labor: "description",
  equipment: "description",
};

const MAX_DESCRIPTION = 200;

/**
 * Validate and coerce one line.
 *
 * `isNew` decides the blank rule, so the caller must resolve the match first —
 * which is deliberate: whether a blank means "keep" or "you forgot something"
 * genuinely depends on whether there is anything to keep.
 */
export function shapeRow(pool: PoolKind, raw: RawRow, isNew: boolean): ShapedRow {
  const errors: string[] = [];
  const values: Record<string, FieldValue> = {};
  const keptBlank: string[] = [];
  const cell = (name: string) => (raw.cells[name] ?? "").trim();

  // ── Identity ──
  let declaredId: number | undefined;
  const idText = cell("id");
  if (idText !== "") {
    const parsed = parseSheetNumber(idText, "id");
    if (!parsed.ok) errors.push(parsed.error);
    else if (parsed.value === null || !Number.isInteger(parsed.value)) {
      errors.push(`Row ${raw.rowNumber}: id "${idText}" is not a whole number.`);
    } else declaredId = parsed.value;
  }

  // ── The name ──
  const nameColumn = NAME_COLUMN[pool];
  const description = cell(nameColumn);
  if (description === "") {
    errors.push(`Row ${raw.rowNumber}: ${nameColumn} is required.`);
  } else if (description.length > MAX_DESCRIPTION) {
    errors.push(
      `Row ${raw.rowNumber}: ${nameColumn} is longer than ${MAX_DESCRIPTION} characters.`
    );
  } else if (hasReplacementChars(description)) {
    // Blocking on purpose: silently destroys the meaning of up to 509 rows.
    errors.push(
      `Row ${raw.rowNumber}: "${description}" contains a character that did not survive saving. ` +
        `Save the file as "CSV UTF-8 (Comma delimited)", not plain CSV.`
    );
  }

  // ── Parent scope ──
  let parentPoolId: number | undefined;
  const parentColumn = pool === "labor" ? "phase_code" : pool === "phases" ? "wbs_code" : null;
  if (parentColumn) {
    const parsed = parseSheetNumber(cell(parentColumn), parentColumn);
    if (!parsed.ok) errors.push(parsed.error);
    else if (parsed.value === null) {
      errors.push(`Row ${raw.rowNumber}: ${parentColumn} is required.`);
    } else parentPoolId = parsed.value;
  }

  // ── Numbers ──
  for (const spec of NUMERIC[pool]) {
    const text = cell(spec.column);
    const parsed = parseSheetNumber(text, spec.column);
    if (!parsed.ok) {
      errors.push(`Row ${raw.rowNumber}: ${parsed.error}`);
      continue;
    }
    if (parsed.value === null) {
      if (isNew && spec.column !== "sort_order") {
        errors.push(
          `Row ${raw.rowNumber}: ${spec.column} is required on a new row. Type 0 if the value really is zero.`
        );
      } else if (!isNew) {
        keptBlank.push(spec.column);
      }
      continue;
    }
    if (spec.nonNegative && parsed.value < 0) {
      errors.push(`Row ${raw.rowNumber}: ${spec.column} cannot be negative.`);
      continue;
    }
    values[spec.field] = parsed.value;
  }

  // ── Text ──
  for (const spec of TEXT[pool]) {
    const text = cell(spec.column);
    // Blank text IS a value: weld_units is legitimately empty on 4,149 rows.
    values[spec.field] = text;
  }

  // ── Flags ──
  values.isActive = parseSheetBoolean(cell("active"), true);
  if (pool === "labor") {
    values.countsTowardTakeoff = parseSheetBoolean(cell("counts_toward_takeoff"), false);
  }
  if (pool === "phases") {
    values.reservedPhaseNumber = parseSheetBoolean(cell("fixed_phase_number"), false);
  }
  if (parentPoolId !== undefined) {
    values[pool === "labor" ? "phasePoolId" : "wbsPoolId"] = parentPoolId;
  }

  // ── Cross-field ──
  if (pool === "labor") {
    const weld = values.weldConstant;
    const units = values.weldUnits;
    if (typeof weld === "number" && weld > 0 && units === "") {
      errors.push(
        `Row ${raw.rowNumber}: a weld constant of ${weld} needs a weld unit — the hours would have nothing to multiply.`
      );
    }
  }

  return {
    rowNumber: raw.rowNumber,
    declaredId,
    description,
    parentPoolId,
    values,
    keptBlank,
    errors,
  };
}

/** Units seen across the real catalog; anything else is worth a second look. */
export const KNOWN_CRAFT_UNITS = new Set([
  "EA",
  "LF",
  "SF",
  "TON",
  "CY",
  "WEEK",
  "DAY",
  "CF",
  "SHIFT",
  "LOAD",
  "SY",
  "CRAFT",
  "SET",
  "PAIR",
]);
export const KNOWN_WELD_UNITS = new Set(["", "EA", "WELDER", "LF", "SHIFT"]);

/** Which fields actually differ from what is stored. */
export function changedFields(
  values: Record<string, FieldValue>,
  current: Record<string, unknown>
): string[] {
  return Object.keys(values).filter((key) => values[key] !== current[key]);
}
