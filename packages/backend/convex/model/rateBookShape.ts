import type { Doc } from "../_generated/dataModel";
import type { PoolKind } from "./rateBookCsv";
import type { MatchCandidate } from "./rateBookMatch";
import type { FieldValue } from "./rateBookRows";

/**
 * The four mappings between a catalog row and everything else.
 *
 * ⚠️ THESE MUST AGREE WITH EACH OTHER, and the agreement is not obvious from
 * reading any one of them:
 *
 *  - `toSheetRow` writes a cell for every column in `COLUMNS`.
 *  - `shapeRow` reads those cells back into fields.
 *  - `beforeOf` reports what the row holds today, for the same fields.
 *  - `candidateOf` / `candidatePayload` describe the row to the matcher from
 *    the two different sides of a comparison.
 *
 * Forget one field in `beforeOf` and every untouched row reads as an edit.
 * Forget one in `candidatePayload` and a rename can never be corroborated, so
 * every rename becomes an unexplained conflict. Neither failure is visible in
 * a unit test of any single function, which is why they live in one file and
 * are tested as a loop: export the real 5,897-row catalog, read it back, and
 * assert that nothing changed.
 *
 * Pure, so that test runs in plain Node against the real fixture.
 */

export type PoolRow = Doc<"wbsPool"> | Doc<"phasePool"> | Doc<"laborPool"> | Doc<"equipmentPool">;

/** Names the ids alone do not carry, for the sheet's `ref_` columns. */
export interface SheetRefs {
  wbsNames: ReadonlyMap<number, string>;
  phases: ReadonlyMap<number, { name: string; wbsPoolId: number }>;
}

export const NO_REFS: SheetRefs = { wbsNames: new Map(), phases: new Map() };

const num = (value: number): string => String(value);
const bool = (value: boolean): string => (value ? "TRUE" : "FALSE");

/** One catalog row as a line of the exported sheet, in `COLUMNS` order. */
export function toSheetRow(pool: PoolKind, row: PoolRow, refs: SheetRefs): string[] {
  if (pool === "wbs") {
    const r = row as Doc<"wbsPool">;
    return [num(r.poolId), r.name, num(r.sortOrder), bool(r.isActive)];
  }
  if (pool === "phases") {
    const r = row as Doc<"phasePool">;
    return [
      num(r.poolId),
      num(r.wbsPoolId),
      r.name,
      num(r.sortOrder),
      r.takeoffUnit ?? "",
      // A FLAG, not a number: "this phase always carries its id as the phase
      // number" (Hydrotesting is always 79996). The original spec called the
      // column reserved_phase_number, which reads like a number and would have
      // had someone typing 79996 into a true/false cell.
      bool(r.reservedPhaseNumber ?? false),
      bool(r.isActive),
      refs.wbsNames.get(r.wbsPoolId) ?? "",
    ];
  }
  if (pool === "labor") {
    const r = row as Doc<"laborPool">;
    const parent = refs.phases.get(r.phasePoolId);
    return [
      num(r.poolId),
      num(r.phasePoolId),
      r.description,
      num(r.sortOrder),
      num(r.craftConstant),
      r.craftUnits,
      num(r.weldConstant),
      r.weldUnits,
      bool(r.countsTowardTakeoff ?? false),
      bool(r.isActive),
      parent ? num(parent.wbsPoolId) : "",
      parent?.name ?? "",
    ];
  }
  const r = row as Doc<"equipmentPool">;
  return [
    num(r.poolId),
    r.description,
    num(r.hourRate),
    num(r.dayRate),
    num(r.weekRate),
    num(r.monthRate),
    num(r.sortOrder),
    bool(r.isActive),
  ];
}

/** How an existing row presents itself to the matcher. */
export function candidateOf(pool: PoolKind, row: PoolRow): MatchCandidate {
  if (pool === "labor") {
    const r = row as Doc<"laborPool">;
    return {
      poolId: r.poolId,
      description: r.description,
      parentPoolId: r.phasePoolId,
      payload: {
        craftConstant: r.craftConstant,
        craftUnits: r.craftUnits,
        weldConstant: r.weldConstant,
        weldUnits: r.weldUnits,
        phase: r.phasePoolId,
      },
    };
  }
  if (pool === "phases") {
    const r = row as Doc<"phasePool">;
    return { poolId: r.poolId, description: r.name, parentPoolId: r.wbsPoolId, payload: {} };
  }
  if (pool === "wbs") {
    const r = row as Doc<"wbsPool">;
    return { poolId: r.poolId, description: r.name, payload: {} };
  }
  const r = row as Doc<"equipmentPool">;
  return {
    poolId: r.poolId,
    description: r.description,
    payload: {
      hourRate: r.hourRate,
      dayRate: r.dayRate,
      weekRate: r.weekRate,
      monthRate: r.monthRate,
    },
  };
}

/**
 * The same fingerprint, built from a file row instead of a stored one.
 *
 * MUST cover exactly the fields `candidateOf` puts in `payload`, or the two
 * sides of a comparison are describing different things.
 */
export function candidatePayload(
  pool: PoolKind,
  values: Record<string, FieldValue>
): Record<string, string | number> {
  const pick = (key: string): string | number => {
    const value = values[key];
    if (typeof value === "boolean") return String(value);
    return value ?? "";
  };
  if (pool === "labor") {
    return {
      craftConstant: pick("craftConstant"),
      craftUnits: pick("craftUnits"),
      weldConstant: pick("weldConstant"),
      weldUnits: pick("weldUnits"),
      phase: pick("phasePoolId"),
    };
  }
  if (pool === "equipment") {
    return {
      hourRate: pick("hourRate"),
      dayRate: pick("dayRate"),
      weekRate: pick("weekRate"),
      monthRate: pick("monthRate"),
    };
  }
  return {};
}

/**
 * What a matched row holds today, for the preview's before/after.
 *
 * MUST cover every field `shapeRow` can write. Miss one and an untouched row
 * reads as an edit — and an admin who sees 5,897 "changes" after touching
 * nothing will never trust the preview again.
 */
export function beforeOf(pool: PoolKind, row: PoolRow): Record<string, FieldValue> {
  if (pool === "labor") {
    const r = row as Doc<"laborPool">;
    return {
      description: r.description,
      sortOrder: r.sortOrder,
      craftConstant: r.craftConstant,
      craftUnits: r.craftUnits,
      weldConstant: r.weldConstant,
      weldUnits: r.weldUnits,
      countsTowardTakeoff: r.countsTowardTakeoff ?? false,
      isActive: r.isActive,
      phasePoolId: r.phasePoolId,
    };
  }
  if (pool === "equipment") {
    const r = row as Doc<"equipmentPool">;
    return {
      description: r.description,
      hourRate: r.hourRate,
      dayRate: r.dayRate,
      weekRate: r.weekRate,
      monthRate: r.monthRate,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
    };
  }
  if (pool === "phases") {
    const r = row as Doc<"phasePool">;
    return {
      name: r.name,
      sortOrder: r.sortOrder,
      takeoffUnit: r.takeoffUnit ?? "",
      reservedPhaseNumber: r.reservedPhaseNumber ?? false,
      isActive: r.isActive,
      wbsPoolId: r.wbsPoolId,
    };
  }
  const r = row as Doc<"wbsPool">;
  return { name: r.name, sortOrder: r.sortOrder, isActive: r.isActive };
}
