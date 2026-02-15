import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@truss/ui/components/button";

/**
 * Export to Excel route - data export functionality
 *
 * WHY: Placeholder for Excel export features with customizable report templates
 */
export const Route = createFileRoute("/project/$projectId/reports/export")({
  component: ExportExcelPage,
});

function ExportExcelPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[600px] px-6">
      <div className="max-w-md w-full text-center space-y-6">
        {/* Icon */}
        <div className="mx-auto w-24 h-24 rounded-full bg-muted/30 flex items-center justify-center">
          <Download className="h-12 w-12 text-muted-foreground/50" />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Export to Excel</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Export project progress data to Excel with customizable templates, including WBS
            breakdown, phase details, and progress history.
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
