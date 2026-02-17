"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
import { Input } from "@truss/ui/components/input";
import { Textarea } from "@truss/ui/components/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";
import {
  ChevronRight,
  Search,
  CircleDot,
  Check,
  MessageSquare,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import type { WorkbookRow, GroupSummary, ColumnMode, WorkbookFilter } from "./types";

/** A display row — either a group header or a detail row. */
interface TableDisplayRow {
  rowType: "wbs" | "phase" | "detail";
  id: string;
  wbsCode: string;
  phaseCode: string;
  description: string;
  quantity: number;
  unit: string;
  totalMH: number;
  quantityComplete: number;
  quantityRemaining: number;
  earnedMH: number;
  percentComplete: number;
  subRows?: TableDisplayRow[];
}

/** Project-level statistics for the summary bar. */
export interface ProjectStats {
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  status: string;
}

export interface WorkbookTableProps {
  /** Flat activity rows from the `getBrowseData` query. */
  rows: WorkbookRow[];
  /** WBS-level rollup summaries keyed by WBS ID. */
  wbsSummaries: Record<string, GroupSummary>;
  /** Phase-level rollup summaries keyed by Phase ID. */
  phaseSummaries: Record<string, GroupSummary>;
  /** Label for the entry column header (e.g., "Feb 15"). */
  entryDateLabel?: string;
  /** Existing entries for the selected date, keyed by activity ID. */
  existingEntries?: Record<string, number>;
  /** Values for the inline entry column keyed by activity ID. */
  entryValues?: Record<string, string>;
  /** Callback when an inline entry value changes. Also triggers debounced save. */
  onEntryChange?: (activityId: string, value: string) => void;
  /**
   * Called when the user leaves a cell (blur).
   * Parent should flush any pending debounce and clear local state.
   */
  onBlurSave?: (activityId: string) => void;
  /** Discard handler called on Escape to revert a local edit. */
  onEntryDiscard?: (activityId: string) => void;
  /** Project-level stats for the summary bar. */
  projectStats?: ProjectStats;
  /** Column display mode. */
  columnMode?: ColumnMode;
  /** Callback when column mode changes. */
  onColumnModeChange?: (mode: ColumnMode) => void;
  /** Existing notes for the selected date, keyed by activity ID. */
  existingNotes?: Record<string, string>;
  /** Callback when a note is saved. */
  onNoteSave?: (activityId: string, notes: string) => void;
  /** Per-cell save status indicators. */
  saveStates?: Record<string, "saving" | "saved" | "error">;
}

/** Build nested tree for TanStack Table expand/collapse. */
function buildTree(
  rows: WorkbookRow[],
  wbsSummaries: Record<string, GroupSummary>,
  phaseSummaries: Record<string, GroupSummary>
): TableDisplayRow[] {
  const wbsMap = new Map<string, { code: string; rows: WorkbookRow[] }>();
  const phaseMap = new Map<string, { wbsId: string; code: string; rows: WorkbookRow[] }>();

  for (const row of rows) {
    if (!wbsMap.has(row.wbsId)) {
      wbsMap.set(row.wbsId, { code: row.wbsCode, rows: [] });
    }
    const phaseKey = `${row.wbsId}::${row.phaseId}`;
    if (!phaseMap.has(phaseKey)) {
      phaseMap.set(phaseKey, { wbsId: row.wbsId, code: row.phaseCode, rows: [] });
    }
    phaseMap.get(phaseKey)!.rows.push(row);
  }

  const wbsOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.wbsId)) {
      seen.add(row.wbsId);
      wbsOrder.push(row.wbsId);
    }
  }

  const tree: TableDisplayRow[] = [];

  for (const wbsId of wbsOrder) {
    const wbsInfo = wbsMap.get(wbsId)!;
    const summary = wbsSummaries[wbsId] ?? {
      totalMH: 0,
      earnedMH: 0,
      craftMH: 0,
      weldMH: 0,
      percentComplete: 0,
    };

    const phaseOrder: string[] = [];
    const phaseSeen = new Set<string>();
    for (const row of rows) {
      if (row.wbsId !== wbsId) continue;
      const pk = `${row.wbsId}::${row.phaseId}`;
      if (!phaseSeen.has(pk)) {
        phaseSeen.add(pk);
        phaseOrder.push(pk);
      }
    }

    const phaseChildren: TableDisplayRow[] = [];

    for (const phaseKey of phaseOrder) {
      const phaseInfo = phaseMap.get(phaseKey)!;
      const phaseId = phaseKey.split("::")[1]!;
      const pSummary = phaseSummaries[phaseId] ?? {
        totalMH: 0,
        earnedMH: 0,
        craftMH: 0,
        weldMH: 0,
        percentComplete: 0,
      };

      const detailChildren: TableDisplayRow[] = phaseInfo.rows.map((r) => ({
        rowType: "detail" as const,
        id: r.id,
        wbsCode: r.wbsCode,
        phaseCode: r.phaseCode,
        description: r.description,
        quantity: r.quantity,
        unit: r.unit,
        totalMH: r.totalMH,
        quantityComplete: r.quantityComplete,
        quantityRemaining: r.quantityRemaining,
        earnedMH: r.earnedMH,
        percentComplete: r.percentComplete,
      }));

      phaseChildren.push({
        rowType: "phase",
        id: phaseId,
        wbsCode: wbsInfo.code,
        phaseCode: phaseInfo.code,
        description: phaseSummaries[phaseId]?.description ?? phaseInfo.code,
        quantity: 0,
        unit: "",
        totalMH: pSummary.totalMH,
        quantityComplete: 0,
        quantityRemaining: 0,
        earnedMH: pSummary.earnedMH,
        percentComplete: pSummary.percentComplete,
        subRows: detailChildren,
      });
    }

    tree.push({
      rowType: "wbs",
      id: wbsId,
      wbsCode: wbsInfo.code,
      phaseCode: "",
      description: wbsSummaries[wbsId]?.description ?? wbsInfo.code,
      quantity: 0,
      unit: "",
      totalMH: summary.totalMH,
      quantityComplete: 0,
      quantityRemaining: 0,
      earnedMH: summary.earnedMH,
      percentComplete: summary.percentComplete,
      subRows: phaseChildren,
    });
  }

  return tree;
}

