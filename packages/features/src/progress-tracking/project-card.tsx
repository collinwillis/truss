import * as React from "react";
import { cn } from "@truss/ui/lib/utils";
import { Building2, MapPin, Clock } from "lucide-react";

export interface Project {
  id: string;
  proposalNumber: string;
  jobNumber: string;
  name: string;
  description: string;
  owner: string;
  location: string;
  startDate: string;
  status: "active" | "on-hold" | "completed" | "archived";
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  lastUpdated: string;
}

export interface ProjectCardProps {
  /** Project data to display. */
  project: Project;
  /** Additional CSS classes. */
  className?: string;
}

/** Left accent color by status — linear/jira-style visual anchor. */
function accentColor(status: Project["status"]): string {
  switch (status) {
    case "active":
      return "bg-teal-500";
    case "completed":
      return "bg-blue-500";
    case "on-hold":
      return "bg-amber-500";
    case "archived":
      return "bg-gray-400";
  }
}

/** Status badge styles. */
function statusStyle(status: Project["status"]): string {
  switch (status) {
    case "active":
      return "bg-teal-500/10 text-teal-700 dark:text-teal-400";
    case "completed":
      return "bg-blue-500/10 text-blue-700 dark:text-blue-400";
    case "on-hold":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "archived":
      return "bg-muted text-muted-foreground";
  }
}

/** Display label for status. */
function statusLabel(status: Project["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "completed":
      return "Complete";
    case "on-hold":
      return "On Hold";
    case "archived":
      return "Archived";
  }
}

/**
 * Progress bar fill color — uses brand teal for normal progress,
 * amber for overrun to signal attention without alarm.
 */
function progressBarColor(pct: number): string {
  if (pct > 100) return "bg-amber-500";
  if (pct >= 75) return "bg-teal-500";
  if (pct >= 50) return "bg-teal-500";
  if (pct > 0) return "bg-teal-500/70";
  return "bg-muted-foreground/20";
}

/** Progress percentage text color. */
function progressTextColor(pct: number): string {
  if (pct > 100) return "text-amber-600 dark:text-amber-400";
  return "text-foreground";
}

/** Relative time formatter. */
function formatRelativeTime(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact number formatter for MH display. */
function formatMH(value: number): string {
  if (value >= 10000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Project card for the projects list.
 *
 * WHY left accent border: Provides instant visual status at a glance without
 * reading text — same pattern as Jira, Linear, and Monday.com. The accent color
 * creates a scannable visual rhythm when viewing a list of projects.
 *
 * WHY overrun treatment: In construction, earned MH exceeding total MH is a
 * genuine overrun scenario. We display it clearly with amber coloring rather than
 * capping the bar at 100% and hiding the reality.
 */
export function ProjectCard({ project, className }: ProjectCardProps) {
  const isOverrun = project.percentComplete > 100;
  const displayPct = Math.min(project.percentComplete, 100);

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-card overflow-hidden",
        "transition-all duration-150 ease-out",
        "hover:shadow-md hover:border-primary/20 hover:-translate-y-0.5",
        "h-full flex flex-col",
        className
      )}
    >
      {/* Status accent — left border strip */}
      <div className={cn("absolute left-0 top-0 bottom-0 w-[3px]", accentColor(project.status))} />

      <div className="flex flex-col flex-1 pl-4 pr-4 pt-3.5 pb-3.5 space-y-3">
        {/* Row 1: Project name + status badge */}
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[13px] font-semibold leading-snug line-clamp-2 text-foreground">
              {project.name}
            </h3>
            <span
              className={cn(
                "inline-flex items-center shrink-0 rounded-full px-2 py-0.5",
                "text-[10px] font-semibold tracking-wide uppercase",
                statusStyle(project.status)
              )}
            >
              {statusLabel(project.status)}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground font-mono tabular-nums">
            {project.jobNumber || project.proposalNumber}
          </p>
        </div>

        {/* Row 2: Progress bar */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Progress</span>
            <div className="flex items-baseline gap-1">
              <span
                className={cn(
                  "text-sm font-bold tabular-nums leading-none",
                  progressTextColor(project.percentComplete)
                )}
              >
                {project.percentComplete}%
              </span>
            </div>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                progressBarColor(project.percentComplete)
              )}
              style={{ width: `${displayPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/70">
            <span className="tabular-nums">
              {formatMH(project.earnedMH)} / {formatMH(project.totalMH)} MH
            </span>
            {isOverrun && (
              <span className="text-amber-600 dark:text-amber-400 font-medium">Overrun</span>
            )}
          </div>
        </div>

        {/* Spacer to push metadata to bottom */}
        <div className="flex-1" />

        {/* Row 3: Metadata footer */}
        <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-border/50">
          <div className="flex items-center gap-3 min-w-0 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1 min-w-0">
              <Building2 className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <span className="truncate max-w-[100px]">{project.owner}</span>
            </div>
            <div className="flex items-center gap-1 min-w-0">
              <MapPin className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <span className="truncate max-w-[100px]">{project.location}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50 shrink-0">
            <Clock className="h-2.5 w-2.5" />
            <span>{formatRelativeTime(project.lastUpdated)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
