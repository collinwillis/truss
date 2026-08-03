import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvex, useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery, warmQuery } from "../../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { cn } from "@truss/ui/lib/utils";
import { Button } from "@truss/ui/components/button";
import { Checkbox } from "@truss/ui/components/checkbox";
import { Skeleton } from "@truss/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import {
  ChevronRight,
  Plus,
  ChevronDown,
  Copy,
  Download,
  Trash2,
  Wrench,
  Package,
  Truck,
  Building2,
  DollarSign,
  UserPen,
} from "lucide-react";
import { EditableCell } from "@truss/features/estimation/editable-cell";
import {
  InspectorToggle,
  TotalsInspector,
  useTotalsInspector,
} from "../../components/totals-inspector";
import { AddActivityDialog } from "@truss/features/activities";
import { CopyToPhaseDialog, type CopyTargetPhase } from "../../components/copy-to-phase-dialog";
import { ImportActivitiesDialog } from "../../components/import-activities-dialog";
import type { PhaseOption } from "../../components/phase-picker";
import { SelectionBar } from "../../components/selection-bar";
import { NumberCell, TextCell } from "../../components/activity-grid/cells";
import { cellId, useGridNavigation } from "../../components/activity-grid/use-grid-navigation";
import { ColumnMenu } from "../../components/activity-grid/column-menu";
import { isCellEditable } from "../../components/activity-grid/editability";
import {
  ACTIVITY_COLUMN_IDS,
  autoVisibility,
  loadOverrides,
  mergeVisibility,
  pruneOverrides,
  loadSizing,
  saveOverrides,
  saveSizing,
  sizingStorageKey,
  summarizeContents,
  UNHIDEABLE,
  visibilityStorageKey,
  type ActivityColumnId,
} from "../../components/activity-grid/visibility";
import type { ActivityPayload, ActivityType } from "@truss/features/activities";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { PhaseNavButtons, PhaseSwitcher, usePhaseSequence } from "../../components/phase-nav";
import { useNavigate } from "@tanstack/react-router";
import { canEditPrecision } from "../../lib/permissions";
import { formatPhaseLabel, formatWbsLabel } from "../../config/shell-config-estimate";
import { toast } from "sonner";
import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";

