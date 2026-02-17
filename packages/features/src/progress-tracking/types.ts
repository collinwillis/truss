/**
 * Type definitions for progress tracking features.
 */

export type { Project } from "./project-card";

/**
 * Progress status derived from earned man-hours percentage.
 */
export type ProgressStatus = "not-started" | "in-progress" | "complete";

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
