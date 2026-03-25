import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Admin layout route.
 *
 * WHY: TanStack Router's file-based routing requires a layout route
 * to render child routes via Outlet. Matches the project/$projectId.tsx pattern.
 */
export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  return <Outlet />;
}
