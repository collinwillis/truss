import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import {
  Download,
  Loader2,
  ChevronRight,
  ChevronsUpDown,
  Eye,
  EyeOff,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
import { Skeleton } from "@truss/ui/components/skeleton";
import { cn } from "@truss/ui/lib/utils";
import { exportProgressWorkbook } from "../../lib/export-excel";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { isWorkspaceAdmin } from "../../lib/permissions";
import { ProjectStatusSlices, type GroupSummary } from "@truss/features/progress-tracking";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/** Monday.com-inspired group color palette for visual differentiation of WBS groups. */
const GROUP_COLORS = [
  "#579BFC",
  "#00C875",
  "#FDAB3D",
  "#A25DDC",
  "#E2445C",
  "#00D1D1",
  "#FF642E",
  "#037F4C",
  "#CAB641",
  "#9AADBD",
] as const;

/** Deterministic group color from a WBS code string. */
function groupColor(code: string): string {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 31 + code.charCodeAt(i)) | 0;
  }
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length]!;
}

/**
 * Reports page — project progress overview with WBS breakdown and Excel export.
 *
 * WHY this layout: Follows Monday.com/Linear dashboard patterns — compact header
 * with export action, hero stats strip, then detailed breakdowns. Export is in
 * the header so it's always reachable without scrolling.
 */
export const Route = createFileRoute("/project/$projectId/reports")({
  component: ReportsPage,
});

/** Progress bar fill color — green for complete, brand iris for normal, amber for overrun. */
function pctBarColor(pct: number): string {
  if (pct > 100) return "bg-mac-orange";
  if (pct >= 100) return "bg-mac-green";
  if (pct > 0) return "bg-primary";
  return "bg-muted-foreground/20";
}

/** Progress text color for percentage values. */
function pctColor(pct: number): string {
  if (pct > 100) return "text-mac-orange";
  if (pct >= 100) return "text-success-text";
  return "text-foreground";
}

