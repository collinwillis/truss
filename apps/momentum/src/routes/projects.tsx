import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Upload, Search } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@truss/ui/components/tabs";
import { ProjectCard } from "@truss/features/progress-tracking";
import { mockProjects, getActiveProjects } from "../data/mock-progress-data";
import { useState } from "react";

/**
 * Projects list route component.
 *
 * Displays all construction projects with:
 * - Grid/card layout for easy scanning
 * - Filtering by status (All, Active, Completed)
 * - Search functionality
 * - Quick actions (Create New, Import from MCP)
 * - Click-to-navigate to project dashboard
 */
export const Route = createFileRoute("/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");

  // Filter projects based on search and status
  const filteredProjects = mockProjects.filter((project) => {
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

  const activeCount = getActiveProjects().length;
  const completedCount = mockProjects.filter((p) => p.status === "completed").length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground mt-2">
            Select a project to view progress and enter daily quantities
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="gap-2">
            <Upload className="h-4 w-4" />
            Import from MCP
          </Button>
          <Button className="gap-2">
            <Plus className="h-4 w-4" />
            Create New Project
          </Button>
        </div>
      </div>

      {/* Search and Filter Controls */}
      <div className="flex items-center gap-4">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Status Filter Tabs */}
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
          <TabsList>
            <TabsTrigger value="all">
              All{" "}
              <span className="ml-1.5 text-xs text-muted-foreground">({mockProjects.length})</span>
            </TabsTrigger>
            <TabsTrigger value="active">
              Active <span className="ml-1.5 text-xs text-muted-foreground">({activeCount})</span>
            </TabsTrigger>
            <TabsTrigger value="completed">
              Completed{" "}
              <span className="ml-1.5 text-xs text-muted-foreground">({completedCount})</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Project Cards Grid */}
      {filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border-2 border-dashed rounded-lg">
          <p className="text-lg font-medium text-muted-foreground">No projects found</p>
          <p className="text-sm text-muted-foreground mt-1">
            {searchQuery ? "Try adjusting your search" : "Create your first project to get started"}
          </p>
          {!searchQuery && (
            <Button className="mt-4 gap-2">
              <Plus className="h-4 w-4" />
              Create New Project
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredProjects.map((project) => (
            <Link
              key={project.id}
              to="/project/$projectId"
              params={{ projectId: project.id }}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
            >
              <ProjectCard project={project} />
            </Link>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {filteredProjects.length > 0 && (
        <div className="pt-6 border-t">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-sm font-medium text-muted-foreground">Total Projects</div>
              <div className="mt-2 text-2xl font-bold">{filteredProjects.length}</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-sm font-medium text-muted-foreground">Total Man-Hours</div>
              <div className="mt-2 text-2xl font-bold">
                {filteredProjects.reduce((sum, project) => sum + project.totalMH, 0).toFixed(0)} MH
              </div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-sm font-medium text-muted-foreground">Average Progress</div>
              <div className="mt-2 text-2xl font-bold">
                {Math.round(
                  filteredProjects.reduce((sum, project) => sum + project.percentComplete, 0) /
                    filteredProjects.length
                )}
                %
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
