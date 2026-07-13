import { useMutation, useQuery } from "convex/react";
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
import * as React from "react";
import { toast } from "sonner";

interface EditActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The added activity to edit; null closes/clears the form. */
  activityId: string | null;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Edit an added (non-MCP) activity (#26). A focused form for fixing an entry
 * mistake — description, quantity, unit, and the craft/weld man-hour constants —
 * so a mistake no longer means deleting the whole phase and starting over. Raw
 * stored values are fetched (not the qty-multiplied workbook MH) so the fields
 * pre-fill exactly what was saved; man-hours recompute on save because every
 * rollup derives MH on read. Only added activities reach here (guarded
 * server-side).
 */
export function EditActivityDialog({ open, onOpenChange, activityId }: EditActivityDialogProps) {
  const updateActivity = useMutation(api.momentum.updateActivity);
  const activity = useQuery(
    api.momentum.getActivityForEdit,
    open && activityId ? { activityId: activityId as Id<"momentumActivities"> } : "skip"
  );

  const [description, setDescription] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [unit, setUnit] = React.useState("");
  const [craft, setCraft] = React.useState("");
  const [weld, setWeld] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Seed the form once the activity's stored values load.
  React.useEffect(() => {
    if (activity) {
      setDescription(activity.description);
      setQuantity(String(activity.quantity));
      setUnit(activity.unit);
      setCraft(String(round4(activity.craftConstant)));
      setWeld(String(round4(activity.welderConstant)));
      setSubmitting(false);
    }
  }, [activity]);

  const qty = parseFloat(quantity) || 0;
  const totalMH = qty * ((parseFloat(craft) || 0) + (parseFloat(weld) || 0));
  const valid = description.trim().length > 0 && quantity.trim().length > 0 && qty >= 0;
  const loading = open && activityId != null && activity === undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activityId || !valid) return;
    setSubmitting(true);
    try {
      await updateActivity({
        activityId: activityId as Id<"momentumActivities">,
        description: description.trim().toUpperCase(),
        quantity: qty,
        unit: unit.trim() || "EA",
        labor: {
          craftConstant: parseFloat(craft) || 0,
          welderConstant: parseFloat(weld) || 0,
        },
      });
      toast.success("Activity updated");
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to update activity", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] p-0 gap-0">
        <form onSubmit={handleSubmit}>
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="text-base font-semibold">Edit Activity</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Correct an added activity&apos;s basis. Man-hours recompute from the constants.
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 pb-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-9 text-sm"
                disabled={loading}
                required
              />
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Quantity</Label>
                <DecimalInput value={quantity} onChange={setQuantity} disabled={loading} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Unit</Label>
                <Input
                  value={unit}
                  onChange={(e) => setUnit(e.target.value.toUpperCase())}
                  placeholder="EA"
                  className="h-9 text-sm font-mono"
                  disabled={loading}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Craft constant (MH/unit)</Label>
                <DecimalInput value={craft} onChange={setCraft} disabled={loading} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Weld constant (MH/unit)</Label>
                <DecimalInput value={weld} onChange={setWeld} disabled={loading} />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between px-5 py-2.5 border-t bg-fill-quaternary/40">
            <span className="text-xs text-muted-foreground">Estimated man-hours</span>
            <span className="text-sm font-semibold tabular-nums">
              {totalMH.toLocaleString(undefined, { maximumFractionDigits: 2 })} MH
            </span>
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
              disabled={!valid || submitting || loading}
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

/** Decimal-only text input (avoids native number-spinner + locale quirks). */
function DecimalInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Input
      type="text"
      inputMode="decimal"
      pattern="[0-9.]*"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
      placeholder="0"
      disabled={disabled}
      className="h-9 text-sm font-mono tabular-nums"
    />
  );
}
