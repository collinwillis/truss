/**
 * Which columns of the WBS HOME sheet show, and why.
 *
 * THREE LAYERS, the same model the activity grid uses one level down — and for
 * the same reason: the estimators' own report defines the column set, the data
 * decides what is worth width today, and the estimator has the last word.
 *
 *   1. REPORT DEFINITION — per WBS, from InDemand's "WBS Cost Report" workbook.
 *      Six columns describe a run of pipe (SIZE, FLC, SPEC, INSUL, INSL. SIZE,
 *      SHT) and appear only on the three breakdowns whose sheet carries them.
 *   2. DATA — a column with nothing behind it anywhere in this breakdown steps
 *      aside, and a piping column comes back wherever a phase actually holds
 *      one, whatever the breakdown is called.
 *   3. USER OVERRIDE — an explicit show/hide from the column menu, persisted
 *      per breakdown. Only DIFFERENCES from layer 2 are stored, so a column the
 *      estimator never touched keeps following the data.
 *
 * ⚠️ LAYERS 1 AND 2 COMPOSE WITH **OR**, WHERE THE ACTIVITY GRID USES AND.
 * That divergence is deliberate, and the piping columns are why. In the
 * activity grid both gates answer the same question — does this phase need this
 * column — so a column must clear both. Here they answer two different ones:
 * layer 1 says "this breakdown's report is DEFINED to carry these six", and
 * layer 2 says "a phase holds one of these, so it must not be invisible".
 * Under AND, a piping breakdown whose specs are not filled in yet would lose
 * the columns its report is made of, and a stray spec on a non-piping phase
 * would be data on screen nowhere. Either failure is worse than a column of
 * blanks, and the menu handles a column of blanks.
 *
 * @module
 */

/** Every column the report can render, in the client's order. */
export const PHASE_COLUMN_IDS = [
  "select",
  "completed",
  "phase",
  "size",
  "flc",
  "description",
  "spec",
  "insulation",
  "insulationSize",
  "sheet",
  "area",
  "status",
  "sys",
  "quantity",
  "unit",
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
] as const;

export type PhaseColumnId = (typeof PHASE_COLUMN_IDS)[number];

/** Columns the estimator may never hide — the row would stop being readable. */
export const UNHIDEABLE: ReadonlySet<PhaseColumnId> = new Set([
  "select",
  "phase",
  "description",
  "totalCost",
]);

/**
 * The five columns that make up labor, drawn as one bracketed channel.
 *
 * This is what keeps the two TOTAL columns apart: LABOR TOTAL is the last cell
 * INSIDE the bracket, the grand TOTAL is frozen outside it at the right edge.
 * See columns.tsx for the rest of that argument.
 */
export const LABOR_CHANNEL: ReadonlySet<PhaseColumnId> = new Set([
  "craftHours",
  "craftCost",
  "welderHours",
  "welderCost",
  "laborTotal",
]);

/** The six columns that describe a run of pipe rather than a phase. */
export const PIPING_COLUMN_IDS: readonly PhaseColumnId[] = [
  "size",
  "flc",
  "spec",
  "insulation",
  "insulationSize",
  "sheet",
];

/**
 * The breakdowns whose report sheet carries the piping columns.
 *
 * ⚠️ THE CODE DECIDES, NOT THE DATA. `phases.pipingSpec` is evidence and not
 * proof in either direction: a phase can carry a stray spec under a breakdown
 * that has nothing to do with pipe (legacy imports do exactly this), and a
 * genuine run of pipe has no spec at all until somebody types it. A rule read
 * off the data would therefore show six columns nobody wants on one estimate
 * and hide six columns the report is defined to have on the next — the column
 * set would change shape from bid to bid, which is the one thing a report
 * cannot do.
 *
 * The codes are the business's own: 70000 AG PIPING, 100000 INSULATION,
 * 130000 BG PIPING are the three rows their template marks, and the other
 * fifteen breakdowns do not. `wbsPoolId` is a catalog identity — stable across
 * estimates, and the same number the estimator reads in the rail — so the rule
 * is as durable as the template it comes from. Data still REVEALS (see the
 * module note); it is only forbidden from concealing.
 */
