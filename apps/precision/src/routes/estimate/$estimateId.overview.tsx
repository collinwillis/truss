import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Column,
  type ColumnSizingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { ProposalStatusChip } from "@truss/features/estimation/proposal-status";
import { SyncOriginNotice } from "@truss/features/estimation/sync-origin";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";
import { useConvex } from "convex/react";
import { ChevronDown, ChevronRight, Copy, Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DuplicateEstimateDialog } from "../../components/duplicate-estimate-dialog";
import { cellWidth, columnSizeVars, pinnedStyle } from "../../components/grid-geometry";
import {
  buildWbsReportColumns,
  carriesWork,
  ESTIMATOR_ENTERED_COLUMN_IDS,
  type WbsReportColumnMeta,
  type WbsReportContext,
  type WbsReportRow,
} from "../../components/wbs-report/columns";
import {
  loadShowEmpty,
  loadSizing,
  saveShowEmpty,
  saveSizing,
} from "../../components/wbs-report/preferences";
import {
  InspectorToggle,
  TotalsInspector,
  useTotalsInspector,
} from "../../components/totals-inspector";
import { formatWbsLabel } from "../../config/shell-config-estimate";
import { canEditPrecision } from "../../lib/permissions";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../../lib/use-stable-query";

export const Route = createFileRoute("/estimate/$estimateId/overview")({
  component: EstimateOverviewPage,
});

/**
 * Row height, matched to the two sheets below this one so all three read as one
 * table. They are 30px; this said 28 and nothing had caught it, which is exactly
 * how three tables come to be "decent, but inconsistent".
 */
const ROW_HEIGHT = 30;

/**
 * A column's heading, in words — what a screen reader is told the drag handle
 * resizes.
 *
 * READ OFF THE HEADER rather than from a second table of labels, which is what
 * the two sheets below this one need only because their headings are elements.
 * Every heading here is a plain string, so a parallel map would be a copy with
 * nothing keeping it honest.
 */
function columnLabel(column: Column<WbsReportRow>): string {
  const heading = column.columnDef.header;
  return typeof heading === "string" ? heading : column.id;
}

/**
 * The estimate's cost report.
 *
 * WHAT THIS REPLACES. The overview used to be a dashboard: four tiles and a bar
 * chart of one dollar figure per work breakdown, most of them a dash. What
 * InDemand actually reads is the PROPOSAL HOME sheet of their WBS Cost Report —
 * twelve columns, one row per breakdown, totalled at the foot — and they said
 * as much. So this screen IS that sheet, with the things a spreadsheet cannot
 * do: it ties to the live grand total, it folds away the breakdowns nobody
 * touched, and every row is a way into the work behind it.
 *
 * ⚠️ WBS ORDER COMES FROM THE WBS CODE, NEVER FROM `sortOrder`. The server
 * already orders by code (see `byWBSCode`); the client re-sorts as defence in
 * depth, because Convex does not guarantee a query's ordering survives
 * serialization — Momentum lost its WBS order exactly that way.
 *
 * ⚠️ THE ESTIMATE IS NOT NAMED HERE. The shell's top bar carries
 * `#1744 AG PIPING` on every screen inside an estimate, one line above this
 * one; the WBS drill-down already refuses the same duplication for the same
 * reason. What this band adds is what the title bar does NOT say — the bid's
 * status and where its data comes from.
 *
 * The drill-down (one row per phase) and the phase detail (one row per activity)
 * are the other two sheets of the same report, and they already exist as
 * screens; this is the level above them.
 *
 * ⚠️ THE TOTALS PANEL IS THE SAME PANEL THOSE TWO CARRY. This screen used to
 * answer with a horizontal strip of four figures while its own drill-downs
 * answered with a right inspector — the same information in two shapes, one
 * drill-down apart. The panel has the room the strip did not, so it says what
 * the strip could not: the labor/material/equipment/sub/cost-only split, and
 * the direct/indirect hours `getProposalSummary` has always returned.
 */
