import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Plus, ArrowLeft, Settings, Edit } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { WBSCard } from "@truss/features/progress-tracking";
import { getProjectById, getWBSByProject } from "../../data/mock-progress-data";
import { Badge } from "@truss/ui/components/badge";

/**
 * Project dashboard index route component.
 *
 * Displays WBS (Work Breakdown Structure) progress for a specific project:
 * - Project metadata (name, owner, location, progress)
 * - Summary statistics (total MH, earned MH, overall progress)
 * - Grid of WBS cards (responsive: 1-4 columns)
 * - Click-to-drill-down navigation to phase view
 * - Quick actions (Enter Progress, Project Settings)
 *
 * WHY: This is the INDEX route for /project/:id, showing the dashboard.
 * Sibling routes (.entry, .browse, etc.) are handled separately.
 */
export const Route = createFileRoute("/project/$projectId/")({
  component: ProjectDashboardPage,
});

function ProjectDashboardPage() {
  const { projectId } = useParams({ from: "/project/$projectId/" });
  const project = getProjectById(projectId);
  const wbsItems = getWBSByProject(projectId);

  if (!project) {
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
                    ? "success"
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
              {project.proposalNumber} • {project.jobNumber}
            </span>
            <span>•</span>
            <span>{project.owner}</span>
            <span>•</span>
            <span>{project.location}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2">
            <Edit className="h-4 w-4" />
            Edit Estimate
          </Button>
          <Button variant="outline" size="sm" className="gap-2">
            <Settings className="h-4 w-4" />
            Settings
          </Button>
          <Link to="/project/$projectId/entry" params={{ projectId }}>
            <Button size="lg" className="gap-2">
              <Plus className="h-4 w-4" />
              Enter Today's Progress
            </Button>
          </Link>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-6">
          <div className="text-sm font-medium text-muted-foreground">Total Man-Hours</div>
          <div className="mt-3 text-2xl font-bold tabular-nums">
            {project.totalMH.toFixed(1)} MH
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-sm font-medium text-muted-foreground">Earned Man-Hours</div>
          <div className="mt-3 text-2xl font-bold tabular-nums">
            {project.earnedMH.toFixed(1)} MH
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <div className="text-sm font-medium text-muted-foreground">Overall Progress</div>
          <div className="mt-3 text-2xl font-bold tabular-nums">{project.percentComplete}%</div>
        </div>
      </div>

      {/* WBS Section Header */}
      <div className="pt-2">
        <h2 className="text-lg font-semibold">Work Breakdown Structure (WBS)</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Click any WBS item to view detailed phase progress
        </p>
      </div>

      {/* WBS Cards Grid */}
      {wbsItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border-2 border-dashed rounded-lg">
          <p className="text-lg font-medium text-muted-foreground">No WBS items found</p>
          <p className="text-sm text-muted-foreground mt-1">
            Import estimate data to get started with progress tracking
          </p>
          <Button className="mt-4 gap-2">Import from MCP</Button>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {wbsItems.map((item) => (
            <Link
              key={item.id}
              to="/project/$projectId/wbs/$wbsId"
              params={{ projectId, wbsId: item.id }}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
            >
              <WBSCard item={item} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
