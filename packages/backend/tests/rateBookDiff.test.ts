/**
 * The diff, calibrated against the only catastrophic drift that ever happened.
 *
 * These tests run against the two real catalog files InDemand shipped —
 * `labor_v1/v2.json` (5,897 -> 5,968 rows) and `equipment_v1/v2.json` (129 ->
 * 133) — copied verbatim into `fixtures/legacy-pools/`. A synthetic fixture
 * would not contain the 1,196 descriptions with commas, the embedded quotes,
 * or the 509 rows whose meaning rides on `≤` versus `≥`, and it certainly
 * would not contain three shift bands nobody noticed for a version.
 *
 * The measured facts every number below is anchored to:
 *
 *   labor      1,064 of 5,968 rows carry their payload at a different id, in
 *              three contiguous bands at offsets -4, -455 and +8
 *   equipment  only 3 of 129 descriptions survive at their own id; 60 rows
 *              carry the previous row's description verbatim
 *
 * If the diff cannot describe that honestly, it is wrong, and we would rather
 * learn it here than after an admin has published.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DIFF_THRESHOLDS,
  DIFF_FIELDS,
  classifyFieldChange,
  detectShiftBands,
  diffPair,
  emptyMergeCursor,
  groupSystematic,
  indexParentKey,
  markShiftedRows,
  markTakeoffFlagBulk,
  mergeJoinStep,
  newDraftScanState,
  newPoolTally,
  observeDraftRow,
  poolIntegrity,
  projectDiffValues,
  renameObservations,
  summarizeDiff,
  tallyPair,
  type DiffFieldSpec,
  type DiffRow,
  type DiffRowInput,
  type DiffSummary,
  type DiffThresholds,
  type PoolIntegrity,
  type RenameObservation,
  type RowPair,
  type ShiftBand,
  type SystematicGroup,
} from "../convex/model/rateBookDiff";
import type { PoolKind } from "../convex/model/rateBookCsv";
import { beforeOf, type PoolRow } from "../convex/model/rateBookShape";

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const read = (file: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Array<Record<string, unknown>>;

/** Legacy JSON projected the way the action projects a stored labor row. */
function laborInputs(file: string): DiffRowInput[] {
  return read(file).map((r) => ({
    poolId: Number(r.id),
    parentPoolId: Number(r.phaseDatabaseId),
    description: String(r.description),
    rowRevision: 0,
    values: projectDiffValues("labor", {
      description: String(r.description),
      sortOrder: Number(r.sortOrder ?? 0),
      craftConstant: Number(r.craftConstant ?? 0),
      craftUnits: String(r.craftUnits ?? ""),
      weldConstant: Number(r.weldConstant ?? 0),
      weldUnits: String(r.weldUnits ?? ""),
      isActive: true,
      phasePoolId: Number(r.phaseDatabaseId),
    }),
  }));
}

function equipmentInputs(file: string): DiffRowInput[] {
  return read(file).map((r) => ({
    poolId: Number(r.id),
    description: String(r.description),
    rowRevision: 0,
    values: projectDiffValues("equipment", {
      description: String(r.description),
      hourRate: Number(r.hourRate ?? 0),
      dayRate: Number(r.dayRate ?? 0),
      weekRate: Number(r.weekRate ?? 0),
      monthRate: Number(r.monthRate ?? 0),
      sortOrder: Number(r.sortOrder ?? 0),
      isActive: true,
    }),
  }));
}

interface DiffRunResult {
  readonly rows: readonly DiffRow[];
  readonly bands: readonly ShiftBand[];
  readonly unbanded: readonly RenameObservation[];
  readonly groups: readonly SystematicGroup[];
  readonly integrity: PoolIntegrity;
  readonly summary: DiffSummary;
}

/**
 * The whole pipeline, in the order the action runs it.
 *
 * Kept here rather than hidden inside each test because the ORDER is a rule:
 * shift attribution must precede systematic grouping, or a moved payload gets
 * folded into a group of honest re-rates and disappears. The takeoff-flag pass
 * comes last, because it is the one verdict that cannot be reached until the
 * whole pool has been walked.
 */
function runPoolDiff(
  pool: PoolKind,
  parentRows: readonly DiffRowInput[],
  draftRows: readonly DiffRowInput[],
  options: {
    pageSize?: number;
    thresholds?: DiffThresholds;
    validParentIds?: ReadonlySet<number>;
  } = {}
): DiffRunResult {
  const thresholds = options.thresholds ?? DEFAULT_DIFF_THRESHOLDS;
  const pageSize = options.pageSize ?? 1000;

  const parentKeys = new Map<string, number>();
  for (const row of parentRows) indexParentKey(parentKeys, row);

  const scan = newDraftScanState(options.validParentIds);
  const tally = newPoolTally();
  const kept: DiffRow[] = [];

  let cursor = emptyMergeCursor();
  let draftAt = 0;
  let parentAt = 0;
  for (;;) {
    const draftPage = draftRows.slice(draftAt, draftAt + pageSize);
    const parentPage = parentRows.slice(parentAt, parentAt + pageSize);
    draftAt += draftPage.length;
    parentAt += parentPage.length;
    const draftExhausted = draftAt >= draftRows.length;
    const parentExhausted = parentAt >= parentRows.length;
    const step = mergeJoinStep({ draftPage, parentPage, draftExhausted, parentExhausted, cursor });
    cursor = step.cursor;
    for (const pair of step.pairs) {
      if (pair.draft) observeDraftRow(scan, pool, pair.draft, pair.parent);
      if (pair.duplicateDraft) observeDraftRow(scan, pool, pair.duplicateDraft, pair.parent);
      const row = diffPair(pool, pair, thresholds);
      tallyPair(tally, pair, row);
      if (row) kept.push(row);
    }
    if (draftExhausted && parentExhausted && step.pairs.length === 0) break;
  }

  const observations = renameObservations(parentKeys, kept);
  const { bands, unbanded } = detectShiftBands(observations, thresholds.shiftBandMin);
  const marked = markShiftedRows(kept, bands, unbanded);
  const { groups, rows: grouped } = groupSystematic(marked, thresholds.systematicGroupMin);
  const rows = markTakeoffFlagBulk({
    rows: grouped,
    takeoffFlagsByPhase: scan.newTakeoffFlagsByPhase,
    thresholds,
  });
  const integrity = poolIntegrity(pool, tally, scan);
  return {
    rows,
    bands,
    unbanded,
    groups,
    integrity,
    summary: summarizeDiff({
      pools: [integrity],
      rows,
      bands,
      groups,
      takeoffFlagsByPhase: scan.newTakeoffFlagsByPhase,
      thresholds,
    }),
  };
}

const rowAt = (result: DiffRunResult, poolId: number): DiffRow => {
  const row = result.rows.find((candidate) => candidate.poolId === poolId);
  expect(row, `no diff row at poolId ${poolId}`).toBeDefined();
  return row as DiffRow;
};

const fieldsOf = (row: DiffRow): string[] => row.changes.map((change) => change.field).sort();

const flagsOf = (row: DiffRow, field: string): readonly string[] =>
  row.changes.find((change) => change.field === field)?.flags ?? [];

/** Ids collapsed into literal `[first, last]` runs, for reading a band's shape. */
function runsOf(poolIds: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const poolId of poolIds) {
    const last = runs[runs.length - 1];
    if (last && poolId === last[1] + 1) last[1] = poolId;
    else runs.push([poolId, poolId]);
  }
  return runs;
}

/** A minimal labor row, for the rules that need a shape the real files lack. */
function labor(
  poolId: number,
  phase: number,
  description: string,
  values: Record<string, string | number | boolean | undefined> = {}
): DiffRowInput {
  return {
    poolId,
    parentPoolId: phase,
    description,
    rowRevision: 0,
    values: {
      ...projectDiffValues("labor", {
        description,
        sortOrder: 10,
        craftConstant: 1,
        craftUnits: "LF",
        weldConstant: 0,
        weldUnits: "",
        isActive: true,
        phasePoolId: phase,
      }),
      ...values,
    },
  };
}

