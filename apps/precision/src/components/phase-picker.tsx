import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery } from "../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@truss/ui/components/command";
import { useMemo } from "react";
import { formatPhaseLabel, formatWbsLabel } from "../config/shell-config-estimate";

/**
 * The phase-choosing surface shared by both directions of activity movement:
 * IMPORT pulls lines from another phase into this one, COPY pushes the
 * selection out to another phase. One list means one set of rules — WBS by
 * code, phases by number, hidden WBS excluded, the current phase omitted —
 * so the two directions can never disagree about what is reachable.
 */

export interface PhaseOption {
  phaseId: string;
  label: string;
}

interface PhaseGroup {
  id: string;
  code: number;
  name: string;
  phases: { id: string; phaseNumber: number; description: string }[];
}

/** Selectable phases of a proposal, grouped by WBS. `[]` while loading. */
export function usePhaseOptions(
  proposalId: Id<"proposals">,
  excludePhaseId: string,
  enabled: boolean
): { groups: PhaseGroup[]; loaded: boolean } {
  // The shell already subscribes to both for the sidebar, so Convex serves
  // this from the same subscriptions.
  const tree = useStableQuery(
    api.precision.getWBSWithPhasesForNav,
    enabled ? { proposalId } : "skip"
  );
  const codes = useStableQuery(api.precision.getWBSForProposal, enabled ? { proposalId } : "skip");

  return useMemo(() => {
    if (!tree || !codes) return { groups: [], loaded: false };
    const codeById = new Map(codes.map((wbs) => [wbs._id as string, wbs.wbsPoolId]));
    const groups = tree
      .filter((wbs) => !wbs.isHidden)
      .map((wbs) => ({
        id: wbs._id as string,
        code: codeById.get(wbs._id as string) ?? 0,
        name: wbs.name,
        phases: wbs.phases
          .filter((phase) => (phase._id as string) !== excludePhaseId)
          .map((phase) => ({
            id: phase._id as string,
            phaseNumber: phase.phaseNumber,
            description: phase.description,
          })),
      }))
      .filter((wbs) => wbs.phases.length > 0)
      .sort((a, b) => a.code - b.code);
    return { groups, loaded: true };
  }, [tree, codes, excludePhaseId]);
}

/**
 * The list body itself. Rendered inside a `Command` the caller owns, so the
 * import flow can wrap it in a multi-step dialog while the copy flow uses the
 * plain command palette.
 */
export function PhaseCommandList({
  groups,
  loaded,
  emptyMessage,
  onPick,
}: {
  groups: PhaseGroup[];
  loaded: boolean;
  /** Shown when there are genuinely no phases to offer — not a search miss. */
  emptyMessage: string;
  onPick: (option: PhaseOption) => void;
}) {
  return (
    <CommandList>
      <CommandEmpty>
        {loaded && groups.length === 0 ? emptyMessage : "No matching phase."}
      </CommandEmpty>
      {groups.map((wbs) => (
        <CommandGroup key={wbs.id} heading={formatWbsLabel(wbs.code, wbs.name)}>
          {wbs.phases.map((phase) => (
            <CommandItem
              key={phase.id}
              value={`${wbs.code} ${wbs.name} ${phase.phaseNumber} ${phase.description}`}
              onSelect={() =>
                onPick({
                  phaseId: phase.id,
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
  );
}
