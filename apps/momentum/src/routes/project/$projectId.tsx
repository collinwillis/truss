import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Project layout route component.
 *
 * This is a LAYOUT-ONLY route that renders child routes:
 * - Index route (`$projectId.index.tsx`) → Dashboard
 * - Sibling routes (`.entry`, `.browse`, `.details`, `.settings`, `.reports`, etc.)
 * - Nested routes (`/wbs/$wbsId`)
 *
 * WHY: TanStack Router's file-based routing requires layout routes to render an Outlet.
 * The dashboard content is in the separate index route file.
 */
export const Route = createFileRoute("/project/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  return <Outlet />;
}
