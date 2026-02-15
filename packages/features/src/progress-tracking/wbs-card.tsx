import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@truss/ui/components/card";
import { Progress } from "@truss/ui/components/progress";
import { StatusBadge } from "@truss/ui/components/status-badge";
import { cn } from "@truss/ui/lib/utils";
import type { WBSItem } from "./types";

export interface WBSCardProps {
  /** WBS item data to display */
  item: WBSItem;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Get status badge variant based on progress percentage.
 *
 * Color encoding:
 * - 🟢 Green (success): 80-100% complete
 * - 🟡 Yellow (warning): 50-79% complete
 * - 🟠 Orange (danger): 20-49% complete
 * - 🔴 Red (danger): 0-19% complete
 */
function getStatusVariant(percentComplete: number): "success" | "warning" | "danger" {
  if (percentComplete >= 80) return "success";
  if (percentComplete >= 50) return "warning";
  return "danger";
}

/**
 * Get status label text.
 */
function getStatusLabel(percentComplete: number): string {
  if (percentComplete === 100) return "Complete";
  if (percentComplete >= 80) return "Near Complete";
  if (percentComplete >= 50) return "In Progress";
  if (percentComplete >= 20) return "Behind Schedule";
  if (percentComplete > 0) return "Started";
  return "Not Started";
}

/**
 * WBS card component for displaying work breakdown structure progress.
 *
 * Displays high-level progress metrics in a card format with:
 * - WBS code and description
 * - Progress bar with percentage
 * - Earned vs. total man-hours
 * - Color-coded status badge
 *
 * Note: Wrap this component with a Link to enable navigation.
 */
export function WBSCard({ item, className }: WBSCardProps) {
  const statusVariant = getStatusVariant(item.percentComplete);
  const statusLabel = getStatusLabel(item.percentComplete);

  return (
    <Card
      className={cn("transition-all hover:shadow-md hover:border-primary/50 h-full", className)}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">{item.code}</CardTitle>
            <CardDescription className="mt-1 text-base font-semibold text-foreground line-clamp-2">
              {item.description}
            </CardDescription>
          </div>
          <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium">{item.percentComplete}%</span>
          </div>
          <Progress value={item.percentComplete} className="h-2" />
        </div>

        {/* Man-Hours Stats */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Man-Hours</span>
          <span className="font-mono font-medium">
            {item.earnedMH.toFixed(1)} / {item.totalMH.toFixed(1)} MH
          </span>
        </div>

        {/* Remaining Man-Hours */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Remaining</span>
          <span className="font-mono">{(item.totalMH - item.earnedMH).toFixed(1)} MH</span>
        </div>
      </CardContent>
    </Card>
  );
}
