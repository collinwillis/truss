import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
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
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import {
  ChevronRight,
  Plus,
  ChevronDown,
  Trash2,
  Wrench,
  Package,
  Truck,
  Building2,
  DollarSign,
  UserPen,
} from "lucide-react";
import { EditableCell } from "@truss/features/estimation/editable-cell";
import { BottomPanel } from "@truss/features/estimation/bottom-panel";
import { AddActivityDialog } from "@truss/features/activities";
import type { ActivityPayload, ActivityType } from "@truss/features/activities";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { PhaseNavButtons, PhaseSwitcher, usePhaseSequence } from "../../components/phase-nav";
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
  labor: { label: "Labor", icon: Wrench, color: "text-blue-500", abbr: "LBR" },
  custom_labor: { label: "Custom Labor", icon: UserPen, color: "text-blue-400", abbr: "CLB" },
  material: { label: "Material", icon: Package, color: "text-amber-500", abbr: "MAT" },
  equipment: { label: "Equipment", icon: Truck, color: "text-emerald-500", abbr: "EQP" },
  subcontractor: { label: "Subcontractor", icon: Building2, color: "text-purple-500", abbr: "SUB" },
  cost_only: { label: "Cost Only", icon: DollarSign, color: "text-gray-500", abbr: "CST" },
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
    customCraftRate?: number;
    customSubsistenceRate?: number;
  };
  equipment?: { ownership: string; time: number };
  subcontractor?: { laborCost: number; materialCost: number; equipmentCost: number };
  unitPrice?: number;
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
  const proposal = useQuery(api.precision.getProposal, { proposalId });
  const activities = useQuery(api.precision.getActivitiesWithCosts, { phaseId: typedPhaseId });

  // Breadcrumb sources. Fetching the whole WBS list instead of this phase's one
  // WBS keeps both reads parallel — chaining `getWBS` on `phase.wbsId` would cost
  // an extra round-trip — and the shell already subscribes to it for the sidebar.
  const phase = useQuery(api.precision.getPhase, { phaseId: typedPhaseId });
  const wbsList = useQuery(api.precision.getWBSForProposal, { proposalId });
  const wbs = phase && wbsList ? wbsList.find((w) => w._id === phase.wbsId) : undefined;
  const updateActivity = useMutation(api.precision.updateActivity);
  const batchDelete = useMutation(api.precision.batchDeleteActivities);
  const addActivity = useMutation(api.precision.addActivity);

  // The dialog reads its opening type once, on mount, so the chosen menu item is
  // carried alongside `open` and the dialog is only rendered while open.
  const [addDialog, setAddDialog] = useState<{ open: boolean; type: ActivityType }>({
    open: false,
    type: "labor",
  });

  // A live revoke unmounts the dialog; also clear its open flag so a later
  // re-grant doesn't pop it open unprompted.
  useEffect(() => {
    if (!canEdit) setAddDialog((prev) => (prev.open ? { ...prev, open: false } : prev));
  }, [canEdit]);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
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

  // ── Tab/Enter navigation ──
  const nav = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!gridRef.current || (e.key !== "Tab" && e.key !== "Enter")) return;
    const cells = Array.from(
      gridRef.current.querySelectorAll<HTMLInputElement>("input[data-cell-id]")
    );
    const cur = (e.target as HTMLInputElement).getAttribute("data-cell-id");
    const idx = cells.findIndex((el) => el.getAttribute("data-cell-id") === cur);
    const next = idx + (e.shiftKey ? -1 : 1);
    if (next >= 0 && next < cells.length) cells[next]!.focus();
  }, []);

  const selCount = Object.values(rowSelection).filter(Boolean).length;
  const handleDelete = async () => {
    if (!canEdit) return;
    const ids = Object.keys(rowSelection).filter((k) => rowSelection[k]);
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

  // ── Column definitions ──
  const columns = useMemo<ColumnDef<ActivityRow>[]>(
    () => [
      // Selection exists only to feed the Delete toolbar button, so the whole
      // column goes with it below "write".
      ...(canEdit
        ? [
            {
              id: "select",
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
        cell: ({ row }) => {
          const m = TYPE_META[row.original.type];
          if (!m) return null;
          const Icon = m.icon;
          return (
            <div className="flex items-center gap-1" title={m.label}>
              <Icon className={cn("h-3 w-3 shrink-0", m.color)} />
              <span className="text-[10px] font-medium text-muted-foreground">{m.abbr}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "description",
        header: "Description",
        size: 999, // flex
        cell: ({ row }) => (
          <EditableCell
            type="text"
            cellId={`${row.original._id}-d`}
            value={row.original.description}
            readOnly={!canEdit}
            onCommit={(v) => commit(row.original._id, "description", v)}
            onKeyDown={nav}
          />
        ),
      },
      {
        accessorKey: "quantity",
        header: () => <span className="block text-right">Qty</span>,
        size: 72,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-q`}
            value={row.original.quantity}
            readOnly={!canEdit}
            onCommit={(v) => commit(row.original._id, "quantity", v)}
            onKeyDown={nav}
          />
        ),
      },
      {
        accessorKey: "unit",
        header: "Unit",
        size: 48,
        cell: ({ row }) => (
          <span className="flex h-full items-center text-[11px] text-muted-foreground">
            {row.original.unit}
          </span>
        ),
      },
      {
        id: "craftMH",
        header: () => <span className="block text-right">Craft MH</span>,
        size: 72,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-cmh`}
            value={row.original.costs.craftManHours}
            readOnly
          />
        ),
      },
      {
        id: "weldMH",
        header: () => <span className="block text-right">Weld MH</span>,
        size: 72,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-wmh`}
            value={row.original.costs.welderManHours}
            readOnly
          />
        ),
      },
      {
        id: "craftCost",
        header: () => <span className="block text-right">Craft $</span>,
        size: 88,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-cc`}
            value={row.original.costs.craftCost}
            displayFormat="currency"
            readOnly
          />
        ),
      },
      {
        id: "matCost",
        header: () => <span className="block text-right">Mat $</span>,
        size: 88,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-mc`}
            value={row.original.costs.materialCost}
            displayFormat="currency"
            readOnly
          />
        ),
      },
      {
        id: "equipCost",
        header: () => <span className="block text-right">Equip $</span>,
        size: 88,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-ec`}
            value={row.original.costs.equipmentCost}
            displayFormat="currency"
            readOnly
          />
        ),
      },
      {
        id: "subCost",
        header: () => <span className="block text-right">Sub $</span>,
        size: 88,
        cell: ({ row }) => (
          <EditableCell
            type="number"
            cellId={`${row.original._id}-sc`}
            value={row.original.costs.subcontractorCost}
            displayFormat="currency"
            readOnly
          />
        ),
      },
      {
        id: "total",
        header: () => <span className="block text-right font-semibold">Total</span>,
        size: 96,
        cell: ({ row }) => (
          <div className="flex h-full items-center justify-end px-2 text-xs font-mono tabular-nums font-semibold text-foreground">
            {fc(row.original.costs.totalCost)}
          </div>
        ),
      },
    ],
    [canEdit, commit, nav]
  );

  // ── Table instance ──
  const table = useReactTable({
    data: (activities as ActivityRow[]) ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    onRowSelectionChange: setRowSelection,
    getRowId: (r) => r._id,
    state: { rowSelection },
  });

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
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-1">
        {/* Breadcrumb: #1744 › 70000 · AG PIPING › 12 — CARBON STEEL */}
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <Link
            to="/estimate/$estimateId"
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
          <span className="ml-1 shrink-0 rounded bg-fill-secondary px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {activities.length}
          </span>
        </nav>

        {/* Navigation is read functionality; edit actions are gated below. */}
        <div className="flex items-center gap-1.5 shrink-0">
          <PhaseNavButtons estimateId={estimateId} sequence={sequence} />
          {canEdit && (
            <>
              {selCount > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={handleDelete}
                >
                  <Trash2 className="h-3 w-3" /> Delete {selCount}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="h-7 gap-1 text-xs">
                    <Plus className="h-3 w-3" /> Add{" "}
                    <ChevronDown className="h-2.5 w-2.5 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
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
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      {/* ── Data Grid ── */}
      <div ref={gridRef} className="flex-1 min-h-0 overflow-auto border-y">
        <table className="w-full border-collapse text-xs">
          {/* Sticky header */}
          <thead className="sticky top-0 z-10 bg-fill-secondary">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="h-8 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b"
                    style={{
                      width: h.column.id === "description" ? undefined : h.getSize(),
                      minWidth: h.column.id === "description" ? 200 : undefined,
                    }}
                  >
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>

          <tbody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row, i) => (
                <tr
                  key={row.id}
                  className={cn(
                    "h-[30px] transition-colors",
                    row.getIsSelected()
                      ? "bg-primary/5"
                      : i % 2 === 0
                        ? "bg-background"
                        : "bg-fill-quaternary",
                    "hover:bg-fill-quaternary"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-0 py-0 border-b border-border/40"
                      style={{
                        width: cell.column.id === "description" ? undefined : cell.column.getSize(),
                      }}
                    >
                      {/* Wrapper ensures consistent height for all cell types */}
                      <div className="flex h-[30px] items-center px-1">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length} className="h-40 text-center align-middle">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <p className="text-sm">No activities in this phase</p>
                    {canEdit && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        onClick={() => setAddDialog({ open: true, type: "labor" })}
                      >
                        <Plus className="h-3 w-3" /> Add Activity
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Bottom Panel ── */}
      {totals && (
        <div className="shrink-0">
          <BottomPanel costs={totals} scope="Activity" itemCount={activities.length} />
        </div>
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
