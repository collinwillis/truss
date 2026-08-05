import { WBS_REPORT_COLUMN_IDS } from "./columns";

/**
 * How this estimator likes to READ the cost report.
 *
 * Column widths, and whether the untouched breakdowns are folded away, are
 * preferences about looking rather than facts about the estimate — so they live
 * in localStorage, the same split the proposal log and the catalog already
 * make. One key each for the whole app rather than one per estimate: the report
 * has a single shape, and a per-bid preference would only mean teaching it
 * again on every bid.
 *
 * @module
 */

const SIZING_KEY = "precision.wbsreport.colwidths";
const EMPTIES_KEY = "precision.wbsreport.showempty";

/** Stored column widths, with anything unrecognisable discarded. */
export function loadSizing(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SIZING_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const clean: Record<string, number> = {};
    for (const id of WBS_REPORT_COLUMN_IDS) {
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
    // A full or disabled localStorage must not break the report.
  }
}

/**
 * Whether the breakdowns carrying no work are unfolded.
 *
 * Defaults to folded: five of eighteen is the measured median, so the default
 * has to serve that and not the exception.
 */
export function loadShowEmpty(): boolean {
  try {
    return localStorage.getItem(EMPTIES_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveShowEmpty(showEmpty: boolean): void {
  try {
    if (showEmpty) localStorage.setItem(EMPTIES_KEY, "true");
    else localStorage.removeItem(EMPTIES_KEY);
  } catch {
    // As above — a preference that cannot be stored is not an error.
  }
}
