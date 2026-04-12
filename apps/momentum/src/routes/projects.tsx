import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import {
  Plus,
  Search,
  FolderOpen,
  ArrowUpDown,
  Clock,
  Hash,
  Type,
  TrendingUp,
  Pin,
} from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { ProjectCard } from "@truss/features/progress-tracking";
import { cn } from "@truss/ui/lib/utils";
import type { Project } from "@truss/features/progress-tracking";
import { ProjectsListSkeleton } from "../components/skeletons";
import { CreateProjectDialog } from "../components/create-project-dialog";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { useState, useEffect, useMemo, useCallback } from "react";

// ---------------------------------------------------------------------------
// Sort configuration
// ---------------------------------------------------------------------------

type SortOption = "lastUpdated" | "projectNumber" | "name" | "progress";

const SORT_OPTIONS: { value: SortOption; label: string; icon: typeof Clock }[] = [
  { value: "lastUpdated", label: "Last Updated", icon: Clock },
  { value: "projectNumber", label: "Project Number", icon: Hash },
  { value: "name", label: "Name", icon: Type },
  { value: "progress", label: "Progress", icon: TrendingUp },
];

const SORT_STORAGE_KEY = "momentum:projects:sortBy";

/** Read persisted sort preference from localStorage. */
function getSavedSort(): SortOption {
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (saved && SORT_OPTIONS.some((o) => o.value === saved)) return saved as SortOption;
  } catch {
    // localStorage unavailable — fall through
  }
  return "projectNumber";
}

