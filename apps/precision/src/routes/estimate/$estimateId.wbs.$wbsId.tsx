import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { cn } from "@truss/ui/lib/utils";
import { ChevronRight, Plus, Copy, Trash2, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Checkbox } from "@truss/ui/components/checkbox";
import { Skeleton } from "@truss/ui/components/skeleton";
import { BottomPanel } from "@truss/features/estimation/bottom-panel";
import { AddPhaseDialog } from "../../components/add-phase-dialog";
import { formatWbsLabel } from "../../config/shell-config-estimate";
import { toast } from "sonner";
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
  const phaseList = useQuery(api.precision.getPhaseListWithCosts, { wbsId: wbsId as never });

  // The whole WBS list rather than this one document: the shell already
  // subscribes to it for the sidebar, so the breadcrumb resolves from cache
  // instead of paying for a second round-trip.
  const wbsList = useQuery(api.precision.getWBSForProposal, { proposalId: estimateId as never });
  const wbs = wbsList?.find((w) => w._id === wbsId);

  const deletePhase = useMutation(api.precision.deletePhase);
  const duplicatePhase = useMutation(api.precision.duplicatePhase);

  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Defence in depth: Convex does not guarantee that a query's ordering survives
  // serialization (Momentum lost its WBS order that way, see the `#36` note in
  // workbook-table.tsx), so order by phase number on the client.
  const phases = useMemo(
    () => (phaseList ? [...phaseList].sort((a, b) => a.phaseNumber - b.phaseNumber) : undefined),
    [phaseList]
  );

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

  if (!proposal || !phases || !wbs) return <WBSSkeleton />;

  const wbsLabel = formatWbsLabel(wbs.wbsPoolId, wbs.name);

  const handleDeleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;

    // Deleted one at a time, so a mid-loop failure leaves the earlier phases
    // already gone. Track what actually succeeded and clear exactly those from
    // the selection — clearing all of it would hide the failure, and clearing
    // none of it would leave deleted rows checked.
    const deleted: string[] = [];
    try {
      for (const id of ids) {
        await deletePhase({ phaseId: id as never });
        deleted.push(id);
      }
      toast.success(ids.length === 1 ? "Phase deleted" : `${ids.length} phases deleted`);
    } catch (error) {
      toast.error(
        deleted.length === 0
          ? "Failed to delete phases"
          : `Deleted ${deleted.length} of ${ids.length} phases, then failed`,
        {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }
      );
    } finally {
      if (deleted.length > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of deleted) next.delete(id);
          return next;
        });
      }
    }
  };

  const handleDuplicate = async (phaseId: string, phaseNumber: number) => {
    const nextNum =
      phases.length > 0 ? Math.max(...phases.map((p) => p.phaseNumber)) + 1 : phaseNumber + 1;
    try {
      await duplicatePhase({ sourcePhaseId: phaseId as never, newPhaseNumber: nextNum });
      toast.success(`Phase ${nextNum} created`, {
        description: `Copied from phase ${phaseNumber}.`,
      });
    } catch (error) {
      toast.error("Failed to duplicate phase", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
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
        {/* Breadcrumb: #1744 › 70000 · AG PIPING */}
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <Link
            to="/estimate/$estimateId"
            params={{ estimateId }}
            className="hover:text-foreground transition-colors shrink-0"
          >
            #{proposal.proposalNumber}
          </Link>
          <ChevronRight className="h-3 w-3 shrink-0 text-foreground-subtle" />
          <span className="font-medium text-foreground truncate" title={wbsLabel}>
            {wbsLabel}
          </span>
          <span className="ml-1 rounded bg-fill-secondary px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
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
                  const [id] = selected;
                  if (!id) return;
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
          <thead className="sticky top-0 z-10 bg-fill-secondary">
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
                  No phases yet. Click &quot;Add Phase&quot; to start.
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
                        : "bg-fill-quaternary",
                    phase.isCompleted && "bg-emerald-50 dark:bg-emerald-950/20",
                    "hover:bg-fill-quaternary"
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
                      <Circle className="h-3.5 w-3.5 text-foreground-subtle" />
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
        <div className="h-8 bg-fill-secondary border-b" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-[30px] border-b border-border/30",
              i % 2 !== 0 && "bg-fill-quaternary"
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
