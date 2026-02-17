import { createFileRoute, Link, useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { Save, Trash2, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@truss/ui/components/breadcrumb";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@truss/ui/components/alert-dialog";
import { Skeleton } from "@truss/ui/components/skeleton";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Project settings page — edit project metadata and manage project lifecycle.
 *
 * WHY: Project managers need to update project details, change status,
 * and manage project lifecycle without developer intervention.
 */
export const Route = createFileRoute("/project/$projectId/settings")({
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectId } = useParams({ from: "/project/$projectId/settings" });
  const navigate = useNavigate();

  const wbsData = useQuery(api.momentum.getProjectWBS, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const updateProject = useMutation(api.momentum.updateProject);
  const deleteProjectMut = useMutation(api.momentum.deleteProject);

  const [name, setName] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [initialized, setInitialized] = React.useState(false);

  // Initialize form from query data
  React.useEffect(() => {
    if (wbsData?.project && !initialized) {
      setName(wbsData.project.name);
      setStatus(wbsData.project.status);
      setInitialized(true);
    }
  }, [wbsData, initialized]);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    try {
      await updateProject({
        projectId: projectId as Id<"momentumProjects">,
        name: name || undefined,
        status: (status as "active" | "on-hold" | "completed" | "archived") || undefined,
        actualStartDate: startDate || undefined,
        projectedEndDate: endDate || undefined,
      });
      toast.success("Project settings saved");
    } catch (error) {
      toast.error("Failed to save", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSaving(false);
    }
  }, [projectId, name, status, startDate, endDate, updateProject]);

  const handleDelete = React.useCallback(async () => {
    setDeleting(true);
    try {
      await deleteProjectMut({ projectId: projectId as Id<"momentumProjects"> });
      toast.success("Project deleted");
      navigate({ to: "/projects" });
    } catch (error) {
      toast.error("Failed to delete", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setDeleting(false);
    }
  }, [projectId, deleteProjectMut, navigate]);

  /* ── Loading ── */
  if (wbsData === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-7 w-32" />
        <div className="max-w-xl space-y-6">
          <div className="rounded-lg border p-6 space-y-5">
            <div className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-9 w-full" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            </div>
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  /* ── Not found ── */
  if (wbsData === null) {
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
            <BreadcrumbLink asChild>
              <Link to="/project/$projectId" params={{ projectId }} search={{ wbs: undefined }}>
                {wbsData.project.name}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Settings</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="text-xl font-bold tracking-tight">Settings</h1>

      {/* ── Form ── */}
      <div className="max-w-lg space-y-6">
        {/* General section */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            General
          </h2>
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name" className="text-xs font-medium">
                Project Name
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-status" className="text-xs font-medium">
                Status
              </Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="project-status">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="on-hold">On Hold</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="start-date" className="text-xs font-medium">
                  Start Date
                </Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="end-date" className="text-xs font-medium">
                  Projected End Date
                </Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            <div className="pt-1">
              <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>

        {/* Danger zone */}
        <div className="space-y-3 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-destructive/70">
            Danger Zone
          </h2>
          <div className="rounded-lg border border-destructive/20 p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 shrink-0 mt-0.5">
                <Info className="h-4 w-4 text-destructive/70" />
              </div>
              <div>
                <p className="text-sm font-medium">Delete this project</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Permanently remove this project and all its progress entries. The underlying
                  estimate in Precision will not be affected.
                </p>
              </div>
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="gap-1.5">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete Project
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete &ldquo;{wbsData.project.name}&rdquo; and all its
                    progress entries. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} disabled={deleting}>
                    {deleting ? "Deleting..." : "Delete Project"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
  );
}
