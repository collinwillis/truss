import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useState, useMemo, useCallback } from "react";
import {
  Search,
  Users,
  Shield,
  ShieldCheck,
  Ban,
  MoreHorizontal,
  UserPlus,
  Crown,
  UserMinus,
  ShieldAlert,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Badge } from "@truss/ui/components/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Skeleton } from "@truss/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@truss/ui/components/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import type { MemberStatusFilter } from "@truss/features/admin/types";
import { cn } from "@truss/ui/lib/utils";

/**
 * Admin members list — organization member management.
 *
 * WHY this layout: Follows the projects.tsx page pattern — compact header
 * with count badge, search + filter bar, then a table. Uses Monday.com/Linear
 * table patterns for professional data-dense displays.
 */
export const Route = createFileRoute("/admin/")({
  component: AdminMembersPage,
});

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

/** Human-readable label for an organization role. */
function getRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
    guest: "Guest",
  };
  return labels[role] ?? role;
}

/** Badge variant for organization role. */
function getRoleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  if (role === "owner") return "default";
  if (role === "admin") return "secondary";
  return "outline";
}

/** Human-readable permission label. */
function getPermissionLabel(level: string): string {
  const labels: Record<string, string> = {
    none: "No access",
    read: "View",
    write: "Edit",
    admin: "Admin",
  };
  return labels[level] ?? level;
}

