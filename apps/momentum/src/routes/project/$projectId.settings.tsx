import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Settings } from "lucide-react";
import { Button } from "@truss/ui/components/button";

/**
 * Project settings route - configuration and preferences
 *
 * WHY: Placeholder for project-level settings, permissions, and configuration
 */
export const Route = createFileRoute("/project/$projectId/settings")({
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[600px] px-6">
      <div className="max-w-md w-full text-center space-y-6">
        {/* Icon */}
        <div className="mx-auto w-24 h-24 rounded-full bg-muted/30 flex items-center justify-center">
          <Settings className="h-12 w-12 text-muted-foreground/50" />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Project Settings</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Configure project settings, team permissions, notifications, and general preferences for
            this project.
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
