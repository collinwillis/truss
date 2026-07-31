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
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo } from "react";
import { formatPhaseLabel } from "../config/shell-config-estimate";

/**
 * Phase-to-phase navigation for the drill-down (D7).
 *
 * The drill-down model stays — Collin's call — so the friction the
 * production data measured (median one activity per phase; up to 2,222
 * phases per estimate) is attacked at the transition: walk the whole
 * estimate with `[` / `]` or the toolbar chevrons, and jump within the WBS
 * from the breadcrumb itself. The sequence crosses WBS boundaries in bid
 * order, so paging through an estimate end-to-end never touches the sidebar.
 *
 * WHY these queries are free: the shell already subscribes to both for the
 * sidebar tree, so Convex serves this component from the same subscriptions.
 */

interface PhaseSequenceEntry {
  phaseId: string;
  phaseNumber: number;
  description: string;
}

interface PhaseSequence {
  prev: PhaseSequenceEntry | null;
  next: PhaseSequenceEntry | null;
  /** Phases of the current WBS, in display order — the switcher's list. */
  siblings: PhaseSequenceEntry[];
  /**
   * 1-based position across the whole estimate; 0 while loading or when the
   * phase sits outside the sequence (its WBS is hidden, reached by deep link).
   */
  position: number;
  total: number;
}

/** The estimate's full phase sequence, in bid order, centered on one phase. */
export function usePhaseSequence(
  proposalId: Id<"proposals">,
  currentPhaseId: string
): PhaseSequence {
  const tree = useStableQuery(api.precision.getWBSWithPhasesForNav, { proposalId });
  const codes = useStableQuery(api.precision.getWBSForProposal, { proposalId });

  return useMemo(() => {
    if (!tree || !codes) return { prev: null, next: null, siblings: [], position: 0, total: 0 };

    const codeById = new Map(codes.map((wbs) => [wbs._id as string, wbs.wbsPoolId]));
    // Hidden WBS (Setup toggles) leave the sequence: `[` / `]` and the
    // position count walk only what the estimate uses. Inside a hidden WBS
    // (deep link), the chevrons simply disable.
    const ordered = tree
      .filter((wbs) => !wbs.isHidden)
      .sort((a, b) => (codeById.get(a._id as string) ?? 0) - (codeById.get(b._id as string) ?? 0));

    const sequence: PhaseSequenceEntry[] = [];
    let siblings: PhaseSequenceEntry[] = [];
    for (const wbs of ordered) {
      const phases = wbs.phases.map((phase) => ({
        phaseId: phase._id as string,
        phaseNumber: phase.phaseNumber,
        description: phase.description,
      }));
      if (phases.some((phase) => phase.phaseId === currentPhaseId)) siblings = phases;
      sequence.push(...phases);
    }

    const index = sequence.findIndex((entry) => entry.phaseId === currentPhaseId);
    return {
      prev: index > 0 ? (sequence[index - 1] ?? null) : null,
      next: index >= 0 ? (sequence[index + 1] ?? null) : null,
      siblings,
      position: index + 1,
      total: sequence.length,
    };
  }, [tree, codes, currentPhaseId]);
}

/**
 * Prev/next phase controls with `[` / `]` keys. Rendered for every permission
 * level — navigation is read functionality.
 */
export function PhaseNavButtons({
  estimateId,
  sequence,
}: {
  estimateId: string;
  sequence: PhaseSequence;
}) {
  const navigate = useNavigate();
  const { prev, next, position, total } = sequence;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Never steal keys from an editing surface — the grid's cells are inputs.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "[" && prev) {
        event.preventDefault();
        void navigate({
          to: "/estimate/$estimateId/phase/$phaseId",
          params: { estimateId, phaseId: prev.phaseId },
        });
      } else if (event.key === "]" && next) {
        event.preventDefault();
        void navigate({
          to: "/estimate/$estimateId/phase/$phaseId",
          params: { estimateId, phaseId: next.phaseId },
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prev, next, estimateId, navigate]);

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {/* position > 0 implies total > 0, and also hides the counter for a
          phase outside the sequence — "0 / 37" would read as a bug. */}
      {position > 0 && (
        <span className="mr-1 text-footnote tabular-nums text-foreground-subtle">
          {position} / {total}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-lg"
        disabled={!prev}
        title={
          prev
            ? `Previous phase — ${formatPhaseLabel(prev.phaseNumber, prev.description)}  [`
            : "No previous phase"
        }
        onClick={() =>
          prev &&
          navigate({
            to: "/estimate/$estimateId/phase/$phaseId",
            params: { estimateId, phaseId: prev.phaseId },
          })
        }
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-lg"
        disabled={!next}
        title={
          next
            ? `Next phase — ${formatPhaseLabel(next.phaseNumber, next.description)}  ]`
            : "No next phase"
        }
        onClick={() =>
          next &&
          navigate({
            to: "/estimate/$estimateId/phase/$phaseId",
            params: { estimateId, phaseId: next.phaseId },
          })
        }
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * The breadcrumb's phase segment as a switcher: click the current phase to
 * jump anywhere within the WBS without touching the sidebar.
 */
export function PhaseSwitcher({
  estimateId,
  currentPhaseId,
  currentLabel,
  siblings,
}: {
  estimateId: string;
  currentPhaseId: string;
  currentLabel: string;
  siblings: PhaseSequenceEntry[];
}) {
  const navigate = useNavigate();
  const convex = useConvex();
  const { queue: queueWarm, cancel: cancelWarm } = useWarmOnIntent();

  // Warm a sibling's queries once its menu item has held the cursor (or
  // keyboard highlight) — the sibling list is unbounded, so a scroll sweep
  // must not fire a warm per item crossed.
  const warmSibling = (phaseId: string) => {
    const typedPhaseId = phaseId as Id<"phases">;
    void warmQuery(convex, api.precision.getPhase, { phaseId: typedPhaseId });
    void warmQuery(convex, api.precision.getActivitiesWithCosts, { phaseId: typedPhaseId });
  };

  if (siblings.length <= 1) {
    return (
      <span className="font-medium text-foreground truncate" title={currentLabel}>
        {currentLabel}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={currentLabel}
          className="flex min-w-0 items-center gap-1 font-medium text-foreground hover:text-primary transition-colors"
        >
          <span className="truncate">{currentLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] w-[280px] overflow-y-auto">
        {siblings.map((phase) => (
          <DropdownMenuItem
            key={phase.phaseId}
            onMouseEnter={() => queueWarm(() => warmSibling(phase.phaseId))}
            onMouseLeave={cancelWarm}
            onFocus={() => queueWarm(() => warmSibling(phase.phaseId))}
            onBlur={cancelWarm}
            onClick={() =>
              navigate({
                to: "/estimate/$estimateId/phase/$phaseId",
                params: { estimateId, phaseId: phase.phaseId },
              })
            }
            className="gap-2"
          >
            {phase.phaseId === currentPhaseId ? (
              <Check className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate text-sm">
              <span className="font-mono text-xs text-muted-foreground">{phase.phaseNumber}</span>{" "}
              {phase.description}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
