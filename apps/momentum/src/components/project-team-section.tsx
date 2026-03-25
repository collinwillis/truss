/**
 * Team section for project settings — shows and manages project assignments.
 *
 * WHY: Admins need to see who is assigned to a project and with what scope
 * and role, with the ability to add/remove assignments inline.
 *
 * Follows the settings page section pattern: section label, rounded-lg border
 * card, table with header row and data rows.
 */

import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useState, useCallback } from "react";
import { UserPlus, Trash2, Users, Globe, Layers, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
import { Badge } from "@truss/ui/components/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Skeleton } from "@truss/ui/components/skeleton";
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
import { getProjectRoleLabel } from "@truss/features/project-assignments/scope-utils";
import type { ProjectRole } from "@truss/features/project-assignments/types";
import { AssignMemberDialog } from "./assign-member-dialog";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

interface ProjectTeamSectionProps {
  projectId: string;
}

/** Get initials from name for avatar fallback. */
function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Icon for scope type. */
function ScopeIcon({ type }: { type: string }) {
  if (type === "project") return <Globe className="h-3 w-3" />;
  if (type === "wbs") return <Layers className="h-3 w-3" />;
  return <FileText className="h-3 w-3" />;
}

export function ProjectTeamSection({ projectId }: ProjectTeamSectionProps) {
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);

  const assignments = useQuery(api.projectAssignments.listProjectAssignments, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const removeAssignment = useMutation(api.projectAssignments.removeAssignment);

  const handleRemove = useCallback(
    async (assignmentId: string, memberName: string) => {
      try {
        await removeAssignment({
          assignmentId: assignmentId as Id<"projectAssignments">,
        });
        toast.success(`${memberName} removed from project`);
      } catch (error) {
        toast.error("Failed to remove assignment", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [removeAssignment]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-muted-foreground">Team</h2>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          onClick={() => setAssignDialogOpen(true)}
        >
          <UserPlus className="h-3 w-3" />
          Assign Member
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        {assignments === undefined ? (
          /* Loading skeleton */
          <div>
            <div className="bg-muted/50 px-4 py-2.5 border-b">
              <Skeleton className="h-3 w-full max-w-sm" />
            </div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-2.5 border-b last:border-b-0 flex items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : assignments.length === 0 ? (
          /* Empty state */
          <div className="py-10 text-center">
            <div className="rounded-full bg-muted p-2.5 mx-auto mb-3 w-fit">
              <Users className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <p className="text-[13px] font-medium text-foreground">No team members assigned</p>
            <p className="text-[11px] text-muted-foreground mt-1 max-w-[240px] mx-auto">
              When no members are assigned, all organization members can access this project.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 gap-1.5 text-[12px]"
              onClick={() => setAssignDialogOpen(true)}
            >
              <UserPlus className="h-3 w-3" />
              Assign First Member
            </Button>
          </div>
        ) : (
          /* Assignments table */
          <div>
            <div className="grid grid-cols-[1fr_140px_120px_36px] gap-3 bg-muted/50 px-4 py-2 border-b">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Member
              </div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Scope
              </div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Role
              </div>
              <div />
            </div>

            {assignments.map((assignment) => (
              <div
                key={assignment.id}
                className="grid grid-cols-[1fr_140px_120px_36px] gap-3 items-center px-4 py-2.5 border-b last:border-b-0 hover:bg-accent/30 transition-colors"
              >
                {/* Member */}
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar className="h-7 w-7 shrink-0">
                    {assignment.userImage && (
                      <AvatarImage src={assignment.userImage} alt={assignment.userName} />
                    )}
                    <AvatarFallback className="text-[10px] font-medium">
                      {getInitials(assignment.userName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{assignment.userName}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {assignment.userEmail}
                    </div>
                  </div>
                </div>

                {/* Scope */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <ScopeIcon type={assignment.scopeType} />
                  <span className="text-[12px] text-muted-foreground truncate">
                    {assignment.scopeName}
                  </span>
                </div>

                {/* Role */}
                <div>
                  <Badge variant="outline" className="text-[10px]">
                    {getProjectRoleLabel(assignment.role as ProjectRole)}
                  </Badge>
                </div>

                {/* Remove */}
                <div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove assignment?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {assignment.userName} will lose access to{" "}
                          {assignment.scopeType === "project"
                            ? "this project"
                            : assignment.scopeName}
                          . You can reassign them later.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleRemove(assignment.id, assignment.userName)}
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AssignMemberDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        projectId={projectId}
      />
    </div>
  );
}
