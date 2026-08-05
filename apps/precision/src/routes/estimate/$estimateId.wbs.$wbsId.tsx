import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { cn } from "@truss/ui/lib/utils";
import { Plus, Copy, Trash2 } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import {
  InspectorToggle,
  TotalsInspector,
  useTotalsInspector,
} from "../../components/totals-inspector";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { AddPhaseDialog } from "../../components/add-phase-dialog";
import { SelectionBar } from "../../components/selection-bar";
import { ColumnMenu } from "../../components/activity-grid/column-menu";
import { refocusCell, useGridNavigation } from "../../components/activity-grid/use-grid-navigation";
import { cellWidth, columnSizeVars, pinnedStyle } from "../../components/grid-geometry";
import {
  buildPhaseColumns,
  laborChannelEdges,
  laborChannelStyle,
  phaseTotalsCell,
  PHASE_COLUMN_LABELS,
  type PhaseColumnMeta,
  type PhaseListContext,
  type PhaseListTotals,
  type PhaseRow,
} from "../../components/phase-list/columns";
import {
  buildPhaseEdit,
  isPhaseCellEditable,
  readPhaseRefusal,
  type EditablePhaseColumnId,
} from "../../components/phase-list/edits";
import {
  autoVisibility,
  loadOverrides,
  loadSizing,
  mergeVisibility,
  pruneOverrides,
  saveOverrides,
  saveSizing,
  sizingStorageKey,
  summarizeContents,
  visibilityStorageKey,
  LABOR_CHANNEL,
  PHASE_COLUMN_IDS,
} from "../../components/phase-list/visibility";
import { canEditPrecision } from "../../lib/permissions";
import { formatWbsLabel } from "../../config/shell-config-estimate";
import { toast } from "sonner";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/estimate/$estimateId/wbs/$wbsId")({
  component: WBSDetailPage,
});

/**
 * A stable empty list for the first render.
 *
 * A fresh `[]` on every render is a new identity, which makes TanStack rebuild
 * its row model each time — see the sizing guide's note on referential inputs.
 */
const NO_ROWS: PhaseRow[] = [];

/**
 * The WBS cost report, WBS HOME sheet: one row per phase of one breakdown.
 *
 * This is the screen InDemand reads a breakdown from, and it is the same
 * instrument as the activity grid one level down — same row height, same
 * resizable and remembered columns, same column menu, same spreadsheet
 * movement, same frozen edges, same totals panel. The two are the same table to
 * the person using them, one drill-down apart, so they are built from the same
 * parts.
 *
 * ⚠️ IT IS A WORK SURFACE, NOT A PRINTOUT. Every attribute of a phase is typed
 * in place, through the same EditableCell the grid below uses — the tool this
 * replaces let an estimator edit a phase where they read it, and a report that
 * makes them open a dialog to fix a sheet number is a report they will keep in
 * Excel. The hours and money columns are the exception and stay read-only: they
 * roll up from the activities, and a typed phase total would be a second source
 * of truth for a number the engine owns. `phase-list/edits.ts` is where one
 * committed cell becomes one payload.
 */
