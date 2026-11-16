import { api } from "@truss/backend/convex/_generated/api";
// Re-exported by the UI package alongside <Toaster>, so shared code reaches the
// toast queue the apps already mount without its own sonner dependency.
import { toast } from "@truss/ui/components/sonner";
import { useMutation, useQuery } from "convex/react";
import { Users } from "lucide-react";
import { useCallback, useMemo, type JSX } from "react";

import { accessErrorText } from "../access/error-text";
import { APP_NAMES, toMemberRole } from "../access/labels";
import type { AppAccessSetting } from "../access/types";
import { getRoleLabel } from "../organizations/permissions";
import type { AppName } from "../organizations/types";
import { useWorkspace } from "../organizations/workspace-context";
import { AdminAccessRequired, useIsOrganizationAdmin } from "./admin-access-guard";
import { MembersView } from "./members-view";
import type { AssignableRole } from "./role-select";
import type { AdminMemberView, MemberConfirmAction } from "./types";

/** Props for {@link AdminMembersPage}. */
export interface AdminMembersPageProps {
  /**
   * Opens the detail view for one member.
   *
   * WHY a callback and not a route: `Link`/`useNavigate` are typed against each
   * app's generated route tree, which a shared package cannot import. The host
   * route file owns the typed navigation and passes the intent down.
   */
  onOpenMember: (memberId: string) => void;
}

/** What a confirmed row action says when it lands. */
const DONE_COPY: Record<MemberConfirmAction, (name: string) => string> = {
  ban: (name) => `${name} has been suspended`,
  unban: (name) => `${name} has been reactivated`,
  remove: (name) => `${name} has been removed`,
};

/**
 * Admin > Members, shared by both desktop apps.
 *
 * Both apps sit on the same Better Auth organization and the same
 * `api.adminUsers` and `api.access` functions, so the data access lives here
 * rather than being injected — one implementation of who can grant what. The
 * table itself is {@link MembersView}.
 */
export function AdminMembersPage({ onOpenMember }: AdminMembersPageProps): JSX.Element {
  const { workspace } = useWorkspace();
  const isOrgAdmin = useIsOrganizationAdmin();
  const orgId = workspace?.organization_id;

  // Skipped for non-admins so the page renders the access wall instead of a
  // thrown query. The Convex query refuses them regardless (D-orgauthz).
  const rows = useQuery(
    api.adminUsers.listOrganizationMembers,
    orgId && isOrgAdmin ? { organizationId: orgId } : "skip"
  );

  const banMember = useMutation(api.adminUsers.banMember);
  const unbanMember = useMutation(api.adminUsers.unbanMember);
  const removeMember = useMutation(api.adminUsers.removeMember);
  const updateRole = useMutation(api.adminUsers.updateMemberRole);
  const setMemberAppAccess = useMutation(api.access.setMemberAppAccess);

  const members = useMemo(
    () =>
      rows?.map((row): AdminMemberView => ({
        memberId: row.memberId,
        userId: row.userId,
        name: row.name,
        email: row.email,
        image: row.image,
        orgRole: toMemberRole(row.orgRole),
        isBanned: row.isBanned,
        createdAt: row.createdAt,
        precisionAccess: row.precisionAccess,
        momentumAccess: row.momentumAccess,
      })),
    [rows]
  );

  const handleConfirmAction = useCallback(
    async (action: MemberConfirmAction, memberId: string) => {
      const name = members?.find((m) => m.memberId === memberId)?.name ?? "Member";
      try {
        if (action === "ban") await banMember({ memberId });
        else if (action === "unban") await unbanMember({ memberId });
        else await removeMember({ memberId });
        toast.success(DONE_COPY[action](name));
      } catch (error) {
        toast.error("Action failed", { description: accessErrorText(error) });
      }
    },
    [members, banMember, unbanMember, removeMember]
  );

  const handleRoleChange = useCallback(
    async (memberId: string, role: AssignableRole) => {
      try {
        await updateRole({ memberId, role });
        toast.success(`Role updated to ${getRoleLabel(role)}`);
      } catch (error) {
        toast.error("Couldn't change the role", { description: accessErrorText(error) });
        throw error;
      }
    },
    [updateRole]
  );

  const handleAppAccessChange = useCallback(
    async (memberId: string, app: AppName, access: AppAccessSetting) => {
      try {
        await setMemberAppAccess({ memberId, app, access });
      } catch (error) {
        toast.error(`Couldn't change ${APP_NAMES[app]} access`, {
          description: accessErrorText(error),
        });
        throw error;
      }
    },
    [setMemberAppAccess]
  );

  /* ── No organization — members can't be listed without an org context ── */
  if (!orgId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 rounded-full bg-fill-quaternary p-3">
          <Users className="h-6 w-6 text-label-quaternary" />
        </div>
        <p className="text-body font-medium text-foreground">No organization</p>
        <p className="mt-1 max-w-[280px] text-body text-muted-foreground">
          Member management is unavailable without an active organization. Try reopening the app, or
          contact your administrator if this persists.
        </p>
      </div>
    );
  }

  /* ── Not an admin — checked after the org check so a personal workspace still
     reads as "no organization" rather than a permission problem. `role` is set
     in the same pass as `organization_id`, so a real admin never sees this. ── */
  if (!isOrgAdmin) {
    return <AdminAccessRequired />;
  }

  return (
    <MembersView
      members={members}
      onOpenMember={onOpenMember}
      onRoleChange={handleRoleChange}
      onAppAccessChange={handleAppAccessChange}
      onConfirmAction={handleConfirmAction}
    />
  );
}
