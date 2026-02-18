"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { Button } from "@truss/ui/components/button";
import { Calendar } from "@truss/ui/components/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";

export interface DatePickerProps {
  /**
   * Currently selected date.
   */
  date: Date | undefined;
  /**
   * Callback when date is selected.
   */
  onDateChange: (date: Date | undefined) => void;
  /**
   * Placeholder text when no date is selected.
   */
  placeholder?: string;
  /**
   * date-fns format string for displaying the date.
   * @default "PPP"
   */
  formatStr?: string;
  /**
   * Text displayed after the date (e.g., day of week).
   */
  suffix?: string;
  /**
   * Disable dates before this date.
   */
  fromDate?: Date;
  /**
   * Disable dates after this date.
   */
  toDate?: Date;
  /**
   * Additional class name for the trigger button.
   */
  className?: string;
  /**
   * Disable the date picker.
   */
  disabled?: boolean;
  /**
   * Popover alignment relative to the trigger.
   * @default "start"
   */
  align?: "start" | "center" | "end";
}

/**
 * Date picker with calendar dropdown.
 *
 * Provides an accessible date selection interface with:
 * - Calendar popover for visual date selection
 * - Keyboard navigation (Arrow keys, Enter, Escape)
 * - Date range constraints (fromDate, toDate)
 * - Formatted date display
 */
export function DatePicker({
  date,
  onDateChange,
  placeholder = "Pick a date",
  formatStr = "PPP",
  suffix,
  fromDate,
  toDate,
  className,
  disabled = false,
  align = "start",
}: DatePickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className
          )}
          disabled={disabled}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? (
            <span className="flex items-center gap-1.5">
              <span>{format(date, formatStr)}</span>
              {suffix && <span className="text-muted-foreground">{suffix}</span>}
            </span>
          ) : (
            <span>{placeholder}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <Calendar
          mode="single"
          selected={date}
          onSelect={onDateChange}
          disabled={
            disabled
              ? true
              : (date) => {
                  if (fromDate && date < fromDate) return true;
                  if (toDate && date > toDate) return true;
                  return false;
                }
          }
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