function WBSDetailPage() {
  const { estimateId, wbsId } = Route.useParams();
  // The route-param casts; every call below stays fully checked.
  const proposalId = estimateId as Id<"proposals">;
  const typedWbsId = wbsId as Id<"wbs">;
  const navigate = useNavigate();
  const convex = useConvex();
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);

  /**
   * Warm the phase screen's two cold queries on row hover, so the drill-down
   * mounts already populated instead of flashing its skeleton. Hover dwell
   * beats the round-trip; misses fall back to the normal loading path.
   */
  const warmPhase = useCallback(
    (phaseId: string) => {
      const typedPhaseId = phaseId as Id<"phases">;
      void warmQuery(convex, api.precision.getPhase, { phaseId: typedPhaseId });
      void warmQuery(convex, api.precision.getActivitiesWithCosts, { phaseId: typedPhaseId });
    },
    [convex]
  );
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();

  const proposal = useStableQuery(api.precision.getProposal, { proposalId });
  const phaseList = useStableQuery(api.precision.getPhaseListWithCosts, { wbsId: typedWbsId });
  // Feeds the toolbar's grand-total chip and the inspector's Estimate section.
  const summary = useStableQuery(api.precision.getProposalSummary, { proposalId });
  const [inspectorOpen, toggleInspector] = useTotalsInspector();

  // The whole WBS list rather than this one document: the shell already
  // subscribes to it for the sidebar, so the breadcrumb resolves from cache
  // instead of paying for a second round-trip.
  const wbsList = useStableQuery(api.precision.getWBSForProposal, { proposalId });
  const wbs = wbsList?.find((w) => w._id === wbsId);

  const deletePhase = useMutation(api.precision.deletePhase);
  const duplicatePhase = useMutation(api.precision.duplicatePhase);
  const updatePhase = useMutation(api.precision.updatePhase);
  const updateRef = useRef(updatePhase);
  updateRef.current = updatePhase;

  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});

  // SELECTION IS PER BREAKDOWN. A param-only navigation keeps this component
  // mounted, so without this reset the previous WBS's phase ids stay selected —
  // invisible (no row matches them) yet counted by the toolbar. Delete would
  // then be honoured against phases the estimator cannot see, in a breakdown
  // they have already left. Same defect the phase grid guards against.
  useEffect(() => {
    setRowSelection({});
  }, [wbsId]);

  // A live revoke unmounts the dialog; also clear its open flag so a later
  // re-grant does not pop it open unprompted.
  useEffect(() => {
    if (!canEdit) setAddPhaseOpen(false);
  }, [canEdit]);

  // Defence in depth: Convex does not guarantee that a query's ordering survives
  // serialization (Momentum lost its WBS order that way, see the `#36` note in
  // workbook-table.tsx), so order by phase number on the client.
  const phases = useMemo<PhaseRow[] | undefined>(
    () => (phaseList ? [...phaseList].sort((a, b) => a.phaseNumber - b.phaseNumber) : undefined),
    [phaseList]
  );
  const rows = phases ?? NO_ROWS;

  /**
   * Commit one attribute cell.
   *
   * WHAT WAS TYPED IS READ BY `buildPhaseEdit` — a clear, a value, or something
   * the field cannot hold — because that decision is the part worth testing
   * without a grid, a server or a browser. This carries the result over the
   * wire and says what happened when the server refuses.
   *
   * ⚠️ ONLY THE EDITED KEY TRAVELS. The mutation merges a piping-spec patch
   * over what is stored, so sending a reconstructed spec would let one cell's
   * edit overwrite the five members beside it — and an unchanged resend is an
   * empty patch server-side, which does not claim the estimate for Precision.
   *
   * A PHASE NUMBER EDIT REORDERS THE REPORT, since the rows are ordered by it.
   * That is right — a phase belongs where its number puts it — and the cell
   * keeps focus through the move because rows are keyed by id.
   */
  const commitField = useCallback(
    async (row: PhaseRow, columnId: EditablePhaseColumnId, raw: string, rejected?: boolean) => {
      if (!canEdit) return;
      const edit = buildPhaseEdit(columnId, raw, rejected);
      if (edit.outcome === "refused") {
        // The cell reverts to what is stored on its own; this says why.
        toast.error("Nothing was saved", { description: edit.message });
        return;
      }
      try {
        await updateRef.current({ phaseId: row._id, ...edit.patch });
      } catch (error) {
        const refusal = readPhaseRefusal(error);
        toast.error(refusal.title, { description: refusal.message });
        // A refusal that names a cell has one remedy — retype that cell — so
        // the screen walks back to it rather than leaving the estimator to
        // work out which of twenty-four columns the toast is about.
        if (refusal.column) refocusCell(row._id, refusal.column);
      }
    },
    [canEdit]
  );

  const toggleCompleted = useCallback(
    async (row: PhaseRow, next: boolean) => {
      if (!canEdit) return;
      try {
        await updateRef.current({ phaseId: row._id, isCompleted: next });
      } catch (error) {
        toast.error("Failed to update the phase", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit]
  );

  // ── Column visibility: report definition → data → user override ──
  const storageKey = visibilityStorageKey(estimateId, wbs?.wbsPoolId);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Re-read when the breakdown changes: preferences are per WBS, and a
  // param-only navigation keeps this component mounted.
  useEffect(() => {
    setOverrides(loadOverrides(storageKey));
  }, [storageKey]);

  const auto = useMemo(
    () => autoVisibility(wbs?.wbsPoolId, summarizeContents(rows)),
    [wbs?.wbsPoolId, rows]
  );
  const columnVisibility = useMemo(() => mergeVisibility(auto, overrides), [auto, overrides]);

  const handleVisibilityChange = useCallback(
    (updater: React.SetStateAction<Record<string, boolean>>) => {
      setOverrides((prev) => {
        const merged = mergeVisibility(auto, prev);
        const next = typeof updater === "function" ? updater(merged) : updater;
        // Only what disagrees with the automatic answer is remembered, so a
        // column the estimator never touched keeps following the data.
        const pruned = pruneOverrides(auto, next);
        saveOverrides(storageKey, pruned);
        return pruned;
      });
    },
    [auto, storageKey]
  );

  const resetVisibility = useCallback(() => {
    saveOverrides(storageKey, {});
    setOverrides({});
  }, [storageKey]);

  // ── Column widths ──
  // Estimators size a grid to the work in front of them; the defaults are a
  // starting point, not a verdict. Drag a header edge to resize, double-click
  // it to put that column back.
  const sizeKey = sizingStorageKey(estimateId, wbs?.wbsPoolId);
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({});
  useEffect(() => {
    setColumnSizing(loadSizing(sizeKey));
  }, [sizeKey]);
  const handleSizingChange = useCallback(
    (updater: React.SetStateAction<Record<string, number>>) => {
      setColumnSizing((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        saveSizing(sizeKey, next);
        return next;
      });
    },
    [sizeKey]
  );

  // ── Spreadsheet movement ──
  // Built from the rows and the VISIBLE columns, so hiding a column changes
  // where Tab goes. Every attribute accepts typing and every rolled-up figure
  // does not, so Tab walks the fields an estimator fills in and steps over the
  // ten columns the engine owns — and Enter walks one column down the
  // breakdown, which is what entering takeoffs or sheet numbers actually is.
  const orderedRows = useMemo(() => rows.map((row) => row._id as string), [rows]);
  const measuredRows = useMemo(() => {
    const measured = new Set<string>();
    for (const row of rows) if (row.takeoff) measured.add(row._id as string);
    return measured;
  }, [rows]);
  // Derived from the visibility model rather than from the table: the table
  // needs the columns, the columns need `nav`, and `nav` needs this.
  const visibleColumnIds = useMemo(
    () =>
      PHASE_COLUMN_IDS.filter(
        (id) => (id !== "select" || canEdit) && columnVisibility[id] !== false
      ),
    [columnVisibility, canEdit]
  );
  const isEditableCell = useCallback(
    // A phase whose type has no takeoff has no QTY or UNIT input to land on, so
    // movement skips those rather than stranding the cursor on a dash.
    (rowId: string, columnId: string) =>
      isPhaseCellEditable(columnId, { canEdit, hasTakeoff: measuredRows.has(rowId) }),
    [canEdit, measuredRows]
  );
  const nav = useGridNavigation({
    rowIds: orderedRows,
    columnIds: visibleColumnIds,
    isEditable: isEditableCell,
  });

  // ── Columns ──
  // Volatile values travel by ref so the array can be built once — see
  // buildPhaseColumns. Refreshed every render, read at cell-render time.
  const columnCtx = useRef<PhaseListContext>({
    estimateId,
    canEdit,
    onToggleCompleted: (row, next) => void toggleCompleted(row, next),
    onCommitField: (row, columnId, raw, rejected) => void commitField(row, columnId, raw, rejected),
    onKeyDown: nav,
  });
  columnCtx.current = {
    estimateId,
    canEdit,
    onToggleCompleted: (row, next) => void toggleCompleted(row, next),
    onCommitField: (row, columnId, raw, rejected) => void commitField(row, columnId, raw, rejected),
    onKeyDown: nav,
  };
  const columns = useMemo(() => buildPhaseColumns(canEdit, columnCtx), [canEdit]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row._id as string,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: handleVisibilityChange,
    onColumnSizingChange: handleSizingChange,
    enableColumnResizing: true,
    // 'onChange' tracks the pointer; the CSS-variable widths below are what
    // keep that affordable, per the sizing guide.
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 44, maxSize: 600 },
    /**
     * Pinned by the app, not by the estimator: scrolling twenty-four columns
     * sideways must never cost the row's identity or its answer.
     *
     * ⚠️ DESCRIPTION IS DELIBERATELY NOT PINNED, unlike the activity grid's.
     * Pinning moves a column to the frozen edge, and on a piping breakdown
     * SIZE and FLC sit BETWEEN the phase and its description — pinning the
     * description would reorder the client's own sheet to get it. The phase
     * number is the identity estimators actually use, and it is frozen.
     */
    initialState: {
      columnPinning: { left: ["select", "completed", "phase"], right: ["totalCost"] },
    },
    // Controlled ONLY — the docs warn that passing columnVisibility in both
    // `state` and `initialState` silently ignores the latter.
    state: { rowSelection, columnVisibility, columnSizing },
  });

  /**
   * The breakdown's totals — ONE object, read by the totals row at the foot of
   * the grid and by the inspector's scope panel beside it. Two sums over the
   * same rows would be two chances to disagree about what this WBS costs.
   */
  const totals = useMemo<PhaseListTotals | null>(() => {
    if (!phases) return null;
    return phases.reduce<PhaseListTotals>(
      (acc, phase) => ({
        phaseCount: acc.phaseCount + 1,
        craftManHours: acc.craftManHours + phase.costs.craftManHours,
        welderManHours: acc.welderManHours + phase.costs.welderManHours,
        craftCost: acc.craftCost + phase.costs.craftCost,
        welderCost: acc.welderCost + phase.costs.welderCost,
        materialCost: acc.materialCost + phase.costs.materialCost,
        equipmentCost: acc.equipmentCost + phase.costs.equipmentCost,
        subcontractorCost: acc.subcontractorCost + phase.costs.subcontractorCost,
        costOnlyCost: acc.costOnlyCost + phase.costs.costOnlyCost,
        totalCost: acc.totalCost + phase.costs.totalCost,
      }),
      {
        phaseCount: 0,
        craftManHours: 0,
        welderManHours: 0,
        craftCost: 0,
        welderCost: 0,
        materialCost: 0,
        equipmentCost: 0,
        subcontractorCost: 0,
        costOnlyCost: 0,
        totalCost: 0,
      }
    );
  }, [phases]);

  const selectedIds = useMemo(() => {
    // Pruned against what is actually loaded: another client may have deleted
    // a selected phase while it sat checked.
    const live = new Set(rows.map((row) => row._id as string));
    return Object.keys(rowSelection).filter((id) => rowSelection[id] && live.has(id));
  }, [rowSelection, rows]);

  const handleDeleteSelected = useCallback(async () => {
    if (!canEdit || selectedIds.length === 0) return;

    // Deleted one at a time, so a mid-loop failure leaves the earlier phases
    // already gone. Track what actually succeeded and clear exactly those from
    // the selection — clearing all of it would hide the failure, and clearing
    // none of it would leave deleted rows checked.
    const deleted: string[] = [];
    try {
      for (const id of selectedIds) {
        await deletePhase({ phaseId: id as Id<"phases"> });
        deleted.push(id);
      }
      toast.success(
        selectedIds.length === 1 ? "Phase deleted" : `${selectedIds.length} phases deleted`
      );
    } catch (error) {
      toast.error(
        deleted.length === 0
          ? "Failed to delete phases"
          : `Deleted ${deleted.length} of ${selectedIds.length} phases, then failed`,
        {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }
      );
    } finally {
      if (deleted.length > 0) {
        setRowSelection((prev) => {
          const next = { ...prev };
          for (const id of deleted) delete next[id];
          return next;
        });
      }
    }
  }, [canEdit, selectedIds, deletePhase]);

  const handleDuplicate = useCallback(
    async (phaseId: string, phaseNumber: number) => {
      if (!canEdit) return;
      try {
        // The server assigns the number (D-phasenumber) and reports it back.
        const result = await duplicatePhase({ sourcePhaseId: phaseId as Id<"phases"> });
        toast.success(`Phase ${result.phaseNumber} created`, {
          description: `Copied from phase ${phaseNumber}.`,
        });
      } catch (error) {
        toast.error("Failed to duplicate phase", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit, duplicatePhase]
  );

  /**
   * The table TRACKS THE WINDOW: 100% of the container with a min-width floor
   * at the sum of the columns. Wider than the columns need, the grid still
   * fills the pane and the description — the one column whose content has no
   * natural width — absorbs the difference. Narrower, the floor holds every
   * measured width and the grid scrolls sideways under frozen edges.
   */
  const descriptionIsSized = columnSizing.description !== undefined;
  const widthFor = (columnId: string, sizeVar: string): React.CSSProperties =>
    cellWidth(columnId, sizeVar, {
      flexColumnId: "description",
      flexMinWidth: 200,
      isFlexColumnSized: descriptionIsSized,
    });
  const sizeVars = columnSizeVars(table);
  /**
   * The columns IN THE ORDER THEY ARE DRAWN.
   *
   * ⚠️ NOT `getVisibleLeafColumns()`, which reports DECLARATION order. Pinning
   * moves columns to the frozen edges, and the body renders
   * `row.getVisibleCells()` — left, then centre, then right. The totals row and
   * the header read the same list, so a future pin can never leave the figure
   * at the foot of a column standing under a different column's heading, which
   * is the one defect a cost report cannot survive.
   */
  const headerGroups = table.getHeaderGroups();
  const laidOutColumns =
    headerGroups[headerGroups.length - 1]?.headers.map((header) => header.column) ?? [];
  const channel = laborChannelEdges(laidOutColumns.map((column) => column.id));

  if (!proposal || !phases || !wbs || !totals) return <WBSSkeleton />;

  const wbsLabel = formatWbsLabel(wbs.wbsPoolId, wbs.name);
  const isCustomized = Object.keys(overrides).length > 0;

  return (
    <div className="flex h-full">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* ── Toolbar ── */}
        <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-3">
          {/* Breadcrumb: 70000 · AG PIPING — the estimate's identity lives in
              the title bar's switcher directly above, so repeating #1744 here
              would say the same thing twice one line apart. */}
          <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <span className="font-medium text-foreground truncate" title={wbsLabel}>
              {wbsLabel}
            </span>
            <span className="ml-1 rounded bg-fill-secondary px-1.5 py-0.5 text-footnote font-medium tabular-nums text-muted-foreground">
              {phases.length}
            </span>
          </nav>

          {/* One right-aligned cluster: edit actions, then the column and panel
              controls outermost — the IDE convention. Edit affordances are
              withheld below "write". */}
          <div className="flex shrink-0 items-center gap-1">
            {canEdit && (
              <>
                {/* Outline, not primary — persistent chrome stays quiet; the
                    saturated blue is reserved for dialog confirms. */}
                <Button variant="outline" size="lg" onClick={() => setAddPhaseOpen(true)}>
                  <Plus className="h-3 w-3" /> Add Phase
                </Button>
                <div className="mx-1 h-4 w-px bg-border" />
              </>
            )}
            <ColumnMenu
              table={table}
              labelFor={(id) => PHASE_COLUMN_LABELS[id] ?? id}
              onReset={resetVisibility}
              isCustomized={isCustomized}
              // NAMED, not "this work breakdown". Six columns appear on the
              // piping sheets and on no others, so an estimator walking the
              // rail watches the report change shape — and the one place they
              // go to ask why should say which breakdown it is answering for.
              label={`Columns in ${wbsLabel}`}
            />
            <InspectorToggle
              grandTotal={summary?.totalCost}
              open={inspectorOpen}
              onToggle={toggleInspector}
            />
          </div>
        </div>

        {/* ── The report ──
            `isolate` gives the grid its own stacking context, so its four
            layers of sticky (header, footer, and the frozen columns of each)
            are ranked against EACH OTHER and never against the floating
            selection bar, which is a sibling of this box rather than a child
            of it. Without it the frozen grand total of the totals row won the
            overlap and painted straight over the bar. */}
        <div className="isolate flex-1 min-h-0 overflow-auto border-y">
          {/* Widths travel as CSS variables so cells never call getSize(). */}
          <table
            className="w-full table-fixed border-collapse text-xs"
            style={{ ...sizeVars, minWidth: table.getTotalSize() }}
          >
            {/* Above the totals row below it, which is in turn above the frozen
                columns of the rows scrolling under both. */}
            <thead className="sticky top-0 z-30">
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const meta = header.column.columnDef.meta as PhaseColumnMeta | undefined;
                    const pinned = header.column.getIsPinned();
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        className={cn(
                          "group relative h-8 overflow-hidden border-b bg-grid-header p-0",
                          "text-left text-footnote font-semibold uppercase tracking-wide text-muted-foreground"
                        )}
                        style={{
                          ...widthFor(header.column.id, `var(--header-${header.id}-size)`),
                          ...(pinned ? pinnedStyle(header.column, "header") : undefined),
                        }}
                      >
                        <div
                          className={cn(
                            "flex h-full w-full items-center px-2 whitespace-nowrap",
                            meta?.align === "right" && "justify-end",
                            meta?.align === "center" && "justify-center",
                            // The labor channel's tint lives on the header
                            // alone: the body carries zebra, hover and
                            // selection fills, and a fourth translucent layer
                            // there would only muddy all three.
                            isLaborColumn(header.column.id) && "bg-fill-tertiary"
                          )}
                          style={laborChannelStyle(header.column.id, channel)}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </div>
                        {header.column.getCanResize() && (
                          <span
                            // Double-click restores this column's default —
                            // the way out of a drag that went wrong.
                            onDoubleClick={() => header.column.resetSize()}
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={`Resize ${PHASE_COLUMN_LABELS[header.column.id] ?? header.column.id}`}
                            className={cn(
                              "absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize touch-none select-none",
                              "opacity-0 transition-opacity group-hover:opacity-100",
                              header.column.getIsResizing()
                                ? "bg-primary opacity-100"
                                : "bg-border-strong"
                            )}
                          />
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>

            <tbody>
              {table.getRowModel().rows.map((row, index) => (
                <tr
                  key={row.id}
                  className={cn(
                    // Estimate data renders in caps by CSS, never by
                    // transforming what is stored — the same rule the catalog
                    // grid follows, and it keeps the clipboard honest.
                    "group h-[30px] cursor-pointer uppercase",
                    // OPAQUE stripe, deliberately. Pinned cells are painted
                    // over the scrolling ones and inherit this colour, so a
                    // translucent fill token would let the columns underneath
                    // bleed through the frozen ones. Hover and selection tints
                    // live one layer in, on the cell's own content box.
                    index % 2 === 0 ? "bg-background" : "bg-background-subtle"
                  )}
                  onMouseEnter={() => queueWarm(() => warmPhase(row.original._id))}
                  onMouseLeave={cancelWarm}
                  onClick={(event) => {
                    // macOS ctrl+click IS a secondary click, and WKWebView
                    // dispatches contextmenu AND a button-0 click for it —
                    // preventDefault on the former does not suppress the
                    // latter. Without this the row navigates out from under
                    // the menu that just opened. Same guard as the proposal
                    // log, for the same platform reason.
                    if (event.ctrlKey) return;
                    void navigate({
                      to: "/estimate/$estimateId/phase/$phaseId",
                      params: { estimateId, phaseId: row.original._id },
                    });
                  }}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as PhaseColumnMeta | undefined;
                    const pinned = cell.column.getIsPinned();
                    return (
                      <td
                        key={cell.id}
                        className="overflow-hidden bg-inherit p-0"
                        style={{
                          ...widthFor(cell.column.id, `var(--col-${cell.column.id}-size)`),
                          ...(pinned ? pinnedStyle(cell.column, "cell") : undefined),
                        }}
                        // A checkbox, a completion ring and an editable
                        // quantity own their clicks; the rest of the row opens
                        // the phase.
                        onClick={meta?.interactive ? (event) => event.stopPropagation() : undefined}
                      >
                        {/* Consistent height for every cell type, and the layer
                            that carries the row's hover and selection tints. */}
                        <div
                          className={cn(
                            "flex h-[30px] items-center transition-colors",
                            meta?.selfPadded ? "px-0" : "px-2",
                            meta?.align === "right" && "justify-end",
                            meta?.align === "center" && "justify-center",
                            row.getIsSelected()
                              ? "bg-primary/10 group-hover:bg-primary/15"
                              : "group-hover:bg-fill-tertiary"
                          )}
                          // The bracket rides ABOVE those tints rather than
                          // under them — see laborChannelStyle.
                          style={laborChannelStyle(cell.column.id, channel)}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}

              {/* Ghost add row — the next action lives where the list ends
                  (the Notion/Linear pattern), not only up in the toolbar. */}
              {phases.length > 0 && canEdit && (
                <tr>
                  <td colSpan={laidOutColumns.length} className="border-b border-border/40 p-0">
                    <button
                      type="button"
                      onClick={() => setAddPhaseOpen(true)}
                      className="flex h-[30px] w-full items-center gap-1.5 px-3 text-xs text-muted-foreground/70 transition-colors hover:bg-fill-quaternary hover:text-foreground"
                    >
                      <Plus className="h-3 w-3" /> Add phase
                    </button>
                  </td>
                </tr>
              )}

              {phases.length === 0 && (
                <tr>
                  <td colSpan={laidOutColumns.length} className="h-40 text-center align-middle">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <p className="text-body">No phases in this work breakdown</p>
                      {canEdit && (
                        <Button variant="outline" size="lg" onClick={() => setAddPhaseOpen(true)}>
                          <Plus className="h-3 w-3" /> Add Phase
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>

            {/* ── The totals row ──
                Anchored to the bottom of the scroll box so the breakdown's
                answer is on screen while the estimator is anywhere in a
                2,000-phase list — which is the only way a totals row is worth
                the height it costs. */}
            {phases.length > 0 && (
              <tfoot>
                <tr className="h-[30px]">
                  {laidOutColumns.map((column) => {
                    const meta = column.columnDef.meta as PhaseColumnMeta | undefined;
                    const pinned = column.getIsPinned();
                    return (
                      <td
                        key={column.id}
                        className="overflow-hidden border-t bg-grid-header p-0"
                        style={{
                          ...widthFor(column.id, `var(--col-${column.id}-size)`),
                          ...(pinned ? pinnedStyle(column, "cell") : undefined),
                          // Sticky in BOTH axes for a pinned column: the grand
                          // total stays at the frozen right edge of the totals
                          // row exactly as it does in every row above it.
                          position: "sticky",
                          bottom: 0,
                          // ⚠️ ABOVE THE FROZEN COLUMNS OF THE ROWS SCROLLING
                          // UNDER IT (20, from pinnedStyle). Below that, the
                          // pinned PHASE column of every passing row was drawn
                          // straight over the breakdown's totals.
                          zIndex: pinned ? 26 : 22,
                        }}
                      >
                        <div
                          className={cn(
                            "flex h-[30px] items-center px-2",
                            meta?.align === "right" && "justify-end"
                          )}
                          // The labor bracket closes here rather than stopping
                          // a row short of the figure it is bracketing.
                          style={laborChannelStyle(column.id, channel)}
                        >
                          {phaseTotalsCell(column.id, totals)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Anchored to the column, NOT the scroll container — inside it the
            bar would scroll away with the rows. Duplicate takes exactly one
            phase, so it withdraws on a multi-selection rather than silently
            acting on the first. */}
        {canEdit && (
          <SelectionBar count={selectedIds.length} noun="phase" onClear={() => setRowSelection({})}>
            {selectedIds.length === 1 && (
              <Button
                variant="ghost"
                size="lg"
                onClick={() => {
                  const [id] = selectedIds;
                  if (!id) return;
                  const phase = phases.find((candidate) => candidate._id === id);
                  if (phase) void handleDuplicate(id, phase.phaseNumber);
                }}
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              onClick={() => void handleDeleteSelected()}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
          </SelectionBar>
        )}

        {canEdit && (
          <AddPhaseDialog
            open={addPhaseOpen}
            onOpenChange={setAddPhaseOpen}
            wbsId={typedWbsId}
            bookId={proposal.bookId}
          />
        )}
      </div>

      <TotalsInspector
        scopeLabel={wbsLabel}
        scopeCosts={totals}
        summary={summary}
        open={inspectorOpen}
      />
    </div>
  );
}

/** Whether this column belongs to the labor channel — the header's tint band. */
function isLaborColumn(columnId: string): boolean {
  return (LABOR_CHANNEL as ReadonlySet<string>).has(columnId);
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/**
 * The skeleton reproduces the real geometry so the first paint does not reflow
 * when data lands.
 *
 * ⚠️ THE WIDTHS ARE DERIVED, NOT TRANSCRIBED — reading the column defs means a
 * size change can only ever be made in one place. The piping columns are
 * included: a hand-copied set would be wrong on three breakdowns out of
 * eighteen and nobody would notice which three.
 */
function WBSSkeleton() {
  const widths = buildPhaseColumns(true, {
    current: {
      estimateId: "",
      canEdit: false,
      onToggleCompleted: () => {},
      onCommitField: () => {},
      onKeyDown: () => {},
    },
  }).map((column) => column.size ?? 80);

  return (
    // ⚠️ IT HAS TO BREATHE. A grid of motionless grey bars is indistinguishable
    // from a report that loaded and came back blank, which is the reading that
    // makes somebody reach for the reload. The pulse is the only thing saying
    // "still coming", so it goes on the whole placeholder rather than on a
    // dozen elements that would then drift out of phase with each other.
    <div
      className="flex h-full animate-pulse flex-col"
      aria-busy="true"
      aria-label="Loading phases"
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <div className="h-4 w-48 rounded bg-fill-quaternary" />
        <div className="h-7 w-24 rounded bg-fill-quaternary" />
      </div>
      {/* Clipped rather than scrolled: the bars keep their real widths, so the
          placeholder runs off the right edge exactly as the report does. */}
      <div className="min-h-0 flex-1 overflow-hidden border-y">
        <div className="h-8 border-b bg-grid-header" />
        {Array.from({ length: 14 }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className={cn(
              "flex h-[30px] items-center gap-2 px-2",
              rowIndex % 2 !== 0 && "bg-background-subtle"
            )}
          >
            {widths.map((width, columnIndex) => (
              <div
                key={columnIndex}
                className="h-2.5 shrink-0 rounded bg-fill-quaternary"
                style={{ width: Math.round(width * 0.6) }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="h-[30px] shrink-0 border-t bg-grid-header" />
    </div>
  );
}
