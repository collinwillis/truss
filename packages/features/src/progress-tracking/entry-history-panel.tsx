"use client";

import * as React from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@truss/ui/components/sheet";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@truss/ui/components/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@truss/ui/components/collapsible";
import { ChevronRight, MessageSquare, User } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import type { HistoryDay } from "./types";

export interface EntryHistoryPanelProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Callback when open state changes. */
  onOpenChange: (open: boolean) => void;
  /** Grouped history data from getEntryHistory query. */
  history: HistoryDay[] | null | undefined;
  /** Callback when a date is selected in the history panel. */
  onDateSelect?: (date: string) => void;
}

/** Format "YYYY-MM-DD" to a readable date. */
function formatHistoryDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Sheet-based entry history panel.
 *
 * WHY: Gives users visibility into past daily entries without leaving
 * the workbook. Slides in from the right like a detail panel.
 */
export function EntryHistoryPanel({
  open,
  onOpenChange,
  history,
  onDateSelect,
}: EntryHistoryPanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[440px] p-0 flex flex-col">
        <SheetHeader className="px-5 py-4 border-b shrink-0">
          <SheetTitle className="text-base font-semibold">Entry History</SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-3 space-y-1">
            {!history || history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
                <p className="text-sm font-medium text-muted-foreground">No entries yet</p>
                <p className="text-xs text-muted-foreground/60">
                  Progress entries will appear here
                </p>
              </div>
            ) : (
              history.map((day) => (
                <DateGroup key={day.date} day={day} onDateSelect={onDateSelect} />
              ))
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** Collapsible group for a single day's entries. */
function DateGroup({
  day,
  onDateSelect,
}: {
  day: HistoryDay;
  onDateSelect?: (date: string) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 w-full rounded-md px-2 py-2 hover:bg-accent/50 transition-colors group">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200",
              open && "rotate-90"
            )}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDateSelect?.(day.date);
            }}
            className="text-sm font-medium hover:text-primary transition-colors"
          >
            {formatHistoryDate(day.date)}
          </button>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{day.entryCount} entries</span>
            <span className="text-border">&middot;</span>
            <span className="font-mono tabular-nums">{day.totalQuantity} qty</span>
          </span>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-6 border-l pl-3 py-1 space-y-0.5">
          {day.entries.map((entry, i) => (
            <div
              key={`${entry.activityId}-${i}`}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" title={entry.activityDescription}>
                  {entry.activityDescription}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  {entry.enteredBy && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <User className="h-3 w-3" />
                      {entry.enteredBy}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {entry.notes && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-[200px]">
                        <p className="text-xs">{entry.notes}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <span className="font-mono text-sm font-medium tabular-nums text-right min-w-[40px]">
                  {entry.quantityCompleted}
                </span>
                <span className="text-[11px] text-muted-foreground uppercase w-5">
                  {entry.unit}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
