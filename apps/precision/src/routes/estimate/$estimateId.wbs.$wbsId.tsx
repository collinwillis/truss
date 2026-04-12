import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { cn } from "@truss/ui/lib/utils";
import { ChevronRight, Plus, Copy, Trash2, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Checkbox } from "@truss/ui/components/checkbox";
import { Skeleton } from "@truss/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { BottomPanel } from "@truss/features/estimation/bottom-panel";
import { AddPhaseDialog } from "../../components/add-phase-dialog";
import { useState, useMemo } from "react";

export const Route = createFileRoute("/estimate/$estimateId/wbs/$wbsId")({
  component: WBSDetailPage,
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const cfmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const nfmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function fc(n: number): string {
  return n === 0 ? "—" : cfmt.format(n);
}
function fn(n: number): string {
  return n === 0 ? "—" : nfmt.format(n);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function WBSDetailPage() {
  const { estimateId, wbsId } = Route.useParams();
  const navigate = useNavigate();

  const proposal = useQuery(api.precision.getProposal, { proposalId: estimateId as never });
  const phases = useQuery(api.precision.getPhaseListWithCosts, { wbsId: wbsId as never });

  const deletePhase = useMutation(api.precision.deletePhase);
  const duplicatePhase = useMutation(api.precision.duplicatePhase);

  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // WBS-level totals for the bottom panel
  const wbsTotals = useMemo(() => {
    if (!phases) return null;
    return phases.reduce(
      (acc, p) => ({
        craftManHours: acc.craftManHours + p.costs.craftManHours,
        welderManHours: acc.welderManHours + p.costs.welderManHours,
        craftCost: acc.craftCost + p.costs.craftCost,
        welderCost: acc.welderCost + p.costs.welderCost,
        materialCost: acc.materialCost + p.costs.materialCost,
        equipmentCost: acc.equipmentCost + p.costs.equipmentCost,
        subcontractorCost: acc.subcontractorCost + p.costs.subcontractorCost,
        costOnlyCost: acc.costOnlyCost + p.costs.costOnlyCost,
        totalCost: acc.totalCost + p.costs.totalCost,
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
  }, [phases]);

  if (!proposal || !phases) return <WBSSkeleton />;

  const handleDeleteSelected = async () => {
    for (const id of selected) {
      await deletePhase({ phaseId: id as never });
    }
    setSelected(new Set());
  };

  const handleDuplicate = async (phaseId: string, phaseNumber: number) => {
    const nextNum =
      phases.length > 0 ? Math.max(...phases.map((p) => p.phaseNumber)) + 1 : phaseNumber + 1;
    await duplicatePhase({ sourcePhaseId: phaseId as never, newPhaseNumber: nextNum });
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === phases.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(phases.map((p) => p._id)));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-1">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <Link
            to="/estimate/$estimateId"
            params={{ estimateId }}
            className="hover:text-foreground transition-colors shrink-0"
          >
            #{proposal.proposalNumber}
          </Link>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
          <span className="font-medium text-foreground truncate">Phases</span>
          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {phases.length}
          </span>
        </nav>

        <div className="flex items-center gap-1.5 shrink-0">
          {selected.size > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => {
                  const id = [...selected][0];
                  const ph = phases.find((p) => p._id === id);
                  if (ph) handleDuplicate(id, ph.phaseNumber);
                }}
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleDeleteSelected}
              >
                <Trash2 className="h-3 w-3" /> Delete {selected.size}
              </Button>
            </>
          )}
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setAddPhaseOpen(true)}>
            <Plus className="h-3 w-3" /> Add Phase
          </Button>
        </div>
      </div>

      {/* ── Phase data grid ── */}
      <div className="flex-1 min-h-0 overflow-auto border-y">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="h-8 w-8 px-2 border-b">
                <Checkbox
                  checked={selected.size === phases.length && phases.length > 0}
                  onCheckedChange={toggleAll}
                  className="h-3.5 w-3.5"
                />
              </th>
              <th className="h-8 w-8 px-1 border-b" />
              <th className="h-8 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-12">
                #
              </th>
              <th className="h-8 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b">
                Description
              </th>
              <th className="h-8 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-16">
                Size
              </th>
              <th className="h-8 px-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-16">
                Spec
              </th>
              <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-14">
                Items
              </th>
              <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
                Craft MH
              </th>
              <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
                Weld MH
              </th>
              <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-24">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {phases.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="h-32 text-center text-sm text-muted-foreground align-middle"
                >
                  No phases yet. Click "Add Phase" to start.
                </td>
              </tr>
            ) : (
              phases.map((phase, i) => (
                <tr
                  key={phase._id}
                  className={cn(
                    "h-[30px] cursor-pointer transition-colors",
                    selected.has(phase._id)
                      ? "bg-primary/5"
                      : i % 2 === 0
                        ? "bg-background"
                        : "bg-muted/20",
                    phase.isCompleted && "bg-emerald-50 dark:bg-emerald-950/20",
                    "hover:bg-accent/50"
                  )}
                  onClick={() =>
                    navigate({
                      to: "/estimate/$estimateId/phase/$phaseId",
                      params: { estimateId, phaseId: phase._id },
                    })
                  }
                >
                  {/* Checkbox */}
                  <td
                    className="px-2 border-b border-border/30"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selected.has(phase._id)}
                      onCheckedChange={() => toggleSelect(phase._id)}
                      className="h-3.5 w-3.5"
                    />
                  </td>

                  {/* Completed indicator */}
                  <td className="px-1 border-b border-border/30">
                    {phase.isCompleted ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground/20" />
                    )}
                  </td>

                  {/* Phase # */}
                  <td className="px-2 font-mono tabular-nums text-center border-b border-border/30">
                    {phase.phaseNumber}
                  </td>

                  {/* Description */}
                  <td className="px-2 font-medium truncate max-w-0 border-b border-border/30">
                    {phase.description}
                  </td>

                  {/* Size (piping) */}
                  <td className="px-2 text-muted-foreground border-b border-border/30">
                    {phase.pipingSpec?.size ?? ""}
                  </td>

                  {/* Spec (piping) */}
                  <td className="px-2 text-muted-foreground border-b border-border/30">
                    {phase.pipingSpec?.spec ?? ""}
                  </td>

                  {/* Items */}
                  <td className="px-2 text-right tabular-nums text-muted-foreground border-b border-border/30">
                    {phase.activityCount}
                  </td>

                  {/* Craft MH */}
                  <td className="px-2 text-right tabular-nums font-mono border-b border-border/30">
                    {fn(phase.costs.craftManHours)}
                  </td>

                  {/* Weld MH */}
                  <td className="px-2 text-right tabular-nums font-mono border-b border-border/30">
                    {fn(phase.costs.welderManHours)}
                  </td>

                  {/* Total */}
                  <td className="px-2 text-right tabular-nums font-mono font-medium border-b border-border/30">
                    {fc(phase.costs.totalCost)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Bottom Panel ── */}
      {wbsTotals && (
        <div className="shrink-0">
          <BottomPanel costs={wbsTotals} scope="Phase" itemCount={phases.length} />
        </div>
      )}

      <AddPhaseDialog
        open={addPhaseOpen}
        onOpenChange={setAddPhaseOpen}
        wbsId={wbsId}
        datasetVersion={proposal.datasetVersion as "v1" | "v2"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function WBSSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex h-10 items-center justify-between px-1">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="flex-1 border-y">
        <div className="h-8 bg-muted border-b" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={cn("h-[30px] border-b border-border/30", i % 2 !== 0 && "bg-muted/20")}
          >
            <Skeleton className="h-3 w-full mx-2 mt-2" />
          </div>
        ))}
      </div>
      <div className="h-10 border-t bg-card" />
    </div>
  );
}
