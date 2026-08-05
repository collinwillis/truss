import { hasReplacementChars, type PoolKind } from "./rateBookCsv";
import { normalizeKey } from "./rateBookMatch";
import type { FieldValue } from "./rateBookRows";

/**
 * What a person may change about one catalog row, typed rather than spelled.
 *
 * ⚠️ THIS IS THE SIBLING OF `shapeRow`, NOT A SECOND COPY OF IT. `shapeRow`
 * owns the CELL rules — reading `1,234` and `(5)` and a letter O out of a
 * spreadsheet, and deciding what a blank means. By the time a value reaches
 * this module it is already a string, a number or a boolean, because it came
 * from a form control rather than from Excel. What is left is the rules that
 * are about the VALUE: what may be edited at all, what may not be negative,
 * and what a row must still be true of once the edit lands. Where the two
 * overlap they must agree, and `catalogEdit.test.ts` asserts the field set
 * here matches `beforeOf` exactly.
 *
 * ⚠️ ROUNDING BELONGS TO THE ADJUSTMENT, NOT TO THE FIELD. A typed edit is
 * stored exactly as typed — the importer accepts any precision a sheet
 * carries, and a grid that silently truncated 0.123456 while the CSV kept it
 * would make the two paths disagree about the same catalog. A percentage
 * MANUFACTURES precision nobody typed (0.6 × 1.03 is 0.6180000000000001 in
 * binary), so `adjustDecimals` exists on the fields a percentage may touch and
 * nowhere else.
 *
 * Pure, so the whole table is unit-tested in plain Node.
 */

/** How a value is carried, which decides how it is checked. */
export type CatalogFieldKind = "text" | "number" | "flag";

/** One editable column of one pool. */
export interface CatalogFieldSpec {
  readonly field: string;
  readonly kind: CatalogFieldKind;
  /** Constants and rates price real work; a minus sign is a typo. */
  readonly nonNegative?: boolean;
  /** All 5,897 real labor rows carry a whole-number `sortOrder`. */
  readonly integer?: boolean;
  readonly maxLength?: number;
  /**
   * Decimals a percentage adjustment rounds to. ABSENT MEANS NOT ADJUSTABLE —
   * one flag rather than two, so a field cannot be eligible for a bulk change
   * and have no rounding scale.
   */
  readonly adjustDecimals?: number;
}

/**
 * Money rounds to the cent.
 *
 * Equipment rates are dollars: 127 of the 129 real rows are whole dollars and
 * the other two are 7.5 and 6.25. $6.25 + 3% is $6.4375, and the only sensible
 * thing to store is $6.44.
 */
export const MONEY_DECIMALS = 2;

/**
 * Man-hour constants round to four places, not two.
 *
 * The real catalog carries craft and weld constants at two decimals, and the
 * smallest non-zero craft constant is 0.01. Rounding an adjustment back to two
 * decimals would move 0.01 by nothing at all — a "+3% on 412 rows" that
 * silently did nothing to the smallest of them, which is a claim the run
 * report would then be making falsely. Four places holds 3% of 0.01 exactly.
 */
export const CONSTANT_DECIMALS = 4;

/** The same bar `shapeRow` applies; the longest real description is 49. */
const MAX_TEXT = 200;

/** Units are codes — `CRAFT` is the longest of the fourteen in use. */
const MAX_UNIT = 16;

/**
 * The editable columns, per pool.
 *
 * ⚠️ `isActive` IS DELIBERATELY ABSENT. Retiring a row also writes
 * `retiredInBookId` — "removed in the 2026 book" is the fact worth keeping —
 * so it is its own operation rather than a cell somebody can toggle without
 * the second write happening.
 *
 * ⚠️ `phasePoolId` AND `wbsPoolId` ARE DELIBERATELY ABSENT TOO. The matcher's
 * natural key is `parent|description`, so re-parenting a row changes what the
 * row IS: the next import would match the old parent's name to nothing and
 * offer to add it back as a new item. Moving an item between phases is a real
 * operation and it is not a cell edit.
 */
