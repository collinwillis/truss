/**
 * Admin feature — organization member management for desktop apps.
 *
 * Momentum and Precision administer the same Better Auth organization, so both
 * render these pages. Each app keeps only a route file that supplies its own
 * typed navigation. The views take plain props; the pages wire them to Convex.
 */

export type * from "./types";
export { AdminAccessRequired, useIsOrganizationAdmin } from "./admin-access-guard";
export { AdminMembersPage, type AdminMembersPageProps } from "./admin-members-page";
export { AdminMemberDetailPage, type AdminMemberDetailPageProps } from "./admin-member-detail-page";
export { MembersView, MembersSkeleton, type MembersViewProps } from "./members-view";
export {
  MemberDetailView,
  MemberDetailSkeleton,
  type MemberDetailViewProps,
  type MemberGrants,
} from "./member-detail-view";
export { RoleSelect, type RoleSelectProps, type AssignableRole } from "./role-select";
