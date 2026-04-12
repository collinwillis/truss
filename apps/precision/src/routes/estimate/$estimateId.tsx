import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Estimate layout route.
 *
 * Renders child routes:
 * - Index route (`$estimateId.index.tsx`) — Overview with info + rates + WBS
 * - Sibling routes (`.wbs.$wbsId`, `.phase.$phaseId`)
 *
 * WHY: TanStack Router's file-based routing requires layout routes to render an Outlet.
 */
export const Route = createFileRoute("/estimate/$estimateId")({
  component: EstimateLayout,
});

function EstimateLayout() {
  return <Outlet />;
}
