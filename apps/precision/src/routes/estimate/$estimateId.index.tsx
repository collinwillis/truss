import { createFileRoute, Navigate } from "@tanstack/react-router";
import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery } from "../../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Skeleton } from "@truss/ui/components/skeleton";

export const Route = createFileRoute("/estimate/$estimateId/")({
  component: EstimateIndexRedirect,
});

/**
 * Opening an estimate lands on the WORK, not a form (Collin's IA decision —
 * the Linear rule: the default screen is the thing you do all day). The
 * first WBS by code is where estimating starts; Overview and Setup are one
 * click away in the rail.
 */
function EstimateIndexRedirect() {
  const { estimateId } = Route.useParams();
  const proposalId = estimateId as Id<"proposals">;
  const wbsList = useStableQuery(api.precision.getWBSForProposal, { proposalId });

  if (!wbsList) {
    return (
      <div className="space-y-3 px-1 py-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // getWBSForProposal returns byWBSCode order, so [0] is the lowest code.
  const first = wbsList[0];
  if (!first) {
    // Every estimate is created with its WBS categories, so this is only
    // reachable on damaged data — Overview still renders there.
    return <Navigate to="/estimate/$estimateId/overview" params={{ estimateId }} replace />;
  }

  return (
    <Navigate
      to="/estimate/$estimateId/wbs/$wbsId"
      params={{ estimateId, wbsId: first._id as string }}
      replace
    />
  );
}
