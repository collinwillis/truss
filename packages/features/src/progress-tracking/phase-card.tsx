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

/**
 * Phase item interface matching mock data structure.
 */
export interface PhaseItem {
  id: string;
  wbsId: string;
  code: string;
  description: string;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  status: "not-started" | "in-progress" | "complete";
}

export interface PhaseCardProps {
  /** Phase item data to display */
  item: PhaseItem;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Get status badge variant based on progress percentage.
 *
 * Color encoding matches WBS card for consistency:
 * - Green (success): 80-100% complete
 * - Yellow (warning): 50-79% complete
 * - Orange/Red (danger): 0-49% complete
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
 * Phase card component for displaying phase-level progress.
 *
 * Similar design to WBSCard but represents a sub-division of work.
 * Displays progress metrics in a card format with:
 * - Phase code and description
 * - Progress bar with percentage
 * - Earned vs. total man-hours
 * - Color-coded status badge
 *
 * Note: Wrap this component with a Link to enable navigation.
 */
export function PhaseCard({ item, className }: PhaseCardProps) {
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
