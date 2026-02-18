import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { Download, Loader2, ChevronRight, ChevronsUpDown } from "lucide-react";
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
import type { Id } from "@truss/backend/convex/_generated/dataModel";

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

/** Progress bar fill color — brand teal for normal, amber for overrun. */
function pctBarColor(pct: number): string {
  if (pct > 100) return "bg-amber-500";
  if (pct >= 50) return "bg-teal-500";
  if (pct > 0) return "bg-teal-500/70";
  return "bg-muted-foreground/20";
}

/** Progress text color for percentage values. */
function pctColor(pct: number): string {
  if (pct > 100) return "text-amber-600 dark:text-amber-400";
  return "text-foreground";
}

/** Format MH values with locale-aware thousands separators. */
function fmtMH(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
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

  const toggleWBS = React.useCallback((wbsId: string) => {
    setExpandedWBS((prev) => {
      const next = new Set(prev);
      if (next.has(wbsId)) next.delete(wbsId);
      else next.add(wbsId);
      return next;
    });
  }, []);

  const toggleAll = React.useCallback(() => {
    if (!phaseData) return;
    const allIds = phaseData.wbsItems.map((w) => w.id);
    setExpandedWBS((prev) => (prev.size === allIds.length ? new Set() : new Set(allIds)));
  }, [phaseData]);

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
        <p className="text-lg font-semibold text-muted-foreground">Project not found</p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const { project, wbsItems } = phaseData;
  const weeks = weeklyData?.weeks ?? [];
  const allExpanded = expandedWBS.size === wbsItems.length && wbsItems.length > 0;
  const remaining = Math.max(0, project.totalMH - project.earnedMH);
  const isOverrun = project.percentComplete > 100;
  return (
    <div className="space-y-5 pb-8">
      {/* ── Page header — title + export action ── */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
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

      {/* ── Overview stats card ── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {/* Primary stats row — progress is hero, others are supporting */}
        <div className="grid grid-cols-4 divide-x">
          <div className="px-4 py-3.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Progress
            </p>
            <div className="flex items-baseline gap-1.5 mt-1">
              <span
                className={cn(
                  "text-2xl font-bold tabular-nums tracking-tight",
                  isOverrun ? "text-amber-600 dark:text-amber-400" : "text-foreground"
                )}
              >
                {project.percentComplete}%
              </span>
              {isOverrun && (
                <span className="text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400">
                  Overrun
                </span>
              )}
            </div>
          </div>

          <div className="px-4 py-3.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Earned MH
            </p>
            <p className="text-lg font-bold tabular-nums tracking-tight mt-1">
              {fmtMH(project.earnedMH)}
            </p>
          </div>

          <div className="px-4 py-3.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Total MH
            </p>
            <p className="text-lg font-bold tabular-nums tracking-tight mt-1">
              {fmtMH(project.totalMH)}
            </p>
          </div>

          <div className="px-4 py-3.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Remaining
            </p>
            <p className="text-lg font-bold tabular-nums tracking-tight text-muted-foreground mt-1">
              {fmtMH(remaining)}
            </p>
          </div>
        </div>

        {/* Full-width progress bar */}
        <div className="px-4 pb-3">
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                pctBarColor(project.percentComplete)
              )}
              style={{ width: `${Math.min(project.percentComplete, 100)}%` }}
            />
          </div>
        </div>

        {/* Craft/Weld split — secondary context */}
        <div className="border-t px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground bg-muted/30">
          <span className="tabular-nums">Craft: {fmtMH(project.craftMH ?? 0)} MH</span>
          <span className="text-muted-foreground/30">&middot;</span>
          <span className="tabular-nums">Weld: {fmtMH(project.weldMH ?? 0)} MH</span>
        </div>
      </div>

      {/* ── WBS + Phase progress table ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-muted-foreground">WBS Progress</h2>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={toggleAll}>
            <ChevronsUpDown className="h-3.5 w-3.5" />
            {allExpanded ? "Collapse All" : "Expand All"}
          </Button>
        </div>
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 w-[280px]">
                  Item
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right">
                  Craft MH
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right">
                  Weld MH
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right">
                  Total MH
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right">
                  Earned
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right">
                  Remaining
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right w-14">
                  %
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 w-28">
                  Progress
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wbsItems.map((wbs) => {
                const isExpanded = expandedWBS.has(wbs.id);
                return (
                  <React.Fragment key={wbs.id}>
                    {/* WBS parent row */}
                    <TableRow
                      className="bg-primary/[0.03] border-l-[3px] border-l-primary hover:bg-primary/[0.06] cursor-pointer transition-colors"
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
                          <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold font-mono text-primary tabular-nums shrink-0">
                            {wbs.code}
                          </span>
                          <span className="text-[13px] font-semibold truncate">
                            {wbs.description}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums py-2.5">
                        {wbs.craftMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums py-2.5">
                        {wbs.weldMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums py-2.5">
                        {wbs.totalMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-semibold tabular-nums py-2.5">
                        {wbs.earnedMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] tabular-nums text-muted-foreground py-2.5">
                        {wbs.remainingMH.toFixed(1)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-[13px] font-semibold tabular-nums py-2.5",
                          pctColor(wbs.percentComplete)
                        )}
                      >
                        {wbs.percentComplete}%
                      </TableCell>
                      <TableCell className="py-2.5">
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-500",
                              pctBarColor(wbs.percentComplete)
                            )}
                            style={{ width: `${Math.min(wbs.percentComplete, 100)}%` }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>

                    {/* Phase child rows */}
                    {isExpanded &&
                      wbs.phases.map((phase) => (
                        <TableRow
                          key={phase.id}
                          className="bg-muted/20 hover:bg-muted/40 transition-colors"
                        >
                          <TableCell className="py-2 pl-10">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                                {phase.code}
                              </span>
                              <span className="text-[13px] text-muted-foreground truncate">
                                {phase.description}
                              </span>
                              <span className="text-[11px] text-muted-foreground/50 shrink-0">
                                ({phase.activityCount})
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-[13px] tabular-nums py-2 text-muted-foreground">
                            {phase.craftMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[13px] tabular-nums py-2 text-muted-foreground">
                            {phase.weldMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[13px] tabular-nums py-2">
                            {phase.totalMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[13px] tabular-nums py-2">
                            {phase.earnedMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-[13px] tabular-nums text-muted-foreground py-2">
                            {phase.remainingMH.toFixed(1)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono text-[13px] font-medium tabular-nums py-2",
                              pctColor(phase.percentComplete)
                            )}
                          >
                            {phase.percentComplete}%
                          </TableCell>
                          <TableCell className="py-2">
                            <div className="h-1 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all duration-500",
                                  pctBarColor(phase.percentComplete)
                                )}
                                style={{ width: `${Math.min(phase.percentComplete, 100)}%` }}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                  </React.Fragment>
                );
              })}

              {/* Totals row */}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell className="py-2.5 text-[13px] font-bold">Total</TableCell>
                <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                  {(project.craftMH ?? 0).toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                  {(project.weldMH ?? 0).toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                  {project.totalMH.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                  {project.earnedMH.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                  {remaining.toFixed(1)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono text-[13px] font-bold tabular-nums py-2.5",
                    pctColor(project.percentComplete)
                  )}
                >
                  {project.percentComplete}%
                </TableCell>
                <TableCell className="py-2.5">
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
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
          <h2 className="text-[13px] font-semibold text-muted-foreground">
            Weekly Earned Man-Hours
          </h2>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 w-[140px]">
                    Week Ending
                  </TableHead>
                  <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right w-[100px]">
                    Quantity
                  </TableHead>
                  <TableHead className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 text-right">
                    Earned MH
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeks.map((week) => (
                  <TableRow key={week.weekEnding} className="hover:bg-accent/50 transition-colors">
                    <TableCell className="text-[13px] py-2.5">
                      {formatWeekDate(week.weekEnding)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums py-2.5">
                      {week.totalQuantity}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums py-2.5">
                      {week.totalEarnedMH.toFixed(1)}
                    </TableCell>
                  </TableRow>
                ))}

                {/* Totals row */}
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell className="py-2.5 text-[13px] font-bold">Total</TableCell>
                  <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                    {weeks.reduce((s, w) => s + w.totalQuantity, 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] font-bold tabular-nums py-2.5">
                    {weeks.reduce((s, w) => s + w.totalEarnedMH, 0).toFixed(1)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
