import { ShieldAlert } from "lucide-react";
import type { JSX } from "react";

import { useWorkspace } from "../organizations/workspace-context";

/**
 * Whether the signed-in user may administer the active organization.
 *
 * WHY a shared hook: both admin pages grant and revoke application access —
 * including access to the OTHER app — so this is an ORGANIZATION-level question,
 * not an app-level one. A member holding `momentum_permission: "admin"` may
 * administer Momentum but must not be able to hand out Precision access; that
 * would be privilege escalation.
 *
 * Each shell must gate its Admin nav entry on this same predicate, NOT on its
 * own app-admin check, or the nav offers a link to an access-denied wall.
 * Momentum's `isWorkspaceAdmin` is deliberately broader — it covers app
 * capabilities like creating projects — so its shell passes a separate
 * `isOrgAdmin` flag for the Admin section.
 *
 * A personal workspace has `role === null` and so is never an admin.
 */
export function useIsOrganizationAdmin(): boolean {
  const { workspace } = useWorkspace();

  return workspace?.role === "owner" || workspace?.role === "admin";
}

/**
 * Whether the workspace is still resolving, so "not an admin" cannot yet be
 * distinguished from "not known".
 *
 * WHY CALLERS MUST CHECK THIS: while `useActiveOrganization()` resolves,
 * `WorkspaceProvider` hands back the personal-workspace object — `role: null`,
 * `organization_id: null`. A page that only asks {@link useIsOrganizationAdmin}
 * therefore flashes "Admin access required" at a genuine admin before flipping
 * to the real content. Render a skeleton while this is true.
 */
export function useIsWorkspaceResolving(): boolean {
  const { workspace, isLoading } = useWorkspace();

  return isLoading || workspace === null;
}

/**
 * Shown instead of an admin page when the viewer lacks the org admin role.
 *
 * WHY needed: hiding the nav entry does not stop a member reaching `/admin` by
 * URL or from a restored window, and the Convex mutations behind these controls
 * do not yet check the caller's role.
 */
export function AdminAccessRequired(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="rounded-full bg-fill-quaternary p-3 mb-4">
        <ShieldAlert className="h-6 w-6 text-label-quaternary" />
      </div>
      <p className="text-body font-medium text-foreground">Admin access required</p>
      <p className="text-body text-muted-foreground mt-1 max-w-[280px]">
        Managing members needs the owner or admin role in this organization. Ask an organization
        owner to change your role if you need access.
      </p>
    </div>
  );
}
