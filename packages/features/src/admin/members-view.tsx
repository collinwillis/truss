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
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Button } from "@truss/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { Input } from "@truss/ui/components/input";
import { Skeleton } from "@truss/ui/components/skeleton";
import { cn } from "@truss/ui/lib/utils";
import { Ban, CheckCircle2, MoreHorizontal, Search, UserMinus, Users } from "lucide-react";
import { useMemo, useState, type JSX } from "react";

import { AppAccessSelect } from "../access/app-access-select";
import { APP_NAMES, getMemberInitials } from "../access/labels";
import type { AppAccessSetting } from "../access/types";
import type { AppName } from "../organizations/types";
import { RoleSelect, type AssignableRole } from "./role-select";
import type { AdminMemberView, MemberConfirmAction, MemberStatusFilter } from "./types";

/**
 * Page root sizing.
 *
 * WHY here and not in the shell: the shell's content area is a flex column with
 * no scroller of its own, so each page owns its overflow — the same classes
 * Momentum's projects page and Precision's estimates page use. Without this a
 * long member roster is clipped instead of scrolled.
 */
export const ADMIN_PAGE_ROOT = "space-y-5 flex-1 min-h-0 overflow-y-auto pb-8";

/** Name | Role | Precision | Momentum | row menu. */
const GRID = "grid grid-cols-[minmax(0,1fr)_120px_152px_152px_40px] gap-3";

/** What each confirmable action says before it happens. */
const CONFIRM_COPY: Record<
  MemberConfirmAction,
  { title: (name: string) => string; body: string; action: string }
> = {
  ban: {
    title: (name) => `Suspend ${name}?`,
    body: "They can't open either app until reactivated.",
    action: "Suspend",
  },
  unban: {
    title: (name) => `Reactivate ${name}?`,
    body: "They get back the access they had.",
    action: "Reactivate",
  },
  remove: {
    title: (name) => `Remove ${name}?`,
    body: "They lose access to everything in this organization. This can't be undone.",
    action: "Remove",
  },
};

/** Props for {@link MembersView}. */
export interface MembersViewProps {
  /** The roster; `undefined` while loading. */
  members: AdminMemberView[] | undefined;
  onOpenMember: (memberId: string) => void;
  onRoleChange: (memberId: string, role: AssignableRole) => void | Promise<void>;
  onAppAccessChange: (
    memberId: string,
    app: AppName,
    access: AppAccessSetting
  ) => void | Promise<void>;
  /** Runs a row action after the person confirmed it. */
  onConfirmAction: (action: MemberConfirmAction, memberId: string) => void | Promise<void>;
}

/**
 * The Members table: Name, Role, Precision, Momentum.
 *
 * Owner and Admin rows show "Full access", locked, in both app columns; a
 * Member's row sets each app's access. What each setting means is on the
 * option itself, so the page needs no legend.
 */
