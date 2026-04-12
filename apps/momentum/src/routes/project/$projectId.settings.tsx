import { createFileRoute, Link, useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { Loader2, Trash2, ShieldAlert } from "lucide-react";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
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
import { ProjectTeamSection } from "../../components/project-team-section";

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
  const { workspace } = useWorkspace();
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";

  const wbsData = useQuery(api.momentum.getProjectWBS, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const updateProject = useMutation(api.momentum.updateProject);
  const deleteProjectMut = useMutation(api.momentum.deleteProject);

  const [name, setName] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [workCalendar, setWorkCalendar] = React.useState("5x10");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [initialized, setInitialized] = React.useState(false);

  React.useEffect(() => {
    if (wbsData?.project && !initialized) {
      setName(wbsData.project.name);
      setStatus(wbsData.project.status);
      setWorkCalendar(wbsData.project.workCalendar ?? "5x10");
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
        workCalendar: workCalendar as "5x10" | "6x10" | "7x10",
      });
      toast.success("Project settings saved");
    } catch (error) {
      toast.error("Failed to save", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSaving(false);
    }
  }, [projectId, name, status, workCalendar, startDate, endDate, updateProject]);

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

  /* ── Admin-only access guard ── */
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <ShieldAlert className="h-8 w-8 text-label-quaternary" />
        <p className="text-title3 font-semibold text-foreground">Admin Access Required</p>
        <p className="text-body text-muted-foreground text-center max-w-sm">
          Project settings are only available to organization administrators.
        </p>
        <Link to="/project/$projectId" params={{ projectId }} search={{ wbs: undefined }}>
          <Button variant="outline" size="sm">
            Back to Workbook
          </Button>
        </Link>
      </div>
    );
  }

  /* ── Loading ── */
  if (wbsData === undefined) {
    return (
      <div className="space-y-5 pb-8 flex-1 min-h-0 overflow-auto">
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
        <p className="text-title3 font-semibold text-muted-foreground">Project not found</p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8 flex-1 min-h-0 overflow-auto">
      <h1 className="text-title3 font-semibold tracking-tight">Project Settings</h1>

      <div className="max-w-xl space-y-8">
        {/* ── General section ── */}
        <div className="space-y-3">
          <h2 className="text-body font-semibold text-muted-foreground">General</h2>
          <div className="rounded-mac-card border bg-card overflow-hidden">
            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="project-name" className="text-body font-medium">
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
                <Label htmlFor="project-status" className="text-body font-medium">
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

              <div className="space-y-1.5">
                <Label htmlFor="work-calendar" className="text-body font-medium">
                  Work Schedule
                </Label>
                <Select value={workCalendar} onValueChange={setWorkCalendar}>
                  <SelectTrigger id="work-calendar" className="w-[220px]">
                    <SelectValue placeholder="Select schedule" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5x10">5 x 10 &mdash; Mon&ndash;Fri</SelectItem>
                    <SelectItem value="6x10">6 x 10 &mdash; Mon&ndash;Sat</SelectItem>
                    <SelectItem value="7x10">7 x 10 &mdash; Every Day</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-subheadline text-muted-foreground">
                  Non-work days are dimmed on the calendar but still selectable.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="start-date" className="text-body font-medium">
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
                  <Label htmlFor="end-date" className="text-body font-medium">
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
            <div className="border-t px-5 py-3 bg-fill-quaternary/30 flex justify-end">
              <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>

        {/* ── Team section ── */}
        <ProjectTeamSection projectId={projectId} />

        {/* ── Danger zone ── */}
        <div className="space-y-3">
          <h2 className="text-body font-semibold text-mac-red/70">Danger Zone</h2>
          <div className="rounded-lg border border-mac-red/20 border-l-[3px] border-l-mac-red/50 p-5">
            <div className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <p className="text-body font-medium">Delete this project</p>
                <p className="text-subheadline text-muted-foreground mt-0.5">
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
