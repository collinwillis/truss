import { useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
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
import { useState } from "react";
import { toast } from "sonner";

interface AddChangeOrderPhaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wbsId: Id<"momentumWbs">;
  /** Auto-suggested phase name (e.g. "Change Order 4"). */
  suggestedName: string;
}

/**
 * Minimal dialog for adding a new phase under the Change Orders WBS.
 *
 * Each change order typically gets its own phase so progress and costs
 * roll up per CO. The default name is `Change Order N` based on the
 * count of existing change-order phases; users typically replace the
 * default with a meaningful CO label (e.g. "CO-002 — Additional fittings").
 */
export function AddChangeOrderPhaseDialog({
  open,
  onOpenChange,
  wbsId,
  suggestedName,
}: AddChangeOrderPhaseDialogProps) {
  const addPhase = useMutation(api.momentum.addChangeOrderPhase);
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize the input to the suggestion each time the dialog opens
  // (controlled inputs need an effect for default values that depend on props)
  const [lastSeenOpen, setLastSeenOpen] = useState(false);
  if (open && !lastSeenOpen) {
    setDescription(suggestedName);
    setLastSeenOpen(true);
  } else if (!open && lastSeenOpen) {
    setLastSeenOpen(false);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    try {
      await addPhase({ wbsId, description: trimmed });
      toast.success("Change order phase added");
      onOpenChange(false);
      setDescription("");
    } catch (error) {
      toast.error("Failed to add phase", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Change Order Phase</DialogTitle>
            <DialogDescription>
              Each change order typically gets its own phase so progress and cost roll up cleanly.
              Name it for the CO so it's easy to find later.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1 mt-4">
            <Label className="text-xs" htmlFor="co-phase-description">
              Description
            </Label>
            <Input
              id="co-phase-description"
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-9 text-sm"
              placeholder="e.g. CO-002 — Additional fittings"
              required
            />
          </div>

          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting || !description.trim()}>
              {isSubmitting ? "Adding..." : "Add Phase"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
