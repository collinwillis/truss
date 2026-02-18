import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { Plus, Search, FolderOpen } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { ProjectCard } from "@truss/features/progress-tracking";
import { ProjectsListSkeleton } from "../components/skeletons";
import { CreateProjectDialog } from "../components/create-project-dialog";
import { useState, useEffect } from "react";

/**
 * Projects list route — the app landing page.
 *
 * WHY this layout: Follows Monday.com/Linear patterns for project list views.
 * Compact header with count, inline search + filters, responsive card grid.
 * No instructional subtitle — professional desktop apps trust their users.
 */
export const Route = createFileRoute("/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Allow command palette to open the create dialog via custom event
  useEffect(() => {
    const handleOpen = () => setCreateDialogOpen(true);
    document.addEventListener("open-create-project", handleOpen);
    return () => document.removeEventListener("open-create-project", handleOpen);
  }, []);

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
    <div className="space-y-5">
      {/* Page header — compact, confident */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
            {projects.length}
          </span>
        </div>
        <Button size="sm" className="gap-1.5 h-8" onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New Project
        </Button>
      </div>

      {/* Search + filter bar — single tight row */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-[280px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>

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
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                statusFilter === filter.value
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {filter.label}
              <span className="ml-1 tabular-nums text-muted-foreground/60">{filter.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Project cards */}
      {filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="rounded-full bg-muted p-3 mb-4">
            <FolderOpen className="h-6 w-6 text-muted-foreground/40" />
          </div>
          <p className="text-sm font-medium text-foreground">
            {searchQuery ? "No matching projects" : "No projects yet"}
          </p>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-[260px]">
            {searchQuery
              ? "Try a different search term or clear your filters."
              : "Import an estimate from Precision to create your first tracking project."}
          </p>
          {!searchQuery && (
            <Button size="sm" className="mt-4 gap-1.5" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New Project
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