const LABOR_V1 = laborInputs("labor_v1.json");
const LABOR_V2 = laborInputs("labor_v2.json");
const EQUIP_V1 = equipmentInputs("equipment_v1.json");
const EQUIP_V2 = equipmentInputs("equipment_v2.json");

const laborRun = runPoolDiff("labor", LABOR_V1, LABOR_V2);
const equipmentRun = runPoolDiff("equipment", EQUIP_V1, EQUIP_V2);

/** The equipment run's raw observations, for the threshold calibration. */
function equipmentObservations(): RenameObservation[] {
  const parentKeys = new Map<string, number>();
  for (const row of EQUIP_V1) indexParentKey(parentKeys, row);
  return renameObservations(parentKeys, equipmentRun.rows);
}

describe("the roster the diff shares with the import audit", () => {
  /** The fake documents `beforeOf` needs; only its key set is under test. */
  const sample: Record<PoolKind, PoolRow> = {
    wbs: { poolId: 1, name: "AG PIPING", sortOrder: 10, isActive: true } as unknown as PoolRow,
    phases: {
      poolId: 70001,
      wbsPoolId: 70000,
      name: "CARBON STEEL",
      sortOrder: 10,
      isActive: true,
    } as unknown as PoolRow,
    labor: {
      poolId: 1,
      phasePoolId: 70001,
      description: "FSW - ≤.75",
      sortOrder: 10,
      craftConstant: 0.6,
      craftUnits: "LF",
      weldConstant: 0.6,
      weldUnits: "LF",
      isActive: true,
    } as unknown as PoolRow,
    equipment: {
      poolId: 1,
      description: "AIR TOOLS - AIR COMPRESSOR 0-185 CFM",
      hourRate: 8,
      dayRate: 64,
      weekRate: 256,
      monthRate: 768,
      sortOrder: 10,
      isActive: true,
    } as unknown as PoolRow,
  };

  it("describes every field the import preview can report, plus retirement", () => {
    // Drift here is invisible in a unit test of either side: the diff would
    // simply never mention a field an import can change, and nobody would know
    // which one.
    for (const pool of ["wbs", "phases", "labor", "equipment"] as const) {
      const audit = Object.keys(beforeOf(pool, sample[pool])).sort();
      const diff = DIFF_FIELDS[pool].map((spec) => spec.field).sort();
      expect(
        diff.filter((field) => field !== "retiredInBookId"),
        `${pool} roster`
      ).toEqual(audit);
      expect(diff, `${pool} sees retirement`).toContain("retiredInBookId");
    }
  });

  it("treats only constants and rates as numbers, so sort order is never a re-rate", () => {
    const numeric = (["wbs", "phases", "labor", "equipment"] as const).flatMap((pool) =>
      DIFF_FIELDS[pool].filter((spec) => spec.numeric).map((spec) => spec.field)
    );
    expect([...new Set(numeric)].sort()).toEqual([
      "craftConstant",
      "dayRate",
      "hourRate",
      "monthRate",
      "weekRate",
      "weldConstant",
    ]);
  });

  it("counts a change to takeoff display as reaching an estimate that is already finished", () => {
    const live = (pool: PoolKind): string[] =>
      DIFF_FIELDS[pool]
        .filter((spec) => spec.effect === "read_live")
        .map((spec) => spec.field)
        .sort();
    // These four are the only fields `loadTakeoffCatalog`, the export and
    // `deriveNextPhaseNumber` read out of the catalog while rendering work that
    // was priced years ago.
    expect(live("phases")).toContain("takeoffUnit");
    expect(live("phases")).toContain("reservedPhaseNumber");
    expect(live("labor")).toContain("countsTowardTakeoff");
    expect(live("labor")).toContain("isActive");
    expect(live("labor")).not.toContain("craftConstant");
  });
});

describe("absence is a third state, not an empty string", () => {
  const spec = (field: string): DiffFieldSpec => {
    const found = DIFF_FIELDS.phases.find((candidate) => candidate.field === field);
    expect(found, field).toBeDefined();
    return found as DiffFieldSpec;
  };

  it("a phase with no takeoff and a phase with a blank takeoff are different phases", () => {
    // `loadTakeoffCatalog` tests `!== undefined`. Absent shows a dash; "" puts
    // the phase in the map claiming a takeoff it does not have, on every
    // estimate that uses it.
    const change = classifyFieldChange(spec("takeoffUnit"), undefined, "", DEFAULT_DIFF_THRESHOLDS);
    expect(change).not.toBeNull();
    expect(Object.hasOwn(change ?? {}, "before")).toBe(false);
    expect(change?.after).toBe("");
    expect(change?.flags).toContain("live_read_field");
  });

  it("a cloned row that never carried reservedPhaseNumber is not an edit against false", () => {
    // `shapeRow` always writes a defined boolean while `cloneBatch` leaves the
    // field absent. Read as distinct, every row an import ever touched would
    // report as changed forever.
    expect(
      classifyFieldChange(spec("reservedPhaseNumber"), undefined, false, DEFAULT_DIFF_THRESHOLDS)
    ).toBeNull();
    expect(
      classifyFieldChange(spec("reservedPhaseNumber"), undefined, true, DEFAULT_DIFF_THRESHOLDS)
    ).not.toBeNull();
  });

  it("a cloned labor row that never carried countsTowardTakeoff is not an edit either", () => {
    // The same rule as reservedPhaseNumber, on the field that actually appears
    // 5,897 times: `cloneBatch` copies the parent row verbatim, so the flag stays
    // absent, while `shapeRow` writes a defined `false` on every row an import
    // has ever touched. Read as distinct, a book that was half imported reports
    // thousands of edits nobody made — and the real bug hiding in that noise is
    // the takeoff flag somebody DID add.
    const flag = DIFF_FIELDS.labor.find((candidate) => candidate.field === "countsTowardTakeoff");
    expect(flag).toBeDefined();
    const countsTowardTakeoff = flag as DiffFieldSpec;
    expect(
      classifyFieldChange(countsTowardTakeoff, undefined, false, DEFAULT_DIFF_THRESHOLDS)
    ).toBeNull();
    expect(
      classifyFieldChange(countsTowardTakeoff, undefined, true, DEFAULT_DIFF_THRESHOLDS)?.flags
    ).toContain("live_read_field");
  });

  it("clearing a takeoff unit back to absent is a change, and reads as absent", () => {
    const change = classifyFieldChange(
      spec("takeoffUnit"),
      "CY",
      undefined,
      DEFAULT_DIFF_THRESHOLDS
    );
    expect(change?.before).toBe("CY");
    expect(Object.hasOwn(change ?? {}, "after")).toBe(false);
  });
});

