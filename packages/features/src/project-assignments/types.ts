/**
 * Type definitions for scoped project assignments.
 *
 * WHY: Construction projects need fine-grained access control where
 * supervisors and foremen are assigned to specific scopes (project, WBS,
 * or phase) rather than having blanket access to everything.
 */

/** Project-level role within a Momentum project scope. */
export type ProjectRole = "superintendent" | "supervisor" | "foreman" | "viewer";

/** Scope granularity for a project assignment. */
export type AssignmentScopeType = "project" | "wbs" | "phase";

/** A single project assignment record with denormalized display fields. */
export interface ProjectAssignment {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  userEmail: string;
  userImage?: string;
  scopeType: AssignmentScopeType;
  scopeId?: string;
  scopeName: string;
  role: ProjectRole;
  assignedBy?: string;
  assignedAt: number;
}

/** User assignment summary from the user's perspective (across projects). */
export interface UserAssignment {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  scopeType: AssignmentScopeType;
  scopeId?: string;
  scopeName: string;
  role: ProjectRole;
  assignedAt: number;
}

/**
 * Resolved effective scope for a user on a project.
 *
 * WHY: The workbook and save mutations need a single resolved view
 * of what a user can access, computed from their potentially many
 * overlapping assignments.
 */
export interface ResolvedScope {
  hasAccess: boolean;
  /** True when no assignments exist (everyone sees everything). */
  isUnscoped: boolean;
  effectiveRole: ProjectRole | null;
  allowedWbsIds: string[] | "all";
  allowedPhaseIds: string[] | "all";
}

/** Quick summary of a project member for list views. */
export interface ProjectMemberSummary {
  userId: string;
  roles: string[];
  scopeCount: number;
}
