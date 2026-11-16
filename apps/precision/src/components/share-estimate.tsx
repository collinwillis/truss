import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { ShareEstimateDialog } from "@truss/features/access";
import type { JSX } from "react";

/** The estimate being shared, as either the log row or `getProposal` carries it. */
export interface ShareableEstimate {
  _id: string;
  proposalNumber: string;
  description: string;
}

/** Props for {@link ShareEstimate}. */
export interface ShareEstimateProps {
  /** Nothing renders without one, so a closed share holds no subscriptions. */
  estimate: ShareableEstimate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The name the Share dialog quotes: `#1744 AG PIPING`, as the top bar and the
 * log spell it. The description is estimate data, which the app draws in caps.
 */
export function shareTitleFor(estimate: ShareableEstimate): string {
  return `#${estimate.proposalNumber.trim()} ${estimate.description.toUpperCase()}`;
}

/**
 * Precision's Share dialog for one estimate. Owner/Admin only: render it only
 * for them, because the queries behind it refuse everyone else.
 */
export function ShareEstimate({
  estimate,
  open,
  onOpenChange,
}: ShareEstimateProps): JSX.Element | null {
  if (!estimate) return null;
  return (
    <ShareEstimateDialog
      proposalId={estimate._id as Id<"proposals">}
      estimateName={shareTitleFor(estimate)}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