describe("the streaming merge join", () => {
  it("produces the same 5,968 pairs whether pages hold 1,000 rows or 7", () => {
    // Page size is an operational knob (2,000 documents against Convex's
    // 16,384 ceiling). If it changed the answer, the diff would depend on how
    // busy the deployment was.
    const coarse = runPoolDiff("labor", LABOR_V1, LABOR_V2, { pageSize: 1000 });
    const fine = runPoolDiff("labor", LABOR_V1, LABOR_V2, { pageSize: 7 });
    expect(fine.rows.map((row) => row.poolId)).toEqual(coarse.rows.map((row) => row.poolId));
    expect(fine.integrity).toEqual(coarse.integrity);
    expect(fine.bands.map((band) => band.id)).toEqual(coarse.bands.map((band) => band.id));
  });

  it("never calls the last row of a page an addition", () => {
    // The whole reason the join holds rows back: the partner for id 3 may be
    // sitting in the parent's next page.
    const draft = [labor(1, 70001, "A"), labor(2, 70001, "B"), labor(3, 70001, "C")];
    const parent = [labor(1, 70001, "A"), labor(2, 70001, "B")];
    const step = mergeJoinStep({
      draftPage: draft,
      parentPage: parent,
      draftExhausted: false,
      parentExhausted: false,
      cursor: emptyMergeCursor(),
    });
    expect(step.pairs.map((pair) => pair.poolId)).toEqual([1]);
    expect(step.cursor.pendingDraft.map((row) => row.poolId)).toEqual([2, 3]);
  });

  it("sees a duplicate that straddles a page boundary", () => {
    // `cloneBatch` commits the inserts that preceded a throw and
    // `retryDraftBuild` replays the same range, so two rows at one id is a real
    // state this system can reach. Convex has no unique constraint to stop it.
    const first = mergeJoinStep({
      draftPage: [labor(7, 70001, "SEVEN")],
      parentPage: [labor(7, 70001, "SEVEN")],
      draftExhausted: false,
      parentExhausted: false,
      cursor: emptyMergeCursor(),
    });
    expect(first.pairs).toEqual([]);
    const second = mergeJoinStep({
      draftPage: [labor(7, 70001, "SEVEN"), labor(8, 70001, "EIGHT")],
      parentPage: [labor(8, 70001, "EIGHT")],
      draftExhausted: true,
      parentExhausted: true,
      cursor: first.cursor,
    });
    const seven = second.pairs.find((pair) => pair.poolId === 7);
    expect(seven?.duplicateDraft?.poolId).toBe(7);
  });

  it("reports a parent row the draft lost the moment the draft runs out", () => {
    const step = mergeJoinStep({
      draftPage: [labor(1, 70001, "A")],
      parentPage: [labor(1, 70001, "A"), labor(2, 70001, "B")],
      draftExhausted: true,
      parentExhausted: true,
      cursor: emptyMergeCursor(),
    });
    const orphan = step.pairs.find((pair) => pair.poolId === 2);
    expect(orphan?.draft).toBeUndefined();
    expect(orphan?.parent?.description).toBe("B");
  });

  it("never speaks about an id it has already emitted, however the pages overlap", () => {
    // The checkpoint is three integers, so a resume re-queries from the last
    // emitted id — and a query written with `gte` rather than `gt` hands back the
    // row that id names. Without the replay guard id 2 comes round a second time:
    // counted twice in the tallies, and stored twice in an audit trail whose
    // whole justification is that it is exact.
    const first = mergeJoinStep({
      draftPage: [labor(1, 70001, "A"), labor(2, 70001, "B"), labor(3, 70001, "C")],
      parentPage: [labor(1, 70001, "A"), labor(2, 70001, "B"), labor(3, 70001, "C")],
      draftExhausted: false,
      parentExhausted: false,
      cursor: emptyMergeCursor(),
    });
    expect(first.pairs.map((pair) => pair.poolId)).toEqual([1, 2]);
    const overlapping = [labor(2, 70001, "B"), labor(4, 70001, "D")];
    const second = mergeJoinStep({
      draftPage: overlapping,
      parentPage: overlapping,
      draftExhausted: true,
      parentExhausted: true,
      cursor: first.cursor,
    });
    expect(second.pairs.map((pair) => pair.poolId)).toEqual([3, 4]);
    // ⚠️ What the guard does NOT cover, and cannot: a row still sitting in the
    // buffer, re-delivered. Two rows at one id with identical values is exactly
    // what a real duplicate looks like, and `DiffRowInput` carries nothing else
    // to tell them apart by — which is why the contract is that a retry starts
    // from `emptyMergeCursor` and re-queries, rather than replaying into a live
    // cursor.
    expect(second.pairs.every((pair) => pair.duplicateDraft === undefined)).toBe(true);
  });

  it("keeps the first of two parent rows at one id, because G1 is about the draft", () => {
    // A published book with two rows at one id is a pre-existing condition this
    // draft did not cause. Taking the second would report the difference between
    // the parent's own two rows as an edit somebody made.
    const step = mergeJoinStep({
      draftPage: [labor(1, 70001, "A")],
      parentPage: [labor(1, 70001, "A"), labor(1, 70001, "A-SECOND")],
      draftExhausted: true,
      parentExhausted: true,
      cursor: emptyMergeCursor(),
    });
    expect(step.pairs.length).toBe(1);
    const pair = step.pairs[0] as RowPair;
    expect(pair.parent?.description).toBe("A");
    expect(diffPair("labor", pair, DEFAULT_DIFF_THRESHOLDS)).toBeNull();
  });

  it("indexes the first parent row under a repeated key, never the last", () => {
    // `buildMatchIndex` does the same, and for the same reason: overwriting here
    // would hide a collision in the parent instead of leaving the key pointing at
    // the row the matcher would resolve to.
    const index = new Map<string, number>();
    indexParentKey(index, labor(11, 70001, "PIPE - 2"));
    indexParentKey(index, labor(12, 70001, "PIPE - 2"));
    expect(index.get("70001|PIPE - 2")).toBe(11);
  });
});

describe("the real labor bump, counted honestly", () => {
  it("leaves the 4,698 untouched rows out of the audit trail entirely", () => {
    // 12,000 documents saying nothing happened is not an audit trail; it is how
    // you make the 1,270 that did move unreadable.
    expect(laborRun.summary.changedRowCount).toBe(1270);
    expect(laborRun.summary.unchangedRowCount).toBe(4698);
    expect(laborRun.integrity.editedCount).toBe(1199);
    expect(laborRun.integrity.addedCount).toBe(71);
  });

  it("loses nothing: every one of the 5,897 parent ids has a draft counterpart", () => {
    // No threshold on this one. Nothing in the subsystem deletes a cloned row,
    // so one missing id is an integrity violation, not a percentage.
    expect(laborRun.integrity.missingFromDraft).toEqual([]);
    expect(laborRun.integrity.parentRowCount).toBe(5897);
    expect(laborRun.integrity.draftRowCount).toBe(5968);
  });

  it("finds no duplicate id and no key collision in either real file", () => {
    expect(laborRun.integrity.duplicatePoolIds).toEqual([]);
    expect(laborRun.integrity.keyCollisions).toEqual([]);
    expect(equipmentRun.integrity.keyCollisions).toEqual([]);
  });
});

