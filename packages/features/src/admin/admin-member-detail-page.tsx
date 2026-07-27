import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
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
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Badge } from "@truss/ui/components/badge";
import { Button } from "@truss/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { Skeleton } from "@truss/ui/components/skeleton";
// Re-exported by the UI package alongside <Toaster>, so shared code reaches the
// toast queue the apps already mount without its own sonner dependency.
import { toast } from "@truss/ui/components/sonner";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Crown,
  FolderOpen,
  Loader2,
  MapPin,
  Shield,
  ShieldCheck,
  Trash2,
  UserMinus,
} from "lucide-react";
import { useCallback, useState, type JSX } from "react";

import { getRoleLabel } from "../organizations/permissions";
import type { AppName, AppPermissionLevel } from "../organizations/types";
import { getProjectRoleLabel } from "../project-assignments/scope-utils";
import type { ProjectRole } from "../project-assignments/types";
import {
  AdminAccessRequired,
  useIsOrganizationAdmin,
  useIsWorkspaceResolving,
} from "./admin-access-guard";
import { AppPermissionSelect } from "./app-permission-select";
import { getMemberInitials } from "./member-display";

/**
 * Page root sizing.
 *
 * WHY here and not in the shell: the shell's content area is a flex column with
 * no scroller of its own, so each page owns its overflow — matching the other
 * pages in both apps. Without this the danger zone is unreachable in a short
 * window.
 */
const PAGE_ROOT = "space-y-5 flex-1 min-h-0 overflow-y-auto pb-8";

/** Props for {@link AdminMemberDetailPage}. */
export interface AdminMemberDetailPageProps {
  /** Better Auth member id, read from the host app's route params. */
  memberId: string;
  /**
   * Returns to the members list — used by the back link and after a successful
   * removal.
   *
   * WHY a callback and not a route: `Link`/`useNavigate` are typed against each
   * app's generated route tree, which a shared package cannot import.
   */
  onBack: () => void;
}

/**
 * Admin member detail page — view and manage a single organization member.
 *
 * WHY this layout: Follows GitHub/Stripe settings patterns — left-aligned
 * sections with clear headers, inline editable fields, and a danger zone.
 *
 * Both desktop apps sit on the same Better Auth organization and the same
 * `api.adminUsers` functions, so the data access lives here rather than being
 * injected — one implementation of who can grant what, for both apps.
 */