function AdminMembersPage() {
  const navigate = useNavigate();
  const { workspace } = useWorkspace();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<MemberStatusFilter>("all");
  const [confirmAction, setConfirmAction] = useState<{
    type: "ban" | "unban" | "remove";
    memberId: string;
    memberName: string;
  } | null>(null);

  const orgId = workspace?.organization_id;

  const members = useQuery(
    api.adminUsers.listOrganizationMembers,
    orgId ? { organizationId: orgId } : "skip"
  );

  const banMember = useMutation(api.adminUsers.banMember);
  const unbanMember = useMutation(api.adminUsers.unbanMember);
  const removeMember = useMutation(api.adminUsers.removeMember);
  const updateRole = useMutation(api.adminUsers.updateMemberRole);
  const setPermission = useMutation(api.appPermissions.setPermission);

  const filteredMembers = useMemo(() => {
    if (!members) return undefined;

    return members.filter((member) => {
      const matchesSearch =
        searchQuery === "" ||
        member.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        member.email.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && !member.isBanned) ||
        (statusFilter === "suspended" && member.isBanned);

      return matchesSearch && matchesStatus;
    });
  }, [members, searchQuery, statusFilter]);

  const activeCount = members?.filter((m) => !m.isBanned).length ?? 0;
  const suspendedCount = members?.filter((m) => m.isBanned).length ?? 0;

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction) return;

    try {
      if (confirmAction.type === "ban") {
        await banMember({ memberId: confirmAction.memberId });
        toast.success(`${confirmAction.memberName} has been suspended`);
      } else if (confirmAction.type === "unban") {
        await unbanMember({ memberId: confirmAction.memberId });
        toast.success(`${confirmAction.memberName} has been reactivated`);
      } else if (confirmAction.type === "remove") {
        await removeMember({ memberId: confirmAction.memberId });
        toast.success(`${confirmAction.memberName} has been removed`);
      }
    } catch (error) {
      toast.error("Action failed", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setConfirmAction(null);
    }
  }, [confirmAction, banMember, unbanMember, removeMember]);

  const handleRoleChange = useCallback(
    async (memberId: string, role: "admin" | "member") => {
      try {
        await updateRole({ memberId, role });
        toast.success(`Role updated to ${getRoleLabel(role)}`);
      } catch (error) {
        toast.error("Failed to update role", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [updateRole]
  );

  const handlePermissionChange = useCallback(
    async (memberId: string, app: "precision" | "momentum", permission: string) => {
      try {
        await setPermission({
          memberId,
          app,
          permission: permission as "none" | "read" | "write" | "admin",
        });
        toast.success("Permission updated");
      } catch (error) {
        toast.error("Failed to update permission", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [setPermission]
  );

  /* ── Loading ── */
  if (members === undefined) {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-5 w-8 rounded-full" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-[280px]" />
          <Skeleton className="h-8 w-[200px]" />
        </div>
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted/50 px-4 py-2.5">
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-4 py-3 border-t flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Members</h1>
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
            {members.length}
          </span>
        </div>
      </div>

      {/* Search + filter bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-[280px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            placeholder="Search members..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>

        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
          {(
            [
              { value: "all", label: "All", count: members.length },
              { value: "active", label: "Active", count: activeCount },
              { value: "suspended", label: "Suspended", count: suspendedCount },
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

      {/* Members table */}
      {filteredMembers && filteredMembers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="rounded-full bg-muted p-3 mb-4">
            <Users className="h-6 w-6 text-muted-foreground/40" />
          </div>
          <p className="text-sm font-medium text-foreground">
            {searchQuery ? "No matching members" : "No members yet"}
          </p>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-[260px]">
            {searchQuery
              ? "Try a different search term or clear your filters."
              : "Members will appear here when they join the organization."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_130px_120px_120px_70px_40px] gap-3 bg-muted/50 px-4 py-2.5 border-b">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Member
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Role
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Momentum
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Precision
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-center">
              Projects
            </div>
            <div />
          </div>

          {/* Table rows */}
          {filteredMembers?.map((member) => (
            <div
              key={member.memberId}
              className={cn(
                "grid grid-cols-[1fr_130px_120px_120px_70px_40px] gap-3 items-center px-4 py-2.5 border-b last:border-b-0 transition-colors hover:bg-accent/40",
                member.isBanned && "opacity-60"
              )}
            >
              {/* Member info */}
              <button
                type="button"
                className="flex items-center gap-3 min-w-0 text-left"
                onClick={() =>
                  navigate({
                    to: "/admin/member/$memberId",
                    params: { memberId: member.memberId },
                  })
                }
              >
                <Avatar className="h-8 w-8 shrink-0">
                  {member.image && <AvatarImage src={member.image} alt={member.name} />}
                  <AvatarFallback className="text-[11px] font-medium">
                    {getInitials(member.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium truncate">{member.name}</span>
                    {member.isBanned && <Ban className="h-3 w-3 text-destructive/70 shrink-0" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">{member.email}</div>
                </div>
              </button>

              {/* Org role */}
              <div>
                {member.orgRole === "owner" ? (
                  <Badge variant="default" className="text-[10px] gap-1">
                    <Crown className="h-2.5 w-2.5" />
                    Owner
                  </Badge>
                ) : (
                  <Select
                    value={member.orgRole}
                    onValueChange={(value) =>
                      handleRoleChange(member.memberId, value as "admin" | "member")
                    }
                    disabled={member.orgRole === "owner"}
                  >
                    <SelectTrigger className="h-6 w-[120px] text-[11px] border-0 bg-transparent shadow-none hover:bg-muted/60 px-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin" className="text-[12px]">
                        <div className="flex items-center gap-1.5">
                          <ShieldCheck className="h-3 w-3" />
                          Admin
                        </div>
                      </SelectItem>
                      <SelectItem value="member" className="text-[12px]">
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3 w-3" />
                          Member
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Momentum permission */}
              <div>
                <Select
                  value={member.appPermissions.momentum}
                  onValueChange={(value) =>
                    handlePermissionChange(member.memberId, "momentum", value)
                  }
                  disabled={member.orgRole === "owner"}
                >
                  <SelectTrigger className="h-6 w-[110px] text-[11px] border-0 bg-transparent shadow-none hover:bg-muted/60 px-1.5">
                    <SelectValue>{getPermissionLabel(member.appPermissions.momentum)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin" className="text-[12px]">
                      Admin
                    </SelectItem>
                    <SelectItem value="write" className="text-[12px]">
                      Edit
                    </SelectItem>
                    <SelectItem value="read" className="text-[12px]">
                      View
                    </SelectItem>
                    <SelectItem value="none" className="text-[12px]">
                      No access
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Precision permission */}
              <div>
                <Select
                  value={member.appPermissions.precision}
                  onValueChange={(value) =>
                    handlePermissionChange(member.memberId, "precision", value)
                  }
                  disabled={member.orgRole === "owner"}
                >
                  <SelectTrigger className="h-6 w-[110px] text-[11px] border-0 bg-transparent shadow-none hover:bg-muted/60 px-1.5">
                    <SelectValue>{getPermissionLabel(member.appPermissions.precision)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin" className="text-[12px]">
                      Admin
                    </SelectItem>
                    <SelectItem value="write" className="text-[12px]">
                      Edit
                    </SelectItem>
                    <SelectItem value="read" className="text-[12px]">
                      View
                    </SelectItem>
                    <SelectItem value="none" className="text-[12px]">
                      No access
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Project assignment count */}
              <div className="text-center">
                <span className="text-[12px] tabular-nums text-muted-foreground">
                  {member.projectAssignmentCount}
                </span>
              </div>

              {/* Actions dropdown */}
              <div>
                {member.orgRole !== "owner" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[180px]">
                      <DropdownMenuItem
                        onClick={() =>
                          navigate({
                            to: "/admin/member/$memberId",
                            params: { memberId: member.memberId },
                          })
                        }
                        className="text-[12px]"
                      >
                        <Users className="h-3.5 w-3.5 mr-2" />
                        View Details
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {member.isBanned ? (
                        <DropdownMenuItem
                          onClick={() =>
                            setConfirmAction({
                              type: "unban",
                              memberId: member.memberId,
                              memberName: member.name,
                            })
                          }
                          className="text-[12px]"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                          Reactivate
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() =>
                            setConfirmAction({
                              type: "ban",
                              memberId: member.memberId,
                              memberName: member.name,
                            })
                          }
                          className="text-[12px] text-amber-600"
                        >
                          <Ban className="h-3.5 w-3.5 mr-2" />
                          Suspend
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() =>
                          setConfirmAction({
                            type: "remove",
                            memberId: member.memberId,
                            memberName: member.name,
                          })
                        }
                        className="text-[12px] text-destructive"
                      >
                        <UserMinus className="h-3.5 w-3.5 mr-2" />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === "ban" && "Suspend member?"}
              {confirmAction?.type === "unban" && "Reactivate member?"}
              {confirmAction?.type === "remove" && "Remove member?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === "ban" &&
                `${confirmAction.memberName} will be suspended and unable to access any applications until reactivated.`}
              {confirmAction?.type === "unban" &&
                `${confirmAction.memberName} will regain access to applications based on their permissions.`}
              {confirmAction?.type === "remove" &&
                `${confirmAction.memberName} will be permanently removed from the organization. All their permissions and project assignments will be deleted. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmAction}
              className={
                confirmAction?.type === "remove"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {confirmAction?.type === "ban" && "Suspend"}
              {confirmAction?.type === "unban" && "Reactivate"}
              {confirmAction?.type === "remove" && "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
