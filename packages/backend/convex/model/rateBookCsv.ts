/**
 * The spreadsheet round trip.
 *
 * These people live in Excel; the CSV is the workflow, not a fallback. So this
 * module is written against what Excel actually produces rather than against
 * the CSV that would be convenient — quoted commas, embedded newlines, CRLF,
 * a UTF-8 BOM, `$` and thousands separators in numeric cells, `(5)` for
 * negatives, and a European locale that writes `;` as the delimiter.
 *
 * ⚠️ EXPORT DEFINES IMPORT. The column list below is the one contract: what
 * `serialize` writes is exactly what `parseRows` accepts, so a file that made
 * the round trip untouched produces zero changes. Any drift between the two
 * halves shows up as phantom edits on rows nobody touched.
 *
 * Pure and dependency-free so it can be tested in plain Node against the real
 * catalog files.
 */

export type PoolKind = "wbs" | "phases" | "labor" | "equipment";

/** UTF-8 BOM. Without it Excel renders the 509 `≤`/`≥` descriptions as mojibake. */
export const BOM = "\uFEFF";

/**
 * The exact columns, per pool.
 *
 * `ref_` columns are written for the human reading the sheet and ignored on
 * import — a labor row means nothing without knowing which phase it sits in,
 * but the phase code is the authority and the name is decoration.
 */
export const COLUMNS: Record<PoolKind, readonly string[]> = {
  wbs: ["id", "name", "sort_order", "active"],
  phases: [
    "id",
    "wbs_code",
    "name",
    "sort_order",
    "takeoff_unit",
    "fixed_phase_number",
    "active",
    "ref_wbs_name",
  ],
  labor: [
    "id",
    "phase_code",
    "description",
    "sort_order",
    "craft_constant",
    "craft_units",
    "weld_constant",
    "weld_units",
    "counts_toward_takeoff",
    "active",
    "ref_wbs_code",
    "ref_phase_name",
  ],
  equipment: [
    "id",
    "description",
    "hour_rate",
    "day_rate",
    "week_rate",
    "month_rate",
    "sort_order",
    "active",
  ],
};

/** Headers the importer reads. Everything else is informational. */
export function isIgnoredHeader(header: string): boolean {
  const key = normalizeHeader(header);
  // `ref_` is decoration; `_` marks a column the error round-trip added, so a
  // returned error file can be re-uploaded without deleting anything first.
  return key.startsWith("ref_") || key.startsWith("_");
}

/** `Craft Constant` = `craft_constant` = `CRAFT_CONSTANT`. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Which pool a sheet describes, from its headers rather than its filename.
 *
 * A file renamed on the way through email is not a reason to refuse it.
 */
export function detectPool(headers: readonly string[]): PoolKind | null {
  const keys = new Set(headers.map(normalizeHeader));
  if (keys.has("craft_constant")) return "labor";
  if (keys.has("hour_rate")) return "equipment";
  if (keys.has("wbs_code") || keys.has("takeoff_unit")) return "phases";
  if (keys.has("id") && keys.has("name") && !keys.has("wbs_code")) return "wbs";
  return null;
}

/** The delimiter this file actually uses. European Excel writes `;`. */
export function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    // Count only OUTSIDE quotes, or a quoted description containing a comma
    // would win the vote for its own delimiter.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i += 1) {
      const ch = headerLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === candidate) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * A full RFC-4180 parse.
 *
 * NEVER `split(",")`: 1,196 real descriptions contain commas, and several
 * contain quotes (`FSW - ≤.75"`). A naive split silently shifts every column
 * after the comma, which is the same class of corruption this whole subsystem
 * exists to prevent — just arriving through a different door.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const clean = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const firstLine = clean.slice(0, clean.indexOf("\n") === -1 ? undefined : clean.indexOf("\n"));
  const sep = delimiter ?? detectDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Trailing all-empty rows are Excel's parting gift on every save. A row with
  // SOME empty cells is a real row and stays.
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** One cell serialized so it survives the trip back. */
function escapeCell(value: string): string {
  return /[",\n;\t|]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Write a sheet. Numbers unformatted — no `$`, no thousands, no trailing zeros. */
export function serialize(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}

export type CellResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Read a number the way a spreadsheet writes one.
 *
 * Thousands separators are stripped ONLY when the digit grouping is valid, so
 * `1,234.00` parses and `1,23.00` is refused rather than silently becoming
 * 123. The letter-O case gets its own message because it is the single most
 * common typo in a hand-edited numeric column and "not a number" does not
 * help anyone find it.
 */
export function parseSheetNumber(raw: string, column: string): CellResult<number | null> {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "") return { ok: true, value: null };

  let text = trimmed;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/^\$/, "").trim();

  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  else if (text.includes(",")) {
    return { ok: false, error: `${column} "${trimmed}" has misplaced thousands separators.` };
  }

  if (/[oO]/.test(text) && /\d/.test(text)) {
    return {
      ok: false,
      error: `${column} "${trimmed}" is not a number — that looks like a letter O.`,
    };
  }
  if (!/^-?\d*\.?\d+([eE][-+]?\d+)?$/.test(text)) {
    return { ok: false, error: `${column} "${trimmed}" is not a number.` };
  }

  const value = Number(text) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `${column} "${trimmed}" is not a number.` };
  }
  return { ok: true, value };
}

/** Every truthy spelling a person might type into a spreadsheet. */
export function parseSheetBoolean(raw: string, fallback: boolean): boolean {
  const text = raw.trim().toLowerCase();
  if (text === "") return fallback;
  return ["true", "1", "yes", "y", "x", "✓"].includes(text);
}

/**
 * Descriptions mangled by saving as plain CSV instead of CSV UTF-8.
 *
 * Blocking, because it silently destroys the meaning of up to 509 rows and is
 * completely invisible to the person who did it — `FSW - ≤.75` and
 * `FSW - ≥.75` are different work, and both become `FSW - ?.75`.
 */
export function hasReplacementChars(value: string): boolean {
  return value.includes("�");
}

/** The instruction sheet that ships with every export. */
export function manifest(
  bookName: string,
  bookNumber: number,
  counts: Record<string, number>
): string {
  return [
    `Edit the .xlsx. If you must use CSV, save as "CSV UTF-8 (Comma delimited)" — NOT plain CSV.`,
    ``,
    `Rate book: ${bookName} (book ${bookNumber})`,
    ``,
    ...Object.entries(counts).map(([pool, n]) => `  ${pool}: ${n} rows`),
    ``,
    `Column A is the id. Do not type in it, sort it away from its row, or fill it down.`,
    `To add a row, leave the id blank and one will be assigned.`,
    `Columns beginning "ref_" are for your convenience and are ignored on import.`,
    `Blank in a number column on an EXISTING row means "leave it alone". Type 0 for zero.`,
  ].join("\n");
}
