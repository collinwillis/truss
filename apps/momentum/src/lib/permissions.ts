import type { WorkspaceContext } from "@truss/features/organizations/types";

/**
 * Whether the caller is an Owner or Admin, who alone create and delete
 * projects, open settings and reports, and manage people (docs/ACCESS.md).
 *
 * WHY the role alone: there is no Momentum-level admin any more, so the app
 * setting never makes someone an admin. A personal workspace and a suspended
 * account both have `role === null`, so neither is ever an admin.
 */
export function isWorkspaceAdmin(workspace: WorkspaceContext | null): boolean {
  return workspace?.role === "owner" || workspace?.role === "admin";
}

/**
 * Whether the caller may open Momentum at all.
 *
 * Gates the shell: everything inside it reads projects, so a caller with No
 * access gets the access wall rather than an app that can show nothing.
 */
export function canOpenMomentum(workspace: WorkspaceContext | null): boolean {
  return !!workspace && workspace.momentumAccess !== "none";
}

/** What the caller may do on one project: everything, log and edit, or read. */
export type ProjectLevel = "full" | "edit" | "view";

/** The part of `getBrowseData().scopeInfo` that says what the caller may do. */
export interface WorkbookScopeInfo {
  hasAccess: boolean;
  access?: ProjectLevel | null;
  effectiveRole?: string | null;
}

/**
 * The caller's level on one project's workbook, or `null` without access.
 *
 * WHY the `effectiveRole` fallback: `access` arrived with the simple-access
 * backend, and until that deploy reaches a server `effectiveRole` is all there
 * is. There, only "viewer" was read-only.
 *
 * @param scopeInfo - From `getBrowseData`; `undefined` while it loads
 * @returns The level, or `null` while loading or without access
 */
export function workbookLevel(
  scopeInfo: WorkbookScopeInfo | null | undefined
): ProjectLevel | null {
  if (!scopeInfo?.hasAccess) return null;
  if (scopeInfo.access) return scopeInfo.access;
  return scopeInfo.effectiveRole === "viewer" ? "view" : "edit";
}

/**
 * Whether a level lets the caller log and correct progress.
 *
 * @param level - From {@link workbookLevel}
 * @returns True for Can edit and for Owners and Admins
 */
export function canLogProgress(level: ProjectLevel | null): boolean {
  return level === "edit" || level === "full";
}
