import { WBSCard } from "@truss/features/progress-tracking";
import { mockWBSItems } from "../data/mock-progress-data";

/**
 * Momentum dashboard page displaying WBS (Work Breakdown Structure) progress cards.
 *
 * Shows high-level project status with:
 * - Grid of WBS cards (responsive: 1-4 columns)
 * - Color-coded progress indicators
 * - Quick drill-down access (click to view details)
 */
export function DashboardPage() {
  const handleCardClick = (wbsCode: string) => {
    console.log("Clicked WBS:", wbsCode);
    // Future: navigate to detail view
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Project Dashboard</h1>
        <p className="text-muted-foreground mt-2">
          Track progress across all work breakdown structure (WBS) items
        </p>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium text-muted-foreground">Total Man-Hours</div>
          <div className="mt-2 text-2xl font-bold">
            {mockWBSItems.reduce((sum, item) => sum + item.totalMH, 0).toFixed(1)} MH
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium text-muted-foreground">Earned Man-Hours</div>
          <div className="mt-2 text-2xl font-bold">
            {mockWBSItems.reduce((sum, item) => sum + item.earnedMH, 0).toFixed(1)} MH
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium text-muted-foreground">Overall Progress</div>
          <div className="mt-2 text-2xl font-bold">
            {Math.round(
              (mockWBSItems.reduce((sum, item) => sum + item.earnedMH, 0) /
                mockWBSItems.reduce((sum, item) => sum + item.totalMH, 0)) *
                100
            )}
            %
          </div>
        </div>
      </div>

      {/* WBS Cards Grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {mockWBSItems.map((item) => (
          <WBSCard key={item.id} item={item} onClick={() => handleCardClick(item.code)} />
        ))}
      </div>
    </div>
  );
}
