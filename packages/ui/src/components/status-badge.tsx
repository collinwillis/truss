import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@truss/ui/lib/utils";

/**
 * Status badge variants for progress tracking and status indicators.
 *
 * Visual encoding follows design principles:
 * - Success (green): 80-100% complete
 * - Warning (yellow): 50-79% complete
 * - Danger (orange/red): 0-49% complete
 * - Info (blue): General information
 */
const statusBadgeVariants = cva(
  "inline-flex items-center justify-center rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        success: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
        warning: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
        danger: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
        info: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof statusBadgeVariants> {}

/**
 * Status badge component for displaying progress and status indicators.
 */
function StatusBadge({ className, variant, ...props }: StatusBadgeProps) {
  return <span className={cn(statusBadgeVariants({ variant }), className)} {...props} />;
}

export { StatusBadge, statusBadgeVariants };
