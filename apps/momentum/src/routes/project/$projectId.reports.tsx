import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { ArrowLeft, Download, FileSpreadsheet, Loader2 } from "lucide-react";
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
import { Progress } from "@truss/ui/components/progress";
import { cn } from "@truss/ui/lib/utils";
import { exportProgressWorkbook } from "../../lib/export-excel";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Combined reports page — WBS progress, weekly breakdown, and Excel export.
 *
 * WHY: Merges the old separate summary and export pages into a single,
 * scannable reports view. Users no longer need to navigate between pages.
 */
export const Route = createFileRoute("/project/$projectId/reports")({
  component: ReportsPage,
});

/** Color class for progress percentage. */
function pctColor(pct: number): string {
  if (pct >= 100) return "text-green-600 dark:text-green-400";
  if (pct >= 75) return "text-green-600 dark:text-green-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
}

function ReportsPage() {
  const { projectId } = useParams({ from: "/project/$projectId/reports" });
  const [exporting, setExporting] = React.useState(false);

  const wbsData = useQuery(api.momentum.getProjectWBS, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const weeklyData = useQuery(api.momentum.getWeeklyBreakdown, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const exportData = useQuery(api.momentum.getExportData, {
    projectId: projectId as Id<"momentumProjects">,
  });

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

  if (wbsData === undefined || weeklyData === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-9 w-96" />
        <div className="grid gap-4 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }

  if (wbsData === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <h2 className="text-2xl font-bold">Project Not Found</h2>
        <Link to="/projects">
          <Button className="mt-4 gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const { project, wbsItems } = wbsData;
  const weeks = weeklyData?.weeks ?? [];

  const detailCount = exportData?.rows.filter((r) => r.rowType === "detail").length ?? 0;
  const wbsCount = exportData?.rows.filter((r) => r.rowType === "wbs").length ?? 0;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
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
              <Link to="/project/$projectId" params={{ projectId }}>
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

      <h1 className="text-2xl font-bold tracking-tight">Reports</h1>

      {/* Summary stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <div className="rounded-lg border bg-card p-5">
          <div className="text-sm font-medium text-muted-foreground">Total MH</div>
          <div className="mt-2 text-xl font-bold tabular-nums">{project.totalMH.toFixed(1)}</div>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <div className="text-sm font-medium text-muted-foreground">Craft MH</div>
          <div className="mt-2 text-xl font-bold tabular-nums">
            {(project.craftMH ?? 0).toFixed(1)}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <div className="text-sm font-medium text-muted-foreground">Weld MH</div>
          <div className="mt-2 text-xl font-bold tabular-nums">
            {(project.weldMH ?? 0).toFixed(1)}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <div className="text-sm font-medium text-muted-foreground">Earned MH</div>
          <div className="mt-2 text-xl font-bold tabular-nums">{project.earnedMH.toFixed(1)}</div>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <div className="text-sm font-medium text-muted-foreground">Overall Progress</div>
          <div className="mt-2 text-xl font-bold tabular-nums">{project.percentComplete}%</div>
          <Progress value={project.percentComplete} className="mt-2 h-2" />
        </div>
      </div>

      {/* WBS Progress Table */}
      <div>
        <h2 className="text-lg font-semibold mb-3">WBS Progress</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>WBS</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Craft MH</TableHead>
                <TableHead className="text-right">Weld MH</TableHead>
                <TableHead className="text-right">Total MH</TableHead>
                <TableHead className="text-right">Earned MH</TableHead>
                <TableHead className="text-right">Remaining MH</TableHead>
                <TableHead className="text-right">%</TableHead>
                <TableHead className="w-32">Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wbsItems.map((wbs) => (
                <TableRow key={wbs.id}>
                  <TableCell className="font-mono font-semibold">{wbs.code}</TableCell>
                  <TableCell className="font-medium">{wbs.description}</TableCell>
                  <TableCell className="text-right font-mono">
                    {(wbs.craftMH ?? 0).toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {(wbs.weldMH ?? 0).toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right font-mono">{wbs.totalMH.toFixed(1)}</TableCell>
                  <TableCell className="text-right font-mono">{wbs.earnedMH.toFixed(1)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {Math.max(0, wbs.totalMH - wbs.earnedMH).toFixed(1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono font-semibold",
                      pctColor(wbs.percentComplete)
                    )}
                  >
                    {wbs.percentComplete}%
                  </TableCell>
                  <TableCell>
                    <Progress value={wbs.percentComplete} className="h-2" />
                  </TableCell>
                </TableRow>
              ))}

              {/* Totals row */}
              <TableRow className="bg-muted/50 font-bold">
                <TableCell colSpan={2} className="font-bold">
                  Total
                </TableCell>
                <TableCell className="text-right font-mono">
                  {(project.craftMH ?? 0).toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {(project.weldMH ?? 0).toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono">{project.totalMH.toFixed(1)}</TableCell>
                <TableCell className="text-right font-mono">
                  {project.earnedMH.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {Math.max(0, project.totalMH - project.earnedMH).toFixed(1)}
                </TableCell>
                <TableCell
                  className={cn("text-right font-mono", pctColor(project.percentComplete))}
                >
                  {project.percentComplete}%
                </TableCell>
                <TableCell>
                  <Progress value={project.percentComplete} className="h-2" />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Weekly Earned MH */}
      {weeks.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Weekly Earned Man-Hours</h2>
          <div className="rounded-md border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week Ending</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Earned MH</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeks.map((week) => (
                  <TableRow key={week.weekEnding}>
                    <TableCell className="font-mono">{week.weekEnding}</TableCell>
                    <TableCell className="text-right font-mono">{week.totalQuantity}</TableCell>
                    <TableCell className="text-right font-mono">
                      {week.totalEarnedMH.toFixed(1)}
                    </TableCell>
                  </TableRow>
                ))}

                <TableRow className="bg-muted/50 font-bold">
                  <TableCell className="font-bold">Total</TableCell>
                  <TableCell className="text-right font-mono">
                    {weeks.reduce((s, w) => s + w.totalQuantity, 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {weeks.reduce((s, w) => s + w.totalEarnedMH, 0).toFixed(1)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Export section */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Export</h2>
        <div className="max-w-lg rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <FileSpreadsheet className="h-6 w-6 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h3 className="font-semibold">Export to Excel</h3>
              <p className="text-sm text-muted-foreground">
                {detailCount} work items &bull; {wbsCount} WBS groups
                {exportData && exportData.weekEndings.length > 0 && (
                  <>
                    {" "}
                    &bull; {exportData.weekEndings[0]} -{" "}
                    {exportData.weekEndings[exportData.weekEndings.length - 1]}
                  </>
                )}
              </p>
            </div>
          </div>

          <Button
            onClick={handleExport}
            disabled={exporting || !exportData}
            size="lg"
            className="w-full gap-2"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting ? "Generating..." : "Download Excel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