/** Compare function for each sort option. */
function sortProjects(projects: Project[], sortBy: SortOption): Project[] {
  const sorted = [...projects];
  switch (sortBy) {
    case "lastUpdated":
      return sorted.sort(
        (a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
      );
    case "projectNumber":
      return sorted.sort((a, b) => {
        const numA = parseFloat(a.jobNumber || a.proposalNumber);
        const numB = parseFloat(b.jobNumber || b.proposalNumber);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return (a.jobNumber || a.proposalNumber).localeCompare(b.jobNumber || b.proposalNumber);
      });
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "progress":
      return sorted.sort((a, b) => a.percentComplete - b.percentComplete);
  }
}

// ---------------------------------------------------------------------------
// Filter tabs
// ---------------------------------------------------------------------------

type StatusFilter = "recent" | "all" | "active" | "completed";

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Projects list route — the app landing page.
 *
 * WHY "Recent" as default tab: Users almost always return to the same 2-4
 * projects. Making "Recent" the landing tab (when history exists) saves a
 * click and surfaces the most relevant work immediately — same pattern as
 * Figma's home screen and VS Code's start page.
 */
export const Route = createFileRoute("/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const { workspace } = useWorkspace();
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>(getSavedSort);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  // Allow command palette to open the create dialog via custom event
  useEffect(() => {
    const handleOpen = () => setCreateDialogOpen(true);
    document.addEventListener("open-create-project", handleOpen);
    return () => document.removeEventListener("open-create-project", handleOpen);
  }, []);

  // Persist sort preference
  const handleSortChange = useCallback((value: string) => {
    const next = value as SortOption;
    setSortBy(next);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — ignore
    }
  }, []);

  // Data queries
  const projects = useQuery(api.momentum.listProjects);
  const recentIds = useQuery(api.momentum.getRecentProjectIds);
  const pinnedIds = useQuery(api.momentum.getPinnedProjectIds);
  const togglePin = useMutation(api.momentum.togglePinnedProject);

  const handleTogglePin = useCallback(
    (projectId: string) => {
      togglePin({ projectId: projectId as never });
    },
    [togglePin]
  );

  // Derived data
  const pinnedSet = useMemo(() => new Set(pinnedIds ?? []), [pinnedIds]);
  const recentIdSet = useMemo(() => new Set(recentIds ?? []), [recentIds]);
  const hasRecent = (recentIds ?? []).length > 0;

  const filteredProjects = useMemo(() => {
    if (!projects) return [];
    return projects.filter((project) => {
      const matchesSearch =
        searchQuery === "" ||
        project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        project.owner.toLowerCase().includes(searchQuery.toLowerCase()) ||
        project.location.toLowerCase().includes(searchQuery.toLowerCase()) ||
        project.jobNumber.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      switch (statusFilter) {
        case "recent":
          return recentIdSet.has(project.id);
        case "active":
          return project.status === "active";
        case "completed":
          return project.status === "completed";
        case "all":
        default:
          return true;
      }
    });
  }, [projects, searchQuery, statusFilter, recentIdSet]);

  // For the "Recent" tab, preserve the recency order from the backend
  const displayProjects = useMemo(() => {
    if (statusFilter === "recent" && recentIds) {
      const projectMap = new Map(filteredProjects.map((p) => [p.id, p]));
      return recentIds.map((id) => projectMap.get(id)).filter(Boolean) as Project[];
    }
    return sortProjects(filteredProjects, sortBy);
  }, [filteredProjects, statusFilter, recentIds, sortBy]);

  // Split into pinned + unpinned for non-recent tabs
  const pinnedProjects = useMemo(() => {
    if (statusFilter === "recent" || pinnedSet.size === 0) return [];
    return displayProjects.filter((p) => pinnedSet.has(p.id));
  }, [displayProjects, pinnedSet, statusFilter]);

  const unpinnedProjects = useMemo(() => {
    if (statusFilter === "recent") return displayProjects;
    return displayProjects.filter((p) => !pinnedSet.has(p.id));
  }, [displayProjects, pinnedSet, statusFilter]);

  if (projects === undefined) {
    return <ProjectsListSkeleton />;
  }

  const activeCount = projects.filter((p) => p.status === "active").length;
  const completedCount = projects.filter((p) => p.status === "completed").length;
  const recentCount = (recentIds ?? []).length;

  // Build filter tabs — only show "Recent" if the user has history
  const filterTabs: { value: StatusFilter; label: string; count: number }[] = [
    ...(hasRecent ? [{ value: "recent" as const, label: "Recent", count: recentCount }] : []),
    { value: "all", label: "All", count: projects.length },
    { value: "active", label: "Active", count: activeCount },
    { value: "completed", label: "Completed", count: completedCount },
  ];

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-title3 font-semibold">Projects</h1>
          <span className="text-callout text-foreground-subtle tabular-nums">
            {projects.length}
          </span>
        </div>
        {isAdmin && (
          <Button variant="default" size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="size-3.5" />
            New Project
          </Button>
        )}
      </div>

      {/* Search + filter + sort bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-[240px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-7"
          />
        </div>

        {/* macOS segmented control style */}
        <div className="flex items-center rounded-lg bg-fill-tertiary p-[3px]">
          {filterTabs.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatusFilter(filter.value)}
              className={cn(
                "px-2 py-[3px] rounded-md text-subheadline font-medium transition-all",
                statusFilter === filter.value
                  ? "bg-background shadow-xs text-foreground"
                  : "text-foreground-subtle hover:text-foreground"
              )}
            >
              {filter.label}
              <span className="ml-1 tabular-nums opacity-50">{filter.count}</span>
            </button>
          ))}
        </div>

        {/* Sort dropdown — pushed to the right, hidden on Recent tab (recency is the sort) */}
        {statusFilter !== "recent" && (
          <div className="ml-auto flex items-center gap-1.5">
            <ArrowUpDown className="h-3 w-3 text-foreground-subtle" />
            <Select value={sortBy} onValueChange={handleSortChange}>
              <SelectTrigger className="h-7 text-subheadline gap-1.5 border-0 bg-transparent shadow-none hover:bg-fill-quaternary px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <div className="flex items-center gap-2">
                      <opt.icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {opt.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Project cards */}
      {displayProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="rounded-full bg-fill-quaternary p-3 mb-4">
            <FolderOpen className="h-6 w-6 text-label-quaternary" />
          </div>
          <p className="text-body font-medium text-foreground">
            {searchQuery ? "No matching projects" : "No projects yet"}
          </p>
          <p className="text-body text-muted-foreground mt-1 max-w-[260px]">
            {searchQuery
              ? "Try a different search term or clear your filters."
              : "Import an estimate from Precision to create your first tracking project."}
          </p>
          {!searchQuery && isAdmin && (
            <Button size="sm" className="mt-4 gap-1.5" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New Project
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {/* Pinned projects section — only on non-recent tabs */}
          {pinnedProjects.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2.5">
                <Pin className="h-3.5 w-3.5 text-primary/60 fill-primary/60" />
                <h2 className="text-subheadline font-medium text-muted-foreground uppercase tracking-wider">
                  Pinned
                </h2>
              </div>
              <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {pinnedProjects.map((project) => (
                  <Link
                    key={project.id}
                    to="/project/$projectId"
                    params={{ projectId: project.id }}
                    search={{ wbs: undefined }}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
                  >
                    <ProjectCard project={project} isPinned onTogglePin={handleTogglePin} />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Main projects grid */}
          {unpinnedProjects.length > 0 && (
            <section>
              {pinnedProjects.length > 0 && (
                <div className="flex items-center gap-2 mb-2.5">
                  <h2 className="text-subheadline font-medium text-muted-foreground uppercase tracking-wider">
                    All Projects
                  </h2>
                </div>
              )}
              <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {unpinnedProjects.map((project) => (
                  <Link
                    key={project.id}
                    to="/project/$projectId"
                    params={{ projectId: project.id }}
                    search={{ wbs: undefined }}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
                  >
                    <ProjectCard
                      project={project}
                      isPinned={pinnedSet.has(project.id)}
                      onTogglePin={handleTogglePin}
                    />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {isAdmin && (
        <CreateProjectDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      )}
    </div>
  );
}
