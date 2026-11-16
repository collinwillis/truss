import { Button } from "@truss/ui/components/button";
import { Plus } from "lucide-react";
import type { JSX, ReactNode } from "react";

/** Props for {@link EstimatesEmptyState}. */
export interface EstimatesEmptyStateProps {
  /** Whether the caller can see any estimate at all, before search and filters. */
  hasAnyProposals: boolean;
  search: string;
  statusFilter: string | null;
  /** Matches the search finds that the filters hide. */
  hiddenMatches: number;
  /** Offers New Estimate when the log is empty. */
  canStart: boolean;
  /**
   * The caller sees only the estimates they were added to, so an empty log
   * means nobody has added them yet, not that the company has no work.
   */
  onlyAssigned: boolean;
  onNew: () => void;
  onClearSearch: () => void;
  onClearFilters: () => void;
}

/**
 * What the proposal log shows when no row is on screen.
 *
 * Each case names what happened and offers the one way out — never a bare
 * "No results", which tells you nothing you could act on.
 */
export function EstimatesEmptyState({
  hasAnyProposals,
  search,
  statusFilter,
  hiddenMatches,
  canStart,
  onlyAssigned,
  onNew,
  onClearSearch,
  onClearFilters,
}: EstimatesEmptyStateProps): JSX.Element {
  if (!hasAnyProposals) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
        <div className="space-y-1">
          <p className="text-body font-medium text-foreground">No estimates yet</p>
          {onlyAssigned && (
            <p className="text-callout text-muted-foreground">
              Estimates you&apos;re added to appear here.
            </p>
          )}
        </div>
        {canStart && (
          <Button variant="outline" size="lg" onClick={onNew}>
            <Plus className="h-3 w-3" /> New Estimate
          </Button>
        )}
      </div>
    );
  }

  let title: string;
  let action: ReactNode;
  if (search && hiddenMatches > 0) {
    title = statusFilter ? `No matches in ${statusFilter}` : "No matches in the current filters";
    action = (
      <Button variant="outline" size="lg" onClick={onClearFilters}>
        Search all ({hiddenMatches} elsewhere)
      </Button>
    );
  } else if (search) {
    title = `No estimates match “${search}”`;
    action = (
      <Button variant="outline" size="lg" onClick={onClearSearch}>
        Clear search
      </Button>
    );
  } else {
    title = statusFilter ? `No ${statusFilter} estimates` : "Nothing matches these filters";
    action = (
      <Button variant="outline" size="lg" onClick={onClearFilters}>
        Clear filters
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <p className="text-body text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}
