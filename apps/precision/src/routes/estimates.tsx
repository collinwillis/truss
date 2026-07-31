import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../lib/use-stable-query";
import { Plus, Search } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { SyncOriginBadge } from "@truss/features/estimation/sync-origin";
import {
  ProposalStatusChip,
  proposalStatusBarClasses,
} from "@truss/features/estimation/proposal-status";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Skeleton } from "@truss/ui/components/skeleton";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { CreateEstimateDialog } from "../components/create-estimate-dialog";
import { canEditPrecision } from "../lib/permissions";
import { useState, useEffect, useMemo } from "react";
import { format, differenceInDays } from "date-fns";

export const Route = createFileRoute("/estimates")({
  component: EstimatesPage,
});

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function EstimatesPage() {
  const navigate = useNavigate();
  const convex = useConvex();
  const { workspace } = useWorkspace();

  /**
   * Warm an estimate's whole opening path on row hover: the shell queries,
   * then — chained, since the redirect target isn't known until the WBS list
   * arrives — the first VISIBLE WBS's phase table, which is where opening
   * lands (hidden WBS leave the redirect too).
   */
  const warmEstimate = (id: string) => {
    const proposalId = id as Id<"proposals">;
    void warmQuery(convex, api.precision.getProposal, { proposalId });
    void warmQuery(convex, api.precision.getProposalSummary, { proposalId });
    void warmQuery(convex, api.precision.getWBSForProposal, { proposalId }).then((wbsList) => {
      const first = wbsList?.find((w) => !w.isHidden);
      if (first) void warmQuery(convex, api.precision.getPhaseListWithCosts, { wbsId: first._id });
    });
  };
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();
  const canEdit = canEditPrecision(workspace);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // The ⌘K "New Estimate" palette entry is hidden below "write", but the
  // listener guard also covers a stale event from a shell rendered before the
  // workspace settled. Clearing `createOpen` on revoke stops the dialog from
  // popping open unprompted if write is later re-granted.
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

  // Stats
  const stats = useMemo(() => {
    if (!proposals) return null;
    const total = proposals.length;
    const inProgress = proposals.filter(
      (p) => p.status === "bidding" || p.status === "open"
    ).length;
    const submitted = proposals.filter((p) => p.status === "submitted").length;
    const awarded = proposals.filter((p) => p.status === "awarded").length;
    const rejected = proposals.filter((p) => p.status === "rejected").length;
    const decided = awarded + rejected;
    const hitRate = decided > 0 ? Math.round((awarded / decided) * 100) : 0;
    return { total, inProgress, submitted, awarded, rejected, hitRate };
  }, [proposals]);

  // Status distribution for the bar
  const segments = useMemo(() => {
    if (!proposals || proposals.length === 0) return [];
    const counts: Record<string, number> = {};
    for (const p of proposals) {
      const s = p.status ?? "open";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return Object.entries(counts)
      .filter(([, c]) => c > 0)
      .map(([status, count]) => ({
        status,
        count,
        pct: (count / proposals.length) * 100,
      }));
  }, [proposals]);

  // Filter + search
  const filtered = useMemo(() => {
    if (!proposals) return [];
    return proposals
      .filter((p) => {
        if (statusFilter && p.status !== statusFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          return (
            p.description.toLowerCase().includes(q) ||
            p.proposalNumber.toLowerCase().includes(q) ||
            p.ownerName.toLowerCase().includes(q) ||
            (p.jobNumber ?? "").toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        const na = parseFloat(a.proposalNumber);
        const nb = parseFloat(b.proposalNumber);
        if (!isNaN(na) && !isNaN(nb)) return nb - na;
        return b.proposalNumber.localeCompare(a.proposalNumber);
      });
  }, [proposals, search, statusFilter]);

  if (!proposals || !stats) return <ListSkeleton />;

  return (
    <div className="flex flex-col h-full">
      {/* ── Stats header ── */}
      <div className="shrink-0 border-b px-4 pt-3 pb-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <StatInline label="Proposals" value={stats.total} />
            <StatInline label="In Progress" value={stats.inProgress} />
            <StatInline label="Submitted" value={stats.submitted} />
            <StatInline label="Awarded" value={stats.awarded} />
            <StatInline label="Hit Rate" value={`${stats.hitRate}%`} />
          </div>
          {canEdit && (
            <Button size="lg" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> New Estimate
            </Button>
          )}
        </div>

        {/* Status distribution bar */}
        {segments.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex h-1.5 w-full rounded-full bg-fill-secondary overflow-hidden">
              {segments.map((seg) => (
                <button
                  key={seg.status}
                  type="button"
                  className={cn(
                    "h-full transition-opacity",
                    proposalStatusBarClasses(seg.status),
                    statusFilter && statusFilter !== seg.status && "opacity-30"
                  )}
                  style={{ width: `${seg.pct}%` }}
                  onClick={() => setStatusFilter(statusFilter === seg.status ? null : seg.status)}
                  title={`${seg.status}: ${seg.count}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-3 text-footnote text-muted-foreground">
              {segments.map((seg) => (
                <button
                  key={seg.status}
                  type="button"
                  className={cn(
                    "flex items-center gap-1 capitalize",
                    statusFilter && statusFilter !== seg.status && "opacity-40"
                  )}
                  onClick={() => setStatusFilter(statusFilter === seg.status ? null : seg.status)}
                >
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", proposalStatusBarClasses(seg.status))}
                  />
                  {seg.status} ({seg.count})
                </button>
              ))}
              {statusFilter && (
                <button
                  type="button"
                  className="ml-auto text-primary hover:underline"
                  onClick={() => setStatusFilter(null)}
                >
                  Clear filter
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Search bar ── */}
      <div className="shrink-0 border-b px-4 py-2">
        <div className="relative max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-subtle" />
          <Input
            placeholder="Search proposals..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-7 text-callout rounded-full"
          />
        </div>
      </div>

      {/* ── Table ── */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 grid grid-cols-[80px_1fr_160px_100px_80px] gap-1 bg-fill-secondary px-4 py-1.5 border-b">
          <span className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
            #
          </span>
          <span className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
            Description
          </span>
          <span className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
            Owner
          </span>
          <span className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
            Status
          </span>
          <span className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground text-right">
            Due
          </span>
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {search || statusFilter ? "No matching proposals." : "No proposals yet."}
          </div>
        ) : (
          filtered.map((p, i) => {
            const dueDate = p.dateDue ? new Date(p.dateDue) : null;
            const now = new Date();
            const daysUntil = dueDate ? differenceInDays(dueDate, now) : null;
            const isOverdue =
              dueDate &&
              daysUntil !== null &&
              daysUntil < 0 &&
              (p.status === "bidding" || p.status === "open");
            const isDueSoon =
              dueDate &&
              daysUntil !== null &&
              daysUntil >= 0 &&
              daysUntil <= 7 &&
              (p.status === "bidding" || p.status === "open");

            return (
              <div
                key={p._id}
                className={cn(
                  "grid grid-cols-[80px_1fr_160px_100px_80px] gap-1 items-center px-4 py-1.5 border-b border-border/30 cursor-pointer transition-colors hover:bg-fill-quaternary",
                  i % 2 !== 0 && "bg-fill-quaternary"
                )}
                onMouseEnter={() => queueWarm(() => warmEstimate(p._id))}
                onMouseLeave={cancelWarm}
                onClick={() =>
                  navigate({ to: "/estimate/$estimateId", params: { estimateId: p._id } })
                }
              >
                {/* # */}
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {p.proposalNumber}
                </span>

                {/* Description, annotated when the estimate has left the mirror */}
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-sm text-foreground/80 truncate">{p.description}</span>
                  <SyncOriginBadge precisionOwnedAt={p.precisionOwnedAt} />
                </span>

                {/* Owner */}
                <span className="text-xs text-muted-foreground truncate">{p.ownerName}</span>

                {/* Status chip */}
                <div>
                  <ProposalStatusChip status={p.status} />
                </div>

                {/* Due date */}
                <span
                  className={cn(
                    "text-xs text-right tabular-nums",
                    isOverdue
                      ? "text-red-600 dark:text-red-400 font-semibold"
                      : isDueSoon
                        ? "text-amber-600 dark:text-amber-400 font-semibold"
                        : "text-muted-foreground"
                  )}
                >
                  {dueDate ? format(dueDate, "MM/dd") : ""}
                </span>
              </div>
            );
          })
        )}
      </div>

      {canEdit && <CreateEstimateDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat inline component — matching legacy pattern
// ---------------------------------------------------------------------------

function StatInline({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 border-b px-4 pt-3 pb-3">
        <div className="flex gap-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-20" />
          ))}
        </div>
      </div>
      <div className="shrink-0 border-b px-4 py-2">
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="flex-1">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 15 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full mt-px" />
        ))}
      </div>
    </div>
  );
}
