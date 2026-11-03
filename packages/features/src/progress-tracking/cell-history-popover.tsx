"use client";

/**
 * Cell History Popover
 *
 * One line's number on one day, and every change made to it: who typed what,
 * when, and what it was before. Opened from a row's right-click "Show History",
 * beside the point that was clicked.
 *
 * WHY: a corrected number used to overwrite the old one with no trace, so
 * "who changed this, and from what?" had no answer, and a number moved to
 * another day simply vanished from the one it was on.
 */

import * as React from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@truss/ui/components/popover";
import { cn } from "@truss/ui/lib/utils";

/** One recorded change, as `getCellHistory` returns it. */
export interface CellHistoryChange {
  kind: "edit" | "move_out" | "move_in" | "undo";
  before?: number;
  after?: number;
  /** The other day of a move or its undo, "YYYY-MM-DD". */
  otherDate?: string;
  byName?: string;
  /** When the change was made, in ms since the epoch. */
  at: number;
}

/** A line's number on a day and its changes, newest first. */
export interface CellHistory {
  unit: string;
  current: {
    quantity: number;
    notes?: string;
    /** Whoever saved the number last. */
    enteredBy?: string;
    /** When the row was first saved, in ms since the epoch. */
    loggedAt: number;
  } | null;
  changes: CellHistoryChange[];
}

/** Props for the popover showing one line's changes on the selected day. */
export interface CellHistoryPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The viewport point to open beside: where the row was right-clicked. */
  anchor: { x: number; y: number } | null;
  description: string;
  /** The day shown, "YYYY-MM-DD". */
  date: string;
  /** Undefined while loading; null when the line is not one the user can see. */
  history: CellHistory | null | undefined;
}

/** "Tue, Oct 28". Read at noon UTC so no US time zone shifts the day. */
function formatDay(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Oct 29, 3:14 PM", in the user's own time zone. */
function formatMoment(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Quantity without float noise. */
function formatQty(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A change in plain words. */
function describeChange(change: CellHistoryChange, unit: string): string {
  const qty = (value: number | undefined) => `${formatQty(value ?? 0)} ${unit}`.trim();
  const other = change.otherDate ? formatDay(change.otherDate) : "another day";
  switch (change.kind) {
    case "edit":
      if (change.before === undefined) return `Logged ${qty(change.after)}`;
      if (change.after === undefined) return `Cleared ${qty(change.before)}`;
      return `Changed ${formatQty(change.before)} → ${qty(change.after)}`;
    case "move_out":
      return `Moved ${qty(change.before)} to ${other}`;
    case "move_in":
      if (change.before === undefined) return `Moved ${qty(change.after)} here from ${other}`;
      return `Added ${qty((change.after ?? 0) - change.before)} from ${other}, making ${qty(change.after)}`;
    case "undo":
      // The undo is recorded on both days; `before` is set on the day it left.
      if (change.before === undefined) {
        return `Move undone: ${qty(change.after)} came back from ${other}`;
      }
      return `Move undone: ${qty(change.before - (change.after ?? 0))} went back to ${other}`;
  }
}

/**
 * Popover anchored at a viewport point.
 *
 * WHY A POINT: the row menu is a native Tauri menu, so there is no DOM trigger
 * to anchor to; opening where the click was keeps the answer next to the row.
 */
export function CellHistoryPopover({
  open,
  onOpenChange,
  anchor,
  description,
  date,
  history,
}: CellHistoryPopoverProps) {
  const unit = history?.unit ?? "";
  const changes = history?.changes ?? [];
  const current = history?.current ?? null;

  return (
    <Popover open={open && anchor !== null} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-80 p-0"
        side="bottom"
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-3 pt-3 pb-2.5">
          <p className="truncate text-body font-medium" title={description}>
            {description}
          </p>
          <p className="text-subheadline text-muted-foreground">{formatDay(date)}</p>
          {history !== undefined && history !== null && (
            <>
              <p
                className={cn(
                  "mt-2 font-mono text-title3 tabular-nums",
                  !current && "text-muted-foreground"
                )}
              >
                {current ? (
                  <>
                    {formatQty(current.quantity)}{" "}
                    <span className="text-body text-muted-foreground">{unit}</span>
                  </>
                ) : (
                  <span className="font-sans text-body">Nothing logged</span>
                )}
              </p>
              {current?.notes && (
                <p className="mt-1 line-clamp-3 text-subheadline italic text-foreground-subtle">
                  {current.notes}
                </p>
              )}
            </>
          )}
        </div>

        <div className="border-t px-3 py-2">
          {history === undefined ? (
            <p className="py-1 text-subheadline text-muted-foreground">Loading…</p>
          ) : history === null ? (
            <p className="py-1 text-subheadline text-muted-foreground">
              This line isn&apos;t in your part of the job.
            </p>
          ) : changes.length === 0 ? (
            current ? (
              // Rows saved before changes were kept have none. Their author field
              // holds whoever saved last, so it is never shown as who logged it.
              <ol>
                <li className="list-none py-1">
                  <p className="text-subheadline text-foreground">
                    Logged before changes were recorded
                  </p>
                  <p className="text-footnote text-muted-foreground">
                    {formatMoment(current.loggedAt)}
                    {current.enteredBy ? ` · last saved by ${current.enteredBy}` : ""}
                  </p>
                </li>
              </ol>
            ) : (
              <p className="py-1 text-subheadline text-muted-foreground">
                Nothing has been logged on this day.
              </p>
            )
          ) : (
            <ol className="max-h-64 overflow-y-auto">
              {changes.map((change, i) => (
                <HistoryItem
                  key={`${change.at}-${i}`}
                  text={describeChange(change, unit)}
                  byName={change.byName}
                  at={change.at}
                />
              ))}
            </ol>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One line of the history: what happened, then who and when. */
function HistoryItem({ text, byName, at }: { text: string; byName?: string; at: number }) {
  return (
    <li className="list-none py-1">
      <p className="text-subheadline text-foreground">{text}</p>
      <p className="text-footnote text-muted-foreground">
        {byName ?? "Someone"} · {formatMoment(at)}
      </p>
    </li>
  );
}
