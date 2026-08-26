import * as React from "react";

const MOBILE_BREAKPOINT = 768;

function subscribe(onStoreChange: () => void): () => void {
  const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

/**
 * Whether the viewport is narrower than the mobile breakpoint.
 *
 * Reads the media query through `useSyncExternalStore` rather than seeding state from an effect:
 * the effect version had to call `setState` synchronously on mount to publish the first value,
 * which costs a second render pass on every consumer and is what `react-hooks/set-state-in-effect`
 * flags. The server snapshot reports false so the markup this package renders under Next stays
 * stable through hydration.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false
  );
}
