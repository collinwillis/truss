/**
 * Skeleton Loading Components
 *
 * WHY: Content-aware skeletons matching actual layout structure
 * for smooth loading transitions.
 */

import { Skeleton } from "@truss/ui/components/skeleton";

/**
 * Project card skeleton matching the ProjectCard layout.
 */
export function ProjectCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Status + timestamp */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-14 rounded-md" />
        <Skeleton className="h-3 w-14" />
      </div>
      {/* Name + identifiers */}
      <div className="space-y-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-24" />
      </div>
      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-8" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <Skeleton className="h-3 w-20" />
      </div>
      {/* Owner + location */}
      <div className="flex items-center gap-3 pt-1 border-t">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}

/**
 * Page header skeleton (breadcrumb + title + subtitle).
 */
export function PageHeaderSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-2" />
        <Skeleton className="h-4 w-28" />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-80" />
      </div>
    </div>
  );
}

/**
 * Summary stats skeleton (5 stat cards).
 */
export function SummaryStatsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-4 w-4 rounded" />
          </div>
          <Skeleton className="h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Full project dashboard skeleton.
 */
export function ProjectDashboardSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <SummaryStatsSkeleton />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-28" />
        </div>
        <Skeleton className="h-[240px] w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Projects list skeleton matching the polished layout.
 */
export function ProjectsListSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-full max-w-sm" />
        <Skeleton className="h-8 w-56 rounded-lg" />
      </div>

      {/* Cards grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
