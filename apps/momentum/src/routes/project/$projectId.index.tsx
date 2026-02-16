import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { ArrowLeft, ArrowRight, Table2 } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Badge } from "@truss/ui/components/badge";
import { Progress } from "@truss/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
import { cn } from "@truss/ui/lib/utils";
import { ProjectDashboardSkeleton } from "../../components/skeletons";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Project dashboard — at-a-glance status overview.
 *
 * WHY: Answers "how is this project doing?" with summary stats and a compact
 * WBS progress table. Clicking a WBS row navigates to the filtered workbook.
 */
export const Route = createFileRoute("/project/$projectId/")({
  component: ProjectDashboardPage,
});

/** Color class for progress percentage. */
function pctColor(pct: number): string {
  if (pct >= 100) return "text-green-600 dark:text-green-400";
  if (pct >= 75) return "text-green-600 dark:text-green-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
}

function ProjectDashboardPage() {
  const { projectId } = useParams({ from: "/project/$projectId/" });
  const data = useQuery(api.momentum.getProjectWBS, {
    projectId: projectId as Id<"momentumProjects">,
  });

  if (data === undefined) {
    return <ProjectDashboardSkeleton />;
  }

  if (data === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <h2 className="text-2xl font-bold">Project Not Found</h2>
        <p className="text-muted-foreground mt-2">The project you're looking for doesn't exist.</p>
        <Link to="/projects">
          <Button className="mt-4 gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const { project, wbsItems } = data;

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
        <Link to="/projects" className="hover:text-foreground transition-colors">
          Projects
        </Link>
        <span>/</span>
        <span className="text-foreground">{project.name}</span>
      </div>

      {/* Project Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <Badge
              variant={
                project.status === "active"
                  ? "default"
                  : project.status === "completed"
                    ? "outline"
                    : "secondary"
              }
            >
              {project.status === "active"
                ? "Active"
                : project.status === "completed"
                  ? "Complete"
                  : project.status}
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="font-medium">
              {project.proposalNumber} &bull; {project.jobNumber}
            </span>
            <span>&bull;</span>
            <span>{project.owner}</span>
            <span>&bull;</span>
            <span>{project.location}</span>
          </div>
        </div>
      </div>

      {/* Summary Stats */}
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">WBS Progress</h2>
          <Link
            to="/project/$projectId/workbook"
            params={{ projectId }}
            search={{ wbs: undefined }}
          >
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              Open Workbook
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>

        {wbsItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center border-2 border-dashed rounded-lg">
            <p className="text-lg font-medium text-muted-foreground">No WBS items found</p>
            <p className="text-sm text-muted-foreground mt-1">
              Import estimate data to get started with progress tracking
            </p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">WBS</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Total MH</TableHead>
                  <TableHead className="text-right">Earned MH</TableHead>
                  <TableHead className="text-right w-16">%</TableHead>
                  <TableHead className="w-32">Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wbsItems.map((wbs) => (
                  <TableRow key={wbs.id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell className="font-mono font-semibold">
                      <Link
                        to="/project/$projectId/workbook"
                        params={{ projectId }}
                        search={{ wbs: wbs.code }}
                        className="hover:underline"
                      >
                        {wbs.code}
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        to="/project/$projectId/workbook"
                        params={{ projectId }}
                        search={{ wbs: wbs.code }}
                        className="hover:underline"
                      >
                        {wbs.description}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-mono">{wbs.totalMH.toFixed(1)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {wbs.earnedMH.toFixed(1)}
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
                    {project.totalMH.toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {project.earnedMH.toFixed(1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono font-semibold",
                      pctColor(project.percentComplete)
                    )}
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
        )}
      </div>

      {/* CTA */}
      <div className="pt-2">
        <Link to="/project/$projectId/workbook" params={{ projectId }} search={{ wbs: undefined }}>
          <Button size="lg" className="gap-2">
            <Table2 className="h-4 w-4" />
            Enter Today&apos;s Progress
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
