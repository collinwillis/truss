/**
 * Admin feature — organization member management for desktop apps.
 *
 * Momentum and Precision administer the same Better Auth organization, so both
 * render these pages. Each app keeps only a route file that supplies its own
 * typed navigation.
 */

export type * from "./types";
export { AdminAccessRequired, useIsOrganizationAdmin } from "./admin-access-guard";
export { AdminMembersPage, type AdminMembersPageProps } from "./admin-members-page";
export { AdminMemberDetailPage, type AdminMemberDetailPageProps } from "./admin-member-detail-page";
export { AppPermissionSelect, type AppPermissionSelectProps } from "./app-permission-select";
export { getMemberInitials, getPermissionOptionLabel } from "./member-display";
