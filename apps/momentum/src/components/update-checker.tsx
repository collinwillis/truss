import { useState, useEffect, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, RefreshCw, X } from "lucide-react";

type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/**
 * In-app update notification banner.
 *
 * WHY: Checks for updates on launch (with delay to avoid blocking startup),
 * then shows a non-intrusive banner when a new version is available.
 * Uses tauri-plugin-updater for signature-verified downloads.
 */
export function UpdateChecker() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setStatus("checking");
        const result = await check();
        if (result) {
          setUpdate(result);
          setStatus("available");
        } else {
          setStatus("idle");
        }
      } catch (e) {
        // Silently fail on update check - don't disrupt the user
        console.warn("Update check failed:", e);
        setStatus("idle");
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, []);

  const handleUpdate = useCallback(async () => {
    if (!update) return;

    try {
      setStatus("downloading");
      setProgress({ downloaded: 0, total: null });

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
            break;
          case "Progress":
            setProgress((prev) => ({
              ...prev,
              downloaded: prev.downloaded + event.data.chunkLength,
            }));
            break;
          case "Finished":
            break;
        }
      });

      setStatus("ready");
    } catch (e) {
      console.error("Update install failed:", e);
      setError(e instanceof Error ? e.message : "Update failed");
      setStatus("error");
    }
  }, [update]);

  const handleRelaunch = useCallback(async () => {
    await relaunch();
  }, []);

  if (dismissed || status === "idle" || status === "checking") return null;

  const progressPercent =
    progress.total && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted/50 px-4 py-2 text-sm">
      {status === "available" && (
        <>
          <Download className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-muted-foreground">Version {update?.version} is available.</span>
          <button
            onClick={handleUpdate}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Update now
          </button>
          <button
            onClick={() => setDismissed(true)}
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
          <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-muted-foreground">Update installed. Restart to apply.</span>
          <button
            onClick={handleRelaunch}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Restart now
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss and restart later"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}

      {status === "error" && (
        <>
          <span className="text-destructive">Update failed{error ? `: ${error}` : ""}</span>
          <button
            onClick={() => setDismissed(true)}
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