export function AdminMemberDetailPage({
  memberId,
  onBack,
}: AdminMemberDetailPageProps): JSX.Element {
  const isOrgAdmin = useIsOrganizationAdmin();
  const isResolving = useIsWorkspaceResolving();

  // Skipped for non-admins so another member's record is never fetched to a
  // client that is not allowed to see it — the Convex query does not check the
  // caller's role.
  const member = useQuery(api.adminUsers.getMemberDetail, isOrgAdmin ? { memberId } : "skip");
  const userAssignments = useQuery(
    api.projectAssignments.listUserAssignments,
    member ? { userId: member.userId } : "skip"
  );

  const updateRole = useMutation(api.adminUsers.updateMemberRole);
  const banMember = useMutation(api.adminUsers.banMember);
  const unbanMember = useMutation(api.adminUsers.unbanMember);
  const removeMember = useMutation(api.adminUsers.removeMember);
  const setPermission = useMutation(api.appPermissions.setPermission);
  const removeAssignment = useMutation(api.projectAssignments.removeAssignment);

  const [removing, setRemoving] = useState(false);

  const handleRoleChange = useCallback(
    async (role: "admin" | "member") => {
      try {
        await updateRole({ memberId, role });
        toast.success(`Role updated to ${getRoleLabel(role)}`);
      } catch (error) {
        toast.error("Failed to update role", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [memberId, updateRole]
  );

  const handlePermissionChange = useCallback(
    async (app: AppName, permission: AppPermissionLevel) => {
      try {
        await setPermission({ memberId, app, permission });
        toast.success("Permission updated");
      } catch (error) {
        toast.error("Failed to update permission", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [memberId, setPermission]
  );

  const handleToggleBan = useCallback(async () => {
    if (!member) return;
    try {
      if (member.isBanned) {
        await unbanMember({ memberId });
        toast.success(`${member.name} has been reactivated`);
      } else {
        await banMember({ memberId });
        toast.success(`${member.name} has been suspended`);
      }
    } catch (error) {
      toast.error("Action failed", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  }, [member, memberId, banMember, unbanMember]);

  const handleRemove = useCallback(async () => {
    if (!member) return;
    setRemoving(true);
    try {
      await removeMember({ memberId });
      toast.success(`${member.name} has been removed`);
      onBack();
    } catch (error) {
      toast.error("Failed to remove member", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setRemoving(false);
    }
  }, [member, memberId, removeMember, onBack]);

  const handleRemoveAssignment = useCallback(
    async (assignmentId: string) => {
      try {
        await removeAssignment({ assignmentId: assignmentId as Id<"projectAssignments"> });
        toast.success("Assignment removed");
      } catch (error) {
        toast.error("Failed to remove assignment", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [removeAssignment]
  );

  /* ── Not an admin — gate before the skeleton so a member who lands here by
     URL never sees another member's details load in.

     Ordered after the resolving check on purpose: unlike the members list, this
     page has no `!orgId` branch to mask the window in which the workspace still
     reads as personal (role: null), so checking admin first would flash
     "Admin access required" at a real admin on a reload. ── */
  if (!isResolving && !isOrgAdmin) {
    return <AdminAccessRequired />;
  }

  /* ── Loading ── */
  if (isResolving || member === undefined) {
    return (
      <div className={PAGE_ROOT}>
        <Skeleton className="h-5 w-24" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
        <div className="max-w-xl space-y-8">
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  /* ── Not found ── */
  if (member === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <p className="text-title3 font-semibold text-muted-foreground">Member not found</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to Members
        </Button>
      </div>
    );
  }

  const isOwner = member.orgRole === "owner";

  return (
    <div className={PAGE_ROOT}>
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-body text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Members
      </button>

      {/* Member header */}
      <div className="flex items-center gap-4">
        <Avatar className="h-16 w-16">
          {member.image && <AvatarImage src={member.image} alt={member.name} />}
          <AvatarFallback className="text-title3 font-medium">
            {getMemberInitials(member.name)}
          </AvatarFallback>
        </Avatar>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-title3 font-semibold tracking-tight">{member.name}</h1>
            {member.isBanned && (
              <Badge variant="destructive" className="text-footnote gap-1">
                <Ban className="h-2.5 w-2.5" />
                Suspended
              </Badge>
            )}
            {isOwner && (
              <Badge variant="default" className="text-footnote gap-1">
                <Crown className="h-2.5 w-2.5" />
                Owner
              </Badge>
            )}
          </div>
          <p className="text-body text-muted-foreground mt-0.5">{member.email}</p>
          <p className="text-subheadline text-foreground-subtle mt-0.5">
            Joined {new Date(member.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="max-w-xl space-y-8">
        {/* ── Role & Permissions section ── */}
        <div className="space-y-3">
          <h2 className="text-body font-semibold text-muted-foreground">Role & Permissions</h2>
          <div className="rounded-mac-card border bg-card overflow-hidden">
            <div className="p-5 space-y-4">
              {/* Org role */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-body font-medium">Organization Role</p>
                  <p className="text-subheadline text-muted-foreground mt-0.5">
                    Controls admin access and organization management
                  </p>
                </div>
                {isOwner ? (
                  <Badge variant="default" className="text-footnote">
                    Owner
                  </Badge>
                ) : (
                  <Select
                    value={member.orgRole}
                    onValueChange={(v) => handleRoleChange(v as "admin" | "member")}
                  >
                    <SelectTrigger className="w-[120px] h-8 text-callout">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin" className="text-callout">
                        <div className="flex items-center gap-1.5">
                          <ShieldCheck className="h-3 w-3" />
                          Admin
                        </div>
                      </SelectItem>
                      <SelectItem value="member" className="text-callout">
                        <div className="flex items-center gap-1.5">
                          <Shield className="h-3 w-3" />
                          Member
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="border-t" />

              {/* Momentum permission */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-body font-medium">Momentum</p>
                  <p className="text-subheadline text-muted-foreground mt-0.5">
                    Progress tracking and workbook access
                  </p>
                </div>
                {isOwner ? (
                  <Badge variant="secondary" className="text-footnote">
                    Admin
                  </Badge>
                ) : (
                  <AppPermissionSelect
                    value={member.appPermissions.momentum}
                    onValueChange={(permission) => handlePermissionChange("momentum", permission)}
                    triggerClassName="w-[120px] h-8 text-callout"
                  />
                )}
              </div>

              {/* Precision permission */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-body font-medium">Precision</p>
                  <p className="text-subheadline text-muted-foreground mt-0.5">
                    Estimating and proposal management
                  </p>
                </div>
                {isOwner ? (
                  <Badge variant="secondary" className="text-footnote">
                    Admin
                  </Badge>
                ) : (
                  <AppPermissionSelect
                    value={member.appPermissions.precision}
                    onValueChange={(permission) => handlePermissionChange("precision", permission)}
                    triggerClassName="w-[120px] h-8 text-callout"
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Project assignments section ── */}
        <div className="space-y-3">
          <h2 className="text-body font-semibold text-muted-foreground">Project Assignments</h2>
          <div className="rounded-mac-card border bg-card overflow-hidden">
            {userAssignments === undefined ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-4 w-4" />
                    <Skeleton className="h-4 w-48" />
                  </div>
                ))}
              </div>
            ) : userAssignments.length === 0 ? (
              <div className="py-10 text-center">
                <FolderOpen className="h-5 w-5 text-label-quaternary mx-auto mb-2" />
                <p className="text-body text-muted-foreground">No project assignments</p>
                <p className="text-subheadline text-foreground-subtle mt-0.5">
                  Assign this member to projects from the project settings page.
                </p>
              </div>
            ) : (
              <div>
                {/* Assignment table header */}
                <div className="grid grid-cols-[1fr_120px_100px_36px] gap-3 bg-fill-quaternary/50 px-4 py-2 border-b">
                  <div className="text-subheadline font-medium uppercase tracking-wider text-muted-foreground">
                    Project
                  </div>
                  <div className="text-subheadline font-medium uppercase tracking-wider text-muted-foreground">
                    Scope
                  </div>
                  <div className="text-subheadline font-medium uppercase tracking-wider text-muted-foreground">
                    Role
                  </div>
                  <div />
                </div>

                {/* Assignment rows */}
                {userAssignments.map((assignment) => (
                  <div
                    key={assignment.id}
                    className="grid grid-cols-[1fr_120px_100px_36px] gap-3 items-center px-4 py-2.5 border-b last:border-b-0 hover:bg-fill-quaternary transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderOpen className="h-3.5 w-3.5 text-foreground-subtle shrink-0" />
                      <span className="text-body truncate">{assignment.projectName}</span>
                    </div>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <MapPin className="h-3 w-3 text-foreground-subtle shrink-0" />
                      <span className="text-callout text-muted-foreground truncate">
                        {assignment.scopeName}
                      </span>
                    </div>
                    <div>
                      <Badge variant="outline" className="text-footnote">
                        {getProjectRoleLabel(assignment.role as ProjectRole)}
                      </Badge>
                    </div>
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveAssignment(assignment.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Danger zone ── */}
        {!isOwner && (
          <div className="space-y-3">
            <h2 className="text-body font-semibold text-destructive/70">Danger Zone</h2>
            <div className="rounded-mac-card border border-mac-red/20 border-l-[3px] border-l-mac-red/50 p-5 space-y-4">
              {/* Suspend / Reactivate */}
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <p className="text-body font-medium">
                    {member.isBanned ? "Reactivate this member" : "Suspend this member"}
                  </p>
                  <p className="text-subheadline text-muted-foreground mt-0.5">
                    {member.isBanned
                      ? "Restore access to all applications."
                      : "Temporarily revoke access to all applications."}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant={member.isBanned ? "outline" : "destructive"}
                      size="sm"
                      className="gap-1.5 shrink-0"
                    >
                      {member.isBanned ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Reactivate
                        </>
                      ) : (
                        <>
                          <Ban className="h-3.5 w-3.5" />
                          Suspend
                        </>
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {member.isBanned ? "Reactivate member?" : "Suspend member?"}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {member.isBanned
                          ? `${member.name} will regain access to applications based on their permissions.`
                          : `${member.name} will be unable to access any applications until reactivated.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleToggleBan}>
                        {member.isBanned ? "Reactivate" : "Suspend"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="border-t border-destructive/10" />

              {/* Remove */}
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <p className="text-body font-medium">Remove from organization</p>
                  <p className="text-subheadline text-muted-foreground mt-0.5">
                    Permanently remove this member and all their permissions and assignments.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="gap-1.5 shrink-0">
                      <UserMinus className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove member?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently remove {member.name} from the organization, delete all
                        their permissions and project assignments. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleRemove}
                        disabled={removing}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {removing ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                            Removing...
                          </>
                        ) : (
                          "Remove Member"
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
