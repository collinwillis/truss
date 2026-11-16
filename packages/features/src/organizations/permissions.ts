import type { EffectiveAppAccess } from "../access/types";
import type { AppPermissionLevel } from "./types";

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
 * @deprecated Compares legacy levels. Gate on `WorkspaceContext.precisionAccess`
 * / `momentumAccess` and the per-item `access` the server returns instead.
 */
export function hasPermission(granted: AppPermissionLevel, required: AppPermissionLevel): boolean {
  const grantedIndex = PERMISSION_HIERARCHY.indexOf(granted);
  const requiredIndex = PERMISSION_HIERARCHY.indexOf(required);
  if (requiredIndex === -1) return false;

  return grantedIndex >= requiredIndex;
}

/**
 * The legacy level a screen not yet moved to the new model should see.
 *
 * WHY `assigned` → `write`, unlike the server's compatibility answer (which
 * looks at the person's grants): the client has no grants to look at, and an
 * Only assigned member may open the app and start an estimate, which is what
 * the legacy gates call "write". The server still refuses each item they were
 * not added to, and the item lists only return the ones they were.
 *
 * @param access - The caller's access to one app
 * @returns The matching legacy level
 */
export function legacyPermissionFor(access: EffectiveAppAccess): AppPermissionLevel {
  switch (access) {
    case "full":
      return "admin";
    case "edit_all":
    case "assigned":
      return "write";
    case "view_all":
      return "read";
    case "none":
      return "none";
  }
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
