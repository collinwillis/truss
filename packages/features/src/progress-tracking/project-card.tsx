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
import { Badge } from "@truss/ui/components/badge";
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
  /** Project data to display */
  project: Project;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Get status badge variant based on project status.
 */
function getStatusVariant(status: Project["status"]): "success" | "warning" | "danger" | "default" {
  switch (status) {
    case "completed":
      return "success";
    case "active":
      return "default";
    case "on-hold":
      return "warning";
    case "archived":
      return "danger";
    default:
      return "default";
  }
}

/**
 * Format project status for display.
 */
function formatStatus(status: Project["status"]): string {
  switch (status) {
    case "completed":
      return "Complete";
    case "active":
      return "Active";
    case "on-hold":
      return "On Hold";
    case "archived":
      return "Archived";
    default:
      return status;
  }
}

/**
 * Format relative time (e.g., "2 hours ago", "3 days ago").
 */
function formatRelativeTime(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}

/**
 * Project card component for displaying construction project information.
 *
 * Displays project metadata and progress in a card format with:
 * - Project name and description
 * - Proposal and job numbers
 * - Owner and location
 * - Progress bar with percentage
 * - Earned vs. total man-hours
 * - Status badge
 * - Last updated timestamp
 *
 * Designed for project selection and navigation. Wrap with Link for navigation.
 */
export function ProjectCard({ project, className }: ProjectCardProps) {
  const statusVariant = getStatusVariant(project.status);
  const statusLabel = formatStatus(project.status);

  return (
    <Card
      className={cn("transition-all hover:shadow-md hover:border-primary/50 h-full", className)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{formatRelativeTime(project.lastUpdated)}</span>
          </div>
        </div>

        <CardTitle className="text-lg font-bold line-clamp-2">{project.name}</CardTitle>

        <CardDescription className="flex items-center gap-2 text-xs">
          <span className="font-medium">{project.proposalNumber}</span>
          <span className="text-muted-foreground/50">•</span>
          <span className="font-medium">{project.jobNumber}</span>
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium tabular-nums">{project.percentComplete}%</span>
          </div>
          <Progress value={project.percentComplete} className="h-2" />
        </div>

        {/* Man-Hours Stats */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Man-Hours</span>
          <span className="font-mono font-medium tabular-nums">
            {project.earnedMH.toFixed(1)} / {project.totalMH.toFixed(1)} MH
          </span>
        </div>

        {/* Owner & Location */}
        <div className="pt-2 border-t space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">{project.owner}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 shrink-0" />
            <span className="truncate">{project.location}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
