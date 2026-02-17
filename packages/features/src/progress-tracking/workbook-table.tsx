"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
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
import { Button } from "@truss/ui/components/button";
import { ChevronRight, Search, Save, X, CircleDot, Check } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import type { WorkbookRow, GroupSummary } from "./types";

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

/** Filter options for the workbook. */
type WorkbookFilter = "all" | "remaining" | "entered-today";

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
  /** Callback when an inline entry value changes. */
  onEntryChange?: (activityId: string, value: string) => void;
  /** Number of unsaved changes. */
  dirtyCount?: number;
  /** Save handler. */
  onSave?: () => void;
  /** Discard handler. */
  onDiscard?: () => void;
  /** Whether save is in progress. */
  saving?: boolean;
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

/**
 * Full workbook table for progress tracking.
 *
 * WHY: The primary work surface. Shows the WBS/Phase/Detail hierarchy
 * with always-visible entry column and inline progress visualization.
 */
export function WorkbookTable({
  rows,
  wbsSummaries,
  phaseSummaries,
  entryDateLabel,
  existingEntries,
  entryValues,
  onEntryChange,
  dirtyCount = 0,
  onSave,
  onDiscard,
  saving,
}: WorkbookTableProps) {
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [filter, setFilter] = React.useState<WorkbookFilter>("all");

  const data = React.useMemo(
    () => buildTree(rows, wbsSummaries, phaseSummaries),
    [rows, wbsSummaries, phaseSummaries]
  );

  const columns = React.useMemo<ColumnDef<TableDisplayRow>[]>(() => {
    const cols: ColumnDef<TableDisplayRow>[] = [
      /* ── Tree column: hierarchy with expand/collapse ── */
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

      /* ── Progress % (detail rows and fallback for groups on small screens) ── */
      {
        accessorKey: "percentComplete",
        header: () => <div className="text-right">%</div>,
        size: 55,
        cell: ({ row }) => {
          const pct = row.original.percentComplete;
          if (pct === 0 && row.original.rowType === "detail") {
            return <div className="text-right text-sm text-muted-foreground/50">0%</div>;
          }
          /* WBS/Phase % is in the tree column on larger screens; show here as fallback */
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
            <span className="text-xs font-semibold text-primary">{entryDateLabel || "Entry"}</span>
          </div>
        ),
        size: 100,
        cell: ({ row }) => {
          if (row.original.rowType !== "detail") return null;
          const activityId = row.original.id;
          const currentValue = entryValues?.[activityId] ?? "";
          const existingValue = existingEntries?.[activityId];
          const hasExisting = existingValue !== undefined && existingValue > 0;
          const isChanged = currentValue !== "" && currentValue !== String(existingValue ?? "");

          return (
            <div className="flex justify-end">
              <Input
                type="number"
                min="0"
                step="any"
                value={currentValue}
                onChange={(e) => onEntryChange?.(activityId, e.target.value)}
                className={cn(
                  "h-8 w-[88px] text-right font-mono text-sm tabular-nums",
                  "border-primary/20 bg-primary/[0.02]",
                  "focus-visible:ring-primary/40 focus-visible:border-primary/40",
                  "placeholder:text-muted-foreground/40",
                  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                  isChanged && "ring-2 ring-primary/25 border-primary bg-primary/[0.06]",
                  hasExisting && !isChanged && "text-foreground"
                )}
                placeholder={hasExisting ? String(existingValue) : "\u2014"}
              />
            </div>
          );
        },
      },
    ];

    return cols;
  }, [entryDateLabel, existingEntries, entryValues, onEntryChange]);

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

      if (filter === "remaining") {
        if (original.rowType === "detail") return original.quantityRemaining > 0;
        return true;
      }
      if (filter === "entered-today") {
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
      expanded: true,
    },
    onGlobalFilterChange: setGlobalFilter,
  });

  /* Save with ⌘S keyboard shortcut */
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirtyCount > 0 && onSave && !saving) {
          onSave();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dirtyCount, onSave, saving]);

  return (
    <div className="flex flex-col h-full min-w-0">
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

        {/* Filter pills */}
        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
          {[
            { value: "all" as const, label: "All" },
            { value: "remaining" as const, label: "Remaining" },
            { value: "entered-today" as const, label: "Today" },
          ].map((option) => (
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
            </button>
          ))}
        </div>

        <div className="ml-auto" />
      </div>

      {/* ── Table ── */}
      <div className="rounded-lg border overflow-auto flex-1 min-w-0 max-h-[calc(100vh-280px)]">
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
                      /* WBS rows: bold with brand accent */
                      rowType === "wbs" &&
                        "bg-primary/[0.03] border-l-[3px] border-l-primary hover:bg-primary/[0.06]",
                      /* Phase rows: subtle group header */
                      rowType === "phase" && "bg-muted/30 hover:bg-muted/50",
                      /* Detail rows: clean with hover */
                      rowType === "detail" && "hover:bg-accent/50",
                      /* Completed items: subtle dimming */
                      isComplete && "opacity-60"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "py-1.5 px-2.5",
                          /* Visual separator for entry column */
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
                    <Search className="h-5 w-5 text-muted-foreground/40" />
                    <p className="text-sm font-medium text-muted-foreground">
                      {globalFilter ? "No matching items" : "No work items"}
                    </p>
                    <p className="text-xs text-muted-foreground/60">
                      {globalFilter
                        ? "Try a different search term"
                        : "Import estimate data to get started"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Sticky save bar ── */}
      {dirtyCount > 0 && (
        <div className="sticky bottom-0 z-20 mt-3 rounded-lg border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg px-4 py-2.5 flex items-center justify-between animate-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-600 dark:text-amber-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
              <span className="text-xs font-semibold tabular-nums">{dirtyCount} unsaved</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onDiscard}
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="mr-1 h-3 w-3" />
              Discard
            </Button>
            <Button
              size="sm"
              onClick={onSave}
              disabled={saving}
              className="h-7 px-3 text-xs gap-1.5"
            >
              <Save className="h-3 w-3" />
              {saving ? "Saving..." : "Save"}
              <kbd className="ml-1 hidden rounded bg-primary-foreground/20 px-1 py-0.5 text-[10px] font-mono leading-none sm:inline-block">
                ⌘S
              </kbd>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
