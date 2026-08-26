/**
 * Which log columns show, how wide, and what the estimator changed.
 *
 * The phase grid's equivalent module answers a harder question — three layers
 * of template, data and user, scoped per WBS. The log needs none of that: it
 * is ONE list with ONE set of columns, so the model here is a fixed default
 * table plus the user's diffs against it. The two modules are deliberately
 * separate rather than shared; the phase grid's is hardcoded to
 * `ACTIVITY_COLUMN_IDS` in both loaders and carries its own tests.
 */

/** Every column the log can render, in display order. */
export const LOG_COLUMN_IDS = [
  "number",
  "description",
  "client",
  "location",
  "estimators",
  "bidType",
  "received",
  "due",
  "status",
  "jobNumber",
  "startDate",
  "endDate",
  "amount",
] as const;

export type LogColumnId = (typeof LOG_COLUMN_IDS)[number];

/** Columns the user may never hide — the row would stop being identifiable. */
export const UNHIDEABLE: ReadonlySet<LogColumnId> = new Set(["number", "description"]);

/**
 * The fixed default view.
 *
 * Chosen against MEASURED fill rates over the live 731 proposals, not taste:
 * every default-on column clears 73%.
 *
 * `jobNumber` is off despite being a column of their sheet: at 8% fill it is
 * 92% whitespace, and the estimators would rather have the width. One click
 * in the column menu brings it back, and the choice is remembered.
 *
 * `startDate` (46%) and `endDate` (38%) are real columns of the client's own
 * sheet but too sparse to spend default width on. `amount` is the reserved
 * seat — see {@link autoVisibility}.
 */
export const DEFAULT_VISIBILITY: Record<LogColumnId, boolean> = {
  number: true,
  description: true,
  client: true,
  location: true,
  estimators: true,
  bidType: true,
  received: true,
  due: true,
  status: true,
  jobNumber: false,
  startDate: false,
  endDate: false,
  amount: false,
};

/**
 * The ONE automatic rule: a column with no data anywhere stays hidden.
 *
 * This exists for `amount`, which is fully built — width, currency renderer,
 * comparator, pinned slot, menu entry — but has no field behind it yet. Rather
 * than special-casing it with a disabled "coming soon" row, or shipping 731
 * em-dashes, it is hidden by the same rule that would hide any empty column,
 * and it appears on its own the moment ANY row carries a value.
 *
 * `some` rather than a percentage on purpose: a partial backfill must not
 * leave the money column mysteriously absent at 55% fill.
 */
export function autoVisibility(
  rows: ReadonlyArray<{ amount?: number | null }>
): Partial<Record<LogColumnId, boolean>> {
  return { amount: rows.some((r) => r.amount != null) };
}

/** Merge the estimator's explicit choices over the computed model. */
export function mergeVisibility(
  auto: Record<string, boolean>,
  overrides: Record<string, boolean>
): Record<string, boolean> {
  return { ...auto, ...overrides };
}

/**
 * Keep only the choices that disagree with what the model would have said.
 *
 * ⚠️ PRUNED AGAINST THE COMPUTED MODEL, not the static defaults. Amount's
 * default is `false` while the auto rule turns it `true` as soon as data
 * exists — measuring against the static table would record that automatic
 * answer as though the estimator had chosen it, freezing it, and would make
 * an explicit "hide Amount" indistinguishable from the default so the column
 * reappeared on the next server push. Comparing against the same model that
 * produced the merge means a stored override is always a real disagreement.
 */
export function pruneOverrides(
  auto: Record<string, boolean>,
  merged: Record<string, boolean>
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const id of LOG_COLUMN_IDS) {
    const value = merged[id];
    if (value === undefined) continue;
    const autoValue = auto[id] ?? DEFAULT_VISIBILITY[id];
    if (value !== autoValue) overrides[id] = value;
  }
  return overrides;
}

/**
 * One key each, not per-scope.
 *
 * Unlike the phase grid — where columns belong to a kind of work and the
 * scope is the WBS — the log is a single list, so a single preference is the
 * whole truth.
 */
const VISIBILITY_KEY = "precision.estimates.columns";
const SIZING_KEY = "precision.estimates.colwidths";

export function loadOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // Trust nothing from storage: a stale key from an older column set would
    // otherwise hide a column that no longer has a menu entry to restore it.
    const clean: Record<string, boolean> = {};
    for (const id of LOG_COLUMN_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === "boolean") clean[id] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveOverrides(overrides: Record<string, boolean>): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(VISIBILITY_KEY);
    else localStorage.setItem(VISIBILITY_KEY, JSON.stringify(overrides));
  } catch {
    // A full or disabled localStorage must not break the log.
  }
}

export function loadSizing(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SIZING_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const clean: Record<string, number> = {};
    for (const id of LOG_COLUMN_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      // A stored NaN or a negative would collapse the column with no way back.
      if (typeof value === "number" && Number.isFinite(value) && value > 0) clean[id] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveSizing(sizing: Record<string, number>): void {
  try {
    if (Object.keys(sizing).length === 0) localStorage.removeItem(SIZING_KEY);
    else localStorage.setItem(SIZING_KEY, JSON.stringify(sizing));
  } catch {
    // A full or disabled localStorage must not break the log.
  }
}
