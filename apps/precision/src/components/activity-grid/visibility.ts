import type { ActivityType } from "@truss/features/activities";

/**
 * Which activity columns show, and why.
 *
 * THREE LAYERS, in order — the model the legacy grid used and the one the
 * estimators' own template describes:
 *
 *   1. TEMPLATE BASELINE — per WBS, from InDemand's "WBS Cost Report — Default
 *      Template" workbook (PHASE DETAIL sheet, green = shown). This is the
 *      business's own spec, not a guess.
 *   2. DATA REVEAL — a column the baseline hides comes BACK when the phase
 *      actually contains lines that need it. The merge is `baseline || data`,
 *      so the template sets the quiet default and the data overrules it. A
 *      phase with equipment lines shows Duration and Ownership even under a
 *      WBS whose template hides them.
 *   3. USER OVERRIDE — an explicit show/hide from the column menu, persisted.
 *      Only DIFFERENCES from layer 2 are stored, so a column the user never
 *      touched keeps following the data (add an equipment line later and it
 *      still appears).
 *
 * ⚠️ ONE DELIBERATE DIVERGENCE FROM LEGACY: legacy's baseline table hides the
 * welder columns on WBS `20000` (SITE PREPARATION) and has no entry at all for
 * `200000` (SUPPORT). The template says the opposite, and the template is
 * right — SUPPORT is where firewatch/manwatch standby roles live and nobody
 * welds, while site prep does. A missing zero, carried for years. We follow
 * the template.
 */

/** Every column the grid can render, in template order. */
export const ACTIVITY_COLUMN_IDS = [
  "select",
  "type",
  "description",
  "quantity",
  "unit",
  "time",
  "price",
  "ownership",
  "craftConstant",
  "craftManHours",
  "craftRate",
  "craftCost",
  "welderConstant",
  "welderManHours",
  "welderRate",
  "welderCost",
  "subsistenceRate",
  "materialCost",
  "equipmentCost",
  "subcontractorCost",
  "costOnlyCost",
  "totalCost",
] as const;

export type ActivityColumnId = (typeof ACTIVITY_COLUMN_IDS)[number];

/** Columns the user may never hide — the row would stop being identifiable. */
export const UNHIDEABLE: ReadonlySet<ActivityColumnId> = new Set([
  "select",
  "description",
  "totalCost",
]);

/** SUPPORT — the only WBS whose template differs. */
const SUPPORT_WBS_POOL_ID = 200000;

/**
 * Layer 1. `false` = hidden by default under this WBS; absent = shown.
 *
 * Every WBS in the workbook hides Duration, Price and Ownership; SUPPORT
 * instead shows those three and hides the welder columns.
 */
export function templateBaseline(
  wbsPoolId: number | undefined
): Partial<Record<ActivityColumnId, boolean>> {
  if (wbsPoolId === SUPPORT_WBS_POOL_ID) {
    return {
      welderConstant: false,
      welderManHours: false,
      welderRate: false,
      welderCost: false,
    };
  }
  return { time: false, price: false, ownership: false };
}

/** What the phase actually contains — layer 2's input. */
export interface PhaseContents {
  hasLabor: boolean;
  hasMaterial: boolean;
  hasEquipment: boolean;
  hasSubcontractor: boolean;
  hasCostOnly: boolean;
  /** Any line may carry a per-line rate override (D6). */
  hasRateEligible: boolean;
}

export function summarizeContents(
  rows: ReadonlyArray<{ type: ActivityType; canOverrideRates: boolean }>
): PhaseContents {
  return {
    hasLabor: rows.some((r) => r.type === "labor" || r.type === "custom_labor"),
    hasMaterial: rows.some((r) => r.type === "material"),
    hasEquipment: rows.some((r) => r.type === "equipment"),
    hasSubcontractor: rows.some((r) => r.type === "subcontractor"),
    hasCostOnly: rows.some((r) => r.type === "cost_only"),
    hasRateEligible: rows.some((r) => r.canOverrideRates),
  };
}

/**
 * Layers 1 + 2. The reveal conditions are legacy's, verbatim — a subcontractor
 * line reveals the equipment and material columns because a sub's bid is
 * broken down into exactly those buckets.
 */
export function autoVisibility(
  wbsPoolId: number | undefined,
  contents: PhaseContents
): Record<string, boolean> {
  const baseline = templateBaseline(wbsPoolId);
  const model: Record<string, boolean> = {};

  const reveal = (id: ActivityColumnId, condition: boolean) => {
    // `baseline || condition`: the template's `false` is a quiet default, not
    // a prohibition — data that needs the column brings it back.
    model[id] = (baseline[id] ?? true) || condition;
  };

  const laborish = contents.hasLabor;
  reveal("craftConstant", laborish);
  reveal("craftManHours", laborish);
  reveal("craftCost", laborish || contents.hasSubcontractor);
  reveal("welderConstant", laborish);
  reveal("welderManHours", laborish);
  reveal("welderRate", laborish);
  reveal("welderCost", laborish);

  // Rate columns follow D6 eligibility, not line type: on an ineligible phase
  // they are a column of dashes.
  reveal("craftRate", contents.hasRateEligible);
  reveal("subsistenceRate", contents.hasRateEligible);

  reveal("ownership", contents.hasEquipment || contents.hasSubcontractor);
  reveal("equipmentCost", contents.hasEquipment || contents.hasSubcontractor);
  reveal("time", contents.hasEquipment || contents.hasSubcontractor);
  reveal("materialCost", contents.hasMaterial || contents.hasSubcontractor);
  reveal("subcontractorCost", contents.hasSubcontractor);
  reveal("costOnlyCost", contents.hasCostOnly);
  reveal("price", contents.hasEquipment || contents.hasMaterial || contents.hasCostOnly);

  return model;
}

/**
 * Layer 3. Merge the user's explicit choices over the automatic model.
 *
 * TanStack reads `columnVisibility` as "hidden only when present AND false",
 * so absent keys are visible — which is why the automatic model writes every
 * managed column explicitly rather than relying on omission.
 */
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
 * freeze it. Add an equipment line next week and Duration must appear on its
 * own; it only can if the user never "chose" the value it already had.
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
 * Preferences are stored PER WBS, not per phase.
 *
 * Phases under one WBS are the same kind of work with the same column needs —
 * legacy stored per phase, which meant re-hiding the same column on every one
 * of a WBS's 2,000 phases.
 */
export function visibilityStorageKey(proposalId: string, wbsPoolId: number | undefined): string {
  return `precision.columns.${proposalId}.${wbsPoolId ?? "unknown"}`;
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
    for (const id of ACTIVITY_COLUMN_IDS) {
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
    // A full or disabled localStorage must not break the grid.
  }
}
