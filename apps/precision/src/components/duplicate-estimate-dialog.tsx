import { useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Button } from "@truss/ui/components/button";
import { useState, useCallback } from "react";

interface DuplicateEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceProposalId: string;
  sourceProposalNumber: string;
  sourceDescription: string;
}

/**
 * Dialog for duplicating an existing estimate.
 *
 * WHY: Deep-copies the entire estimate tree (proposal + WBS + phases + activities)
 * with a new proposal number. Common workflow for revision-based estimating.
 */
export function DuplicateEstimateDialog({
  open,
  onOpenChange,
  sourceProposalId,
  sourceProposalNumber,
  sourceDescription,
}: DuplicateEstimateDialogProps) {
  const navigate = useNavigate();
  const duplicateProposal = useMutation(api.precision.duplicateProposal);

  const [newNumber, setNewNumber] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setNewNumber("");
    setNewDescription("");
    setIsSubmitting(false);
  }, []);

  // Auto-suggest a revision number
  const suggestedNumber = (() => {
    const base = parseFloat(sourceProposalNumber);
    if (!isNaN(base)) {
      const decimal = sourceProposalNumber.includes(".") ? base + 0.01 : base + 0.1;
      return decimal.toFixed(sourceProposalNumber.includes(".") ? 2 : 1);
    }
    return `${sourceProposalNumber}-copy`;
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const number = newNumber.trim() || suggestedNumber;
    if (!number) return;

    setIsSubmitting(true);
    try {
      const newId = await duplicateProposal({
        sourceProposalId: sourceProposalId as never,
        newProposalNumber: number,
        newDescription: newDescription.trim() || undefined,
      });

      onOpenChange(false);
      resetForm();
      navigate({ to: "/estimate/$estimateId", params: { estimateId: newId } });
    } catch (error) {
      console.error("Failed to duplicate estimate:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetForm();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Duplicate Estimate</DialogTitle>
            <DialogDescription>
              Create a copy of estimate #{sourceProposalNumber} with all WBS, phases, and
              activities.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <p className="font-medium">Source: #{sourceProposalNumber}</p>
              <p className="text-muted-foreground text-xs mt-0.5">{sourceDescription}</p>
            </div>

            <div className="grid gap-3">
              <Label htmlFor="new-number">New Proposal Number</Label>
              <Input
                id="new-number"
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                placeholder={suggestedNumber}
                className="font-mono"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Leave blank to use {suggestedNumber}
              </p>
            </div>

            <div className="grid gap-3">
              <Label htmlFor="new-desc">Description (optional)</Label>
              <Input
                id="new-desc"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={sourceDescription}
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Duplicating..." : "Duplicate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
