/**
 * Repairing an estimate line's link to the catalog.
 *
 * The scenario every test here is built on is not hypothetical. The legacy
 * equipment catalog was edited in place for three years — `equipment_v2.json`
 * went from 122 rows to 133, `equipment.json` from 135 to 129 — with rows
 * inserted mid-list, so ids below an insertion slid down. Exactly one of the
 * 122 rows in the July-2025 v2 file is still at its own id today.
 *
 * So the tests shift the real catalog the way a spreadsheet insertion shifts
 * it, and assert that a line's own description finds it again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCatalogIndex,
  countResolution,
  emptyTally,
  linkKey,
  resolveActivityLink,
  type ActivityLink,
  type CatalogItem,
} from "../convex/model/activityLinks";

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const read = (file: string) =>
  JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Array<Record<string, unknown>>;

const equipmentCatalog = (): CatalogItem[] =>
  read("equipment_v1.json").map((r) => ({
    poolId: Number(r.id),
    description: String(r.description),
    numbers: [
      Number(r.hourRate ?? 0),
      Number(r.dayRate ?? 0),
      Number(r.weekRate ?? 0),
      Number(r.monthRate ?? 0),
    ],
  }));

const laborCatalog = (): CatalogItem[] =>
  read("labor_v1.json").map((r) => ({
    poolId: Number(r.id),
    description: String(r.description),
    phasePoolId: Number(r.phaseDatabaseId),
    numbers: [Number(r.craftConstant ?? 0), Number(r.weldConstant ?? 0)],
  }));

const equipmentLine = (over: Partial<ActivityLink>): ActivityLink => ({
  type: "equipment",
  description: "CRANES - ROUGH TERRAIN 35 TO 50 TON",
  currentPoolId: 28,
  numbers: [9120],
  ...over,
});

describe("a line finds its item again after the ids slid", () => {
  it("re-points every shifted equipment line to what it actually describes", () => {
    const catalog = equipmentCatalog();
    const index = buildCatalogIndex(catalog);

    // Exactly what inserting six rows near the top of the sheet did: the
    // descriptions stayed put and every id below slid by six.
    const tally = emptyTally();
    const wrongTargets: string[] = [];
    for (const item of catalog) {
      const line = equipmentLine({
        description: item.description,
        currentPoolId: item.poolId - 6,
        numbers: item.numbers,
      });
      const resolution = resolveActivityLink(line, index);
      countResolution(tally, resolution);
      if (resolution.verdict === "relink" && resolution.poolId !== item.poolId) {
        wrongTargets.push(`${item.description} -> ${resolution.poolId}`);
      }
    }

    // Named, not counted, so a failure says WHICH item went to the wrong place.
    expect(wrongTargets.slice(0, 3)).toEqual([]);
    expect(tally.ambiguous).toBe(0);
    expect(tally.noMatch).toBe(0);
    expect(tally.relinked).toBe(catalog.length);
    // All but one corroborated: the line carries the rate the catalog holds,
    // which is what makes this repair safe rather than merely plausible. The
    // exception is UNIQUE EQUIPMENT, the catch-all row whose four rates are all
    // zero — nothing can corroborate against it, and nothing should.
    expect(tally.nameOnly).toBe(1);
    expect(tally.corroborated).toBe(catalog.length - 1);
  });

  it("leaves a line alone when the link is already right", () => {
    const catalog = equipmentCatalog();
    const index = buildCatalogIndex(catalog);
    const item = catalog[10] as CatalogItem;
    const resolution = resolveActivityLink(
      equipmentLine({
        description: item.description,
        currentPoolId: item.poolId,
        numbers: item.numbers,
      }),
      index
    );
    expect(resolution.verdict).toBe("already_correct");
    expect(resolution.poolId).toBeUndefined();
  });
});

describe("what it refuses to guess at", () => {
  it("leaves an item that is no longer in the catalog exactly as it is", () => {
    // Real: 'WELDING MACHINE - PORTABLE' at id 133 exists in no revision of the
    // list that survives, because the file it came from was edited away.
    const resolution = resolveActivityLink(
      equipmentLine({ description: "WELDING MACHINE - PORTABLE", currentPoolId: 133 }),
      buildCatalogIndex(equipmentCatalog())
    );
    expect(resolution.verdict).toBe("no_match");
    expect(resolution.poolId).toBeUndefined();
    expect(resolution.reason).toContain("left as it is");
  });

  it("refuses when two catalog items answer to the same name", () => {
    const index = buildCatalogIndex([
      { poolId: 1, description: "MANLIFT 60", numbers: [10] },
      { poolId: 2, description: "MANLIFT 60", numbers: [20] },
    ]);
    const resolution = resolveActivityLink(
      equipmentLine({ description: "MANLIFT 60", currentPoolId: 99 }),
      index
    );
    expect(resolution.verdict).toBe("ambiguous");
    expect(resolution.poolId).toBeUndefined();
  });

  it("does not invent a link for a custom line", () => {
    const index = buildCatalogIndex(equipmentCatalog());
    for (const type of ["custom_labor", "material", "subcontractor", "cost_only"]) {
      expect(resolveActivityLink(equipmentLine({ type }), index).verdict).toBe("not_applicable");
    }
    // A line that never carried a link is the estimator writing their own item.
    expect(resolveActivityLink(equipmentLine({ currentPoolId: undefined }), index).verdict).toBe(
      "not_applicable"
    );
  });
});

describe("labor is scoped to its phase", () => {
  it("finds the item under the phase the line actually sits in", () => {
    const catalog = laborCatalog();
    const index = buildCatalogIndex(catalog);
    const item = catalog[400] as CatalogItem;

    const found = resolveActivityLink(
      {
        type: "labor",
        description: item.description,
        currentPoolId: item.poolId - 455,
        phasePoolId: item.phasePoolId,
        numbers: item.numbers,
      },
      index
    );
    expect(found.verdict).toBe("relink");
    expect(found.poolId).toBe(item.poolId);
  });

  it("will not reach into another phase for a same-named item", () => {
    // 'CUT - 2' under carbon steel and under stainless are different work with
    // different constants. An unscoped key would collide them.
    const index = buildCatalogIndex([
      { poolId: 10, description: "CUT - 2", phasePoolId: 70001, numbers: [0.5] },
      { poolId: 20, description: "CUT - 2", phasePoolId: 70002, numbers: [0.9] },
    ]);
    const resolution = resolveActivityLink(
      {
        type: "labor",
        description: "CUT - 2",
        currentPoolId: 999,
        phasePoolId: 70002,
        numbers: [0.9],
      },
      index
    );
    expect(resolution.verdict).toBe("relink");
    expect(resolution.poolId).toBe(20);
  });

  it("keys a phase-scoped item separately from a global one", () => {
    expect(linkKey("CUT - 2", 70001)).not.toBe(linkKey("CUT - 2"));
  });
});

describe("corroboration is reported, never a gate", () => {
  it("still relinks a line whose constant the estimator overrode", () => {
    // 16% of live labor lines carry a constant that is not the catalog's.
    // Refusing to fix their link because they used a feature would be absurd.
    const index = buildCatalogIndex([
      { poolId: 4690, description: "BASE SUPPORT (3 - 10)", phasePoolId: 70001, numbers: [3.75] },
    ]);
    const resolution = resolveActivityLink(
      {
        type: "labor",
        description: "BASE SUPPORT (3 - 10)",
        currentPoolId: 4684,
        phasePoolId: 70001,
        numbers: [5.75],
      },
      index
    );
    expect(resolution.verdict).toBe("relink");
    expect(resolution.poolId).toBe(4690);
    expect(resolution.confidence).toBe("name_only");
  });

  it("corroborates on ANY rate, because a line uses one of the four", () => {
    // An equipment line taken by the month carries the month rate and nothing
    // else. Demanding all four agree would make corroboration impossible for
    // every equipment line in the system.
    const index = buildCatalogIndex([
      { poolId: 28, description: "CRANE", numbers: [230, 1840, 6440, 9120] },
    ]);
    const byMonth = resolveActivityLink(
      equipmentLine({ description: "CRANE", currentPoolId: 22, numbers: [9120] }),
      index
    );
    expect(byMonth.confidence).toBe("corroborated");
  });

  it("does not let a zero corroborate anything", () => {
    // 'UNIQUE EQUIPMENT' carries 0 in all four rates, so a zero on a line
    // would otherwise "agree" with every catch-all row in the catalog.
    const index = buildCatalogIndex([{ poolId: 0, description: "UNIQUE", numbers: [0, 0, 0, 0] }]);
    const resolution = resolveActivityLink(
      equipmentLine({ description: "UNIQUE", currentPoolId: 5, numbers: [0] }),
      index
    );
    expect(resolution.confidence).toBe("name_only");
  });
});

describe("the tally is what a person reads afterwards", () => {
  it("splits a repair into the four things that can happen to a line", () => {
    const index = buildCatalogIndex([
      { poolId: 7, description: "PUMP", numbers: [100] },
      { poolId: 8, description: "TWIN", numbers: [1] },
      { poolId: 9, description: "TWIN", numbers: [2] },
    ]);
    const tally = emptyTally();
    for (const line of [
      equipmentLine({ description: "PUMP", currentPoolId: 3, numbers: [100] }),
      equipmentLine({ description: "PUMP", currentPoolId: 7, numbers: [100] }),
      equipmentLine({ description: "GONE", currentPoolId: 4 }),
      equipmentLine({ description: "TWIN", currentPoolId: 5 }),
      equipmentLine({ type: "material", description: "PIPE", currentPoolId: 1 }),
    ]) {
      countResolution(tally, resolveActivityLink(line, index));
    }
    expect(tally).toEqual({
      examined: 5,
      alreadyCorrect: 1,
      relinked: 1,
      corroborated: 1,
      nameOnly: 0,
      noMatch: 1,
      ambiguous: 1,
      notApplicable: 1,
    });
  });
});

describe("the plural the two equipment files disagreed about", () => {
  // The older list says LIFT/GENERATOR/MONITOR where today's says
  // LIFTS/GENERATORS/MONITORS. Measured live, folding that plural recovers 667
  // of 2,196 unmatched equipment lines with zero collisions in the catalog.
  const catalog: CatalogItem[] = [
    { poolId: 61, description: "LIFTS - MANLIFT 60'", numbers: [2290] },
    { poolId: 40, description: "GENERATORS - 5000W", numbers: [768] },
    { poolId: 72, description: "MONITORS - 4 GAS PERSONAL", numbers: [24] },
    { poolId: 14, description: "COMPACTOR - VIBRATORY SHEEPSFOOT WALK BEHIND", numbers: [2088] },
  ];

  it("finds LIFTS - MANLIFT 60' for a line that says LIFT - MANLIFT 60'", () => {
    const resolution = resolveActivityLink(
      equipmentLine({ description: "LIFT - MANLIFT 60'", currentPoolId: 57, numbers: [2290] }),
      buildCatalogIndex(catalog)
    );
    expect(resolution.verdict).toBe("relink");
    expect(resolution.poolId).toBe(61);
    // Flagged, so a report can separate the exact matches from the relaxed.
    expect(resolution.matchedBy).toBe("name_relaxed");
  });

  it("prefers the exact name and never consults the relaxed pass over it", () => {
    const index = buildCatalogIndex([
      { poolId: 1, description: "LIFT - MANLIFT 60'", numbers: [1] },
      { poolId: 2, description: "LIFTS - MANLIFT 60'", numbers: [2] },
    ]);
    const resolution = resolveActivityLink(
      equipmentLine({ description: "LIFT - MANLIFT 60'", currentPoolId: 99, numbers: [1] }),
      index
    );
    expect(resolution.poolId).toBe(1);
    expect(resolution.matchedBy).toBe("name");
  });

  it("still refuses a genuine rewording, which is not a plural", () => {
    // 'COMPACTOR - VIBRATORY SHEEPSFOOT' vs '... SHEEPSFOOT WALK BEHIND': the
    // suffix changed, and no amount of folding should make that a match.
    const resolution = resolveActivityLink(
      equipmentLine({ description: "COMPACTOR - VIBRATORY SHEEPSFOOT", currentPoolId: 14 }),
      buildCatalogIndex(catalog)
    );
    expect(resolution.verdict).toBe("no_match");
  });

  it("does NOT relax labor, whose prefix is an operation code", () => {
    // 'CUTS' and 'CUT' are not a category pluralised, and treating them as one
    // would be a guess with nothing behind it.
    const index = buildCatalogIndex([
      { poolId: 10, description: "CUTS - 40", phasePoolId: 70001, numbers: [0.5] },
    ]);
    const resolution = resolveActivityLink(
      {
        type: "labor",
        description: "CUT - 40",
        currentPoolId: 9,
        phasePoolId: 70001,
        numbers: [0.5],
      },
      index
    );
    expect(resolution.verdict).toBe("no_match");
  });

  it("puts both spellings in one relaxed bucket, so a collision is refusable", () => {
    // The guarantee that makes the relaxed pass safe: folding can only ever
    // merge names, and a merged bucket holds more than one item, which
    // resolveActivityLink refuses. It cannot silently pick one.
    const index = buildCatalogIndex([
      { poolId: 1, description: "TRUCK - PICKUP", numbers: [88] },
      { poolId: 2, description: "TRUCKS - PICKUP", numbers: [1056] },
    ]);
    expect(index.relaxed.get("TRUCK - PICKUP")).toHaveLength(2);
    expect(index.exact.get("TRUCK - PICKUP")).toHaveLength(1);
  });

  it("refuses a line that reaches a merged bucket rather than picking one", () => {
    const index = buildCatalogIndex([
      { poolId: 1, description: "TRUCKS - PICKUP", numbers: [88] },
      { poolId: 2, description: "TRUCKS - PICKUP", numbers: [1056] },
    ]);
    const resolution = resolveActivityLink(
      equipmentLine({ description: "TRUCKS - PICKUP", currentPoolId: 5, numbers: [88] }),
      index
    );
    expect(resolution.verdict).toBe("ambiguous");
  });
});
