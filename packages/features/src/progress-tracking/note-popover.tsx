"use client";

import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";
import { Textarea } from "@truss/ui/components/textarea";
import { MessageSquare } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";

/** Props for the inline note popover on entry cells. */
export interface NotePopoverProps {
  activityId: string;
  existingNote?: string;
  onSave?: (activityId: string, notes: string) => void;
  /** Show the icon at low opacity even without hover. */
  showAlways?: boolean;
}

/**
 * Inline note popover for entry cells.
 *
 * WHY extracted: The popover needs internal open/close state to re-sync
 * the draft text from the server value when the popover is closed and
 * the prop changes (e.g. after a Convex reactive update).
 */
export const NotePopover = React.memo(function NotePopover({
  activityId,
  existingNote,
  onSave,
  showAlways,
}: NotePopoverProps) {
  const [note, setNote] = React.useState(existingNote ?? "");
  const [isOpen, setIsOpen] = React.useState(false);
  const hasNote = !!existingNote;

  /* Re-sync draft from server when popover is closed and prop changes */
  React.useEffect(() => {
    if (!isOpen) {
      setNote(existingNote ?? "");
    }
  }, [existingNote, isOpen]);

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && note !== (existingNote ?? "")) {
          onSave?.(activityId, note);
        }
        setIsOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center justify-center h-6 w-6 rounded transition-colors shrink-0",
            hasNote
              ? "text-primary hover:bg-primary/10"
              : showAlways
                ? "text-muted-foreground/30 hover:text-muted-foreground hover:bg-foreground/10"
                : "text-muted-foreground/40 opacity-0 group-hover/row:opacity-100 hover:bg-foreground/10"
          )}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" className="w-64 p-3" align="center">
        <Textarea
          placeholder="Add a note..."
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="text-sm resize-none"
        />
      </PopoverContent>
    </Popover>
  );
});
