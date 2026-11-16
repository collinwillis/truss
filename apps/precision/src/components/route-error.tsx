import { useNavigate, useParams, type ErrorComponentProps } from "@tanstack/react-router";
import { accessErrorText, isAccessRefusal } from "@truss/features/access";
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { JSX } from "react";
import { WindowDragStrip } from "./window-drag-strip";

/** Props for {@link RouteErrorView}. */
export interface RouteErrorViewProps {
  /** One line saying what happened. */
  title: string;
  /** The server refused: a shield rather than a warning sign. */
  refused: boolean;
  /** Back to All estimates, the one place that always opens. */
  onBack: () => void;
  /**
   * Fill the window. The root's error replaces the shell, so it brings its own
   * drag strip; everywhere else it sits in the shell's content area.
   */
  fullScreen?: boolean;
}

/**
 * A screen that could not render, and the way back to All estimates.
 *
 * WHY a way back at all: main.tsx re-pushes history on every popstate, so Back
 * does nothing, and without a button the only escape was restarting the app.
 */
export function RouteErrorView({
  title,
  refused,
  onBack,
  fullScreen = false,
}: RouteErrorViewProps): JSX.Element {
  const Icon = refused ? ShieldAlert : AlertTriangle;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4 text-center",
        fullScreen ? "relative min-h-screen bg-background" : "min-h-[400px] flex-1"
      )}
    >
      {fullScreen && <WindowDragStrip />}
      <div className="mb-4 rounded-full bg-fill-quaternary p-3">
        <Icon className="size-6 text-label-quaternary" aria-hidden />
      </div>
      <p className="max-w-sm text-body font-medium text-foreground">{title}</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onBack}>
        All estimates
      </Button>
    </div>
  );
}

/**
 * The line for a failed screen.
 *
 * Inside an estimate a refusal means the caller was just removed from it (or
 * lost Can edit all) while it was open, so it says that. Elsewhere it is the
 * server's own sentence ("Organization admin access required."), which is
 * written for the person reading it.
 */
function errorTitle(error: unknown, inEstimate: boolean): string {
  if (!isAccessRefusal(error)) return "Something went wrong";
  return inEstimate ? "You no longer have access to this estimate" : accessErrorText(error);
}

/** The route-aware wiring shared by {@link RouteError} and {@link RootRouteError}. */
function RouteErrorScreen({
  error,
  reset,
  fullScreen,
}: ErrorComponentProps & { fullScreen?: boolean }): JSX.Element {
  const navigate = useNavigate();
  const { estimateId } = useParams({ strict: false });
  return (
    <RouteErrorView
      title={errorTitle(error, estimateId !== undefined)}
      refused={isAccessRefusal(error)}
      // Clear the boundary after leaving, in case it is still mounted.
      onBack={() => void navigate({ to: "/estimates" }).then(reset)}
      fullScreen={fullScreen}
    />
  );
}

/**
 * Error boundary for every screen inside the shell: the router's default, and
 * the estimate layout's own.
 *
 * WHY estimates need one: the overview, WBS and phase screens subscribe to
 * queries the server refuses the moment someone is removed from the estimate,
 * and with no boundary that refusal replaced the whole app. This keeps the
 * shell and says what happened.
 */
export function RouteError(props: ErrorComponentProps): JSX.Element {
  return <RouteErrorScreen {...props} />;
}

/** The root route's error boundary: the shell itself failed, so it fills the window. */
export function RootRouteError(props: ErrorComponentProps): JSX.Element {
  return <RouteErrorScreen {...props} fullScreen />;
}
