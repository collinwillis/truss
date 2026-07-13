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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@truss/ui/components/alert-dialog";
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
import { AddActivityDialog } from "../../components/add-activity-dialog";
import { AddPhaseDialog } from "../../components/add-phase-dialog";
import { ChangeOrderDetailsDialog } from "../../components/change-order-details-dialog";
import { EditActivityDialog } from "../../components/edit-activity-dialog";
import { EditPhaseDialog } from "../../components/edit-phase-dialog";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { isWorkspaceAdmin } from "../../lib/permissions";
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
  const { workspace } = useWorkspace();
  const isAdmin = isWorkspaceAdmin(workspace);

  const data = useQuery(api.momentum.getBrowseData, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());
  const [pendingDate, setPendingDate] = React.useState<Date | null>(null);
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const dateLabel = format(selectedDate, "MMM d");

  /** Derive non-work days from the project's work calendar setting. */
  const workCalendar = data?.project.workCalendar ?? "5x10";
  const nonWorkDays = React.useMemo(() => {
    switch (workCalendar) {
      case "5x10":
        return [0, 6]; // Sun, Sat
      case "6x10":
        return [0]; // Sun
      case "7x10":
        return []; // No off-days
      default:
        return [0, 6];
    }
  }, [workCalendar]);

  /** Snap to most recent work day if current selection falls on a non-work day. */
  const adjustedOnce = React.useRef(false);
  React.useEffect(() => {
    if (adjustedOnce.current || !data) return;
    adjustedOnce.current = true;
    if (nonWorkDays.length === 0) return;
    if (!nonWorkDays.includes(selectedDate.getDay())) return;
    const d = new Date(selectedDate);
    for (let i = 1; i <= 7; i++) {
      d.setDate(d.getDate() - 1);
      if (!nonWorkDays.includes(d.getDay())) {
        setSelectedDate(d);
        return;
      }
    }
  }, [data, nonWorkDays, selectedDate]);

  /** Handle date selection -- confirm if it's a non-work day. */
  const handleDateChange = React.useCallback(
    (date: Date | undefined) => {
      if (!date) return;
      if (nonWorkDays.includes(date.getDay())) {
        setPendingDate(date);
      } else {
        setSelectedDate(date);
      }
    },
    [nonWorkDays]
  );

  const rawEntries = useQuery(api.momentum.getEntriesForDate, {
    projectId: projectId as Id<"momentumProjects">,
    entryDate: dateStr,
  });

  /**
   * Mutation with optimistic update for instant UI feedback.
   *
   * WHY: Without this, every cell edit round-trips to the Convex server before
   * totals update. The optimistic update mirrors the server's rollup math
   * client-side so rows, phase/WBS summaries, and project totals reflect
   * changes immediately while the mutation is in-flight.
   */
  const saveEntries = useMutation(api.momentum.saveProgressEntries).withOptimisticUpdate(
    (localStore, args) => {
      // ── 1. Update the entries-for-date query (cell display values) ──
      const entriesArgs = { projectId: args.projectId, entryDate: args.entryDate };
      const currentEntries = localStore.getQuery(api.momentum.getEntriesForDate, entriesArgs);

      if (currentEntries !== undefined) {
        const updated: Record<string, { quantity: number; notes?: string }> = {};
        for (const [id, entry] of Object.entries(currentEntries)) {
          updated[id] = { ...entry };
        }
        for (const entry of args.entries) {
          const id = entry.activityId as string;
          if (entry.quantityCompleted === 0) {
            delete updated[id];
          } else {
            updated[id] = {
              quantity: entry.quantityCompleted,
              notes: entry.notes ?? currentEntries[id]?.notes,
            };
          }
        }
        localStore.setQuery(api.momentum.getEntriesForDate, entriesArgs, updated);
      }

      // ── 2. Update browse data (rows + rollup summaries) ──
      const browseArgs = { projectId: args.projectId };
      const browseData = localStore.getQuery(api.momentum.getBrowseData, browseArgs);
      if (!browseData) return;

      // Compute quantity deltas from old → new
      const deltas = new Map<string, number>();
      for (const entry of args.entries) {
        const id = entry.activityId as string;
        const oldQty = currentEntries?.[id]?.quantity ?? 0;
        const delta = entry.quantityCompleted - oldQty;
        if (delta !== 0) deltas.set(id, delta);
      }
      if (deltas.size === 0) return;

      // Apply deltas to rows, accumulate earned-MH changes for rollups
      const phaseEarnedDeltas = new Map<string, number>();
      const wbsEarnedDeltas = new Map<string, number>();

      const newRows = browseData.rows.map((row) => {
        const delta = deltas.get(row.id);
        if (delta === undefined) return row;

        const mhPerUnit = row.quantity > 0 ? row.totalMH / row.quantity : 0;
        const earnedDelta = delta * mhPerUnit;
        const newQtyComplete = row.quantityComplete + delta;
        const newEarnedMH = newQtyComplete * mhPerUnit;

        // #30 — mirror the server's approved-only gate: a non-approved Change
        // Order row updates its own display but must NOT roll into the phase/WBS/
        // project totals (which feed the dashboard). The phase's CO status comes
        // from its phase summary (set only on CO phases).
        const coStatus = browseData.phaseSummaries[row.phaseId]?.changeOrderStatus;
        const rowCounts = !(coStatus && coStatus !== "approved");
        if (rowCounts) {
          phaseEarnedDeltas.set(
            row.phaseId,
            (phaseEarnedDeltas.get(row.phaseId) ?? 0) + earnedDelta
          );
          wbsEarnedDeltas.set(row.wbsId, (wbsEarnedDeltas.get(row.wbsId) ?? 0) + earnedDelta);
        }

        return {
          ...row,
          quantityComplete: newQtyComplete,
          quantityRemaining: Math.max(0, row.quantity - newQtyComplete),
          earnedMH: newEarnedMH,
          remainingMH: Math.max(0, row.totalMH - newEarnedMH),
          percentComplete: row.totalMH > 0 ? Math.round((newEarnedMH / row.totalMH) * 100) : 0,
        };
      });

      // Roll up phase summaries
      const newPhaseSummaries = { ...browseData.phaseSummaries };
      for (const [phaseId, earnedDelta] of phaseEarnedDeltas) {
        const phase = newPhaseSummaries[phaseId];
        if (!phase) continue;
        const newEarned = phase.earnedMH + earnedDelta;
        newPhaseSummaries[phaseId] = {
          ...phase,
          earnedMH: newEarned,
          percentComplete: phase.totalMH > 0 ? Math.round((newEarned / phase.totalMH) * 100) : 0,
        };
      }

      // Roll up WBS summaries
      const newWbsSummaries = { ...browseData.wbsSummaries };
      for (const [wbsId, earnedDelta] of wbsEarnedDeltas) {
        const wbs = newWbsSummaries[wbsId];
        if (!wbs) continue;
        const newEarned = wbs.earnedMH + earnedDelta;
        newWbsSummaries[wbsId] = {
          ...wbs,
          earnedMH: newEarned,
          percentComplete: wbs.totalMH > 0 ? Math.round((newEarned / wbs.totalMH) * 100) : 0,
        };
      }

      // Recompute project totals from updated WBS summaries
      let projectEarnedMH = 0;
      let projectTotalMH = 0;
      for (const s of Object.values(newWbsSummaries)) {
        projectEarnedMH += s.earnedMH;
        projectTotalMH += s.totalMH;
      }

      localStore.setQuery(api.momentum.getBrowseData, browseArgs, {
        ...browseData,
        rows: newRows,
        phaseSummaries: newPhaseSummaries,
        wbsSummaries: newWbsSummaries,
        project: {
          ...browseData.project,
          earnedMH: projectEarnedMH,
          percentComplete:
            projectTotalMH > 0 ? Math.round((projectEarnedMH / projectTotalMH) * 100) : 0,
        },
      });

      // ── 3. Update project list sidebar ──
      const projects = localStore.getQuery(api.momentum.listProjects, {});
      if (projects) {
        let totalEarnedDelta = 0;
        for (const d of wbsEarnedDeltas.values()) totalEarnedDelta += d;
        if (totalEarnedDelta !== 0) {
          const pid = args.projectId as string;
          localStore.setQuery(
            api.momentum.listProjects,
            {},
            projects.map((p) => {
              if (p.id !== pid) return p;
              const newEarned = p.earnedMH + totalEarnedDelta;
              return {
                ...p,
                earnedMH: newEarned,
                percentComplete: p.totalMH > 0 ? Math.round((newEarned / p.totalMH) * 100) : 0,
              };
            })
          );
        }
      }
    }
  );
  const reassignPhase = useMutation(api.momentum.reassignActivityPhase);
  const revertPhase = useMutation(api.momentum.revertActivityPhase);
  const splitActivityBatch = useMutation(api.momentum.splitActivityToPhases);
  const revertSplit = useMutation(api.momentum.revertActivitySplit);
  const deletePhase = useMutation(api.momentum.deletePhase);
  const deleteActivity = useMutation(api.momentum.deleteActivity);

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

  // Only query history when panel is open (admin only)
  const historyResult = useQuery(
    api.momentum.getEntryHistory,
    isAdmin && historyOpen
      ? { projectId: projectId as Id<"momentumProjects">, limit: historyLimit }
      : "skip"
  );

  // Contributor names for the admin-only "added after the estimate" markers.
  const contributors = useQuery(
    api.momentum.getProjectContributors,
    isAdmin ? { projectId: projectId as Id<"momentumProjects"> } : "skip"
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

  /* Cmd+H toggle for history panel (admin only) */
  React.useEffect(() => {
    if (!isAdmin) return;
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "h") {
        e.preventDefault();
        setHistoryOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAdmin]);

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
   * Resolve a workbook row id to the `{ activityId, splitId? }` pair the
   * server expects. Split rows use the split's own _id as their row id,
   * but the mutation API needs both the source activity and the split.
   * Source rows just pass the activity id through.
   */
  const resolveRowTarget = React.useCallback(
    (rowId: string): { activityId: string; splitId?: string } | null => {
      const row = dataRef.current?.rows.find((r) => r.id === rowId);
      if (!row) return null;
      if (row.isSplit && row.sourceActivityId && row.splitId) {
        return { activityId: row.sourceActivityId, splitId: row.splitId };
      }
      return { activityId: rowId };
    },
    []
  );

  /**
   * Persist a single entry to the backend with save-state feedback.
   * `rowId` is a workbook row id (split or source); the resolver decides
   * which bucket the entry lands in.
   */
  const persistEntry = React.useCallback(
    async (rowId: string, value: number) => {
      const existing = existingEntriesRef.current?.[rowId] ?? 0;
      if (value === existing) return;

      const target = resolveRowTarget(rowId);
      if (!target) return;

      const saveId = Date.now();
      pendingSavesRef.current.set(rowId, saveId);
      setSaveStates((prev) => ({ ...prev, [rowId]: "saving" }));

      try {
        await saveEntries({
          projectId: projectId as Id<"momentumProjects">,
          entryDate: dateStr,
          entries: [
            {
              activityId: target.activityId as Id<"momentumActivities">,
              splitId: target.splitId as Id<"activitySplits"> | undefined,
              quantityCompleted: value,
            },
          ],
        });

        if (pendingSavesRef.current.get(rowId) !== saveId) return;
        pendingSavesRef.current.delete(rowId);

        setSaveStates((prev) => ({ ...prev, [rowId]: "saved" }));
        setTimeout(() => {
          setSaveStates((prev) => {
            if (prev[rowId] !== "saved") return prev;
            const next = { ...prev };
            delete next[rowId];
            return next;
          });
        }, 1500);
      } catch (error) {
        if (pendingSavesRef.current.get(rowId) !== saveId) return;
        pendingSavesRef.current.delete(rowId);

        setSaveStates((prev) => ({ ...prev, [rowId]: "error" }));
        toast.error("Failed to save", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
        setTimeout(() => {
          setSaveStates((prev) => {
            if (prev[rowId] !== "error") return prev;
            const next = { ...prev };
            delete next[rowId];
            return next;
          });
        }, 3000);
      }
    },
    [dateStr, projectId, resolveRowTarget, saveEntries]
  );

  /**
   * Called on cell blur. Receives the raw string from the cell,
   * parses and clamps it, then persists.
   */
  const handleEntryCommit = React.useCallback(
    (rowId: string, rawValue: string) => {
      if (rawValue === "") {
        const existing = existingEntriesRef.current?.[rowId];
        if (existing !== undefined && existing > 0) {
          persistEntry(rowId, 0);
        }
        return;
      }

      const row = dataRef.current?.rows.find((r) => r.id === rowId);
      if (!row) return;
      const existing = existingEntriesRef.current?.[rowId] ?? 0;
      const max = row.quantityRemaining + existing;
      const clamped = Math.min(Math.max(parseFloat(rawValue) || 0, 0), max);
      persistEntry(rowId, clamped);
    },
    [persistEntry]
  );

  /** Discard handler — no-op now since local state is in EntryCellInput. */
  const handleEntryDiscard = React.useCallback((_activityId: string) => {
    // Local state is managed by EntryCellInput; nothing to clean up here
  }, []);

  /** Save a note for a row (source activity or split). */
  const handleNoteSave = React.useCallback(
    async (rowId: string, notes: string) => {
      try {
        const target = resolveRowTarget(rowId);
        if (!target) return;
        const currentQty = existingEntries?.[rowId] ?? 0;
        await saveEntries({
          projectId: projectId as Id<"momentumProjects">,
          entryDate: dateStr,
          entries: [
            {
              activityId: target.activityId as Id<"momentumActivities">,
              splitId: target.splitId as Id<"activitySplits"> | undefined,
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
    [dateStr, projectId, resolveRowTarget, saveEntries, existingEntries]
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

  /** State for the phase reassignment / split dialog. */
  const [reassignDialog, setReassignDialog] = React.useState<{
    open: boolean;
    activityId: string;
    activityDescription: string;
    currentPhaseId: string;
    availablePhases: PhaseOption[];
    availableQuantity: number;
    unit: string;
  }>({
    open: false,
    activityId: "",
    activityDescription: "",
    currentPhaseId: "",
    availablePhases: [],
    availableQuantity: 0,
    unit: "",
  });

  /** Reassign an activity to a different phase via mutation. */
  const handlePhaseReassign = React.useCallback(
    async (activityId: string, targetPhaseId: string) => {
      try {
        await reassignPhase({
          projectId: projectId as Id<"momentumProjects">,
          activityId: activityId as Id<"momentumActivities">,
          targetPhaseId: targetPhaseId as Id<"momentumPhases">,
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

  /** Allocate an activity's quantity across one or more phases atomically (#31). */
  const handleActivityAllocate = React.useCallback(
    async (activityId: string, allocations: { targetPhaseId: string; quantity: number }[]) => {
      try {
        await splitActivityBatch({
          projectId: projectId as Id<"momentumProjects">,
          activityId: activityId as Id<"momentumActivities">,
          allocations: allocations.map((a) => ({
            targetPhaseId: a.targetPhaseId as Id<"momentumPhases">,
            quantity: a.quantity,
          })),
        });
        toast.success(
          `Allocated to ${allocations.length} ${allocations.length === 1 ? "phase" : "phases"}`
        );
      } catch (error) {
        toast.error("Failed to allocate activity", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [projectId, splitActivityBatch]
  );

  /** Unsplit — return a split's quantity to the source activity. */
  const handleSplitRevert = React.useCallback(
    async (splitId: string) => {
      try {
        await revertSplit({ splitId: splitId as Id<"activitySplits"> });
        toast.success("Split removed");
      } catch (error) {
        toast.error("Failed to unsplit", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [revertSplit]
  );

  /** Revert an activity's phase override back to the original. */
  const handlePhaseRevert = React.useCallback(
    async (activityId: string) => {
      try {
        await revertPhase({
          projectId: projectId as Id<"momentumProjects">,
          activityId: activityId as Id<"momentumActivities">,
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

  /** Delete a phase added in Momentum (guarded server-side to non-estimate). */
  const handleDeletePhase = React.useCallback(
    async (phaseId: string) => {
      try {
        await deletePhase({ phaseId: phaseId as Id<"momentumPhases"> });
        toast.success("Phase deleted");
      } catch (error) {
        toast.error("Failed to delete phase", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [deletePhase]
  );

  /** Delete an activity added in Momentum (guarded server-side to non-estimate). */
  const handleDeleteActivity = React.useCallback(
    async (activityId: string) => {
      try {
        await deleteActivity({ activityId: activityId as Id<"momentumActivities"> });
        toast.success("Activity deleted");
      } catch (error) {
        toast.error("Failed to delete activity", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [deleteActivity]
  );

  /** State for "Add Activity" on a phase row. */
  const [addActivityDialog, setAddActivityDialog] = React.useState<{
    open: boolean;
    phaseId: string;
    phaseDescription: string;
  }>({ open: false, phaseId: "", phaseDescription: "" });

  /** State for "Add Phase" on any WBS. */
  const [addPhaseDialog, setAddPhaseDialog] = React.useState<{
    open: boolean;
    wbsId: string;
    wbsCode: string;
    isChangeOrder: boolean;
    suggestedPhaseCode: string;
    suggestedDescription: string;
  }>({
    open: false,
    wbsId: "",
    wbsCode: "",
    isChangeOrder: false,
    suggestedPhaseCode: "",
    suggestedDescription: "",
  });

  /** State for the "Change Order Details" editor (#30). */
  const [coDetailsDialog, setCoDetailsDialog] = React.useState<{
    open: boolean;
    phaseId: string;
    phaseCode: string;
    description: string;
    status: string;
    type: string;
  }>({
    open: false,
    phaseId: "",
    phaseCode: "",
    description: "",
    status: "submitted",
    type: "none",
  });

  /** State for the "Delete Phase" confirmation. */
  const [deletePhaseConfirm, setDeletePhaseConfirm] = React.useState<{
    open: boolean;
    phaseId: string;
    phaseCode: string;
  }>({ open: false, phaseId: "", phaseCode: "" });

  /** State for the "Edit Activity" dialog (#26). */
  const [editActivityDialog, setEditActivityDialog] = React.useState<{
    open: boolean;
    activityId: string | null;
  }>({ open: false, activityId: null });

  /** State for the "Edit Phase" dialog (#26). */
  const [editPhaseDialog, setEditPhaseDialog] = React.useState<{
    open: boolean;
    phase: { phaseId: string; phaseCode: string; description: string } | null;
  }>({ open: false, phase: null });

  /** State for the "Delete Activity" confirmation (#26). */
  const [deleteActivityConfirm, setDeleteActivityConfirm] = React.useState<{
    open: boolean;
    activityId: string;
    description: string;
  }>({ open: false, activityId: "", description: "" });

  /**
   * Show a native Tauri context menu on right-click of a detail (activity) row.
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
        const items: Array<MenuItem | PredefinedMenuItem> = [];

        if (row.isSplit && row.splitId) {
          // Split rows only offer Unsplit. Re-targeting a split's phase
          // is equivalent to unsplit + split again; making that two
          // explicit clicks avoids ambiguous semantics around the split's
          // accumulated progress.
          const unsplitItem = await MenuItem.new({
            id: "unsplit",
            text: `Unsplit (return to Phase ${row.sourcePhaseCode ?? ""})`.trim(),
            action: () => {
              if (row.splitId) handleSplitRevert(row.splitId);
            },
          });
          items.push(unsplitItem);
        } else {
          const phases = data?.phasesByWbs?.[row.wbsId] ?? [];

          const moveItem = await MenuItem.new({
            id: "move-to-phase",
            text: "Move to Phase\u2026",
            enabled: phases.length > 0 && row.quantity > 0,
            action: () => {
              setReassignDialog({
                open: true,
                activityId: row.id,
                activityDescription: row.description,
                currentPhaseId: row.phaseId,
                availablePhases: phases,
                // Cap the dialog's quantity input at the source row's
                // *effective* remaining budget (after any prior splits).
                availableQuantity: row.quantity,
                unit: row.unit,
              });
            },
          });
          items.push(moveItem);

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

          // Added (non-MCP) activities can be edited or deleted (#26). MCP-native
          // estimate rows are read-only and never get these items.
          if (row.source && row.source !== "estimate") {
            const sep = await PredefinedMenuItem.new({ item: "Separator" });
            const editItem = await MenuItem.new({
              id: "edit-activity",
              text: "Edit Activity…",
              action: () => {
                setEditActivityDialog({ open: true, activityId: row.id });
              },
            });
            const deleteItem = await MenuItem.new({
              id: "delete-activity",
              text: "Delete Activity…",
              action: () => {
                setDeleteActivityConfirm({
                  open: true,
                  activityId: row.id,
                  description: row.description,
                });
              },
            });
            items.push(sep, editItem, deleteItem);
          }
        }

        if (items.length === 0) return;
        const menu = await Menu.new({ items });
        await menu.popup();
      } catch (error) {
        console.error("Context menu error:", error);
      }
    },
    [data?.phasesByWbs, handlePhaseRevert, handleSplitRevert]
  );

  /** Right-click a phase row \u2192 "Add Activity" (+ "Delete Phase" for added phases). */
  const handlePhaseContextMenu = React.useCallback(
    async (phaseId: string, wbsId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const phase = data?.phasesByWbs?.[wbsId]?.find((p) => p.id === phaseId);
        const phaseDescription = data?.phaseSummaries?.[phaseId]?.description ?? "this phase";
        const items: Array<MenuItem | PredefinedMenuItem> = [];

        const addItem = await MenuItem.new({
          id: "add-activity",
          text: "Add Activity\u2026",
          action: () => {
            setAddActivityDialog({ open: true, phaseId, phaseDescription });
          },
        });
        items.push(addItem);

        // Only phases added in Momentum (not native MCP-import phases) can be
        // edited or deleted; change orders also get a status/type editor (#30).
        if (phase && phase.source !== "estimate") {
          const separator = await PredefinedMenuItem.new({ item: "Separator" });
          items.push(separator);

          const editPhaseItem = await MenuItem.new({
            id: "edit-phase",
            text: "Edit Phase…",
            action: () => {
              setEditPhaseDialog({
                open: true,
                phase: {
                  phaseId,
                  phaseCode: phase.code,
                  description: data?.phaseSummaries?.[phaseId]?.description ?? "",
                },
              });
            },
          });
          items.push(editPhaseItem);

          if (phase.source === "change_order") {
            const coItem = await MenuItem.new({
              id: "co-details",
              text: "Change Order Details\u2026",
              action: () => {
                const ps = data?.phaseSummaries?.[phaseId];
                setCoDetailsDialog({
                  open: true,
                  phaseId,
                  phaseCode: phase.code,
                  description: ps?.description ?? "",
                  status: ps?.changeOrderStatus ?? "submitted",
                  type: ps?.changeOrderType ?? "none",
                });
              },
            });
            items.push(coItem);
          }

          const deleteItem = await MenuItem.new({
            id: "delete-phase",
            text: "Delete Phase\u2026",
            action: () => {
              setDeletePhaseConfirm({ open: true, phaseId, phaseCode: phase.code });
            },
          });
          items.push(deleteItem);
        }

        const menu = await Menu.new({ items });
        await menu.popup();
      } catch (error) {
        console.error("Phase context menu error:", error);
      }
    },
    [data?.phaseSummaries, data?.phasesByWbs]
  );

  /**
   * Right-click a WBS row \u2192 "Add Phase". Available on any WBS.
   *
   * Phases added under the Change Orders WBS become change-order phases; phases
   * added under an estimate WBS become field-added phases. Both are
   * project-owned (the estimate is never touched) and carry a user-assigned
   * phase code.
   */
  const handleWbsContextMenu = React.useCallback(
    async (wbsId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const wbs = data?.wbsSummaries?.[wbsId];
      if (!wbs) return;
      try {
        const isChangeOrder = wbs.source === "change_order";
        const wbsCode = wbs.code ?? "";
        const phasesUnderWbs = data?.phasesByWbs?.[wbsId] ?? [];
        // Change orders get a smart default code (next 300000-NNN) + name;
        // estimate WBS leave the code blank (the dialog hints the band).
        let suggestedPhaseCode = "";
        let suggestedDescription = "";
        if (isChangeOrder) {
          const next = phasesUnderWbs.length + 1;
          suggestedPhaseCode = `${wbsCode || "300000"}-${String(next).padStart(3, "0")}`;
          suggestedDescription = `Change Order ${next}`;
        }
        const addItem = await MenuItem.new({
          id: "add-phase",
          text: "Add Phase\u2026",
          action: () => {
            setAddPhaseDialog({
              open: true,
              wbsId,
              wbsCode,
              isChangeOrder,
              suggestedPhaseCode,
              suggestedDescription,
            });
          },
        });
        const menu = await Menu.new({ items: [addItem] });
        await menu.popup();
      } catch (error) {
        console.error("WBS context menu error:", error);
      }
    },
    [data?.wbsSummaries, data?.phasesByWbs]
  );

  if (data === undefined) return <WorkbookSkeleton />;

  if (data === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <p className="text-title3 font-semibold text-muted-foreground">Project not found</p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  /* ── Access denied — scoped project, user has no assignment ── */
  if (data.scopeInfo?.isScoped && !data.scopeInfo.hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <p className="text-title3 font-semibold text-foreground">Access Restricted</p>
        <p className="text-body text-muted-foreground text-center max-w-sm">
          You don&apos;t have access to this project&apos;s workbook. Contact a project
          administrator to request access.
        </p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const isViewer = data.scopeInfo?.effectiveRole === "viewer";
  const filteredRows = wbsFilter ? data.rows.filter((r) => r.wbsCode === wbsFilter) : data.rows;

  return (
    <div className="flex flex-col h-full gap-4 min-w-0 overflow-hidden">
      {/* ── Page header — title + date controls ── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-title3 font-semibold tracking-tight">Workbook</h1>
          <span className="inline-flex items-center rounded-full bg-fill-quaternary px-2 py-0.5 text-subheadline font-medium text-muted-foreground tabular-nums">
            {filteredRows.length}
          </span>
          <span className="text-body text-muted-foreground">{data.project.proposalNumber}</span>
          {wbsFilter && (
            <Badge variant="secondary" className="gap-1 h-5 px-1.5 text-subheadline">
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
            onDateChange={handleDateChange}
            placeholder="Entry date"
            toDate={new Date()}
            formatStr="MMMM do, yyyy"
            suffix={format(selectedDate, "EEEE")}
            align="end"
            className="w-auto"
            nonWorkDays={nonWorkDays}
          />
          {isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-subheadline"
              onClick={() => setHistoryOpen(true)}
            >
              <Clock className="h-3.5 w-3.5" />
              History
            </Button>
          )}
        </div>
      </div>

      {/* ── Workbook table ── */}
      <div className="flex-1 min-h-0 min-w-0">
        <WorkbookTable
          rows={filteredRows}
          wbsSummaries={data.wbsSummaries}
          phaseSummaries={data.phaseSummaries}
          entryDateLabel={dateLabel}
          existingEntries={isViewer ? undefined : existingEntries}
          onEntryCommit={isViewer ? undefined : handleEntryCommit}
          onEntryDiscard={isViewer ? undefined : handleEntryDiscard}
          existingNotes={isViewer ? undefined : existingNotes}
          onNoteSave={isViewer ? undefined : handleNoteSave}
          projectStats={{
            totalMH: data.project.totalMH,
            earnedMH: data.project.earnedMH,
            percentComplete: data.project.percentComplete,
            status: data.project.status,
          }}
          columnMode={isViewer ? "full" : columnMode}
          onColumnModeChange={isViewer ? undefined : setColumnMode}
          saveStates={isViewer ? undefined : saveStates}
          phasesByWbs={data.phasesByWbs}
          onRowContextMenu={handleRowContextMenu}
          onPhaseContextMenu={isViewer ? undefined : handlePhaseContextMenu}
          onWbsContextMenu={isViewer ? undefined : handleWbsContextMenu}
          showSourceMarkers={isAdmin}
          contributors={contributors ?? undefined}
        />
      </div>

      {/* ── Add Activity dialog (right-click a phase row) ── */}
      {addActivityDialog.open && (
        <AddActivityDialog
          open={addActivityDialog.open}
          onOpenChange={(open) => setAddActivityDialog((prev) => ({ ...prev, open }))}
          projectId={projectId as Id<"momentumProjects">}
          phaseId={addActivityDialog.phaseId as Id<"momentumPhases">}
          phaseDescription={addActivityDialog.phaseDescription}
        />
      )}

      {/* ── Add Phase dialog (right-click any WBS) ── */}
      {addPhaseDialog.open && (
        <AddPhaseDialog
          open={addPhaseDialog.open}
          onOpenChange={(open) => setAddPhaseDialog((prev) => ({ ...prev, open }))}
          wbsId={addPhaseDialog.wbsId as Id<"momentumWbs">}
          wbsCode={addPhaseDialog.wbsCode}
          isChangeOrder={addPhaseDialog.isChangeOrder}
          suggestedPhaseCode={addPhaseDialog.suggestedPhaseCode}
          suggestedDescription={addPhaseDialog.suggestedDescription}
        />
      )}

      {/* ── Change Order details editor (right-click a CO phase) ── */}
      <ChangeOrderDetailsDialog
        open={coDetailsDialog.open}
        onOpenChange={(open) => setCoDetailsDialog((prev) => ({ ...prev, open }))}
        phaseId={coDetailsDialog.phaseId ? (coDetailsDialog.phaseId as Id<"momentumPhases">) : null}
        phaseCode={coDetailsDialog.phaseCode}
        description={coDetailsDialog.description}
        status={coDetailsDialog.status}
        type={coDetailsDialog.type}
      />

      {/* ── Delete Phase confirmation ── */}
      <AlertDialog
        open={deletePhaseConfirm.open}
        onOpenChange={(open) => setDeletePhaseConfirm((prev) => ({ ...prev, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete phase {deletePhaseConfirm.phaseCode}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the phase and any activities under it. A phase with logged progress
              can&apos;t be deleted. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deletePhaseConfirm.phaseId) handleDeletePhase(deletePhaseConfirm.phaseId);
                setDeletePhaseConfirm((prev) => ({ ...prev, open: false }));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Edit Activity dialog (right-click an added activity row) — #26 ── */}
      <EditActivityDialog
        open={editActivityDialog.open}
        onOpenChange={(open) => setEditActivityDialog((prev) => ({ ...prev, open }))}
        activityId={editActivityDialog.activityId}
      />

      {/* ── Edit Phase dialog (right-click an added phase row) — #26 ── */}
      <EditPhaseDialog
        open={editPhaseDialog.open}
        onOpenChange={(open) => setEditPhaseDialog((prev) => ({ ...prev, open }))}
        phase={editPhaseDialog.phase}
      />

      {/* ── Delete Activity confirmation — #26 ── */}
      <AlertDialog
        open={deleteActivityConfirm.open}
        onOpenChange={(open) => setDeleteActivityConfirm((prev) => ({ ...prev, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this activity?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteActivityConfirm.description
                ? `"${deleteActivityConfirm.description}" will be removed. `
                : ""}
              An activity with logged progress can&apos;t be deleted. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteActivityConfirm.activityId)
                  handleDeleteActivity(deleteActivityConfirm.activityId);
                setDeleteActivityConfirm((prev) => ({ ...prev, open: false }));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Phase reassign / split dialog ── */}
      <PhaseReassignDialog
        open={reassignDialog.open}
        onOpenChange={(open) => setReassignDialog((prev) => ({ ...prev, open }))}
        activityId={reassignDialog.activityId}
        activityDescription={reassignDialog.activityDescription}
        currentPhaseId={reassignDialog.currentPhaseId}
        availablePhases={reassignDialog.availablePhases}
        availableQuantity={reassignDialog.availableQuantity}
        unit={reassignDialog.unit}
        onReassign={handlePhaseReassign}
        onAllocate={handleActivityAllocate}
      />

      {/* ── Entry history panel (admin only) ── */}
      {isAdmin && (
        <EntryHistoryPanel
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          history={historyData as HistoryDay[] | null | undefined}
          onDateSelect={handleHistoryDateSelect}
          hasMore={historyHasMore}
          onLoadMore={handleLoadMore}
        />
      )}

      {/* ── Non-work day confirmation dialog ── */}
      <AlertDialog open={!!pendingDate} onOpenChange={(open) => !open && setPendingDate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Non-work day selected</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDate && format(pendingDate, "EEEE, MMMM do")} is not a scheduled work day on
              your {workCalendar} calendar. Do you want to enter progress for this day anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDate) setSelectedDate(pendingDate);
                setPendingDate(null);
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
