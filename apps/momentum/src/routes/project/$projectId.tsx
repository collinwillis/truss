import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Project layout route component.
 *
 * Layout-only route that renders child routes:
 * - Index route (`$projectId.index.tsx`) — Dashboard
 * - Sibling routes (`.workbook`, `.reports`, `.settings`)
 *
 * WHY: TanStack Router's file-based routing requires layout routes to render an Outlet.
 */
export const Route = createFileRoute("/project/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  return <Outlet />;
}