/** Semantic color for progress percentage. */
function progressColor(pct: number): string {
  if (pct >= 100) return "text-green-600 dark:text-green-400";
  if (pct >= 75) return "text-green-600 dark:text-green-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
}

/** Progress bar fill color. */
function progressBarColor(pct: number): string {
  if (pct >= 100) return "bg-green-500";
  if (pct >= 75) return "bg-green-500";
  if (pct >= 50) return "bg-amber-500";
  if (pct > 0) return "bg-orange-500";
  return "bg-muted-foreground/30";
}

/** Format a number with locale-aware grouping and 1 decimal. */
function fmtMH(val: number | undefined): string {
  if (val == null) return "0.0";
  return val.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Inline note popover for entry cells. */
function NotePopover({
  activityId,
  existingNote,
  onSave,
  showAlways,
}: {
  activityId: string;
  existingNote?: string;
  onSave?: (activityId: string, notes: string) => void;
  /** Show the icon at low opacity even without hover. */
  showAlways?: boolean;
}) {
  const [note, setNote] = React.useState(existingNote ?? "");
  const hasNote = !!existingNote;

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open && note !== (existingNote ?? "")) {
          onSave?.(activityId, note);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center justify-center h-6 w-6 rounded transition-colors shrink-0",
            hasNote
              ? "text-primary hover:bg-primary/10"
              : showAlways
                ? "text-muted-foreground/30 hover:text-muted-foreground hover:bg-foreground/10"
                : "text-muted-foreground/40 opacity-0 group-hover/row:opacity-100 hover:bg-foreground/10"
          )}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" className="w-64 p-3" align="center">
        <Textarea
          placeholder="Add a note..."
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="text-sm resize-none"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Full workbook table for progress tracking.
 *
 * WHY: The primary work surface. Shows the WBS/Phase/Detail hierarchy
 * with column modes (entry/full), summary bar, and keyboard navigation.
 */
