import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
// Re-exported by the UI package alongside <Toaster>, so shared code reaches the
// toast queue the apps already mount without its own sonner dependency.
import { toast } from "@truss/ui/components/sonner";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, type JSX } from "react";

import { accessErrorText } from "../access/error-text";
import { APP_NAMES, toMemberRole } from "../access/labels";
import type { AppAccessSetting } from "../access/types";
import { getRoleLabel } from "../organizations/permissions";
import type { AppName } from "../organizations/types";
import {
  AdminAccessRequired,
  useIsOrganizationAdmin,
  useIsWorkspaceResolving,
} from "./admin-access-guard";
import { MemberDetailSkeleton, MemberDetailView, type MemberGrants } from "./member-detail-view";
import type { AssignableRole } from "./role-select";
import type { AdminMemberDetail } from "./types";

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
 * Admin > Members > one member, shared by both desktop apps. Wires
 * {@link MemberDetailView} to `api.adminUsers` and `api.access`.
 */
export function AdminMemberDetailPage({
  memberId,
  onBack,
}: AdminMemberDetailPageProps): JSX.Element {
  const isOrgAdmin = useIsOrganizationAdmin();
  const isResolving = useIsWorkspaceResolving();

  // Skipped for non-admins so another member's record is never requested by a
  // client that is not allowed to see it; the queries refuse them regardless.
  const row = useQuery(api.adminUsers.getMemberDetail, isOrgAdmin ? { memberId } : "skip");
  const grantRows = useQuery(api.access.listMemberGrants, isOrgAdmin ? { memberId } : "skip");

  const updateRole = useMutation(api.adminUsers.updateMemberRole);
  const banMember = useMutation(api.adminUsers.banMember);
  const unbanMember = useMutation(api.adminUsers.unbanMember);
  const removeMember = useMutation(api.adminUsers.removeMember);
  const setMemberAppAccess = useMutation(api.access.setMemberAppAccess);
  const revokeItemAccess = useMutation(api.access.revokeItemAccess);

  const member = useMemo(
    (): AdminMemberDetail | null | undefined =>
      row && {
        memberId: row.memberId,
        userId: row.userId,
        name: row.name,
        email: row.email,
        image: row.image,
        orgRole: toMemberRole(row.orgRole),
        isBanned: row.isBanned,
        banReason: row.banReason,
        createdAt: row.createdAt,
        precisionAccess: row.precisionAccess,
        momentumAccess: row.momentumAccess,
      },
    [row]
  );

  const grants = useMemo(
    (): MemberGrants | undefined =>
      grantRows && {
        estimates: grantRows.estimates.map((grant) => ({
          id: grant.proposalId,
          number: grant.proposalNumber,
          name: grant.description,
          level: grant.level,
        })),
        projects: grantRows.projects.map((grant) => ({
          id: grant.projectId,
          number: grant.projectNumber,
          name: grant.name,
          level: grant.level,
        })),
      },
    [grantRows]
  );

  const handleRoleChange = useCallback(
    async (role: AssignableRole) => {
      try {
        await updateRole({ memberId, role });
        toast.success(`Role updated to ${getRoleLabel(role)}`);
      } catch (error) {
        toast.error("Couldn't change the role", { description: accessErrorText(error) });
        throw error;
      }
    },
    [memberId, updateRole]
  );

  const handleAppAccessChange = useCallback(
    async (app: AppName, access: AppAccessSetting) => {
      try {
        await setMemberAppAccess({ memberId, app, access });
      } catch (error) {
        toast.error(`Couldn't change ${APP_NAMES[app]} access`, {
          description: accessErrorText(error),
        });
        throw error;
      }
    },
    [memberId, setMemberAppAccess]
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
      toast.error("Action failed", { description: accessErrorText(error) });
    }
  }, [member, memberId, banMember, unbanMember]);

  const handleRemoveMember = useCallback(async () => {
    if (!member) return;
    try {
      await removeMember({ memberId });
      toast.success(`${member.name} has been removed`);
      onBack();
    } catch (error) {
      toast.error("Couldn't remove member", { description: accessErrorText(error) });
      throw error;
    }
  }, [member, memberId, removeMember, onBack]);

  const handleRemoveGrant = useCallback(
    async (app: AppName, id: string) => {
      if (!member || !grantRows) return;
      // The id comes back from the list it was rendered from, so finding it
      // there recovers its typed Convex id without a cast.
      const item =
        app === "precision"
          ? grantRows.estimates.find((grant) => grant.proposalId === id)
          : grantRows.projects.find((grant) => grant.projectId === id);
      if (!item) return;
      const args: { proposalId?: Id<"proposals">; projectId?: Id<"momentumProjects"> } =
        "proposalId" in item ? { proposalId: item.proposalId } : { projectId: item.projectId };
      try {
        await revokeItemAccess({ ...args, userId: member.userId });
      } catch (error) {
        toast.error("Couldn't remove access", { description: accessErrorText(error) });
      }
    },
    [member, grantRows, revokeItemAccess]
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

  if (isResolving || member === undefined) {
    return <MemberDetailSkeleton />;
  }

  if (member === null) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-3">
        <p className="text-title3 font-semibold text-muted-foreground">Member not found</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to Members
        </Button>
      </div>
    );
  }

  return (
    <MemberDetailView
      member={member}
      grants={grants}
      onBack={onBack}
      onRoleChange={handleRoleChange}
      onAppAccessChange={handleAppAccessChange}
      onToggleBan={handleToggleBan}
      onRemoveMember={handleRemoveMember}
      onRemoveGrant={handleRemoveGrant}
    />
  );
}