export const PIPING_WBS_POOL_IDS: ReadonlySet<number> = new Set([70000, 100000, 130000]);

/** Whether this breakdown's report is defined to carry the piping columns. */
export function isPipingWbs(wbsPoolId: number | undefined): boolean {
  return wbsPoolId !== undefined && PIPING_WBS_POOL_IDS.has(wbsPoolId);
}

/** What the phases of this breakdown actually hold — layer 2's input. */
export interface PhaseListContents {
  hasSize: boolean;
  hasFlc: boolean;
  hasSpec: boolean;
  hasInsulation: boolean;
  hasInsulationSize: boolean;
  hasSheet: boolean;
  hasSystem: boolean;
  hasArea: boolean;
  hasStatus: boolean;
  hasTakeoff: boolean;
  hasCraft: boolean;
  hasWelder: boolean;
  hasMaterial: boolean;
  hasEquipment: boolean;
  hasSubcontractor: boolean;
  hasCostOnly: boolean;
}

/** The fields {@link summarizeContents} reads — a subset of the report row. */
export interface PhaseContentSample {
  area: string | null;
  sheet: number | null;
  status: string | null;
  pipingSpec: {
    size?: string;
    spec?: string;
    flc?: string;
    system?: string;
    insulation?: string;
    insulationSize?: number;
  } | null;
  takeoff: { quantity: number; unit: string; isOverridden: boolean } | null;
  costs: {
    craftManHours: number;
    welderManHours: number;
    craftCost: number;
    welderCost: number;
    materialCost: number;
    equipmentCost: number;
    subcontractorCost: number;
    costOnlyCost: number;
  };
}

/** Whether any phase carries something in this field. */
function anyText(
  rows: readonly PhaseContentSample[],
  read: (row: PhaseContentSample) => string | null | undefined
): boolean {
  return rows.some((row) => {
    const value = read(row);
    return value !== null && value !== undefined && value.trim() !== "";
  });
}

export function summarizeContents(rows: readonly PhaseContentSample[]): PhaseListContents {
  return {
    hasSize: anyText(rows, (r) => r.pipingSpec?.size),
    hasFlc: anyText(rows, (r) => r.pipingSpec?.flc),
    hasSpec: anyText(rows, (r) => r.pipingSpec?.spec),
    hasInsulation: anyText(rows, (r) => r.pipingSpec?.insulation),
    hasInsulationSize: rows.some((r) => r.pipingSpec?.insulationSize !== undefined),
    hasSheet: rows.some((r) => r.sheet !== null),
    hasSystem: anyText(rows, (r) => r.pipingSpec?.system),
    hasArea: anyText(rows, (r) => r.area),
    hasStatus: anyText(rows, (r) => r.status),
    // A phase type with no takeoff unit reports null, and a whole breakdown of
    // them has no quantity to show — only a column of dashes.
    hasTakeoff: rows.some((r) => r.takeoff !== null),
    hasCraft: rows.some((r) => r.costs.craftManHours !== 0 || r.costs.craftCost !== 0),
    hasWelder: rows.some((r) => r.costs.welderManHours !== 0 || r.costs.welderCost !== 0),
    hasMaterial: rows.some((r) => r.costs.materialCost !== 0),
    hasEquipment: rows.some((r) => r.costs.equipmentCost !== 0),
    hasSubcontractor: rows.some((r) => r.costs.subcontractorCost !== 0),
    hasCostOnly: rows.some((r) => r.costs.costOnlyCost !== 0),
  };
}

/**
 * Layers 1 + 2 — the automatic answer, before the estimator has said anything.
 *
 * Only managed columns are written. TanStack reads `columnVisibility` as
 * "hidden only when present AND false", so the ones omitted here — the report's
 * spine: the selection box, the completion ring, the phase, its description and
 * the grand total — are always shown.
 */
