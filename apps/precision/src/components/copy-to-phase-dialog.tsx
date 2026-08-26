import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { CommandDialog, CommandInput } from "@truss/ui/components/command";
import { PhaseCommandList, usePhaseOptions, type PhaseOption } from "./phase-picker";

/**
 * Push the current selection out to another phase.
 *
 * The secondary direction, and deliberately selection-driven: it is offered
 * from the selection bar, where the lines are already in hand. Pulling a
 * whole phase in is {@link ImportActivitiesDialog}'s job — that one needs no
 * selection at all, because the estimator is at the destination.
 */
export type CopyTargetPhase = PhaseOption;

export function CopyToPhaseDialog({
  open,
  onOpenChange,
  proposalId,
  currentPhaseId,
  count,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposalId: Id<"proposals">;
  currentPhaseId: string;
  /** How many activities the pick will copy — the title says what it does. */
  count: number;
  onPick: (target: CopyTargetPhase) => void;
}) {
  const { groups, loaded } = usePhaseOptions(proposalId, currentPhaseId, open);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Copy ${count} ${count === 1 ? "activity" : "activities"} to…`}
      description="Search phases by number, description, or WBS"
    >
      <CommandInput placeholder="Copy to phase… (number, description, or WBS)" />
      <PhaseCommandList
        groups={groups}
        loaded={loaded}
        emptyMessage="No other phases to copy to — add a phase, or unhide a WBS in Setup."
        onPick={onPick}
      />
    </CommandDialog>
  );
}
