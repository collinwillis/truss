"use client";

import { useEffect, useState } from "react";
import { getOS, isTauri } from "@truss/lib/platform";
import type { AppShellConfig } from "../types";

/**
 * Whether this window runs the macOS OVERLAY title bar, and whether the
 * native traffic lights are currently visible in it.
 *
 * With `titleBarStyle: Overlay` the OS draws no title bar of its own — the
 * web content reaches the top of the window and the close/minimize/zoom
 * buttons float over it. The shell must therefore (a) reserve room for them
 * and (b) provide its own drag surface. Both are conditional on this hook:
 * the config opts a window in, and only a macOS Tauri window qualifies —
 * a browser tab or a future Windows build renders the ordinary bar.
 *
 * `lightsVisible` goes false in native fullscreen, where macOS hides the
 * buttons — keeping the reserved inset there would leave a dead notch of
 * empty pixels at the window's top-left.
 */
export function useOverlayTitleBar(config: AppShellConfig): {
  overlay: boolean;
  lightsVisible: boolean;
} {
  const overlay = config.layout?.titleBar === "overlay" && isTauri() && getOS() === "macos";
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!overlay) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    // Dynamic import so this module stays loadable outside Tauri — the
    // overlay guard above means the API is only touched where it exists.
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const apply = async () => {
        const fs = await win.isFullscreen();
        if (!disposed) setFullscreen(fs);
      };
      await apply();
      // Fullscreen has no dedicated event; the resize that accompanies the
      // transition is the reliable signal.
      const off = await win.onResized(() => void apply());
      if (disposed) off();
      else unlisten = off;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [overlay]);

  return { overlay, lightsVisible: overlay && !fullscreen };
}