describe("shift bands, calibrated on the only real drift", () => {
  it("finds exactly the three labor bands at -4, -455 and +8, with nothing left over", () => {
    expect(
      laborRun.bands.map((band) => ({
        offset: band.offset,
        start: band.startPoolId,
        end: band.endPoolId,
        rows: band.rowCount,
      }))
    ).toEqual([
      { offset: -4, start: 4725, end: 5430, rows: 706 },
      { offset: -455, start: 5431, end: 5442, rows: 12 },
      { offset: 8, start: 5443, end: 5788, rows: 346 },
    ]);
    expect(laborRun.bands.reduce((sum, band) => sum + band.rowCount, 0)).toBe(1064);
    expect(laborRun.unbanded).toEqual([]);
  });

  it("says of id 4725 that its payload moved, not that TECHNICIAN got 25x slower", () => {
    // v1 4725 is PREINSULATED, 0.4 LF. v2 4725 is TECHNICIAN, 10 DAY — which is
    // v1 id 4729, four rows down. Every number in the field comparison below is
    // a comparison against a different item, and the band flag is the only
    // thing that says so.
    const row = rowAt(laborRun, 4725);
    expect(row.parentDescription).toBe("PREINSULATED");
    expect(row.draftDescription).toBe("TECHNICIAN");
    expect(row.descriptionsNormalizeEqual).toBe(false);
    expect(row.flags).toContain("shifted_payload");
    expect(row.shiftBandId).toBe(laborRun.bands[0]?.id);
    expect(fieldsOf(row)).toEqual(["craftConstant", "craftUnits", "description", "phasePoolId"]);
  });

  it("groups the 60 equipment rows that took the previous row's name into ONE band", () => {
    // Catalog ids are sparse, so "contiguous" means adjacent among the
    // observations, not literally n, n+1. Read literally, this band shatters
    // into the four id ranges 10-12, 16-35, 37-46 and 52-77 and each fragment
    // argues for itself.
    const bandOfOne = equipmentRun.bands.find((band) => band.offset === 1);
    expect(bandOfOne?.rowCount).toBe(60);
    expect(bandOfOne?.startPoolId).toBe(10);
    expect(bandOfOne?.endPoolId).toBe(77);
  });

  it("holds ids 10-12, 16-35, 37-46, 48 alone, and 52-77 — five runs, one finding", () => {
    // The gaps are the calibration. Read as literal id adjacency the 60 rows are
    // four ranges the spec names plus id 48 sitting on its own between 46 and
    // 52, so the largest fragment is 26 rows and the smallest is one — and a
    // single row at a constant offset is below every band threshold there is.
    // The whole spreadsheet slipped by one; reporting it as five events, one of
    // them a coincidence, is how a catastrophe gets filed as noise.
    const band = equipmentRun.bands.find((candidate) => candidate.offset === 1);
    expect(runsOf(band?.poolIds ?? [])).toEqual([
      [10, 12],
      [16, 35],
      [37, 46],
      [48, 48],
      [52, 77],
    ]);
  });

  it("would call 14 real equipment shifts individual coincidences at a threshold of 10", () => {
    // The calibration argument for 3 rather than 10: the +3 and +4 bands are 5
    // and 9 rows, and one of the 9 is the renumbered dumpster. A threshold that
    // could miss part of the only real occurrence is not calibrated to it.
    const atThree = detectShiftBands(equipmentObservations(), 3);
    const atTen = detectShiftBands(equipmentObservations(), 10);
    expect(atThree.bands.map((band) => band.rowCount)).toEqual([60, 5, 9]);
    expect(atTen.bands.map((band) => band.rowCount)).toEqual([60]);
    expect(atTen.unbanded.length - atThree.unbanded.length).toBe(14);
  });

  it("never drops a two-item swap, which a threshold of three cannot see", () => {
    // Two items exchanging descriptions is exactly the case a person must
    // confirm, and it is structurally invisible to any band rule. It becomes a
    // per-row acknowledgement instead of being discarded.
    const swapped: RenameObservation[] = [
      { pool: "labor", draftPoolId: 41, parentPoolIdOfKey: 42 },
      { pool: "labor", draftPoolId: 42, parentPoolIdOfKey: 41 },
    ];
    const { bands, unbanded } = detectShiftBands(swapped, 3);
    expect(bands).toEqual([]);
    expect(unbanded).toEqual(swapped);

    const parent = [labor(41, 70001, "A"), labor(42, 70001, "B")];
    const draft = [labor(41, 70001, "B"), labor(42, 70001, "A")];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.unbanded).toEqual(swapped);
    expect(rowAt(run, 41).flags).toContain("description_swap");
    expect(rowAt(run, 42).flags).toContain("description_swap");
  });

  it("reports a renumbered dumpster as an addition by id AND a moved payload by name", () => {
    // v2 id 132 MISC - DUMPSTER SERVICE is byte-identical to v1 id 128. Diffing
    // id sets calls it new; adding it again would create a duplicate item and
    // orphan every estimate pointing at 128.
    const row = rowAt(equipmentRun, 132);
    expect(row.kind).toBe("added");
    expect(row.draftDescription).toBe("MISC - DUMPSTER SERVICE");
    // Nothing sat at id 132 in the parent, so there are not two descriptions to
    // fold together and the answer is not "they match".
    expect(row.parentDescription).toBeUndefined();
    expect(row.descriptionsNormalizeEqual).toBe(false);
    expect(row.flags).toContain("shifted_payload");
    expect(equipmentRun.bands.find((band) => band.id === row.shiftBandId)?.offset).toBe(4);
  });

  it("flags the single equipment row that moved on its own as a swap, not a band", () => {
    // v2 id 122 carries v1 id 117's name and rates at offset 5 — one row, so it
    // is a per-row decision rather than a policy.
    expect(equipmentRun.unbanded).toEqual([
      { pool: "equipment", draftPoolId: 122, parentPoolIdOfKey: 117 },
    ]);
    expect(rowAt(equipmentRun, 122).flags).toContain("description_swap");
  });
});

describe("what each flag actually claims", () => {
  const laborSpec = (field: string): DiffFieldSpec => {
    const found = DIFF_FIELDS.labor.find((candidate) => candidate.field === field);
    return found as DiffFieldSpec;
  };
  const change = (field: string, before: number | string, after: number | string) =>
    classifyFieldChange(laborSpec(field), before, after, DEFAULT_DIFF_THRESHOLDS);

  it("0.6 becoming 6 is a decimal point, and is never also called a large change", () => {
    // A shape of typo, not a size of change — so it can never be folded into a
    // group of honest re-rates and acknowledged in bulk.
    const shifted = change("craftConstant", 0.6, 6);
    expect(shifted?.flags).toEqual(["decimal_shift"]);
    expect(shifted?.ratio).toBe(10);
    // A point moved two places is the same typo, and nothing else in the diff
    // would say so: 100x reads as an implausible re-rate, which is a size of
    // change and can be acknowledged in bulk alongside honest ones.
    expect(change("craftConstant", 0.6, 60)?.flags).toEqual(["decimal_shift"]);
    expect(change("craftConstant", 60, 0.6)?.flags).toEqual(["decimal_shift"]);
  });

  it("a re-rate that lands near ten-fold but not on it is not called a typo", () => {
    const nearly = change("craftConstant", 0.6, 6.6);
    expect(nearly?.flags).not.toContain("decimal_shift");
    expect(nearly?.flags).toContain("implausible_magnitude");
  });

  it("a constant driven to zero deletes work in every future estimate, and says that", () => {
    // `shapeRow` already refuses a blank constant on a new row because silently
    // writing 0 would price real work at nothing. The same value arriving as an
    // edit earns the same suspicion — and "large change" would be a weaker way
    // of saying it.
    const zeroed = change("craftConstant", 0.6, 0);
    expect(zeroed?.flags).toEqual(["zeroed_constant"]);
  });

  it("a constant switched on is flagged, but not as the same finding", () => {
    // ->0 destroys hours invisibly; 0-> creates hours the benchmark will show.
    const activated = change("craftConstant", 0, 0.6);
    expect(activated?.flags).toEqual(["constant_activated"]);
    expect(activated?.ratio).toBeUndefined();
  });

  it("0.6 LF becoming 0.6 EA is a change, though no number moved", () => {
    // 10x on a ten-foot spool, and every numeric comparison in the diff sees an
    // untouched value. 268 labor rows changed craft units in the real bump.
    const flipped = change("craftUnits", "LF", "EA");
    expect(flipped?.flags).toEqual(["unit_changed"]);
    expect(flagsOf(rowAt(laborRun, 4725), "craftUnits")).toContain("unit_changed");
  });

  it("sort order is not a re-rate, on any of the 1,157 rows that moved one", () => {
    const sortChanges = laborRun.rows.flatMap((row) =>
      row.changes.filter((c) => c.field === "sortOrder")
    );
    expect(sortChanges.length).toBe(1157);
    expect(sortChanges.every((c) => c.flags.length === 0)).toBe(true);
    expect(sortChanges.every((c) => c.ratio === undefined)).toBe(true);
  });

  it("moving a labor line to another phase changes what it is, and 329 rows did", () => {
    // The one edit that makes an id and its meaning disagree by construction:
    // the row keeps its id and changes its natural key.
    const reparented = laborRun.rows.filter((row) => row.flags.includes("reparented"));
    expect(reparented.length).toBe(329);
    expect(flagsOf(rowAt(laborRun, 4725), "phasePoolId")).toEqual(["reparented"]);
  });

  it("calls equipment rates that do not ascend wrong on their face", () => {
    // They are cumulative period prices — book #1 id 5 is 7/56/224/672 — so an
    // inversion needs no history to condemn.
    const parent = EQUIP_V1.find((row) => row.poolId === 1) as DiffRowInput;
    const inverted: DiffRowInput = {
      ...parent,
      values: { ...parent.values, dayRate: 4 },
    };
    const row = diffPair(
      "equipment",
      { poolId: 1, parent, draft: inverted },
      DEFAULT_DIFF_THRESHOLDS
    );
    expect(row?.flags).toContain("rate_tier_inversion");
  });

  it("checks a brand new equipment row too, since a new row is entirely the draft's doing", () => {
    // The real bump added four equipment rows. A row with no parent has no field
    // changes to compare, so a check gated on "something changed" would let
    // 7/56/224/12 into the book through the one door nobody is watching — and
    // every estimate written against it would price a month cheaper than a week.
    const parent = EQUIP_V1.find((row) => row.poolId === 1) as DiffRowInput;
    const added: DiffRowInput = {
      ...parent,
      poolId: 200,
      description: "MANLIFT - 60'",
      values: { ...parent.values, description: "MANLIFT - 60'", monthRate: 12 },
    };
    const row = diffPair("equipment", { poolId: 200, draft: added }, DEFAULT_DIFF_THRESHOLDS);
    expect(row?.kind).toBe("added");
    expect(row?.flags).toContain("rate_tier_inversion");
    // And an untouched row is still nobody's decision: the parent book was never
    // gated and reading it by hand is a separate job.
    const untouched = diffPair(
      "equipment",
      { poolId: 1, parent, draft: parent },
      DEFAULT_DIFF_THRESHOLDS
    );
    expect(untouched).toBeNull();
  });

  it("finds no inversion in either real equipment file, across 129 and 133 rows", () => {
    expect(equipmentRun.summary.flagCounts.rate_tier_inversion).toBe(0);
  });

  it("ignores a missing tier, because a rate that is not offered is legitimate", () => {
    // v2 id 124 MISC - TOTAL STATION is 0/0/400/1200: two tiers absent, and the
    // two that exist ascend.
    const row = rowAt(equipmentRun, 124);
    expect(row.flags).not.toContain("rate_tier_inversion");
    expect(flagsOf(row, "hourRate")).toContain("zeroed_constant");
  });
});

