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
import { TableCell, TableHead, TableRow } from "@truss/ui/components/table";
import { Input } from "@truss/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@truss/ui/components/tooltip";
import {
  ChevronRight,
  Search,
  CircleDot,
  Check,
  ArrowRightLeft,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Split,
} from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { EntryCellInput } from "./entry-cell-input";
import { ProjectStatusSlices } from "./status-slices";
import type { PhaseOption } from "./phase-reassign-dialog";
import type { WorkbookRow, GroupSummary, ColumnMode, WorkbookFilter } from "./types";

/** Monday.com-inspired group color palette for visual differentiation of WBS groups. */
const GROUP_COLORS = [
  "#579BFC",
  "#00C875",
  "#FDAB3D",
  "#A25DDC",
  "#E2445C",
  "#00D1D1",
  "#FF642E",
  "#037F4C",
  "#CAB641",
  "#9AADBD",
] as const;

/** Deterministic group color from a WBS code string. */
function groupColor(code: string): string {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 31 + code.charCodeAt(i)) | 0;
  }
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length]!;
}

/** A display row — either a group header or a detail row. */
interface TableDisplayRow {
  rowType: "wbs" | "phase" | "detail";
  id: string;
  wbsId: string;
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
  isOverridden?: boolean;
  originalPhaseCode?: string;
  /** Mirrors the Momentum row source for change-order styling + field badges. */
  source?: "estimate" | "change_order" | "field_added";
  /** Change Order status for the phase badge (#30) — set only on CO phase rows. */
  changeOrderStatus?: string;
  /** Attribution for rows added in Momentum (powers the admin provenance marker). */
  addedByUserId?: string;
  addedAt?: number;
  /** Split metadata (see `WorkbookRow.isSplit`). */
  isSplit?: boolean;
  sourcePhaseCode?: string;
  sourceDescription?: string;
  subRows?: TableDisplayRow[];
}

/** Distinct amber accent reserved for Change Orders WBS / phases. */
const CHANGE_ORDER_ACCENT = "#d97706";

/**
 * Admin-only provenance marker for phases/activities added after the MCP
 * import. A subtle amber dot with a hover tooltip naming who added it and
 * when — invisible to field users (gated by `showSourceMarkers` upstream),
 * and the visual counterpart to the estimate-basis-vs-added rollup.
 */
function SourceMarker({
  source,
  addedByUserId,
  addedAt,
  contributors,
}: {
  source?: "estimate" | "change_order" | "field_added";
  addedByUserId?: string;
  addedAt?: number;
  contributors?: Record<string, string>;
}) {
  if (!source || source === "estimate") return null;

  const kind = source === "change_order" ? "Change order" : "Field-added";
  const who = addedByUserId ? contributors?.[addedByUserId] : undefined;
  const when =
    addedAt !== undefined
      ? new Date(addedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : undefined;
  const attribution =
    who && when
      ? `Added by ${who} · ${when}`
      : who
        ? `Added by ${who}`
        : when
          ? `Added ${when}`
          : "Added in Momentum";

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: CHANGE_ORDER_ACCENT }}
            aria-label="Added after the original estimate"
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-subheadline">
          <div className="font-medium">Not in the original estimate</div>
          <div className="text-muted-foreground">
            {kind} · {attribution}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Display metadata for each Change Order status (#30). */
const CO_STATUS_META: Record<string, { label: string; className: string }> = {
  approved: { label: "Approved", className: "bg-mac-green/15 text-success-text" },
  submitted: { label: "Submitted", className: "bg-fill-secondary text-muted-foreground" },
  pricing: { label: "Pricing", className: "bg-fill-secondary text-muted-foreground" },
  disputed: { label: "Disputed", className: "bg-mac-orange/15 text-mac-orange" },
  rejected: { label: "Rejected", className: "bg-destructive/10 text-destructive" },
  void: { label: "Void", className: "bg-fill-secondary text-foreground-subtle" },
};

/**
 * Status pill on a Change Order phase row (#30). A non-approved CO reads as a
 * placeholder whose hours don't yet count — the badge makes that explicit.
 */
function ChangeOrderBadge({ status }: { status?: string }) {
  if (!status) return null;
  const meta = CO_STATUS_META[status] ?? {
    label: status,
    className: "bg-fill-secondary text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        meta.className
      )}
    >
      {meta.label}
    </span>
  );
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
  /**
   * Called on blur to commit a cell value.
   * Receives the raw string typed by the user.
   */
  onEntryCommit?: (activityId: string, value: string) => void;
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
  /** Available phases grouped by WBS ID, for the phase reassign picker. */
  phasesByWbs?: Record<string, PhaseOption[]>;
  /**
   * Called when user right-clicks a detail row.
   * The app layer handles showing the native context menu.
   */
  onRowContextMenu?: (row: WorkbookRow, event: React.MouseEvent) => void;
  /**
   * Called when user right-clicks a phase row. Powers "Add Activity…"
   * on phase headers in the workbook tree.
   */
  onPhaseContextMenu?: (phaseId: string, wbsId: string, event: React.MouseEvent) => void;
  /**
   * Called when user right-clicks a WBS row. Powers "Add Phase…" on
   * the Change Orders WBS header. The app inspects `wbsSummaries[wbsId].source`
   * to decide what menu items to surface.
   */
  onWbsContextMenu?: (wbsId: string, event: React.MouseEvent) => void;
  /**
   * Show the provenance marker on phases/activities added after the MCP
   * import. Admin-only — the app passes its `isAdmin` here.
   */
  showSourceMarkers?: boolean;
  /** Map of userId → display name, for the provenance tooltip's attribution. */
  contributors?: Record<string, string>;
}

