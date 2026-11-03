"use client";

/**
 * Move Day Dialog
 *
 * Moves logged numbers from one day to another: the fix for "I logged that on
 * the wrong day". Momentum's logs are mostly typed from paper days after the
 * work, so a number under the wrong date is a common, honest mistake.
 *
 * The dialog previews the one thing that can surprise someone: when the other
 * day already has a number for a line, the two are added together.
 */

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";
import { Calendar } from "@truss/ui/components/calendar";
import { Checkbox } from "@truss/ui/components/checkbox";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";

/** One logged number that can be moved. */
export interface MoveDayLine {
  /** The workbook row the number belongs to: the split's id, else the activity's. */
  rowKey: string;
  description: string;
  phaseCode: string;
  unit: string;
  quantity: number;
}

/** Props for the dialog that moves a day's (or one row's) logged numbers to another day. */
export interface MoveDayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The day the numbers are on now, "YYYY-MM-DD". */
  fromDate: string;
  /** What can move. A single line hides the checkboxes: a row's own "Move to Another Day…". */
  lines: MoveDayLine[];
  /** The day picked to move to, held by the app so it can load that day's numbers. */
  toDate: string | null;
  onToDateChange: (date: string | null) => void;
  /** Numbers already on the picked day, by row key; undefined while they load. */
  targetQuantities: Record<string, number> | undefined;
  /** Days of the week that are not work days on this job (0 = Sunday). */
  nonWorkDays: number[];
  /** Performs the move. If it throws, the dialog stays open with the choices intact. */
  onMove: (rowKeys: string[]) => Promise<void>;
}

/** "YYYY-MM-DD" as a local-midnight Date, which is what the calendar works in. */
function toLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** A local calendar day as "YYYY-MM-DD". */
function toDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
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

/** "Nov 2". */
function formatShortDay(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The Sunday that ends a day's reporting week.
 *
 * Matches the backend's `getWeekEndingSunday`, which the weekly report and the
 * Excel export group by: InDemand's weeks run Monday to Sunday.
 */
function weekEndingSunday(dateStr: string): string {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? 0 : 7 - day));
  return date.toISOString().slice(0, 10);
}