/** Format MH values with locale-aware thousands separators and 2 decimal places. */
function fmtMH(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Formatted MH or muted dash for zero — reduces visual noise on untouched rows. */
function fmtMHOrDash(value: number): React.ReactNode {
  if (value === 0) return <span className="text-label-quaternary">&mdash;</span>;
  return fmtMH(value);
}

/** Format a percentage value with 2 decimal places. */
function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** Format "YYYY-MM-DD" to readable short date. */
function formatWeekDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function ReportsPage() {
  const { projectId } = useParams({ from: "/project/$projectId/reports" });
  const { workspace } = useWorkspace();
  const isAdmin = isWorkspaceAdmin(workspace);
  const [exporting, setExporting] = React.useState(false);
  const [expandedWBS, setExpandedWBS] = React.useState<Set<string>>(new Set());

  const phaseData = useQuery(api.momentum.getPhaseBreakdown, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const weeklyData = useQuery(api.momentum.getWeeklyBreakdown, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const exportData = useQuery(api.momentum.getExportData, {
    projectId: projectId as Id<"momentumProjects">,
  });

  // Hide WBS / phases with no man-hours by default — an estimate carries the
  // full catalog of WBS, but most aren't used on a given job, so showing them
  // all just buries the work that matters.
  const [showUnused, setShowUnused] = React.useState(false);

  const visibleWbs = React.useMemo(() => {
    const items = phaseData?.wbsItems ?? [];
    if (showUnused) return items;
    return items
      .filter((w) => w.totalMH > 0 || w.earnedMH > 0)
      .map((w) => ({
        ...w,
        phases: w.phases.filter((p) => p.totalMH > 0 || p.earnedMH > 0),
      }));
  }, [phaseData, showUnused]);

  // #45 — feed the Workbook's status-slices header with the Reports rollups so
  // Reports shows the same scope buckets (self-perform / subs / change orders).
  const wbsSummaries = React.useMemo<Record<string, GroupSummary>>(() => {
    const rec: Record<string, GroupSummary> = {};
    for (const w of phaseData?.wbsItems ?? []) {
      rec[w.id] = {
        description: w.description,
        code: w.code,
        totalMH: w.totalMH,
        earnedMH: w.earnedMH,
        craftMH: w.craftMH,
        weldMH: w.weldMH,
        percentComplete: w.percentComplete,
        source: w.source as GroupSummary["source"],
      };
    }
    return rec;
  }, [phaseData]);

  const toggleWBS = React.useCallback((wbsId: string) => {
    setExpandedWBS((prev) => {
      const next = new Set(prev);
      if (next.has(wbsId)) next.delete(wbsId);
      else next.add(wbsId);
      return next;
    });
  }, []);

  const toggleAll = React.useCallback(() => {
    const allIds = visibleWbs.map((w) => w.id);
    setExpandedWBS((prev) => (prev.size === allIds.length ? new Set() : new Set(allIds)));
  }, [visibleWbs]);

  const handleExport = React.useCallback(async () => {
    if (!exportData) return;

    setExporting(true);
    try {
      const blob = await exportProgressWorkbook(exportData);
      const sanitized = exportData.project.proposalNumber.replace(/[^a-zA-Z0-9-_]/g, "_");
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `${sanitized}_Progress_${dateStr}.xlsx`;

      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");

        const path = await save({
          defaultPath: filename,
          filters: [{ name: "Excel", extensions: ["xlsx"] }],
        });

        if (path) {
          const arrayBuffer = await blob.arrayBuffer();
          await writeFile(path, new Uint8Array(arrayBuffer));
          toast.success("Export saved", { description: path });
        }
      } catch {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Export downloaded", { description: filename });
      }
    } catch (error) {
      toast.error("Export failed", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setExporting(false);
    }
  }, [exportData]);

  /* ── Admin-only access guard (#39) ── */
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <ShieldAlert className="h-8 w-8 text-label-quaternary" />
        <p className="text-title3 font-semibold text-foreground">Admin Access Required</p>
        <p className="text-body text-muted-foreground text-center max-w-sm">
          Reports are only available to organization administrators.
        </p>
        <Link to="/project/$projectId" params={{ projectId }} search={{ wbs: undefined }}>
          <Button variant="outline" size="sm">
            Back to Workbook
          </Button>
        </Link>
      </div>
    );
  }

  /* ── Loading ── */
  if (phaseData === undefined || weeklyData === undefined) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-8 w-28" />
        </div>
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-[300px] w-full rounded-lg" />
      </div>
    );
  }

  /* ── Not found ── */
  if (phaseData === null) {
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

  const { project } = phaseData;
  const weeks = weeklyData?.weeks ?? [];
  const allExpanded = expandedWBS.size === visibleWbs.length && visibleWbs.length > 0;
  const hiddenCount = phaseData.wbsItems.length - visibleWbs.length;
  const remaining = Math.max(0, project.totalMH - project.earnedMH);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Page header — sticky title + export action ── */}
      <div className="flex items-center justify-between gap-4 pb-4 shrink-0">
        <h1 className="text-title3 font-semibold tracking-tight">Reports</h1>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8"
          onClick={handleExport}
          disabled={exporting || !exportData}
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {exporting ? "Generating..." : "Export Excel"}
        </Button>
      </div>

      {/* ── Scrollable content area ── */}
      <div className="flex-1 min-h-0 overflow-auto space-y-5 pb-8">
        {/* ── Scope status header — same buckets as the Workbook (#45) ── */}
        <ProjectStatusSlices wbsSummaries={wbsSummaries} />

        {/* ── WBS + Phase progress table ── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-body font-semibold text-muted-foreground">WBS Progress</h2>
              {!showUnused && hiddenCount > 0 && (
                <span className="text-subheadline text-foreground-subtle tabular-nums">
                  {hiddenCount} unused hidden
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => setShowUnused((v) => !v)}
              >
                {showUnused ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showUnused ? "Hide unused" : "Show unused"}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={toggleAll}>
                <ChevronsUpDown className="h-3.5 w-3.5" />
                {allExpanded ? "Collapse All" : "Expand All"}
              </Button>
            </div>
          </div>
          <div className="rounded-mac-card border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-transparent hover:bg-transparent sticky top-0 z-10">
                  <TableHead className="text-subheadline font-medium text-muted-foreground w-[280px] bg-transparent">
                    Item
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground text-right bg-transparent">
                    Craft MH
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground text-right bg-transparent">
                    Weld MH
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground text-right bg-transparent">
                    Total MH
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground text-right bg-transparent">
                    Earned
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground text-right bg-transparent">
                    Remaining
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground text-right w-14 bg-transparent">
                    %
                  </TableHead>
                  <TableHead className="text-subheadline font-medium text-muted-foreground w-28 bg-transparent">
                    Progress
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleWbs.map((wbs) => {
                  const isExpanded = expandedWBS.has(wbs.id);
                  const isZeroRow = wbs.totalMH === 0 && wbs.earnedMH === 0;
                  return (
                    <React.Fragment key={wbs.id}>
                      {/* WBS parent row */}
                      <TableRow
                        className={cn(
                          "hover:bg-fill-quaternary cursor-pointer transition-colors",
                          isZeroRow && "opacity-50"
                        )}
                        style={{ borderLeft: `3px solid ${groupColor(wbs.code)}` }}
                        onClick={() => toggleWBS(wbs.id)}
                      >
                        <TableCell className="py-2.5">
                          <div className="flex items-center gap-2">
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-150",
                                isExpanded && "rotate-90"
                              )}
                            />
                            <span className="inline-flex items-center rounded bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-bold font-mono text-foreground tabular-nums shrink-0">
                              {wbs.code}
                            </span>
                            <span className="text-body font-semibold truncate">
                              {wbs.description}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-body font-semibold tabular-nums py-2.5">
                          {fmtMHOrDash(wbs.craftMH)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-body font-semibold tabular-nums py-2.5">
                          {fmtMHOrDash(wbs.weldMH)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-body font-semibold tabular-nums py-2.5">
                          {fmtMHOrDash(wbs.totalMH)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-body font-semibold tabular-nums py-2.5">
                          {fmtMHOrDash(wbs.earnedMH)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-body tabular-nums text-muted-foreground py-2.5">
                          {fmtMHOrDash(wbs.remainingMH)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono text-body font-semibold tabular-nums py-2.5",
                            wbs.percentComplete === 0 && wbs.earnedMH === 0
                              ? ""
                              : wbs.percentComplete === 0
                                ? "text-foreground-subtle"
                                : pctColor(wbs.percentComplete)
                          )}
                        >
                          {fmtPct(wbs.percentComplete)}
                        </TableCell>
                        <TableCell className="py-2.5">
                          <div className="h-1.5 rounded-full bg-fill-quaternary overflow-hidden">
                            {(wbs.percentComplete > 0 || wbs.earnedMH > 0) && (
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all duration-500",
                                  wbs.earnedMH > 0 ? "bg-primary" : pctBarColor(wbs.percentComplete)
                                )}
                                style={{
                                  width: `${Math.max(wbs.percentComplete > 0 ? Math.min(wbs.percentComplete, 100) : 2, 2)}%`,
                                }}
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>

                      {/* Phase child rows */}
                      {isExpanded &&
                        wbs.phases.map((phase) => (
                          <TableRow
                            key={phase.id}
                            className="bg-fill-quaternary/20 hover:bg-fill-quaternary/40 transition-colors"
                          >
                            <TableCell className="py-2 pl-10">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex items-center rounded bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                                  {phase.code}
                                </span>
                                <span className="text-body text-muted-foreground truncate">
                                  {phase.description}
                                </span>
                                <span className="text-subheadline text-foreground-subtle shrink-0">
                                  ({phase.activityCount})
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-body tabular-nums py-2 text-muted-foreground">
                              {fmtMHOrDash(phase.craftMH)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-body tabular-nums py-2 text-muted-foreground">
                              {fmtMHOrDash(phase.weldMH)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-body tabular-nums py-2">
                              {fmtMHOrDash(phase.totalMH)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-body tabular-nums py-2">
                              {fmtMHOrDash(phase.earnedMH)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-body tabular-nums text-muted-foreground py-2">
                              {fmtMHOrDash(phase.remainingMH)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right font-mono text-body font-medium tabular-nums py-2",
                                phase.percentComplete === 0 && phase.earnedMH === 0
                                  ? ""
                                  : phase.percentComplete === 0
                                    ? "text-foreground-subtle"
                                    : pctColor(phase.percentComplete)
                              )}
                            >
                              {fmtPct(phase.percentComplete)}
                            </TableCell>
                            <TableCell className="py-2">
                              <div className="h-1 rounded-full bg-fill-quaternary overflow-hidden">
                                {(phase.percentComplete > 0 || phase.earnedMH > 0) && (
                                  <div
                                    className={cn(
                                      "h-full rounded-full transition-all duration-500",
                                      phase.earnedMH > 0
                                        ? "bg-primary"
                                        : pctBarColor(phase.percentComplete)
                                    )}
                                    style={{
                                      width: `${Math.max(phase.percentComplete > 0 ? Math.min(phase.percentComplete, 100) : 2, 2)}%`,
                                    }}
                                  />
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                    </React.Fragment>
                  );
                })}

                {/* Totals row */}
                <TableRow className="bg-fill-quaternary/40 hover:bg-fill-quaternary/40">
                  <TableCell className="py-2.5 text-body font-bold">Total</TableCell>
                  <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                    {fmtMH(project.craftMH ?? 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                    {fmtMH(project.weldMH ?? 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                    {fmtMH(project.totalMH)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                    {fmtMH(project.earnedMH)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                    {fmtMH(remaining)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-body font-bold tabular-nums py-2.5",
                      pctColor(project.percentComplete)
                    )}
                  >
                    {fmtPct(project.percentComplete)}
                  </TableCell>
                  <TableCell className="py-2.5">
                    <div className="h-1.5 rounded-full bg-fill-quaternary overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          pctBarColor(project.percentComplete)
                        )}
                        style={{ width: `${Math.min(project.percentComplete, 100)}%` }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>

        {/* ── Weekly earned MH — with inline trend bars ── */}
        {weeks.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-body font-semibold text-muted-foreground">
              Weekly Earned Man-Hours
            </h2>
            <div className="rounded-mac-card border overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-transparent hover:bg-transparent">
                    <TableHead className="text-subheadline font-medium text-muted-foreground w-[140px]">
                      Week Ending
                    </TableHead>
                    <TableHead className="text-subheadline font-medium text-muted-foreground text-right w-[100px]">
                      Quantity
                    </TableHead>
                    <TableHead className="text-subheadline font-medium text-muted-foreground text-right">
                      Earned MH
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {weeks.map((week) => (
                    <TableRow
                      key={week.weekEnding}
                      className="hover:bg-fill-quaternary transition-colors"
                    >
                      <TableCell className="text-body py-2.5">
                        {formatWeekDate(week.weekEnding)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-body tabular-nums py-2.5">
                        {fmtMH(week.totalQuantity)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-body tabular-nums py-2.5">
                        {week.totalEarnedMH.toFixed(2)}
                      </TableCell>
                    </TableRow>
                  ))}

                  {/* Totals row */}
                  <TableRow className="bg-fill-quaternary/40 hover:bg-fill-quaternary/40">
                    <TableCell className="py-2.5 text-body font-bold">Total</TableCell>
                    <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                      {fmtMH(weeks.reduce((s, w) => s + w.totalQuantity, 0))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-body font-bold tabular-nums py-2.5">
                      {weeks.reduce((s, w) => s + w.totalEarnedMH, 0).toFixed(2)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
