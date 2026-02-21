/**
 * In-app update notification banner.
 *
 * WHY: Provides non-intrusive, always-visible feedback for the entire update
 * lifecycle — from detection through download and restart. Consumes state from
 * the UpdateContext so other surfaces (command palette, status bar) can also
 * trigger checks without duplicating plugin logic.
 *
 * @see https://v2.tauri.app/plugin/updater/
 */

import { CheckCircle2, Download, Loader2, RefreshCw, X, AlertCircle } from "lucide-react";
import { useUpdate } from "../lib/update-context";

/**
 * Update notification banner rendered at the top of the authenticated app.
 *
 * WHY: A banner (vs. a dialog) lets users continue working while being
 * informed. All interactions are user-initiated — no forced restarts.
 */
export function UpdateChecker(): React.ReactNode {
  const { status, update, progress, error, downloadAndInstall, restart, dismiss } = useUpdate();

  if (status === "idle") return null;

  const progressPercent =
    progress.total && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div
      className="flex items-center gap-3 border-b border-border bg-muted/50 px-4 py-2 text-sm"
      role="status"
      aria-live="polite"
    >
      {status === "checking" && (
        <>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">Checking for updates...</span>
        </>
      )}

      {status === "up-to-date" && (
        <>
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          <span className="text-muted-foreground">You&apos;re on the latest version.</span>
          <button
            onClick={dismiss}
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}

      {status === "available" && (
        <>
          <Download className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-muted-foreground">Version {update?.version} is available.</span>
          <button
            onClick={downloadAndInstall}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Update now
          </button>
          <button
            onClick={dismiss}
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss update notification"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}

      {status === "downloading" && (
        <>
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
          <span className="text-muted-foreground">
            Downloading update{progressPercent !== null ? ` (${progressPercent}%)` : "..."}
          </span>
          {progressPercent !== null && (
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
        </>
      )}

      {status === "ready" && (
        <>
          <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-muted-foreground">Update installed. Restart to apply.</span>
          <button
            onClick={restart}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Restart now
          </button>
          <button
            onClick={dismiss}
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss and restart later"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}

      {status === "error" && (
        <>
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="text-destructive">Update failed{error ? `: ${error}` : ""}</span>
          <button
            onClick={dismiss}
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss error"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
