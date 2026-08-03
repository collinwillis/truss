import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { cn } from "@truss/ui/lib/utils";
import { Plus, Copy, Trash2, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Checkbox } from "@truss/ui/components/checkbox";
import { Skeleton } from "@truss/ui/components/skeleton";
import {
  InspectorToggle,
  TotalsInspector,
  useTotalsInspector,
} from "../../components/totals-inspector";
import { EditableCell } from "@truss/features/estimation/editable-cell";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { AddPhaseDialog } from "../../components/add-phase-dialog";
import { SelectionBar } from "../../components/selection-bar";
import { canEditPrecision } from "../../lib/permissions";
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
  const warmPhase = (phaseId: string) => {
    const typedPhaseId = phaseId as Id<"phases">;
    void warmQuery(convex, api.precision.getPhase, { phaseId: typedPhaseId });
    void warmQuery(convex, api.precision.getActivitiesWithCosts, { phaseId: typedPhaseId });
  };
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

  /**
   * Commit a takeoff override. Empty input clears the override (back to the
   * derived sum) — the D3 contract: `null` clears, a number (including 0)
   * sets.
   */
  const commitTakeoff = async (phaseId: Id<"phases">, raw: string) => {
    if (!canEdit) return;
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : parseFloat(trimmed);
    if (value !== null && isNaN(value)) {
      toast.error("Invalid number", {
        description: `"${raw}" could not be read as a number, so nothing was saved.`,
      });
      return;
    }
    try {
      await updatePhase({ phaseId, takeoffQuantity: value });
    } catch (error) {
      toast.error("Failed to save takeoff", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

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

  // Piping-spec columns render only when the data exists — empty Size/Spec
  // columns were eating width while descriptions truncated.
  const showPipingColumns = phases.some((p) => p.pipingSpec?.size || p.pipingSpec?.spec);
  const columnCount = (canEdit ? 10 : 9) + (showPipingColumns ? 2 : 0);

  const handleDeleteSelected = async () => {
    if (!canEdit) return;
    const ids = [...selected];
    if (ids.length === 0) return;

    // Deleted one at a time, so a mid-loop failure leaves the earlier phases
    // already gone. Track what actually succeeded and clear exactly those from
    // the selection — clearing all of it would hide the failure, and clearing
    // none of it would leave deleted rows checked.
    const deleted: string[] = [];
    try {
      for (const id of ids) {
        await deletePhase({ phaseId: id as Id<"phases"> });
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

          {/* One right-aligned cluster: selection actions, Add, then the
              panel toggle outermost — the IDE convention for panel controls.
              Edit affordances are withheld below "write". */}
          <div className="flex shrink-0 items-center gap-1">
            {canEdit && (
              /* Outline, not primary — persistent chrome stays quiet; the
                 saturated blue is reserved for dialog confirms. */
              <Button variant="outline" size="lg" onClick={() => setAddPhaseOpen(true)}>
                <Plus className="h-3 w-3" /> Add Phase
              </Button>
            )}
            <InspectorToggle
              grandTotal={summary?.totalCost}
              open={inspectorOpen}
              onToggle={toggleInspector}
            />
          </div>
        </div>

        {/* ── Phase data grid ── */}
        <div className="flex-1 min-h-0 overflow-auto border-y">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-fill-secondary">
              <tr>
                {/* Selection exists only to feed Duplicate/Delete, so the whole
                  column goes with them below "write". */}
                {canEdit && (
                  <th className="h-8 w-8 px-2 border-b">
                    <Checkbox
                      checked={selected.size === phases.length && phases.length > 0}
                      onCheckedChange={toggleAll}
                      className="h-3.5 w-3.5"
                    />
                  </th>
                )}
                <th className="h-8 w-8 px-1 border-b" />
                <th className="h-8 px-2 text-left text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-12">
                  #
                </th>
                <th className="h-8 px-2 text-left text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b">
                  Description
                </th>
                <th className="h-8 px-2 text-left text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-16">
                  Size
                </th>
                <th className="h-8 px-2 text-left text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-16">
                  Spec
                </th>
                <th className="h-8 px-2 text-right text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
                  Quantity
                </th>
                <th className="h-8 px-2 text-left text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-12">
                  Unit
                </th>
                <th className="h-8 px-2 text-right text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-14">
                  Items
                </th>
                <th className="h-8 px-2 text-right text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
                  Craft MH
                </th>
                <th className="h-8 px-2 text-right text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
                  Weld MH
                </th>
                <th className="h-8 px-2 text-right text-footnote font-semibold uppercase tracking-wider text-muted-foreground border-b w-24">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {phases.length === 0 ? (
                <tr>
                  <td
                    colSpan={columnCount}
                    className="h-32 text-center text-sm text-muted-foreground align-middle"
                  >
                    {canEdit ? 'No phases yet. Click "Add Phase" to start.' : "No phases yet."}
                  </td>
                </tr>
              ) : (
                phases.map((phase, i) => (
                  <tr
                    key={phase._id}
                    className={cn(
                      "h-[30px] cursor-pointer transition-colors",
                      // Hover steps one tint past the zebra stripe and
                      // DEEPENS selection instead of erasing it.
                      selected.has(phase._id)
                        ? "bg-primary/5 hover:bg-primary/10"
                        : cn(
                            i % 2 === 0 ? "bg-background" : "bg-fill-quaternary",
                            "hover:bg-fill-tertiary"
                          )
                    )}
                    onMouseEnter={() => queueWarm(() => warmPhase(phase._id))}
                    onMouseLeave={cancelWarm}
                    onClick={() =>
                      navigate({
                        to: "/estimate/$estimateId/phase/$phaseId",
                        params: { estimateId, phaseId: phase._id },
                      })
                    }
                  >
                    {/* Checkbox */}
                    {canEdit && (
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
                    )}

                    {/* Completed indicator */}
                    <td className="px-1 border-b border-border/30">
                      {phase.isCompleted ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success-text" />
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

                    {/* Quantity (D-takeoff): derived from flagged lines, editable
                      to override; clearing the cell returns to the derived
                      sum. The dot marks an override. */}
                    <td
                      className="px-1 text-right border-b border-border/30"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {phase.takeoff ? (
                        <div className="flex items-center justify-end gap-1">
                          {phase.takeoff.isOverridden && (
                            <span
                              title="Manually set — clear the cell to return to the computed sum"
                              className="h-1 w-1 shrink-0 rounded-full bg-primary"
                            />
                          )}
                          <EditableCell
                            type="number"
                            cellId={`takeoff-${phase._id}`}
                            value={phase.takeoff.quantity}
                            readOnly={!canEdit}
                            onCommit={(v) => commitTakeoff(phase._id, v)}
                          />
                        </div>
                      ) : (
                        <span className="pr-2 text-foreground-subtle">—</span>
                      )}
                    </td>

                    {/* Unit (from the phase catalog) */}
                    <td className="px-2 text-muted-foreground border-b border-border/30">
                      {phase.takeoff?.unit ?? ""}
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
              {/* Ghost add row — the next action lives where the list ends. */}
              {phases.length > 0 && canEdit && (
                <tr>
                  <td colSpan={columnCount} className="border-b border-border/30 p-0">
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
            </tbody>
          </table>
        </div>

        {/* Anchored to the column, NOT the scroll container — inside it the
            bar would scroll away with the rows. Duplicate takes exactly one
            phase, so it withdraws on a multi-selection rather than silently
            acting on the first. */}
        {canEdit && (
          <SelectionBar count={selected.size} noun="phase" onClear={() => setSelected(new Set())}>
            {selected.size === 1 && (
              <Button
                variant="ghost"
                size="lg"
                onClick={() => {
                  const [id] = selected;
                  if (!id) return;
                  const ph = phases.find((p) => p._id === id);
                  if (ph) handleDuplicate(id, ph.phaseNumber);
                }}
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              onClick={handleDeleteSelected}
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
            datasetVersion={proposal.datasetVersion as "v1" | "v2"}
          />
        )}
      </div>

      {wbsTotals && (
        <TotalsInspector
          scopeLabel={wbsLabel}
          scopeCosts={wbsTotals}
          summary={summary}
          open={inspectorOpen}
        />
      )}
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
