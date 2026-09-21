/**
 * How far the last edit moved a figure.
 *
 * The flash says THAT a number moved; this says by how much, which is what an
 * estimator wants to know after changing a quantity. Pure, so the rules below
 * are stated by tests instead of discovered on a live bid.
 *
 * @module
 */

/** What the panel remembers between renders. */
export interface ChangeTrack {
  scopeKey: string;
  settled: boolean;
  value: number;
  /** The value before the current burst of edits began. */
  baseline: number;
  /** When the value last moved, in ms. `0` means it has not. */
  changedAt: number;
}

/** A change worth printing. */
export interface LastChange {
  from: number;
  to: number;
}

/** What one render saw. */
export interface ChangeInput {
  scopeKey: string;
  /** False while the figure is a stand-in for data still loading. */
  settled: boolean;
  value: number;
}

/** How long a run of edits counts as one change. */
export const BURST_MS = 1500;

/** Under half a cent is float noise from re-summing, not an edit. */
const NOISE = 0.005;

/** Begin tracking a figure. */
export function startTrack(input: ChangeInput): ChangeTrack {
  return { ...input, baseline: input.value, changedAt: 0 };
}

/**
 * Advance the track by one render.
 *
 * `change` is `undefined` when the printed change should be left as it is.
 *
 * - A NEW SCOPE, or figures that are or were a stand-in, reset everything. The
 *   stand-in case covers the render on which the real rows ARRIVE: that change
 *   was caused by the network, and reporting it as "+$41,000" would be a lie
 *   told in the largest type on the panel.
 * - Edits inside {@link BURST_MS} of each other share a baseline, so tabbing
 *   through five cells reports their net effect rather than the last cell's.
 * - A burst that returns to where it started reports nothing.
 */
export function advanceTrack(
  track: ChangeTrack,
  input: ChangeInput,
  now: number
): { track: ChangeTrack; change: LastChange | null | undefined } {
  if (track.scopeKey !== input.scopeKey || !input.settled || !track.settled) {
    return { track: startTrack(input), change: null };
  }
  if (track.value === input.value) return { track, change: undefined };

  const inBurst = track.changedAt !== 0 && now - track.changedAt < BURST_MS;
  const baseline = inBurst ? track.baseline : track.value;
  return {
    track: { ...input, baseline, changedAt: now },
    change: Math.abs(input.value - baseline) < NOISE ? null : { from: baseline, to: input.value },
  };
}
