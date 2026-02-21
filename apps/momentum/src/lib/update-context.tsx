/**
 * Application Update Context
 *
 * Centralized state management for the Tauri v2 updater plugin lifecycle.
 *
 * WHY: The updater logic is separated into a context so any part of the app
 * (banner, command palette, status bar) can trigger or observe update state
 * without duplicating the underlying plugin calls.
 *
 * Follows the Tauri v2 updater plugin API:
 * - `check()` returns `Update | null` (null = already on latest)
 * - `Update` extends `Resource` and must be `close()`d when no longer needed
 * - `downloadAndInstall()` accepts a `DownloadEvent` callback for progress
 * - `relaunch()` restarts the app after installation
 *
 * @see https://v2.tauri.app/plugin/updater/
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import type { ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Delay before the first automatic check to avoid blocking app startup. */
const STARTUP_DELAY_MS = 3_000;

/** Interval between automatic background checks (1 hour). */
const RECHECK_INTERVAL_MS = 60 * 60 * 1_000;

/** Duration to show the "up-to-date" confirmation before auto-dismissing. */
const UP_TO_DATE_DISMISS_MS = 5_000;

/** Represents the current phase of the update lifecycle. */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

/** Download progress state. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/** Public API exposed by the update context. */
export interface UpdateContextValue {
  /** Current phase of the update lifecycle. */
  status: UpdateStatus;
  /** The available update, if one exists. */
  update: Update | null;
  /** Download progress (only meaningful during "downloading" status). */
  progress: UpdateProgress;
  /** Human-readable error message when status is "error". */
  error: string | null;
  /** Trigger a manual update check with visible feedback. */
  checkForUpdate: () => Promise<void>;
  /** Download and install the available update. */
  downloadAndInstall: () => Promise<void>;
  /** Restart the application to apply the installed update. */
  restart: () => Promise<void>;
  /** Dismiss the current notification and return to idle. */
  dismiss: () => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

/**
 * Access the update context.
 *
 * WHY: Typed wrapper that enforces provider presence at the call site
 * rather than silently returning null.
 */
export function useUpdate(): UpdateContextValue {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error("useUpdate must be used within an UpdateProvider");
  }
  return context;
}

/**
 * Provides update lifecycle state to the component tree.
 *
 * WHY: Encapsulates all Tauri updater plugin interactions in one place.
 * Components consume state via `useUpdate()` without knowing plugin details.
 *
 * Behavior:
 * - Checks for updates 3 seconds after mount (avoids blocking startup)
 * - Re-checks every hour in the background
 * - Manual checks show "checking" and "up-to-date" feedback
 * - Automatic checks are invisible unless an update is found
 * - Dismissed versions are remembered for the current session
 * - Update resources are properly closed to prevent memory leaks
 */
export function UpdateProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);

  // Refs for values accessed inside stable callbacks
  const statusRef = useRef<UpdateStatus>("idle");
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const dismissedVersionRef = useRef<string | null>(null);

  // Keep status ref in sync
  statusRef.current = status;

  /**
   * Core update check logic.
   *
   * WHY manual vs automatic distinction: automatic checks should be invisible
   * to avoid disrupting the user. Manual checks must always provide feedback
   * so the user knows the check actually ran.
   */
  const performCheck = useCallback(async (manual: boolean) => {
    // Don't interrupt an active download or pending restart
    if (statusRef.current === "downloading" || statusRef.current === "ready") return;
    // Prevent concurrent checks
    if (checkingRef.current) return;

    checkingRef.current = true;

    if (manual) {
      setStatus("checking");
    }

    try {
      // Release the previous Update resource before creating a new one
      if (updateRef.current) {
        try {
          await updateRef.current.close();
        } catch {
          // Resource may already be closed
        }
        updateRef.current = null;
      }

      const result = await check();

      if (result) {
        // Skip if the user already dismissed this version in the current session
        if (dismissedVersionRef.current === result.version) {
          await result.close();
          setUpdate(null);
          setStatus(manual ? "up-to-date" : "idle");
        } else {
          updateRef.current = result;
          setUpdate(result);
          setError(null);
          setStatus("available");
        }
      } else {
        setUpdate(null);
        setError(null);
        setStatus(manual ? "up-to-date" : "idle");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (manual) {
        setError(message);
        setStatus("error");
      } else {
        // Automatic checks log and stay silent
        console.warn("Update check failed:", message);
        setStatus("idle");
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  /** Manual check — always provides visible feedback. */
  const checkForUpdate = useCallback(async () => {
    await performCheck(true);
  }, [performCheck]);

  /** Download and install the available update with progress tracking. */
  const handleDownloadAndInstall = useCallback(async () => {
    const currentUpdate = updateRef.current;
    if (!currentUpdate) return;

    try {
      setStatus("downloading");
      setProgress({ downloaded: 0, total: null });

      await currentUpdate.downloadAndInstall((event) => {
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
      const message = e instanceof Error ? e.message : "Download failed";
      console.error("Update download failed:", message);
      setError(message);
      setStatus("error");
    }
  }, []);

  /** Restart the application to apply the installed update. */
  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  /** Dismiss the current notification. Remembers the version to avoid re-nagging. */
  const dismiss = useCallback(() => {
    if (updateRef.current) {
      dismissedVersionRef.current = updateRef.current.version;
    }
    setStatus("idle");
    setError(null);
  }, []);

  // Startup check with delay
  useEffect(() => {
    const timer = setTimeout(() => {
      performCheck(false);
    }, STARTUP_DELAY_MS);

    return () => clearTimeout(timer);
  }, [performCheck]);

  // Periodic background re-check
  useEffect(() => {
    const interval = setInterval(() => {
      performCheck(false);
    }, RECHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [performCheck]);

  // Auto-dismiss "up-to-date" confirmation after timeout
  useEffect(() => {
    if (status !== "up-to-date") return;

    const timer = setTimeout(() => {
      setStatus("idle");
    }, UP_TO_DATE_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [status]);

  // Clean up Update resource on unmount
  useEffect(() => {
    return () => {
      if (updateRef.current) {
        updateRef.current.close().catch(() => {});
        updateRef.current = null;
      }
    };
  }, []);

  const value = useMemo<UpdateContextValue>(
    () => ({
      status,
      update,
      progress,
      error,
      checkForUpdate,
      downloadAndInstall: handleDownloadAndInstall,
      restart,
      dismiss,
    }),
    [status, update, progress, error, checkForUpdate, handleDownloadAndInstall, restart, dismiss]
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}