/** Build nested tree for TanStack Table expand/collapse. */
function buildTree(
  rows: WorkbookRow[],
  wbsSummaries: Record<string, GroupSummary>,
  phaseSummaries: Record<string, GroupSummary>,
  phasesByWbs?: Record<string, PhaseOption[]>,
  hideUnused: boolean = false
): TableDisplayRow[] {
  const wbsMap = new Map<string, { code: string; rows: WorkbookRow[] }>();
  const phaseMap = new Map<string, { wbsId: string; code: string; rows: WorkbookRow[] }>();

  // A phase's own provenance (estimate / change_order / field_added) comes
  // from `phasesByWbs`, not its WBS — a field-added phase under an estimate
  // WBS must read as added, not estimate.
  const phaseSourceById = new Map<string, "estimate" | "change_order" | "field_added">();
  if (phasesByWbs) {
    for (const list of Object.values(phasesByWbs)) {
      for (const p of list) {
        if (p.source) phaseSourceById.set(p.id, p.source);
      }
    }
  }

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

  // WBS display order. CRITICAL: we sort by each WBS's numeric code here on the
  // client and do NOT trust the key order of `wbsSummaries`. Convex does not
  // preserve object-key insertion order across the wire — it returns record
  // keys sorted lexicographically by document id — so the server's
  // `compareWbsForDisplay` sort is lost by the time the object reaches us,
  // which scrambled the WBS list (#36). Sorting by code below is order-stable
  // regardless of serialization.
  //
  // Rule: Change Orders WBS is ALWAYS visible and ALWAYS last. The separate
  // `estimateOrder` / `changeOrderOrder` arrays keep it at the bottom even if a
  // change-order WBS somehow carries a low code.
  const estimateOrder: string[] = [];
  const changeOrderOrder: string[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(wbsSummaries)) {
    const summary = wbsSummaries[id];
    if (!summary) continue;
    const isChangeOrder = summary.source === "change_order";
    const hasContent = (summary.totalMH ?? 0) > 0;
    if (hideUnused && !hasContent && !isChangeOrder) continue;
    if (!wbsMap.has(id)) {
      wbsMap.set(id, { code: summary.code ?? "", rows: [] });
    }
    seen.add(id);
    if (isChangeOrder) {
      changeOrderOrder.push(id);
    } else {
      estimateOrder.push(id);
    }
  }
  // Safety net: any WBS in rows that wasn't in summaries (shouldn't happen
  // with a healthy backend) still gets rendered so we don't drop
  // user-visible data on the floor. Slots in before change-order rows.
  for (const row of rows) {
    if (!seen.has(row.wbsId)) {
      seen.add(row.wbsId);
      estimateOrder.push(row.wbsId);
    }
  }
  // Sort by numeric WBS code (10000, 30000, … 200000), Change Orders last.
  // `wbsMap` carries each WBS's display code (from the summary or its rows).
  const wbsNumericCode = (id: string): number => {
    const raw = wbsSummaries[id]?.code ?? wbsMap.get(id)?.code ?? "";
    const n = Number(raw);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  estimateOrder.sort((a, b) => wbsNumericCode(a) - wbsNumericCode(b));
  changeOrderOrder.sort((a, b) => wbsNumericCode(a) - wbsNumericCode(b));
  const wbsOrder = [...estimateOrder, ...changeOrderOrder];

  const tree: TableDisplayRow[] = [];

  for (const wbsId of wbsOrder) {
    const wbsInfo = wbsMap.get(wbsId)!;
    const summary: GroupSummary = wbsSummaries[wbsId] ?? {
      description: wbsInfo.code,
      totalMH: 0,
      earnedMH: 0,
      craftMH: 0,
      weldMH: 0,
      percentComplete: 0,
    };

    // Phase order: driven by `phasesByWbs` (server-sorted by sortOrder).
    // Mirrors the WBS-order logic above so that phases with newly-added
    // activities don't jump out of position.
    const phaseOrder: string[] = [];
    const phaseSeen = new Set<string>();
    const knownPhases = phasesByWbs?.[wbsId] ?? [];
    for (const p of knownPhases) {
      const pk = `${wbsId}::${p.id}`;
      if (!phaseSeen.has(pk)) {
        phaseSeen.add(pk);
        phaseOrder.push(pk);
        if (!phaseMap.has(pk)) {
          phaseMap.set(pk, { wbsId, code: p.code, rows: [] });
        }
      }
    }
    // Safety net: phases observed in rows but missing from phasesByWbs.
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

      const phaseSource = phaseSourceById.get(phaseId) ?? wbsSummaries[wbsId]?.source;

      // #34 — "Unused" hides only the un-bid ESTIMATE tail. User-added phases
      // (change_order / field_added) and their rows stay visible even at 0 MH so
      // the Change Orders area and field additions remain manageable.
      if (hideUnused && (phaseSource ?? "estimate") === "estimate" && (pSummary.totalMH ?? 0) <= 0)
        continue;
      const phaseRows = hideUnused
        ? phaseInfo.rows.filter((r) => (r.totalMH ?? 0) > 0 || r.source !== "estimate")
        : phaseInfo.rows;

      const detailChildren: TableDisplayRow[] = phaseRows.map((r) => ({
        rowType: "detail" as const,
        id: r.id,
        wbsId: r.wbsId,
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
        isOverridden: r.isOverridden,
        originalPhaseCode: r.originalPhaseCode,
        source: r.source,
        addedByUserId: r.addedByUserId,
        addedAt: r.addedAt,
        isSplit: r.isSplit,
        sourcePhaseCode: r.sourcePhaseCode,
        sourceDescription: r.sourceDescription,
      }));

      phaseChildren.push({
        rowType: "phase",
        id: phaseId,
        wbsId: wbsId,
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
        source: phaseSourceById.get(phaseId) ?? wbsSummaries[wbsId]?.source,
        changeOrderStatus: phaseSummaries[phaseId]?.changeOrderStatus,
        subRows: detailChildren,
      });
    }

    tree.push({
      rowType: "wbs",
      id: wbsId,
      wbsId: wbsId,
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
      source: summary.source,
      subRows: phaseChildren,
    });
  }

  return tree;
}

