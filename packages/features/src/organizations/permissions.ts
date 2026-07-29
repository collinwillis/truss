import type { AppPermissionLevel, PermissionCheck, AppAccess } from "./types";

/**
 * Permission level hierarchy for comparison
 * Higher index = more permissions
 *
 * ⚠️ This is the client-side twin of `packages/backend/convex/model/
 * appPermissionLevels.ts` (`APP_PERMISSION_ORDER`). It cannot import that
 * module — `@truss/features` already peer-depends on `@truss/backend`, so the
 * reverse import would close a dependency cycle. IF YOU CHANGE THIS ORDERING,
 * CHANGE THE OTHER ONE.
 */
const PERMISSION_HIERARCHY: AppPermissionLevel[] = ["none", "read", "write", "admin"];

/**
 * Check if a permission level meets the minimum requirement
 *
 * Unknown values fail closed, mirroring the backend's `meetsPermissionLevel`:
 * an unrecognised `granted` sorts below "none" (workspace values arrive
 * through unchecked casts of server strings), and an unrecognised `required`
 * refuses everyone rather than letting a typo'd requirement grant access.
 *
 * @example
 * hasPermission('write', 'read') // true (write >= read)
 * hasPermission('read', 'write') // false (read < write)
 * hasPermission('admin', 'write') // true (admin >= write)
 */
export function hasPermission(granted: AppPermissionLevel, required: AppPermissionLevel): boolean {
  const grantedIndex = PERMISSION_HIERARCHY.indexOf(granted);
  const requiredIndex = PERMISSION_HIERARCHY.indexOf(required);
  if (requiredIndex === -1) return false;

  return grantedIndex >= requiredIndex;
}

/**
 * Check if user has required permission level
 * Returns detailed result with reason if access is denied
 */
export function checkPermission(
  granted: AppPermissionLevel,
  required: AppPermissionLevel
): PermissionCheck {
  const hasAccess = hasPermission(granted, required);

  if (hasAccess) {
    return {
      hasAccess: true,
      permission: granted,
    };
  }

  return {
    hasAccess: false,
    permission: granted,
    reason: `Insufficient permissions. Required: ${required}, granted: ${granted}`,
  };
}

/**
 * Get the highest permission level from a list
 *
 * @example
 * getHighestPermission(['read', 'write', 'admin']) // 'admin'
 * getHighestPermission(['none', 'read']) // 'read'
 */
export function getHighestPermission(permissions: AppPermissionLevel[]): AppPermissionLevel {
  let highest: AppPermissionLevel = "none";

  for (const permission of permissions) {
    if (hasPermission(permission, highest)) {
      highest = permission;
    }
  }

  return highest;
}

/**
 * Check if user can perform an action based on permission level
 */
export const canView = (permission: AppPermissionLevel) => hasPermission(permission, "read");
export const canEdit = (permission: AppPermissionLevel) => hasPermission(permission, "write");
export const canAdmin = (permission: AppPermissionLevel) => hasPermission(permission, "admin");

/**
 * Get display label for permission level
 */
export function getPermissionLabel(permission: AppPermissionLevel): string {
  const labels: Record<AppPermissionLevel, string> = {
    none: "No Access",
    read: "View Only",
    write: "Can Edit",
    admin: "Full Access",
  };

  return labels[permission];
}

/**
 * Get display label for organization role
 */
export function getRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
    guest: "Guest",
  };

  return labels[role] || role;
}

/**
 * Get comprehensive app access object for UI components
 * This is the primary utility for permission-gated UI
 *
 * @example
 * const access = getAppAccess('write')
 * if (access.canEdit) {
 *   // Show edit button
 * }
 */
export function getAppAccess(permission: AppPermissionLevel): AppAccess {
  const hasAccess = permission !== "none";

  return {
    hasAccess,
    canView: hasPermission(permission, "read"),
    canEdit: hasPermission(permission, "write"),
    canAdmin: hasPermission(permission, "admin"),
    permission,
  };
}
