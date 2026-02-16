import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { DetailTable } from "@truss/features/progress-tracking";
import { Progress } from "@truss/ui/components/progress";
import { StatusBadge } from "@truss/ui/components/status-badge";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@truss/ui/components/breadcrumb";
import { PageHeaderSkeleton } from "../../../../components/skeletons";
import { Skeleton } from "@truss/ui/components/skeleton";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Detail view route component.
 *
 * Displays detail-level work items for a specific phase within a project:
 * - Breadcrumb navigation (Projects > Project > WBS > Phase)
 * - Phase header card with progress summary
 * - Detail table with sortable columns and quantity tracking
 * - Comprehensive work item information
 */
export const Route = createFileRoute("/project/$projectId/wbs/$wbsId/phase/$phaseId")({
  component: DetailViewPage,
});

/** Get status badge variant based on progress percentage. */
function getStatusVariant(percentComplete: number): "success" | "warning" | "danger" {
  if (percentComplete >= 80) return "success";
  if (percentComplete >= 50) return "warning";
  return "danger";
}

/** Get status label text. */
function getStatusLabel(percentComplete: number): string {
  if (percentComplete === 100) return "Complete";
  if (percentComplete >= 80) return "Near Complete";
  if (percentComplete >= 50) return "In Progress";
  if (percentComplete >= 20) return "Behind Schedule";
  if (percentComplete > 0) return "Started";
  return "Not Started";
}

function DetailViewPage() {
  const { projectId, wbsId, phaseId } = useParams({
    from: "/project/$projectId/wbs/$wbsId/phase/$phaseId",
  });

  const data = useQuery(api.momentum.getPhaseDetails, {
    projectId: projectId as Id<"momentumProjects">,
    phaseId: phaseId as Id<"phases">,
  });

  if (data === undefined) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-muted-foreground">Not Found</h2>
          <p className="text-muted-foreground mt-2">
            The requested project or phase could not be found.
          </p>
          <Link to="/projects" className="mt-4 inline-block text-primary hover:underline">
            Return to Projects
          </Link>
        </div>
      </div>
    );
  }

  const { project, wbs, phase, details } = data;
  const statusVariant = getStatusVariant(phase.percentComplete);
  const statusLabel = getStatusLabel(phase.percentComplete);

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
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
          {wbs && (
            <>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/project/$projectId/wbs/$wbsId" params={{ projectId, wbsId }}>
                    {wbs.description}
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </>
          )}
          <BreadcrumbItem>
            <BreadcrumbPage>{phase.description}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Phase Header Card */}
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <div className="text-sm font-medium text-muted-foreground">{phase.code}</div>
            <h1 className="text-2xl font-bold tracking-tight mt-1">{phase.description}</h1>
          </div>
          <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-medium">Progress</span>
              <span className="font-semibold tabular-nums">{phase.percentComplete}%</span>
            </div>
            <Progress value={phase.percentComplete} className="h-2" />
          </div>

          {/* Man-Hours Stats */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-muted-foreground">Man-Hours Earned</div>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {phase.earnedMH.toFixed(1)} MH
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-muted-foreground">Man-Hours Total</div>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {phase.totalMH.toFixed(1)} MH
            </div>
          </div>
        </div>
      </div>

      {/* Detail Items Section */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Work Items ({details.length})</h2>
        {details.length === 0 ? (
          <div className="rounded-lg border bg-muted/50 p-12 text-center">
            <p className="text-muted-foreground">No work items found for this phase.</p>
          </div>
        ) : (
          <DetailTable items={details} />
        )}
      </div>
    </div>
  );
}
