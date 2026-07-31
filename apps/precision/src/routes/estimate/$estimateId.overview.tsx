import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { cn } from "@truss/ui/lib/utils";
import { SyncOriginNotice } from "@truss/features/estimation/sync-origin";
import { ProposalStatusChip } from "@truss/features/estimation/proposal-status";
import { Copy, Download } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Skeleton } from "@truss/ui/components/skeleton";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { DuplicateEstimateDialog } from "../../components/duplicate-estimate-dialog";
import { canEditPrecision } from "../../lib/permissions";
import { formatWbsLabel } from "../../config/shell-config-estimate";
import { useState, useCallback } from "react";

export const Route = createFileRoute("/estimate/$estimateId/overview")({
  component: EstimateOverviewPage,
});

const cfmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const mhfmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Overview — a read-only dashboard (Collin's IA decision: glance, don't
 * edit). Editing lives in Setup; the work lives behind the WBS rail. Every
 * number here is also a link into the place it came from.
 */
function EstimateOverviewPage() {
  const { estimateId } = Route.useParams();
  const proposalId = estimateId as Id<"proposals">;
  const convex = useConvex();
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);

  const proposal = useStableQuery(api.precision.getProposal, { proposalId });
  const wbsItems = useStableQuery(api.precision.getWBSListWithCosts, { proposalId });
  const summary = useStableQuery(api.precision.getProposalSummary, { proposalId });

  const [duplicateOpen, setDuplicateOpen] = useState(false);

  // Delegated to the estimate layout route, which owns the single export
  // implementation shared with the ⌘K entry and ⌘⇧E.
  const handleExport = useCallback(() => {
    document.dispatchEvent(new CustomEvent("export-estimate"));
  }, []);

  if (!proposal || !wbsItems || !summary) return <OverviewSkeleton />;

  // Setup's visibility toggles declutter this list too — but hidden work is
  // never silently dropped: the footnote below reconciles the bars with the
  // grand total whenever a hidden section carries cost.
  const visibleWbs = wbsItems.filter((w) => !w.isHidden);
  const hiddenWithCost = wbsItems.filter((w) => w.isHidden && w.costs.totalCost !== 0);
  const hiddenCost = hiddenWithCost.reduce((sum, w) => sum + w.costs.totalCost, 0);
  const maxWbsCost = Math.max(1, ...visibleWbs.map((w) => w.costs.totalCost));

  return (
    <div className="h-full overflow-auto py-4 px-1">
      <div className="max-w-3xl space-y-6">
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight truncate">
              <span className="font-mono text-muted-foreground">#{proposal.proposalNumber}</span>
              <span className="mx-1.5 text-foreground-subtle">—</span>
              {proposal.description}
              <ProposalStatusChip status={proposal.status} className="ml-2" />
            </h1>
            <SyncOriginNotice
              precisionOwnedAt={proposal.precisionOwnedAt ?? null}
              className="mt-1"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => setDuplicateOpen(true)}
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleExport}>
              <Download className="h-3 w-3" /> Export
            </Button>
          </div>
        </div>

        {/* ── Headline metrics ── */}
        <div className="grid grid-cols-4 gap-3">
          <MetricCard label="Grand total" value={cfmt.format(summary.totalCost)} emphasis />
          <MetricCard
            label="Man-hours"
            value={mhfmt.format(summary.craftManHours + summary.welderManHours)}
          />
          <MetricCard
            label="Total labor"
            value={cfmt.format(summary.craftCost + summary.welderCost)}
          />
          <MetricCard label="Activities" value={String(summary.activityCount)} />
        </div>

        {/* ── Cost by WBS — each row is a link into the work ── */}
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Cost by work breakdown
          </h2>
          <div className="space-y-px">
            {visibleWbs.map((wbs) => {
              const share = wbs.costs.totalCost / maxWbsCost;
              return (
                <Link
                  key={wbs._id as string}
                  to="/estimate/$estimateId/wbs/$wbsId"
                  params={{ estimateId, wbsId: wbs._id as string }}
                  className="group flex h-8 items-center gap-3 rounded-md px-2 transition-colors hover:bg-fill-quaternary"
                  onMouseEnter={() =>
                    queueWarm(
                      () =>
                        void warmQuery(convex, api.precision.getPhaseListWithCosts, {
                          wbsId: wbs._id,
                        })
                    )
                  }
                  onMouseLeave={cancelWarm}
                >
                  <span className="w-56 truncate text-xs">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {wbs.wbsPoolId}
                    </span>{" "}
                    <span className="font-medium">
                      {formatWbsLabel(wbs.wbsPoolId, wbs.name).split(" · ")[1]}
                    </span>
                  </span>
                  {wbs.costs.totalCost > 0 ? (
                    <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-fill-secondary">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-primary/60 transition-all group-hover:bg-primary"
                        style={{ width: `${Math.max(1.5, share * 100)}%` }}
                      />
                    </span>
                  ) : (
                    // Zero rows stay quiet — a bed of empty tracks is noise.
                    <span className="flex-1" />
                  )}
                  <span
                    className={cn(
                      "w-24 text-right font-mono text-xs tabular-nums",
                      wbs.costs.totalCost === 0 && "text-foreground-subtle"
                    )}
                  >
                    {wbs.costs.totalCost === 0 ? "—" : cfmt.format(wbs.costs.totalCost)}
                  </span>
                </Link>
              );
            })}
          </div>
          {hiddenWithCost.length > 0 && (
            <p className="mt-2 px-2 text-[11px] text-muted-foreground">
              {hiddenWithCost.length} hidden {hiddenWithCost.length === 1 ? "section" : "sections"}{" "}
              carrying <span className="font-mono tabular-nums">{cfmt.format(hiddenCost)}</span> —
              still included in the totals above.{" "}
              <Link
                to="/estimate/$estimateId/setup"
                params={{ estimateId }}
                className="text-primary hover:underline"
              >
                Manage in Setup
              </Link>
            </p>
          )}
        </section>

        {/* ── Breakdown ── */}
        <section className="grid grid-cols-2 gap-6">
          <div>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Man-hours
            </h2>
            <BreakdownRow label="Craft" value={mhfmt.format(summary.craftManHours)} />
            <BreakdownRow label="Welder" value={mhfmt.format(summary.welderManHours)} />
            <BreakdownRow
              label="Total"
              value={mhfmt.format(summary.craftManHours + summary.welderManHours)}
              strong
            />
          </div>
          <div>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Costs
            </h2>
            <BreakdownRow
              label="Labor"
              value={cfmt.format(summary.craftCost + summary.welderCost)}
            />
            <BreakdownRow label="Material" value={cfmt.format(summary.materialCost)} />
            <BreakdownRow label="Equipment" value={cfmt.format(summary.equipmentCost)} />
            <BreakdownRow label="Subcontractor" value={cfmt.format(summary.subcontractorCost)} />
            <BreakdownRow label="Cost only" value={cfmt.format(summary.costOnlyCost)} />
            <BreakdownRow label="Grand total" value={cfmt.format(summary.totalCost)} strong />
          </div>
        </section>
      </div>

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
  );
}

function MetricCard({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-md bg-fill-quaternary px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-base tabular-nums",
          emphasis ? "font-semibold" : "font-medium"
        )}
      >
        {value}
      </p>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center justify-between text-xs",
        strong && "border-t font-medium"
      )}
    >
      <span className={cn(strong ? "text-foreground" : "text-muted-foreground")}>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="max-w-3xl space-y-6 px-1 py-4">
      <Skeleton className="h-5 w-64" />
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}
