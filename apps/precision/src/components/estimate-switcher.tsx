import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery, useWarmOnIntent, warmQuery } from "../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useConvex } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@truss/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { Check, ChevronsUpDown, ArrowRight } from "lucide-react";
import { useMemo } from "react";

interface EstimateSwitcherProps {
  currentEstimateId: string;
  currentDescription: string;
  currentNumber: string;
}

/**
 * Dropdown switcher for quickly navigating between estimates.
 *
 * WHY: When inside an estimate, users need to quickly jump to other
 * estimates without navigating back to the list. Same pattern as
 * Momentum's ProjectSwitcher in the top bar.
 */
export function EstimateSwitcher({
  currentEstimateId,
  currentDescription,
  currentNumber,
}: EstimateSwitcherProps) {
  const navigate = useNavigate();
  const convex = useConvex();
  const proposals = useStableQuery(api.precision.listProposals);

  // Warm the highlighted estimate's opening path (shell queries, then the
  // first VISIBLE WBS's phase table once the list arrives — mirroring the
  // redirect) so switching swaps in place instead of dropping to a skeleton.
  const warmEstimate = (id: string) => {
    const proposalId = id as Id<"proposals">;
    void warmQuery(convex, api.precision.getProposal, { proposalId });
    void warmQuery(convex, api.precision.getProposalSummary, { proposalId });
    void warmQuery(convex, api.precision.getWBSForProposal, { proposalId }).then((wbsList) => {
      const first = wbsList?.find((w) => !w.isHidden);
      if (first) void warmQuery(convex, api.precision.getPhaseListWithCosts, { wbsId: first._id });
    });
  };
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();

  const otherProposals = useMemo(() => {
    if (!proposals) return [];
    return proposals
      .filter((p) => p._id !== currentEstimateId)
      .sort((a, b) => {
        const numA = parseFloat(a.proposalNumber);
        const numB = parseFloat(b.proposalNumber);
        if (!isNaN(numA) && !isNaN(numB)) return numB - numA;
        return b.proposalNumber.localeCompare(a.proposalNumber);
      })
      .slice(0, 10); // Show top 10
  }, [proposals, currentEstimateId]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The window's document control — this is the title now that the
            native bar is gone, so it reads as a title first (name weighted,
            number quiet) and a control second (the popup chevron). */}
        <Button variant="ghost" size="lg" className="gap-1.5 px-2 max-w-[280px]">
          <span className="truncate text-[13px]">
            <span className="font-mono text-xs text-muted-foreground">#{currentNumber}</span>{" "}
            <span className="font-medium">{currentDescription}</span>
          </span>
          <ChevronsUpDown className="h-3 w-3 text-foreground-subtle shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[320px]">
        <DropdownMenuLabel className="text-footnote font-medium uppercase tracking-wide text-foreground-subtle">
          Switch estimate
        </DropdownMenuLabel>
        {/* The current estimate anchors the list — you can see where you are
            before deciding where to go. */}
        <DropdownMenuItem className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm">
              <span className="font-mono text-xs text-muted-foreground">#{currentNumber}</span>{" "}
              <span className="font-medium">{currentDescription}</span>
            </p>
          </div>
          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
        </DropdownMenuItem>
        {otherProposals.map((p) => (
          <DropdownMenuItem
            key={p._id}
            onMouseEnter={() => queueWarm(() => warmEstimate(p._id))}
            onMouseLeave={cancelWarm}
            onFocus={() => queueWarm(() => warmEstimate(p._id))}
            onBlur={cancelWarm}
            onClick={() =>
              navigate({
                to: "/estimate/$estimateId",
                params: { estimateId: p._id },
              })
            }
            className="flex items-center gap-2"
          >
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm">
                <span className="font-mono text-xs text-muted-foreground">#{p.proposalNumber}</span>{" "}
                {p.description}
              </p>
              <p className="truncate text-xs text-muted-foreground">{p.ownerName}</p>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ to: "/estimates" })} className="gap-2">
          <ArrowRight className="h-3.5 w-3.5" />
          All estimates
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