/** Quantity without float noise. */
function formatQty(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Dialog for moving one line, or any lines of a day, to another day.
 *
 * WHY THE PREVIEW: a move never changes a total, but a line already logged on
 * the other day ends up with the two numbers added. Each such line says what
 * it adds to, so nobody finds a 140 they didn't type.
 */
export function MoveDayDialog({
  open,
  onOpenChange,
  fromDate,
  lines,
  toDate,
  onToDateChange,
  targetQuantities,
  nonWorkDays,
  onMove,
}: MoveDayDialogProps) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(lines.map((line) => line.rowKey))
  );
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const [moving, setMoving] = React.useState(false);

  // Reset on each opening during render, not in an effect, so the dialog never
  // shows the last move's choices for a frame.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSelected(new Set(lines.map((line) => line.rowKey)));
      setMoving(false);
    }
  }

  const single = lines.length === 1;
  const chosen = lines.filter((line) => selected.has(line.rowKey));
  const sameDay = toDate === fromDate;
  const combining =
    toDate && targetQuantities ? chosen.filter((l) => targetQuantities[l.rowKey]) : [];
  const canMove = !!toDate && !sameDay && !!targetQuantities && chosen.length > 0 && !moving;

  const handleMove = async () => {
    if (!canMove) return;
    setMoving(true);
    try {
      await onMove(chosen.map((line) => line.rowKey));
    } catch {
      // The app has said why; leave the choices as they were so a retry is one click.
    } finally {
      setMoving(false);
    }
  };

  const today = new Date();
  const from = toLocalDate(fromDate);

  const notes: string[] = [];
  if (toDate && !sameDay) {
    // One line already says what it adds to on its own row.
    if (!single && combining.length > 0) {
      const count =
        combining.length === 1 ? "1 of these lines" : `${combining.length} of these lines`;
      notes.push(`${formatDay(toDate)} already has ${count}. Their numbers are added together.`);
    }
    const fromWeek = weekEndingSunday(fromDate);
    const toWeek = weekEndingSunday(toDate);
    if (fromWeek !== toWeek) {
      notes.push(
        `This moves progress from the week ending ${formatShortDay(fromWeek)} to the week ending ${formatShortDay(toWeek)}.`
      );
    }
    if (nonWorkDays.includes(toLocalDate(toDate).getDay())) {
      notes.push(`${formatDay(toDate)} isn't a work day on this job's calendar.`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-md"
        showCloseButton={false}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canMove) {
            e.preventDefault();
            void handleMove();
          }
        }}
      >
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="text-callout font-semibold">Move to Another Day</DialogTitle>
          <DialogDescription className="text-subheadline truncate">
            From {formatDay(fromDate)}
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, and without it a long description sets
            the column's minimum width, so it is clipped instead of truncated. */}
        <div className="min-w-0 space-y-3 border-t p-4">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start gap-2 font-normal",
                  !toDate && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="size-4" />
                {toDate ? formatDay(toDate) : "Pick the day it belongs on"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={toDate ? toLocalDate(toDate) : undefined}
                defaultMonth={toDate ? toLocalDate(toDate) : from}
                onSelect={(date) => {
                  onToDateChange(date ? toDateString(date) : null);
                  if (date) setCalendarOpen(false);
                }}
                disabled={(date) => date > today || toDateString(date) === fromDate}
                modifiers={{
                  nonWorkDay: (date: Date) => nonWorkDays.includes(date.getDay()),
                }}
                modifiersClassNames={{ nonWorkDay: "opacity-40" }}
                autoFocus
              />
            </PopoverContent>
          </Popover>

          {single ? (
            lines[0] && (
              <LineRow line={lines[0]} toDate={toDate} targetQuantities={targetQuantities} />
            )
          ) : (
            <div className="rounded-lg border">
              <div className="flex items-center justify-between border-b px-3 py-1.5 text-subheadline">
                <span className="text-muted-foreground tabular-nums">
                  {chosen.length} of {lines.length} selected
                </span>
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() =>
                    setSelected(
                      chosen.length === lines.length
                        ? new Set()
                        : new Set(lines.map((line) => line.rowKey))
                    )
                  }
                >
                  {chosen.length === lines.length ? "Select None" : "Select All"}
                </button>
              </div>
              {/* The cap goes on Radix's viewport: on the root it never makes the list scroll. */}
              <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-64" blockContent>
                <div className="py-1">
                  {lines.map((line) => (
                    <label
                      key={line.rowKey}
                      className="flex cursor-pointer items-start gap-2.5 px-3 py-1.5 hover:bg-fill-quaternary"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(line.rowKey)}
                        onCheckedChange={(checked) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (checked === true) next.add(line.rowKey);
                            else next.delete(line.rowKey);
                            return next;
                          })
                        }
                      />
                      <LineRow
                        line={line}
                        toDate={toDate}
                        targetQuantities={targetQuantities}
                        bare
                      />
                    </label>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {notes.length > 0 && (
            <div className="space-y-1 rounded-lg bg-fill-quaternary/60 px-3 py-2 text-subheadline text-muted-foreground">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-fill-quaternary/30 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canMove} onClick={() => void handleMove()}>
            {moving ? "Moving…" : toDate && !sameDay ? `Move to ${formatDay(toDate)}` : "Move"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A line's description and number, plus what it adds to on the other day.
 *
 * `bare` drops the card chrome when the row sits inside the checklist.
 */
function LineRow({
  line,
  toDate,
  targetQuantities,
  bare = false,
}: {
  line: MoveDayLine;
  toDate: string | null;
  targetQuantities: Record<string, number> | undefined;
  bare?: boolean;
}) {
  const already = toDate ? targetQuantities?.[line.rowKey] : undefined;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-start justify-between gap-3",
        !bare && "rounded-lg border px-3 py-2"
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-body" title={line.description}>
          {line.description}
        </p>
        <p className="text-subheadline text-foreground-subtle">
          {already
            ? `Adds to the ${formatQty(already)} ${line.unit} already there, making ${formatQty(already + line.quantity)}`
            : line.phaseCode
              ? `Phase ${line.phaseCode}`
              : null}
        </p>
      </div>
      <span className="shrink-0 font-mono text-body tabular-nums">
        {formatQty(line.quantity)} <span className="text-muted-foreground">{line.unit}</span>
      </span>
    </div>
  );
}
