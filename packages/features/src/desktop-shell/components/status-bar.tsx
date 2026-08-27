"use client";

/**
 * StatusBar Component
 *
 * Bottom status bar showing connection status and workspace context.
 * Similar to VS Code's status bar.
 */

import { useState, useEffect, useSyncExternalStore } from "react";
import { Wifi, WifiOff, AlertCircle, Loader2 } from "lucide-react";
import { Badge } from "@truss/ui/components/badge";
import { Button } from "@truss/ui/components/button";
import { Separator } from "@truss/ui/components/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@truss/ui/components/tooltip";
import { cn } from "@truss/ui/lib/utils";
import { useWorkspace } from "../../organizations/workspace-context";
import type { ConnectionStatus } from "../types";

/**
 * Status bar component for the bottom of the application
 */
/** Online/offline is browser state; the component reads it rather than copying it. */
function subscribeToConnection(onStoreChange: () => void): () => void {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

export function StatusBar() {
  const { workspace } = useWorkspace();
  // Subscribed rather than mirrored into state: the browser already owns this, and seeding it
  // from an effect meant every mount rendered "connected" once before correcting itself.
  const connectionStatus: ConnectionStatus = useSyncExternalStore(
    subscribeToConnection,
    () => (navigator.onLine ? "connected" : "disconnected"),
    () => "connected"
  );
  const [time, setTime] = useState(new Date());

  // Update time every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="status-bar h-7 border-t bg-background/95 backdrop-blur-sm px-3 flex items-center justify-between text-xs text-muted-foreground transition-all duration-150">
        {/* Left Section */}
        <div className="flex items-center gap-3">
          {/* Connection Status */}
          <ConnectionIndicator status={connectionStatus} />

          <Separator orientation="vertical" className="h-3.5" />

          {/* Workspace Info */}
          <button className="flex items-center gap-1.5 px-2 py-1 rounded-sm hover:bg-fill-quaternary active:bg-fill-tertiary transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <span className="font-medium text-footnote">
              {workspace?.organization_name || "Personal"}
            </span>
            {workspace?.role && (
              <Badge variant="secondary" className="h-4 px-1.5 text-footnote transition-all">
                {workspace.role}
              </Badge>
            )}
          </button>
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-3">
          {/* Command Palette Hint */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 hover:bg-fill-quaternary active:bg-fill-tertiary transition-all duration-150 focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  // Trigger command palette
                  const event = new KeyboardEvent("keydown", {
                    key: "k",
                    metaKey: true,
                    ctrlKey: true,
                  });
                  document.dispatchEvent(event);
                }}
              >
                {/* The glyph alone — an icon beside it printed "⌘ ⌘K". */}
                <span className="text-footnote font-medium">⌘K</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <p>Open Command Palette</p>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-3.5" />

          {/* Time */}
          <span className="tabular-nums text-footnote font-medium">
            {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Connection status indicator with enhanced hover states
 */
function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1 px-1.5 py-0.5 rounded-sm",
            "transition-all duration-150",
            "hover:bg-fill-quaternary active:bg-fill-tertiary",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            status === "connected" && "text-green-600 dark:text-green-400",
            status === "connecting" && "text-yellow-600 dark:text-yellow-400",
            status === "disconnected" && "text-red-600 dark:text-red-400",
            status === "error" && "text-destructive"
          )}
        >
          {status === "connected" && (
            <Wifi className="h-3 w-3 transition-transform hover:scale-110" />
          )}
          {status === "connecting" && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === "disconnected" && (
            <WifiOff className="h-3 w-3 transition-transform hover:scale-110" />
          )}
          {status === "error" && (
            <AlertCircle className="h-3 w-3 transition-transform hover:scale-110" />
          )}
          <span className="capitalize text-footnote font-medium">{status}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <p>Connection: {status}</p>
      </TooltipContent>
    </Tooltip>
  );
}
