"use client";

import * as React from "react";
import { Check, Split } from "lucide-react";
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
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { cn } from "@truss/ui/lib/utils";

/** Available phase option for the picker. */
export interface PhaseOption {
  id: string;
  code: string;
  description: string;
  /** Provenance — lets the workbook mark phases added after the MCP import. */
  source?: "estimate" | "change_order" | "field_added";
}

export interface PhaseReassignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activityId: string;
  activityDescription: string;
  currentPhaseId: string;
  availablePhases: PhaseOption[];
  /**
   * Remaining quantity on the source activity after any existing splits.
   * Doubles as the upper bound for the split input and the default
   * "move whole activity" value.
   */
  availableQuantity: number;
  /** Activity unit (`EA`, `LF`, `CY`, …) — shown next to the quantity input. */
  unit: string;
  /**
   * Whole-activity move. Reassigns the entire activity (and any source
   * progress) to the target phase via the existing override path.
   */
  onReassign: (activityId: string, targetPhaseId: string) => void;
  /**
   * Partial move (split). Source quantity stays where it is, minus the
   * slice; the slice becomes a virtual row in the target phase.
   */
  onSplit: (activityId: string, targetPhaseId: string, quantity: number) => void;
}

/**
 * Two-step dialog for moving an activity to a different phase, in whole
 * or by splitting off a portion of the quantity.
 *
 * Flow: pick a target phase from the searchable list → optionally reduce
 * the quantity → confirm. Moving the full available quantity routes
 * through `onReassign`; anything less routes through `onSplit`. The button
 * label and helper line flip accordingly so the user always sees what's
 * about to happen.
 */
export function PhaseReassignDialog({
  open,
  onOpenChange,
  activityId,
  activityDescription,
  currentPhaseId,
  availablePhases,
  availableQuantity,
  unit,
  onReassign,
  onSplit,
}: PhaseReassignDialogProps) {
  const [selectedPhaseId, setSelectedPhaseId] = React.useState<string | null>(null);
  const [quantityInput, setQuantityInput] = React.useState<string>("");

  // Reset internal state whenever the dialog reopens for a new row.
  React.useEffect(() => {
    if (open) {
      setSelectedPhaseId(null);
      setQuantityInput(String(availableQuantity));
    }
  }, [open, availableQuantity, activityId]);

  const selectedPhase = React.useMemo(
    () => availablePhases.find((p) => p.id === selectedPhaseId) ?? null,
    [availablePhases, selectedPhaseId]
  );

  const parsedQuantity = Number(quantityInput);
  const quantityValid =
    Number.isFinite(parsedQuantity) && parsedQuantity > 0 && parsedQuantity <= availableQuantity;
  const isFullMove = quantityValid && parsedQuantity === availableQuantity;
  const canConfirm = !!selectedPhase && quantityValid;

  const handleConfirm = React.useCallback(() => {
    if (!selectedPhase || !quantityValid) return;
    if (isFullMove) {
      onReassign(activityId, selectedPhase.id);
    } else {
      onSplit(activityId, selectedPhase.id, parsedQuantity);
    }
    onOpenChange(false);
  }, [
    activityId,
    isFullMove,
    onOpenChange,
    onReassign,
    onSplit,
    parsedQuantity,
    quantityValid,
    selectedPhase,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="text-callout font-semibold">
            {selectedPhase ? "Confirm Move" : "Move to Phase"}
          </DialogTitle>
          <DialogDescription className="text-subheadline truncate">
            {activityDescription}
          </DialogDescription>
        </DialogHeader>

        {!selectedPhase ? (
          <Command className="border-t">
            <CommandInput placeholder="Search phases..." />
            <CommandList>
              <CommandEmpty>No phases found.</CommandEmpty>
              <CommandGroup>
                {availablePhases.map((phase) => (
                  <CommandItem
                    key={phase.id}
                    value={`${phase.code} ${phase.description}`}
                    onSelect={() => setSelectedPhaseId(phase.id)}
                    className="gap-2"
                  >
                    <span className="inline-flex items-center rounded bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                      {phase.code}
                    </span>
                    <span className="text-callout truncate">{phase.description}</span>
                    {phase.id === currentPhaseId && (
                      <Check className="ml-auto h-4 w-4 text-primary shrink-0" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <div className="border-t p-4 space-y-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded bg-fill-quaternary px-1.5 py-0.5 text-subheadline font-mono font-medium text-muted-foreground tabular-nums shrink-0">
                {selectedPhase.code}
              </span>
              <span className="text-callout truncate">{selectedPhase.description}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-subheadline"
                onClick={() => setSelectedPhaseId(null)}
              >
                Change
              </Button>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="move-quantity"
                className="flex items-baseline justify-between text-subheadline font-medium text-foreground"
              >
                <span>Quantity to move</span>
                <span className="text-foreground-subtle font-mono tabular-nums">
                  of {availableQuantity} {unit}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="move-quantity"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={availableQuantity}
                  step="any"
                  value={quantityInput}
                  onChange={(e) => setQuantityInput(e.target.value)}
                  className={cn(
                    "font-mono tabular-nums",
                    !quantityValid && quantityInput !== "" && "border-destructive"
                  )}
                  autoFocus
                />
                <span className="text-subheadline text-muted-foreground shrink-0 font-mono">
                  {unit}
                </span>
              </div>
              <p className="flex items-center gap-1.5 text-subheadline text-muted-foreground">
                {isFullMove ? (
                  <span>Moves the whole activity to phase {selectedPhase.code}.</span>
                ) : quantityValid ? (
                  <>
                    <Split className="h-3 w-3 shrink-0" />
                    <span>
                      Splits off {parsedQuantity} {unit};{" "}
                      {round2(availableQuantity - parsedQuantity)} {unit} stays in the current
                      phase.
                    </span>
                  </>
                ) : (
                  <span className="text-destructive">
                    Enter a quantity between 0 and {availableQuantity}.
                  </span>
                )}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!canConfirm} onClick={handleConfirm}>
                {isFullMove ? "Move activity" : "Split to phase"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Two-decimal rounding for display math. */
function round2(val: number): number {
  return Math.round(val * 100) / 100;
}
