/**
 * Pure utility functions for project assignment scope resolution.
 *
 * WHY: Both the backend (Convex functions) and UI need consistent
 * scope-checking logic. These functions are side-effect-free and
 * can run in any environment.
 */

import type { ProjectRole, ResolvedScope } from "./types";

/**
 * Role hierarchy — higher index = more permissions.
 * Used for role comparison and "highest role" resolution.
 */
const ROLE_HIERARCHY: ProjectRole[] = ["viewer", "foreman", "supervisor", "superintendent"];

/**
 * Check if a granted role meets the minimum required level.
 *
 * @param granted - The role the user has
 * @param required - The minimum role needed
 * @returns True if granted >= required in the hierarchy
 */
export function hasProjectPermission(granted: ProjectRole, required: ProjectRole): boolean {
  return ROLE_HIERARCHY.indexOf(granted) >= ROLE_HIERARCHY.indexOf(required);
}

/**
 * Get the highest role from a list of roles.
 *
 * @param roles - Array of project roles to compare
 * @returns The highest role, or "viewer" if empty
 */
export function getHighestRole(roles: ProjectRole[]): ProjectRole {
  if (roles.length === 0) return "viewer";

  let highest: ProjectRole = "viewer";
  for (const role of roles) {
    if (ROLE_HIERARCHY.indexOf(role) > ROLE_HIERARCHY.indexOf(highest)) {
      highest = role;
    }
  }
  return highest;
}

/**
 * Check if an activity (identified by its WBS and phase) falls within
 * a resolved scope.
 *
 * @param scope - The resolved scope to check against
 * @param wbsId - The activity's WBS ID
 * @param phaseId - The activity's phase ID
 * @returns True if the activity is visible under this scope
 */
export function isInScope(scope: ResolvedScope, wbsId: string, phaseId: string): boolean {
  if (!scope.hasAccess) return false;
  if (scope.isUnscoped) return true;
  if (scope.allowedPhaseIds === "all") return true;
  if (scope.allowedPhaseIds.includes(phaseId)) return true;
  if (scope.allowedWbsIds !== "all" && scope.allowedWbsIds.includes(wbsId)) return true;
  return false;
}

/**
 * Check if the user can enter quantities (not just view).
 *
 * WHY: Viewers can see data but cannot modify it. This helper
 * combines scope and role checks for the save path.
 */
export function canEnterQuantities(scope: ResolvedScope): boolean {
  if (!scope.hasAccess) return false;
  if (scope.isUnscoped) return true;
  if (!scope.effectiveRole) return false;
  return hasProjectPermission(scope.effectiveRole, "foreman");
}

/** Human-readable label for a project role. */
export function getProjectRoleLabel(role: ProjectRole): string {
  const labels: Record<ProjectRole, string> = {
    superintendent: "Superintendent",
    supervisor: "Supervisor",
    foreman: "Foreman",
    viewer: "Viewer",
  };
  return labels[role];
}

/** Human-readable description for a project role. */
export function getProjectRoleDescription(role: ProjectRole): string {
  const descriptions: Record<ProjectRole, string> = {
    superintendent: "Full oversight of assigned scope",
    supervisor: "Can enter quantities in assigned scope",
    foreman: "Can enter quantities in assigned scope",
    viewer: "Read-only access to assigned scope",
  };
  return descriptions[role];
}

/** All available project roles in hierarchy order (lowest to highest). */
export function getProjectRoleHierarchy(): ProjectRole[] {
  return [...ROLE_HIERARCHY];
}

/** All available project roles in display order (highest to lowest). */
export function getProjectRolesForDisplay(): ProjectRole[] {
  return [...ROLE_HIERARCHY].reverse();
}
