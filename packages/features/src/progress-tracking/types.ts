/**
 * Type definitions for progress tracking features.
 */

export type { Project } from "./project-card";

/**
 * Progress status derived from earned man-hours percentage.
 */
export type ProgressStatus = "not-started" | "in-progress" | "complete";

/**
 * Column visibility mode for the workbook table.
 *
 * WHY: Entry mode shows minimal columns for rapid data entry;
 * Full mode exposes all 9 columns for detailed review.
 */
export type ColumnMode = "entry" | "full";

/**
 * Filter options for the workbook table.
 *
 * WHY: Separates overview, items needing entry, and items with date entries
 * so users can focus on the data entry task at hand.
 */
export type WorkbookFilter = "all" | "needs-entry" | "date-entries";

/**
 * WBS (Work Breakdown Structure) item with progress tracking data.
 */
export interface WBSItem {
  id: string;
  code: string;
  description: string;
  totalMH: number;
  craftMH?: number;
  weldMH?: number;
  earnedMH: number;
  percentComplete: number;
  status: ProgressStatus;
}

/**
 * Flat row for workbook-style table display.
 *
 * Each row is a labor activity with parent WBS/Phase context embedded
 * for a single-table workbook layout.
 */
export interface WorkbookRow {
  id: string;
  wbsId: string;
  phaseId: string;
  wbsCode: string;
  phaseCode: string;
  size: string;
  flc: string;
  description: string;
  spec: string;
  insulation: string;
  insulationSize: number | null;
  sheet: number | null;
  quantity: number;
  unit: string;
  craftMH: number;
  weldMH: number;
  totalMH: number;
  quantityComplete: number;
  quantityRemaining: number;
  earnedMH: number;
  remainingMH: number;
  percentComplete: number;
  sortOrder: number;
}

/**
 * Summary rollup data for WBS or Phase group rows.
 */
export interface GroupSummary {
  description: string;
  totalMH: number;
  earnedMH: number;
  craftMH: number;
  weldMH: number;
  percentComplete: number;
}

/**
 * Phase-level progress data for the reports page.
 */
export interface PhaseProgress {
  id: string;
  code: string;
  description: string;
  activityCount: number;
  totalMH: number;
  craftMH: number;
  weldMH: number;
  earnedMH: number;
  remainingMH: number;
  percentComplete: number;
  status: ProgressStatus;
}

/**
 * WBS item with nested phase-level progress breakdown.
 */
export interface WBSWithPhases {
  id: string;
  code: string;
  description: string;
  totalMH: number;
  craftMH: number;
  weldMH: number;
  earnedMH: number;
  remainingMH: number;
  percentComplete: number;
  status: ProgressStatus;
  phases: PhaseProgress[];
}

/**
 * Single entry in the history panel.
 */
export interface HistoryEntry {
  activityId: string;
  activityDescription: string;
  unit: string;
  quantityCompleted: number;
  enteredBy?: string;
  notes?: string;
}

/**
 * Grouped day of entries for the history panel.
 */
export interface HistoryDay {
  date: string;
  totalQuantity: number;
  entryCount: number;
  entries: HistoryEntry[];
}
