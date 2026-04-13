/**
 * In-app update dialog.
 *
 * WHY a modal dialog instead of a banner: Premium desktop apps (Slack, Linear,
 * Figma, VS Code) all use centered modal dialogs for update notifications.
 * A dialog is impossible to miss, can't be hidden by layout elements, and
 * feels intentional and professional.
 *
 * @see https://v2.tauri.app/plugin/updater/
 */

import { ArrowDownToLine, CheckCircle2, Loader2, RotateCcw, AlertCircle } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { useUpdate } from "../lib/update-context";

/**
 * Update dialog rendered when a new version is detected.
 *
 * States:
 * - available: Shows version info with Update Now / Later buttons
 * - downloading: Shows progress bar, non-dismissible
 * - ready: Shows restart prompt
 * - error: Shows error with retry/dismiss
 *
 * Idle, checking, and up-to-date states are invisible.
 */
export function UpdateChecker(): React.ReactNode {
  const { status, update, progress, error, downloadAndInstall, restart, dismiss, checkForUpdate } =
    useUpdate();

  const showDialog =
    status === "available" || status === "downloading" || status === "ready" || status === "error";

  if (!showDialog) return null;

  const progressPercent =
    progress.total && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  const canDismiss = status !== "downloading";

  return (
    <Dialog
      open={showDialog}
      onOpenChange={(open) => {
        if (!open && canDismiss) dismiss();
      }}
    >
      <DialogContent
        className="sm:max-w-[360px] p-0 gap-0 overflow-hidden [&>button:last-child]:hidden"
        onPointerDownOutside={(e) => {
          if (!canDismiss) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (!canDismiss) e.preventDefault();
        }}
      >
        {/* ── Update available ── */}
        {status === "available" && (
          <>
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/8 ring-1 ring-primary/10">
                <ArrowDownToLine className="h-7 w-7 text-primary" strokeWidth={1.5} />
              </div>
              <DialogHeader className="space-y-1.5">
                <DialogTitle className="text-center text-[17px] font-semibold tracking-tight">
                  Update Available
                </DialogTitle>
                <DialogDescription className="text-center text-[13px] leading-relaxed">
                  A new version of Momentum is ready to install.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-3 inline-flex items-center rounded-full bg-muted px-2.5 py-0.5">
                <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                  v{update?.version}
                </span>
              </div>
            </div>
            <div className="border-t bg-muted/30 px-6 py-4 flex flex-col gap-2">
              <Button onClick={downloadAndInstall} size="sm" className="w-full h-9">
                Update Now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={dismiss}
                className="w-full h-9 text-muted-foreground"
              >
                Not Now
              </Button>
            </div>
          </>
        )}

        {/* ── Downloading ── */}
        {status === "downloading" && (
          <div className="px-6 py-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/8 ring-1 ring-primary/10">
              <Loader2 className="h-7 w-7 text-primary animate-spin" strokeWidth={1.5} />
            </div>
            <DialogHeader className="space-y-1.5">
              <DialogTitle className="text-center text-[17px] font-semibold tracking-tight">
                Installing Update
              </DialogTitle>
              <DialogDescription className="text-center text-[13px] leading-relaxed">
                {progressPercent !== null
                  ? "Downloading — please don't close the app."
                  : "Preparing download..."}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-5 space-y-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                  style={{ width: `${progressPercent ?? 2}%` }}
                />
              </div>
              {progressPercent !== null && (
                <p className="text-[11px] tabular-nums text-muted-foreground">{progressPercent}%</p>
              )}
            </div>
          </div>
        )}

        {/* ── Ready to restart ── */}
        {status === "ready" && (
          <>
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-success/8 ring-1 ring-success/10">
                <CheckCircle2 className="h-7 w-7 text-success-text" strokeWidth={1.5} />
              </div>
              <DialogHeader className="space-y-1.5">
                <DialogTitle className="text-center text-[17px] font-semibold tracking-tight">
                  Update Installed
                </DialogTitle>
                <DialogDescription className="text-center text-[13px] leading-relaxed">
                  Restart Momentum to start using v{update?.version}.
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="border-t bg-muted/30 px-6 py-4 flex flex-col gap-2">
              <Button onClick={restart} size="sm" className="w-full h-9">
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Restart Now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={dismiss}
                className="w-full h-9 text-muted-foreground"
              >
                Restart Later
              </Button>
            </div>
          </>
        )}

        {/* ── Error ── */}
        {status === "error" && (
          <>
            <div className="px-6 pt-8 pb-6 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/8 ring-1 ring-destructive/10">
                <AlertCircle className="h-7 w-7 text-destructive" strokeWidth={1.5} />
              </div>
              <DialogHeader className="space-y-1.5">
                <DialogTitle className="text-center text-[17px] font-semibold tracking-tight">
                  Update Failed
                </DialogTitle>
                <DialogDescription className="text-center text-[13px] leading-relaxed max-w-[280px] mx-auto">
                  {error || "Something went wrong. Please try again."}
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="border-t bg-muted/30 px-6 py-4 flex flex-col gap-2">
              <Button onClick={checkForUpdate} variant="outline" size="sm" className="w-full h-9">
                Try Again
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={dismiss}
                className="w-full h-9 text-muted-foreground"
              >
                Dismiss
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
