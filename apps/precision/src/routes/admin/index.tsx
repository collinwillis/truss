import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminMembersPage } from "@truss/features/admin";

/**
 * Admin members list route.
 *
 * The page itself is shared with Momentum — both apps administer the same
 * Better Auth organization. This file only binds it to Precision's route tree,
 * which is the one thing a shared component cannot own.
 */
export const Route = createFileRoute("/admin/")({
  component: AdminMembersRoute,
});

function AdminMembersRoute() {
  const navigate = useNavigate();

  return (
    // Precision's shell runs edge-to-edge for the proposal log, so this
    // document-style page supplies the frame the shell no longer does. The
    // padding lives here rather than in the shared page, which Momentum
    // renders inside a shell that still pads.
    <div className="h-full overflow-auto p-4 md:p-5">
      <AdminMembersPage
        onOpenMember={(memberId) =>
          navigate({ to: "/admin/member/$memberId", params: { memberId } })
        }
      />
    </div>
  );
}
