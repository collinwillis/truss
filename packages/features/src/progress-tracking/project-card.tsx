import * as React from "react";
import { cn } from "@truss/ui/lib/utils";
import { Pin } from "lucide-react";

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

/** Status dot color — Finder tag-style indicator. */
function statusDotColor(status: Project["status"]): string {
  switch (status) {
    case "active":
      return "bg-mac-green";
    case "completed":
      return "bg-mac-blue";
    case "on-hold":
      return "bg-mac-orange";
    case "archived":
      return "bg-mac-gray";
  }
}

/** Status label for tooltip/screen readers. */
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

/** Progress bar fill color. */
function progressBarColor(pct: number): string {
  if (pct > 100) return "bg-mac-orange";
  if (pct >= 100) return "bg-mac-green";
  if (pct > 0) return "bg-primary";
  return "bg-fill-primary";
}

/** Progress text color — only colored for notable states. */
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
 * Project card — macOS native style.
 *
 * Designed to feel like a native macOS card:
 * - No borders at rest — subtle fill change on hover
 * - Status shown as a small colored dot (Finder tags pattern)
 * - Project name is the hero element
 * - Progress and metadata are secondary/tertiary
 * - Restrained hover effect (background tint only, no translate)
 */
export function ProjectCard({ project, isPinned, onTogglePin, className }: ProjectCardProps) {
  const isOverrun = project.percentComplete > 100;
  const displayPct = Math.min(project.percentComplete, 100);

  return (
    <div
      className={cn(
        "group relative rounded-mac-card bg-card overflow-hidden",
        "border border-border transition-all duration-200",
        "hover:shadow-[0_2px_12px_rgba(0,0,0,0.08)] dark:hover:shadow-none dark:hover:bg-fill-quaternary",
        "h-full flex flex-col",
        className
      )}
    >
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
            "absolute top-2 right-2 z-10 rounded-full p-1 transition-opacity duration-150",
            isPinned
              ? "opacity-100 text-primary"
              : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-foreground-subtle"
          )}
          title={isPinned ? "Unpin project" : "Pin project"}
        >
          <Pin className={cn("size-3", isPinned && "fill-current")} />
        </button>
      )}

      <div className="flex flex-col flex-1 px-3.5 pt-3 pb-3 gap-3">
        {/* Title */}
        <div className="flex items-start gap-1.5">
          <span
            className={cn(
              "size-[7px] rounded-full shrink-0 mt-[5px]",
              statusDotColor(project.status)
            )}
            title={statusLabel(project.status)}
          />
          <h3
            className="text-body font-medium leading-snug truncate text-foreground"
            title={project.name}
          >
            {project.name}
          </h3>
        </div>

        {/* Progress — percentage is the hero */}
        <div className="space-y-1.5">
          <span
            className={cn(
              "text-title2 font-bold tabular-nums tracking-tight",
              progressTextColor(project.percentComplete)
            )}
          >
            {project.percentComplete.toFixed(1)}%
          </span>
          <div className="h-[3px] rounded-full bg-fill-secondary overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                progressBarColor(project.percentComplete)
              )}
              style={{
                width: displayPct > 0 ? `max(${displayPct}%, 3px)` : "0%",
              }}
            />
          </div>
          <p className="text-footnote text-foreground-subtle tabular-nums">
            {formatMH(project.earnedMH)} / {formatMH(project.totalMH)} MH
          </p>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Footer — minimal, no icons */}
        <p className="text-footnote text-foreground-subtle truncate">
          {project.owner}
          {project.owner && project.lastUpdated && " · "}
          {project.lastUpdated && formatRelativeTime(project.lastUpdated)}
        </p>
      </div>
    </div>
  );
}
