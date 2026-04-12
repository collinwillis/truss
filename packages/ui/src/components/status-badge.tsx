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
  "inline-flex items-center justify-center rounded-full px-1.5 py-px text-footnote font-medium transition-colors",
  {
    variants: {
      variant: {
        success: "bg-mac-green/15 text-mac-green dark:bg-mac-green/20 dark:text-mac-green",
        warning: "bg-mac-orange/15 text-mac-orange dark:bg-mac-orange/20 dark:text-mac-orange",
        danger: "bg-mac-red/15 text-mac-red dark:bg-mac-red/20 dark:text-mac-red",
        info: "bg-mac-blue/15 text-mac-blue dark:bg-mac-blue/20 dark:text-mac-blue",
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