describe("a shifted row's numbers are a comparison against a different item", () => {
  it("puts all five 10x craft-constant moves inside the -4 band", () => {
    // Read alone, ids 4876, 5179, 5208, 5257 and 5421 look like five decimal
    // typos. Every one of them is a row whose payload came from four ids down —
    // v2 4876 LG - (INSTALL) 4 EA is v1 4880 verbatim — and the band flag is
    // what stops an admin from "fixing" five constants that were never wrong.
    const decimals = laborRun.rows
      .filter((row) => row.flags.includes("decimal_shift"))
      .map((row) => row.poolId);
    expect(decimals).toEqual([4876, 5179, 5208, 5257, 5421]);
    for (const poolId of decimals) {
      expect(rowAt(laborRun, poolId).shiftBandId, `row ${poolId}`).toBe(laborRun.bands[0]?.id);
    }
    expect(rowAt(laborRun, 4876).draftDescription).toBe("LG - (INSTALL)");
  });

  it("never folds a moved payload into a systematic group", () => {
    const grouped = laborRun.rows.filter((row) => row.systematicGroupId !== undefined);
    expect(grouped.every((row) => !row.flags.includes("shifted_payload"))).toBe(true);
    expect(grouped.every((row) => !row.flags.includes("decimal_shift"))).toBe(true);
    // Nor a row that changed phase. A re-rate group says "these lines all moved
    // by R"; a line that also moved to another phase is a different item now, and
    // one signature covering both statements says neither of them clearly.
    expect(grouped.every((row) => !row.flags.includes("reparented"))).toBe(true);
    const reparented = laborRun.rows.filter((row) => row.flags.includes("reparented"));
    expect(
      reparented.some((row) => row.changes.some((c) => c.flags.includes("large_change")))
    ).toBe(true);
  });
});

describe("the equipment file, where only 3 of 129 names survived", () => {
  it("says id 6's name and rates changed, and does not guess whose rates they are", () => {
    // v2 id 6 BREAKERS - AIR 30 LBS carries 7/56/224/672 — v1 id 5's rates,
    // under a shortened name, shifted AND renamed in one pass. Seven different
    // v1 items carry those four numbers, so naming an owner would be a guess
    // wearing the costume of a finding.
    const row = rowAt(equipmentRun, 6);
    expect(row.parentDescription).toBe("BREAKERS - AIR BREAKER 60 LBS");
    expect(row.draftDescription).toBe("BREAKERS - AIR 30 LBS");
    expect(row.descriptionsNormalizeEqual).toBe(false);
    expect(row.shiftBandId).toBeUndefined();
    expect(row.flags).not.toContain("shifted_payload");
    expect(fieldsOf(row)).toEqual(["dayRate", "description", "hourRate", "monthRate", "weekRate"]);
    // The numbers, not just the field names: v1 id 6 is 8/64/256/768 and v1 id 5
    // is 7/56/224/672, and what arrives at v2 id 6 is id 5's four rates verbatim.
    // Asserting only WHICH fields moved would pass on a diff that reported the
    // right five fields with any values at all — including the ones it was
    // supposed to notice had come from a different item.
    expect(
      row.changes
        .filter((change) => change.field !== "description")
        .map((change) => [change.field, change.before, change.after])
    ).toEqual([
      ["hourRate", 8, 7],
      ["dayRate", 64, 56],
      ["weekRate", 256, 224],
      ["monthRate", 768, 672],
    ]);
    // A 12.5% drop is a re-rate, not an anomaly. It says so by saying nothing.
    expect(flagsOf(row, "hourRate")).toEqual([]);
  });

  it("reports a cosmetic rename as what it is", () => {
    // Excel's autocorrect rewrites " - " as " – " while you type, and a round
    // trip through a spreadsheet re-spaces cells. The row changed and says so;
    // it also says the change is nothing, which is the difference between a
    // rename a person must read and one they must not waste time on.
    const sample = EQUIP_V1[9] as DiffRowInput;
    // `description` and `values.description` are the same fact told twice, and a
    // row where they disagree cannot exist. Building the fixture that way would
    // make this test pass on a diff that never looked at the descriptions at all.
    const rename = (text: string): DiffRowInput => ({
      ...sample,
      description: text,
      values: { ...sample.values, description: text },
    });
    const cosmetic = diffPair(
      "equipment",
      {
        poolId: sample.poolId,
        parent: rename("MISC - TRANSIT/LEVEL"),
        draft: rename("MISC  –  TRANSIT/LEVEL"),
      },
      DEFAULT_DIFF_THRESHOLDS
    );
    expect(cosmetic?.kind).toBe("edited");
    expect(fieldsOf(cosmetic as DiffRow)).toEqual(["description"]);
    expect(cosmetic?.descriptionsNormalizeEqual).toBe(true);
  });
});

