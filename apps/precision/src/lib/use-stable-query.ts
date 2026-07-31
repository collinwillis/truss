import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import { useRef } from "react";

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

const CACHE_LIMIT = 50;
const resultCache = new Map<string, unknown>();

function remember(key: string, value: unknown): void {
  resultCache.delete(key);
  resultCache.set(key, value);
  if (resultCache.size > CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
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
