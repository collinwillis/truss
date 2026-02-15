/**
 * Skeleton Loading Components
 *
 * WHY: Provide visual feedback during data loading with content-aware skeletons
 * matching the structure of actual content for a smooth loading experience.
 */

import { Skeleton } from "@truss/ui/components/skeleton";

/**
 * Project card skeleton loader
 *
 * Matches the structure of ProjectCard component
 */
export function ProjectCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      {/* Title and badge */}
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full" />
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-8" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="space-y-1">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  );
}

/**
 * WBS card skeleton loader
 *
 * Matches the structure of WBSCard component
 */
export function WBSCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      {/* Code and title */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-5 w-full" />
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 pt-2">
        <div className="space-y-1">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="space-y-1">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-4 w-16" />
        </div>
      </div>
    </div>
  );
}

/**
 * Page header skeleton
 */
export function PageHeaderSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>

      <div className="flex items-start justify-between">
        <div className="space-y-3 flex-1">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-4 w-96" />
        </div>

        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-10 w-48" />
        </div>
      </div>
    </div>
  );
}

/**
 * Summary stats skeleton (3 cards)
 */
export function SummaryStatsSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-6 space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24" />
        </div>
      ))}
    </div>
  );
}

/**
 * Full project dashboard skeleton
 */
export function ProjectDashboardSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <SummaryStatsSkeleton />

      <div className="pt-2">
        <Skeleton className="h-6 w-64 mb-2" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[...Array(8)].map((_, i) => (
          <WBSCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Projects list skeleton
 */
export function ProjectsListSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-44" />
        </div>
      </div>

      {/* Search and filters */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-10 w-80" />
      </div>

      {/* Project cards grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[...Array(8)].map((_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
