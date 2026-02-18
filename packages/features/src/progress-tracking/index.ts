/**
 * Progress tracking features for Momentum.
 *
 * Provides components and utilities for tracking project progress,
 * WBS hierarchy visualization, and daily quantity entry.
 */

export { ProjectCard } from "./project-card";
export type { ProjectCardProps, Project } from "./project-card";
export { ProjectSwitcher } from "./project-switcher";
export type { ProjectSwitcherProps } from "./project-switcher";
export { ProjectProvider, useProject, useHasProject, useCurrentProject } from "./project-context";
export type { ProjectContextValue, ProjectProviderProps } from "./project-context";
export { WBSCard } from "./wbs-card";
export type { WBSCardProps } from "./wbs-card";
export { WorkbookTable } from "./workbook-table";
export type { WorkbookTableProps, ProjectStats } from "./workbook-table";
export { EntryCellInput } from "./entry-cell-input";
export type { EntryCellInputProps } from "./entry-cell-input";
export { NotePopover } from "./note-popover";
export type { NotePopoverProps } from "./note-popover";
export { EntryHistoryPanel } from "./entry-history-panel";
export type { EntryHistoryPanelProps } from "./entry-history-panel";
export type {
  WBSItem,
  ProgressStatus,
  WorkbookRow,
  GroupSummary,
  ColumnMode,
  WorkbookFilter,
  PhaseProgress,
  WBSWithPhases,
  HistoryEntry,
  HistoryDay,
} from "./types";
