import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { AdminMemberDetailPage } from "@truss/features/admin";

/**
 * Admin member detail route.
 *
 * The page itself is shared with Momentum — both apps administer the same
 * Better Auth organization. This file only binds it to Precision's route tree,
 * which is the one thing a shared component cannot own.
 */
export const Route = createFileRoute("/admin/member/$memberId")({
  component: AdminMemberDetailRoute,
});

function AdminMemberDetailRoute() {
  const { memberId } = useParams({ from: "/admin/member/$memberId" });
  const navigate = useNavigate();

  return <AdminMemberDetailPage memberId={memberId} onBack={() => navigate({ to: "/admin" })} />;
}
