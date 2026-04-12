import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Admin layout route.
 *
 * WHY: TanStack Router requires a layout route to render child routes.
 * Admin pages share no specific layout, so this is a plain Outlet wrapper.
 */
export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  return <Outlet />;
}
