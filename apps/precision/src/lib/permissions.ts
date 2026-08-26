import { hasPermission } from "@truss/features/organizations/permissions";
import type { AppPermissionLevel, WorkspaceContext } from "@truss/features/organizations/types";

/**
 * Client-side twins of the server's Precision access rule
 * (`packages/backend/convex/model/precisionAccess.ts`). The server is the
 * authority — these exist only so the UI stops offering what the server will
 * refuse. The ordering must mirror the server exactly: org role FIRST, then
 * the app-permission level.
 *
 * WHY role first: neither the org owner nor org admins have an
 * `appPermissions` row, so `workspace.precision_permission` resolves to
 * "none" for an admin-role member. A gate that read the permission field
 * alone would lock a legitimate admin's UI while the server allows
 * everything. (Owners are hardcoded to "admin" by the workspace provider;
 * admins are not.)
 *
 * WHY the organization guard: the provider's personal-workspace fallback
 * defaults both app permissions to "admin" with a null `organization_id`,
 * but the server resolves an org-less user to "none" and refuses every
 * Precision call. Requiring an organization keeps the client's answer
 * aligned with the server's for that user instead of rendering an enabled
 * UI where every call fails. Mirrors `isWorkspaceAdmin` in Momentum's
 * `lib/permissions.ts`.
 */
function hasPrecisionLevel(
  workspace: WorkspaceContext | null,
  required: AppPermissionLevel
): boolean {
  if (!workspace?.organization_id) return false;
  if (workspace.role === "owner" || workspace.role === "admin") return true;
  return hasPermission(workspace.precision_permission, required);
}

/**
 * Whether the workspace may see estimates at all.
 *
 * Gates the app shell itself: the root layout subscribes to Precision
 * queries that the server refuses below "read", so a workspace that fails
 * this check must get the access wall instead of a shell full of errors.
 */
export function canViewPrecision(workspace: WorkspaceContext | null): boolean {
  return hasPrecisionLevel(workspace, "read");
}

/**
 * Whether the workspace may create or modify estimates.
 *
 * Gates every edit affordance — buttons, dialogs, editable cells. "read"
 * members keep full visibility; their edit controls are withheld rather
 * than disabled, matching Momentum's viewer pattern.
 */
export function canEditPrecision(workspace: WorkspaceContext | null): boolean {
  return hasPrecisionLevel(workspace, "write");
}
