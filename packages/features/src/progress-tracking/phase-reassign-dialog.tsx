"use client";

import * as React from "react";
import { Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@truss/ui/components/command";
import { cn } from "@truss/ui/lib/utils";

/** Available phase option for the picker. */
export interface PhaseOption {
  id: string;
  code: string;
  description: string;
}

export interface PhaseReassignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activityId: string;
  activityDescription: string;
  currentPhaseId: string;
  availablePhases: PhaseOption[];
  onReassign: (activityId: string, targetPhaseId: string) => void;
}

/**
 * Dialog for reassigning an activity to a different phase.
 *
 * WHY a dialog with Command instead of a simple select: phases can
 * number in the dozens, so a searchable list is essential for usability.
 */
export function PhaseReassignDialog({
  open,
  onOpenChange,
  activityId,
  activityDescription,
  currentPhaseId,
  availablePhases,
  onReassign,
}: PhaseReassignDialogProps) {
  const handleSelect = React.useCallback(
    (phaseId: string) => {
      onReassign(activityId, phaseId);
      onOpenChange(false);
    },
    [activityId, onReassign, onOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="text-sm font-semibold">Move to Phase</DialogTitle>
          <DialogDescription className="text-xs truncate">{activityDescription}</DialogDescription>
        </DialogHeader>
        <Command className="border-t">
          <CommandInput placeholder="Search phases..." />
          <CommandList>
            <CommandEmpty>No phases found.</CommandEmpty>
            <CommandGroup>
              {availablePhases.map((phase) => (
                <CommandItem
                  key={phase.id}
                  value={`${phase.code} ${phase.description}`}
                  onSelect={() => handleSelect(phase.id)}
                  className="gap-2"
                >
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                    {phase.code}
                  </span>
                  <span className="text-sm truncate">{phase.description}</span>
                  {phase.id === currentPhaseId && (
                    <Check className="ml-auto h-4 w-4 text-primary shrink-0" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
