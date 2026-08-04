/**
 * Export the real catalog, read it straight back, and change nothing.
 *
 * This is the single most important test in the rate-book subsystem, and it is
 * the only one that can catch its worst failure mode. `toSheetRow`,
 * `shapeRow`, `beforeOf` and `candidatePayload` each look obviously correct on
 * their own; the bug is a field present in one and missing from another. Then
 * an admin who exported a sheet, opened it, and saved it — touching nothing —
 * sees 5,897 "changes" and correctly concludes the preview is lying to them.
 *
 * Run against all 5,897 real v1 labor rows and all 129 equipment rows, through
 * the actual serializer and the actual RFC-4180 parser, because a synthetic
 * fixture would not contain the 1,196 descriptions with commas, the quotes, or
 * the 509 `≤`/`≥` rows that make this hard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS, parseDelimited, serialize } from "../convex/model/rateBookCsv";
import type { PoolKind } from "../convex/model/rateBookCsv";
import { changedFields, shapeRow, toRawRows } from "../convex/model/rateBookRows";
import { buildMatchIndex, matchRow } from "../convex/model/rateBookMatch";
import {
  beforeOf,
  candidateOf,
  candidatePayload,
  toSheetRow,
  type PoolRow,
  type SheetRefs,
} from "../convex/model/rateBookShape";

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const read = (file: string) =>
  JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Array<Record<string, unknown>>;

/** Legacy JSON shaped into the rows the catalog actually stores. */
function laborRows(): PoolRow[] {
  return read("labor_v1.json").map(
    (r, i) =>
      ({
        _id: `labor${i}`,
        _creationTime: 0,
        datasetVersion: "v1",
        poolId: Number(r.id),
        phasePoolId: Number(r.phaseDatabaseId),
        description: String(r.description),
        sortOrder: Number(r.sortOrder ?? i),
        craftConstant: Number(r.craftConstant ?? 0),
        craftUnits: String(r.craftUnits ?? ""),
        weldConstant: Number(r.weldConstant ?? 0),
        weldUnits: String(r.weldUnits ?? ""),
        countsTowardTakeoff: false,
        isCustom: false,
        isActive: true,
      }) as unknown as PoolRow
  );
}

function equipmentRows(): PoolRow[] {
  return read("equipment_v1.json").map(
    (r, i) =>
      ({
        _id: `equip${i}`,
        _creationTime: 0,
        datasetVersion: "v1",
        poolId: Number(r.id),
        description: String(r.description),
        hourRate: Number(r.hourRate ?? 0),
        dayRate: Number(r.dayRate ?? 0),
        weekRate: Number(r.weekRate ?? 0),
        monthRate: Number(r.monthRate ?? 0),
        sortOrder: Number(r.sortOrder ?? i),
        isCustom: false,
        isActive: true,
      }) as unknown as PoolRow
  );
}

const NO_REFS: SheetRefs = { wbsNames: new Map(), phases: new Map() };

/** The whole loop: rows -> sheet -> file -> rows, reporting what moved. */
function roundTrip(pool: PoolKind, rows: PoolRow[]) {
  const csv = serialize(
    COLUMNS[pool],
    rows.map((row) => toSheetRow(pool, row, NO_REFS))
  );
  const { rows: raw } = toRawRows(parseDelimited(csv));
  const index = buildMatchIndex(rows.map((row) => candidateOf(pool, row)));
  const beforeById = new Map(
    rows.map((row) => [candidateOf(pool, row).poolId, beforeOf(pool, row)])
  );

  const changes: string[] = [];
  const blocked: string[] = [];
  const unmatched: string[] = [];
  const errors: string[] = [];

  for (const line of raw) {
    const shaped = shapeRow(pool, line, false);
    if (shaped.errors.length > 0) errors.push(shaped.errors[0] as string);

    const match = matchRow(
      {
        poolId: shaped.declaredId ?? -1,
        description: shaped.description,
        parentPoolId: shaped.parentPoolId,
        payload: candidatePayload(pool, shaped.values),
        declaredId: shaped.declaredId,
      },
      index
    );
    if (!match.matched) {
      unmatched.push(shaped.description);
      continue;
    }
    if (match.blocking) blocked.push(`${shaped.description}: ${match.reason}`);
    // The row must resolve to ITSELF — a round trip that lands on a different
    // id is the exact corruption this subsystem exists to prevent.
    if (match.matched.poolId !== shaped.declaredId) {
      blocked.push(`${shaped.description} resolved to id ${match.matched.poolId}`);
    }
    const diff = changedFields(shaped.values, beforeById.get(match.matched.poolId) ?? {});
    if (diff.length > 0) changes.push(`${shaped.description}: ${diff.join(", ")}`);
  }
  return { count: raw.length, changes, blocked, unmatched, errors };
}

