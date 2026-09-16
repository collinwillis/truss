"use client";

import { useEffect, useRef, useState } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { isTauri } from "@truss/lib/platform";
import { useShortcut } from "../providers/keyboard-provider";

/** Shared with the Rust side, which restores this key before the first frame. */
const STORE_FILE = "preferences.json";
const STORE_KEY = "windows.zoom";

/**
 * One step is 10%, the ratio Yaak ships; VS Code's is 20%. Clamped so the
 * lowest setting is the unzoomed page: a data-grid product must not be zoomed
 * OUT, because 12px text at 0.75 renders at 9px, under the very Microsoft
 * legibility floor the Windows token block exists to enforce.
 */
const STEP = 1.1;
const MIN = 1;
const MAX = 1.5;

/**
 * Ctrl + / Ctrl − / Ctrl 0 zoom, on Windows only, remembered between launches.
 *
 * WHY IT EXISTS: Tauri defaults `zoomHotkeysEnabled` to false, overriding
 * WebView2's own default, so the client laptops have no way to enlarge the
 * app at all today. Every documented web-technology desktop peer offers user
 * zoom — VS Code, GitHub Desktop, Slack, Figma, 1Password, and the Tauri apps
 * that ship it own it in app code exactly like this, because Tauri exposes
 * `setZoom` but no getter and no change event, so a native hotkey would drift
 * from anything the app could remember.
 *
 * WHY WINDOWS ONLY: the Mac has no zoom today and must not change. Enabling
 * Tauri's hotkeys in the shared config would inject a script on macOS that
 * takes over Cmd+=, Cmd+- and Cmd+0. The gate here is `platform()`, read
 * directly from the os plugin rather than back out of the DOM attribute that
 * exists for CSS — one source of truth, not two.
 *
 * WHO APPLIES IT: on launch, Rust reads the same store key in `setup()` and
 * calls `set_zoom` before the page loads, so there is no first-frame jump.
 * This component only records the user's changes and applies them live.
 *
 * Mounted once inside the shell's KeyboardProvider, beside the command
 * palette, so the keys go through the shell's one shortcut registry rather
 * than a second keydown listener. On macOS every shortcut is registered with
 * `disabled: true`, which the provider treats as "never register".
 */
export function WindowsZoom() {
  const [enabled] = useState(() => isTauri() && platform() === "windows");
  const level = useRef(MIN);

  useEffect(() => {
    if (!enabled) return;
    // Start stepping from the level Rust already applied, not from 1 — or the
    // first Ctrl+= after a relaunch would snap the page back down.
    void import("@tauri-apps/plugin-store")
      .then(({ load }) => load(STORE_FILE))
      .then((store) => store.get<number>(STORE_KEY))
      .then((stored) => {
        if (typeof stored === "number" && stored >= MIN && stored <= MAX) level.current = stored;
      })
      .catch(() => {
        // A fresh install has no store yet. Nothing to restore is not an error.
      });
  }, [enabled]);

  const apply = async (next: number) => {
    // Two decimals: 1.1 compounded drifts into 1.3310000000000004 otherwise,
    // and the stored value is what the next launch restores.
    const clamped = Math.round(Math.min(MAX, Math.max(MIN, next)) * 100) / 100;
    level.current = clamped;
    try {
      // Dynamic, as the shell already imports @tauri-apps/api for the overlay
      // title bar: the module is never evaluated on a platform that does not
      // reach this line.
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(clamped);
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE);
      await store.set(STORE_KEY, clamped);
    } catch (error) {
      console.error("Could not change the zoom level:", error);
    }
  };

  // The provider normalises Ctrl to "cmd", so these read as Ctrl on Windows.
  // "=" is the unshifted key beside Backspace; "+" is Shift+= and the numpad.
  useShortcut("cmd+=", () => void apply(level.current * STEP), { disabled: !enabled });
  useShortcut("cmd++", () => void apply(level.current * STEP), { disabled: !enabled });
  useShortcut("cmd+shift++", () => void apply(level.current * STEP), { disabled: !enabled });
  useShortcut("cmd+-", () => void apply(level.current / STEP), { disabled: !enabled });
  useShortcut("cmd+0", () => void apply(MIN), { disabled: !enabled });

  return null;
}
