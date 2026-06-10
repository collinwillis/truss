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

/**
 * Shared grid template for the list view so the optional column header and the
 * rows stay perfectly aligned. Columns: status · number · name+city · owner ·
 * progress · man-hours · updated · pin.
 */
export const PROJECT_LIST_GRID_COLS =
  "grid-cols-[10px_64px_minmax(0,1fr)_minmax(0,140px)_148px_minmax(0,128px)_80px_24px]";

export interface ProjectListRowProps {
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
 * Dense list row for the All Projects list view (#22) — a Linear/Notion-style
 * table row aligned by a shared CSS grid. Mirrors ProjectCard's data at glance
 * density: status · number · name+location · owner · % + slim bar · earned/total
 * MH · last updated · pin. All formatting comes from the shared display utils so
 * the list and tile views can never drift.
 */
export function ProjectListRow({ project, isPinned, onTogglePin, className }: ProjectListRowProps) {
  const projectNumber = project.projectNumber?.trim();
  const cityState = project.cityState?.trim();
  const displayName = cleanProjectName(project.name, projectNumber, cityState);
  const displayPct = Math.min(project.percentComplete, 100);

  return (
    <div
      className={cn(
        "group grid h-11 items-center gap-3 rounded-mac-card px-3 transition-colors",
        PROJECT_LIST_GRID_COLS,
        "hover:bg-fill-quaternary",
        className
      )}
    >
      {/* Status */}
      <span
        className={cn("size-[7px] rounded-full", statusDotColor(project.status))}
        title={statusLabel(project.status)}
      />

      {/* Project number */}
      <span className="truncate font-mono text-footnote tabular-nums text-foreground-subtle">
        {projectNumber}
      </span>

      {/* Name + city/state */}
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-body font-medium text-foreground" title={project.name}>
          {displayName}
        </span>
        {cityState && (
          <span className="shrink truncate text-footnote text-foreground-subtle">{cityState}</span>
        )}
      </div>

      {/* Owner */}
      <span className="truncate text-footnote text-foreground-subtle">{project.owner}</span>

      {/* Progress — slim bar + percentage */}
      <div className="flex items-center gap-2">
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-fill-secondary">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              progressBarColor(project.percentComplete)
            )}
            style={{ width: displayPct > 0 ? `max(${displayPct}%, 3px)` : "0%" }}
          />
        </div>
        <span
          className={cn(
            "w-12 shrink-0 text-right text-footnote font-semibold tabular-nums",
            progressTextColor(project.percentComplete)
          )}
        >
          {project.percentComplete.toFixed(1)}%
        </span>
      </div>

      {/* Man-hours */}
      <span className="truncate text-right font-mono text-footnote tabular-nums text-foreground-subtle">
        {formatMH(project.earnedMH)} / {formatMH(project.totalMH)}
      </span>

      {/* Last updated */}
      <span className="text-right text-footnote tabular-nums text-foreground-subtle">
        {project.lastUpdated && formatRelativeTime(project.lastUpdated)}
      </span>

      {/* Pin — hover-reveal, mirrors the card */}
      {onTogglePin ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTogglePin(project.id);
          }}
          className={cn(
            "flex size-6 items-center justify-center rounded-full transition-opacity duration-150",
            isPinned
              ? "text-primary opacity-100"
              : "text-foreground-subtle opacity-0 group-hover:opacity-60 hover:!opacity-100"
          )}
          title={isPinned ? "Unpin project" : "Pin project"}
        >
          <Pin className={cn("size-3", isPinned && "fill-current")} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
