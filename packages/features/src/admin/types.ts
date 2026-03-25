/**
 * Type definitions for the admin user management panel.
 *
 * WHY: The admin panel needs composite views that join data from
 * Better Auth (user/member/org), Convex (app permissions), and
 * project assignments into unified display models.
 */

import type { AppPermissionLevel, OrganizationRole } from "../organizations/types";

/** Organization member view for the admin members table. */
export interface AdminMemberView {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  image?: string;
  orgRole: OrganizationRole;
  isBanned: boolean;
  createdAt: string;
  appPermissions: {
    precision: AppPermissionLevel;
    momentum: AppPermissionLevel;
  };
  projectAssignmentCount: number;
}

/** Detailed member view for the admin member detail page. */
export interface AdminMemberDetail extends AdminMemberView {
  banReason?: string;
  lastActive?: string;
}

/** Status filter options for the members table. */
export type MemberStatusFilter = "all" | "active" | "suspended";
