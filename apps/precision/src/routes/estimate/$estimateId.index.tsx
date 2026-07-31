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

  // getWBSForProposal returns byWBSCode order, so the first VISIBLE entry is
  // the lowest active code — Setup's toggles decide what this estimate uses.
  //
  // ACCEPTED STALENESS: this list may come from the stale-while-loading cache,
  // so a WBS hidden elsewhere moments ago could still be chosen. The warms
  // refetch on every hover (so the common paths carry fresh flags), and the
  // failure mode is benign — the table renders, the rail simply omits it.
  const first = wbsList.find((w) => !w.isHidden);
  if (!first) {
    // No visible WBS (all toggled off in Setup, or damaged data) — Overview
    // still renders and links to Setup.
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
