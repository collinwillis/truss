import * as React from "react";
import { cn } from "@truss/ui/lib/utils";
import { Building2, MapPin, Clock, Pin } from "lucide-react";

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
  /** Whether this project is pinned by the current user. */
  isPinned?: boolean;
  /** Called when the pin button is clicked. */
  onTogglePin?: (projectId: string) => void;
  /** Additional CSS classes. */
  className?: string;
}

/** Left accent color by status — macOS-style visual anchor. */
function accentColor(status: Project["status"]): string {
  switch (status) {
    case "active":
      return "bg-primary";
    case "completed":
      return "bg-mac-green";
    case "on-hold":
      return "bg-mac-orange";
    case "archived":
      return "bg-mac-gray";
  }
}

/** Status badge styles — macOS system colors. */
function statusStyle(status: Project["status"]): string {
  switch (status) {
    case "active":
      return "bg-primary/12 text-primary";
    case "completed":
      return "bg-mac-green/12 text-mac-green";
    case "on-hold":
      return "bg-mac-orange/12 text-mac-orange";
    case "archived":
      return "bg-fill-tertiary text-muted-foreground";
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

/** Progress bar fill color — macOS system colors for status. */
function progressBarColor(pct: number): string {
  if (pct > 100) return "bg-mac-orange";
  if (pct >= 100) return "bg-mac-green";
  if (pct > 0) return "bg-primary";
  return "bg-fill-secondary";
}

/** Progress percentage text color. */
function progressTextColor(pct: number): string {
  if (pct > 100) return "text-mac-orange";
  if (pct >= 100) return "text-mac-green";
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
export function ProjectCard({ project, isPinned, onTogglePin, className }: ProjectCardProps) {
  const isOverrun = project.percentComplete > 100;
  const displayPct = Math.min(project.percentComplete, 100);

  return (
    <div
      className={cn(
        "group relative rounded-mac-card border bg-card overflow-hidden",
        "transition-all duration-150 ease-out",
        "hover:shadow-mac-card hover:border-primary/20 hover:-translate-y-0.5",
        "h-full flex flex-col",
        className
      )}
    >
      {/* Status accent — left border strip */}
      <div className={cn("absolute left-0 top-0 bottom-0 w-[3px]", accentColor(project.status))} />

      {/* Pin button — appears on hover, stays visible when pinned */}
      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTogglePin(project.id);
          }}
          className={cn(
            "absolute top-2 right-2 z-10 rounded-lg p-1 transition-all duration-150",
            isPinned
              ? "opacity-100 text-primary bg-primary/10 hover:bg-primary/20"
              : "opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground hover:bg-muted"
          )}
          title={isPinned ? "Unpin project" : "Pin project"}
        >
          <Pin className={cn("h-3 w-3", isPinned && "fill-current")} />
        </button>
      )}

      <div className="flex flex-col flex-1 pl-3 pr-3 pt-2.5 pb-2 space-y-1.5">
        {/* Row 1: Project name + status badge */}
        <div className="space-y-0.5">
          <div className="flex items-start justify-between gap-1.5">
            <h3
              className="text-body font-semibold leading-snug truncate text-foreground"
              title={project.name}
            >
              {project.name}
            </h3>
            <span
              className={cn(
                "inline-flex items-center shrink-0 rounded-full px-1.5 py-px",
                "text-footnote font-medium uppercase",
                statusStyle(project.status)
              )}
            >
              {statusLabel(project.status)}
            </span>
          </div>
          <p className="text-footnote text-muted-foreground font-mono tabular-nums">
            {project.jobNumber || project.proposalNumber}
          </p>
        </div>

        {/* Row 2: Progress bar */}
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-1.5">
            <span className="text-footnote text-muted-foreground">Progress</span>
            <span
              className={cn(
                "text-subheadline font-bold tabular-nums leading-none",
                progressTextColor(project.percentComplete)
              )}
            >
              {project.percentComplete.toFixed(2)}%
            </span>
          </div>
          <div className="h-1 rounded-full bg-fill-secondary overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                progressBarColor(project.percentComplete)
              )}
              style={{
                width: displayPct > 0 ? `max(${displayPct}%, 4px)` : "0%",
              }}
            />
          </div>
          <div className="flex items-center justify-between text-footnote text-muted-foreground/70">
            <span className="tabular-nums">
              {formatMH(project.earnedMH)} / {formatMH(project.totalMH)} MH
            </span>
            {isOverrun && <span className="text-mac-orange font-medium">Overrun</span>}
          </div>
        </div>

        {/* Spacer to push metadata to bottom */}
        <div className="flex-1" />

        {/* Row 3: Metadata footer */}
        <div className="flex items-center justify-between gap-1.5 pt-1.5 border-t border-border/50">
          <div className="flex items-center gap-2 min-w-0 text-footnote text-muted-foreground">
            {project.owner && (
              <div className="flex items-center gap-0.5 min-w-0">
                <Building2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />
                <span className="truncate max-w-[80px]">{project.owner}</span>
              </div>
            )}
            {project.location && (
              <div className="flex items-center gap-0.5 min-w-0">
                <MapPin className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />
                <span className="truncate max-w-[80px]">{project.location}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5 text-footnote text-muted-foreground/50 shrink-0">
            <Clock className="h-2.5 w-2.5" />
            <span>{formatRelativeTime(project.lastUpdated)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
