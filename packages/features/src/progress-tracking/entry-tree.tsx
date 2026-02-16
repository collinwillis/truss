"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@truss/ui/components/collapsible";
import { Button } from "@truss/ui/components/button";
import { EntryItemCard } from "./entry-item-card";
import type { WBSItem, PhaseItem, DetailItem, ProgressMetrics } from "./types";

export interface DetailItemState {
  checked: boolean;
  quantity: string;
  validation: { type: "error" | "warning"; message: string } | null;
}

export interface EntryTreeProps {
  /**
   * WBS items to display.
   */
  wbsItems: WBSItem[];
  /**
   * Phase items grouped by WBS ID.
   */
  phasesByWBS: Record<string, PhaseItem[]>;
  /**
   * Detail items grouped by phase ID.
   */
  detailsByPhase: Record<string, DetailItem[]>;
  /**
   * Progress metrics for each detail item.
   */
  metricsById: Record<string, ProgressMetrics>;
  /**
   * Suggested quantities for each detail item.
   */
  suggestedQuantities: Record<string, number | null>;
  /**
   * State for each detail item (checked, quantity, validation).
   */
  itemStates: Record<string, DetailItemState>;
  /**
   * Callback when item state changes.
   */
  onItemStateChange: (itemId: string, state: Partial<DetailItemState>) => void;
  /**
   * Additional class name.
   */
  className?: string;
}

/**
 * Hierarchical tree view for WBS → Phase → Detail items.
 *
 * Provides collapsible sections with:
 * - Auto-expand items with partial progress
 * - Auto-collapse completed items
 * - Visual hierarchy with indentation
 * - Keyboard navigation
 */
export function EntryTree({
  wbsItems,
  phasesByWBS,
  detailsByPhase,
  metricsById,
  suggestedQuantities,
  itemStates,
  onItemStateChange,
  className,
}: EntryTreeProps) {
  // Track expanded WBS and Phase items
  const [expandedWBS, setExpandedWBS] = React.useState<Set<string>>(new Set());
  const [expandedPhases, setExpandedPhases] = React.useState<Set<string>>(new Set());

  // Auto-expand WBS with in-progress items on mount
  React.useEffect(() => {
    const wbsToExpand = new Set<string>();
    const phasesToExpand = new Set<string>();

    wbsItems.forEach((wbs) => {
      const phases = phasesByWBS[wbs.id] || [];
      const hasInProgress = phases.some((phase) => {
        const details = detailsByPhase[phase.id] || [];
        return details.some((detail) => {
          const metrics = metricsById[detail.id];
          return metrics && metrics.percentComplete > 0 && metrics.percentComplete < 100;
        });
      });

      if (hasInProgress) {
        wbsToExpand.add(wbs.id);
        phases.forEach((phase) => {
          const details = detailsByPhase[phase.id] || [];
          const hasPhaseProgress = details.some((detail) => {
            const metrics = metricsById[detail.id];
            return metrics && metrics.percentComplete > 0 && metrics.percentComplete < 100;
          });
          if (hasPhaseProgress) {
            phasesToExpand.add(phase.id);
          }
        });
      }
    });

    setExpandedWBS(wbsToExpand);
    setExpandedPhases(phasesToExpand);
  }, [wbsItems, phasesByWBS, detailsByPhase, metricsById]);

  const toggleWBS = (wbsId: string) => {
    setExpandedWBS((prev) => {
      const next = new Set(prev);
      if (next.has(wbsId)) {
        next.delete(wbsId);
      } else {
        next.add(wbsId);
      }
      return next;
    });
  };

  const togglePhase = (phaseId: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      return next;
    });
  };

  return (
    <div className={cn("space-y-2", className)}>
      {wbsItems.map((wbs) => {
        const phases = phasesByWBS[wbs.id] || [];
        const isExpanded = expandedWBS.has(wbs.id);

        return (
          <Collapsible key={wbs.id} open={isExpanded} onOpenChange={() => toggleWBS(wbs.id)}>
            {/* WBS Header */}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="w-full justify-start px-2 py-2 h-auto font-semibold hover:bg-accent"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 mr-2 flex-shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 mr-2 flex-shrink-0" />
                )}
                <span className="flex-1 text-left">
                  {wbs.code} {wbs.description}
                </span>
                <span className="text-sm text-muted-foreground ml-2">{wbs.percentComplete}%</span>
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <div className="ml-4 space-y-2 mt-2">
                {phases.map((phase) => {
                  const details = detailsByPhase[phase.id] || [];
                  const isPhaseExpanded = expandedPhases.has(phase.id);

                  return (
                    <Collapsible
                      key={phase.id}
                      open={isPhaseExpanded}
                      onOpenChange={() => togglePhase(phase.id)}
                    >
                      {/* Phase Header */}
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          className="w-full justify-start px-2 py-2 h-auto text-sm hover:bg-accent/50"
                        >
                          {isPhaseExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 mr-2 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 mr-2 flex-shrink-0" />
                          )}
                          <span className="flex-1 text-left font-medium">
                            {phase.code} {phase.description}
                          </span>
                          <span className="text-xs text-muted-foreground ml-2">
                            {phase.percentComplete}%
                          </span>
                        </Button>
                      </CollapsibleTrigger>

                      <CollapsibleContent>
                        <div className="ml-4 space-y-3 mt-3">
                          {details.map((detail) => {
                            const metrics = metricsById[detail.id];
                            const suggestedQuantity = suggestedQuantities[detail.id] ?? null;
                            const state = itemStates[detail.id] || {
                              checked: false,
                              quantity: "",
                              validation: null,
                            };

                            if (!metrics) return null;

                            return (
                              <EntryItemCard
                                key={detail.id}
                                item={detail}
                                metrics={metrics}
                                suggestedQuantity={suggestedQuantity}
                                checked={state.checked}
                                quantity={state.quantity}
                                validation={state.validation}
                                onCheckedChange={(checked) => {
                                  onItemStateChange(detail.id, {
                                    checked,
                                    quantity: checked
                                      ? state.quantity || (suggestedQuantity?.toString() ?? "")
                                      : "",
                                  });
                                }}
                                onQuantityChange={(quantity) => {
                                  onItemStateChange(detail.id, { quantity });
                                }}
                              />
                            );
                          })}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