export const Route = createFileRoute("/estimate/$estimateId/phase/$phaseId")({
  component: PhaseDetailPage,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TYPE_META: Record<
  ActivityType,
  { label: string; icon: typeof Wrench; color: string; abbr: string }
> = {
  labor: { label: "Labor", icon: Wrench, color: "text-blue-600 dark:text-blue-400", abbr: "LBR" },
  custom_labor: {
    label: "Custom Labor",
    icon: UserPen,
    color: "text-sky-600 dark:text-sky-400",
    abbr: "CLB",
  },
  material: {
    label: "Material",
    icon: Package,
    color: "text-amber-600 dark:text-amber-400",
    abbr: "MAT",
  },
  equipment: {
    label: "Equipment",
    icon: Truck,
    color: "text-emerald-600 dark:text-emerald-400",
    abbr: "EQP",
  },
  subcontractor: {
    label: "Subcontractor",
    icon: Building2,
    color: "text-purple-600 dark:text-purple-400",
    abbr: "SUB",
  },
  cost_only: { label: "Cost Only", icon: DollarSign, color: "text-muted-foreground", abbr: "CST" },
};

const cfmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function fc(n: number): string {
  return n === 0 ? "—" : cfmt.format(n);
}

/** Menu labels — the header cells are elements, so they cannot be reused. */
const COLUMN_LABELS: Record<string, string> = {
  type: "Type",
  description: "Description",
  quantity: "Qty",
  unit: "Unit",
  time: "Duration",
  price: "Price",
  ownership: "Ownership",
  craftConstant: "Craft Const",
  craftManHours: "Craft MH",
  craftRate: "Craft Rate",
  craftCost: "Craft Cost",
  welderConstant: "Weld Const",
  welderManHours: "Weld MH",
  welderRate: "Weld Rate",
  welderCost: "Weld Cost",
  subsistenceRate: "Subsistence",
  materialCost: "Material",
  equipmentCost: "Equipment",
  subcontractorCost: "Subcontract",
  costOnlyCost: "Cost Only",
  totalCost: "Total",
};

/** Rates render with cents — a placeholder must look like the value it stands for. */
const rateFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Grid fields parsed as numbers before they are written back. */
const NUMERIC_FIELDS = new Set(["quantity", "unitPrice"]);

/** Order of the Add ▾ menu. Each entry opens the dialog on that activity type. */
const ADD_MENU_TYPES: readonly ActivityType[] = [
  "labor",
  "custom_labor",
  "material",
  "equipment",
  "subcontractor",
  "cost_only",
];

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface ActivityRow {
  _id: string;
  type: ActivityType;
  description: string;
  quantity: number;
  unit: string;
  sortOrder: number;
  labor?: {
    craftConstant: number;
    welderConstant: number;
    customCraftRate?: number | null;
    customSubsistenceRate?: number | null;
  };
  equipment?: { ownership: string; time: number };
  subcontractor?: { laborCost: number; materialCost: number; equipmentCost: number };
  unitPrice?: number;
  /** Server-resolved D6 eligibility — the same predicate the mutation enforces. */
  canOverrideRates: boolean;
  costs: {
    craftManHours: number;
    welderManHours: number;
    craftCost: number;
    welderCost: number;
    materialCost: number;
    equipmentCost: number;
    subcontractorCost: number;
    costOnlyCost: number;
    totalCost: number;
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function PhaseDetailPage() {
  const { estimateId, phaseId } = Route.useParams();

  // Route params are plain strings; Convex wants branded ids. Cast once, named,
  // rather than `as never` at each call site — `never` is assignable to
  // anything, so it silences a genuinely wrong table just as happily as the
  // string/brand mismatch it was meant to paper over. The raw string params are
  // still what <Link params> needs.
  const proposalId = estimateId as Id<"proposals">;
  const typedPhaseId = phaseId as Id<"phases">;
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);
  const sequence = usePhaseSequence(proposalId, phaseId);
  const proposal = useStableQuery(api.precision.getProposal, { proposalId });
  const activities = useStableQuery(api.precision.getActivitiesWithCosts, {
    phaseId: typedPhaseId,
  });
  // Feeds the toolbar's grand-total chip and the inspector's Estimate section.
  const summary = useStableQuery(api.precision.getProposalSummary, { proposalId });
  const [inspectorOpen, toggleInspector] = useTotalsInspector();

  // Breadcrumb sources. Fetching the whole WBS list instead of this phase's one
  // WBS keeps both reads parallel — chaining `getWBS` on `phase.wbsId` would cost
  // an extra round-trip — and the shell already subscribes to it for the sidebar.
  const phase = useStableQuery(api.precision.getPhase, { phaseId: typedPhaseId });
  const wbsList = useStableQuery(api.precision.getWBSForProposal, { proposalId });
  const wbs = phase && wbsList ? wbsList.find((w) => w._id === phase.wbsId) : undefined;
  const convex = useConvex();

  // Warm both sequence neighbors so `[` / `]` paging (and the chevrons) land
  // on correct data instantly instead of showing the previous phase for a
  // round-trip. Re-runs as the user moves, always keeping the frontier warm.
  useEffect(() => {
    for (const neighbor of [sequence.prev, sequence.next]) {
      if (!neighbor) continue;
      const neighborId = neighbor.phaseId as Id<"phases">;
      void warmQuery(convex, api.precision.getPhase, { phaseId: neighborId });
      void warmQuery(convex, api.precision.getActivitiesWithCosts, { phaseId: neighborId });
    }
  }, [sequence.prev, sequence.next, convex]);
  const updateActivity = useMutation(api.precision.updateActivity);
  const batchDelete = useMutation(api.precision.batchDeleteActivities);
  const addActivity = useMutation(api.precision.addActivity);
  const copyActivities = useMutation(api.precision.copyActivitiesToPhase);
  const navigate = useNavigate();
  const [copyOpen, setCopyOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // The dialog reads its opening type once, on mount, so the chosen menu item is
  // carried alongside `open` and the dialog is only rendered while open.
  const [addDialog, setAddDialog] = useState<{ open: boolean; type: ActivityType }>({
    open: false,
    type: "labor",
  });

  // A live revoke unmounts the dialogs; also clear their open flags so a later
  // re-grant doesn't pop one open unprompted.
  useEffect(() => {
    if (!canEdit) {
      setAddDialog((prev) => (prev.open ? { ...prev, open: false } : prev));
      setCopyOpen(false);
      setImportOpen(false);
    }
  }, [canEdit]);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});

  // SELECTION IS PER-PHASE. A param-only navigation keeps this component
  // mounted, so without this reset the previous phase's ids stay selected —
  // invisible (no row matches them) yet counted by the toolbar. Copy would be
  // refused by the server's source-phase check, but Delete would be HONORED:
  // batchDeleteActivities deliberately accepts ids across estimates, so the
  // phantom "Delete N" destroyed another phase's rows.
  useEffect(() => {
    setRowSelection({});
  }, [phaseId]);
  const gridRef = useRef<HTMLDivElement>(null);
  const updateRef = useRef(updateActivity);
  updateRef.current = updateActivity;

  // Catalogs for the shared Add Activity dialog. Labor is scoped to this phase's
  // pool type; equipment is global. Both are skipped while the dialog is closed
  // so opening a phase does not pull two reference tables it may never show.
  // Gated on `phase` rather than on `phase.phasePoolId` being truthy, which is
  // what the old inline dialog did. A pool id of 0 would previously have skipped
  // the query and shown an empty catalog forever. Measured: 0 of 3,000 phases
  // carry 0 or a missing id (lowest in production is 10001), so this is a no-op
  // today — but gating on presence rather than truthiness is the correct rule.
  const activityLaborPool = useQuery(
    api.precision.getLaborPool,
    addDialog.open && phase
      ? {
          datasetVersion: proposal?.datasetVersion ?? "v1",
          phasePoolId: phase.phasePoolId,
        }
      : "skip"
  );
  const activityEquipmentPool = useQuery(
    api.precision.getEquipmentPool,
    addDialog.open ? { datasetVersion: proposal?.datasetVersion ?? "v1" } : "skip"
  );

  /** Supply the phase id the shared dialog deliberately doesn't know about. */
  const handleAddActivity = useCallback(
    async (payload: ActivityPayload) => {
      if (!canEdit) return;
      await addActivity({ ...payload, phaseId: typedPhaseId });
    },
    [addActivity, typedPhaseId, canEdit]
  );

  // ── Cell edit commit ──
  // The canEdit guard is defense in depth behind the cells' readOnly flag —
  // one choke point covers every editable cell, and the server refuses anyway.
  const commit = useCallback(
    async (id: string, field: string, value: string) => {
      if (!canEdit) return;
      let next: string | number = value;
      if (NUMERIC_FIELDS.has(field)) {
        const n = parseFloat(value);
        // Unparseable input used to be dropped silently, so a typo was
        // indistinguishable from a saved edit.
        if (isNaN(n)) {
          toast.error("Invalid number", {
            description: `"${value}" could not be read as a number, so nothing was saved.`,
          });
          return;
        }
        next = n;
      }

      try {
        await updateRef.current({ activityId: id as Id<"activities">, [field]: next });
      } catch (error) {
        toast.error("Failed to save activity", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit]
  );

  /**
   * Commit a per-activity rate override (D3): an empty cell CLEARS back to the
   * proposal's rate, and a number — including 0, a real $0.00/hr — sets. The
   * whole labor object goes with the write, so the sibling override is carried
   * through explicitly rather than being dropped by omission.
   */
  const commitRateOverride = useCallback(
    async (
      row: ActivityRow,
      field: "customCraftRate" | "customSubsistenceRate",
      raw: string,
      rejected: boolean
    ) => {
      if (!canEdit || !row.labor) return;
      // A number input hands back "" for keystrokes it refused ("5e"). Clearing
      // the override on a typo would silently re-price the line.
      if (rejected) {
        toast.error("Invalid rate", { description: "That entry could not be read as a number." });
        return;
      }
      const trimmed = raw.trim();
      const value = trimmed === "" ? null : parseFloat(trimmed);
      if (value !== null && isNaN(value)) {
        toast.error("Invalid rate", {
          description: `"${raw}" could not be read as a number, so nothing was saved.`,
        });
        return;
      }

      try {
        await updateRef.current({
          activityId: row._id as Id<"activities">,
          labor: {
            craftConstant: row.labor.craftConstant,
            welderConstant: row.labor.welderConstant,
            customCraftRate:
              field === "customCraftRate" ? value : (row.labor.customCraftRate ?? null),
            customSubsistenceRate:
              field === "customSubsistenceRate" ? value : (row.labor.customSubsistenceRate ?? null),
          },
        });
      } catch (error) {
        toast.error("Failed to save rate override", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit]
  );

  /**
   * Commit one nested field (labor / equipment / subcontractor).
   *
   * Sends ONLY the changed key — the server merges over what is stored, so a
   * craft-constant edit can no longer take that line's rate overrides with it.
   */
  const commitNested = useCallback(
    async (
      row: ActivityRow,
      group: "labor" | "equipment" | "subcontractor",
      field: string,
      raw: string,
      rejected?: boolean
    ) => {
      if (!canEdit) return;
      if (rejected) {
        toast.error("Invalid number", { description: "That entry could not be read as a number." });
        return;
      }
      const value = field === "ownership" ? raw : parseFloat(raw.trim());
      if (typeof value === "number" && isNaN(value)) {
        toast.error("Invalid number", {
          description: `"${raw}" could not be read as a number, so nothing was saved.`,
        });
        return;
      }
      try {
        await updateRef.current({
          activityId: row._id as Id<"activities">,
          [group]: { [field]: value },
        });
      } catch (error) {
        toast.error("Failed to save", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit]
  );

  const selCount = Object.values(rowSelection).filter(Boolean).length;

  /** Copy the selected lines into the picked phase, then offer the trip. */
  const copyingRef = useRef(false);
  const handleCopyTo = async (target: CopyTargetPhase) => {
    if (!canEdit) return;
    // A second Enter can land before the dialog's close-state applies —
    // without this guard it would send the copy twice.
    if (copyingRef.current) return;
    copyingRef.current = true;
    // Pruned against what is actually loaded: another client may have deleted
    // a selected row while the picker was open. The server's refuse-don't-skip
    // contract stays intact for ids we cannot see are gone.
    const live = new Set<string>((activities ?? []).map((a) => a._id as string));
    const ids = Object.keys(rowSelection).filter((k) => rowSelection[k] && live.has(k));
    setCopyOpen(false);
    if (ids.length === 0) {
      copyingRef.current = false;
      return;
    }
    try {
      const inserted = await copyActivities({
        sourcePhaseId: typedPhaseId,
        targetPhaseId: target.phaseId as Id<"phases">,
        activityIds: ids as Id<"activities">[],
      });
      setRowSelection({});
      // Warm the destination so the toast's "Open" lands instantly.
      void warmQuery(convex, api.precision.getPhase, {
        phaseId: target.phaseId as Id<"phases">,
      });
      void warmQuery(convex, api.precision.getActivitiesWithCosts, {
        phaseId: target.phaseId as Id<"phases">,
      });
      toast.success(
        `${inserted.length} ${inserted.length === 1 ? "activity" : "activities"} copied to ${target.label}`,
        {
          action: {
            label: "Open",
            onClick: () =>
              void navigate({
                to: "/estimate/$estimateId/phase/$phaseId",
                params: { estimateId, phaseId: target.phaseId },
              }),
          },
        }
      );
    } catch (error) {
      toast.error("Failed to copy activities", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      copyingRef.current = false;
    }
  };

  /**
   * Pull lines from another phase into this one. Same server mutation as the
   * copy direction with source and target swapped — one write path, so the
   * takeoff-flag fidelity and target-derived wbsId hold either way.
   */
  const handleImport = async (
    sourcePhase: PhaseOption,
    activityIds: string[]
  ): Promise<boolean> => {
    if (!canEdit) return false;
    try {
      const inserted = await copyActivities({
        sourcePhaseId: sourcePhase.phaseId as Id<"phases">,
        targetPhaseId: typedPhaseId,
        activityIds: activityIds as Id<"activities">[],
      });
      toast.success(
        `${inserted.length} ${inserted.length === 1 ? "activity" : "activities"} imported from ${sourcePhase.label}`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void batchDelete({ activityIds: inserted }).catch(() =>
                toast.error("Couldn't undo the import")
              );
            },
          },
        }
      );
      return true;
    } catch (error) {
      toast.error("Failed to import activities", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      return false;
    }
  };

  const handleDelete = async () => {
    if (!canEdit) return;
    const live = new Set<string>((activities ?? []).map((a) => a._id as string));
    const ids = Object.keys(rowSelection).filter((k) => rowSelection[k] && live.has(k));
    if (ids.length === 0) return;
    try {
      await batchDelete({ activityIds: ids as Id<"activities">[] });
      toast.success(ids.length === 1 ? "Activity deleted" : `${ids.length} activities deleted`);
      setRowSelection({});
    } catch (error) {
      toast.error("Failed to delete activities", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  const craftBaseRate = proposal?.rates.craftBaseRate ?? 0;
  const subsistenceRate = proposal?.rates.subsistenceRate ?? 0;
  const weldBaseRate = proposal?.rates.weldBaseRate ?? 0;

  // ── Column visibility: template baseline → data reveal → user override ──
  const storageKey = visibilityStorageKey(estimateId, wbs?.wbsPoolId);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Re-read when the WBS changes: preferences are per work breakdown, and a
  // param-only navigation keeps this component mounted.
  useEffect(() => {
    setOverrides(loadOverrides(storageKey));
  }, [storageKey]);

  const auto = useMemo(
    () => autoVisibility(wbs?.wbsPoolId, summarizeContents((activities as ActivityRow[]) ?? [])),
    [wbs?.wbsPoolId, activities]
  );
  const columnVisibility = useMemo(() => mergeVisibility(auto, overrides), [auto, overrides]);

  const handleVisibilityChange = useCallback(
    (updater: React.SetStateAction<Record<string, boolean>>) => {
      setOverrides((prev) => {
        const merged = mergeVisibility(auto, prev);
        const next = typeof updater === "function" ? updater(merged) : updater;
        // Only what disagrees with the automatic answer is remembered, so a
        // column the user never touched keeps following the data.
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

  // ── Spreadsheet navigation ──
  // Built from the table's own rows and VISIBLE columns, so hiding a column
  // changes where Tab goes, and Enter walks a column the way estimators
  // actually enter quantities.
  const orderedRows = useMemo(
    () => ((activities as ActivityRow[]) ?? []).map((a) => a._id),
    [activities]
  );
  const rowTypeById = useMemo(() => {
    const map = new Map<string, { type: ActivityType; canOverrideRates: boolean }>();
    for (const a of (activities as ActivityRow[]) ?? [])
      map.set(a._id, { type: a.type, canOverrideRates: a.canOverrideRates });
    return map;
  }, [activities]);
  // Derived from the visibility model rather than from the table: the table
  // needs the columns, the columns need `nav`, and `nav` needs this — reading
  // it from the same source the table will use breaks that cycle without
  // letting the two disagree (ACTIVITY_COLUMN_IDS is the declared order).
  const visibleColumnIds = useMemo(
    () => ACTIVITY_COLUMN_IDS.filter((id) => columnVisibility[id] !== false),
    [columnVisibility]
  );
  const isEditableCell = useCallback(
    (rowId: string, columnId: string) => {
      const meta = rowTypeById.get(rowId);
      if (!meta) return false;
      return isCellEditable(columnId as ActivityColumnId, meta.type, {
        canEdit,
        canOverrideRates: meta.canOverrideRates,
      });
    },
    [rowTypeById, canEdit]
  );
  const nav = useGridNavigation({
    rowIds: orderedRows,
    columnIds: visibleColumnIds,
    isEditable: isEditableCell,
  });

  // ── Column definitions ──
  /**
   * Every column the template defines, always DECLARED — TanStack decides
   * which are shown from `columnVisibility` (see activity-grid/visibility.ts).
   * Declaring them conditionally would make a hidden column unreachable from
   * the column menu, which is the one place a user can bring it back.
   *
   * Editability is per ROW, not per column: `isCellEditable` resolves the
   * activity type against legacy's allowlists, so Craft Cost is computed on a
   * labor line and typed on a subcontractor line.
   */
  const columns = useMemo<ColumnDef<ActivityRow>[]>(() => {
    /** A numeric cell that is only editable on some rows. */
    const numeric = (
      id: ActivityColumnId,
      header: string,
      read: (row: ActivityRow) => number,
      commitCell: (row: ActivityRow, raw: string, rejected?: boolean) => void,
      opts: { size: number; currency?: boolean } = { size: 80 }
    ): ColumnDef<ActivityRow> => ({
      id,
      header: () => <span className="block text-right">{header}</span>,
      size: opts.size,
      enableHiding: !UNHIDEABLE.has(id),
      cell: ({ row }) => {
        const editable = isCellEditable(id, row.original.type, {
          canEdit,
          canOverrideRates: row.original.canOverrideRates,
        });
        return (
          <NumberCell
            editable={editable}
            cellId={cellId(row.original._id, id)}
            value={read(row.original)}
            currency={opts.currency}
            onCommit={(v, rejected) => commitCell(row.original, v, rejected)}
            onKeyDown={nav}
          />
        );
      },
    });

    return [
      // Selection exists only to feed the selection bar, so the whole column
      // goes with it below "write".
      ...(canEdit
        ? [
            {
              id: "select",
              enableHiding: false,
              header: ({ table }) => (
                <Checkbox
                  checked={
                    table.getIsAllRowsSelected() ||
                    (table.getIsSomeRowsSelected() && "indeterminate")
                  }
                  onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
                  className="h-4 w-4"
                />
              ),
              cell: ({ row }) => (
                <Checkbox
                  checked={row.getIsSelected()}
                  onCheckedChange={(v) => row.toggleSelected(!!v)}
                  className="h-4 w-4"
                />
              ),
              size: 36,
            } satisfies ColumnDef<ActivityRow>,
          ]
        : []),
      {
        id: "type",
        header: () => <span>Type</span>,
        size: 48,
        // The code alone. An icon per row was six competing glyphs down a
        // column nobody scans — the description says what the line is; this
        // is a tiebreaker, so it reads as a quiet ticker symbol.
        cell: ({ row }) => {
          const m = TYPE_META[row.original.type];
          if (!m) return null;
          return (
            <span
              className="flex h-full items-center px-2 font-mono text-footnote tracking-wide text-foreground-subtle"
              title={m.label}
            >
              {m.abbr}
            </span>
          );
        },
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        // A real width, used only once the estimator drags it. Until then the
        // column is `auto` and absorbs the leftover row — see the render.
        size: 280,
        minSize: 160,
        enableHiding: false,
        cell: ({ row }) => (
          <TextCell
            editable={canEdit}
            cellId={cellId(row.original._id, "description")}
            value={row.original.description}
            onCommit={(v) => commit(row.original._id, "description", v)}
            onKeyDown={nav}
          />
        ),
      },
      numeric(
        "quantity",
        "Qty",
        (r) => r.quantity,
        (r, v) => commit(r._id, "quantity", v),
        {
          size: 72,
        }
      ),
      {
        id: "unit",
        accessorKey: "unit",
        header: "Unit",
        size: 56,
        cell: ({ row }) => {
          const editable = isCellEditable("unit", row.original.type, {
            canEdit,
            canOverrideRates: row.original.canOverrideRates,
          });
          return (
            <TextCell
              editable={editable}
              cellId={cellId(row.original._id, "unit")}
              value={row.original.unit}
              onCommit={(v) => commit(row.original._id, "unit", v)}
              onKeyDown={nav}
            />
          );
        },
      },
      numeric(
        "time",
        "Duration",
        (r) => r.equipment?.time ?? 0,
        (r, v, rejected) => void commitNested(r, "equipment", "time", v, rejected),
        { size: 76 }
      ),
      numeric(
        "price",
        "Price",
        (r) => r.unitPrice ?? 0,
        (r, v) => commit(r._id, "unitPrice", v),
        { size: 84, currency: true }
      ),
      {
        id: "ownership",
        header: () => <span>Ownership</span>,
        size: 88,
        cell: ({ row }) => (
          <span className="flex h-full items-center px-2 text-xs capitalize text-muted-foreground">
            {row.original.equipment?.ownership ?? "—"}
          </span>
        ),
      },
      numeric(
        "craftConstant",
        "Craft Const",
        (r) => r.labor?.craftConstant ?? 0,
        (r, v, rejected) => void commitNested(r, "labor", "craftConstant", v, rejected),
        { size: 88 }
      ),
      numeric(
        "craftManHours",
        "Craft MH",
        (r) => r.costs.craftManHours,
        () => {},
        { size: 76 }
      ),
      {
        id: "craftRate",
        header: () => <span className="block text-right">Craft Rate</span>,
        size: 88,
        cell: ({ row }) => (
          <RateOverrideCell
            row={row.original}
            field="customCraftRate"
            columnId="craftRate"
            inherited={craftBaseRate}
            canEdit={canEdit}
            onCommit={commitRateOverride}
            onKeyDown={nav}
          />
        ),
      },
      numeric(
        "craftCost",
        "Craft Cost",
        (r) => r.costs.craftCost,
        (r, v, rejected) => void commitNested(r, "subcontractor", "laborCost", v, rejected),
        { size: 88, currency: true }
      ),
      numeric(
        "welderConstant",
        "Weld Const",
        (r) => r.labor?.welderConstant ?? 0,
        (r, v, rejected) => void commitNested(r, "labor", "welderConstant", v, rejected),
        { size: 92 }
      ),
      numeric(
        "welderManHours",
        "Weld MH",
        (r) => r.costs.welderManHours,
        () => {},
        { size: 76 }
      ),
      // Welder base has no per-line override (D6 covers craft and subsistence
      // only), so it reports the estimate's rate — the template asks for the
      // number to be visible, not editable.
      {
        id: "welderRate",
        header: () => <span className="block text-right">Weld Rate</span>,
        size: 92,
        cell: () => (
          <span className="flex h-full items-center justify-end px-2 font-mono text-xs tabular-nums text-muted-foreground">
            {weldBaseRate === 0 ? "—" : rateFmt.format(weldBaseRate)}
          </span>
        ),
      },
      numeric(
        "welderCost",
        "Weld Cost",
        (r) => r.costs.welderCost,
        () => {},
        {
          size: 92,
          currency: true,
        }
      ),
      {
        id: "subsistenceRate",
        header: () => <span className="block text-right">Subsistence</span>,
        size: 92,
        cell: ({ row }) => (
          <RateOverrideCell
            row={row.original}
            field="customSubsistenceRate"
            columnId="subsistenceRate"
            inherited={subsistenceRate}
            canEdit={canEdit}
            onCommit={commitRateOverride}
            onKeyDown={nav}
          />
        ),
      },
      numeric(
        "materialCost",
        "Material",
        (r) => r.costs.materialCost,
        (r, v, rejected) => void commitNested(r, "subcontractor", "materialCost", v, rejected),
        { size: 88, currency: true }
      ),
      numeric(
        "equipmentCost",
        "Equipment",
        (r) => r.costs.equipmentCost,
        (r, v, rejected) => void commitNested(r, "subcontractor", "equipmentCost", v, rejected),
        { size: 88, currency: true }
      ),
      numeric(
        "subcontractorCost",
        "Subcontract",
        (r) => r.costs.subcontractorCost,
        () => {},
        {
          size: 96,
          currency: true,
        }
      ),
      numeric(
        "costOnlyCost",
        "Cost Only",
        (r) => r.costs.costOnlyCost,
        () => {},
        {
          size: 88,
          currency: true,
        }
      ),
      {
        id: "totalCost",
        header: () => <span className="block text-right font-semibold">Total</span>,
        size: 96,
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex h-full items-center justify-end px-2 font-mono text-xs font-semibold tabular-nums text-foreground">
            {fc(row.original.costs.totalCost)}
          </div>
        ),
      },
    ];
  }, [
    canEdit,
    commit,
    nav,
    commitNested,
    craftBaseRate,
    subsistenceRate,
    weldBaseRate,
    commitRateOverride,
  ]);

  // ── Table instance ──
  const table = useReactTable({
    data: (activities as ActivityRow[]) ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: handleVisibilityChange,
    onColumnSizingChange: handleSizingChange,
    enableColumnResizing: true,
    // 'onChange' tracks the pointer; the memoized body below is what keeps
    // that affordable, per the sizing guide.
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 48, maxSize: 600 },
    getRowId: (r) => r._id,
    // Controlled ONLY — the docs warn that passing columnVisibility in both
    // `state` and `initialState` silently ignores the latter.
    state: { rowSelection, columnVisibility, columnSizing },
  });

  /**
   * Column widths as CSS variables, computed ONCE per size change.
   *
   * Straight from the sizing guide: calling `column.getSize()` on every header
   * and every data cell is the expensive way to do this — a 40-row phase with
   * 20 columns is 800 calls per frame while dragging. The table element
   * carries the variables; cells just read theirs.
   */
  // Computed inline rather than memoized: the sizing guide's warning is about
  // calling getSize() on every CELL — a 40-row phase would be ~800 calls per
  // frame while dragging — which the CSS variables below eliminate. This is
  // one pass over ~20 headers, and memoizing it would require the table's
  // sizing state in a dependency array the hooks lint cannot verify.
  /**
   * Description is the one column with no natural width — its content is a
   * free-text line item, so any fixed number is either cramped or wasteful.
   * It stays `auto` and absorbs whatever the sized columns leave, which is
   * how a spreadsheet behaves, until the estimator drags it; after that their
   * width is the answer and it is honoured like any other.
   */
  const descriptionIsSized = columnSizing.description !== undefined;
  const cellWidth = (columnId: string, sizeVar: string): React.CSSProperties =>
    columnId === "description" && !descriptionIsSized
      ? { width: "auto", minWidth: 160 }
      : { width: sizeVar };

  const columnSizeVars: Record<string, string> = {};
  for (const header of table.getFlatHeaders()) {
    columnSizeVars[`--header-${header.id}-size`] = `${header.getSize()}px`;
    columnSizeVars[`--col-${header.column.id}-size`] = `${header.column.getSize()}px`;
  }

  // ── Phase totals ──
  const totals = useMemo(() => {
    if (!activities) return null;
    return activities.reduce(
      (a, x) => ({
        craftManHours: a.craftManHours + x.costs.craftManHours,
        welderManHours: a.welderManHours + x.costs.welderManHours,
        craftCost: a.craftCost + x.costs.craftCost,
        welderCost: a.welderCost + x.costs.welderCost,
        materialCost: a.materialCost + x.costs.materialCost,
        equipmentCost: a.equipmentCost + x.costs.equipmentCost,
        subcontractorCost: a.subcontractorCost + x.costs.subcontractorCost,
        costOnlyCost: a.costOnlyCost + x.costs.costOnlyCost,
        totalCost: a.totalCost + x.costs.totalCost,
      }),
      {
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
  }, [activities]);

  if (!proposal || !activities || !phase || !wbs) return <PhaseDetailSkeleton />;

  const wbsLabel = formatWbsLabel(wbs.wbsPoolId, wbs.name);
  const phaseLabel = formatPhaseLabel(phase.phaseNumber, phase.description);

  return (
    <div className="flex h-full">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* ── Toolbar ── */}
        <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-3">
          {/* Breadcrumb: #1744 › 70000 · AG PIPING › 12 — CARBON STEEL */}
          <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <Link
              to="/estimate/$estimateId/overview"
              params={{ estimateId }}
              className="hover:text-foreground transition-colors shrink-0"
            >
              #{proposal.proposalNumber}
            </Link>
            <ChevronRight className="h-3 w-3 shrink-0 text-foreground-subtle" />
            <Link
              to="/estimate/$estimateId/wbs/$wbsId"
              params={{ estimateId, wbsId: wbs._id }}
              title={wbsLabel}
              className="hover:text-foreground transition-colors truncate max-w-[40%]"
              onMouseEnter={() =>
                void warmQuery(convex, api.precision.getPhaseListWithCosts, { wbsId: phase.wbsId })
              }
            >
              {wbsLabel}
            </Link>
            <ChevronRight className="h-3 w-3 shrink-0 text-foreground-subtle" />
            <PhaseSwitcher
              estimateId={estimateId}
              currentPhaseId={phaseId}
              currentLabel={phaseLabel}
              siblings={sequence.siblings}
            />
            <span className="ml-1 shrink-0 rounded bg-fill-secondary px-1.5 py-0.5 text-footnote font-medium tabular-nums text-muted-foreground">
              {activities.length}
            </span>
          </nav>

          {/* One right cluster: navigation, edit actions, panel toggle
              outermost — the IDE convention. Navigation renders for every
              permission level; edit actions are gated. */}
          <div className="flex items-center gap-1 shrink-0">
            <PhaseNavButtons estimateId={estimateId} sequence={sequence} />
            <div className="mx-1 h-4 w-px bg-border" />
            {canEdit && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="lg">
                      <Plus className="h-3 w-3" /> Add{" "}
                      <ChevronDown className="h-2.5 w-2.5 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {ADD_MENU_TYPES.map((type) => {
                      const m = TYPE_META[type];
                      const Icon = m.icon;
                      return (
                        <DropdownMenuItem
                          key={type}
                          onClick={() => setAddDialog({ open: true, type })}
                          className="gap-2"
                        >
                          <Icon className={cn("h-3.5 w-3.5", m.color)} /> {m.label}
                        </DropdownMenuItem>
                      );
                    })}
                    {/* Importing a phase's worth of lines is another way to
                        ADD — so it lives where the hand already goes, and
                        needs no selection to start. */}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setImportOpen(true)} className="gap-2">
                      <Download className="h-3.5 w-3.5 text-muted-foreground" /> Import from phase…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <div className="mx-1 h-4 w-px bg-border" />
              </>
            )}
            <ColumnMenu
              table={table}
              labelFor={(id) => COLUMN_LABELS[id] ?? id}
              onReset={resetVisibility}
              isCustomized={Object.keys(overrides).length > 0}
            />
            <InspectorToggle
              grandTotal={summary?.totalCost}
              open={inspectorOpen}
              onToggle={toggleInspector}
            />
          </div>
        </div>

        {/* ── Data Grid ── */}
        <div ref={gridRef} className="flex-1 min-h-0 overflow-auto border-y">
          {/* Widths travel as CSS variables so cells never call getSize(). */}
          {/*
            `w-full` + `min-width: total` is what lets description flex WITHOUT
            collapsing. Wider container: the table is 100% and the auto
            description absorbs the slack. Narrower: the table falls back to
            the sum of every column's width, so each keeps its size —
            description included — and the grid scrolls sideways instead of
            crushing the one column that holds the words. (A min-width on the
            cell itself is ignored in a fixed-layout table; the floor has to
            live on the table.)
          */}
          <table
            className="w-full table-fixed border-collapse text-xs"
            style={{ ...columnSizeVars, minWidth: table.getTotalSize() }}
          >
            {/* Sticky header */}
            <thead className="sticky top-0 z-10 bg-fill-secondary">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th
                      key={h.id}
                      className="group relative h-8 whitespace-nowrap border-b px-2 text-left text-footnote font-semibold uppercase tracking-wider text-muted-foreground"
                      style={cellWidth(h.column.id, `var(--header-${h.id}-size)`)}
                    >
                      {h.isPlaceholder
                        ? null
                        : flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getCanResize() && (
                        <span
                          // Double-click restores this column's default —
                          // the way out of a drag that went wrong.
                          onDoubleClick={() => h.column.resetSize()}
                          onMouseDown={h.getResizeHandler()}
                          onTouchStart={h.getResizeHandler()}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${COLUMN_LABELS[h.column.id] ?? h.column.id}`}
                          className={cn(
                            "absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize touch-none select-none",
                            "opacity-0 transition-opacity group-hover:opacity-100",
                            h.column.getIsResizing() ? "bg-primary opacity-100" : "bg-border-strong"
                          )}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>

            <tbody>
              {table.getRowModel().rows.length > 0
                ? table.getRowModel().rows.map((row, i) => (
                    <tr
                      key={row.id}
                      className={cn(
                        "h-[30px] transition-colors",
                        // Hover steps one tint past the zebra stripe and
                        // DEEPENS selection instead of erasing it.
                        row.getIsSelected()
                          ? "bg-primary/5 hover:bg-primary/10"
                          : cn(
                              i % 2 === 0 ? "bg-background" : "bg-fill-quaternary",
                              "hover:bg-fill-tertiary"
                            )
                      )}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className="border-b border-border/40 px-0 py-0"
                          style={cellWidth(cell.column.id, `var(--col-${cell.column.id}-size)`)}
                        >
                          {/* Wrapper ensures consistent height for all cell types */}
                          <div className="flex h-[30px] items-center px-1">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))
                : null}
              {/* Ghost add row — the next action lives where the list ends
                  (the Notion/Linear pattern), not only up in the toolbar. */}
              {activities.length > 0 && canEdit && (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="border-b border-border/40 p-0"
                  >
                    <button
                      type="button"
                      onClick={() => setAddDialog({ open: true, type: "labor" })}
                      className="flex h-[30px] w-full items-center gap-1.5 px-3 text-xs text-muted-foreground/70 transition-colors hover:bg-fill-quaternary hover:text-foreground"
                    >
                      <Plus className="h-3 w-3" /> Add activity
                    </button>
                  </td>
                </tr>
              )}
              {activities.length === 0 && (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length}
                    className="h-40 text-center align-middle"
                  >
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <p className="text-sm">No activities in this phase</p>
                      {/* An empty phase is exactly where importing pays off —
                          "I built this before in 40001" — so both ways to
                          fill it are offered side by side. */}
                      {canEdit && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="lg"
                            onClick={() => setAddDialog({ open: true, type: "labor" })}
                          >
                            <Plus className="h-3 w-3" /> Add Activity
                          </Button>
                          <Button variant="ghost" size="lg" onClick={() => setImportOpen(true)}>
                            <Download className="h-3 w-3" /> Import from phase…
                          </Button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Anchored to the column, NOT the scroll container — inside it the
            bar would scroll away with the rows. */}
        {canEdit && (
          <SelectionBar count={selCount} noun="activity" onClear={() => setRowSelection({})}>
            <Button variant="ghost" size="lg" onClick={() => setCopyOpen(true)}>
              <Copy className="h-3 w-3" /> Copy to…
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={handleDelete}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
          </SelectionBar>
        )}

        {canEdit && (
          <ImportActivitiesDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            proposalId={proposalId}
            currentPhaseId={phaseId}
            onImport={handleImport}
          />
        )}
        {canEdit && (
          <CopyToPhaseDialog
            open={copyOpen}
            onOpenChange={setCopyOpen}
            proposalId={proposalId}
            currentPhaseId={phaseId}
            count={selCount}
            onPick={(target) => void handleCopyTo(target)}
          />
        )}
        {canEdit && addDialog.open && (
          <AddActivityDialog
            open={addDialog.open}
            onOpenChange={(open) => setAddDialog((prev) => ({ ...prev, open }))}
            phaseDescription={phaseLabel}
            laborPool={activityLaborPool}
            equipmentPool={activityEquipmentPool}
            onSubmit={handleAddActivity}
            initialType={addDialog.type}
          />
        )}
      </div>

      {totals && (
        <TotalsInspector
          scopeLabel={phaseLabel}
          scopeCosts={totals}
          summary={summary}
          open={inspectorOpen}
        />
      )}
    </div>
  );
}

/**
 * One rate-override cell.
 *
 * Shows the rate the line is actually USING: the estimate's rate when nothing
 * is set here, the override when there is one — marked by the same dot the
 * takeoff cell uses, so "set on this row" reads identically across the app.
 * Clearing the cell writes `null`, which is what returns it to inheriting.
 */
function RateOverrideCell({
  row,
  field,
  columnId,
  inherited,
  canEdit,
  onCommit,
  onKeyDown,
}: {
  row: ActivityRow;
  field: "customCraftRate" | "customSubsistenceRate";
  /** The COLUMN id — navigation addresses cells by column, not by field. */
  columnId: ActivityColumnId;
  inherited: number;
  canEdit: boolean;
  onCommit: (
    row: ActivityRow,
    field: "customCraftRate" | "customSubsistenceRate",
    raw: string,
    rejected: boolean
  ) => Promise<void>;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  // Ineligible lines say so with a dash rather than an empty cell, which in a
  // column of money would read as zero.
  if (!row.canOverrideRates || !row.labor) {
    return (
      <span
        className="flex h-full items-center justify-end pr-2 text-foreground-subtle"
        title="Rate overrides are limited to custom labor, SUPPORT, and standby phases"
      >
        —
      </span>
    );
  }

  const override = row.labor[field] ?? null;
  const inheritedLabel = rateFmt.format(inherited);

  return (
    <div
      className="flex h-full items-center"
      title={
        override !== null
          ? "Set on this line — clear the cell to use the estimate's rate"
          : `Using the estimate's rate (${inheritedLabel}) — type to override just this line`
      }
    >
      <EditableCell
        type="number"
        cellId={cellId(row._id, columnId)}
        // EMPTY means inheriting. Showing the inherited rate as the VALUE would
        // let a pass-through commit pin it silently; as a placeholder there is
        // nothing to commit, and D3's three states stay distinct on screen.
        value={override}
        placeholder={inheritedLabel}
        displayFormat="currency"
        readOnly={!canEdit}
        onCommit={(v, rejected) => void onCommit(row, field, v, rejected ?? false)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function PhaseDetailSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex h-10 items-center justify-between px-1">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="flex-1 border-y">
        <div className="h-8 bg-fill-secondary border-b" />
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-[30px] border-b border-border/40",
              i % 2 === 0 ? "" : "bg-fill-quaternary"
            )}
          >
            <Skeleton className="h-3 w-full mx-2 mt-2" />
          </div>
        ))}
      </div>
      <div className="h-10 border-t bg-card" />
    </div>
  );
}
