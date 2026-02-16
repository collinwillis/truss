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
  earnedMH: number;
  percentComplete: number;
  status: ProgressStatus;
}

/**
 * Phase item representing a sub-division of WBS work.
 */
export interface PhaseItem {
  id: string;
  wbsId: string;
  code: string;
  description: string;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  status: ProgressStatus;
}

/**
 * Detail item representing individual work tasks with quantity tracking.
 */
export interface DetailItem {
  id: string;
  wbsId: string;
  phaseId: string;
  description: string;
  quantity: number;
  unit: string;
  quantityComplete: number;
  quantityRemaining: number;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
}

/**
 * Daily progress entry representing quantities completed on a specific date.
 */
export interface ProgressEntry {
  id: string;
  detailItemId: string;
  entryDate: string; // ISO date string (YYYY-MM-DD)
  quantityCompleted: number;
  enteredBy: string;
  createdAt: string; // ISO timestamp
}

/**
 * Calculated progress metrics for a detail item.
 */
export interface ProgressMetrics {
  previousTotal: number;
  todaysEntry: number;
  newTotal: number;
  remaining: number;
  percentComplete: number;
}
