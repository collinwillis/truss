import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../lib/use-stable-query";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnSizingState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { Plus, Search, Download, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { proposalStatusBarClasses } from "@truss/features/estimation/proposal-status";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { CreateEstimateDialog } from "../components/create-estimate-dialog";
import { CreateRevisionDialog } from "../components/create-revision-dialog";
import { canEditPrecision } from "../lib/permissions";
import { ColumnMenu } from "../components/activity-grid/column-menu";
import { cellWidth, columnSizeVars, pinnedStyle } from "../components/grid-geometry";
import {
  buildLogColumns,
  bidTypeLabel,
  dueTier,
  LOG_COLUMN_LABELS,
  type ProposalRow,
} from "../components/estimates-grid/columns";
import {
  autoVisibility,
  DEFAULT_VISIBILITY,
  loadOverrides,
  loadSizing,
  mergeVisibility,
  pruneOverrides,
  saveOverrides,
  saveSizing,
} from "../components/estimates-grid/visibility";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { toast } from "sonner";

/**
 * What you are LOOKING AT lives in the URL; how you like to look at it
 * (sort, widths, columns) lives in localStorage. That split is what lets the
 * sidebar's saved views be plain links, and what makes the back button
 * unwind a filter instead of leaving the screen.
 *
 * The search text is deliberately NOT here: syncing it per keystroke would
 * push one history entry per character.
 */
export interface EstimatesSearch {
  status?: string;
  due?: "overdue" | "dormant";
}

export const Route = createFileRoute("/estimates")({
  validateSearch: (search: Record<string, unknown>): EstimatesSearch => ({
    status: typeof search.status === "string" ? search.status : undefined,
    due: search.due === "overdue" || search.due === "dormant" ? search.due : undefined,
  }),
  component: EstimatesPage,
});

/** Status order for the rail: by real population, biggest first. */
const STATUS_ORDER = [
  "bidding",
  "submitted",
  "awarded",
  "rejected",
  "closed",
  "declined",
  "open",
] as const;

/**
 * The proposal log.
 *
 * This is InDemand's home screen and the direct replacement for the
 * "Proposal Log.xlsx" they have run the business from for years — same
 * columns, same vocabulary, same primary key, with sorting and filtering
 * their spreadsheet cannot do. The design brief was to beat the spreadsheet
 * at its own game rather than reinterpret it as a dashboard.
 */
