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
  diffValuesOf,
  toSheetRow,
  toStoredPatch,
  type PoolRow,
  type SheetRefs,
} from "../convex/model/rateBookShape";
import { DIFF_FIELDS, diffRowKey } from "../convex/model/rateBookDiff";

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

describe("why a row blocked, as a value the apply step can act on", () => {
  const rows = laborRows().slice(0, 200);
  const index = () => buildMatchIndex(rows.map((row) => candidateOf("labor", row)));
  const asRow = (row: PoolRow) => {
    const c = candidateOf("labor", row);
    return {
      poolId: c.poolId,
      description: c.description,
      parentPoolId: c.parentPoolId,
      payload: c.payload,
    };
  };

  it("calls a shifted id column id_disagrees, and still finds the right row", () => {
    const index0 = index();
    let checked = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const truth = asRow(rows[i] as PoolRow);
      // The description stays put and the id column slides by one — what a
      // sorted-then-inserted spreadsheet does.
      const wrongId = asRow(rows[(i + 1) % rows.length] as PoolRow).poolId;
      if (wrongId === truth.poolId) continue;
      const match = matchRow({ ...truth, declaredId: wrongId }, index0);

      expect(match.blockKind).toBe("id_disagrees");
      // The target is the row the NAME identifies, so "trust the names" writes
      // to the right place rather than to the id the file asked for.
      expect(match.matched?.poolId).toBe(truth.poolId);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("calls a rename possible_rename, which no policy un-blocks", () => {
    const truth = asRow(rows[3] as PoolRow);
    const match = matchRow(
      { ...truth, description: "SOMETHING ENTIRELY NEW", declaredId: truth.poolId },
      index()
    );
    expect(match.blocking).toBe(true);
    expect(match.blockKind).toBe("possible_rename");
  });

  it("calls an id with nothing corroborating it unverified_id", () => {
    const truth = asRow(rows[3] as PoolRow);
    const match = matchRow(
      {
        ...truth,
        description: "SOMETHING ENTIRELY NEW",
        payload: { ...truth.payload, craftConstant: 99.5 },
        declaredId: truth.poolId,
      },
      index()
    );
    expect(match.blockKind).toBe("unverified_id");
  });

  it("leaves blockKind unset when nothing is wrong", () => {
    const match = matchRow(
      { ...asRow(rows[3] as PoolRow), declaredId: asRow(rows[3] as PoolRow).poolId },
      index()
    );
    expect(match.blocking).toBe(false);
    expect(match.blockKind).toBeUndefined();
  });
});

describe("the fifth mapping: the row as the differ compares it", () => {
  /** The two pools whose name lives in `name` have no legacy fixture. */
  const phase = (poolId: number, wbsPoolId: number, name: string, extra = {}): PoolRow =>
    ({
      _id: `phase${poolId}`,
      _creationTime: 0,
      datasetVersion: "v1",
      poolId,
      wbsPoolId,
      name,
      sortOrder: 10,
      isCustom: false,
      isActive: true,
      ...extra,
    }) as unknown as PoolRow;

  it("takes a phase's name from `name`, the field a wrong projection turns into 'undefined'", () => {
    // `laborPool` and `equipmentPool` store `description`; `wbsPool` and
    // `phasePool` store `name`. Reach for the wrong one and every phase in the
    // book keys as "70000|UNDEFINED" — one key for all 228 of them, which is a
    // collision on every phase and blocks G3 until somebody notices the diff
    // never mentions a phase by name.
    const rows = [
      phase(70001, 70000, "CARBON STEEL - A106/A53 (SCH 10/40)"),
      phase(70007, 70000, "STAINLESS STEEL"),
      // The same name under a different WBS is a different item, and the key
      // says so — which is why the parent has to travel with it.
      phase(80007, 80000, "STAINLESS STEEL"),
    ];
    const inputs = rows.map((row) => diffValuesOf("phases", row));
    expect(inputs.map((input) => input.description)).toEqual([
      "CARBON STEEL - A106/A53 (SCH 10/40)",
      "STAINLESS STEEL",
      "STAINLESS STEEL",
    ]);
    expect(inputs.map((input) => input.parentPoolId)).toEqual([70000, 70000, 80000]);
    expect(inputs.map(diffRowKey)).toEqual([
      // `normalizeKey` drops the brackets and keeps the slashes — the same
      // folding the matcher does, because a diff that keyed rows its own way
      // would pair items the import refuses to.
      "70000|CARBON STEEL - A106/A53 SCH 10/40",
      "70000|STAINLESS STEEL",
      "80000|STAINLESS STEEL",
    ]);
  });

  it("keys all 5,897 real labor rows the way the matcher does, with no collision", () => {
    // The differ pairs on the matcher's rule or the two subsystems disagree
    // about what an item is. `normalizeKey` produces zero collisions across this
    // file, so a description reappearing at another id is a moved payload — the
    // premise the whole shift check rests on, carried by this projection.
    const rows = laborRows();
    const inputs = rows.map((row) => diffValuesOf("labor", row));
    expect(new Set(inputs.map(diffRowKey)).size).toBe(5897);
    const first = inputs[0] as (typeof inputs)[number];
    expect(first.description).toBe(
      String((rows[0] as unknown as { description: string }).description)
    );
    expect(first.parentPoolId).toBe((rows[0] as unknown as { phasePoolId: number }).phasePoolId);
    // WBS and equipment have no parent, so their key is the bare name.
    expect(diffValuesOf("equipment", equipmentRows()[0] as PoolRow).parentPoolId).toBeUndefined();
  });

  it("carries exactly the fields the diff compares, on all four pools", () => {
    // The roster the diff walks and the values it walks it over come from two
    // different files, and a projection that omitted one would report that field
    // as unchanged on every row, forever.
    const samples: Record<PoolKind, PoolRow> = {
      wbs: {
        poolId: 70000,
        name: "AG PIPING",
        sortOrder: 10,
        isActive: true,
      } as unknown as PoolRow,
      phases: phase(70001, 70000, "CARBON STEEL"),
      labor: laborRows()[0] as PoolRow,
      equipment: equipmentRows()[0] as PoolRow,
    };
    for (const pool of ["wbs", "phases", "labor", "equipment"] as const) {
      expect(Object.keys(diffValuesOf(pool, samples[pool]).values).sort(), `${pool}`).toEqual(
        DIFF_FIELDS[pool].map((spec) => spec.field).sort()
      );
    }
  });

  it("keeps an absent takeoff unit absent, where `beforeOf` reports it as empty", () => {
    // The one place the fourth and fifth mappings must NOT agree.
    // `loadTakeoffCatalog` tests `takeoffUnit !== undefined`, so absent means
    // "this phase has no takeoff, show a dash" while "" claims one it does not
    // have. `beforeOf` coalesces for the import preview; the differ must not, or
    // the change that puts every estimate on a phase into the takeoff map with a
    // blank unit is invisible.
    const none = phase(70002, 70000, "MOBILIZE");
    expect(beforeOf("phases", none).takeoffUnit).toBe("");
    const values = diffValuesOf("phases", none).values;
    expect("takeoffUnit" in values).toBe(true);
    expect(values.takeoffUnit).toBeUndefined();
    expect(
      diffValuesOf("phases", phase(70003, 70000, "EXCAVATE", { takeoffUnit: "CY" })).values
        .takeoffUnit
    ).toBe("CY");
  });

  it("reads a row nobody has written since rowRevision was added as revision 0", () => {
    // `rowRevision` is `v.optional(v.number())` on all four pools, and the diff
    // stores it beside each row so a stale acknowledgement can be told from a
    // current one. Left absent it would compare as undefined against every
    // number the other side holds.
    expect(diffValuesOf("phases", phase(70004, 70000, "HYDROTEST")).rowRevision).toBe(0);
    expect(
      diffValuesOf("phases", phase(70005, 70000, "PAINT", { rowRevision: 7 })).rowRevision
    ).toBe(7);
  });
});

describe("a blank takeoff unit means the phase has none", () => {
  it("stores it as absent rather than as an empty string", () => {
    // loadTakeoffCatalog tests `takeoffUnit !== undefined`. An empty string
    // would put the phase in that map with a blank unit, so an estimate using
    // it would start claiming a takeoff quantity it does not have.
    const stored = toStoredPatch("phases", { name: "MOBILIZE", takeoffUnit: "", sortOrder: 1 });
    expect("takeoffUnit" in stored).toBe(true);
    expect(stored.takeoffUnit).toBeUndefined();
  });

  it("leaves a real unit alone, and never touches the other pools", () => {
    expect(toStoredPatch("phases", { takeoffUnit: "LF" }).takeoffUnit).toBe("LF");
    expect(toStoredPatch("labor", { weldUnits: "" }).weldUnits).toBe("");
  });
});
