import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { Plus, Upload, Search, FolderOpen } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { ProjectCard } from "@truss/features/progress-tracking";
import { ProjectsListSkeleton } from "../components/skeletons";
import { CreateProjectDialog } from "../components/create-project-dialog";
import { useState } from "react";

/**
 * Projects list route — the app landing page.
 *
 * WHY: First screen users see. Needs to be scannable with clear
 * status at a glance and fast navigation to any project.
 */
export const Route = createFileRoute("/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const projects = useQuery(api.momentum.listProjects);

  if (projects === undefined) {
    return <ProjectsListSkeleton />;
  }

  const filteredProjects = projects.filter((project) => {
    const matchesSearch =
      searchQuery === "" ||
      project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.owner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.location.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.jobNumber.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && project.status === "active") ||
      (statusFilter === "completed" && project.status === "completed");

    return matchesSearch && matchesStatus;
  });

  const activeCount = projects.filter((p) => p.status === "active").length;
  const completedCount = projects.filter((p) => p.status === "completed").length;

  return (
    <div className="space-y-6">
      {/* ── Page header ── */}
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Select a project to view progress and enter daily quantities
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Upload className="h-3.5 w-3.5" />
            Import from Estimate
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Project
          </Button>
        </div>
      </div>

      {/* ── Search and filter ── */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>

        {/* Pill-style filter buttons */}
        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
          {(
            [
              { value: "all", label: "All", count: projects.length },
              { value: "active", label: "Active", count: activeCount },
              { value: "completed", label: "Completed", count: completedCount },
            ] as const
          ).map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatusFilter(filter.value)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                statusFilter === filter.value
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {filter.label}
              <span className="ml-1 tabular-nums text-muted-foreground/80">{filter.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Project cards ── */}
      {filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center border rounded-lg bg-muted/20">
          <FolderOpen className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No projects found</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            {searchQuery
              ? "Try adjusting your search"
              : "Import a proposal to create your first project"}
          </p>
          {!searchQuery && (
            <Button
              size="sm"
              variant="outline"
              className="mt-4 gap-1.5"
              onClick={() => setCreateDialogOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Import from Estimate
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredProjects.map((project) => (
            <Link
              key={project.id}
              to="/project/$projectId"
              params={{ projectId: project.id }}
              search={{ wbs: undefined }}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
            >
              <ProjectCard project={project} />
            </Link>
          ))}
        </div>
      )}

      <CreateProjectDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </div>
  );
}
