import { useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Button } from "@truss/ui/components/button";
import * as React from "react";
import { toast } from "sonner";

/** The added phase being edited; code + description come from the workbook. */
export interface EditPhaseTarget {
  phaseId: string;
  phaseCode: string;
  description: string;
}

interface EditPhaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: EditPhaseTarget | null;
}

/**
 * Edit an added (non-MCP) phase's code + description (#26). Estimate phases are
 * read-only and never reach this dialog (guarded server-side). Code + name are
 * uppercased on save for consistency with the MCP-sourced data (#35).
 */
export function EditPhaseDialog({ open, onOpenChange, phase }: EditPhaseDialogProps) {
  const updatePhase = useMutation(api.momentum.updatePhase);
  const [code, setCode] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open && phase) {
      setCode(phase.phaseCode);
      setDescription(phase.description);
      setSubmitting(false);
    }
  }, [open, phase]);

  const valid = description.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phase || !valid) return;
    setSubmitting(true);
    try {
      await updatePhase({
        phaseId: phase.phaseId as Id<"momentumPhases">,
        phaseCode: code.trim(),
        description: description.trim(),
      });
      toast.success("Phase updated");
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to update phase", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px] p-0 gap-0" aria-describedby={undefined}>
        <form onSubmit={handleSubmit}>
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="text-base font-semibold">Edit Phase</DialogTitle>
          </DialogHeader>

          <div className="px-5 pb-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Phase code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. 20020"
                className="h-9 text-sm font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Phase description"
                className="h-9 text-sm"
                required
              />
            </div>
          </div>

          <DialogFooter className="px-5 py-3 border-t bg-muted/30 sm:gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={!valid || submitting}
              className="min-w-[110px]"
            >
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
