import { ShieldAlert } from "lucide-react";
import type { JSX } from "react";

import { useWorkspace } from "../organizations/workspace-context";

/**
 * Whether the signed-in user may administer the active organization.
 *
 * WHY a shared hook: both admin pages grant and revoke access to BOTH apps, so
 * this is an organization-level question. Under docs/ACCESS.md only the Owner
 * and Admins manage people; no app-level setting does.
 *
 * Each shell must gate its Admin nav entry on this same predicate, or the nav
 * offers a link to an access-denied wall.
 *
 * A personal workspace, and a suspended account, has `role === null` and so is
 * never an admin.
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
 * URL or from a restored window. The Convex functions behind these controls now
 * refuse a non-admin caller themselves (D-orgauthz), so this wall is affordance
 * — it explains the refusal instead of letting the page throw.
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
