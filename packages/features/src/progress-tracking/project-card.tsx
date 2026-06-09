import * as React from "react";
import { cn } from "@truss/ui/lib/utils";
import { Pin } from "lucide-react";

export interface Project {
  id: string;
  proposalNumber: string;
  /** User-facing project number, shown separately from the name and sorted on. */
  projectNumber: string;
  jobNumber: string;
  name: string;
  description: string;
  owner: string;
  location: string;
  /** "City, ST" for the tile (from the source proposal address). */
  cityState: string;
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
  if (pct >= 100) return "text-success-text";
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

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean job name for the card heading: the stored name minus the leading
 * project number, a trailing bracketed tag (e.g. "[DA TEST COPY]"), and a
 * trailing city/state that the location chip already shows — so the heading
 * reads as a tight job name rather than a redundant, truncated string.
 */
function cleanProjectName(name: string, projectNumber?: string, cityState?: string): string {
  let n = name;
  if (projectNumber && n.startsWith(projectNumber)) {
    n = n.slice(projectNumber.length).replace(/^[\s\-–—]+/, "");
  }
  n = n.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
  if (cityState) {
    n = n.replace(new RegExp("[\\s,\\-–—]+" + escapeRegExp(cityState) + "\\s*$", "i"), "").trim();
  }
  return n || name;
}

/**
 * Project card — macOS native style.
 *
 * Identity (status · number · location, then the job name) sits at the top;
 * the metrics cluster (percent + man-hours, progress bar, owner · updated)
 * anchors to the bottom so every card shares a stable baseline regardless of
 * how much identity text it carries.
 */
export function ProjectCard({ project, isPinned, onTogglePin, className }: ProjectCardProps) {
  const displayPct = Math.min(project.percentComplete, 100);
  const projectNumber = project.projectNumber?.trim();
  const cityState = project.cityState?.trim();
  const displayName = cleanProjectName(project.name, projectNumber, cityState);

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

      <div className="flex flex-col flex-1 p-4 gap-3">
        {/* Identity — status · number · location, then the job name */}
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-1.5 text-footnote text-foreground-subtle min-w-0">
            <span
              className={cn("size-[7px] rounded-full shrink-0", statusDotColor(project.status))}
              title={statusLabel(project.status)}
            />
            {projectNumber && (
              <span className="font-mono tabular-nums shrink-0">{projectNumber}</span>
            )}
            {cityState && (
              <>
                <span className="shrink-0 opacity-40">&middot;</span>
                <span className="truncate">{cityState}</span>
              </>
            )}
          </div>
          <h3
            className="text-body font-semibold leading-snug truncate text-foreground"
            title={project.name}
          >
            {displayName}
          </h3>
        </div>

        {/* Push metrics to the bottom for a shared baseline across cards */}
        <div className="flex-1" />

        {/* Metrics — percent + MH on one baseline, bar, owner · updated */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                "text-title2 font-bold tabular-nums tracking-tight leading-none",
                progressTextColor(project.percentComplete)
              )}
            >
              {project.percentComplete.toFixed(1)}%
            </span>
            <span className="text-footnote font-mono tabular-nums text-foreground-subtle shrink-0">
              {formatMH(project.earnedMH)} / {formatMH(project.totalMH)} MH
            </span>
          </div>
          <div className="h-[3px] rounded-full bg-fill-secondary overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                progressBarColor(project.percentComplete)
              )}
              style={{ width: displayPct > 0 ? `max(${displayPct}%, 3px)` : "0%" }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-footnote text-foreground-subtle">
            <span className="truncate">{project.owner}</span>
            {project.lastUpdated && (
              <span className="shrink-0 tabular-nums">
                {formatRelativeTime(project.lastUpdated)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
