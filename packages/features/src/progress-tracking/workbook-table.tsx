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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { ChevronRight, ChevronDown, Search, Save, X, AlertTriangle } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import type { WorkbookRow, GroupSummary } from "./types";

/** A display row — either a group header or a detail row. */
interface TableDisplayRow {
  rowType: "wbs" | "phase" | "detail";
  id: string;
  wbsCode: string;
  phaseCode: string;
  description: string;
  size: string;
  spec: string;
  flc: string;
  insulation: string;
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
  /** Nested children for expand/collapse (wbs -> phases -> details). */
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

/** Build a nested tree structure for TanStack Table's expand/collapse. */
function buildTree(
  rows: WorkbookRow[],
  wbsSummaries: Record<string, GroupSummary>,
  phaseSummaries: Record<string, GroupSummary>
): TableDisplayRow[] {
  const wbsMap = new Map<string, { code: string; description: string; rows: WorkbookRow[] }>();
  const phaseMap = new Map<
    string,
    {
      wbsId: string;
      code: string;
      description: string;
      size: string;
      spec: string;
      flc: string;
      insulation: string;
      sheet: number | null;
      rows: WorkbookRow[];
    }
  >();

  for (const row of rows) {
    if (!wbsMap.has(row.wbsId)) {
      wbsMap.set(row.wbsId, { code: row.wbsCode, description: "", rows: [] });
    }

    const phaseKey = `${row.wbsId}::${row.phaseId}`;
    if (!phaseMap.has(phaseKey)) {
      phaseMap.set(phaseKey, {
        wbsId: row.wbsId,
        code: row.phaseCode,
        description: "",
        size: row.size,
        spec: row.spec,
        flc: row.flc,
        insulation: row.insulation,
        sheet: row.sheet,
        rows: [],
      });
    }
    phaseMap.get(phaseKey)!.rows.push(row);
  }

  const tree: TableDisplayRow[] = [];

  // Get unique WBS IDs in order
  const wbsOrder: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.wbsId)) {
      seen.add(row.wbsId);
      wbsOrder.push(row.wbsId);
    }
  }

  for (const wbsId of wbsOrder) {
    const wbsInfo = wbsMap.get(wbsId)!;
    const summary = wbsSummaries[wbsId] ?? {
      totalMH: 0,
      earnedMH: 0,
      craftMH: 0,
      weldMH: 0,
      percentComplete: 0,
    };

    const phaseChildren: TableDisplayRow[] = [];
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
        size: r.size,
        spec: r.spec,
        flc: r.flc,
        insulation: r.insulation,
        sheet: r.sheet,
        quantity: r.quantity,
        unit: r.unit,
        craftMH: r.craftMH,
        weldMH: r.weldMH,
        totalMH: r.totalMH,
        quantityComplete: r.quantityComplete,
        quantityRemaining: r.quantityRemaining,
        earnedMH: r.earnedMH,
        remainingMH: r.remainingMH,
        percentComplete: r.percentComplete,
      }));

      phaseChildren.push({
        rowType: "phase",
        id: phaseId,
        wbsCode: wbsInfo.code,
        phaseCode: phaseInfo.code,
        description: `Phase ${phaseInfo.code}`,
        size: phaseInfo.size,
        spec: phaseInfo.spec,
        flc: phaseInfo.flc,
        insulation: phaseInfo.insulation,
        sheet: phaseInfo.sheet,
        quantity: 0,
        unit: "",
        craftMH: pSummary.craftMH,
        weldMH: pSummary.weldMH,
        totalMH: pSummary.totalMH,
        quantityComplete: 0,
        quantityRemaining: 0,
        earnedMH: pSummary.earnedMH,
        remainingMH: Math.max(0, pSummary.totalMH - pSummary.earnedMH),
        percentComplete: pSummary.percentComplete,
        subRows: detailChildren,
      });
    }

    tree.push({
      rowType: "wbs",
      id: wbsId,
      wbsCode: wbsInfo.code,
      phaseCode: "",
      description: `WBS ${wbsInfo.code}`,
      size: "",
      spec: "",
      flc: "",
      insulation: "",
      sheet: null,
      quantity: 0,
      unit: "",
      craftMH: summary.craftMH,
      weldMH: summary.weldMH,
      totalMH: summary.totalMH,
      quantityComplete: 0,
      quantityRemaining: 0,
      earnedMH: summary.earnedMH,
      remainingMH: Math.max(0, summary.totalMH - summary.earnedMH),
      percentComplete: summary.percentComplete,
      subRows: phaseChildren,
    });
  }

  return tree;
}

/** Color class for progress percentage. */
function percentColor(pct: number): string {
  if (pct >= 100) return "text-green-600 dark:text-green-400";
  if (pct >= 75) return "text-green-600 dark:text-green-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
}

