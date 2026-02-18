"use client";

/**
 * Entry History Panel
 *
 * Slide-out panel showing past daily entries grouped by date.
 * Follows Slack's thread panel / Linear's detail panel patterns.
 */

import * as React from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@truss/ui/components/sheet";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { Input } from "@truss/ui/components/input";
import { Button } from "@truss/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@truss/ui/components/collapsible";
import { ChevronRight, Search, User } from "lucide-react";
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
  /** Whether more entries can be loaded. */
  hasMore?: boolean;
  /** Callback to load more entries. */
  onLoadMore?: () => void;
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

/** Pluralize "entry" / "entries". */
function pluralEntries(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

/**
 * Sheet-based entry history panel.
 *
 * WHY Sheet: Gives users visibility into past daily entries without
 * leaving the workbook. Slides in from the right like Slack's thread panel.
 */
export function EntryHistoryPanel({
  open,
  onOpenChange,
  history,
  onDateSelect,
  hasMore,
  onLoadMore,
}: EntryHistoryPanelProps) {
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filteredHistory = React.useMemo(() => {
    if (!history || !search.trim()) return history;
    const query = search.toLowerCase();

    return history
      .map((day) => ({
        ...day,
        entries: day.entries.filter(
          (e) =>
            e.activityDescription.toLowerCase().includes(query) ||
            e.notes?.toLowerCase().includes(query)
        ),
      }))
      .filter((day) => day.entries.length > 0);
  }, [history, search]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[440px] p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-4 shrink-0">
          <SheetTitle className="text-base font-semibold">Entry History</SheetTitle>
        </SheetHeader>

        {/* Search — pinned above scrollable content */}
        <div className="px-5 pb-3 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
            <Input
              placeholder="Search entries..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        </div>

        <div className="border-t" />

        <ScrollArea className="flex-1 min-h-0">
          <div className="py-1">
            {!filteredHistory || filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-1.5 text-center px-5">
                <p className="text-[13px] font-medium text-muted-foreground">
                  {search ? "No matching entries" : "No entries yet"}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  {search ? "Try a different search term." : "Progress entries will appear here."}
                </p>
              </div>
            ) : (
              <>
                {filteredHistory.map((day) => (
                  <DateGroup key={day.date} day={day} onDateSelect={onDateSelect} />
                ))}

                {hasMore && !search && (
                  <div className="py-3 flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={onLoadMore}
                    >
                      Load more
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** Collapsible group for a single day's entries. */
function DateGroup({ day }: { day: HistoryDay; onDateSelect?: (date: string) => void }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 w-full px-5 py-2 text-left",
            "hover:bg-accent/50 transition-colors"
          )}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-150",
              open && "rotate-90"
            )}
          />
          <span className="text-[13px] font-medium truncate">{formatHistoryDate(day.date)}</span>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0">
            <span className="tabular-nums">{pluralEntries(day.entryCount)}</span>
            <span className="text-muted-foreground/30">&middot;</span>
            <span className="font-mono tabular-nums">{day.totalQuantity} qty</span>
          </span>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-[38px] mr-5 border-l border-border/60 py-0.5 mb-1">
          {day.entries.map((entry, i) => (
            <div
              key={`${entry.activityId}-${i}`}
              className="flex items-start gap-3 pl-3 pr-1 py-1.5 text-[13px]"
            >
              <div className="flex-1 min-w-0">
                <p className="truncate font-medium" title={entry.activityDescription}>
                  {entry.activityDescription}
                </p>
                {entry.notes && (
                  <p className="text-xs text-muted-foreground/70 mt-0.5 italic line-clamp-1">
                    {entry.notes}
                  </p>
                )}
                {entry.enteredBy && (
                  <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground/60">
                    <User className="h-2.5 w-2.5" />
                    <span>{entry.enteredBy}</span>
                  </div>
                )}
              </div>

              <div className="flex items-baseline gap-1 shrink-0 pt-0.5">
                <span className="font-mono text-[13px] font-semibold tabular-nums">
                  {entry.quantityCompleted}
                </span>
                <span className="text-[10px] text-muted-foreground uppercase">{entry.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
