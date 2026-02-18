"use client";

import * as React from "react";
import { Input } from "@truss/ui/components/input";
import { Check, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { NotePopover } from "./note-popover";

/** Idle time before auto-saving while the user is still in the cell. */
const DEBOUNCE_MS = 800;

/** Props for a single entry cell input. */
export interface EntryCellInputProps {
  activityId: string;
  /** Server-side existing value for this cell. */
  existingValue: number | undefined;
  /** Maximum quantity remaining + existing (upper clamp bound). */
  maxAllowed: number;
  /** Per-cell save status indicator. */
  saveState: "saving" | "saved" | "error" | undefined;
  /** Existing note for this activity. */
  existingNote: string | undefined;
  /** Called to commit the current value (both debounced and on blur). */
  onCommit: (activityId: string, value: string) => void;
  /** Called on Escape to discard the edit. */
  onDiscard: (activityId: string) => void;
  /** Called when a note is saved. */
  onNoteSave: (activityId: string, notes: string) => void;
  /** Whether to show the note icon always (not just on hover). */
  showNoteAlways: boolean;
  /** Keyboard navigation handler. */
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, activityId: string) => void;
}

/**
 * Isolated entry cell with local edit state and debounced auto-save.
 *
 * WHY: Each cell manages its own local value. While the user is typing,
 * parent re-renders (from Convex reactive queries) do NOT disturb focus
 * because React.memo prevents re-render when props haven't changed,
 * and local state takes precedence over server value during editing.
 *
 * Auto-saves after 800ms of idle typing so progress bars and summaries
 * update without the user needing to leave the cell. On blur, any
 * pending debounce is cancelled and the value is committed immediately.
 */
export const EntryCellInput = React.memo(function EntryCellInput({
  activityId,
  existingValue,
  maxAllowed,
  saveState,
  existingNote,
  onCommit,
  onDiscard,
  onNoteSave,
  showNoteAlways,
  onKeyDown,
}: EntryCellInputProps) {
  /** undefined = not editing (show server value), string = actively editing */
  const [localValue, setLocalValue] = React.useState<string | undefined>(undefined);
  const escapeRef = React.useRef(false);
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * Ref for onCommit so the debounce timer closure never goes stale.
   * The stable callback from the parent doesn't change identity, but
   * using a ref is defensive against any future refactors.
   */
  const onCommitRef = React.useRef(onCommit);
  onCommitRef.current = onCommit;

  /* Cleanup debounce timer on unmount */
  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const hasExisting = existingValue !== undefined && existingValue > 0;
  const isEditing = localValue !== undefined;

  const displayValue =
    localValue !== undefined ? localValue : hasExisting ? String(existingValue) : "";

  const typedNum = parseFloat(displayValue);
  const isOverMax = !isNaN(typedNum) && typedNum > maxAllowed && maxAllowed > 0;

  return (
    <div className="flex items-center justify-end gap-1">
      {/* Save state indicator */}
      <span className="w-4 flex items-center justify-center shrink-0">
        {saveState === "saving" && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
        {saveState === "saved" && <Check className="h-3 w-3 text-green-500" />}
        {saveState === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
      </span>
      <NotePopover
        activityId={activityId}
        existingNote={existingNote}
        onSave={onNoteSave}
        showAlways={showNoteAlways}
      />
      <Input
        type="number"
        min="0"
        max={maxAllowed}
        step="any"
        data-entry-cell={activityId}
        value={displayValue}
        onFocus={() => {
          /* Enter edit mode: snapshot current display value as local state */
          if (localValue === undefined) {
            setLocalValue(hasExisting ? String(existingValue) : "");
          }
        }}
        onChange={(e) => {
          const newValue = e.target.value;
          setLocalValue(newValue);

          /* Schedule debounced auto-save */
          if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(() => {
            debounceTimerRef.current = null;
            onCommitRef.current(activityId, newValue);
          }, DEBOUNCE_MS);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            escapeRef.current = true;
            (e.target as HTMLInputElement).blur();
            return;
          }
          onKeyDown(e, activityId);
        }}
        onBlur={() => {
          /* Cancel any pending debounce — we're committing now */
          if (debounceTimerRef.current !== null) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }

          if (escapeRef.current) {
            escapeRef.current = false;
            setLocalValue(undefined);
            onDiscard(activityId);
            return;
          }
          const committed = localValue;
          setLocalValue(undefined);
          if (committed !== undefined) {
            onCommit(activityId, committed);
          }
        }}
        className={cn(
          "h-8 w-[88px] text-right font-mono text-sm tabular-nums",
          "border-primary/20 bg-primary/[0.02]",
          "focus-visible:ring-primary/40 focus-visible:border-primary/40",
          "placeholder:text-muted-foreground/40",
          "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
          isEditing && "ring-2 ring-primary/25 border-primary bg-primary/[0.06]",
          hasExisting && !isEditing && "text-foreground",
          isOverMax && "ring-2 ring-destructive/30 border-destructive"
        )}
        placeholder={"\u2014"}
      />
    </div>
  );
});