function EstimatesPage() {
  const navigate = useNavigate();
  const convex = useConvex();
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);

  /**
   * Warm an estimate's whole opening path: the shell queries, then — chained,
   * since the redirect target isn't known until the WBS list arrives — the
   * first VISIBLE WBS's phase table, which is where opening lands.
   */
  const warmEstimate = useCallback(
    (id: string) => {
      const proposalId = id as Id<"proposals">;
      void warmQuery(convex, api.precision.getProposal, { proposalId });
      void warmQuery(convex, api.precision.getProposalSummary, { proposalId });
      void warmQuery(convex, api.precision.getWBSForProposal, { proposalId }).then((wbsList) => {
        const first = wbsList?.find((w) => !w.isHidden);
        if (first)
          void warmQuery(convex, api.precision.getPhaseListWithCosts, { wbsId: first._id });
      });
    },
    [convex]
  );
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();

  const { status: statusParam, due: dueParam } = Route.useSearch();
  const statusFilter = statusParam ?? null;
  const dueFilter = dueParam ?? null;

  /** Filter changes REPLACE rather than push — the back button should leave
   *  the screen, not walk back through every chip you tried. */
  const setStatusFilter = useCallback(
    (next: string | null) => {
      void navigate({
        to: "/estimates",
        search: (prev: EstimatesSearch) => ({ ...prev, status: next ?? undefined }),
        replace: true,
      });
    },
    [navigate]
  );
  const setDueFilter = useCallback(
    (next: "overdue" | "dormant" | null) => {
      void navigate({
        to: "/estimates",
        search: (prev: EstimatesSearch) => ({ ...prev, due: next ?? undefined }),
        replace: true,
      });
    },
    [navigate]
  );

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<Set<string>>(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [revisionSource, setRevisionSource] = useState<ProposalRow | null>(null);

  // The ⌘K "New Estimate" palette entry is hidden below "write", but the
  // listener guard also covers a stale event from a shell rendered before the
  // workspace settled.
  useEffect(() => {
    if (!canEdit) {
      setCreateOpen(false);
      return;
    }
    const h = () => setCreateOpen(true);
    document.addEventListener("open-create-estimate", h);
    return () => document.removeEventListener("open-create-estimate", h);
  }, [canEdit]);

  const proposals = useStableQuery(api.precision.listProposals);
  const rows: ProposalRow[] = useMemo(() => proposals ?? [], [proposals]);

  /**
   * One clock for the whole screen, held in state and ticked on a timer.
   *
   * It cannot be read inline during render: `now` feeds the column
   * definitions, and TanStack's flexRender treats a column's `cell` function
   * as a React COMPONENT TYPE — a value that changed every render would
   * rebuild the columns array continuously and remount every cell. Nor can it
   * be a mount-time constant: a log left open overnight would keep tiering
   * due dates against yesterday. A minute's granularity is far finer than the
   * day boundary that actually matters.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Filtering ──
  //
  // Search is token-AND across every field a person might remember, so
  // "tank dayton" finds the Dayton tank job. Every field is null-guarded:
  // 108 proposals have a blank client, and the screen this replaces called
  // `.toLowerCase()` on it unguarded.
  const matchesSearch = useCallback((row: ProposalRow, query: string): boolean => {
    if (!query) return true;
    const haystack = [
      row.proposalNumber,
      row.description,
      row.ownerName,
      row.location ?? "",
      row.jobNumber ?? "",
      row.estimators.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => haystack.includes(token));
  }, []);

  /**
   * Search only — the base each facet counts from.
   *
   * Every facet must be counted over a set that EXCLUDES its own filter,
   * otherwise selecting it collapses its own alternatives: picking Overdue
   * would make Dormant read 0 while the sidebar simultaneously reported 310.
   */
  const preFacet = useMemo(
    () => rows.filter((r) => matchesSearch(r, search)),
    [rows, search, matchesSearch]
  );

  /** Search + due — what the Type menu counts over. */
  const preType = useMemo(
    () => (dueFilter ? preFacet.filter((r) => dueTier(r, now) === dueFilter) : preFacet),
    [preFacet, dueFilter, now]
  );

  /** Everything except the status filter — what the status rail counts over. */
  const preStatus = useMemo(
    () => preType.filter((r) => typeFilter.size === 0 || typeFilter.has(r.bidType ?? "(none)")),
    [preType, typeFilter]
  );

  const filtered = useMemo(
    () => (statusFilter ? preStatus.filter((r) => (r.status ?? "") === statusFilter) : preStatus),
    [preStatus, statusFilter]
  );

  /**
   * Counts are faceted over everything EXCEPT the status filter.
   *
   * Otherwise selecting "Awarded" zeroes the other six chips and pins hit
   * rate at 100% — the rail would stop being a way to move between statuses
   * and become a description of the one you already chose.
   */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of preStatus) {
      const s = r.status ?? "";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [preStatus]);

  const metrics = useMemo(() => {
    let overdue = 0;
    let dormant = 0;
    let awarded = 0;
    let rejected = 0;
    // Counted over the due-filter-free set, so Overdue and Dormant always
    // offer each other as a way out.
    for (const r of preFacet.filter(
      (r) => typeFilter.size === 0 || typeFilter.has(r.bidType ?? "(none)")
    )) {
      const tier = dueTier(r, now);
      if (tier === "overdue") overdue += 1;
      if (tier === "dormant") dormant += 1;
      if (r.status === "awarded") awarded += 1;
      if (r.status === "rejected") rejected += 1;
    }
    const decided = awarded + rejected;
    return {
      overdue,
      dormant,
      awarded,
      rejected,
      // Declined and Closed are excluded deliberately: neither is a decision
      // on our price, so counting them would understate the real hit rate.
      hitRate: decided > 0 ? Math.round((awarded / decided) * 100) : null,
    };
  }, [preFacet, typeFilter, now]);

  /** Counted over search + due, excluding the type filter itself. */
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of preType) {
      const key = r.bidType ?? "(none)";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [preType]);

  // ── Table ──
  const [sorting, setSorting] = useState<SortingState>([{ id: "number", desc: true }]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setColumnSizing(loadSizing());
    setColumnVisibility(
      mergeVisibility({ ...DEFAULT_VISIBILITY, ...autoVisibility(rows) }, loadOverrides())
    );
    setHydrated(true);
    // Deliberately once: re-reading storage on every data change would undo
    // a toggle the estimator just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The model the stored overrides are measured against. */
  const autoModel = useMemo(() => ({ ...DEFAULT_VISIBILITY, ...autoVisibility(rows) }), [rows]);

  // Amount is hidden only because nothing feeds it yet; the moment any row
  // carries one it appears, unless the estimator has said otherwise.
  useEffect(() => {
    if (!hydrated) return;
    setColumnVisibility((current) =>
      mergeVisibility(autoModel, pruneOverrides(autoModel, current as Record<string, boolean>))
    );
  }, [autoModel, hydrated]);

  // Volatile values travel by ref so the columns array can be built once —
  // see buildLogColumns. Refreshed every render, read at cell-render time.
  const columnCtx = useRef({ now, query: search });
  columnCtx.current = { now, query: search };
  const columns = useMemo(() => buildLogColumns(columnCtx), []);

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row._id,
    columnResizeMode: "onChange",
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    initialState: {
      columnPinning: { left: ["number", "description"], right: ["amount"] },
    },
    state: { sorting, columnVisibility, columnSizing },
  });

  useEffect(() => {
    if (hydrated) saveSizing(columnSizing);
  }, [columnSizing, hydrated]);
  useEffect(() => {
    if (hydrated)
      saveOverrides(pruneOverrides(autoModel, columnVisibility as Record<string, boolean>));
  }, [columnVisibility, autoModel, hydrated]);

  const descriptionIsSized = columnSizing.description !== undefined;
  const widthFor = (columnId: string, sizeVar: string): React.CSSProperties =>
    cellWidth(columnId, sizeVar, {
      flexColumnId: "description",
      flexMinWidth: 260,
      isFlexColumnSized: descriptionIsSized,
    });
  const sizeVars = columnSizeVars(table);

  // ── Keyboard ──
  const gridRef = useRef<HTMLDivElement>(null);
  const sortedRows = table.getRowModel().rows;

  /**
   * The cursor is the highlighted PROPOSAL, not the highlighted row number.
   *
   * Held as an index it silently changed meaning: sort by Client with row 41
   * highlighted and the row count never changes, so nothing corrects it and
   * the highlight is now on whichever proposal happens to be 41st. Holding
   * the id instead means the same estimate stays selected through a re-sort,
   * and falls out of the list — index −1, no cursor — when a filter excludes
   * it, which is the honest answer rather than a highlight that has quietly
   * moved to a neighbour.
   */
  const [cursorId, setCursorId] = useState<string | null>(null);
  const cursor = useMemo(
    () => (cursorId === null ? -1 : sortedRows.findIndex((r) => r.original._id === cursorId)),
    [sortedRows, cursorId]
  );

  const moveCursor = useCallback(
    (next: number) => {
      if (sortedRows.length === 0) return;
      const clamped = Math.max(0, Math.min(next, sortedRows.length - 1));
      const row = sortedRows[clamped];
      if (!row) return;
      setCursorId(row.original._id);
      // The keyboard gets the same prefetch the mouse does — otherwise
      // arrowing to a row and pressing Enter takes the slow path.
      queueWarm(() => warmEstimate(row.original._id));
      gridRef.current
        ?.querySelector(`[data-row-index="${clamped}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [sortedRows, queueWarm, warmEstimate]
  );

  const openRow = useCallback(
    (id: string) => navigate({ to: "/estimate/$estimateId", params: { estimateId: id } }),
    [navigate]
  );

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      // Never steal keys from a dialog or an open menu. Radix's dropdown
      // content is role="menu", NOT role="dialog", and neither react-menu nor
      // react-roving-focus stops propagation — without the second selector,
      // arrows drove the grid underneath an open menu and Enter navigated
      // away from it. Same guard selection-bar.tsx and phase-nav.tsx use.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]'
        )
      ) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveCursor(cursor + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(cursor - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        moveCursor(0);
      } else if (e.key === "End") {
        e.preventDefault();
        moveCursor(sortedRows.length - 1);
      } else if (e.key === "Enter" && cursor >= 0) {
        const row = sortedRows[cursor];
        if (row) openRow(row.original._id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cursor, moveCursor, openRow, sortedRows]);

  /**
   * Right-click a row.
   *
   * A NATIVE Tauri menu, not a Radix one: WKWebView handles the right-click
   * itself and shows its own Back / Reload / Inspect Element menu before any
   * DOM menu can render, so the only way to own the gesture is to preventDefault
   * and pop the platform menu. Momentum reached the same conclusion for its
   * workbook rows, and this follows that implementation.
   */
  const handleRowContextMenu = useCallback(
    async (row: ProposalRow, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Right-clicking a row makes it the cursor row, so the menu and the
      // keyboard never disagree about which estimate is being acted on.
      setCursorId(row._id);

      const copy = (text: string, what: string) => {
        void navigator.clipboard
          .writeText(text)
          .then(() => toast.success(`Copied ${what}`))
          .catch(() => toast.error("Could not copy to the clipboard"));
      };

      try {
        const open = await MenuItem.new({
          id: "open",
          text: "Open Estimate",
          action: () => openRow(row._id),
        });
        const sep = await PredefinedMenuItem.new({ item: "Separator" });
        const copyNumber = await MenuItem.new({
          id: "copy-number",
          text: `Copy Number (${row.proposalNumber.trim()})`,
          action: () => copy(row.proposalNumber.trim(), "proposal number"),
        });
        const copyDescription = await MenuItem.new({
          id: "copy-description",
          text: "Copy Description",
          action: () => copy(row.description, "description"),
        });
        const copyRow = await MenuItem.new({
          id: "copy-row",
          text: "Copy Row",
          // Tab-separated and upper-cased, exactly like ⌘C on the whole view,
          // so a single row pastes into their sheet the same way a filtered
          // selection does.
          action: () =>
            copy(
              [
                row.proposalNumber.trim(),
                row.description,
                row.ownerName,
                row.location ?? "",
                row.estimators.join(", "),
                bidTypeLabel(row.bidType),
                row.status ?? "",
              ]
                .map((v) => v.toUpperCase().replace(/[\t\r\n]+/g, " "))
                .join("\t"),
              "row"
            ),
        });

        const items: Array<MenuItem | PredefinedMenuItem> = [open];
        if (canEdit) {
          const revise = await MenuItem.new({
            id: "create-revision",
            text: "Create Revision\u2026",
            action: () => setRevisionSource(row),
          });
          items.push(revise);
        }
        items.push(sep, copyNumber, copyDescription, copyRow);

        const menu = await Menu.new({ items });
        await menu.popup();
      } catch (error) {
        // A non-Tauri host has no native menu; falling through leaves the
        // row's own click behaviour intact rather than breaking the page.
        console.error("Context menu error:", error);
      }
    },
    [openRow, canEdit]
  );

  /**
   * Copy the current view as TSV.
   *
   * These people live in Excel and paste is how they leave. The real workflow
   * is "filter to open bids for Cargill, copy, paste into an email" — which a
   * selection model would only slow down, so this copies exactly what is on
   * screen: current filter, current sort, visible columns only.
   */
  const copyView = useCallback(() => {
    const visible = table.getVisibleLeafColumns();
    const header = visible.map((c) => LOG_COLUMN_LABELS[c.id] ?? c.id).join("\t");
    const body = table
      .getRowModel()
      .rows.map((row) =>
        visible
          .map((c) => {
            const r = row.original;
            switch (c.id) {
              case "number":
                return r.proposalNumber;
              case "description":
                return r.description;
              case "client":
                return r.ownerName;
              case "location":
                return r.location ?? "";
              case "estimators":
                return r.estimators.join(", ");
              case "bidType":
                return bidTypeLabel(r.bidType);
              case "received":
                return r.dateReceived ? new Date(r.dateReceived).toLocaleDateString("en-US") : "";
              case "due":
                return r.dateDue ? new Date(r.dateDue).toLocaleDateString("en-US") : "";
              case "status":
                return r.status ?? "";
              case "jobNumber":
                return r.jobNumber ?? "";
              case "startDate":
                return r.projectStartDate
                  ? new Date(r.projectStartDate).toLocaleDateString("en-US")
                  : "";
              case "endDate":
                return r.projectEndDate
                  ? new Date(r.projectEndDate).toLocaleDateString("en-US")
                  : "";
              case "amount":
                return r.amount == null ? "" : String(r.amount);
              default:
                return "";
            }
          })
          // The grid draws these in caps with CSS, which never reaches the
          // clipboard — so the copy path says it out loud and the pasted
          // sheet matches the screen.
          .map((v) => v.toUpperCase())
          // A tab or newline inside a description would shift every later
          // column by one when it lands in a spreadsheet.
          .map((v) => v.replace(/[\t\r\n]+/g, " "))
          .join("\t")
      )
      .join("\n");

    void navigator.clipboard
      .writeText(`${header}\n${body}`)
      .then(() => toast.success(`Copied ${table.getRowModel().rows.length} rows`))
      .catch(() => toast.error("Could not copy to the clipboard"));
  }, [table]);

  useEffect(() => {
    const onCopy = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "c") return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      // Same reasoning as the navigation listener: an open dialog or menu owns
      // the keyboard, so ⌘C there must not silently copy the whole grid.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]'
        )
      ) {
        return;
      }
      // A real text selection means the user meant to copy that, not the grid.
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
      e.preventDefault();
      copyView();
    };
    document.addEventListener("keydown", onCopy);
    return () => document.removeEventListener("keydown", onCopy);
  }, [copyView]);

  const filtersActive =
    search !== "" || statusFilter !== null || typeFilter.size > 0 || dueFilter !== null;
  const clearFilters = () => {
    setTypeFilter(new Set());
    // One navigation, not two — clearing status then due would leave an
    // intermediate URL in play and re-render the whole log twice.
    void navigate({ to: "/estimates", search: {}, replace: true });
  };

  /**
   * Matches the search finds but the filters hide.
   *
   * A scoped list fails when the thing you remember is in the other bucket;
   * this is the way out of that dead end without losing the query.
   */
  const hiddenMatches = useMemo(() => {
    if (!search) return 0;
    const all = rows.filter((r) => matchesSearch(r, search)).length;
    return all - filtered.length;
  }, [rows, search, filtered.length, matchesSearch]);

  if (!proposals) return <LogSkeleton />;

  const isCustomized =
    Object.keys(pruneOverrides(autoModel, columnVisibility as Record<string, boolean>)).length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* ── Band A: command row ── */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-foreground-subtle" />
          <Input
            ref={searchRef}
            placeholder="Search the log..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Down-arrow walks from the query into the results, which is
              // the only way to reach the grid without clearing what you typed.
              if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
                moveCursor(0);
              } else if (e.key === "Escape") {
                e.currentTarget.blur();
                setSearch("");
              }
            }}
            className="h-7 rounded-md border-0 bg-fill-tertiary pl-7 pr-10 text-callout"
          />
          {search === "" && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-footnote text-foreground-subtle">
              ⌘F
            </span>
          )}
        </div>

        {filtersActive && (
          <span className="shrink-0 text-footnote tabular-nums text-foreground-subtle">
            {filtered.length} of {rows.length}
          </span>
        )}

        <div className="flex-1" />

        {/* Metrics read as a terminal status line — value then label on one
            baseline — rather than dashboard tiles. Each one is a filter. */}
        <div className="flex items-center gap-4">
          <MetricButton
            value={metrics.overdue}
            label="Overdue"
            tone="danger"
            active={dueFilter === "overdue"}
            onClick={() => setDueFilter(dueFilter === "overdue" ? null : "overdue")}
            title="Past due and still bidding. Submitted bids are excluded — the deadline was met."
          />
          <MetricButton
            value={metrics.dormant}
            label="Dormant"
            active={dueFilter === "dormant"}
            onClick={() => setDueFilter(dueFilter === "dormant" ? null : "dormant")}
            title="Still bidding more than 90 days past due. Most of these are finished and were never closed out."
          />
          <MetricButton
            value={metrics.hitRate === null ? "—" : `${metrics.hitRate}%`}
            label="Hit rate"
            title={`Awarded ÷ (Awarded + Rejected) — ${metrics.awarded} of ${metrics.awarded + metrics.rejected} decided. Declined and Closed are excluded; neither is a decision on our price.`}
          />
        </div>

        <div className="mx-1 h-4 w-px bg-border" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="lg" className="gap-1">
              Type
              {typeFilter.size > 0 && <span className="h-1 w-1 rounded-full bg-primary" />}
              <ChevronDown className="h-2.5 w-2.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-footnote font-normal text-muted-foreground">
              Contract type
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {Object.entries(typeCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([key, count]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={typeFilter.has(key)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) =>
                    setTypeFilter((current) => {
                      const next = new Set(current);
                      if (checked) next.add(key);
                      else next.delete(key);
                      return next;
                    })
                  }
                >
                  <span className="flex-1">
                    {key === "(none)" ? "Unspecified" : bidTypeLabel(key)}
                  </span>
                  <span className="tabular-nums text-foreground-subtle">{count}</span>
                </DropdownMenuCheckboxItem>
              ))}
            {typeFilter.size > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTypeFilter(new Set())}>
                  Clear type filter
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <ColumnMenu
          table={table}
          label="Columns in this log"
          labelFor={(id) => LOG_COLUMN_LABELS[id] ?? id}
          isCustomized={isCustomized}
          onReset={() => setColumnVisibility(autoModel)}
        />

        <Button variant="ghost" size="lg" onClick={copyView} title="Copy this view as TSV (⌘C)">
          <Download className="h-3.5 w-3.5" />
        </Button>

        {canEdit && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <Button variant="outline" size="lg" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> New Estimate
            </Button>
          </>
        )}
      </div>

      {/* ── Band B: status rail ──
          The rail's bottom border IS the distribution strip — the proportions
          double as the rule, so the chart costs no vertical space. */}
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
        <StatusChip
          label="All"
          count={preStatus.length}
          selected={statusFilter === null}
          onClick={() => setStatusFilter(null)}
        />
        {STATUS_ORDER.filter((s) => (statusCounts[s] ?? 0) > 0 || statusFilter === s).map(
          (status) => (
            <StatusChip
              key={status}
              label={status}
              count={statusCounts[status] ?? 0}
              status={status}
              selected={statusFilter === status}
              onClick={() => setStatusFilter(statusFilter === status ? null : status)}
            />
          )
        )}
      </div>

      {/* The way out of a scoped dead end, without losing the query. Above
          the grid, not below it — under 731 rows nobody would ever see it. */}
      {hiddenMatches > 0 && (
        <button
          type="button"
          onClick={clearFilters}
          className="shrink-0 border-b bg-primary/5 px-3 py-1.5 text-left text-callout text-primary hover:bg-primary/10"
        >
          +{hiddenMatches} more match &ldquo;{search}&rdquo; outside the current filters →
        </button>
      )}

      {/* ── The grid ── */}
      <div ref={gridRef} className="min-h-0 flex-1 overflow-auto">
        <table
          className="w-full table-fixed border-collapse text-xs"
          style={{ ...sizeVars, minWidth: table.getTotalSize() }}
        >
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((h) => {
                  const align = (h.column.columnDef.meta as { align?: string } | undefined)?.align;
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className="group relative h-8 overflow-hidden border-b bg-grid-header p-0 text-left text-footnote font-semibold uppercase tracking-wide text-muted-foreground"
                      style={{
                        ...widthFor(h.column.id, `var(--header-${h.id}-size)`),
                        ...pinnedStyle(h.column, "header"),
                      }}
                    >
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className={cn(
                          "flex h-full w-full items-center gap-1 px-2 whitespace-nowrap",
                          align === "right" && "justify-end"
                        )}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === "asc" ? (
                          <ChevronUp className="h-2.5 w-2.5 shrink-0" />
                        ) : sorted === "desc" ? (
                          <ChevronDown className="h-2.5 w-2.5 shrink-0" />
                        ) : (
                          <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-40" />
                        )}
                      </button>
                      <div
                        onDoubleClick={() => h.column.resetSize()}
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                        className={cn(
                          "absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize touch-none select-none bg-border-strong opacity-0 transition-opacity group-hover:opacity-100",
                          h.column.getIsResizing() && "bg-primary opacity-100"
                        )}
                      />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {sortedRows.map((row, i) => (
              <tr
                key={row.id}
                data-row-index={i}
                className={cn(
                  // scroll-mt clears the sticky header: without it, arrowing
                  // upward parks the cursor row underneath it, out of sight.
                  "group h-[30px] cursor-pointer scroll-mt-8",
                  // The cursor tints the ROW, which the cells inherit through
                  // `bg-inherit` — a ring on each cell drew ten separate boxes
                  // across the row instead of one highlight.
                  cursor === i
                    ? "bg-primary/10"
                    : i % 2 === 0
                      ? "bg-background"
                      : "bg-background-subtle"
                )}
                onMouseEnter={() => queueWarm(() => warmEstimate(row.original._id))}
                onMouseLeave={cancelWarm}
                onClick={() => openRow(row.original._id)}
                onContextMenu={(e) => void handleRowContextMenu(row.original, e)}
              >
                {row.getVisibleCells().map((cell) => {
                  const align = (cell.column.columnDef.meta as { align?: string } | undefined)
                    ?.align;
                  return (
                    <td
                      key={cell.id}
                      className="overflow-hidden bg-inherit p-0"
                      style={{
                        ...widthFor(cell.column.id, `var(--col-${cell.column.id}-size)`),
                        ...pinnedStyle(cell.column, "cell"),
                      }}
                    >
                      <div
                        className={cn(
                          "flex h-[30px] items-center px-2 transition-colors",
                          align === "right" && "justify-end",
                          cursor !== i && "group-hover:bg-fill-tertiary"
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {sortedRows.length === 0 && (
          <EmptyState
            hasAnyProposals={rows.length > 0}
            search={search}
            statusFilter={statusFilter}
            hiddenMatches={hiddenMatches}
            canEdit={canEdit}
            onNew={() => setCreateOpen(true)}
            onClearSearch={() => setSearch("")}
            onClearFilters={clearFilters}
          />
        )}
      </div>

      {canEdit && <CreateEstimateDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {canEdit && (
        <CreateRevisionDialog
          open={revisionSource !== null}
          onOpenChange={(next) => !next && setRevisionSource(null)}
          source={revisionSource}
          allProposals={rows}
        />
      )}
    </div>
  );
}

/**
 * `declined` and `closed` share a neutral fill with no colour of its own, and
 * a neutral at strip opacity is invisible against the background — so those
 * two get a visible neutral instead of a token that would render as a gap.
 */
function barClass(status: string): string {
  if (status === "declined" || status === "closed") return "bg-foreground/25";
  return proposalStatusBarClasses(status);
}

function MetricButton({
  value,
  label,
  title,
  tone,
  active,
  onClick,
}: {
  value: number | string;
  label: string;
  title: string;
  tone?: "danger";
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span
        className={cn(
          "text-callout font-semibold tabular-nums",
          tone === "danger" && value !== 0 ? "text-red-600 dark:text-red-400" : "text-foreground"
        )}
      >
        {value}
      </span>
      <span className="text-footnote uppercase tracking-[0.06em] text-foreground-subtle">
        {label}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <span className="flex items-center gap-1" title={title}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-fill-quaternary",
        active && "bg-fill-secondary"
      )}
    >
      {content}
    </button>
  );
}

function StatusChip({
  label,
  count,
  status,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  status?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 pb-0.5 transition-colors",
        selected
          ? "bg-fill-secondary text-foreground"
          : "text-muted-foreground hover:bg-fill-quaternary"
      )}
    >
      <span className="text-callout capitalize">{label}</span>
      <span className="text-footnote tabular-nums text-foreground-subtle">{count}</span>
      {status && (
        // The colour arrives as a sliver, not a fill — seven statuses sharing
        // five hues would be a rainbow if every chip were tinted.
        <span
          className={cn(
            "absolute bottom-0 left-2 right-2 h-[2px] rounded-full",
            barClass(status),
            selected ? "opacity-100" : "opacity-50"
          )}
        />
      )}
    </button>
  );
}

function EmptyState({
  hasAnyProposals,
  search,
  statusFilter,
  hiddenMatches,
  canEdit,
  onNew,
  onClearSearch,
  onClearFilters,
}: {
  hasAnyProposals: boolean;
  search: string;
  statusFilter: string | null;
  hiddenMatches: number;
  canEdit: boolean;
  onNew: () => void;
  onClearSearch: () => void;
  onClearFilters: () => void;
}) {
  // Each case names what happened and offers the one way out — never a bare
  // "No results", which tells you nothing you could act on.
  let title: string;
  let action: React.ReactNode = null;

  if (!hasAnyProposals) {
    title = "No estimates yet";
    if (canEdit)
      action = (
        <Button variant="outline" size="lg" onClick={onNew}>
          <Plus className="h-3 w-3" /> New Estimate
        </Button>
      );
  } else if (search && hiddenMatches > 0) {
    title = statusFilter ? `No matches in ${statusFilter}` : "No matches in the current filters";
    action = (
      <Button variant="outline" size="lg" onClick={onClearFilters}>
        Search all {hiddenMatches > 0 ? `(${hiddenMatches} elsewhere)` : ""}
      </Button>
    );
  } else if (search) {
    title = `No estimates match “${search}”`;
    action = (
      <Button variant="outline" size="lg" onClick={onClearSearch}>
        Clear search
      </Button>
    );
  } else {
    title = statusFilter ? `No ${statusFilter} estimates` : "Nothing matches these filters";
    action = (
      <Button variant="outline" size="lg" onClick={onClearFilters}>
        Clear filters
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <p className="text-body text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}

/**
 * The skeleton reproduces the real geometry so the first paint does not
 * reflow when data lands.
 *
 * ⚠️ THE WIDTHS ARE DERIVED, NOT TRANSCRIBED. Hand-copied numbers went stale
 * within a day — Job No. was hidden, Client and Location were re-measured,
 * and the distribution strip was deleted, while this still drew all of them.
 * A skeleton that disagrees with the table is worse than none, because it
 * promises a layout the data then rearranges. Reading the column defs means
 * a size change can only ever be made in one place.
 */
function LogSkeleton() {
  const widths = buildLogColumns({ current: { now: 0, query: "" } })
    .filter((c) => DEFAULT_VISIBILITY[c.id as keyof typeof DEFAULT_VISIBILITY])
    .map((c) => c.size ?? 80);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <div className="h-7 w-64 rounded-md bg-fill-tertiary" />
        <div className="flex-1" />
        <div className="h-4 w-16 rounded bg-fill-tertiary" />
        <div className="h-4 w-16 rounded bg-fill-tertiary" />
        <div className="h-4 w-16 rounded bg-fill-tertiary" />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-[26px] w-16 rounded-md bg-fill-quaternary" />
        ))}
      </div>
      <div className="h-8 shrink-0 border-b bg-grid-header" />
      <div className="min-h-0 flex-1">
        {Array.from({ length: 14 }).map((_, r) => (
          <div
            key={r}
            className={cn(
              "flex h-[30px] items-center gap-2 px-2",
              r % 2 !== 0 && "bg-background-subtle"
            )}
          >
            {widths.map((w, c) => (
              <div
                key={c}
                className="h-2.5 rounded bg-fill-quaternary"
                style={{ width: Math.round(w * 0.6) }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