export function WorkbookTable({
  rows,
  wbsSummaries,
  phaseSummaries,
  entryDateLabel,
  existingEntries,
  entryValues,
  onEntryChange,
  onBlurSave,
  onEntryDiscard,
  projectStats,
  columnMode = "entry",
  onColumnModeChange,
  existingNotes,
  onNoteSave,
  saveStates,
}: WorkbookTableProps) {
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [filter, setFilter] = React.useState<WorkbookFilter>("all");
  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  const escapeRef = React.useRef(false);

  /* Refs for values read inside onBlur — avoids stale closures in useMemo column defs */
  const onBlurSaveRef = React.useRef(onBlurSave);
  onBlurSaveRef.current = onBlurSave;
  const onEntryDiscardRef = React.useRef(onEntryDiscard);
  onEntryDiscardRef.current = onEntryDiscard;

  const data = React.useMemo(
    () => buildTree(rows, wbsSummaries, phaseSummaries),
    [rows, wbsSummaries, phaseSummaries]
  );

  /**
   * Smart expand state: collapsed by default ("All" view acts as dashboard),
   * fully expanded when filtering to "Remaining" or "Today" for data entry.
   * Uses real state so user clicks can toggle individual rows.
   */
  const [expanded, setExpanded] = React.useState<ExpandedState>({});

  /* Reset expand state when filter changes */
  React.useEffect(() => {
    if (filter === "needs-entry" || filter === "date-entries") {
      setExpanded(true);
    } else {
      setExpanded({});
    }
  }, [filter]);

  /* ── Entry mode columns: compact 3-column layout for rapid entry ── */
  const entryColumns = React.useMemo<ColumnDef<TableDisplayRow>[]>(() => {
    return [
      /* ── ITEM: hierarchy + codes + description + inline progress ── */
      {
        id: "item",
        header: "Item",
        size: 450,
        cell: ({ row }) => {
          const { rowType, wbsCode, phaseCode, description, percentComplete, totalMH, earnedMH } =
            row.original;
          const isGroup = rowType !== "detail";
          const indent = row.depth * 20;

          return (
            <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: indent }}>
              {isGroup ? (
                <button
                  onClick={row.getToggleExpandedHandler()}
                  className="flex items-center justify-center h-5 w-5 rounded hover:bg-foreground/10 shrink-0 transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200",
                      row.getIsExpanded() && "rotate-90"
                    )}
                  />
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}

              {rowType === "wbs" && (
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold font-mono text-primary tabular-nums shrink-0">
                    {wbsCode}
                  </span>
                  <span className="font-semibold text-sm truncate">{description}</span>
                  <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                      {fmtMH(totalMH)} MH
                    </span>
                    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          progressBarColor(percentComplete)
                        )}
                        style={{ width: `${Math.min(percentComplete, 100)}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "text-[11px] font-medium tabular-nums",
                        progressColor(percentComplete)
                      )}
                    >
                      {percentComplete}%
                    </span>
                  </div>
                </div>
              )}

              {rowType === "phase" && (
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                    {phaseCode}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground truncate">
                    {description}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-muted-foreground/60 shrink-0 ml-auto">
                    {fmtMH(earnedMH)} / {fmtMH(totalMH)}
                  </span>
                </div>
              )}

              {rowType === "detail" && (
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {percentComplete >= 100 ? (
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : percentComplete > 0 ? (
                    <CircleDot className="h-3 w-3 text-amber-500 shrink-0" />
                  ) : null}
                  <span className="text-sm truncate" title={description}>
                    {description}
                  </span>
                  {percentComplete > 0 && percentComplete < 100 && (
                    <span
                      className={cn(
                        "text-[11px] font-mono tabular-nums shrink-0 ml-auto",
                        progressColor(percentComplete)
                      )}
                    >
                      {percentComplete}%
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        },
      },

      /* ── LEFT: remaining quantity ── */
      {
        accessorKey: "quantityRemaining",
        header: () => <div className="text-right">Left</div>,
        size: 65,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div
              className={cn(
                "text-right font-mono text-sm tabular-nums",
                row.original.quantityRemaining === 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-muted-foreground"
              )}
            >
              {row.original.quantityRemaining}
            </div>
          ) : null,
      },

      /* ── Entry column ── */
      {
        id: "entryQty",
        header: () => (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-xs font-semibold text-primary">
              {entryDateLabel || "Entry"}{" "}
              <span className="font-normal text-muted-foreground/60">Qty</span>
            </span>
          </div>
        ),
        size: 130,
        cell: ({ row }) => {
          if (row.original.rowType !== "detail") return null;
          const activityId = row.original.id;
          const localValue = entryValues?.[activityId];
          const existingValue = existingEntries?.[activityId];
          const hasExisting = existingValue !== undefined && existingValue > 0;
          const isModified = localValue !== undefined;
          const maxAllowed = row.original.quantityRemaining + (existingValue ?? 0);

          // Completed item — no remaining qty and no entry for this date
          const isComplete = row.original.quantityRemaining === 0 && !hasExisting && !isModified;
          if (isComplete) {
            return (
              <div className="flex items-center justify-end gap-1.5 text-green-600 dark:text-green-400">
                <Check className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Done</span>
              </div>
            );
          }

          const displayValue =
            localValue !== undefined ? localValue : hasExisting ? String(existingValue) : "";

          // Over-max visual warning
          const typedNum = parseFloat(displayValue);
          const isOverMax = !isNaN(typedNum) && typedNum > maxAllowed && maxAllowed > 0;

          const cellSaveState = saveStates?.[activityId];

          return (
            <div className="flex items-center justify-end gap-1">
              {/* Save state indicator */}
              <span className="w-4 flex items-center justify-center shrink-0">
                {cellSaveState === "saving" && (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                )}
                {cellSaveState === "saved" && <Check className="h-3 w-3 text-green-500" />}
                {cellSaveState === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
              </span>
              <NotePopover
                activityId={activityId}
                existingNote={existingNotes?.[activityId]}
                onSave={onNoteSave}
                showAlways={hasExisting || isModified}
              />
              <Input
                type="number"
                min="0"
                max={maxAllowed}
                step="any"
                data-entry-cell={activityId}
                value={displayValue}
                onChange={(e) => onEntryChange?.(activityId, e.target.value)}
                onKeyDown={(e) => handleEntryCellKeyDown(e, activityId)}
                onBlur={() => {
                  if (escapeRef.current) {
                    escapeRef.current = false;
                    onEntryDiscardRef.current?.(activityId);
                    return;
                  }
                  onBlurSaveRef.current?.(activityId);
                }}
                className={cn(
                  "h-8 w-[88px] text-right font-mono text-sm tabular-nums",
                  "border-primary/20 bg-primary/[0.02]",
                  "focus-visible:ring-primary/40 focus-visible:border-primary/40",
                  "placeholder:text-muted-foreground/40",
                  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                  isModified && "ring-2 ring-primary/25 border-primary bg-primary/[0.06]",
                  hasExisting && !isModified && "text-foreground",
                  isOverMax && "ring-2 ring-destructive/30 border-destructive"
                )}
                placeholder={"\u2014"}
              />
            </div>
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleEntryCellKeyDown is defined later and only uses a ref
  }, [
    entryDateLabel,
    existingEntries,
    entryValues,
    onEntryChange,
    existingNotes,
    onNoteSave,
    saveStates,
  ]);

  /* ── Full mode columns: all 9 columns ── */
  const fullColumns = React.useMemo<ColumnDef<TableDisplayRow>[]>(() => {
    return [
      /* ── Tree column ── */
      {
        id: "item",
        header: "Item",
        size: 320,
        cell: ({ row }) => {
          const { rowType, wbsCode, phaseCode, description, percentComplete } = row.original;
          const isGroup = rowType !== "detail";
          const indent = row.depth * 20;

          return (
            <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: indent }}>
              {isGroup ? (
                <button
                  onClick={row.getToggleExpandedHandler()}
                  className="flex items-center justify-center h-5 w-5 rounded hover:bg-foreground/10 shrink-0 transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200",
                      row.getIsExpanded() && "rotate-90"
                    )}
                  />
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}

              {rowType === "wbs" && (
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold font-mono text-primary tabular-nums shrink-0">
                    {wbsCode}
                  </span>
                  <span className="font-semibold text-sm truncate">{description}</span>
                  <div className="hidden sm:flex items-center gap-1.5 shrink-0 ml-auto">
                    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          progressBarColor(percentComplete)
                        )}
                        style={{ width: `${Math.min(percentComplete, 100)}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "text-[11px] font-medium tabular-nums",
                        progressColor(percentComplete)
                      )}
                    >
                      {percentComplete}%
                    </span>
                  </div>
                </div>
              )}

              {rowType === "phase" && (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                    {phaseCode}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground truncate">
                    {description}
                  </span>
                </div>
              )}

              {rowType === "detail" && (
                <div className="flex items-center gap-1.5 min-w-0">
                  {percentComplete >= 100 ? (
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : percentComplete > 0 ? (
                    <CircleDot className="h-3 w-3 text-amber-500 shrink-0" />
                  ) : null}
                  <span className="text-sm truncate" title={description}>
                    {description}
                  </span>
                </div>
              )}
            </div>
          );
        },
      },

      /* ── Qty ── */
      {
        accessorKey: "quantity",
        header: () => <div className="text-right">Qty</div>,
        size: 60,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-right font-mono text-sm tabular-nums">{row.original.quantity}</div>
          ) : null,
      },

      /* ── Unit ── */
      {
        accessorKey: "unit",
        header: () => <div className="text-center">Unit</div>,
        size: 50,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-center text-xs text-muted-foreground uppercase tracking-wide">
              {row.original.unit}
            </div>
          ) : null,
      },

      /* ── Complete ── */
      {
        accessorKey: "quantityComplete",
        header: () => <div className="text-right">Done</div>,
        size: 65,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-right font-mono text-sm tabular-nums">
              {row.original.quantityComplete > 0 ? (
                row.original.quantityComplete
              ) : (
                <span className="text-muted-foreground/40">&mdash;</span>
              )}
            </div>
          ) : null,
      },

      /* ── Remaining ── */
      {
        accessorKey: "quantityRemaining",
        header: () => <div className="text-right">Left</div>,
        size: 65,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div
              className={cn(
                "text-right font-mono text-sm tabular-nums",
                row.original.quantityRemaining === 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-muted-foreground"
              )}
            >
              {row.original.quantityRemaining}
            </div>
          ) : null,
      },

      /* ── Total MH ── */
      {
        accessorKey: "totalMH",
        header: () => <div className="text-right">Total MH</div>,
        size: 80,
        cell: ({ row }) => {
          if (row.original.totalMH === 0 && row.original.rowType === "detail") return null;
          return (
            <div
              className={cn(
                "text-right font-mono text-sm tabular-nums",
                row.original.rowType !== "detail" && "font-semibold"
              )}
            >
              {row.original.totalMH > 0 ? row.original.totalMH.toFixed(1) : ""}
            </div>
          );
        },
      },

      /* ── Earned MH ── */
      {
        accessorKey: "earnedMH",
        header: () => <div className="text-right">Earned</div>,
        size: 80,
        cell: ({ row }) => {
          if (row.original.earnedMH === 0 && row.original.rowType === "detail") return null;
          return (
            <div
              className={cn(
                "text-right font-mono text-sm tabular-nums",
                row.original.rowType !== "detail" && "font-semibold"
              )}
            >
              {row.original.earnedMH > 0 ? row.original.earnedMH.toFixed(1) : ""}
            </div>
          );
        },
      },

      /* ── Progress % ── */
      {
        accessorKey: "percentComplete",
        header: () => <div className="text-right">%</div>,
        size: 55,
        cell: ({ row }) => {
          const pct = row.original.percentComplete;
          if (pct === 0 && row.original.rowType === "detail") {
            return <div className="text-right text-sm text-muted-foreground/50">0%</div>;
          }
          if (row.original.rowType !== "detail") {
            return (
              <div
                className={cn(
                  "text-right font-mono text-sm font-semibold tabular-nums sm:hidden",
                  progressColor(pct)
                )}
              >
                {pct}%
              </div>
            );
          }
          return (
            <div
              className={cn(
                "text-right font-mono text-sm font-medium tabular-nums",
                progressColor(pct)
              )}
            >
              {pct}%
            </div>
          );
        },
      },

      /* ── Entry column ── */
      {
        id: "entryQty",
        header: () => (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-xs font-semibold text-primary">
              {entryDateLabel || "Entry"}{" "}
              <span className="font-normal text-muted-foreground/60">Qty</span>
            </span>
          </div>
        ),
        size: 130,
        cell: ({ row }) => {
          if (row.original.rowType !== "detail") return null;
          const activityId = row.original.id;
          const localValue = entryValues?.[activityId];
          const existingValue = existingEntries?.[activityId];
          const hasExisting = existingValue !== undefined && existingValue > 0;
          const isModified = localValue !== undefined;
          const maxAllowed = row.original.quantityRemaining + (existingValue ?? 0);

          // Completed item — no remaining qty and no entry for this date
          const isComplete = row.original.quantityRemaining === 0 && !hasExisting && !isModified;
          if (isComplete) {
            return (
              <div className="flex items-center justify-end gap-1.5 text-green-600 dark:text-green-400">
                <Check className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Done</span>
              </div>
            );
          }

          const displayValue =
            localValue !== undefined ? localValue : hasExisting ? String(existingValue) : "";

          // Over-max visual warning
          const typedNum = parseFloat(displayValue);
          const isOverMax = !isNaN(typedNum) && typedNum > maxAllowed && maxAllowed > 0;

          const cellSaveState = saveStates?.[activityId];

          return (
            <div className="flex items-center justify-end gap-1">
              {/* Save state indicator */}
              <span className="w-4 flex items-center justify-center shrink-0">
                {cellSaveState === "saving" && (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                )}
                {cellSaveState === "saved" && <Check className="h-3 w-3 text-green-500" />}
                {cellSaveState === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
              </span>
              <NotePopover
                activityId={activityId}
                existingNote={existingNotes?.[activityId]}
                onSave={onNoteSave}
                showAlways={hasExisting || isModified}
              />
              <Input
                type="number"
                min="0"
                max={maxAllowed}
                step="any"
                data-entry-cell={activityId}
                value={displayValue}
                onChange={(e) => onEntryChange?.(activityId, e.target.value)}
                onKeyDown={(e) => handleEntryCellKeyDown(e, activityId)}
                onBlur={() => {
                  if (escapeRef.current) {
                    escapeRef.current = false;
                    onEntryDiscardRef.current?.(activityId);
                    return;
                  }
                  onBlurSaveRef.current?.(activityId);
                }}
                className={cn(
                  "h-8 w-[88px] text-right font-mono text-sm tabular-nums",
                  "border-primary/20 bg-primary/[0.02]",
                  "focus-visible:ring-primary/40 focus-visible:border-primary/40",
                  "placeholder:text-muted-foreground/40",
                  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                  isModified && "ring-2 ring-primary/25 border-primary bg-primary/[0.06]",
                  hasExisting && !isModified && "text-foreground",
                  isOverMax && "ring-2 ring-destructive/30 border-destructive"
                )}
                placeholder={"\u2014"}
              />
            </div>
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleEntryCellKeyDown is defined later and only uses a ref
  }, [
    entryDateLabel,
    existingEntries,
    entryValues,
    onEntryChange,
    existingNotes,
    onNoteSave,
    saveStates,
  ]);

  const columns = columnMode === "entry" ? entryColumns : fullColumns;

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSubRows: (row) => row.subRows,
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const search = filterValue.toLowerCase();
      const original = row.original;

      const matchesSearch =
        !search ||
        original.description.toLowerCase().includes(search) ||
        original.wbsCode.toLowerCase().includes(search) ||
        original.phaseCode.toLowerCase().includes(search);

      if (!matchesSearch) return false;

      if (filter === "needs-entry") {
        if (original.rowType === "detail") return original.quantityRemaining > 0;
        return true;
      }
      if (filter === "date-entries") {
        if (original.rowType === "detail") {
          const hasEntry =
            entryValues?.[original.id] !== undefined && entryValues[original.id] !== "";
          const hasExisting = existingEntries?.[original.id] !== undefined;
          return hasEntry || hasExisting;
        }
        return true;
      }

      return true;
    },
    state: {
      globalFilter,
      expanded,
    },
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
  });

  /**
   * Keyboard navigation for entry cells.
   *
   * WHY: Rapid data entry requires keyboard-first navigation.
   * Tab/Enter move forward, Shift+Tab moves back, Escape clears.
   */
  const handleEntryCellKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, activityId: string) => {
      const container = tableContainerRef.current;
      if (!container) return;

      const allCells = Array.from(
        container.querySelectorAll<HTMLInputElement>("input[data-entry-cell]")
      );
      const currentIndex = allCells.findIndex(
        (el) => el.getAttribute("data-entry-cell") === activityId
      );
      if (currentIndex === -1) return;

      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const direction = e.shiftKey ? -1 : 1;
        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < allCells.length) {
          allCells[nextIndex]!.focus();
          allCells[nextIndex]!.select();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        escapeRef.current = true;
        (e.target as HTMLInputElement).blur();
      }
    },
    []
  );

  /* Cmd+S blurs the active cell, triggering auto-save via onBlur */
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (document.activeElement instanceof HTMLInputElement) {
          document.activeElement.blur();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /** Dynamic filter options with live counts. */
  const filterOptions = React.useMemo(() => {
    const needsEntryCount = rows.filter((r) => r.quantityRemaining > 0).length;
    const dateEntryCount = rows.filter(
      (r) =>
        (entryValues?.[r.id] !== undefined && entryValues[r.id] !== "") ||
        existingEntries?.[r.id] !== undefined
    ).length;
    return [
      { value: "all" as const, label: "Overview", count: rows.length },
      { value: "needs-entry" as const, label: "Needs Entry", count: needsEntryCount },
      {
        value: "date-entries" as const,
        label: entryDateLabel || "Date",
        count: dateEntryCount,
      },
    ];
  }, [rows, entryValues, existingEntries, entryDateLabel]);

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* ── Summary bar ── */}
      {projectStats && (
        <div className="flex items-center gap-4 px-3 py-1.5 rounded-lg border bg-muted/30 mb-3 text-sm">
          <span className="text-muted-foreground">
            Total:{" "}
            <span className="font-semibold font-mono tabular-nums text-foreground">
              {fmtMH(projectStats.totalMH)} MH
            </span>
          </span>
          <span className="text-border">&middot;</span>
          <span className="text-muted-foreground">
            Earned:{" "}
            <span className="font-semibold font-mono tabular-nums text-foreground">
              {fmtMH(projectStats.earnedMH)} MH
            </span>
          </span>
          <span className="text-border">&middot;</span>
          <span className="text-muted-foreground">
            Progress:{" "}
            <span
              className={cn(
                "font-semibold font-mono tabular-nums",
                progressColor(projectStats.percentComplete ?? 0)
              )}
            >
              {projectStats.percentComplete ?? 0}%
            </span>
          </span>
          <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                progressBarColor(projectStats.percentComplete ?? 0)
              )}
              style={{ width: `${Math.min(projectStats.percentComplete ?? 0, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 pb-3">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search items..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>

        {/* Filter pills with counts */}
        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setFilter(option.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
                filter === option.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
              <span className="ml-1 text-[10px] tabular-nums opacity-60">{option.count}</span>
            </button>
          ))}
        </div>

        {/* Column mode toggle */}
        {onColumnModeChange && (
          <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
            {[
              { value: "entry" as const, label: "Entry" },
              { value: "full" as const, label: "Full" },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => onColumnModeChange(option.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150",
                  columnMode === option.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option.value === "entry" ? "Entry" : "Full"}
              </button>
            ))}
          </div>
        )}

        <span className="text-[10px] text-muted-foreground/40 hidden lg:inline ml-auto">
          Tab/Enter to navigate &middot; Esc to cancel
        </span>
      </div>

      {/* ── Table ── */}
      <div
        ref={tableContainerRef}
        className="rounded-lg border overflow-auto flex-1 min-w-0 max-h-[calc(100vh-280px)]"
      >
        <Table className="w-full table-fixed">
          <TableHeader className="sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted/50 hover:bg-muted/50">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className={cn(
                      "text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 whitespace-nowrap h-8",
                      header.id === "entryQty" && "border-l border-primary/15 bg-primary/[0.03]"
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => {
                const { rowType, percentComplete } = row.original;
                const isComplete = percentComplete >= 100 && rowType === "detail";

                return (
                  <TableRow
                    key={row.id}
                    className={cn(
                      "transition-colors duration-100",
                      rowType === "wbs" &&
                        "bg-primary/[0.03] border-l-[3px] border-l-primary hover:bg-primary/[0.06]",
                      rowType === "phase" && "bg-muted/30 hover:bg-muted/50",
                      rowType === "detail" && "hover:bg-accent/50 group/row",
                      isComplete && "opacity-60"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "py-1.5 px-2.5",
                          cell.column.id === "entryQty" &&
                            "border-l border-primary/10 bg-primary/[0.015]"
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32">
                  <div className="flex flex-col items-center justify-center gap-1.5 text-center">
                    {filter === "needs-entry" ? (
                      <>
                        <Check className="h-5 w-5 text-green-500" />
                        <p className="text-sm font-medium text-muted-foreground">
                          All items complete
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                          No remaining quantities to enter
                        </p>
                      </>
                    ) : (
                      <>
                        <Search className="h-5 w-5 text-muted-foreground/40" />
                        <p className="text-sm font-medium text-muted-foreground">
                          {globalFilter ? "No matching items" : "No work items"}
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                          {globalFilter
                            ? "Try a different search term"
                            : filter === "date-entries"
                              ? "No entries for this date yet"
                              : "Import estimate data to get started"}
                        </p>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
