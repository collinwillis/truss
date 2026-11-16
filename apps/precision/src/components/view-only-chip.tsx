import { cn } from "@truss/ui/lib/utils";
import { Lock } from "lucide-react";
import type { JSX } from "react";

/**
 * Says the estimate on screen is view-only for the caller.
 *
 * Shown because a view-only estimate simply lacks its edit controls, and an
 * estimator who can edit the next one over would otherwise read that as
 * broken. Who to ask is left out: an Owner or Admin is the only answer.
 *
 * @param className - Sizing for the surrounding toolbar or header
 */
export function ViewOnlyChip({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md bg-fill-quaternary px-2 py-0.5 text-callout text-muted-foreground",
        className
      )}
    >
      <Lock className="h-3 w-3" aria-hidden="true" />
      View only
    </span>
  );
}