describe("systematic grouping, so a gate does not become a click-through", () => {
  const bulkRerate = (ratio: number, rows: number): readonly DiffRow[] => {
    const parent = Array.from({ length: rows }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row) => ({
      ...row,
      values: { ...row.values, craftConstant: Number(row.values.craftConstant) * ratio },
    }));
    return runPoolDiff("labor", parent, draft).rows;
  };

  it("turns 8 lines under one phase moving by exactly 2.5x into one decision", () => {
    const rows = bulkRerate(2.5, 8);
    const { groups, rows: grouped } = groupSystematic(rows, 5);
    expect(groups.length).toBe(1);
    expect(groups[0]?.rowCount).toBe(8);
    expect(groups[0]?.ratio).toBe(2.5);
    expect(groups[0]?.field).toBe("craftConstant");
    expect(groups[0]?.parentPoolId).toBe(70001);
    expect(grouped.every((row) => row.systematicGroupId === groups[0]?.id)).toBe(true);
  });

  it("does not group 4 lines, because four rows is not a policy", () => {
    expect(groupSystematic(bulkRerate(2.5, 4), 5).groups).toEqual([]);
  });

  it("treats 2.1999999999999997 and 2.2 as the same decision", () => {
    // 0.11/0.05 is 2.1999999999999997 while 1.32/0.6 is exactly 2.2. One person
    // typed one multiplier; a group keyed on the raw quotient splits that into
    // two policies of 2 and 3 rows, neither of which reaches five, so the whole
    // re-rate falls out of grouping and comes back as five checkboxes.
    const before = [0.6, 1, 0.05, 0.1, 0.14];
    const after = [1.32, 2.2, 0.11, 0.22, 0.308];
    const parent = before.map((value, i) =>
      labor(i + 1, 70001, `LINE ${i + 1}`, { craftConstant: value })
    );
    const draft = after.map((value, i) =>
      labor(i + 1, 70001, `LINE ${i + 1}`, { craftConstant: value })
    );
    const { groups } = groupSystematic(runPoolDiff("labor", parent, draft).rows, 5);
    expect(groups.map((group) => group.ratio)).toEqual([2.2]);
    expect(groups[0]?.rowCount).toBe(5);
  });

  it("does not merge two phases' re-rates into one claim about one phase", () => {
    // A group says "N lines under parent P moved by exactly R". Bucketing without
    // the parent makes that sentence false while keeping it plausible: five rows
    // and a parent id that is only true of the first three.
    const parent = [
      ...Array.from({ length: 3 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`)),
      ...Array.from({ length: 3 }, (_, i) => labor(i + 4, 70002, `LINE ${i + 4}`)),
    ];
    const draft = parent.map((row) => ({
      ...row,
      values: { ...row.values, craftConstant: 2.5 },
    }));
    const run = runPoolDiff("labor", parent, draft);
    expect(run.rows.length).toBe(6);
    expect(groupSystematic(run.rows, 5).groups).toEqual([]);
    expect(groupSystematic(run.rows, 3).groups.map((group) => group.parentPoolId)).toEqual([
      70001, 70002,
    ]);
  });

  it("leaves out the row that also changed phase and the one that also changed units", () => {
    // Both would otherwise land in this group's own bucket — same phase, same
    // field, same ratio — and a group is one signature. A line that arrived from
    // another phase is not the same item it was, and 0.6 LF becoming 0.6 EA is
    // 10x on a ten-foot spool with no number moving. Either one, swallowed into
    // "all seven lines under 70001 moved 3x", is a finding that was acknowledged
    // without ever being read.
    const parent = Array.from({ length: 7 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    parent[5] = labor(6, 70002, "LINE 6");
    const draft = parent.map((row, i) => ({
      ...row,
      parentPoolId: 70001,
      values: {
        ...row.values,
        craftConstant: 3,
        phasePoolId: 70001,
        ...(i === 6 ? { craftUnits: "EA" } : {}),
      },
    }));
    const { groups, rows } = groupSystematic(runPoolDiff("labor", parent, draft).rows, 5);
    expect(groups.length).toBe(1);
    expect(groups[0]?.rowCount).toBe(5);
    const at = (poolId: number): DiffRow | undefined => rows.find((row) => row.poolId === poolId);
    expect(at(6)?.flags).toContain("reparented");
    expect(at(7)?.flags).toContain("unit_changed");
    expect(at(6)?.systematicGroupId).toBeUndefined();
    expect(at(7)?.systematicGroupId).toBeUndefined();
  });

  it("never folds a retirement into a bulk re-rate", () => {
    // A deactivation is the one edit that removes work from the catalog, and a
    // group is a single signature covering N rows. Swallowing a retirement into
    // "all six lines moved 3x" is how a row leaves the book without anyone
    // agreeing to it.
    const parent = Array.from({ length: 6 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row, i) => ({
      ...row,
      values: { ...row.values, craftConstant: 3, ...(i === 5 ? { isActive: false } : {}) },
    }));
    const run = runPoolDiff("labor", parent, draft);
    const { groups, rows } = groupSystematic(run.rows, 5);
    expect(groups[0]?.rowCount).toBe(5);
    expect(rows.find((row) => row.poolId === 6)?.kind).toBe("deactivated");
    expect(rows.find((row) => row.poolId === 6)?.systematicGroupId).toBeUndefined();
  });

  it("never lets one pool's findings land on another pool's rows at the same id", () => {
    // Equipment numbers its rows from 0 to 133 and labor from 1 to 5,968, so
    // every equipment id is also a labor id. `publishGates` stores a signature
    // against a band id and a group id, and a signature that covered two pools
    // would retire an item its reader never saw.
    const rerate = runPoolDiff(
      "labor",
      Array.from({ length: 5 }, (_, i) => labor(i + 10, 70001, `LINE ${i + 10}`)),
      Array.from({ length: 5 }, (_, i) =>
        labor(i + 10, 70001, `LINE ${i + 10}`, { craftConstant: 3 })
      )
    );
    expect(rerate.groups.length).toBe(1);

    // One equipment row at an id inside that run, renamed and nothing else.
    const parent = EQUIP_V1[12] as DiffRowInput;
    const renamed: DiffRowInput = {
      ...parent,
      description: "MANLIFT - 60'",
      values: { ...parent.values, description: "MANLIFT - 60'" },
    };
    const equipmentRow = diffPair(
      "equipment",
      { poolId: parent.poolId, parent, draft: renamed },
      DEFAULT_DIFF_THRESHOLDS
    );
    expect(equipmentRow?.poolId).toBe(12);
    const mixed = [...rerate.rows, equipmentRow as DiffRow];

    expect(
      groupSystematic(mixed, 5).rows.find((row) => row.pool === "equipment")?.systematicGroupId
    ).toBeUndefined();

    const { bands } = detectShiftBands(
      [
        { pool: "labor", draftPoolId: 10, parentPoolIdOfKey: 9 },
        { pool: "labor", draftPoolId: 11, parentPoolIdOfKey: 10 },
        { pool: "labor", draftPoolId: 12, parentPoolIdOfKey: 11 },
      ],
      3
    );
    expect(bands.map((band) => band.id)).toEqual(["shift:labor:1:10-12"]);
    // And a run stops at the pool boundary however the observations arrive. Two
    // catalogs each sliding by one id is two findings: read as one they become a
    // band whose start and end ids name rows in a pool it never looked at, and
    // read in arrival order they shatter into six coincidences and are reported
    // as nothing at all.
    const interleaved = detectShiftBands(
      [
        { pool: "labor", draftPoolId: 10, parentPoolIdOfKey: 9 },
        { pool: "equipment", draftPoolId: 11, parentPoolIdOfKey: 10 },
        { pool: "labor", draftPoolId: 11, parentPoolIdOfKey: 10 },
        { pool: "equipment", draftPoolId: 12, parentPoolIdOfKey: 11 },
        { pool: "labor", draftPoolId: 12, parentPoolIdOfKey: 11 },
        { pool: "equipment", draftPoolId: 13, parentPoolIdOfKey: 12 },
      ],
      3
    );
    expect(interleaved.bands.map((band) => band.id)).toEqual([
      "shift:equipment:1:11-13",
      "shift:labor:1:10-12",
    ]);
    expect(interleaved.unbanded).toEqual([]);
    const marked = markShiftedRows(mixed, bands, []);
    expect(marked.find((row) => row.pool === "equipment")?.flags).not.toContain("shifted_payload");
    expect(marked.find((row) => row.poolId === 12 && row.pool === "labor")?.flags).toContain(
      "shifted_payload"
    );
  });

  it("leaves a row alone when two of its constants moved independently", () => {
    const parent = Array.from({ length: 6 }, (_, i) =>
      labor(i + 1, 70001, `LINE ${i + 1}`, { weldConstant: 1, weldUnits: "LF" })
    );
    const draft = parent.map((row, i) => ({
      ...row,
      values: {
        ...row.values,
        craftConstant: 3,
        // One row also doubles its weld constant: two large moves is two
        // judgements, not one policy.
        weldConstant: i === 0 ? 2 : 1,
      },
    }));
    const { groups, rows } = groupSystematic(runPoolDiff("labor", parent, draft).rows, 5);
    expect(groups[0]?.rowCount).toBe(5);
    expect(rows.find((row) => row.poolId === 1)?.systematicGroupId).toBeUndefined();
  });
});

describe("integrity the same pass computes", () => {
  it("refuses to believe a draft with two rows at one id", () => {
    // `loadTakeoffCatalog` resolves a catalog phase with `.unique()`, so a
    // duplicate does not degrade the phase list — it stops it loading, for every
    // estimate on the book.
    const parent = [labor(1, 70001, "A")];
    const draft = [labor(1, 70001, "A"), labor(1, 70001, "A")];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.integrity.duplicatePoolIds).toEqual([1]);
    expect(rowAt(run, 1).kind).toBe("duplicate_in_draft");
    // Two copies of the same row: `retryDraftBuild` replaying a range it had
    // already written, which deleting the extra fixes.
    expect(rowAt(run, 1).duplicateDiffers).toBe(false);
  });

  it("says when the two copies at one id disagree, which is a different accident", () => {
    // 0.6 in one copy and 4 in the other is not a replayed range — something
    // wrote a different row at that id, and which copy survives decides what
    // every future estimate on this line costs. Compared over the same roster,
    // so a copy that differs only in an absent `countsTowardTakeoff` still reads
    // as identical.
    const parent = [labor(1, 70001, "A")];
    const draft = [labor(1, 70001, "A"), labor(1, 70001, "A", { craftConstant: 4 })];
    const run = runPoolDiff("labor", parent, draft);
    const row = rowAt(run, 1);
    expect(row.kind).toBe("duplicate_in_draft");
    expect(row.duplicateDiffers).toBe(true);
    // The row still quotes the FIRST copy, so the pair the join emitted and the
    // row an admin reads describe the same document.
    expect(row.changes).toEqual([]);
  });

  it("refuses to close a pool whose scan restarted while its counts carried on", () => {
    // The resume this module cannot survive, and the reason it cannot be spotted
    // any other way: `PoolTally` is numbers and arrays and checkpoints cleanly,
    // while `DraftScanState` is a Map and two Sets and does not, so persisting
    // the half that serializes is the natural mistake. What it produces is a
    // pool reporting all four of its rows with a collision check that only ever
    // saw two of them — and G3 reads an empty collision list as a clean catalog.
    const rows = [
      labor(1, 70001, "FSW - ≤.75"),
      labor(2, 70001, "CUT - ≤2"),
      labor(3, 70001, "WELD - 6"),
      labor(4, 70001, "FSW  -  ≤.75"),
    ];
    const tally = newPoolTally();
    for (const row of rows) tallyPair(tally, { poolId: row.poolId, parent: row, draft: row }, null);

    const wholePool = newDraftScanState();
    for (const row of rows) observeDraftRow(wholePool, "labor", row);
    // The collision is between the first row and the last, so only a scan that
    // saw both can report it.
    expect(poolIntegrity("labor", tally, wholePool).keyCollisions).toEqual(["70001|FSW - <=.75"]);

    const resumedHalfway = newDraftScanState();
    for (const row of rows.slice(2)) observeDraftRow(resumedHalfway, "labor", row);
    expect(resumedHalfway.collisions).toEqual([]);
    expect(() => poolIntegrity("labor", tally, resumedHalfway)).toThrow(
      "The labor scan observed 2 draft rows while its tally counted 4"
    );
  });

  it("names the id of a cloned row the draft no longer has", () => {
    // The gate reads this list, and "nothing is missing" is the only reading of
    // an empty one — so the empty array the real files produce proves nothing on
    // its own. Nothing in the subsystem deletes a cloned row, which is exactly
    // why a row that vanished has to arrive with its id attached rather than as
    // a count.
    const parent = [labor(1, 70001, "A"), labor(2, 70001, "B"), labor(3, 70001, "C")];
    const draft = [labor(1, 70001, "A"), labor(3, 70001, "C")];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.integrity.missingFromDraft).toEqual([2]);
    expect(rowAt(run, 2).kind).toBe("missing_in_draft");
    expect(rowAt(run, 2).parentDescription).toBe("B");
    expect(rowAt(run, 2).descriptionsNormalizeEqual).toBe(false);
  });

  it("counts the rows it actually walked, including equipment id 0", () => {
    // Equipment is the one pool that starts at id 0, and 0 is the id every
    // "have I started yet" sentinel is written as. UNIQUE EQUIPMENT is identical
    // in both books, so dropping it would remove nothing from the audit trail
    // and quietly change only the denominator — which is how a row goes missing
    // without anyone noticing, the failure this whole subsystem is about.
    expect(equipmentRun.integrity.parentRowCount).toBe(129);
    expect(equipmentRun.integrity.draftRowCount).toBe(133);
    // Only 3 of 129 descriptions survived at their own id, so 3 rows is the whole
    // of what this bump left alone.
    expect(equipmentRun.summary.unchangedRowCount).toBe(3);
    expect(equipmentRun.summary.changedRowCount).toBe(130);
  });

  it("does not report a row it lost as a row it left alone", () => {
    // `unchanged` is a subtraction, so its denominator has to be the pairs the
    // join produced: one per parent row plus the additions. Measured against the
    // larger of the two row counts, a pool that lost three rows and gained three
    // reports the three it lost as untouched.
    const parent = [labor(1, 70001, "A"), labor(2, 70001, "B"), labor(3, 70001, "C")];
    const draft = [
      labor(1, 70001, "A", { craftConstant: 2 }),
      labor(3, 70001, "C"),
      labor(4, 70001, "D"),
    ];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.summary.changedRowCount).toBe(3);
    expect(run.summary.unchangedRowCount).toBe(1);
  });

  it("finds a labor line filed under a phase that does not exist", () => {
    // `shapeRow` parses phase_code and never checks the phase exists;
    // `insertPoolRow` writes the row at a dangling phasePoolId. The row then
    // counts toward rowCounts and is invisible in every picker, because they all
    // query by_book_phase_active under phases that DO exist.
    const parent = [labor(1, 70001, "A")];
    const draft = [labor(1, 70001, "A"), labor(2, 79999, "ORPHAN")];
    const run = runPoolDiff("labor", parent, draft, { validParentIds: new Set([70001]) });
    expect(run.integrity.danglingParentRefs).toEqual([{ poolId: 2, parentPoolId: 79999 }]);
  });

  it("catches a draft that gave two lines under one phase the same name", () => {
    // The matcher's founding premise is that a name plus a parent identifies one
    // item — true of all 5,897 v1 and 5,968 v2 rows. Publish is the last moment
    // fixing a break is free.
    const parent = [labor(1, 70001, "FSW - ≤.75"), labor(2, 70001, "FSW - ≥.75")];
    const draft = [labor(1, 70001, "FSW - ≤.75"), labor(2, 70001, "FSW  -  ≤.75")];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.integrity.keyCollisions).toEqual(["70001|FSW - <=.75"]);
  });

  it("keeps ≤ and ≥ apart, so the two pipe sizes are not one item", () => {
    // 509 real rows depend on this. Collapsing them would report a collision
    // that is not there and hide the one that is.
    const parent = [labor(1, 70001, "FSW - ≤.75"), labor(2, 70001, "FSW - ≥.75")];
    const run = runPoolDiff("labor", parent, parent);
    expect(run.integrity.keyCollisions).toEqual([]);
    expect(run.rows).toEqual([]);
  });

  it("counts a retirement as a retirement, not as a flipped boolean", () => {
    const parent = [labor(1, 70001, "A")];
    const draft = [labor(1, 70001, "A", { isActive: false })];
    const run = runPoolDiff("labor", parent, draft);
    expect(rowAt(run, 1).kind).toBe("deactivated");
    expect(run.summary.deactivatedPoolIds.labor).toEqual([1]);
    expect(flagsOf(rowAt(run, 1), "isActive")).toEqual(["live_read_field"]);
  });
});

describe("the summary the publish gates read", () => {
  it("calls the real labor bump a bulk edit: 1,199 edits on a 5,897-row pool", () => {
    // 20.3%, against a threshold of 20% set by the one real change event.
    expect(laborRun.summary.bulkEditPools).toEqual(["labor"]);
  });

  it("does not call 71 new rows a mass change, at 1.2% of the pool", () => {
    // The failure this threshold targets — an id column deleted in Excel, which
    // turns every row into an addition — sits at 100%.
    expect(laborRun.summary.massChangePools).toEqual([]);
  });

  it("counts a wave of retirements against the same threshold as a wave of additions", () => {
    // They share a cause — a file whose id column moved — and the one that
    // removes work is the one nobody sees, because a retired row simply stops
    // appearing in every picker that reads `by_book_active`.
    const parent = Array.from({ length: 20 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row, i) =>
      i < 2 ? { ...row, values: { ...row.values, isActive: false } } : row
    );
    const run = runPoolDiff("labor", parent, draft);
    expect(run.integrity.deactivatedCount).toBe(2);
    expect(run.integrity.addedCount).toBe(0);
    expect(run.summary.massChangePools).toEqual(["labor"]);
    // And it is not also called a bulk edit: nothing was re-rated.
    expect(run.summary.bulkEditPools).toEqual([]);
  });

  it("counts a wave of REactivations against that threshold too, at 2 of 20 rows", () => {
    // The mirror of a mass retirement and the same cause — a file whose id column
    // moved. A row coming back reappears in every picker that reads
    // `by_book_active` and in `loadTakeoffCatalog`, on every estimate on the
    // book, and nobody asked for it. Counted separately from the other two so
    // the gate can name which of the three happened: 400 rows returning is not
    // 400 rows leaving.
    const parent = Array.from({ length: 20 }, (_, i) =>
      labor(i + 1, 70001, `LINE ${i + 1}`, { isActive: i >= 2 })
    );
    const draft = parent.map((row, i) =>
      i < 2 ? { ...row, values: { ...row.values, isActive: true } } : row
    );
    const run = runPoolDiff("labor", parent, draft);
    expect(run.integrity.reactivatedCount).toBe(2);
    expect(run.integrity.deactivatedCount).toBe(0);
    expect(run.integrity.addedCount).toBe(0);
    expect(run.summary.massChangePools).toEqual(["labor"]);
  });

  it("says which labor items changed, because the benchmark can only price those", () => {
    expect(laborRun.summary.changedLaborPoolIds.length).toBe(1270);
    expect(laborRun.summary.changedLaborPoolIds).toContain(4725);
    expect(laborRun.summary.changedEquipmentPoolIds).toEqual([]);
  });

  it("keeps display-only changes visible when no money moved at all", () => {
    // A draft whose only changes are read-live fields shows $0.00 in the
    // benchmark and still changes what 736 finished estimates print.
    const parent = [labor(1, 70001, "A")];
    const draft = [labor(1, 70001, "A", { countsTowardTakeoff: true })];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.summary.effectCounts).toEqual({ priced_at_creation: 0, read_live: 1 });
    expect(run.summary.flagCounts.live_read_field).toBe(1);
  });

  it("counts one row that changed four fields as one row, not as four", () => {
    // Every count on this summary is row-denominated, because the screen reads
    // them as "how many rows do I have to look at" and the gates read them
    // against row counts. Two rows that each moved three priced fields are two
    // rows of work, and a 6 next to a pool of 2 is a number nobody can act on.
    const parent = [labor(1, 70001, "A"), labor(2, 70001, "B")];
    const draft = [
      labor(1, 70001, "A", { craftConstant: 3, weldConstant: 3, sortOrder: 20 }),
      labor(2, 70001, "B", { craftConstant: 3, weldConstant: 3, sortOrder: 20 }),
    ];
    const run = runPoolDiff("labor", parent, draft);
    expect(run.summary.effectCounts).toEqual({ priced_at_creation: 2, read_live: 0 });
    expect(run.summary.flagCounts.large_change).toBe(2);
  });

  it("calls four new takeoff flags under one phase the legacy bug arriving again", () => {
    // The InDemand phase-maintenance workbook names one to three exact lines per
    // phase. More means the flag was applied by pattern — which is legacy's
    // description matching, 2x on concrete and up to 28x on foundation phases.
    const parent = Array.from({ length: 6 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row, i) =>
      i < 4 ? { ...row, values: { ...row.values, countsTowardTakeoff: true } } : row
    );
    const run = runPoolDiff("labor", parent, draft);
    expect(run.summary.takeoffFlagBulkPhases).toEqual([70001]);
    expect(run.summary.flagCounts.takeoff_flags_bulk).toBe(4);
  });

  it("stamps those four rows, because the review screen lists them through by_diff_flag", () => {
    // `rateBookDiffRows` is read per flag class, never as one capped list, so a
    // finding that lives only in a counter names four rows nobody can retrieve:
    // the pool requirement says "labor rows were newly flagged in 1 phase" and
    // the evidence link comes back empty. `takeoff_flags_bulk` was the only
    // member of `DiffFlag` that never reached a row.
    const parent = Array.from({ length: 6 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row, i) =>
      i < 4 ? { ...row, values: { ...row.values, countsTowardTakeoff: true } } : row
    );
    const run = runPoolDiff("labor", parent, draft);
    expect(
      run.rows.filter((row) => row.flags.includes("takeoff_flags_bulk")).map((row) => row.poolId)
    ).toEqual([1, 2, 3, 4]);
    // And the counter is now read off those rows, so the number on the screen and
    // the rows behind the link cannot drift apart.
    expect(run.summary.flagCounts.takeoff_flags_bulk).toBe(4);
  });

  it("does not fire on three, which is what the workbook actually contains", () => {
    const parent = Array.from({ length: 6 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row, i) =>
      i < 3 ? { ...row, values: { ...row.values, countsTowardTakeoff: true } } : row
    );
    expect(runPoolDiff("labor", parent, draft).summary.takeoffFlagBulkPhases).toEqual([]);
  });

  it("does not count flags this draft inherited, only the ones it added", () => {
    // The failure mode of getting this wrong is the loud one: the production
    // book already carries legacy's pattern-matched flags — up to 28 lines on a
    // foundation phase — so a draft that touched nothing would trip the gate on
    // every phase, every time, and the gate would be switched off within a week.
    const parent = Array.from({ length: 6 }, (_, i) =>
      labor(i + 1, 70001, `LINE ${i + 1}`, { countsTowardTakeoff: true })
    );
    const draft = parent.map((row) => ({
      ...row,
      values: { ...row.values, sortOrder: 20 },
    }));
    const run = runPoolDiff("labor", parent, draft);
    expect(run.summary.takeoffFlagBulkPhases).toEqual([]);
    expect(run.summary.flagCounts.takeoff_flags_bulk).toBe(0);
  });

  it("counts the rows that were newly flagged, not every changed row under the phase", () => {
    // `takeoff_flags_bulk` is row-denominated like every other flag count, and
    // the rows it counts are the ones the finding is about. Counting the whole
    // phase would inflate the number the review screen puts next to a sentence
    // that names four specific lines.
    const parent = Array.from({ length: 8 }, (_, i) => labor(i + 1, 70001, `LINE ${i + 1}`));
    const draft = parent.map((row, i) => {
      if (i < 4) return { ...row, values: { ...row.values, countsTowardTakeoff: true } };
      if (i < 6) return { ...row, values: { ...row.values, craftConstant: 3 } };
      return row;
    });
    const run = runPoolDiff("labor", parent, draft);
    expect(run.summary.takeoffFlagBulkPhases).toEqual([70001]);
    expect(run.summary.changedRowCount).toBe(6);
    expect(run.summary.flagCounts.takeoff_flags_bulk).toBe(4);
  });

  it("carries the thresholds it was run under, so a changed convention is visible", () => {
    // `largeChangeRatio` is a pressure valve and also a way to tune the gate
    // into uselessness. Whoever moved it is recorded on the book.
    expect(laborRun.summary.thresholds).toEqual(DEFAULT_DIFF_THRESHOLDS);
  });
});
