import * as React from "react";
import { cn } from "@truss/ui/lib/utils";
import { Pin } from "lucide-react";
import {
  type Project,
  cleanProjectName,
  formatMH,
  formatRelativeTime,
  progressBarColor,
  progressTextColor,
  statusDotColor,
  statusLabel,
} from "./project-display-utils";

export type { Project };

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