export const CATALOG_FIELDS: Record<PoolKind, readonly CatalogFieldSpec[]> = {
  wbs: [
    { field: "name", kind: "text", maxLength: MAX_TEXT },
    { field: "sortOrder", kind: "number", integer: true },
  ],
  phases: [
    { field: "name", kind: "text", maxLength: MAX_TEXT },
    { field: "sortOrder", kind: "number", integer: true },
    { field: "takeoffUnit", kind: "text", maxLength: MAX_UNIT },
    { field: "reservedPhaseNumber", kind: "flag" },
  ],
  labor: [
    { field: "description", kind: "text", maxLength: MAX_TEXT },
    { field: "sortOrder", kind: "number", integer: true },
    {
      field: "craftConstant",
      kind: "number",
      nonNegative: true,
      adjustDecimals: CONSTANT_DECIMALS,
    },
    { field: "craftUnits", kind: "text", maxLength: MAX_UNIT },
    {
      field: "weldConstant",
      kind: "number",
      nonNegative: true,
      adjustDecimals: CONSTANT_DECIMALS,
    },
    { field: "weldUnits", kind: "text", maxLength: MAX_UNIT },
    { field: "countsTowardTakeoff", kind: "flag" },
  ],
  equipment: [
    { field: "description", kind: "text", maxLength: MAX_TEXT },
    { field: "hourRate", kind: "number", nonNegative: true, adjustDecimals: MONEY_DECIMALS },
    { field: "dayRate", kind: "number", nonNegative: true, adjustDecimals: MONEY_DECIMALS },
    { field: "weekRate", kind: "number", nonNegative: true, adjustDecimals: MONEY_DECIMALS },
    { field: "monthRate", kind: "number", nonNegative: true, adjustDecimals: MONEY_DECIMALS },
    { field: "sortOrder", kind: "number", integer: true },
  ],
};

/**
 * The column carrying the row's own name.
 *
 * `laborPool` and `equipmentPool` store `description`; `wbsPool` and
 * `phasePool` store `name`. Reaching for the wrong one is the failure
 * `rateBookShape` documents at length, so it is named once here and asserted
 * against `beforeOf` in the tests.
 */
export const CATALOG_NAME_FIELD: Record<PoolKind, string> = {
  wbs: "name",
  phases: "name",
  labor: "description",
  equipment: "description",
};

/** The parent-scope field a pool's rows are filed under, where they have one. */
export const CATALOG_PARENT_FIELD: Record<PoolKind, string | null> = {
  wbs: null,
  phases: "wbsPoolId",
  labor: "phasePoolId",
  equipment: null,
};

/** The spec for one field, or `undefined` if that field may not be edited. */
export function editableField(pool: PoolKind, field: string): CatalogFieldSpec | undefined {
  return CATALOG_FIELDS[pool].find((spec) => spec.field === field);
}

/** The editable field names, for a refusal that says what WOULD have worked. */
export function editableFieldNames(pool: PoolKind): string[] {
  return CATALOG_FIELDS[pool].map((spec) => spec.field);
}

/** Whether a percentage adjustment may touch this field. */
export function isAdjustable(pool: PoolKind, field: string): boolean {
  return editableField(pool, field)?.adjustDecimals !== undefined;
}

export type FieldCheck = { ok: true; value: FieldValue } | { ok: false; error: string };

/**
 * One typed value against one field's rules.
 *
 * Returns the value rather than just a verdict so the caller stores exactly
 * what was checked — a check that hands back nothing invites the caller to
 * store the un-trimmed original.
 */