export function autoVisibility(
  wbsPoolId: number | undefined,
  contents: PhaseListContents
): Record<string, boolean> {
  const piping = isPipingWbs(wbsPoolId);
  return {
    // Layer 1 OR layer 2 — see the module note for why this is not AND.
    size: piping || contents.hasSize,
    flc: piping || contents.hasFlc,
    spec: piping || contents.hasSpec,
    insulation: piping || contents.hasInsulation,
    insulationSize: piping || contents.hasInsulationSize,
    sheet: piping || contents.hasSheet,

    // SYS is a column of every WBS's sheet, but it reads from the same piping
    // record and is blank on most breakdowns. It is not typed into here, so a
    // column of blanks costs width and returns nothing; the data brings it
    // back on its own the moment a phase carries a system.
    sys: contents.hasSystem,
    area: contents.hasArea,
    status: contents.hasStatus,

    // Quantity and unit travel together — a unit with no figure beside it is
    // not a column, it is a caption.
    quantity: contents.hasTakeoff,
    unit: contents.hasTakeoff,

    craftHours: contents.hasCraft,
    craftCost: contents.hasCraft,
    welderHours: contents.hasWelder,
    welderCost: contents.hasWelder,
    laborTotal: contents.hasCraft || contents.hasWelder,

    materialCost: contents.hasMaterial,
    equipmentCost: contents.hasEquipment,
    subcontractorCost: contents.hasSubcontractor,
    costOnlyCost: contents.hasCostOnly,
  };
}

/** Layer 3. Merge the estimator's explicit choices over the automatic model. */
export function mergeVisibility(
  auto: Record<string, boolean>,
  overrides: Record<string, boolean>
): Record<string, boolean> {
  return { ...auto, ...overrides };
}

/**
 * Keep only the choices that actually disagree with the automatic model.
 *
 * WHY NOT STORE EVERYTHING: a stored copy of today's automatic answer would
 * freeze it. Price a subcontractor into this breakdown next week and the
 * SUBCONTRACT column must appear on its own; it only can if the estimator
 * never "chose" the value it already had.
 */
export function pruneOverrides(
  auto: Record<string, boolean>,
  merged: Record<string, boolean>
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const [id, visible] of Object.entries(merged)) {
    const autoValue = auto[id] ?? true;
    if (visible !== autoValue) overrides[id] = visible;
  }
  return overrides;
}

/**
 * Preferences are stored per ESTIMATE AND BREAKDOWN.
 *
 * The same scope the activity grid uses, deliberately: the two grids sit on
 * either side of one drill-down, and a column choice that survived the trip
 * down but not the trip back would read as the screen forgetting.
 */
export function visibilityStorageKey(proposalId: string, wbsPoolId: number | undefined): string {
  return `precision.phaselist.columns.${proposalId}.${wbsPoolId ?? "unknown"}`;
}

export function loadOverrides(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // Trust nothing from storage: a stale key from an older column set would
    // otherwise hide a column that no longer has a menu entry to restore it.
    const clean: Record<string, boolean> = {};
    for (const id of PHASE_COLUMN_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === "boolean") clean[id] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveOverrides(key: string, overrides: Record<string, boolean>): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(overrides));
  } catch {
    // A full or disabled localStorage must not break the report.
  }
}

/** Column WIDTHS, same scope as visibility, separate key so neither disturbs the other. */
export function sizingStorageKey(proposalId: string, wbsPoolId: number | undefined): string {
  return `precision.phaselist.colwidths.${proposalId}.${wbsPoolId ?? "unknown"}`;
}

export function loadSizing(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const clean: Record<string, number> = {};
    for (const id of PHASE_COLUMN_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      // A stored NaN or a negative would collapse the column with no way back.
      if (typeof value === "number" && Number.isFinite(value) && value > 0) clean[id] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveSizing(key: string, sizing: Record<string, number>): void {
  try {
    if (Object.keys(sizing).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(sizing));
  } catch {
    // A full or disabled localStorage must not break the report.
  }
}
