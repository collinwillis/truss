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
 * Workbook page skeleton matching the combined dashboard+workbook layout.
 *
 * WHY: The index route now serves as the primary workbook surface,
 * so the skeleton matches: breadcrumb, metadata bar, summary bar, toolbar, table.
 */
export function WorkbookSkeleton() {
  return (
    <div className="flex flex-col h-full gap-4 min-w-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-2" />
        <Skeleton className="h-4 w-36" />
      </div>

      {/* Metadata + date picker */}
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-8 w-[170px]" />
          <Skeleton className="h-4 w-16" />
        </div>
      </div>

      {/* Summary bar */}
      <Skeleton className="h-8 w-full rounded-lg" />

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-full max-w-xs" />
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>

      {/* Table */}
      <Skeleton className="flex-1 min-h-[400px] w-full rounded-lg" />
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