export function checkFieldValue(spec: CatalogFieldSpec, value: FieldValue): FieldCheck {
  if (spec.kind === "flag") {
    if (typeof value !== "boolean") return { ok: false, error: `${spec.field} is true or false.` };
    return { ok: true, value };
  }

  if (spec.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `${spec.field} must be a number.` };
    }
    if (spec.nonNegative && value < 0) {
      return { ok: false, error: `${spec.field} cannot be negative.` };
    }
    if (spec.integer && !Number.isInteger(value)) {
      return { ok: false, error: `${spec.field} must be a whole number.` };
    }
    return { ok: true, value };
  }

  if (typeof value !== "string") return { ok: false, error: `${spec.field} must be text.` };
  const trimmed = value.trim();
  if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
    return { ok: false, error: `${spec.field} is longer than ${spec.maxLength} characters.` };
  }
  if (hasReplacementChars(trimmed)) {
    // The same block the importer applies: `FSW - ≤.75` and `FSW - ≥.75` are
    // different work and both arrive as `FSW - ?.75` once the character is gone.
    return {
      ok: false,
      error: `"${trimmed}" contains a character that did not survive being copied. Retype it.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * What must still be true of a whole row once an edit lands.
 *
 * Called with the row AFTER the change, on both the edit and the add path, so
 * a single-cell edit cannot walk a row into a state the add form would have
 * refused.
 */
export function checkRowInvariants(
  pool: PoolKind,
  values: Readonly<Record<string, FieldValue>>
): string[] {
  const errors: string[] = [];

  const name = values[CATALOG_NAME_FIELD[pool]];
  if (typeof name !== "string" || name.trim() === "") {
    errors.push(`${CATALOG_NAME_FIELD[pool]} is required.`);
  }

  if (pool === "labor") {
    const weld = values.weldConstant;
    const units = values.weldUnits;
    if (typeof weld === "number" && weld > 0 && units === "") {
      errors.push(
        `a weld constant of ${weld} needs a weld unit — the hours would have nothing to multiply.`
      );
    }
  }

  return errors;
}

export type NewRowCheck =
  | { ok: true; values: Record<string, FieldValue> }
  | { ok: false; errors: string[] };

/**
 * Every field of a brand-new row.
 *
 * `sortOrder` is the one field the caller may omit, because the server places
 * a new row at the END of its parent group — the same rule the importer uses,
 * and for the same reason: zero would put every addition at the top of a list
 * people have memorised.
 *
 * A missing NUMBER is an error rather than a zero. There is nothing to inherit
 * from on a new row, and silently writing 0 prices real work at nothing.
 */
export function checkNewRow(
  pool: PoolKind,
  values: Readonly<Record<string, FieldValue>>
): NewRowCheck {
  const errors: string[] = [];
  const checked: Record<string, FieldValue> = {};

  for (const spec of CATALOG_FIELDS[pool]) {
    const raw = values[spec.field];

    if (raw === undefined) {
      if (spec.field === "sortOrder") continue;
      if (spec.kind === "number") {
        errors.push(`${spec.field} is required. Type 0 if the value really is zero.`);
        continue;
      }
      // Blank text and an unticked flag are real answers: `weldUnits` is
      // legitimately empty on 4,149 of the 5,897 real labor rows.
      checked[spec.field] = spec.kind === "flag" ? false : "";
      continue;
    }

    const result = checkFieldValue(spec, raw);
    if (result.ok) checked[spec.field] = result.value;
    else errors.push(result.error);
  }

  const unknown = Object.keys(values).filter((field) => editableField(pool, field) === undefined);
  for (const field of unknown) {
    errors.push(`${field} is not a column of the ${pool} catalog.`);
  }

  errors.push(...checkRowInvariants(pool, checked));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: checked };
}

/**
 * A percentage may not take a rate below zero, and may not be nothing.
 *
 * -100% is refused rather than clamped: an admin who meant "zero these out"
 * can type 0 into the cells, and an admin who typed -100 by accident should
 * not discover it by finding 412 constants at zero.
 */
export const MIN_ADJUST_PERCENT = -99;

/** A five-figure percentage is a typo, not a rate change. */
export const MAX_ADJUST_PERCENT = 1000;

/** Whether a percentage is one this system will apply at all. */
export function checkAdjustPercent(percent: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(percent)) return { ok: false, error: "That is not a percentage." };
  if (percent === 0) {
    return { ok: false, error: "0% would change nothing. Cancel instead of applying it." };
  }
  if (percent < MIN_ADJUST_PERCENT || percent > MAX_ADJUST_PERCENT) {
    return {
      ok: false,
      error: `A percentage adjustment must be between ${MIN_ADJUST_PERCENT}% and ${MAX_ADJUST_PERCENT}%.`,
    };
  }
  return { ok: true };
}

/**
 * One value moved by a percentage, rounded to the field's own scale.
 *
 * Rounding happens ONCE, on the final figure. Rounding the multiplier first
 * would compound across the four equipment rates of the same item and leave
 * a day rate that is not eight times an hour rate anybody typed.
 */
export function adjustByPercent(current: number, percent: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(current * (1 + percent / 100) * scale) / scale;
}

/**
 * Whether a row survives the screen's text filter.
 *
 * Uses the MATCHER'S normalizer rather than a plain `toLowerCase().includes`,
 * so searching `FSW <= .75` finds `FSW - ≤.75`. The filter and the importer
 * then agree about what two descriptions being "the same" means, which is the
 * difference between a search that finds a row and an admin concluding the row
 * is not there.
 *
 * A term that is exactly an id matches that id, because "what is 4725" is a
 * question people ask out loud. It is exact, not a prefix: `47` returning two
 * hundred rows would be an answer to nobody's question.
 */
export function matchesCatalogFilter(
  row: { readonly description: string; readonly poolId: number },
  term: string
): boolean {
  const needle = normalizeKey(term);
  if (needle === "") return true;
  if (normalizeKey(row.description).includes(needle)) return true;
  return String(row.poolId) === term.trim();
}
