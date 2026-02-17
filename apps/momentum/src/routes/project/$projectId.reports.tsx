import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import {
  Clock,
  Hammer,
  Flame,
  TrendingUp,
  Target,
  Download,
  FileSpreadsheet,
  Loader2,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@truss/ui/components/breadcrumb";
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
 * Combined reports page — WBS+Phase progress, weekly breakdown, and Excel export.
 *
 * WHY: Single scannable reports view with expandable WBS rows
 * showing phase-level progress underneath.
 */
export const Route = createFileRoute("/project/$projectId/reports")({
  component: ReportsPage,
});

/** Semantic color for progress percentage. */
function pctColor(pct: number): string {
  if (pct >= 100) return "text-green-600 dark:text-green-400";
  if (pct >= 75) return "text-green-600 dark:text-green-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
}

/** Progress bar fill color. */
function pctBarColor(pct: number): string {
  if (pct >= 100) return "bg-green-500";
  if (pct >= 75) return "bg-green-500";
  if (pct >= 50) return "bg-amber-500";
  if (pct > 0) return "bg-orange-500";
  return "bg-muted-foreground/30";
}

/** Compact stat with icon. */
function MiniStat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <Icon className="h-4 w-4 text-muted-foreground/70 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </p>
        <p className="text-lg font-bold tabular-nums tracking-tight">{value}</p>
      </div>
    </div>
  );
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
      if (next.has(wbsId)) {
        next.delete(wbsId);
      } else {
        next.add(wbsId);
      }
      return next;
    });
  }, []);

  const toggleAll = React.useCallback(() => {
    if (!phaseData) return;
    const allIds = phaseData.wbsItems.map((w) => w.id);
    setExpandedWBS((prev) => {
      if (prev.size === allIds.length) return new Set();
      return new Set(allIds);
    });
  }, [phaseData]);

  const handleExport = React.useCallback(async () => {
    if (!exportData) return;

    setExporting(true);
    try {
      const blob = exportProgressWorkbook({
        ...exportData,
        project: {
          ...exportData.project,
          startDate: String(exportData.project.startDate),
        },
      });

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
      <div className="space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-24" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-[250px] w-full rounded-lg" />
        <Skeleton className="h-[200px] w-full rounded-lg" />
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

  const detailCount = exportData?.rows.filter((r) => r.rowType === "detail").length ?? 0;
  const wbsCount = exportData?.rows.filter((r) => r.rowType === "wbs").length ?? 0;
  const allExpanded = expandedWBS.size === wbsItems.length && wbsItems.length > 0;

  return (
    <div className="space-y-6">
      {/* ── Breadcrumb ── */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/projects">Projects</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/project/$projectId" params={{ projectId }} search={{ wbs: undefined }}>
                {project.name}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Reports</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="text-xl font-bold tracking-tight">Reports</h1>

      {/* ── Summary stats ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MiniStat
          label="Total MH"
          value={project.totalMH.toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={Clock}
        />
        <MiniStat
          label="Craft MH"
          value={(project.craftMH ?? 0).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={Hammer}
        />
        <MiniStat
          label="Weld MH"
          value={(project.weldMH ?? 0).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={Flame}
        />
        <MiniStat
          label="Earned MH"
          value={project.earnedMH.toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={TrendingUp}
        />
        <MiniStat label="Progress" value={`${project.percentComplete}%`} icon={Target} />
      </div>

      {/* ── WBS + Phase progress table ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            WBS Progress
          </h2>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={toggleAll}>
            <ChevronsUpDown className="h-3.5 w-3.5" />
            {allExpanded ? "Collapse All" : "Expand All"}
          </Button>
        </div>
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 w-[280px]">
                  Item
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                  Craft MH
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                  Weld MH
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                  Total MH
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                  Earned
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                  Remaining
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right w-14">
                  %
                </TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 w-28">
                  Progress
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wbsItems.map((wbs) => {
                const isExpanded = expandedWBS.has(wbs.id);
                return (
                  <React.Fragment key={wbs.id}>
                    {/* WBS row */}
                    <TableRow
                      className="bg-primary/[0.03] border-l-[3px] border-l-primary hover:bg-primary/[0.06] cursor-pointer transition-colors"
                      onClick={() => toggleWBS(wbs.id)}
                    >
                      <TableCell className="py-2.5">
                        <div className="flex items-center gap-2">
                          <ChevronRight
                            className={cn(
                              "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200",
                              isExpanded && "rotate-90"
                            )}
                          />
                          <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold font-mono text-primary tabular-nums shrink-0">
                            {wbs.code}
                          </span>
                          <span className="text-sm font-semibold truncate">{wbs.description}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold tabular-nums py-2.5">
                        {wbs.craftMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold tabular-nums py-2.5">
                        {wbs.weldMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold tabular-nums py-2.5">
                        {wbs.totalMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold tabular-nums py-2.5">
                        {wbs.earnedMH.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold tabular-nums text-muted-foreground py-2.5">
                        {wbs.remainingMH.toFixed(1)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-sm font-semibold tabular-nums py-2.5",
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

                    {/* Phase rows (expanded) */}
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
                              <span className="text-sm text-muted-foreground truncate">
                                {phase.description}
                              </span>
                              <span className="text-[11px] text-muted-foreground/50 shrink-0">
                                ({phase.activityCount})
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums py-2 text-muted-foreground">
                            {phase.craftMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums py-2 text-muted-foreground">
                            {phase.weldMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums py-2">
                            {phase.totalMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums py-2">
                            {phase.earnedMH.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums text-muted-foreground py-2">
                            {phase.remainingMH.toFixed(1)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono text-sm font-medium tabular-nums py-2",
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

              {/* Totals */}
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell className="py-2.5 text-sm font-bold">Total</TableCell>
                <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                  {(project.craftMH ?? 0).toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                  {(project.weldMH ?? 0).toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                  {project.totalMH.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                  {project.earnedMH.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                  {Math.max(0, project.totalMH - project.earnedMH).toFixed(1)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono text-sm font-bold tabular-nums py-2.5",
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

      {/* ── Weekly earned MH ── */}
      {weeks.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Weekly Earned Man-Hours
          </h2>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Week Ending
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                    Quantity
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                    Earned MH
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeks.map((week) => (
                  <TableRow key={week.weekEnding} className="hover:bg-accent/50 transition-colors">
                    <TableCell className="font-mono text-sm py-2.5">{week.weekEnding}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums py-2.5">
                      {week.totalQuantity}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums py-2.5">
                      {week.totalEarnedMH.toFixed(1)}
                    </TableCell>
                  </TableRow>
                ))}

                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell className="py-2.5 text-sm font-bold">Total</TableCell>
                  <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                    {weeks.reduce((s, w) => s + w.totalQuantity, 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                    {weeks.reduce((s, w) => s + w.totalEarnedMH, 0).toFixed(1)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* ── Export ── */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Export
        </h2>
        <div className="flex items-center gap-4 rounded-lg border bg-card p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10 shrink-0">
            <FileSpreadsheet className="h-5 w-5 text-green-600 dark:text-green-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Export to Excel</p>
            <p className="text-xs text-muted-foreground truncate">
              {detailCount} work items &middot; {wbsCount} WBS groups
              {exportData && exportData.weekEndings.length > 0 && (
                <>
                  {" "}
                  &middot; {exportData.weekEndings[0]} &ndash;{" "}
                  {exportData.weekEndings[exportData.weekEndings.length - 1]}
                </>
              )}
            </p>
          </div>
          <Button
            onClick={handleExport}
            disabled={exporting || !exportData}
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {exporting ? "Generating..." : "Download"}
          </Button>
        </div>
      </div>
    </div>
  );
}
