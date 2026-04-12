import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@truss/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { Calculator, ChevronDown, ArrowRight } from "lucide-react";
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
  const proposals = useQuery(api.precision.listProposals);

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
        <Button variant="ghost" size="sm" className="gap-2 h-8 px-2 max-w-[260px]">
          <Calculator className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate text-sm">
            <span className="font-mono text-muted-foreground">#{currentNumber}</span>{" "}
            <span className="font-medium">{currentDescription}</span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px]">
        {otherProposals.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            No other estimates
          </div>
        ) : (
          otherProposals.map((p) => (
            <DropdownMenuItem
              key={p._id}
              onClick={() =>
                navigate({
                  to: "/estimate/$estimateId",
                  params: { estimateId: p._id },
                })
              }
              className="flex items-center gap-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">
                  <span className="font-mono text-muted-foreground text-xs">
                    #{p.proposalNumber}
                  </span>{" "}
                  {p.description}
                </p>
                <p className="text-[11px] text-muted-foreground">{p.ownerName}</p>
              </div>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ to: "/estimates" })} className="gap-2">
          <ArrowRight className="h-3.5 w-3.5" />
          View All Estimates
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
