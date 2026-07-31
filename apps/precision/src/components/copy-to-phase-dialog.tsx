import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery } from "../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@truss/ui/components/command";
import { useMemo } from "react";
import { formatPhaseLabel, formatWbsLabel } from "../config/shell-config-estimate";

/**
 * Target picker for copying activities into another phase.
 *
 * A searchable palette rather than a tree: on production estimates a WBS can
 * hold hundreds of phases, and the estimator knows the phase number or
 * description they want — typing beats expanding. Groups follow the sidebar's
 * rules exactly (WBS by code, phases by number, hidden WBS excluded), so the
 * picker never offers a destination the rail wouldn't show.
 */

export interface CopyTargetPhase {
  phaseId: string;
  label: string;
}

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
  // The shell already subscribes to both for the sidebar; Convex serves this
  // component from the same subscriptions.
  const tree = useStableQuery(api.precision.getWBSWithPhasesForNav, open ? { proposalId } : "skip");
  const codes = useStableQuery(api.precision.getWBSForProposal, open ? { proposalId } : "skip");

  const groups = useMemo(() => {
    if (!tree || !codes) return [];
    const codeById = new Map(codes.map((wbs) => [wbs._id as string, wbs.wbsPoolId]));
    return tree
      .filter((wbs) => !wbs.isHidden)
      .map((wbs) => ({
        id: wbs._id as string,
        code: codeById.get(wbs._id as string) ?? 0,
        name: wbs.name,
        phases: wbs.phases.filter((phase) => (phase._id as string) !== currentPhaseId),
      }))
      .filter((wbs) => wbs.phases.length > 0)
      .sort((a, b) => a.code - b.code);
  }, [tree, codes, currentPhaseId]);

  // A single-phase estimate (or one whose other phases all sit in hidden WBS)
  // opens this picker with nothing to offer — the search-miss message would
  // be a lie under an untouched input.
  const loaded = tree !== undefined && codes !== undefined;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Copy ${count} ${count === 1 ? "activity" : "activities"} to…`}
      description="Search phases by number, description, or WBS"
    >
      <CommandInput placeholder="Copy to phase… (number, description, or WBS)" />
      <CommandList>
        <CommandEmpty>
          {loaded && groups.length === 0
            ? "No other phases to copy to — add a phase, or unhide a WBS in Setup."
            : "No matching phase."}
        </CommandEmpty>
        {groups.map((wbs) => (
          <CommandGroup key={wbs.id} heading={formatWbsLabel(wbs.code, wbs.name)}>
            {wbs.phases.map((phase) => (
              <CommandItem
                key={phase._id as string}
                value={`${wbs.code} ${wbs.name} ${phase.phaseNumber} ${phase.description}`}
                onSelect={() =>
                  onPick({
                    phaseId: phase._id as string,
                    label: formatPhaseLabel(phase.phaseNumber, phase.description),
                  })
                }
              >
                <span className="font-mono text-xs text-muted-foreground">{phase.phaseNumber}</span>
                <span className="truncate">{phase.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
