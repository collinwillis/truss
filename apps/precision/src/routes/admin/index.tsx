import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useState, useMemo, useCallback } from "react";
import { Search, Users, Shield, ShieldCheck, Ban, MoreHorizontal, Crown } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Badge } from "@truss/ui/components/badge";
import { Skeleton } from "@truss/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
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
import { useWorkspace } from "@truss/features/organizations/workspace-context";

export const Route = createFileRoute("/admin/")({
  component: AdminMembersPage,
});

type StatusFilter = "all" | "active" | "suspended";

/**
 * Admin member management page.
 *
 * WHY: Mirrors Momentum's admin page exactly — same Convex queries,
 * same org member management. Both apps share the same Better Auth
 * organization and user model.
 */
function AdminMembersPage() {
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const orgId = workspace?.organizationId;
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";

  const members = useQuery(
    api.adminUsers.listOrganizationMembers,
    orgId ? { organizationId: orgId } : "skip"
  );

  const banMember = useMutation(api.adminUsers.banMember);
  const unbanMember = useMutation(api.adminUsers.unbanMember);
  const removeMember = useMutation(api.adminUsers.removeMember);
  const updateRole = useMutation(api.adminUsers.updateMemberRole);
  const setPermission = useMutation(api.appPermissions.setPermission);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [confirmAction, setConfirmAction] = useState<{
    type: "ban" | "unban" | "remove";
    memberId: string;
    memberName: string;
  } | null>(null);

  const filtered = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => {
      const matchesSearch =
        !search ||
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.email.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && !m.banned) ||
        (statusFilter === "suspended" && m.banned);

      return matchesSearch && matchesStatus;
    });
  }, [members, search, statusFilter]);

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    switch (confirmAction.type) {
      case "ban":
        await banMember({ memberId: confirmAction.memberId });
        break;
      case "unban":
        await unbanMember({ memberId: confirmAction.memberId });
        break;
      case "remove":
        await removeMember({ memberId: confirmAction.memberId });
        break;
    }
    setConfirmAction(null);
  };

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Shield className="h-8 w-8 text-muted-foreground/40 mb-4" />
        <p className="text-sm font-medium">Admin access required</p>
        <p className="text-xs text-muted-foreground mt-1">
          You need admin or owner role to manage members.
        </p>
      </div>
    );
  }

  if (members === undefined) {
    return (
      <div className="space-y-4 flex-1 overflow-auto">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-[280px]" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const activeCount = members.filter((m) => !m.banned).length;
  const suspendedCount = members.filter((m) => m.banned).length;

  const filterTabs: { value: StatusFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: members.length },
    { value: "active", label: "Active", count: activeCount },
    { value: "suspended", label: "Suspended", count: suspendedCount },
  ];

  return (
    <div className="space-y-4 flex-1 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Users className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold tracking-tight">Members</h1>
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
          {members.length}
        </span>
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-[280px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            placeholder="Search members..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>

        <div className="flex items-center rounded-lg border bg-muted/50 p-0.5">
          {filterTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setStatusFilter(tab.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                statusFilter === tab.value
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              <span className="ml-1 tabular-nums text-muted-foreground/60">{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Member list */}
      <div className="rounded-lg border overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_130px_120px_120px_40px] gap-3 bg-muted/50 px-4 py-2.5 border-b">
          <span className="text-xs font-medium text-muted-foreground">Member</span>
          <span className="text-xs font-medium text-muted-foreground">Role</span>
          <span className="text-xs font-medium text-muted-foreground">Precision</span>
          <span className="text-xs font-medium text-muted-foreground">Momentum</span>
          <span />
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {search ? "No matching members." : "No members found."}
          </div>
        ) : (
          filtered.map((member) => (
            <div
              key={member.memberId}
              className="grid grid-cols-[1fr_130px_120px_120px_40px] gap-3 items-center px-4 py-2.5 border-b last:border-b-0 hover:bg-accent/40 transition-colors"
            >
              {/* Name + email */}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{member.name}</p>
                  {member.banned && (
                    <Badge variant="destructive" className="text-[9px] px-1 py-0">
                      Suspended
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">{member.email}</p>
              </div>

              {/* Role */}
              <div className="flex items-center gap-1.5">
                {member.role === "owner" ? (
                  <Crown className="h-3.5 w-3.5 text-amber-500" />
                ) : member.role === "admin" ? (
                  <ShieldCheck className="h-3.5 w-3.5 text-blue-500" />
                ) : (
                  <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="text-xs capitalize">{member.role}</span>
              </div>

              {/* Precision permission */}
              <PermissionBadge permission={member.precisionPermission} />

              {/* Momentum permission */}
              <PermissionBadge permission={member.momentumPermission} />

              {/* Actions */}
              {member.role !== "owner" && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        navigate({
                          to: "/admin/member/$memberId",
                          params: { memberId: member.memberId },
                        })
                      }
                    >
                      Manage Member
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {member.banned ? (
                      <DropdownMenuItem
                        onClick={() =>
                          setConfirmAction({
                            type: "unban",
                            memberId: member.memberId,
                            memberName: member.name,
                          })
                        }
                      >
                        Unsuspend
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() =>
                          setConfirmAction({
                            type: "ban",
                            memberId: member.memberId,
                            memberName: member.name,
                          })
                        }
                      >
                        <Ban className="h-3.5 w-3.5 mr-2" />
                        Suspend
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))
        )}
      </div>

      {/* Confirmation dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === "ban"
                ? "Suspend Member"
                : confirmAction?.type === "unban"
                  ? "Unsuspend Member"
                  : "Remove Member"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === "ban"
                ? `${confirmAction.memberName} will be suspended and unable to access any apps.`
                : confirmAction?.type === "unban"
                  ? `${confirmAction?.memberName} will regain access to their assigned apps.`
                  : `${confirmAction?.memberName} will be permanently removed from the organization.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmAction}>
              {confirmAction?.type === "ban"
                ? "Suspend"
                : confirmAction?.type === "unban"
                  ? "Unsuspend"
                  : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PermissionBadge({ permission }: { permission: string }) {
  const colors: Record<string, string> = {
    admin: "bg-blue-500/10 text-blue-600",
    write: "bg-green-500/10 text-green-600",
    read: "bg-amber-500/10 text-amber-600",
    none: "bg-gray-500/10 text-gray-500",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${
        colors[permission] ?? colors.none
      }`}
    >
      {permission}
    </span>
  );
}
