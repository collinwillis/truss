import { createFileRoute, Link, useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
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
 * Project settings page — edit project metadata and manage lifecycle.
 *
 * WHY this layout: Follows GitHub/Stripe settings patterns — clean form
 * sections with footer-style save, horizontal danger zone.
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
      <div className="space-y-5 pb-8">
        <Skeleton className="h-6 w-36" />
        <div className="max-w-xl space-y-8">
          <div className="space-y-3">
            <Skeleton className="h-4 w-16" />
            <div className="rounded-lg border p-5 space-y-4">
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-9 w-full" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-9 w-32" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-9 w-full" />
                </div>
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-9 w-full" />
                </div>
              </div>
            </div>
          </div>
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
    <div className="space-y-5 pb-8">
      <h1 className="text-lg font-semibold tracking-tight">Project Settings</h1>

      <div className="max-w-xl space-y-8">
        {/* ── General section ── */}
        <div className="space-y-3">
          <h2 className="text-[13px] font-semibold text-muted-foreground">General</h2>
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="project-name" className="text-[13px] font-medium">
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
                <Label htmlFor="project-status" className="text-[13px] font-medium">
                  Status
                </Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="project-status" className="w-[180px]">
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
                  <Label htmlFor="start-date" className="text-[13px] font-medium">
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
                  <Label htmlFor="end-date" className="text-[13px] font-medium">
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
            </div>

            {/* Save footer — GitHub/Stripe pattern */}
            <div className="border-t px-5 py-3 bg-muted/30 flex justify-end">
              <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>

        {/* ── Danger zone ── */}
        <div className="space-y-3">
          <h2 className="text-[13px] font-semibold text-destructive/70">Danger Zone</h2>
          <div className="rounded-lg border border-destructive/20 p-5">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Delete this project</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Permanently remove this project and all its progress entries.
                </p>
              </div>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="gap-1.5 shrink-0">
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
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
    </div>
  );
}
