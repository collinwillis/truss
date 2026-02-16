"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { Checkbox } from "@truss/ui/components/checkbox";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Progress } from "@truss/ui/components/progress";
import type { DetailItem, ProgressMetrics } from "./types";

export interface EntryItemCardProps {
  /**
   * Detail item to display.
   */
  item: DetailItem;
  /**
   * Progress metrics for the item on the selected date.
   */
  metrics: ProgressMetrics;
  /**
   * Suggested quantity based on work patterns.
   */
  suggestedQuantity: number | null;
  /**
   * Whether this item is checked for entry.
   */
  checked: boolean;
  /**
   * Current quantity value in the input.
   */
  quantity: string;
  /**
   * Validation result for the current quantity.
   */
  validation: { type: "error" | "warning"; message: string } | null;
  /**
   * Callback when checkbox state changes.
   */
  onCheckedChange: (checked: boolean) => void;
  /**
   * Callback when quantity value changes.
   */
  onQuantityChange: (quantity: string) => void;
  /**
   * Additional class name.
   */
  className?: string;
}

/**
 * Quantity entry card for a single detail item.
 *
 * Displays item information and provides quantity input with:
 * - Checkbox to mark item as worked on
 * - Quantity input with validation
 * - Progress metrics (previous, today, remaining)
 * - Visual progress bar
 * - Warnings and errors
 */
export function EntryItemCard({
  item,
  metrics,
  suggestedQuantity,
  checked,
  quantity,
  validation,
  onCheckedChange,
  onQuantityChange,
  className,
}: EntryItemCardProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus input when checkbox is checked
  React.useEffect(() => {
    if (checked && inputRef.current) {
      inputRef.current.focus();
    }
  }, [checked]);

  const isComplete = metrics.percentComplete >= 100;
  const hasError = validation?.type === "error";
  const hasWarning = validation?.type === "warning";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 transition-all",
        checked && "ring-2 ring-primary ring-offset-2",
        isComplete && "opacity-60",
        className
      )}
    >
      {/* Header: Checkbox + Description */}
      <div className="flex items-start gap-3">
        <Checkbox
          id={`item-${item.id}`}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={isComplete}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <Label
            htmlFor={`item-${item.id}`}
            className={cn(
              "text-base font-medium cursor-pointer",
              isComplete && "line-through text-muted-foreground"
            )}
          >
            {item.description}
          </Label>
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
            <span>
              Estimate: {item.quantity} {item.unit}
            </span>
            <span>Total MH: {item.totalMH.toFixed(1)}</span>
          </div>
        </div>
      </div>

      {/* Quantity Input (shown when checked) */}
      {checked && (
        <div className="mt-4 space-y-3">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor={`quantity-${item.id}`} className="text-sm">
                Quantity Completed
              </Label>
              <div className="relative mt-1.5">
                <Input
                  ref={inputRef}
                  id={`quantity-${item.id}`}
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => onQuantityChange(e.target.value)}
                  placeholder={
                    suggestedQuantity ? `Suggested: ${suggestedQuantity}` : "Enter quantity"
                  }
                  className={cn(
                    "pr-16",
                    hasError && "border-destructive focus-visible:ring-destructive",
                    hasWarning && "border-warning focus-visible:ring-warning"
                  )}
                  aria-invalid={hasError}
                  aria-describedby={validation ? `validation-${item.id}` : undefined}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {item.unit}
                </span>
              </div>
            </div>
          </div>

          {/* Validation Message */}
          {validation && (
            <div
              id={`validation-${item.id}`}
              className={cn(
                "flex items-start gap-2 rounded-md p-3 text-sm",
                validation.type === "error" && "bg-destructive/10 text-destructive",
                validation.type === "warning" && "bg-warning/10 text-warning-foreground"
              )}
              role="alert"
            >
              {validation.type === "error" ? (
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              ) : (
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              )}
              <span>{validation.message}</span>
            </div>
          )}

          {/* Progress Metrics */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium">
                {metrics.newTotal}/{item.quantity} {item.unit} ({metrics.percentComplete}%)
              </span>
            </div>

            <Progress value={metrics.percentComplete} className="h-2" />

            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <div>
                <div className="font-medium">Previous</div>
                <div>
                  {metrics.previousTotal} {item.unit}
                </div>
              </div>
              <div>
                <div className="font-medium">Today</div>
                <div>
                  {metrics.todaysEntry} {item.unit}
                </div>
              </div>
              <div>
                <div className="font-medium">Remaining</div>
                <div>
                  {metrics.remaining} {item.unit}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Completion Badge */}
      {isComplete && !checked && (
        <div className="mt-3 flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
          <CheckCircle2 className="h-4 w-4" />
          <span>Complete ({metrics.percentComplete}%)</span>
        </div>
      )}

      {/* Remaining Badge (not checked, not complete) */}
      {!checked && !isComplete && metrics.remaining > 0 && (
        <div className="mt-3 text-sm text-muted-foreground">
          Remaining: {metrics.remaining} {item.unit} ({metrics.percentComplete}
          %)
        </div>
      )}
    </div>
  );
}
