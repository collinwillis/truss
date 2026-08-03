import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { toast } from "sonner";
import { deriveRevision, type FamilyMember } from "./estimates-grid/revision";

export interface CreateRevisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The proposal being revised, or null while the dialog is closed. */
  source: (FamilyMember & { _id: string }) | null;
  /** Every proposal, so the family and any collision can be found. */
  allProposals: readonly FamilyMember[];
}

/**
 * Create a revision of an existing proposal.
 *
 * WHY A DIALOG AND NOT A SILENT ACTION: the number and description are
 * derived from the family's own convention, and across the live data those
 * conventions genuinely disagree — `.01` against `.3`, `(R5)` against
 * `(Rev #4)`, and one family carrying three of them at once. A derivation is
 * a good guess, not an authority, so it arrives pre-filled and the estimator
 * confirms it. The number field is focused and selected on open, so accepting
 * the suggestion is one keystroke and overriding it is one more.
 */
export function CreateRevisionDialog({
  open,
  onOpenChange,
  source,
  allProposals,
}: CreateRevisionDialogProps) {
  const navigate = useNavigate();
  const duplicateProposal = useMutation(api.precision.duplicateProposal);

  const [proposalNumber, setProposalNumber] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const numberRef = useRef<HTMLInputElement>(null);

  // Re-derive whenever the dialog opens on a row. useLayoutEffect so the
  // fields are never painted holding the previous proposal's values.
  useLayoutEffect(() => {
    if (!open || !source) return;
    const derived = deriveRevision(source, allProposals);
    setProposalNumber(derived.proposalNumber);
    setDescription(derived.description);
    setSubmitting(false);
  }, [open, source, allProposals]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      numberRef.current?.focus();
      numberRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!source) return null;

  const trimmedNumber = proposalNumber.trim();
  // Checked against what is TYPED, not against the derivation — the estimator
  // may overrule the suggestion, and the warning has to follow them.
  const taken = allProposals.some((p) => p.proposalNumber.trim() === trimmedNumber);
  const canSubmit = trimmedNumber.length > 0 && description.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const newId = await duplicateProposal({
        sourceProposalId: source._id as Id<"proposals">,
        newProposalNumber: trimmedNumber,
        newDescription: description.trim(),
      });
      toast.success(`Created ${trimmedNumber}`);
      onOpenChange(false);
      // Land on the new revision: the reason for making one is to change it.
      navigate({ to: "/estimate/$estimateId", params: { estimateId: newId as string } });
    } catch (error) {
      setSubmitting(false);
      toast.error(error instanceof Error ? error.message : "Could not create the revision");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Create revision</DialogTitle>
          <DialogDescription>
            Copies {source.proposalNumber.trim()} — every work breakdown, phase and activity — into
            a new estimate.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="revision-number">Proposal number</Label>
            <Input
              id="revision-number"
              ref={numberRef}
              value={proposalNumber}
              onChange={(e) => setProposalNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              className="font-mono"
              autoComplete="off"
            />
            {taken && (
              <p className="text-footnote text-amber-600 dark:text-amber-400">
                Another estimate already uses this number. That&rsquo;s allowed — the log has a few
                — but worth a second look.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="revision-description">Description</Label>
            <Input
              id="revision-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create revision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