export function MembersView({
  members,
  onOpenMember,
  onRoleChange,
  onAppAccessChange,
  onConfirmAction,
}: MembersViewProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<MemberStatusFilter>("all");
  // The confirmed row is kept after the dialog closes, so its text does not
  // vanish during the close animation.
  const [confirm, setConfirmState] = useState<{
    action: MemberConfirmAction;
    memberId: string;
    name: string;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const setConfirm = (next: NonNullable<typeof confirm>) => {
    setConfirmState(next);
    setConfirmOpen(true);
  };

  const filteredMembers = useMemo(() => {
    if (!members) return undefined;
    const query = searchQuery.toLowerCase();
    return members.filter((member) => {
      const matchesSearch =
        query === "" ||
        member.name.toLowerCase().includes(query) ||
        member.email.toLowerCase().includes(query);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && !member.isBanned) ||
        (statusFilter === "suspended" && member.isBanned);
      return matchesSearch && matchesStatus;
    });
  }, [members, searchQuery, statusFilter]);

  if (members === undefined || filteredMembers === undefined) {
    return <MembersSkeleton />;
  }

  const activeCount = members.filter((m) => !m.isBanned).length;
  const suspendedCount = members.length - activeCount;
  const emptyCopy = emptyStateCopy(searchQuery, statusFilter);

  return (
    <div className={ADMIN_PAGE_ROOT}>
      <div className="flex items-center gap-3">
        <h1 className="text-title3 font-semibold tracking-tight">Members</h1>
        <span className="inline-flex items-center rounded-full bg-fill-quaternary px-2 py-0.5 text-subheadline font-medium text-muted-foreground tabular-nums">
          {members.length}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative max-w-[280px] flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
          <Input
            placeholder="Search members..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 rounded-full pl-8 text-callout"
          />
        </div>

        <div className="flex items-center rounded-lg bg-fill-tertiary p-[3px]">
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
              className={cn(
                "rounded-md px-2 py-[3px] text-subheadline font-medium transition-all",
                statusFilter === filter.value
                  ? "bg-background text-foreground shadow-xs"
                  : "text-foreground-subtle hover:text-foreground"
              )}
            >
              {filter.label}
              <span className="ml-1 tabular-nums opacity-50">{filter.count}</span>
            </button>
          ))}
        </div>
      </div>

      {filteredMembers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 rounded-full bg-fill-quaternary p-3">
            <Users className="h-6 w-6 text-label-quaternary" />
          </div>
          <p className="text-body font-medium text-foreground">{emptyCopy.title}</p>
          <p className="mt-1 max-w-[260px] text-body text-muted-foreground">{emptyCopy.body}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-mac-card border">
          <div className={cn(GRID, "border-b px-4 py-2")}>
            {["Name", "Role", "Precision", "Momentum"].map((heading) => (
              <div key={heading} className="text-subheadline font-medium text-muted-foreground">
                {heading}
              </div>
            ))}
            <div />
          </div>

          {filteredMembers.map((member) => {
            const isAdmin = member.orgRole === "owner" || member.orgRole === "admin";
            return (
              <div
                key={member.memberId}
                className={cn(
                  GRID,
                  "items-center border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-fill-quaternary",
                  member.isBanned && "opacity-60"
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-3 text-left"
                  onClick={() => onOpenMember(member.memberId)}
                >
                  <Avatar className="h-8 w-8 shrink-0">
                    {member.image && <AvatarImage src={member.image} alt={member.name} />}
                    <AvatarFallback className="text-subheadline font-medium">
                      {getMemberInitials(member.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-body font-medium">{member.name}</span>
                      {member.isBanned && <Ban className="h-3 w-3 shrink-0 text-destructive/70" />}
                    </div>
                    <div className="truncate text-subheadline text-muted-foreground">
                      {member.email}
                    </div>
                  </div>
                </button>

                <div>
                  <RoleSelect
                    value={member.orgRole}
                    label={`${member.name}, role`}
                    onChange={(role) => onRoleChange(member.memberId, role)}
                  />
                </div>

                {(["precision", "momentum"] as const).map((app) => (
                  <div key={app}>
                    <AppAccessSelect
                      app={app}
                      value={app === "precision" ? member.precisionAccess : member.momentumAccess}
                      locked={isAdmin}
                      label={`${member.name}, ${APP_NAMES[app]} access`}
                      onChange={(access) => onAppAccessChange(member.memberId, app, access)}
                    />
                  </div>
                ))}

                <div>
                  {member.orgRole !== "owner" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          aria-label={`Actions for ${member.name}`}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[180px]">
                        <DropdownMenuItem
                          onClick={() => onOpenMember(member.memberId)}
                          className="text-callout"
                        >
                          <Users className="mr-2 h-3.5 w-3.5" />
                          View Details
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {member.isBanned ? (
                          <DropdownMenuItem
                            onClick={() =>
                              setConfirm({
                                action: "unban",
                                memberId: member.memberId,
                                name: member.name,
                              })
                            }
                            className="text-callout"
                          >
                            <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                            Reactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() =>
                              setConfirm({
                                action: "ban",
                                memberId: member.memberId,
                                name: member.name,
                              })
                            }
                            className="text-callout text-mac-orange"
                          >
                            <Ban className="mr-2 h-3.5 w-3.5" />
                            Suspend
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() =>
                            setConfirm({
                              action: "remove",
                              memberId: member.memberId,
                              name: member.name,
                            })
                          }
                          className="text-callout text-destructive"
                        >
                          <UserMinus className="mr-2 h-3.5 w-3.5" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          {confirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {CONFIRM_COPY[confirm.action].title(confirm.name)}
                </AlertDialogTitle>
                <AlertDialogDescription>{CONFIRM_COPY[confirm.action].body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void onConfirmAction(confirm.action, confirm.memberId)}
                  className={
                    confirm.action === "remove"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : undefined
                  }
                >
                  {CONFIRM_COPY[confirm.action].action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * What an empty roster says, given why it is empty.
 *
 * WHY per filter: the viewer is always on the roster, so "No members yet" can
 * only appear through a filter, usually Suspended at 0, where it would be false.
 */
function emptyStateCopy(
  searchQuery: string,
  statusFilter: MemberStatusFilter
): { title: string; body: string } {
  if (searchQuery) {
    return {
      title: "No matching members",
      body: "Try a different search term or clear your filters.",
    };
  }
  if (statusFilter === "suspended") {
    return { title: "No suspended members", body: "Suspended members appear here." };
  }
  if (statusFilter === "active") {
    return { title: "No active members", body: "Active members appear here." };
  }
  return {
    title: "No members yet",
    body: "Members will appear here when they join the organization.",
  };
}

/** The Members page while the roster loads. */
export function MembersSkeleton(): JSX.Element {
  return (
    <div className={ADMIN_PAGE_ROOT}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-[280px]" />
        <Skeleton className="h-8 w-[200px]" />
      </div>
      <div className="overflow-hidden rounded-mac-card border">
        <div className="bg-fill-quaternary/50 px-4 py-2.5">
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-t px-4 py-3">
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
