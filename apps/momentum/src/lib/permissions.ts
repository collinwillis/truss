import type { WorkspaceContext } from "@truss/features/organizations/types";

/**
 * Whether the current workspace grants Momentum admin capabilities.
 *
 * WHY the organization guard: admin surfaces (member management, entry
 * history) operate on an organization. The "personal workspace" fallback
 * defaults `momentum_permission` to "admin" with a null `organization_id`;
 * without this guard that fallback exposes admin UI that has no org to act on
 * — most visibly an Admin > Members page stuck loading forever, because its
 * members query is skipped whenever `organization_id` is null. Requiring an
 * organization keeps admin status meaningful and org-scoped.
 */
export function isWorkspaceAdmin(workspace: WorkspaceContext | null): boolean {
  if (!workspace?.organization_id) return false;
  return (
    workspace.role === "owner" ||
    workspace.role === "admin" ||
    workspace.momentum_permission === "admin"
  );
}