/** Progress text color — green for complete, neutral for in-progress, amber for overrun. */
function progressColor(pct: number): string {
  if (pct > 100) return "text-mac-orange";
  if (pct >= 100) return "text-success-text";
  if (pct > 0) return "text-foreground";
  return "text-muted-foreground";
}

/** Progress bar fill color — green for complete, brand primary for normal, amber for overrun. */
function progressBarColor(pct: number): string {
  if (pct > 100) return "bg-mac-orange";
  if (pct >= 100) return "bg-mac-green";
  if (pct > 0) return "bg-primary";
  return "bg-muted-foreground/20";
}

/** Format man-hours with locale-aware grouping and 2 decimal places. */
function fmtMH(val: number | undefined): string {
  if (val == null) return "0.00";
  return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a quantity value with 2 decimal places. */
function fmtQty(val: number): string {
  return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a percentage value with 2 decimal places. */
function fmtPct(val: number): string {
  return `${val.toFixed(2)}%`;
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
  onEntryCommit,
  onEntryDiscard,
  columnMode = "entry",
  onColumnModeChange,
  existingNotes,
  onNoteSave,
  saveStates,
  phasesByWbs,
  onRowContextMenu,
  onPhaseContextMenu,
  onWbsContextMenu,
  showSourceMarkers,
  contributors,
}: WorkbookTableProps) {
  /** Combined global filter state — search text + active filter tab in one object
   * so TanStack's memoized getFilteredRowModel re-evaluates when either changes. */
  const [globalFilter, setGlobalFilter] = React.useState<{
    search: string;
    mode: WorkbookFilter;
  }>({ search: "", mode: "all" });
  const tableContainerRef = React.useRef<HTMLDivElement>(null);

  /*
   * Refs for volatile data read inside column cell renderers.
   * WHY: Column definitions close over ref objects (referentially stable).
   * When Convex pushes new data, the ref `.current` is updated but column
   * defs are NOT recreated — keeping TanStack's row model stable.
   */
  const existingEntriesRef = React.useRef(existingEntries);
  existingEntriesRef.current = existingEntries;
  const saveStatesRef = React.useRef(saveStates);
  saveStatesRef.current = saveStates;
  const existingNotesRef = React.useRef(existingNotes);
  existingNotesRef.current = existingNotes;
  const onEntryCommitRef = React.useRef(onEntryCommit);
  onEntryCommitRef.current = onEntryCommit;
  const onEntryDiscardRef = React.useRef(onEntryDiscard);
  onEntryDiscardRef.current = onEntryDiscard;
  const onNoteSaveRef = React.useRef(onNoteSave);
  onNoteSaveRef.current = onNoteSave;

  /**
   * Smart expand state: collapsed by default ("All" view acts as dashboard),
   * fully expanded when filtering to "Remaining" or "Today" for data entry.
   * Uses real state so user clicks can toggle individual rows.
   */
  const [expanded, setExpanded] = React.useState<ExpandedState>({});

  /**
   * Hide WBS rows with no labor MH by default — cleaner workbook for the
   * common case where many estimate WBS items aren't actually being used on
   * a given project. Change Orders is always exempt so users can still
   * right-click it to add scope.
   */
  const [hideUnused, setHideUnused] = React.useState(true);

  const data = React.useMemo(
    () => buildTree(rows, wbsSummaries, phaseSummaries, phasesByWbs, hideUnused),
    [rows, wbsSummaries, phaseSummaries, phasesByWbs, hideUnused]
  );

  /** Count of WBS items that the empty-filter is currently hiding. */
  const hiddenWbsCount = React.useMemo(() => {
    if (!hideUnused) return 0;
    let n = 0;
    for (const id of Object.keys(wbsSummaries)) {
      const s = wbsSummaries[id];
      if (!s) continue;
      if (s.source === "change_order") continue;
      if ((s.totalMH ?? 0) === 0) n++;
    }
    return n;
  }, [hideUnused, wbsSummaries]);

  /* Auto-expand when filtering or searching so results are immediately visible. */
  React.useEffect(() => {
    if (
      globalFilter.mode === "needs-entry" ||
      globalFilter.mode === "date-entries" ||
      globalFilter.search
    ) {
      setExpanded(true);
    } else {
      setExpanded({});
    }
  }, [globalFilter.mode, globalFilter.search]);

  /**
   * Keyboard navigation for entry cells.
   *
   * WHY: Rapid data entry requires keyboard-first navigation.
   * Tab/Enter move forward, Shift+Tab moves back.
   * Escape is handled inside EntryCellInput directly.
   */
  const handleEntryCellKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, activityId: string) => {
      const container = tableContainerRef.current;
      if (!container) return;

      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const allCells = Array.from(
          container.querySelectorAll<HTMLInputElement>("input[data-entry-cell]")
        );
        const currentIndex = allCells.findIndex(
          (el) => el.getAttribute("data-entry-cell") === activityId
        );
        if (currentIndex === -1) return;

        const direction = e.shiftKey ? -1 : 1;
        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < allCells.length) {
          allCells[nextIndex]!.focus();
          allCells[nextIndex]!.select();
        }
      }
    },
    []
  );

  /* Stable ref so column defs don't recreate when this callback identity changes */
  const handleEntryCellKeyDownRef = React.useRef(handleEntryCellKeyDown);
  handleEntryCellKeyDownRef.current = handleEntryCellKeyDown;

  /*
   * Stable callbacks passed to EntryCellInput. Created once (empty deps)
   * and delegate to refs internally so they always invoke the latest function.
   * WHY: Without stable references, React.memo on EntryCellInput is defeated
   * because inline arrows in the cell renderer create new identities every render.
   */
  const stableOnCommit = React.useCallback((id: string, val: string) => {
    onEntryCommitRef.current?.(id, val);
  }, []);
  const stableOnDiscard = React.useCallback((id: string) => {
    onEntryDiscardRef.current?.(id);
  }, []);
  const stableOnNoteSave = React.useCallback((id: string, notes: string) => {
    onNoteSaveRef.current?.(id, notes);
  }, []);
  const stableOnKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, id: string) => {
      handleEntryCellKeyDownRef.current(e, id);
    },
    []
  );

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
                  <span className="inline-flex items-center rounded-lg bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-bold font-mono text-foreground tabular-nums shrink-0">
                    {wbsCode}
                  </span>
                  <span className="font-semibold text-callout truncate">{description}</span>
                  <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                    <span className="text-subheadline font-mono tabular-nums text-muted-foreground">
                      {fmtMH(totalMH)} MH
                    </span>
                    <div className="w-16 h-1.5 rounded-full bg-fill-quaternary overflow-hidden">
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
                        "text-subheadline font-medium tabular-nums",
                        percentComplete === 0
                          ? "text-foreground-subtle"
                          : progressColor(percentComplete)
                      )}
                    >
                      {fmtPct(percentComplete)}
                    </span>
                  </div>
                </div>
              )}

              {rowType === "phase" && (
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="inline-flex items-center rounded-lg bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                    {phaseCode}
                  </span>
                  <span className="text-callout font-medium text-muted-foreground truncate">
                    {description}
                  </span>
                  {showSourceMarkers && (
                    <SourceMarker
                      source={row.original.source}
                      addedByUserId={row.original.addedByUserId}
                      addedAt={row.original.addedAt}
                      contributors={contributors}
                    />
                  )}
                  {row.original.source === "change_order" && (
                    <ChangeOrderBadge status={row.original.changeOrderStatus} />
                  )}
                  <span className="text-subheadline font-mono tabular-nums text-foreground-subtle shrink-0 ml-auto">
                    {earnedMH === 0 ? (
                      <>
                        <span className="text-foreground-subtle">&mdash;</span> / {fmtMH(totalMH)}
                      </>
                    ) : (
                      <>
                        {fmtMH(earnedMH)} / {fmtMH(totalMH)}
                      </>
                    )}
                  </span>
                  {/* #33 — phase % complete, mirroring the WBS row's readout. */}
                  <span
                    className={cn(
                      "w-14 text-right text-subheadline font-medium tabular-nums shrink-0",
                      percentComplete === 0
                        ? "text-foreground-subtle"
                        : progressColor(percentComplete)
                    )}
                  >
                    {fmtPct(percentComplete)}
                  </span>
                </div>
              )}

              {rowType === "detail" && (
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {row.original.isSplit ? (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Split className="h-3.5 w-3.5 text-primary shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-subheadline">
                          Split from Phase {row.original.sourcePhaseCode ?? ""}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : percentComplete >= 100 ? (
                    <Check className="h-3.5 w-3.5 text-success-text shrink-0" />
                  ) : percentComplete > 0 ? (
                    <CircleDot className="h-3 w-3 text-primary/70 shrink-0" />
                  ) : null}
                  <span
                    className={cn(
                      "text-callout truncate",
                      row.original.isSplit && "italic text-muted-foreground"
                    )}
                    title={
                      row.original.isSplit && row.original.sourcePhaseCode
                        ? `${description} — split from Phase ${row.original.sourcePhaseCode}`
                        : description
                    }
                  >
                    {description}
                  </span>
                  {showSourceMarkers && (
                    <SourceMarker
                      source={row.original.source}
                      addedByUserId={row.original.addedByUserId}
                      addedAt={row.original.addedAt}
                      contributors={contributors}
                    />
                  )}
                  {row.original.isOverridden && row.original.originalPhaseCode && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <ArrowRightLeft className="h-3 w-3 text-mac-orange shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-subheadline">
                          Moved from Phase {row.original.originalPhaseCode}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {/* #25 — always show an activity-level % (even at 0% / 100%). */}
                  <span
                    className={cn(
                      "text-subheadline font-mono tabular-nums shrink-0 ml-auto",
                      percentComplete === 0
                        ? "text-foreground-subtle"
                        : progressColor(percentComplete)
                    )}
                  >
                    {fmtPct(percentComplete)}
                  </span>
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
                "text-right font-mono text-callout tabular-nums",
                row.original.quantityRemaining === 0 ? "text-success-text" : "text-muted-foreground"
              )}
            >
              {fmtQty(row.original.quantityRemaining)}
            </div>
          ) : null,
      },

      /* ── Entry column ── */
      {
        id: "entryQty",
        header: () => (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-subheadline font-semibold text-primary">
              {entryDateLabel || "Entry"}{" "}
              <span className="font-normal text-foreground-subtle">Qty</span>
            </span>
          </div>
        ),
        size: 130,
        cell: ({ row }) => {
          if (row.original.rowType !== "detail") return null;
          const activityId = row.original.id;
          const existingValue = existingEntriesRef.current?.[activityId];
          const hasExisting = existingValue !== undefined && existingValue > 0;
          const maxAllowed = row.original.quantityRemaining + (existingValue ?? 0);

          const isComplete = row.original.quantityRemaining === 0 && !hasExisting;
          if (isComplete) {
            return (
              <div className="flex items-center justify-end gap-1.5 text-success-text">
                <Check className="h-3.5 w-3.5" />
                <span className="text-subheadline font-medium">Done</span>
              </div>
            );
          }

          return (
            <EntryCellInput
              activityId={activityId}
              existingValue={existingValue}
              maxAllowed={maxAllowed}
              saveState={saveStatesRef.current?.[activityId]}
              existingNote={existingNotesRef.current?.[activityId]}
              onCommit={stableOnCommit}
              onDiscard={stableOnDiscard}
              onNoteSave={stableOnNoteSave}
              showNoteAlways={hasExisting}
              onKeyDown={stableOnKeyDown}
            />
          );
        },
      },
    ];
  }, [
    entryDateLabel,
    stableOnCommit,
    stableOnDiscard,
    stableOnNoteSave,
    stableOnKeyDown,
    showSourceMarkers,
    contributors,
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
                  <span className="inline-flex items-center rounded-lg bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-bold font-mono text-foreground tabular-nums shrink-0">
                    {wbsCode}
                  </span>
                  <span className="font-semibold text-callout truncate">{description}</span>
                  <div className="hidden sm:flex items-center gap-1.5 shrink-0 ml-auto">
                    <div className="w-16 h-1.5 rounded-full bg-fill-quaternary overflow-hidden">
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
                        "text-subheadline font-medium tabular-nums",
                        percentComplete === 0
                          ? "text-foreground-subtle"
                          : progressColor(percentComplete)
                      )}
                    >
                      {fmtPct(percentComplete)}
                    </span>
                  </div>
                </div>
              )}

              {rowType === "phase" && (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex items-center rounded-lg bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                    {phaseCode}
                  </span>
                  <span className="text-callout font-medium text-muted-foreground truncate">
                    {description}
                  </span>
                  {showSourceMarkers && (
                    <SourceMarker
                      source={row.original.source}
                      addedByUserId={row.original.addedByUserId}
                      addedAt={row.original.addedAt}
                      contributors={contributors}
                    />
                  )}
                </div>
              )}

              {rowType === "detail" && (
                <div className="flex items-center gap-1.5 min-w-0">
                  {row.original.isSplit ? (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Split className="h-3.5 w-3.5 text-primary shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-subheadline">
                          Split from Phase {row.original.sourcePhaseCode ?? ""}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : percentComplete >= 100 ? (
                    <Check className="h-3.5 w-3.5 text-success-text shrink-0" />
                  ) : percentComplete > 0 ? (
                    <CircleDot className="h-3 w-3 text-primary/70 shrink-0" />
                  ) : null}
                  <span
                    className={cn(
                      "text-callout truncate",
                      row.original.isSplit && "italic text-muted-foreground"
                    )}
                    title={
                      row.original.isSplit && row.original.sourcePhaseCode
                        ? `${description} — split from Phase ${row.original.sourcePhaseCode}`
                        : description
                    }
                  >
                    {description}
                  </span>
                  {showSourceMarkers && (
                    <SourceMarker
                      source={row.original.source}
                      addedByUserId={row.original.addedByUserId}
                      addedAt={row.original.addedAt}
                      contributors={contributors}
                    />
                  )}
                  {row.original.isOverridden && row.original.originalPhaseCode && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <ArrowRightLeft className="h-3 w-3 text-mac-orange shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-subheadline">
                          Moved from Phase {row.original.originalPhaseCode}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
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
            <div className="text-right font-mono text-callout tabular-nums">
              {row.original.quantity}
            </div>
          ) : null,
      },

      /* ── Unit ── */
      {
        accessorKey: "unit",
        header: () => <div className="text-center">Unit</div>,
        size: 50,
        cell: ({ row }) =>
          row.original.rowType === "detail" ? (
            <div className="text-center text-subheadline text-muted-foreground uppercase tracking-wide">
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
            <div className="text-right font-mono text-callout tabular-nums">
              {row.original.quantityComplete > 0 ? (
                row.original.quantityComplete
              ) : (
                <span className="text-foreground-subtle">&mdash;</span>
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
                "text-right font-mono text-callout tabular-nums",
                row.original.quantityRemaining === 0 ? "text-success-text" : "text-muted-foreground"
              )}
            >
              {fmtQty(row.original.quantityRemaining)}
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
          const isGroup = row.original.rowType !== "detail";
          return (
            <div
              className={cn(
                "text-right font-mono text-callout tabular-nums",
                isGroup && "font-semibold"
              )}
            >
              {row.original.totalMH > 0 ? (
                row.original.totalMH.toFixed(2)
              ) : isGroup ? (
                <span className="text-foreground-subtle">&mdash;</span>
              ) : (
                ""
              )}
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
          const isGroup = row.original.rowType !== "detail";
          return (
            <div
              className={cn(
                "text-right font-mono text-callout tabular-nums",
                isGroup && "font-semibold"
              )}
            >
              {row.original.earnedMH > 0 ? (
                row.original.earnedMH.toFixed(2)
              ) : isGroup ? (
                <span className="text-foreground-subtle">&mdash;</span>
              ) : (
                ""
              )}
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
            return (
              <div className="text-right text-callout text-foreground-subtle">{fmtPct(0)}</div>
            );
          }
          if (row.original.rowType !== "detail") {
            if (pct === 0) {
              return (
                <div className="text-right font-mono text-callout font-semibold tabular-nums sm:hidden text-foreground-subtle">
                  &mdash;
                </div>
              );
            }
            return (
              <div
                className={cn(
                  "text-right font-mono text-callout font-semibold tabular-nums sm:hidden",
                  progressColor(pct)
                )}
              >
                {fmtPct(pct)}
              </div>
            );
          }
          return (
            <div
              className={cn(
                "text-right font-mono text-callout font-medium tabular-nums",
                progressColor(pct)
              )}
            >
              {fmtPct(pct)}
            </div>
          );
        },
      },

      /* ── Entry column ── */
      {
        id: "entryQty",
        header: () => (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-subheadline font-semibold text-primary">
              {entryDateLabel || "Entry"}{" "}
              <span className="font-normal text-foreground-subtle">Qty</span>
            </span>
          </div>
        ),
        size: 130,
        cell: ({ row }) => {
          if (row.original.rowType !== "detail") return null;
          const activityId = row.original.id;
          const existingValue = existingEntriesRef.current?.[activityId];
          const hasExisting = existingValue !== undefined && existingValue > 0;
          const maxAllowed = row.original.quantityRemaining + (existingValue ?? 0);

          const isComplete = row.original.quantityRemaining === 0 && !hasExisting;
          if (isComplete) {
            return (
              <div className="flex items-center justify-end gap-1.5 text-success-text">
                <Check className="h-3.5 w-3.5" />
                <span className="text-subheadline font-medium">Done</span>
              </div>
            );
          }

          return (
            <EntryCellInput
              activityId={activityId}
              existingValue={existingValue}
              maxAllowed={maxAllowed}
              saveState={saveStatesRef.current?.[activityId]}
              existingNote={existingNotesRef.current?.[activityId]}
              onCommit={stableOnCommit}
              onDiscard={stableOnDiscard}
              onNoteSave={stableOnNoteSave}
              showNoteAlways={hasExisting}
              onKeyDown={stableOnKeyDown}
            />
          );
        },
      },
    ];
  }, [
    entryDateLabel,
    stableOnCommit,
    stableOnDiscard,
    stableOnNoteSave,
    stableOnKeyDown,
    showSourceMarkers,
    contributors,
  ]);

  const columns = columnMode === "entry" ? entryColumns : fullColumns;

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSubRows: (row) => row.subRows,
    filterFromLeafRows: true,
    globalFilterFn: (row, _columnId, filterValue: { search: string; mode: WorkbookFilter }) => {
      const { search: rawSearch, mode } = filterValue;
      const search = rawSearch.toLowerCase();
      const original = row.original;

      const matchesSearch =
        !search ||
        original.description.toLowerCase().includes(search) ||
        original.wbsCode.toLowerCase().includes(search) ||
        original.phaseCode.toLowerCase().includes(search);

      if (!matchesSearch) return false;

      if (mode === "needs-entry") {
        if (original.rowType === "detail") {
          const hasEntry = existingEntriesRef.current?.[original.id] !== undefined;
          return !hasEntry && original.quantityRemaining > 0;
        }
        // Group rows: let filterFromLeafRows propagate from matching children
        return false;
      }
      if (mode === "date-entries") {
        if (original.rowType === "detail") {
          const hasEntry = existingEntriesRef.current?.[original.id] !== undefined;
          return hasEntry;
        }
        // Group rows: let filterFromLeafRows propagate from matching children
        return false;
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

  /** Group flattened rows into per-WBS sections for scoped sticky behavior. */
  const flatRows = table.getRowModel().rows;
  const rowGroups = React.useMemo(() => {
    const groups: { wbsId: string; rows: typeof flatRows }[] = [];
    let current: (typeof groups)[0] | null = null;

    for (const row of flatRows) {
      if (row.original.rowType === "wbs") {
        current = { wbsId: row.id, rows: [row] };
        groups.push(current);
      } else if (current) {
        current.rows.push(row);
      }
    }
    return groups;
  }, [flatRows]);

  /**
   * Filter modes scoped to the selected entry date — the daily-entry arc:
   * browse everything → find what's still to log → review what was logged.
   * Counts and tooltips name the date so the segmented control is unambiguous.
   */
  const filterOptions = React.useMemo(() => {
    // "Entered" = items with progress logged for the selected date.
    const enteredCount = rows.filter((r) => existingEntries?.[r.id] !== undefined).length;
    // "Needs Entry" matches its filter exactly: not logged for this date AND
    // still incomplete (so completed items don't pad the to-do count).
    const needsEntryCount = rows.filter(
      (r) => existingEntries?.[r.id] === undefined && r.quantityRemaining > 0
    ).length;
    const dateLabel = entryDateLabel || "this date";
    return [
      {
        value: "all" as const,
        label: "All",
        count: rows.length,
        title: "Every line item",
      },
      {
        value: "needs-entry" as const,
        label: "Needs Entry",
        count: needsEntryCount,
        title: `Still to log for ${dateLabel} — incomplete items you haven't entered yet`,
      },
      {
        value: "date-entries" as const,
        label: "Entered",
        count: enteredCount,
        title: `Logged for ${dateLabel}`,
      },
    ];
  }, [rows, existingEntries, entryDateLabel]);

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* ── Status slices — category roll-ups (#38) ── */}
      <ProjectStatusSlices wbsSummaries={wbsSummaries} className="mb-3" />

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 pb-3 px-1">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search items..."
            value={globalFilter.search}
            onChange={(e) => setGlobalFilter((prev) => ({ ...prev, search: e.target.value }))}
            className="h-8 pl-8 text-callout rounded-full"
          />
        </div>

        {/* Filter pills with counts */}
        <div className="flex items-center rounded-lg bg-fill-tertiary p-[3px]">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.title}
              onClick={() => setGlobalFilter((prev) => ({ ...prev, mode: option.value }))}
              className={cn(
                "rounded-md px-2 py-[3px] text-subheadline font-medium transition-all duration-150",
                globalFilter.mode === option.value
                  ? "bg-background text-foreground shadow-xs"
                  : "text-foreground-subtle hover:text-foreground"
              )}
            >
              {option.label}
              <span className="ml-1 text-footnote tabular-nums opacity-50">{option.count}</span>
            </button>
          ))}
        </div>

        {/* Column mode toggle */}
        {onColumnModeChange && (
          <div className="flex items-center rounded-lg bg-fill-tertiary p-[3px]">
            {[
              { value: "entry" as const, label: "Entry" },
              { value: "full" as const, label: "Full" },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => onColumnModeChange(option.value)}
                className={cn(
                  "rounded-md px-2 py-[3px] text-subheadline font-medium transition-all duration-150",
                  columnMode === option.value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-foreground-subtle hover:text-foreground"
                )}
              >
                {option.value === "entry" ? "Entry" : "Full"}
              </button>
            ))}
          </div>
        )}

        {/* Empty-WBS visibility toggle */}
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setHideUnused((v) => !v)}
                className={cn(
                  "flex items-center gap-1 rounded-lg px-2 py-1 text-subheadline font-medium transition-colors",
                  hideUnused
                    ? "text-muted-foreground hover:text-foreground hover:bg-fill-quaternary/50"
                    : "text-foreground bg-fill-quaternary/60 hover:bg-fill-quaternary"
                )}
                aria-pressed={!hideUnused}
              >
                {hideUnused ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {hideUnused
                  ? hiddenWbsCount > 0
                    ? `${hiddenWbsCount} hidden`
                    : "Unused"
                  : "Show all"}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {hideUnused
                ? "Show WBS, phases & activities with no assigned man-hours"
                : "Hide WBS, phases & activities with no assigned man-hours"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Expand / Collapse All */}
        <button
          type="button"
          onClick={() => setExpanded((prev) => (prev === true ? {} : true))}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-subheadline font-medium text-muted-foreground hover:text-foreground hover:bg-fill-quaternary/50 transition-colors"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
          {expanded === true ? "Collapse All" : "Expand All"}
        </button>

        <span className="text-footnote text-foreground-subtle hidden lg:inline ml-auto">
          Tab/Enter to navigate &middot; Esc to cancel
        </span>
      </div>

      {/* ── Table ── */}
      <div
        ref={tableContainerRef}
        className="rounded-lg border overflow-auto flex-1 min-w-0 max-h-[calc(100vh-280px)]"
      >
        <table className="w-full table-fixed text-callout">
          <thead className="sticky top-0 z-30 bg-background [&_tr]:border-b">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                key={headerGroup.id}
                className="bg-fill-quaternary/50 hover:bg-fill-quaternary/50 border-b transition-colors"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className={cn(
                      "text-subheadline font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap h-8",
                      header.id === "entryQty" && "border-l border-primary/15 bg-primary/[0.03]"
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </tr>
            ))}
          </thead>
          {rowGroups.length > 0 ? (
            rowGroups.map((group) => (
              <tbody key={group.wbsId} className="[&_tr:last-child]:border-0">
                {group.rows.map((row) => {
                  const { rowType, percentComplete } = row.original;
                  const isComplete = percentComplete >= 100 && rowType === "detail";

                  return (
                    <TableRow
                      key={row.id}
                      style={
                        rowType === "wbs"
                          ? {
                              borderLeftColor:
                                row.original.source === "change_order"
                                  ? CHANGE_ORDER_ACCENT
                                  : groupColor(row.original.wbsCode),
                            }
                          : undefined
                      }
                      className={cn(
                        "transition-colors duration-100",
                        rowType === "wbs" &&
                          cn(
                            "sticky top-[32px] z-20",
                            "bg-background",
                            "shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
                            "border-l-[3px]",
                            "hover:bg-fill-quaternary"
                          ),
                        rowType === "phase" &&
                          cn(
                            "sticky top-[72px] z-10",
                            "bg-background",
                            "[&>td]:bg-fill-quaternary/40",
                            "hover:bg-fill-quaternary/50"
                          ),
                        rowType === "detail" && "hover:bg-fill-quaternary group/row",
                        isComplete && "opacity-60"
                      )}
                      onContextMenu={
                        rowType === "detail" && onRowContextMenu
                          ? (e) => {
                              const sourceRow = rows.find((r) => r.id === row.original.id);
                              if (sourceRow) onRowContextMenu(sourceRow, e);
                            }
                          : rowType === "phase" && onPhaseContextMenu
                            ? (e) => {
                                onPhaseContextMenu(row.original.id, row.original.wbsId, e);
                              }
                            : rowType === "wbs" && onWbsContextMenu
                              ? (e) => {
                                  onWbsContextMenu(row.original.id, e);
                                }
                              : undefined
                      }
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            "py-1.5 px-2.5",
                            rowType === "wbs" && "h-10",
                            rowType === "phase" && "h-9",
                            cell.column.id === "entryQty" &&
                              rowType === "wbs" &&
                              "border-l border-primary/15 bg-primary/[0.04]",
                            cell.column.id === "entryQty" &&
                              rowType === "phase" &&
                              "border-l border-primary/10 bg-fill-quaternary/50",
                            cell.column.id === "entryQty" &&
                              rowType === "detail" &&
                              "border-l border-primary/10 bg-primary/[0.015]"
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </tbody>
            ))
          ) : (
            <tbody className="[&_tr:last-child]:border-0">
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32">
                  <div className="flex flex-col items-center justify-center gap-1.5 text-center">
                    {globalFilter.mode === "needs-entry" ? (
                      <>
                        <Check className="h-5 w-5 text-success-text" />
                        <p className="text-callout font-medium text-muted-foreground">
                          You&apos;re all caught up
                        </p>
                        <p className="text-subheadline text-foreground-subtle">
                          Nothing left to log{entryDateLabel ? ` for ${entryDateLabel}` : ""}
                        </p>
                      </>
                    ) : (
                      <>
                        <Search className="h-5 w-5 text-foreground-subtle" />
                        <p className="text-callout font-medium text-muted-foreground">
                          {globalFilter.search ? "No matching items" : "No work items"}
                        </p>
                        <p className="text-subheadline text-foreground-subtle">
                          {globalFilter.search
                            ? "Try a different search term"
                            : globalFilter.mode === "date-entries"
                              ? `Nothing logged${entryDateLabel ? ` for ${entryDateLabel}` : ""} yet`
                              : "Import estimate data to get started"}
                        </p>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
