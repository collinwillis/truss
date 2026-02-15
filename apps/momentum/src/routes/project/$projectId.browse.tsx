import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, List } from "lucide-react";
import { Button } from "@truss/ui/components/button";

/**
 * Browse all work items route - hierarchical view of all WBS items and phases
 *
 * WHY: Placeholder for comprehensive work item browser with filtering and search
 */
export const Route = createFileRoute("/project/$projectId/browse")({
  component: BrowseWorkItemsPage,
});

function BrowseWorkItemsPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[600px] px-6">
      <div className="max-w-md w-full text-center space-y-6">
        {/* Icon */}
        <div className="mx-auto w-24 h-24 rounded-full bg-muted/30 flex items-center justify-center">
          <List className="h-12 w-12 text-muted-foreground/50" />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Browse All Work Items</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            A comprehensive hierarchical view of all WBS items, phases, and work packages with
            advanced filtering and search capabilities.
          </p>
        </div>

        {/* Status Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-sm font-medium">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
          Coming Soon
        </div>

        {/* Action Button */}
        <Link to="/project/$projectId" params={{ projectId: Route.useParams().projectId }}>
          <Button variant="outline" className="gap-2 mt-4">
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
