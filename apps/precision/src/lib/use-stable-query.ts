import { useQuery, type ConvexReactClient, type OptionalRestArgsOrSkip } from "convex/react";
import {
  getFunctionName,
  type FunctionReference,
  type FunctionReturnType,
  type OptionalRestArgs,
} from "convex/server";
import { useMemo, useRef } from "react";

/**
 * `useQuery` with stale-while-loading — the fix for the blink.
 *
 * Convex's `useQuery` returns `undefined` the moment its arguments change
 * (a new WBS id is a new subscription), so every navigation dropped the
 * screen to a skeleton and popped back ~100ms later. This wrapper keeps the
 * last real result rendered until the fresh one arrives — the
 * `keepPreviousData` pattern — so transitions swap in place.
 *
 * Two layers, covering the two ways the blink happened:
 *  - A PER-INSTANCE ref: navigating between siblings (WBS → WBS) keeps the
 *    previous sibling's rows for the brief swap window.
 *  - A MODULE-LEVEL LRU keyed by function + args: returning to a screen you
 *    already visited renders its data instantly even though the component
 *    remounted and the ref was lost. Capped so 2,000 phase visits cannot
 *    hoard memory.
 *
 * Skeletons still show on a genuine first load — there is honestly nothing
 * to render then.
 */

// Sized for prefetching: hovering across a large WBS warms 2 keys per phase,
// and a visit uses ~5, so 150 keeps roughly the last 30 screens warm. Entries
// are query results for single screens — small.
const CACHE_LIMIT = 150;
const resultCache = new Map<string, unknown>();
const inflightWarms = new Set<string>();

function remember(key: string, value: unknown): void {
  resultCache.delete(key);
  resultCache.set(key, value);
  if (resultCache.size > CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
}

/**
 * Prefetch a query result into the stale-while-loading cache.
 *
 * The stale layer cannot help a screen that has NEVER run its queries —
 * drilling from a WBS into a phase mounts a fresh route whose per-phase
 * queries are cold, so the skeleton still flashed there. Warming on INTENT
 * (row hover, neighbor-in-sequence) wins the race: hover-to-click dwell is
 * longer than the round-trip, so the screen mounts already populated.
 *
 * Best-effort by design: a failed or too-late warm just means the normal
 * skeleton path. Resolves with the result so call sites can chain dependent
 * warms (estimate → its first WBS). The cache key must match
 * `useStableQuery`'s exactly, so args objects here must be written with the
 * same property order as the corresponding hook call.
 */
export function warmQuery<Query extends FunctionReference<"query">>(
  client: ConvexReactClient,
  query: Query,
  ...args: OptionalRestArgs<Query>
): Promise<FunctionReturnType<Query> | undefined> {
  const key = JSON.stringify([getFunctionName(query), args]);

  // In-flight dedupe only — a cached entry is deliberately NOT served here.
  // A warmed snapshot has no subscription refreshing it, so treating it as
  // fresh on renewed intent would pin pre-mutation data until LRU eviction;
  // refetching bounds staleness by the last hover instead.
  if (inflightWarms.has(key)) return Promise.resolve(undefined);

  inflightWarms.add(key);
  // The call is deferred into the chain because client.query can throw
  // SYNCHRONOUSLY (a live same-key subscription whose latest result is an
  // error) — the catch/finally must cover that path too, or the key wedges
  // in the in-flight set and silently disables warming it for the session.
  return Promise.resolve()
    .then(() => client.query(query, ...args))
    .then((result) => {
      remember(key, result);
      return result;
    })
    .catch(() => undefined)
    .finally(() => inflightWarms.delete(key));
}

/**
 * Debounce warms behind ~80ms of hover dwell, so sweeping the cursor across
 * a long table doesn't fire a query per row crossed — only a rested cursor
 * signals intent. One shared timer is enough: hover is exclusive, so queuing
 * a new row cancels the previous row's pending warm.
 */
export function useWarmOnIntent(delayMs = 80): {
  queue: (warm: () => void) => void;
  cancel: () => void;
} {
  const timer = useRef<number | null>(null);
  return useMemo(
    () => ({
      queue: (warm: () => void) => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = window.setTimeout(warm, delayMs);
      },
      cancel: () => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      },
    }),
    [delayMs]
  );
}

export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
): FunctionReturnType<Query> | undefined {
  const result = useQuery(query, ...args);
  const lastShown = useRef<FunctionReturnType<Query> | undefined>(undefined);

  // Skipped queries genuinely have no data — show none.
  if (args[0] === "skip") return undefined;

  const key = JSON.stringify([getFunctionName(query), args]);

  if (result !== undefined) {
    remember(key, result);
    lastShown.current = result;
    return result;
  }

  // Loading: prefer this exact query's cached result (correct data,
  // instant), else whatever this component last rendered (previous sibling,
  // right shape, swaps within the round-trip).
  const cached = resultCache.get(key) as FunctionReturnType<Query> | undefined;
  if (cached !== undefined) {
    lastShown.current = cached;
    return cached;
  }
  return lastShown.current;
}
