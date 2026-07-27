import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminMembersPage } from "@truss/features/admin";

/**
 * Admin members list route.
 *
 * The page itself is shared with Precision — both apps administer the same
 * Better Auth organization. This file only binds it to Momentum's route tree,
 * which is the one thing a shared component cannot own.
 */
export const Route = createFileRoute("/admin/")({
  component: AdminMembersRoute,
});

function AdminMembersRoute() {
  const navigate = useNavigate();

  return (
    <AdminMembersPage
      onOpenMember={(memberId) => navigate({ to: "/admin/member/$memberId", params: { memberId } })}
    />
  );
}
