/**
 * Shared project-display model + formatting helpers used by both the tile
 * (ProjectCard) and the list row (ProjectListRow), so the two views can never
 * drift in how they format names, man-hours, time, or status color.
 */

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
  /** "City, ST" for display (from the source proposal address). */
  cityState: string;
  startDate: string;
  status: "active" | "on-hold" | "completed" | "archived";
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  lastUpdated: string;
}

/** Status dot color — Finder tag-style indicator. */
export function statusDotColor(status: Project["status"]): string {
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
export function statusLabel(status: Project["status"]): string {
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
export function progressBarColor(pct: number): string {
  if (pct > 100) return "bg-mac-orange";
  if (pct >= 100) return "bg-mac-green";
  if (pct > 0) return "bg-primary";
  return "bg-fill-primary";
}

/** Progress text color — only colored for notable states. */
export function progressTextColor(pct: number): string {
  if (pct > 100) return "text-mac-orange";
  if (pct >= 100) return "text-success-text";
  return "text-foreground";
}

/** Relative time formatter. */
export function formatRelativeTime(dateString: string): string {
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
export function formatMH(value: number): string {
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
 * Clean job name for display: the stored name minus the leading project number,
 * a trailing bracketed tag (e.g. "[DA TEST COPY]"), and a trailing city/state
 * that the location chip already shows — so the heading reads as a tight job
 * name rather than a redundant, truncated string.
 */
export function cleanProjectName(name: string, projectNumber?: string, cityState?: string): string {
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