/**
 * Full workbook-style table for progress tracking.
 *
 * Shows the full WBS/Phase/Detail hierarchy with expand/collapse,
 * an always-visible entry column for the selected date, and a
 * sticky save bar when changes exist.
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
      {
        accessorKey: "wbsCode",
        header: "WBS",
        size: 70,
        cell: ({ row }) => {
          const isGroup = row.original.rowType !== "detail";
          return (
            <div className="flex items-center gap-1">
              {isGroup ? (
                <button
                  onClick={row.getToggleExpandedHandler()}
                  className="p-0.5 rounded hover:bg-muted"
                >
                  {row.getIsExpanded() ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
              ) : (
                <span className="w-5" />
              )}
              <span className={cn("font-mono text-xs", isGroup && "font-bold")}>
                {row.original.wbsCode}
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: "phaseCode",
        header: "Phase",
        size: 70,
        cell: ({ row }) => (
          <span
            className={cn("font-mono text-xs", row.original.rowType === "phase" && "font-semibold")}
          >
            {row.original.phaseCode}
          </span>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        size: 220,
        cell: ({ row }) => {
          const depth = row.depth;
          return (
            <div
              className={cn(
                "truncate",
                row.original.rowType === "wbs" && "font-bold",
                row.original.rowType === "phase" && "font-semibold",
                depth > 0 && `pl-${depth * 2}`
              )}
              title={row.original.description}
            >
              {row.original.description}
            </div>
          );
        },
      },
      {
        accessorKey: "quantity",
        header: () => <div className="text-right">Qty</div>,
        size: 60,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-right font-mono text-sm">{row.original.quantity}</div>
          ) : null,
      },
      {
        accessorKey: "unit",
        header: "Unit",
        size: 50,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-center text-xs text-muted-foreground">{row.original.unit}</div>
          ) : null,
      },
      {
        accessorKey: "quantityComplete",
        header: () => <div className="text-right">Complete</div>,
        size: 70,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-right font-mono text-sm">{row.original.quantityComplete}</div>
          ) : null,
      },
      {
        accessorKey: "quantityRemaining",
        header: () => <div className="text-right">Remain</div>,
        size: 70,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-right font-mono text-sm text-muted-foreground">
              {row.original.quantityRemaining}
            </div>
          ) : null,
      },
      {
        accessorKey: "totalMH",
        header: () => <div className="text-right">Total MH</div>,
        size: 80,
        cell: ({ row }) => (
          <div
            className={cn(
              "text-right font-mono text-sm",
              row.original.rowType !== "detail" && "font-semibold"
            )}
          >
            {row.original.totalMH > 0 ? row.original.totalMH.toFixed(1) : ""}
          </div>
        ),
      },
      {
        accessorKey: "earnedMH",
        header: () => <div className="text-right">Earned MH</div>,
        size: 80,
        cell: ({ row }) => (
          <div
            className={cn(
              "text-right font-mono text-sm",
              row.original.rowType !== "detail" && "font-semibold"
            )}
          >
            {row.original.earnedMH > 0 ? row.original.earnedMH.toFixed(1) : ""}
          </div>
        ),
      },
      {
        accessorKey: "percentComplete",
        header: () => <div className="text-right">%</div>,
        size: 55,
        cell: ({ row }) => {
          const pctVal = row.original.percentComplete;
          return (
            <div className={cn("text-right font-mono text-sm font-semibold", percentColor(pctVal))}>
              {pctVal > 0 ? `${pctVal}%` : row.original.rowType === "detail" ? "0%" : ""}
            </div>
          );
        },
      },
      // Entry column — always present
      {
        id: "entryQty",
        header: () => (
          <div className="text-right text-xs font-semibold text-primary">
            {entryDateLabel || "Entry"}
          </div>
        ),
        size: 90,
        cell: ({ row }) => {
          if (row.original.rowType !== "detail") return null;
          const activityId = row.original.id;
          const currentValue = entryValues?.[activityId] ?? "";
          const existingValue = existingEntries?.[activityId];
          const hasExisting = existingValue !== undefined && existingValue > 0;
          const isChanged = currentValue !== "" && currentValue !== String(existingValue ?? "");

          return (
            <div className="text-right">
              <Input
                type="number"
                min="0"
                step="any"
                value={currentValue}
                onChange={(e) => onEntryChange?.(activityId, e.target.value)}
                className={cn(
                  "h-7 w-20 text-right font-mono text-sm ml-auto",
                  isChanged && "border-primary bg-primary/5",
                  hasExisting && !isChanged && "text-muted-foreground"
                )}
                placeholder={hasExisting ? String(existingValue) : "0"}
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

      // Text search
      const matchesSearch =
        !search ||
        original.description.toLowerCase().includes(search) ||
        original.wbsCode.toLowerCase().includes(search) ||
        original.phaseCode.toLowerCase().includes(search) ||
        original.spec.toLowerCase().includes(search);

      if (!matchesSearch) return false;

      // Category filter
      if (filter === "remaining") {
        if (original.rowType === "detail") return original.quantityRemaining > 0;
        return true; // show group rows if they have remaining children
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

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 pb-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by WBS, phase, description..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as WorkbookFilter)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All items</SelectItem>
            <SelectItem value="remaining">Remaining work</SelectItem>
            <SelectItem value="entered-today">Entered today</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground ml-auto">{rows.length} work items</p>
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-auto flex-1 max-h-[calc(100vh-320px)]">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="text-xs whitespace-nowrap"
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
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(
                    row.original.rowType === "wbs" && "bg-muted/60 font-bold",
                    row.original.rowType === "phase" && "bg-muted/30",
                    row.original.percentComplete >= 100 &&
                      row.original.rowType === "detail" &&
                      "opacity-50"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-1.5 px-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {globalFilter ? "No matching rows found." : "No work items found."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Sticky save bar */}
      {dirtyCount > 0 && (
        <div className="sticky bottom-0 mt-3 rounded-lg border bg-card px-4 py-3 flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="font-medium">
              {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onDiscard} className="gap-1.5">
              <X className="h-3.5 w-3.5" />
              Discard
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving} className="gap-1.5">
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving..." : "Save Progress"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
