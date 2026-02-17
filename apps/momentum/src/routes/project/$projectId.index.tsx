import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { ArrowRight, Clock, Hammer, Flame, TrendingUp, Target, Table2 } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Badge } from "@truss/ui/components/badge";
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
import { cn } from "@truss/ui/lib/utils";
import { ProjectDashboardSkeleton } from "../../components/skeletons";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Project dashboard — at-a-glance status overview.
 *
 * WHY: Answers "how is this project doing?" with summary stats and
 * a compact WBS progress table. Clicking a WBS row navigates to
 * the filtered workbook.
 */
export const Route = createFileRoute("/project/$projectId/")({
  component: ProjectDashboardPage,
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

/** Stat card with icon for the summary grid. */
function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  children,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 space-y-3 transition-colors",
        accent && "border-primary/20 bg-primary/[0.02]"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Icon className={cn("h-4 w-4", accent ? "text-primary" : "text-muted-foreground/70")} />
      </div>
      <div
        className={cn("text-2xl font-bold tabular-nums tracking-tight", accent && "text-primary")}
      >
        {value}
      </div>
      {children}
    </div>
  );
}

function ProjectDashboardPage() {
  const { projectId } = useParams({ from: "/project/$projectId/" });
  const data = useQuery(api.momentum.getProjectWBS, {
    projectId: projectId as Id<"momentumProjects">,
  });

  if (data === undefined) return <ProjectDashboardSkeleton />;

  if (data === null) {
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

  const { project, wbsItems } = data;

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
            <BreadcrumbPage>{project.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* ── Project header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">{project.name}</h1>
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
                  : project.status === "on-hold"
                    ? "On Hold"
                    : project.status === "archived"
                      ? "Archived"
                      : project.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium">{project.proposalNumber}</span>
            <span className="mx-1.5 text-border">&middot;</span>
            <span>{project.jobNumber}</span>
            <span className="mx-1.5 text-border">&middot;</span>
            <span>{project.owner}</span>
            <span className="mx-1.5 text-border">&middot;</span>
            <span>{project.location}</span>
          </p>
        </div>
      </div>

      {/* ── Summary stats ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Total MH"
          value={project.totalMH.toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={Clock}
        />
        <StatCard
          label="Craft MH"
          value={(project.craftMH ?? 0).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={Hammer}
        />
        <StatCard
          label="Weld MH"
          value={(project.weldMH ?? 0).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={Flame}
        />
        <StatCard
          label="Earned MH"
          value={project.earnedMH.toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          icon={TrendingUp}
        />
        <StatCard label="Progress" value={`${project.percentComplete}%`} icon={Target} accent>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                pctBarColor(project.percentComplete)
              )}
              style={{ width: `${Math.min(project.percentComplete, 100)}%` }}
            />
          </div>
        </StatCard>
      </div>

      {/* ── WBS progress table ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            WBS Progress
          </h2>
          <Link
            to="/project/$projectId/workbook"
            params={{ projectId }}
            search={{ wbs: undefined }}
          >
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground">
              Open Workbook
              <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>

        {wbsItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center border rounded-lg bg-muted/20">
            <Table2 className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No WBS items</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Import estimate data to get started
            </p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 w-16">
                    WBS
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Description
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                    Total MH
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 text-right">
                    Earned
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
                {wbsItems.map((wbs) => (
                  <TableRow
                    key={wbs.id}
                    className="group cursor-pointer transition-colors hover:bg-accent/50"
                  >
                    <TableCell className="py-2.5">
                      <Link
                        to="/project/$projectId/workbook"
                        params={{ projectId }}
                        search={{ wbs: wbs.code }}
                        className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold font-mono text-primary tabular-nums hover:bg-primary/20 transition-colors"
                      >
                        {wbs.code}
                      </Link>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <Link
                        to="/project/$projectId/workbook"
                        params={{ projectId }}
                        search={{ wbs: wbs.code }}
                        className="text-sm font-medium group-hover:text-primary transition-colors"
                      >
                        {wbs.description}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums py-2.5">
                      {wbs.totalMH.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums py-2.5">
                      {wbs.earnedMH.toFixed(1)}
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
                ))}

                {/* Totals row */}
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={2} className="py-2.5 text-sm font-bold">
                    Total
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                    {project.totalMH.toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-bold tabular-nums py-2.5">
                    {project.earnedMH.toFixed(1)}
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
        )}
      </div>

      {/* ── CTA ── */}
      <div className="pt-1">
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
