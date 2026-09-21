import { describe, expect, it } from "vitest";
import { advanceTrack, BURST_MS, startTrack, type ChangeInput } from "./last-change";

const at = (value: number, over: Partial<ChangeInput> = {}): ChangeInput => ({
  scopeKey: "phase-a",
  settled: true,
  value,
  ...over,
});

describe("advanceTrack", () => {
  it("reports an edit as from and to", () => {
    const { change } = advanceTrack(startTrack(at(1000)), at(1250), 10_000);
    expect(change).toEqual({ from: 1000, to: 1250 });
  });

  it("leaves the printed change alone when nothing moved", () => {
    const track = startTrack(at(1000));
    expect(advanceTrack(track, at(1000), 10_000).change).toBeUndefined();
  });

  it("merges a burst of edits into their net effect", () => {
    let step = advanceTrack(startTrack(at(1000)), at(1100), 10_000);
    step = advanceTrack(step.track, at(1300), 10_000 + BURST_MS - 1);
    expect(step.change).toEqual({ from: 1000, to: 1300 });
  });

  it("starts a new baseline once the burst is over", () => {
    let step = advanceTrack(startTrack(at(1000)), at(1100), 10_000);
    step = advanceTrack(step.track, at(1300), 10_000 + BURST_MS + 1);
    expect(step.change).toEqual({ from: 1100, to: 1300 });
  });

  it("reports nothing for a burst that ends where it began", () => {
    let step = advanceTrack(startTrack(at(1000)), at(1100), 10_000);
    step = advanceTrack(step.track, at(1000), 10_500);
    expect(step.change).toBeNull();
  });

  it("treats re-summing noise as no change", () => {
    const { change } = advanceTrack(startTrack(at(1000)), at(1000.0000001), 10_000);
    expect(change).toBeNull();
  });

  it("resets silently when the scope changes", () => {
    const { change, track } = advanceTrack(
      startTrack(at(1000)),
      at(88_000, { scopeKey: "phase-b" }),
      10_000
    );
    expect(change).toBeNull();
    expect(track.baseline).toBe(88_000);
  });

  it("never reports the render on which real rows replace a stand-in", () => {
    // Navigation: the previous phase's rows stand in for one round trip.
    let step = advanceTrack(startTrack(at(1000)), at(1000, { settled: false }), 10_000);
    expect(step.change).toBeNull();
    // The real rows land. The number moves, and no edit moved it.
    step = advanceTrack(step.track, at(41_000), 10_100);
    expect(step.change).toBeNull();
    // From here on an edit is an edit again.
    step = advanceTrack(step.track, at(41_500), 20_000);
    expect(step.change).toEqual({ from: 41_000, to: 41_500 });
  });
});
