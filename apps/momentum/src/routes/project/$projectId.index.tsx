import { createFileRoute, Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { format, parseISO } from "date-fns";
import { X, Clock } from "lucide-react";
import { toast } from "sonner";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { DatePicker } from "@truss/ui/components/date-picker";
import { Badge } from "@truss/ui/components/badge";
import { Button } from "@truss/ui/components/button";
import {
  WorkbookTable,
  EntryHistoryPanel,
  PhaseReassignDialog,
} from "@truss/features/progress-tracking";
import type {
  ColumnMode,
  HistoryDay,
  WorkbookRow,
  PhaseOption,
} from "@truss/features/progress-tracking";
import { WorkbookSkeleton } from "../../components/skeletons";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Project index route — the primary workbook-first work surface.
 *
 * WHY: Merges the old dashboard and workbook into a single page.
 * When collapsed, WBS rows serve as a dashboard overview.
 * When expanded (via filters), it becomes the data entry surface.
 */
export const Route = createFileRoute("/project/$projectId/")({
  component: ProjectWorkbookPage,
  validateSearch: (search: Record<string, unknown>) => ({
    wbs: (search.wbs as string) || undefined,
  }),
});

function ProjectWorkbookPage() {
  const { projectId } = useParams({ from: "/project/$projectId/" });
  const { wbs: wbsFilter } = useSearch({ from: "/project/$projectId/" });

  const data = useQuery(api.momentum.getBrowseData, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const dateLabel = format(selectedDate, "MMM d");

  const rawEntries = useQuery(api.momentum.getEntriesForDate, {
    projectId: projectId as Id<"momentumProjects">,
    entryDate: dateStr,
  });

  const saveEntries = useMutation(api.momentum.saveProgressEntries);
  const reassignPhase = useMutation(api.momentum.reassignActivityPhase);
  const revertPhase = useMutation(api.momentum.revertActivityPhase);

  const [columnMode, setColumnMode] = React.useState<ColumnMode>("entry");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [saveStates, setSaveStates] = React.useState<Record<string, "saving" | "saved" | "error">>(
    {}
  );
  const [historyLimit, setHistoryLimit] = React.useState(500);

  /** Tracks the latest save per activity to handle rapid-fire saves. */
  const pendingSavesRef = React.useRef(new Map<string, number>());

  // Derive quantity and notes maps from the new return shape
  const existingEntries = React.useMemo(() => {
    if (!rawEntries) return undefined;
    const result: Record<string, number> = {};
    for (const [id, entry] of Object.entries(rawEntries)) {
      result[id] = entry.quantity;
    }
    return result;
  }, [rawEntries]);

  const existingNotes = React.useMemo(() => {
    if (!rawEntries) return undefined;
    const result: Record<string, string> = {};
    for (const [id, entry] of Object.entries(rawEntries)) {
      if (entry.notes) result[id] = entry.notes;
    }
    return result;
  }, [rawEntries]);

  /** Refs for values read inside callbacks — avoids stale closures. */
  const dataRef = React.useRef(data);
  dataRef.current = data;
  const existingEntriesRef = React.useRef(existingEntries);
  existingEntriesRef.current = existingEntries;

  // Only query history when panel is open
  const historyResult = useQuery(
    api.momentum.getEntryHistory,
    historyOpen ? { projectId: projectId as Id<"momentumProjects">, limit: historyLimit } : "skip"
  );

  // Handle both old (flat array) and new ({ days, hasMore }) return shapes
  // so the UI works regardless of whether the backend has been redeployed.
  const historyData = Array.isArray(historyResult)
    ? historyResult
    : ((historyResult as { days?: HistoryDay[]; hasMore?: boolean } | null | undefined)?.days ??
      null);
  const historyHasMore = Array.isArray(historyResult)
    ? false
    : ((historyResult as { hasMore?: boolean } | null | undefined)?.hasMore ?? false);

  /* Cmd+H toggle for history panel */
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "h") {
        e.preventDefault();
        setHistoryOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /* Blur active input on beforeunload to trigger commit (crash recovery) */
  React.useEffect(() => {
    function handleBeforeUnload() {
      if (document.activeElement instanceof HTMLInputElement) {
        document.activeElement.blur();
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  /**
   * Persist a single entry to the backend with save-state feedback.
   */
  const persistEntry = React.useCallback(
    async (activityId: string, value: number) => {
      // Skip if value matches what's already on the server
      const existing = existingEntriesRef.current?.[activityId] ?? 0;
      if (value === existing) return;

      const saveId = Date.now();
      pendingSavesRef.current.set(activityId, saveId);
      setSaveStates((prev) => ({ ...prev, [activityId]: "saving" }));

      try {
        await saveEntries({
          projectId: projectId as Id<"momentumProjects">,
          entryDate: dateStr,
          entries: [{ activityId: activityId as Id<"activities">, quantityCompleted: value }],
        });

        // Superseded by a newer save — skip UI update
        if (pendingSavesRef.current.get(activityId) !== saveId) return;
        pendingSavesRef.current.delete(activityId);

        setSaveStates((prev) => ({ ...prev, [activityId]: "saved" }));
        setTimeout(() => {
          setSaveStates((prev) => {
            if (prev[activityId] !== "saved") return prev;
            const next = { ...prev };
            delete next[activityId];
            return next;
          });
        }, 1500);
      } catch (error) {
        if (pendingSavesRef.current.get(activityId) !== saveId) return;
        pendingSavesRef.current.delete(activityId);

        setSaveStates((prev) => ({ ...prev, [activityId]: "error" }));
        toast.error("Failed to save", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
        setTimeout(() => {
          setSaveStates((prev) => {
            if (prev[activityId] !== "error") return prev;
            const next = { ...prev };
            delete next[activityId];
            return next;
          });
        }, 3000);
      }
    },
    [dateStr, projectId, saveEntries]
  );

  /**
   * Called on cell blur. Receives the raw string from the cell,
   * parses and clamps it, then persists.
   */
  const handleEntryCommit = React.useCallback(
    (activityId: string, rawValue: string) => {
      if (rawValue === "") {
        // Empty input — save 0 to delete entry if one exists
        const existing = existingEntriesRef.current?.[activityId];
        if (existing !== undefined && existing > 0) {
          persistEntry(activityId, 0);
        }
        return;
      }

      const row = dataRef.current?.rows.find((r) => r.id === activityId);
      if (!row) return;
      const existing = existingEntriesRef.current?.[activityId] ?? 0;
      const max = row.quantityRemaining + existing;
      const clamped = Math.min(Math.max(parseFloat(rawValue) || 0, 0), max);
      persistEntry(activityId, clamped);
    },
    [persistEntry]
  );

  /** Discard handler — no-op now since local state is in EntryCellInput. */
  const handleEntryDiscard = React.useCallback((_activityId: string) => {
    // Local state is managed by EntryCellInput; nothing to clean up here
  }, []);

  /** Save a note for an activity. */
  const handleNoteSave = React.useCallback(
    async (activityId: string, notes: string) => {
      try {
        const currentQty = existingEntries?.[activityId] ?? 0;
        await saveEntries({
          projectId: projectId as Id<"momentumProjects">,
          entryDate: dateStr,
          entries: [
            {
              activityId: activityId as Id<"activities">,
              quantityCompleted: currentQty,
              notes: notes || undefined,
            },
          ],
        });
      } catch (error) {
        toast.error("Failed to save note", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [dateStr, projectId, saveEntries, existingEntries]
  );

  /** Load a date from the history panel into the date picker. */
  const handleHistoryDateSelect = React.useCallback((date: string) => {
    setSelectedDate(parseISO(date));
    setHistoryOpen(false);
  }, []);

  /** Load more history entries. */
  const handleLoadMore = React.useCallback(() => {
    setHistoryLimit((prev) => prev + 500);
  }, []);

  /** State for the phase reassignment dialog. */
  const [reassignDialog, setReassignDialog] = React.useState<{
    open: boolean;
    activityId: string;
    activityDescription: string;
    currentPhaseId: string;
    availablePhases: PhaseOption[];
  }>({
    open: false,
    activityId: "",
    activityDescription: "",
    currentPhaseId: "",
    availablePhases: [],
  });

  /** Reassign an activity to a different phase via mutation. */
  const handlePhaseReassign = React.useCallback(
    async (activityId: string, targetPhaseId: string) => {
      try {
        await reassignPhase({
          projectId: projectId as Id<"momentumProjects">,
          activityId: activityId as Id<"activities">,
          targetPhaseId: targetPhaseId as Id<"phases">,
        });
        toast.success("Activity moved to new phase");
      } catch (error) {
        toast.error("Failed to reassign phase", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [projectId, reassignPhase]
  );

  /** Revert an activity's phase override back to the original. */
  const handlePhaseRevert = React.useCallback(
    async (activityId: string) => {
      try {
        await revertPhase({
          projectId: projectId as Id<"momentumProjects">,
          activityId: activityId as Id<"activities">,
        });
        toast.success("Phase reverted to original");
      } catch (error) {
        toast.error("Failed to revert phase", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [projectId, revertPhase]
  );

  /**
   * Show a native Tauri context menu on right-click of a detail row.
   *
   * WHY native menu: Tauri WebView intercepts right-click before any
   * DOM-based context menu (Radix, etc.) can render. The official Tauri v2
   * Menu API with `popup()` is the intended approach.
   */
  const handleRowContextMenu = React.useCallback(
    async (row: WorkbookRow, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        const phases = data?.phasesByWbs?.[row.wbsId] ?? [];

        const moveItem = await MenuItem.new({
          id: "move-to-phase",
          text: "Move to Phase\u2026",
          enabled: phases.length > 0,
          action: () => {
            setReassignDialog({
              open: true,
              activityId: row.id,
              activityDescription: row.description,
              currentPhaseId: row.phaseId,
              availablePhases: phases,
            });
          },
        });

        const items: Array<MenuItem | PredefinedMenuItem> = [moveItem];

        if (row.isOverridden) {
          const separator = await PredefinedMenuItem.new({ item: "Separator" });
          const revertItem = await MenuItem.new({
            id: "revert-phase",
            text: `Revert to Phase ${row.originalPhaseCode ?? ""}`.trim(),
            action: () => {
              handlePhaseRevert(row.id);
            },
          });
          items.push(separator, revertItem);
        }

        const menu = await Menu.new({ items });
        await menu.popup();
      } catch (error) {
        console.error("Context menu error:", error);
      }
    },
    [data?.phasesByWbs, handlePhaseRevert]
  );

  if (data === undefined) return <WorkbookSkeleton />;

  if (data === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <p className="text-lg font-semibold text-muted-foreground">Project not found</p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const filteredRows = wbsFilter ? data.rows.filter((r) => r.wbsCode === wbsFilter) : data.rows;

  return (
    <div className="flex flex-col h-full gap-4 min-w-0 overflow-hidden">
      {/* ── Page header — title + date controls ── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Workbook</h1>
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
            {filteredRows.length}
          </span>
          <span className="text-[13px] text-muted-foreground">{data.project.proposalNumber}</span>
          {wbsFilter && (
            <Badge variant="secondary" className="gap-1 h-5 px-1.5 text-[11px]">
              WBS {wbsFilter}
              <Link
                to="/project/$projectId"
                params={{ projectId }}
                search={{ wbs: undefined }}
                className="ml-0.5 rounded-sm hover:bg-foreground/10"
              >
                <X className="h-3 w-3" />
              </Link>
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <DatePicker
            date={selectedDate}
            onDateChange={(date) => date && setSelectedDate(date)}
            placeholder="Entry date"
            toDate={new Date()}
            formatStr="MMMM do, yyyy"
            suffix={format(selectedDate, "EEEE")}
            align="end"
            className="w-auto"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setHistoryOpen(true)}
          >
            <Clock className="h-3.5 w-3.5" />
            History
          </Button>
        </div>
      </div>

      {/* ── Workbook table ── */}
      <div className="flex-1 min-h-0 min-w-0">
        <WorkbookTable
          rows={filteredRows}
          wbsSummaries={data.wbsSummaries}
          phaseSummaries={data.phaseSummaries}
          entryDateLabel={dateLabel}
          existingEntries={existingEntries}
          onEntryCommit={handleEntryCommit}
          onEntryDiscard={handleEntryDiscard}
          existingNotes={existingNotes}
          onNoteSave={handleNoteSave}
          projectStats={{
            totalMH: data.project.totalMH,
            earnedMH: data.project.earnedMH,
            percentComplete: data.project.percentComplete,
            status: data.project.status,
          }}
          columnMode={columnMode}
          onColumnModeChange={setColumnMode}
          saveStates={saveStates}
          phasesByWbs={data.phasesByWbs}
          onRowContextMenu={handleRowContextMenu}
        />
      </div>

      {/* ── Phase reassign dialog ── */}
      <PhaseReassignDialog
        open={reassignDialog.open}
        onOpenChange={(open) => setReassignDialog((prev) => ({ ...prev, open }))}
        activityId={reassignDialog.activityId}
        activityDescription={reassignDialog.activityDescription}
        currentPhaseId={reassignDialog.currentPhaseId}
        availablePhases={reassignDialog.availablePhases}
        onReassign={handlePhaseReassign}
      />

      {/* ── Entry history panel ── */}
      <EntryHistoryPanel
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        history={historyData as HistoryDay[] | null | undefined}
        onDateSelect={handleHistoryDateSelect}
        hasMore={historyHasMore}
        onLoadMore={handleLoadMore}
      />
    </div>
  );
}
