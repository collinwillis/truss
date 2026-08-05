/**
 * The WBS cost report's column rules.
 *
 * The piping rule is the load-bearing decision on this screen: six columns
 * appear on three breakdowns out of eighteen, and getting it from the DATA
 * rather than from the breakdown's code would make the report change shape
 * from bid to bid. Every case below is one an estimator can actually land on.
 */
import { describe, expect, it } from "vitest";
import {
  autoVisibility,
  mergeVisibility,
  pruneOverrides,
  summarizeContents,
  type PhaseContentSample,
} from "./visibility";

const AG_PIPING = 70000;
const INSULATION = 100000;
const BG_PIPING = 130000;
const CONCRETE = 30000;

/** A phase with nothing in it — every field the report reads, empty. */
function phase(overrides: Partial<PhaseContentSample> = {}): PhaseContentSample {
  return {
    area: null,
    sheet: null,
    status: null,
    pipingSpec: null,
    takeoff: null,
    costs: {
      craftManHours: 0,
      welderManHours: 0,
      craftCost: 0,
      welderCost: 0,
      materialCost: 0,
      equipmentCost: 0,
      subcontractorCost: 0,
      costOnlyCost: 0,
    },
    ...overrides,
  };
}

const PIPING_COLUMNS = ["size", "flc", "spec", "insulation", "insulationSize", "sheet"] as const;

describe("the piping rule", () => {
  it("carries all six columns on a piping breakdown with nothing filled in yet", () => {
    // A fresh estimate: the phases exist, the specs have not been typed. The
    // report is still defined to have these columns.
    const visibility = autoVisibility(AG_PIPING, summarizeContents([phase(), phase()]));
    for (const id of PIPING_COLUMNS) expect(visibility[id]).toBe(true);
  });

  it("carries them on all three of the client's breakdowns and on no others", () => {
    const empty = summarizeContents([phase()]);
    for (const code of [AG_PIPING, INSULATION, BG_PIPING]) {
      expect(autoVisibility(code, empty).spec).toBe(true);
    }
    expect(autoVisibility(CONCRETE, empty).spec).toBe(false);
  });

  it("still shows a stray spec sitting under a breakdown that is not piping", () => {
    // Legacy imports do exactly this. Data may REVEAL; it may not conceal, so
    // nothing on a phase is ever invisible.
    const visibility = autoVisibility(
      CONCRETE,
      summarizeContents([phase(), phase({ pipingSpec: { spec: "A106" } })])
    );
    expect(visibility.spec).toBe(true);
    // ...and reveals only the column that actually holds something.
    expect(visibility.size).toBe(false);
    expect(visibility.flc).toBe(false);
  });

  it("does not let an unfilled spec take a piping breakdown's column away", () => {
    // The AND the activity grid uses would hide it here, which is why this
    // module composes the two layers with OR.
    const visibility = autoVisibility(BG_PIPING, summarizeContents([phase()]));
    expect(visibility.insulation).toBe(true);
  });

  it("treats a blank string as no value, not as a value", () => {
    const visibility = autoVisibility(
      CONCRETE,
      summarizeContents([phase({ pipingSpec: { size: "   " } })])
    );
    expect(visibility.size).toBe(false);
  });
});

describe("the data gate", () => {
  it("stands the unused money columns down on a labor-only breakdown", () => {
    const visibility = autoVisibility(
      AG_PIPING,
      summarizeContents([
        phase({
          costs: {
            craftManHours: 12,
            welderManHours: 4,
            craftCost: 900,
            welderCost: 300,
            materialCost: 0,
            equipmentCost: 0,
            subcontractorCost: 0,
            costOnlyCost: 0,
          },
        }),
      ])
    );

    expect(visibility.materialCost).toBe(false);
    expect(visibility.equipmentCost).toBe(false);
    expect(visibility.subcontractorCost).toBe(false);
    expect(visibility.costOnlyCost).toBe(false);
    // What it DOES carry, including the labor total the two halves add to.
    expect(visibility.craftHours).toBe(true);
    expect(visibility.craftCost).toBe(true);
    expect(visibility.welderCost).toBe(true);
    expect(visibility.laborTotal).toBe(true);
  });

  it("hides the welder pair where nobody welds", () => {
    const visibility = autoVisibility(
      200000,
      summarizeContents([
        phase({
          costs: {
            craftManHours: 40,
            welderManHours: 0,
            craftCost: 2000,
            welderCost: 0,
            materialCost: 0,
            equipmentCost: 0,
            subcontractorCost: 0,
            costOnlyCost: 0,
          },
        }),
      ])
    );
    expect(visibility.welderHours).toBe(false);
    expect(visibility.welderCost).toBe(false);
    // The labor total survives on craft alone — it is still labor.
    expect(visibility.laborTotal).toBe(true);
  });

  it("keeps quantity and unit together, and stands both down where nothing is measured", () => {
    const unmeasured = autoVisibility(AG_PIPING, summarizeContents([phase(), phase()]));
    expect(unmeasured.quantity).toBe(false);
    expect(unmeasured.unit).toBe(false);

    const measured = autoVisibility(
      AG_PIPING,
      summarizeContents([
        phase(),
        phase({ takeoff: { quantity: 0, unit: "LF", isOverridden: false } }),
      ])
    );
    // A derived ZERO is still a measurement — the column has something to say.
    expect(measured.quantity).toBe(true);
    expect(measured.unit).toBe(true);
  });
});

describe("the estimator's overrides", () => {
  it("remembers only what disagrees with the automatic answer", () => {
    const auto = autoVisibility(AG_PIPING, summarizeContents([phase()]));
    // Turn off a piping column the report gave them, turn on a money column
    // the data stood down.
    const merged = mergeVisibility(auto, { flc: false, materialCost: true });
    const pruned = pruneOverrides(auto, merged);

    expect(pruned).toEqual({ flc: false, materialCost: true });
  });

  it("lets a column the estimator never touched follow the data", () => {
    const before = autoVisibility(AG_PIPING, summarizeContents([phase()]));
    const stored = pruneOverrides(before, mergeVisibility(before, { flc: false }));

    // A subcontractor is priced into the breakdown next week.
    const after = autoVisibility(
      AG_PIPING,
      summarizeContents([
        phase({
          costs: {
            craftManHours: 0,
            welderManHours: 0,
            craftCost: 0,
            welderCost: 0,
            materialCost: 0,
            equipmentCost: 0,
            subcontractorCost: 5000,
            costOnlyCost: 0,
          },
        }),
      ])
    );

    const visible = mergeVisibility(after, stored);
    expect(visible.subcontractorCost).toBe(true);
    // ...while the one choice they DID make survives.
    expect(visible.flc).toBe(false);
  });
});
