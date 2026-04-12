import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
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
import { AddActivityDialog } from "../../components/add-activity-dialog";
import React, { useState, useCallback, useRef, useMemo } from "react";

export const Route = createFileRoute("/estimate/$estimateId/phase/$phaseId")({
  component: PhaseDetailPage,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TYPE_META: Record<
  string,
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
const nfmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fc(n: number): string {
  return n === 0 ? "—" : cfmt.format(n);
}
function fn(n: number): string {
  return n === 0 ? "—" : nfmt.format(n);
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface ActivityRow {
  _id: string;
  type: string;
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
  const proposal = useQuery(api.precision.getProposal, { proposalId: estimateId as never });
  const activities = useQuery(api.precision.getActivitiesWithCosts, { phaseId: phaseId as never });
  const updateActivity = useMutation(api.precision.updateActivity);
  const batchDelete = useMutation(api.precision.batchDeleteActivities);

  const [addOpen, setAddOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const updateRef = useRef(updateActivity);
  updateRef.current = updateActivity;

  // ── Cell edit commit ──
  const commit = useCallback((id: string, field: string, value: string) => {
    const numeric = new Set(["quantity", "unitPrice"]);
    if (numeric.has(field)) {
      const n = parseFloat(value);
      if (!isNaN(n)) updateRef.current({ activityId: id as never, [field]: n });
    } else {
      updateRef.current({ activityId: id as never, [field]: value });
    }
  }, []);

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
    const ids = Object.keys(rowSelection).filter((k) => rowSelection[k]);
    if (ids.length === 0) return;
    await batchDelete({ activityIds: ids as never[] });
    setRowSelection({});
  };

  // ── Column definitions ──
  const columns = useMemo<ColumnDef<ActivityRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")
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
      },
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
    [commit, nav]
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

  if (!proposal || !activities) return <PhaseDetailSkeleton />;

  return (
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-1">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <Link
            to="/estimate/$estimateId"
            params={{ estimateId }}
            className="hover:text-foreground transition-colors shrink-0"
          >
            #{proposal.proposalNumber}
          </Link>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
          <span className="font-medium text-foreground truncate">Phase</span>
          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {activities.length}
          </span>
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
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
                <Plus className="h-3 w-3" /> Add <ChevronDown className="h-2.5 w-2.5 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {Object.entries(TYPE_META).map(([type, m]) => {
                const Icon = m.icon;
                return (
                  <DropdownMenuItem key={type} onClick={() => setAddOpen(true)} className="gap-2">
                    <Icon className={cn("h-3.5 w-3.5", m.color)} /> {m.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Data Grid ── */}
      <div ref={gridRef} className="flex-1 min-h-0 overflow-auto border-y">
        <table className="w-full border-collapse text-xs">
          {/* Sticky header */}
          <thead className="sticky top-0 z-10 bg-muted">
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
                        : "bg-muted/30",
                    "hover:bg-accent/50"
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
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      onClick={() => setAddOpen(true)}
                    >
                      <Plus className="h-3 w-3" /> Add Activity
                    </Button>
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

      <AddActivityDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        phaseId={phaseId}
        estimateId={estimateId}
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
        <div className="h-8 bg-muted border-b" />
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className={cn("h-[30px] border-b border-border/40", i % 2 === 0 ? "" : "bg-muted/30")}
          >
            <Skeleton className="h-3 w-full mx-2 mt-2" />
          </div>
        ))}
      </div>
      <div className="h-10 border-t bg-card" />
    </div>
  );
}
