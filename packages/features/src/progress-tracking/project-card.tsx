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

/** Status badge color mapping. */
function statusStyle(status: Project["status"]) {
  switch (status) {
    case "active":
      return "bg-green-500/15 text-green-700 dark:text-green-400";
    case "completed":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
    case "on-hold":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case "archived":
      return "bg-muted text-muted-foreground";
  }
}

/** Display label for status. */
function statusLabel(status: Project["status"]) {
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

/** Progress bar fill color. */
function pctBarColor(pct: number): string {
  if (pct >= 100) return "bg-green-500";
  if (pct >= 75) return "bg-green-500";
  if (pct >= 50) return "bg-amber-500";
  if (pct > 0) return "bg-orange-500";
  return "bg-muted-foreground/30";
}

/** Progress percentage text color. */
function pctColor(pct: number): string {
  if (pct >= 75) return "text-green-600 dark:text-green-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  if (pct > 0) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
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
  return date.toLocaleDateString();
}

/**
 * Project card for the projects list.
 *
 * WHY: Dense but scannable — shows status, progress, MH, owner,
 * and location at a glance without overwhelming.
 */
export function ProjectCard({ project, className }: ProjectCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 space-y-3 transition-all",
        "hover:shadow-md hover:border-primary/30",
        "h-full",
        className
      )}
    >
      {/* Status + timestamp row */}
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold",
            statusStyle(project.status)
          )}
        >
          {statusLabel(project.status)}
        </span>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
          <Clock className="h-3 w-3" />
          <span>{formatRelativeTime(project.lastUpdated)}</span>
        </div>
      </div>

      {/* Name + identifiers */}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold leading-snug line-clamp-2">{project.name}</h3>
        <p className="text-[11px] text-muted-foreground font-mono tabular-nums">
          {project.proposalNumber}
          {project.jobNumber && (
            <>
              <span className="mx-1 text-muted-foreground/40">&middot;</span>
              {project.jobNumber}
            </>
          )}
        </p>
      </div>

      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">Progress</span>
          <span className={cn("text-xs font-bold tabular-nums", pctColor(project.percentComplete))}>
            {project.percentComplete}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              pctBarColor(project.percentComplete)
            )}
            style={{ width: `${Math.min(project.percentComplete, 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="font-mono tabular-nums">
            {project.earnedMH.toLocaleString(undefined, { maximumFractionDigits: 0 })} /{" "}
            {project.totalMH.toLocaleString(undefined, { maximumFractionDigits: 0 })} MH
          </span>
        </div>
      </div>

      {/* Owner + location */}
      <div className="flex items-center gap-3 pt-1 border-t text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1 min-w-0">
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate font-medium">{project.owner}</span>
        </div>
        <div className="flex items-center gap-1 min-w-0">
          <MapPin className="h-3 w-3 shrink-0" />
          <span className="truncate">{project.location}</span>
        </div>
      </div>
    </div>
  );
}
