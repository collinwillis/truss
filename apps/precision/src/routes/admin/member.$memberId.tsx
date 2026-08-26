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

  // See the sibling route: the shell no longer pads, so document pages do.
  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <AdminMemberDetailPage memberId={memberId} onBack={() => navigate({ to: "/admin" })} />
    </div>
  );
}
