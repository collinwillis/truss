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

interface AddPhaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wbsId: Id<"momentumWbs">;
  /** Display code of the parent WBS (e.g. "300000", "70000"). */
  wbsCode: string;
  /** Whether the parent WBS is the Change Orders WBS — adjusts copy/defaults. */
  isChangeOrder: boolean;
  /** Pre-filled phase code (e.g. "300000-002"); blank for non-CO WBS. Editable. */
  suggestedPhaseCode: string;
  /** Pre-filled description (e.g. "Change Order 2"); editable. */
  suggestedDescription: string;
}

/**
 * Dialog for adding a phase under any WBS.
 *
 * The phase code is pre-filled with a smart suggestion for the Change Orders
 * WBS (the next `300000-NNN`) and left blank but hinted for estimate WBS, and
 * stays fully editable in both cases — so a user can enter "300000-001" for a
 * change order or a code like "20020" in an estimate WBS's numbering band.
 */
export function AddPhaseDialog({
  open,
  onOpenChange,
  wbsId,
  wbsCode,
  isChangeOrder,
  suggestedPhaseCode,
  suggestedDescription,
}: AddPhaseDialogProps) {
  const addPhase = useMutation(api.momentum.addPhase);
  const [phaseCode, setPhaseCode] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Seed the inputs from the suggestions each time the dialog opens
  // (controlled inputs need an effect for prop-derived defaults).
  const [lastSeenOpen, setLastSeenOpen] = useState(false);
  if (open && !lastSeenOpen) {
    setPhaseCode(suggestedPhaseCode);
    setDescription(suggestedDescription);
    setLastSeenOpen(true);
  } else if (!open && lastSeenOpen) {
    setLastSeenOpen(false);
  }

  // In-band example for the estimate-WBS hint (e.g. WBS 20000 → "20020").
  const numericWbs = Number(wbsCode);
  const codeExample = isChangeOrder
    ? `${wbsCode}-001`
    : Number.isFinite(numericWbs)
      ? String(numericWbs + 20)
      : "20020";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = phaseCode.trim();
    const desc = description.trim();
    if (!code || !desc) return;

    setIsSubmitting(true);
    try {
      await addPhase({ wbsId, phaseCode: code, description: desc });
      toast.success("Phase added");
      onOpenChange(false);
      setPhaseCode("");
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
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isChangeOrder ? "Add Change Order Phase" : "Add Phase"}</DialogTitle>
            <DialogDescription>
              {isChangeOrder
                ? "Each change order typically gets its own phase so progress and cost roll up cleanly. Give it a phase code and a description."
                : `Add a phase under WBS ${wbsCode}. Give it a phase code and description, then use Add Activity to assign activities and man-hours.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="phase-code">
                Phase Code
              </Label>
              <Input
                id="phase-code"
                autoFocus
                value={phaseCode}
                onChange={(e) => setPhaseCode(e.target.value)}
                className="h-9 text-sm"
                placeholder={`e.g. ${codeExample}`}
                required
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="phase-description">
                Description
              </Label>
              <Input
                id="phase-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-9 text-sm"
                placeholder={isChangeOrder ? "e.g. Additional fittings" : "e.g. Field rework"}
                required
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={isSubmitting || !phaseCode.trim() || !description.trim()}
            >
              {isSubmitting ? "Adding..." : "Add Phase"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