describe("a file exported and re-imported untouched changes nothing", () => {
  it("holds for all 5,897 real labor rows", () => {
    const rows = laborRows();
    expect(rows.length).toBe(5897);
    const result = roundTrip("labor", rows);

    expect(result.count).toBe(5897);
    // Named in the assertion rather than counted, so a failure says WHICH
    // field drifted instead of "expected 0 to be 4".
    expect(result.errors.slice(0, 3)).toEqual([]);
    expect(result.changes.slice(0, 3)).toEqual([]);
    expect(result.blocked.slice(0, 3)).toEqual([]);
    expect(result.unmatched.slice(0, 3)).toEqual([]);
  });

  it("holds for all 129 real equipment rows", () => {
    const rows = equipmentRows();
    expect(rows.length).toBe(129);
    const result = roundTrip("equipment", rows);

    expect(result.errors.slice(0, 3)).toEqual([]);
    expect(result.changes.slice(0, 3)).toEqual([]);
    expect(result.blocked.slice(0, 3)).toEqual([]);
    expect(result.unmatched.slice(0, 3)).toEqual([]);
  });
});

describe("an edited file changes exactly what was edited", () => {
  it("reports the one changed constant and nothing else", () => {
    const rows = laborRows().slice(0, 200);
    const sheet = rows.map((row) => toSheetRow("labor", row, NO_REFS));
    // Column 4 is craft_constant. Bump one row by a real amount.
    const target = sheet[7] as string[];
    const original = target[4];
    target[4] = String(Number(original) + 0.25);

    const csv = serialize(COLUMNS.labor, sheet);
    const { rows: raw } = toRawRows(parseDelimited(csv));
    const index = buildMatchIndex(rows.map((row) => candidateOf("labor", row)));
    const beforeById = new Map(
      rows.map((row) => [candidateOf("labor", row).poolId, beforeOf("labor", row)])
    );

    const edited: string[] = [];
    for (const line of raw) {
      const shaped = shapeRow("labor", line, false);
      const match = matchRow(
        {
          poolId: shaped.declaredId ?? -1,
          description: shaped.description,
          parentPoolId: shaped.parentPoolId,
          payload: candidatePayload("labor", shaped.values),
          declaredId: shaped.declaredId,
        },
        index
      );
      if (!match.matched) continue;
      const diff = changedFields(shaped.values, beforeById.get(match.matched.poolId) ?? {});
      if (diff.length > 0) edited.push(`${match.matched.poolId}:${diff.join(",")}`);
    }

    expect(edited).toEqual([`${(rows[7] as unknown as { poolId: number }).poolId}:craftConstant`]);
  });

  it("BLOCKS the row whose id was shifted, which is the whole point", () => {
    const rows = laborRows().slice(0, 200);
    const sheet = rows.map((row) => toSheetRow("labor", row, NO_REFS));
    // Exactly what a sorted-then-inserted spreadsheet does: the description
    // stays put and the id column slides by one.
    const shifted = sheet.map((row, i) => {
      const copy = [...row];
      copy[0] = (sheet[(i + 1) % sheet.length] as string[])[0] as string;
      return copy;
    });

    const { rows: raw } = toRawRows(parseDelimited(serialize(COLUMNS.labor, shifted)));
    const index = buildMatchIndex(rows.map((row) => candidateOf("labor", row)));

    let blocking = 0;
    for (const line of raw) {
      const shaped = shapeRow("labor", line, false);
      const match = matchRow(
        {
          poolId: shaped.declaredId ?? -1,
          description: shaped.description,
          parentPoolId: shaped.parentPoolId,
          payload: candidatePayload("labor", shaped.values),
          declaredId: shaped.declaredId,
        },
        index
      );
      if (match.blocking) blocking += 1;
    }
    // Every row now carries someone else's id. Not one of them applies.
    expect(blocking).toBe(raw.length);
  });
});
