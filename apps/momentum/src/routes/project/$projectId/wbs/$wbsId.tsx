import { createFileRoute, Link, Outlet, useParams, useLocation } from "@tanstack/react-router";
import { PhaseCard } from "@truss/features/progress-tracking";
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
import { getProjectById, getWBSById, getPhasesByWBS } from "../../../../data/mock-progress-data";

/**
 * Phase view route component.
 *
 * Displays phase-level breakdown for a specific WBS item within a project:
 * - Breadcrumb navigation (Projects > Project > WBS)
 * - WBS header card with progress summary
 * - Grid of phase cards (responsive: 1-3 columns)
 * - Click-to-drill-down navigation to detail view
 */
export const Route = createFileRoute("/project/$projectId/wbs/$wbsId")({
  component: PhaseViewPage,
});

/**
 * Get status badge variant based on progress percentage.
 */
function getStatusVariant(percentComplete: number): "success" | "warning" | "danger" {
  if (percentComplete >= 80) return "success";
  if (percentComplete >= 50) return "warning";
  return "danger";
}

/**
 * Get status label text.
 */
function getStatusLabel(percentComplete: number): string {
  if (percentComplete === 100) return "Complete";
  if (percentComplete >= 80) return "Near Complete";
  if (percentComplete >= 50) return "In Progress";
  if (percentComplete >= 20) return "Behind Schedule";
  if (percentComplete > 0) return "Started";
  return "Not Started";
}

function PhaseViewPage() {
  const { projectId, wbsId } = useParams({
    from: "/project/$projectId/wbs/$wbsId",
  });
  const location = useLocation();
  const project = getProjectById(projectId);
  const wbsItem = getWBSById(wbsId);
  const phases = getPhasesByWBS(wbsId);

  // Check if we're navigating to a child route (phase detail view)
  const isChildRoute = location.pathname.includes("/phase/");

  if (!project || !wbsItem) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-muted-foreground">
            {!project ? "Project Not Found" : "WBS Not Found"}
          </h2>
          <p className="text-muted-foreground mt-2">
            The requested {!project ? "project" : "WBS item"} could not be found.
          </p>
          <Link to="/projects" className="mt-4 inline-block text-primary hover:underline">
            Return to Projects
          </Link>
        </div>
      </div>
    );
  }

  // If navigating to a child route, render the Outlet
  if (isChildRoute) {
    return <Outlet />;
  }

  const statusVariant = getStatusVariant(wbsItem.percentComplete);
  const statusLabel = getStatusLabel(wbsItem.percentComplete);

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
          <BreadcrumbItem>
            <BreadcrumbPage>{wbsItem.description}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* WBS Header Card */}
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <div className="text-sm font-medium text-muted-foreground">{wbsItem.code}</div>
            <h1 className="text-2xl font-bold tracking-tight mt-1">{wbsItem.description}</h1>
          </div>
          <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-medium">Progress</span>
              <span className="font-semibold tabular-nums">{wbsItem.percentComplete}%</span>
            </div>
            <Progress value={wbsItem.percentComplete} className="h-2" />
          </div>

          {/* Man-Hours Stats */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-muted-foreground">Man-Hours Earned</div>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {wbsItem.earnedMH.toFixed(1)} MH
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-muted-foreground">Man-Hours Total</div>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {wbsItem.totalMH.toFixed(1)} MH
            </div>
          </div>
        </div>
      </div>

      {/* Phases Section */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Phases ({phases.length})</h2>
        {phases.length === 0 ? (
          <div className="rounded-lg border bg-muted/50 p-12 text-center">
            <p className="text-muted-foreground">No phases found for this WBS item.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {phases.map((phase) => (
              <Link
                key={phase.id}
                to="/project/$projectId/wbs/$wbsId/phase/$phaseId"
                params={{ projectId, wbsId, phaseId: phase.id }}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
              >
                <PhaseCard item={phase} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