function EstimateOverviewPage() {
  const { estimateId } = Route.useParams();
  const proposalId = estimateId as Id<"proposals">;
  const convex = useConvex();
  const navigate = useNavigate();
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);

  const proposal = useStableQuery(api.precision.getProposal, { proposalId });
  const wbsItems = useStableQuery(api.precision.getWBSListWithCosts, { proposalId });
  const summary = useStableQuery(api.precision.getProposalSummary, { proposalId });
  const [inspectorOpen, toggleInspector] = useTotalsInspector();

  const [duplicateOpen, setDuplicateOpen] = useState(false);

  // ── What is on screen ──
  //
  // Hidden breakdowns are NOT filtered out here, unlike the screen this
  // replaces. Hiding is navigation state that "must never move a bid", so a
  // hidden breakdown carrying cost has to appear or the TOTALS row would stop
  // tying to the grand total. It is marked instead. Hidden AND untouched falls
  // into the folded set below like any other empty row.
  /**
   * Hidden breakdowns are HIDDEN, which is what `setWBSHidden` says it does —
   * its own contract names "the rail, redirect, phase sequence and overview
   * bars" as the places hiding applies.
   *
   * Safe for the totals, and checked rather than assumed: of 39 hidden WBS
   * records live today, not one carries a single activity. The guard below
   * keeps that true — a hidden breakdown that somehow holds cost is surfaced
   * rather than silently dropped, because the TOTALS row tying to the grand
   * total matters more than the preference.
   */
  const allRows = useMemo<WbsReportRow[]>(
    () => (wbsItems ? [...wbsItems].sort((a, b) => a.wbsPoolId - b.wbsPoolId) : []),
    [wbsItems]
  );
  /** Hidden and carrying nothing: gone. Hidden and carrying cost: shown, marked. */
  const visibleRows = useMemo(
    () => allRows.filter((row) => !row.isHidden || carriesWork(row)),
    [allRows]
  );
  const hiddenWithWork = useMemo(
    () => allRows.filter((row) => row.isHidden && carriesWork(row)).length,
    [allRows]
  );
  const working = useMemo(() => visibleRows.filter(carriesWork), [visibleRows]);
  const emptyCount = visibleRows.length - working.length;

  const [showEmpty, setShowEmpty] = useState(false);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setColumnSizing(loadSizing());
    setShowEmpty(loadShowEmpty());
    setHydrated(true);
    // Deliberately once: re-reading storage when the data changes would undo a
    // width the estimator just dragged.
  }, []);

  // Guarded on `hydrated` so the first render — which still holds the initial
  // empty state — cannot write over what was read a tick later.
  useEffect(() => {
    if (hydrated) saveSizing(columnSizing);
  }, [columnSizing, hydrated]);
  useEffect(() => {
    if (hydrated) saveShowEmpty(showEmpty);
  }, [showEmpty, hydrated]);

  const rows = showEmpty ? visibleRows : working;

  /**
   * QTY and UNIT appear once any breakdown has a takeoff.
   *
   * They are derived now — rolled up from the phases beneath, the same way a
   * phase derives its own — so the old reason for withholding them (nothing in
   * Precision ever wrote `wbs.customQuantity`, and not one of 12,000 live
   * records carried one) no longer applies. A breakdown whose phases have no
   * takeoff at all still shows nothing, which is why this stays conditional.
   */
  const estimatorEnteredPresent = useMemo(
    () => allRows.some((row) => row.takeoff !== null),
    [allRows]
  );
  const columnVisibility = useMemo<VisibilityState>(
    () =>
      Object.fromEntries(
        ESTIMATOR_ENTERED_COLUMN_IDS.map((id) => [id, estimatorEnteredPresent])
      ) satisfies VisibilityState,
    [estimatorEnteredPresent]
  );

  // Volatile values travel by ref so the columns array can be built once — see
  // buildWbsReportColumns. Refreshed every render, read at cell-render time.
  const maxRowTotal = useMemo(
    () => allRows.reduce((largest, row) => Math.max(largest, row.costs.totalCost), 0),
    [allRows]
  );
  const columnCtx = useRef<WbsReportContext>({ estimateId, maxRowTotal: 0, grandTotal: 0 });
  columnCtx.current = { estimateId, maxRowTotal, grandTotal: summary?.totalCost ?? 0 };
  const columns = useMemo(() => buildWbsReportColumns(columnCtx), []);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row._id,
    columnResizeMode: "onChange",
    onColumnSizingChange: setColumnSizing,
    enableColumnResizing: true,
    // The same floor the two sheets below this one hold. Without it TanStack's
    // default (20px) let a drag collapse a column to a sliver with nothing but
    // a double-click to find its way back.
    defaultColumn: { minSize: 44, maxSize: 600 },
    // The identity and the number everybody quotes stay put while the ten
    // columns between them scroll.
    initialState: { columnPinning: { left: ["wbs"], right: ["totalCost"] } },
    state: { columnSizing, columnVisibility },
  });

  const wbsIsSized = columnSizing.wbs !== undefined;
  const widthFor = (columnId: string, sizeVar: string): React.CSSProperties =>
    cellWidth(columnId, sizeVar, {
      flexColumnId: "wbs",
      flexMinWidth: 200,
      isFlexColumnSized: wbsIsSized,
    });
  const sizeVars = columnSizeVars(table);

  // Delegated to the estimate layout route, which owns the single export
  // implementation shared with the ⌘K entry and ⌘⇧E.
  const handleExport = useCallback(() => {
    document.dispatchEvent(new CustomEvent("export-estimate"));
  }, []);

  if (!proposal || !wbsItems || !summary) return <OverviewSkeleton />;

  const bodyRows = table.getRowModel().rows;
  /**
   * The columns IN THE ORDER THEY ARE DRAWN.
   *
   * ⚠️ NOT `getVisibleLeafColumns()`, which reports DECLARATION order. Pinning
   * moves columns to the frozen edges and the body renders
   * `row.getVisibleCells()` — left, then centre, then right — so the foot has to
   * read the same list the header does, or a future pin would leave the figure
   * at the bottom of a column standing under a different column's heading. That
   * is the one defect a cost report cannot survive, and the WBS HOME sheet
   * already guards against it.
   */
  const headerGroups = table.getHeaderGroups();
  const footerColumns =
    headerGroups[headerGroups.length - 1]?.headers.map((header) => header.column) ?? [];
  const priced = summary.activityCount > 0;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Band A: facts about the bid the title bar does not carry ──
            The height of the toolbar on the two sheets below this one, so the
            top edge of the report does not jump 4px on the way down. `min-h`
            rather than `h`, because the sync notice can wrap where a breadcrumb
            cannot. */}
        <div className="flex min-h-10 shrink-0 items-center gap-2.5 border-b px-3 py-1.5">
          {/* The screen still needs a heading; the visible one would be the third
            copy of the same words on the same window. */}
          <h1 className="sr-only">
            Cost report — #{proposal.proposalNumber} {proposal.description}
          </h1>
          <ProposalStatusChip status={proposal.status} className="shrink-0" />
          <SyncOriginNotice
            precisionOwnedAt={proposal.precisionOwnedAt ?? null}
            className="min-w-0"
          />
          <div className="flex-1" />
          <div className="flex shrink-0 items-center gap-1.5">
            {canEdit && (
              <Button variant="ghost" size="lg" onClick={() => setDuplicateOpen(true)}>
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
            )}
            <Button variant="ghost" size="lg" onClick={handleExport}>
              <Download className="h-3 w-3" /> Export
            </Button>
            {/* Outermost, as on the two sheets below this one — the IDE
              convention, and the grand total stays on screen with the panel
              closed. */}
            <InspectorToggle
              grandTotal={summary.totalCost}
              open={inspectorOpen}
              onToggle={toggleInspector}
            />
          </div>
        </div>

        {!priced ? (
          <NothingPricedYet
            estimateId={estimateId}
            rows={allRows}
            phaseCount={summary.phaseCount}
          />
        ) : (
          <>
            {/* ── The report ──
                `isolate` gives the grid its own stacking context so its four
                sticky layers — the header, the foot, and the frozen columns of
                each — are ranked against EACH OTHER and never against the page
                around them. The WBS HOME sheet carries the same guard. */}
            <div className="isolate min-h-0 flex-1 overflow-auto">
              <table
                className="w-full table-fixed border-collapse text-xs"
                style={{ ...sizeVars, minWidth: table.getTotalSize() }}
              >
                <caption className="sr-only">
                  Cost by work breakdown, in WBS code order, totalled at the foot.
                </caption>
                {/* ⚠️ ABOVE THE FROZEN COLUMNS OF THE ROWS SCROLLING UNDER IT.
                    A sticky element with a z-index makes its own stacking
                    context, so at z-10 the whole header sat BELOW the pinned
                    cells of every passing row (z-20, from pinnedStyle) and the
                    WBS column painted straight over the headings. Same rank as
                    the two sheets below this one. */}
                <thead className="sticky top-0 z-30">
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => {
                        const meta = header.column.columnDef.meta as
                          | WbsReportColumnMeta
                          | undefined;
                        return (
                          <th
                            key={header.id}
                            scope="col"
                            className="group relative h-8 overflow-hidden border-b bg-grid-header p-0 text-left text-footnote font-semibold uppercase tracking-wide text-muted-foreground"
                            style={{
                              ...widthFor(header.column.id, `var(--header-${header.id}-size)`),
                              ...pinnedStyle(header.column, "header"),
                            }}
                          >
                            <div
                              className={cn(
                                "flex h-full w-full items-center whitespace-nowrap px-2",
                                meta?.align === "right" && "justify-end",
                                // The hours channel is marked HERE AND NOWHERE
                                // ELSE, exactly as the WBS HOME sheet marks its
                                // labor channel: the body already carries zebra
                                // stripes and a hover fill, and a third
                                // translucent layer over those only muddies all
                                // three. The figures themselves stay apart by
                                // their trailing decimal and their contrast.
                                meta?.kind === "hours" && "bg-fill-quaternary"
                              )}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
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
                                aria-label={`Resize ${columnLabel(header.column)}`}
                                className={cn(
                                  "absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize touch-none select-none",
                                  "bg-border-strong opacity-0 transition-opacity group-hover:opacity-100",
                                  header.column.getIsResizing() && "bg-primary opacity-100"
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
                  {bodyRows.map((row, index) => (
                    <tr
                      key={row.id}
                      className={cn(
                        "group cursor-pointer",
                        index % 2 === 0 ? "bg-background" : "bg-background-subtle",
                        // A folded-open empty row recedes: it is context for the
                        // rows that carry work, not competition with them.
                        !carriesWork(row.original) && "text-foreground-subtle"
                      )}
                      style={{ height: ROW_HEIGHT }}
                      onMouseEnter={() =>
                        queueWarm(
                          () =>
                            void warmQuery(convex, api.precision.getPhaseListWithCosts, {
                              wbsId: row.original._id,
                            })
                        )
                      }
                      onMouseLeave={cancelWarm}
                      onClick={(event) => {
                        // macOS ctrl+click IS a secondary click, and WKWebView
                        // dispatches a button-0 click for it alongside the
                        // context menu — without this the row navigates out from
                        // under the menu the webview just popped. The proposal
                        // log carries the same guard.
                        if (event.ctrlKey) return;
                        void navigate({
                          to: "/estimate/$estimateId/wbs/$wbsId",
                          params: { estimateId, wbsId: row.original._id },
                        });
                      }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta as WbsReportColumnMeta | undefined;
                        return (
                          <td
                            key={cell.id}
                            // `bg-inherit` picks up the zebra stripe and the
                            // hover fill without restating either — and pinned
                            // cells, painted over scrolling content, must stay
                            // opaque. The hours channel is marked on the header
                            // alone; see the comment there.
                            className="overflow-hidden bg-inherit p-0"
                            style={{
                              ...widthFor(cell.column.id, `var(--col-${cell.column.id}-size)`),
                              ...pinnedStyle(cell.column, "cell"),
                            }}
                          >
                            <div
                              className={cn(
                                "flex items-center px-2 transition-colors group-hover:bg-fill-tertiary",
                                meta?.align === "right" && "justify-end"
                              )}
                              style={{ height: ROW_HEIGHT }}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>

                {/* ── TOTALS ──
                  Read from `getProposalSummary`, not summed from the rows
                  above: the grand total is one number, computed once on the
                  server, and two hand-written accumulations would eventually
                  disagree by a dollar. The rows tie to it because every
                  breakdown carrying cost is on screen — hidden ones included —
                  and a folded row contributes zero by definition.

                  Each cell comes from its own column's `meta.total`, so a
                  column cannot be renamed out of the foot. */}
                <tfoot>
                  <tr>
                    {footerColumns.map((column) => {
                      const meta = column.columnDef.meta as WbsReportColumnMeta | undefined;
                      const isPinned = column.getIsPinned();
                      return (
                        <td
                          key={column.id}
                          className="overflow-hidden border-t bg-grid-header p-0 font-medium"
                          style={{
                            ...widthFor(column.id, `var(--col-${column.id}-size)`),
                            ...pinnedStyle(column, "cell"),
                            // Sticky on two axes at once: the totals stay at the
                            // foot while the rows scroll, and the pinned columns
                            // stay at the edges while the columns scroll.
                            position: "sticky",
                            bottom: 0,
                            // ⚠️ ABOVE THE FROZEN COLUMNS OF THE ROWS SCROLLING
                            // UNDER IT (20, from pinnedStyle) AND BELOW THE
                            // HEADER (30). The same three ranks the WBS HOME
                            // sheet uses, so the two feet stack identically.
                            zIndex: isPinned ? 26 : 22,
                          }}
                        >
                          <div
                            className={cn(
                              "flex items-center px-2",
                              meta?.align === "right" && "justify-end"
                            )}
                            style={{ height: ROW_HEIGHT }}
                          >
                            {meta?.total?.(summary)}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* ── The breakdowns nobody touched ──
              Folded by default and counted honestly. Every live estimate
              carries 18 breakdowns and the median puts work in 5 of them, so
              left expanded this list is thirteen rows of em-dashes pushing the
              real numbers off the screen. It is a FOLD, NOT A FILTER: the
              denominator is always on screen, the choice is remembered, and one
              click brings the rest back — an estimator must never have to
              wonder whether a breakdown is missing or merely empty. */}
            <div className="flex h-8 shrink-0 items-center gap-3 border-t px-3">
              <span className="shrink-0 text-footnote tabular-nums text-muted-foreground">
                {working.length} of {allRows.length}{" "}
                {allRows.length === 1 ? "breakdown carries" : "breakdowns carry"} work
              </span>
              {!estimatorEnteredPresent && (
                // Named rather than silently absent: these are the client's own
                // columns, and a spreadsheet reader who cannot find them should
                // learn why here rather than conclude the report is incomplete.
                <span className="min-w-0 truncate text-footnote text-foreground-subtle">
                  Qty and Unit appear once a breakdown carries one
                </span>
              )}
              {/* The guard behind hiding hidden breakdowns. Of 39 hidden WBS
                records live today not one carries an activity, so this should
                never render — but if hiding ever DID conceal cost, the totals
                row would stop tying to the grand total, and that must be said
                out loud rather than discovered. */}
              {hiddenWithWork > 0 && (
                <span className="min-w-0 truncate text-footnote text-amber-600 dark:text-amber-400">
                  {hiddenWithWork} hidden{" "}
                  {hiddenWithWork === 1 ? "breakdown carries" : "breakdowns carry"} work and{" "}
                  {hiddenWithWork === 1 ? "is" : "are"} still counted below
                </span>
              )}
              <div className="flex-1" />
              {emptyCount > 0 && (
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => setShowEmpty((current) => !current)}
                  aria-expanded={showEmpty}
                >
                  {showEmpty ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  {showEmpty ? "Hide" : "Show"} {emptyCount} empty
                </Button>
              )}
            </div>
          </>
        )}

        {canEdit && (
          <DuplicateEstimateDialog
            open={duplicateOpen}
            onOpenChange={setDuplicateOpen}
            sourceProposalId={proposalId}
            sourceProposalNumber={proposal.proposalNumber}
            sourceDescription={proposal.description}
          />
        )}
      </div>

      {/* THE SCOPE IS THE ESTIMATE, so the panel is headed the way the foot of
          the table below is headed — the same words for the same number, which
          is what makes the two visibly one figure rather than coincidentally
          equal ones. Naming the bid here instead would be its third appearance
          on one window. */}
      <TotalsInspector
        scopeLabel="Grand total"
        scopeCosts={summary}
        summary={summary}
        open={inspectorOpen}
        scopeIsEstimate
      />
    </div>
  );
}

/**
 * An estimate with no priced work at all.
 *
 * 121 of the 736 live estimates are in exactly this state, so this is not an
 * edge case — it is one visit in six. An empty grid would say nothing; this
 * says what the estimate DOES have, why there is no cost to report, and offers
 * the one place the next move happens.
 */
function NothingPricedYet({
  estimateId,
  rows,
  phaseCount,
}: {
  estimateId: string;
  rows: WbsReportRow[];
  phaseCount: number;
}): React.ReactElement {
  const withPhases = rows.filter((row) => row.phaseCount > 0);
  // Land where the work already is, and only fall back to the top of the list
  // when there is no work anywhere.
  const firstStop = withPhases[0] ?? rows[0] ?? null;

  let title: string;
  let body: string;
  if (rows.length === 0) {
    title = "This estimate has no work breakdown yet";
    body =
      "There is nowhere to put a cost, so there is nothing to report. A work breakdown comes from Setup.";
  } else if (phaseCount === 0) {
    title = "Nothing has been priced yet";
    body = `${rows.length} work breakdowns are set up and not one of them holds a phase, so every column of this report would read zero. Work starts by adding a phase to a breakdown.`;
  } else {
    title = "Nothing has been priced yet";
    body = `${phaseCount} ${phaseCount === 1 ? "phase" : "phases"} across ${withPhases.length} ${
      withPhases.length === 1 ? "breakdown" : "breakdowns"
    }, and not one activity between them — so there is no cost to report. Priced lines are added inside a phase.`;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-body font-medium text-foreground">{title}</p>
      <p className="max-w-[46ch] text-pretty text-callout text-muted-foreground">{body}</p>
      {firstStop === null ? (
        <Button variant="outline" size="lg" asChild>
          <Link to="/estimate/$estimateId/setup" params={{ estimateId }}>
            Open Setup
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="lg" asChild>
          <Link to="/estimate/$estimateId/wbs/$wbsId" params={{ estimateId, wbsId: firstStop._id }}>
            {/* Only the breakdown's own label is drawn in caps — the verb is
                not estimate data and reads as shouting when it is. */}
            Open{" "}
            <span className="uppercase">{formatWbsLabel(firstStop.wbsPoolId, firstStop.name)}</span>
          </Link>
        </Button>
      )}
    </div>
  );
}

/**
 * The skeleton reproduces the real geometry so the first paint does not reflow
 * when the data lands.
 *
 * ⚠️ THE WIDTHS ARE DERIVED, NOT TRANSCRIBED — the proposal log learned this
 * the hard way: hand-copied numbers went stale within a day, and a skeleton
 * that disagrees with its table is worse than none, because it promises a
 * layout the data then rearranges.
 */
function OverviewSkeleton(): React.ReactElement {
  const widths = buildWbsReportColumns({
    current: { estimateId: "", maxRowTotal: 0, grandTotal: 0 },
  })
    // The two estimator-entered columns are withheld until a row carries one,
    // and no row does today — so the skeleton must not promise them either.
    .filter(
      (column) =>
        !ESTIMATOR_ENTERED_COLUMN_IDS.some((id) => id === (column.id as string | undefined))
    )
    .map((column) => column.size ?? 92);

  return (
    // ⚠️ IT HAS TO BREATHE. A grid of motionless grey bars is indistinguishable
    // from a report that loaded and came back blank, which is the reading that
    // makes somebody reach for the reload. The pulse is the only thing saying
    // "still coming", so it goes on the whole placeholder rather than on a dozen
    // elements that would then drift out of phase with each other. Same device,
    // same words, as the WBS HOME sheet's skeleton.
    <div
      className="flex h-full animate-pulse flex-col"
      aria-busy="true"
      aria-label="Loading the cost report"
    >
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b px-3">
        <div className="h-3.5 w-16 rounded bg-fill-quaternary" />
        <div className="h-2.5 w-80 rounded bg-fill-quaternary" />
        <div className="flex-1" />
        <div className="h-5 w-56 rounded bg-fill-quaternary" />
      </div>
      {/* Clipped rather than scrolled: the bars keep their real widths, so the
          placeholder runs off the right edge exactly as the report does. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="h-8 border-b bg-grid-header" />
        {Array.from({ length: 6 }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className={cn(
              "flex items-center gap-2 px-2",
              rowIndex % 2 !== 0 && "bg-background-subtle"
            )}
            style={{ height: ROW_HEIGHT }}
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
      {/* The totals row, then the fold bar that counts the breakdowns carrying
          work — both are chrome the report always has, so the placeholder shows
          them rather than letting them arrive as a layout shift. */}
      <div className="h-[30px] shrink-0 border-t bg-grid-header" />
      <div className="h-8 shrink-0 border-t" />
    </div>
  );
}
