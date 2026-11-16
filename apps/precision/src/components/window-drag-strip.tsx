import type { JSX } from "react";

/**
 * An invisible strip at title-bar height that keeps the window movable.
 *
 * The window uses macOS Overlay title-bar style, so screens rendered OUTSIDE
 * the shell (loading, sign-in, the access wall) have no native bar to grab.
 * Place it inside a `relative` container.
 */
export function WindowDragStrip(): JSX.Element {
  return <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-50 h-11" />;
}
