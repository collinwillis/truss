import { Button } from "@truss/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import type { JSX, ReactNode } from "react";

/** Props for {@link ShareDialog}. */
export interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item's name, quoted in the title. */
  name: string;
  /** The access panel: {@link ItemAccessPanel} with data, or its container. */
  children: ReactNode;
}

/**
 * The Share dialog's shell: a title naming the item, the access panel, and
 * Done. Every change in the panel saves as it is made, so there is nothing to
 * confirm and no Cancel.
 */
export function ShareDialog({ open, onOpenChange, name, children }: ShareDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="min-w-0 px-4 pt-4 pb-3">
          <DialogTitle className="truncate text-callout font-semibold">Share “{name}”</DialogTitle>
          <DialogDescription className="sr-only">
            Add people, or change what they can do here.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, and without it a long name sets the
            column's minimum width, so rows clip instead of truncating. */}
        <div className="min-w-0 border-t p-4">{children}</div>

        <div className="flex items-center justify-end border-t bg-fill-quaternary/30 px-4 py-3">
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
