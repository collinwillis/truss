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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { useState } from "react";
import { toast } from "sonner";

type CoStatus = "submitted" | "approved" | "rejected" | "void" | "disputed" | "pricing";
type CoType = "lump_sum" | "tm";

const CO_STATUS_OPTIONS: { value: CoStatus; label: string }[] = [
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "pricing", label: "Pricing" },
  { value: "disputed", label: "Disputed" },
  { value: "rejected", label: "Rejected" },
  { value: "void", label: "Void" },
];

export interface ChangeOrderDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phaseId: Id<"momentumPhases"> | null;
  phaseCode: string;
  description: string;
  status: string;
  type: string;
}

/**
 * Edit an existing Change Order's status, type, and description (#30).
 * Approving a CO makes its man-hours count in every total; moving it off
 * "approved" removes them again — both reactively.
 */
export function ChangeOrderDetailsDialog({
  open,
  onOpenChange,
  phaseId,
  phaseCode,
  description,
  status,
  type,
}: ChangeOrderDetailsDialogProps) {
  const update = useMutation(api.momentum.updateChangeOrderPhase);

  const [desc, setDesc] = useState(description);
  const [coStatus, setCoStatus] = useState<string>(status || "submitted");
  const [coType, setCoType] = useState<string>(type || "none");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Re-seed from props each time the dialog opens for a new CO.
  const [lastSeenOpen, setLastSeenOpen] = useState(false);
  if (open && !lastSeenOpen) {
    setDesc(description);
    setCoStatus(status || "submitted");
    setCoType(type || "none");
    setLastSeenOpen(true);
  } else if (!open && lastSeenOpen) {
    setLastSeenOpen(false);
  }

  const handleSave = async () => {
    if (!phaseId) return;
    setIsSubmitting(true);
    try {
      await update({
        phaseId,
        changeOrderStatus: coStatus as CoStatus,
        ...(coType !== "none" ? { changeOrderType: coType as CoType } : {}),
        description: desc.trim() || description,
      });
      toast.success("Change order updated");
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to update change order", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Change Order {phaseCode}</DialogTitle>
          <DialogDescription>
            Set the status and type. Hours only roll into project totals once the status is
            Approved.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="co-description">
              Description
            </Label>
            <Input
              id="co-description"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select value={coStatus} onValueChange={setCoStatus}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CO_STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select value={coType} onValueChange={setCoType}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">&mdash;</SelectItem>
                  <SelectItem value="lump_sum">Lump Sum</SelectItem>
                  <SelectItem value="tm">T&amp;M</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {coStatus !== "approved" && (
            <p className="text-footnote text-muted-foreground">
              This change order&apos;s man-hours are not counted toward project totals while
              it&apos;s {CO_STATUS_OPTIONS.find((o) => o.value === coStatus)?.label ?? coStatus}.
            </p>
          )}
        </div>

        <DialogFooter className="mt-6">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" disabled={isSubmitting || !phaseId} onClick={handleSave}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
