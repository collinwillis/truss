/**
 * The repricing benchmark, tested against what the production data actually
 * looks like rather than against what a catalog ought to look like.
 *
 * The numbers in these names are measured, not illustrative:
 *
 *   92% / 8%    of 4,015 sampled labor lines point at a catalog row whose
 *               description matches the line — and 326 do not.
 *   84% / 16%   still carry the catalog's craftConstant verbatim; 640 were
 *               typed over by an estimator.
 *   16% / 81%   of 245 sampled equipment lines are corroborated; 199 point at
 *               an entirely different item.
 *   4,149       of the 5,897 labor rows carry a blank `weldUnits` beside a zero
 *               `weldConstant`, and 134 carry a zero `craftConstant`. Both
 *               shapes decide a rule below.
 *
 * Every catalog row below is READ from `fixtures/legacy-pools/` — labor 1527,
 * 1524, 1526 and 61, equipment 5 and 61, as book #1 ships them — rather than
 * hand-copied into a literal that a fixture change could no longer contradict.
 * An activity's snapshot is built from the row it names, the way picking a
 * catalog item builds one, so a test that passes here is a test that passes on
 * their data. Where a test needs a value the shipped row does not carry — a
 * draft's new constant, a welder leg that differs from its craft leg — it says
 * so with `withLabor`/`withEquipment` at the point it does it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { round2, roundCosts, type ActivityType } from "../convex/model/costEngine";
import { rollUpProposal } from "../convex/model/proposalTotals";
import {
  accumulateProposal,
  benchmarkCaveats,
  benchmarkProposal,
  classifyLaborLine,
  counterfactualActivity,
  emptyBenchmarkAccumulator,
  equipmentRateFacts,
  finalizeBenchmark,
  reviveAccumulator,
  serializeAccumulator,
  traceEquipmentLine,
  CARRIED_BUCKET_PHRASES,
  SAMPLED_DESCRIPTION_CORROBORATED,
  type BenchmarkAccumulator,
  type BenchmarkAccumulatorSnapshot,
  type BenchmarkActivity,
  type BenchmarkReport,
  type CarriedBucket,
  type EquipmentCatalog,
  type EquipmentCatalogRow,
  type LaborCatalog,
  type LaborCatalogRow,
  type ProposalBenchmarkInput,
  type ProposalBenchmarkResult,
} from "../convex/model/repriceBenchmark";
import { RATES_2020, RATES_ALL_ZERO } from "./rates";

// ---------------------------------------------------------------------------
// Catalog fixtures — real rows, read out of book #1's shipped files
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");

const readPool = (file: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Array<Record<string, unknown>>;

const LABOR_V1 = readPool("labor_v1.json");
const EQUIPMENT_V1 = readPool("equipment_v1.json");

function fixtureRow(
  rows: Array<Record<string, unknown>>,
  file: string,
  poolId: number
): Record<string, unknown> {
  const row = rows.find((candidate) => candidate.id === poolId);
  if (!row) throw new Error(`${file} carries no row ${poolId}`);
  return row;
}

/**
 * One shipped labor row as the benchmark sees it.
 *
 * `isActive` is true because the legacy files carry no such column: every row in
 * them was offered. Retirement is something a draft does, and the tests that
 * care about it say so at the point they do it.
 */
function laborFixture(poolId: number): LaborCatalogRow {
  const row = fixtureRow(LABOR_V1, "labor_v1.json", poolId);
  return {
    poolId,
    description: String(row.description),
    craftConstant: Number(row.craftConstant),
    weldConstant: Number(row.weldConstant),
    craftUnits: String(row.craftUnits),
    weldUnits: String(row.weldUnits),
    isActive: true,
  };
}

/** One shipped equipment row, with the same reading of `isActive`. */
function equipmentFixture(poolId: number): EquipmentCatalogRow {
  const row = fixtureRow(EQUIPMENT_V1, "equipment_v1.json", poolId);
  return {
    poolId,
    description: String(row.description),
    hourRate: Number(row.hourRate),
    dayRate: Number(row.dayRate),
    weekRate: Number(row.weekRate),
    monthRate: Number(row.monthRate),
    isActive: true,
  };
}

const FSW_1 = laborFixture(1527);
const FSW_3 = laborFixture(1524);
/** A third item under the same phase, for the runs that need three ids at once. */
const FSW_1_5 = laborFixture(1526);
const AIR_BREAKER = equipmentFixture(5);
const MANLIFT_60 = equipmentFixture(61);
/** Labor 61 and equipment 61 are different items. Two pools, one id space. */
const TRUCK_4_MILE = laborFixture(61);

const laborBook = (...rows: LaborCatalogRow[]): LaborCatalog =>
  new Map(rows.map((row) => [row.poolId, row]));

const equipmentBook = (...rows: EquipmentCatalogRow[]): EquipmentCatalog =>
  new Map(rows.map((row) => [row.poolId, row]));

const withLabor = (row: LaborCatalogRow, over: Partial<LaborCatalogRow>): LaborCatalogRow => ({
  ...row,
  ...over,
});

const withEquipment = (
  row: EquipmentCatalogRow,
  over: Partial<EquipmentCatalogRow>
): EquipmentCatalogRow => ({ ...row, ...over });

// ---------------------------------------------------------------------------
// Activity fixtures
// ---------------------------------------------------------------------------

/** A labor line created by picking catalog item 1527, with its snapshot intact. */
function fswLine(over: Partial<BenchmarkActivity> = {}): BenchmarkActivity {
  return {
    type: "labor",
    wbsId: "wbs_ag_piping",
    description: FSW_1.description,
    quantity: 100,
    laborPoolId: FSW_1.poolId,
    labor: { craftConstant: FSW_1.craftConstant, welderConstant: FSW_1.weldConstant },
    ...over,
  };
}

/** An equipment line held one week at book #1's week rate for item 5. */
function breakerLine(over: Partial<BenchmarkActivity> = {}): BenchmarkActivity {
  return {
    type: "equipment",
    wbsId: "wbs_ag_piping",
    description: AIR_BREAKER.description,
    quantity: 1,
    equipmentPoolId: AIR_BREAKER.poolId,
    unitPrice: AIR_BREAKER.weekRate,
    equipment: { ownership: "rental", time: 1 },
    ...over,
  };
}

function plainLine(type: ActivityType, over: Partial<BenchmarkActivity>): BenchmarkActivity {
  return {
    type,
    wbsId: "wbs_ag_piping",
    description: "line",
    quantity: 1,
    ...over,
  };
}

function run(over: Partial<ProposalBenchmarkInput> = {}): ProposalBenchmarkResult {
  return benchmarkProposal({
    proposalNumber: "2020",
    rates: RATES_2020,
    activities: [fswLine()],
    parentLabor: laborBook(FSW_1),
    draftLabor: laborBook(withLabor(FSW_1, { craftConstant: 0.9 })),
    parentEquipment: equipmentBook(AIR_BREAKER),
    draftEquipment: equipmentBook(AIR_BREAKER),
    ...over,
  });
}

function report(
  results: readonly ProposalBenchmarkResult[],
  over: Partial<Parameters<typeof finalizeBenchmark>[0]> = {}
): BenchmarkReport {
  const acc = emptyBenchmarkAccumulator();
  for (const result of results) accumulateProposal(acc, result);
  return finish(acc, over);
}

function finish(
  acc: BenchmarkAccumulator,
  over: Partial<Parameters<typeof finalizeBenchmark>[0]> = {}
): BenchmarkReport {
  return finalizeBenchmark({
    acc,
    changedLaborPoolIds: [1527],
    changedEquipmentPoolIds: [],
    equipmentFacts: equipmentRateFacts(equipmentBook(AIR_BREAKER), equipmentBook(AIR_BREAKER)),
    laborReach: new Map<number, number>(),
    equipmentReach: new Map<number, number>(),
    reachAvailable: true,
    excludedProposals: [],
    parentBookName: "Original Rate Book",
    basedOnContentRevision: 47,
    triggeredBy: "collin",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    activityDocumentsRead: 1,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The fixtures themselves
// ---------------------------------------------------------------------------

describe("the catalog rows these tests price against, as book #1 ships them", () => {
  it("reads labor 1527 as FSW - 1 at 0.7/0.7 EA and equipment 5 as 7/56/224/672", () => {
    expect(FSW_1).toEqual({
      poolId: 1527,
      description: "FSW - 1",
      craftConstant: 0.7,
      weldConstant: 0.7,
      craftUnits: "EA",
      weldUnits: "EA",
      isActive: true,
    });
    expect(FSW_3.description).toBe("FSW - 3");
    expect(FSW_3.craftConstant).toBe(1.5);
    expect(AIR_BREAKER.description).toBe("BREAKERS - AIR BREAKER 30 LBS");
    expect([
      AIR_BREAKER.hourRate,
      AIR_BREAKER.dayRate,
      AIR_BREAKER.weekRate,
      AIR_BREAKER.monthRate,
    ]).toEqual([7, 56, 224, 672]);
    expect(MANLIFT_60.description).toBe("LIFTS - MANLIFT 60'");
  });

  it("carries 5,897 labor rows, 4,149 with a blank weldUnits and 134 with a zero craftConstant", () => {
    // Both shapes decide a rule: the blank weld leg is why a unit that appears
    // beside no hours is not `unit_redefined`, and the zero craft constant is
    // why an estimate can have a $0 baseline and a real delta.
    expect(LABOR_V1).toHaveLength(5897);
    expect(LABOR_V1.filter((row) => row.weldUnits === "" && row.weldConstant === 0)).toHaveLength(
      4149
    );
    expect(LABOR_V1.filter((row) => row.craftConstant === 0)).toHaveLength(134);
    expect(EQUIPMENT_V1).toHaveLength(129);
  });
});

// ---------------------------------------------------------------------------
// The labor rule
// ---------------------------------------------------------------------------

describe("which lines a rate book is allowed to move", () => {
  it("reprices a line still carrying the constant it was created with", () => {
    const disposition = classifyLaborLine(
      fswLine(),
      laborBook(FSW_1),
      laborBook(withLabor(FSW_1, { craftConstant: 0.9 }))
    );

    expect(disposition.craft).toBe("repriced");
    expect(disposition.draftCraftConstant).toBe(0.9);
  });

  it("leaves a line the estimator typed over alone — the measured 16%, 640 of 4,015", () => {
    const disposition = classifyLaborLine(
      fswLine({ labor: { craftConstant: 0.9, welderConstant: 0.7 } }),
      laborBook(FSW_1),
      laborBook(withLabor(FSW_1, { craftConstant: 1.1 }))
    );

    expect(disposition.craft).toBe("estimator_override");
    expect(disposition.draftCraftConstant).toBeUndefined();
  });

  it("reads 0.61 against a catalog 0.60 as an override, not as rounding", () => {
    const catalogRow = withLabor(FSW_1, { craftConstant: 0.6 });
    const disposition = classifyLaborLine(
      fswLine({ labor: { craftConstant: 0.61, welderConstant: 0.7 } }),
      laborBook(catalogRow),
      laborBook(withLabor(catalogRow, { craftConstant: 0.8 }))
    );

    expect(disposition.craft).toBe("estimator_override");
  });

  it("refuses a line whose description contradicts its own laborPoolId — the measured 8%, 326 of 4,015", () => {
    const disposition = classifyLaborLine(
      fswLine({ description: MANLIFT_60.description }),
      laborBook(FSW_1),
      laborBook(withLabor(FSW_1, { craftConstant: 0.9 }))
    );

    expect(disposition.line).toBe("description_mismatch");
    expect(disposition.draftCraftConstant).toBeUndefined();
  });

  it("still corroborates a description Excel autocorrected an en-dash into", () => {
    const disposition = classifyLaborLine(
      fswLine({ description: "FSW – 1" }),
      laborBook(FSW_1),
      laborBook(withLabor(FSW_1, { craftConstant: 0.9 }))
    );

    expect(disposition.craft).toBe("repriced");
  });

  it("names an id the parent book does not contain instead of crashing on it", () => {
    const disposition = classifyLaborLine(
      fswLine({ laborPoolId: 99999 }),
      laborBook(FSW_1),
      laborBook(FSW_1)
    );

    expect(disposition.line).toBe("dangling_reference");
  });

  it("names an item the draft removed, because that line breaks on the next re-pick", () => {
    const disposition = classifyLaborLine(fswLine(), laborBook(FSW_1), laborBook(FSW_3));

    expect(disposition.line).toBe("retired_under_draft");
  });

  it("counts a row deactivated in the draft as retired: every picker queries by_book_phase_active", () => {
    const disposition = classifyLaborLine(
      fswLine(),
      laborBook(FSW_1),
      laborBook(withLabor(FSW_1, { isActive: false, craftConstant: 0.9 }))
    );

    expect(disposition.line).toBe("retired_under_draft");
  });

  it("says nothing about a material line, because no rate book has ever touched one", () => {
    const material = plainLine("material", { description: '3" PIPE', unitPrice: 42 });
    const disposition = classifyLaborLine(material, laborBook(FSW_1), laborBook(FSW_1));

    expect(disposition.line).toBe("no_catalog_reference");
    expect(counterfactualActivity(material, disposition)).toBe(material);
  });

  it("refuses an item the draft restates from LF to EA: 0.7 per foot is not 0.7 each", () => {
    const perFoot = withLabor(FSW_1, { craftUnits: "LF" });
    const disposition = classifyLaborLine(
      fswLine(),
      laborBook(perFoot),
      laborBook(withLabor(perFoot, { craftUnits: "EA" }))
    );

    expect(disposition.craft).toBe("unit_redefined");
    expect(disposition.line).toBe("unit_redefined");
    expect(disposition.draftCraftConstant).toBeUndefined();
  });

  it("ignores a blank weldUnits the draft fills in, since 4,149 of 5,897 rows carry one", () => {
    const noWeld = withLabor(FSW_1, { weldConstant: 0, weldUnits: "" });
    const disposition = classifyLaborLine(
      fswLine({ labor: { craftConstant: 0.7, welderConstant: 0 } }),
      laborBook(noWeld),
      laborBook(withLabor(noWeld, { weldUnits: "EA", craftConstant: 0.9 }))
    );

    // The leg carries no hours in either book, so the unit it is stated in
    // cannot change a number. Flagging it would report near-zero coverage on a
    // draft that did nothing but tidy 4,149 blank cells.
    expect(disposition.weld).toBe("repriced_no_delta");
    expect(disposition.craft).toBe("repriced");
  });

  it("blames the draft, not the estimator, when a redefined item was also typed over", () => {
    const perFoot = withLabor(FSW_1, { craftUnits: "LF" });
    const disposition = classifyLaborLine(
      fswLine({ labor: { craftConstant: 0.75, welderConstant: 0.7 } }),
      laborBook(perFoot),
      laborBook(withLabor(perFoot, { craftUnits: "EA" }))
    );

    // Both are true, and only one of them is a fact about this draft that an
    // admin can act on before publishing.
    expect(disposition.craft).toBe("unit_redefined");
  });

  it("reads a lowercased unit as the same unit, because the importer's matcher does", () => {
    const perFoot = withLabor(FSW_1, { craftUnits: "LF" });
    const disposition = classifyLaborLine(
      fswLine(),
      laborBook(perFoot),
      laborBook(withLabor(perFoot, { craftUnits: "lf", craftConstant: 0.9 }))
    );

    expect(disposition.craft).toBe("repriced");
  });

  it("gives both legs one verdict when the line itself is the problem, never a mixture", () => {
    // The four verdicts below are facts about the LINE — there is no item to
    // state a unit or a constant against — so they are stamped on both legs at
    // once and never reach `worstOf`. That is why the precedence list only ever
    // ranks the four a leg can carry: an id the parent book does not contain is
    // not weighed against a redefined unit, it replaces the question.
    const draft = laborBook(withLabor(FSW_1, { craftConstant: 0.9 }));
    const cases = [
      {
        what: "a description that contradicts its own poolId",
        line: fswLine({ description: MANLIFT_60.description }),
        draft,
        verdict: "description_mismatch",
      },
      {
        what: "an id the parent book does not contain",
        line: fswLine({ laborPoolId: 99999 }),
        draft,
        verdict: "dangling_reference",
      },
      {
        what: "an item the draft no longer offers",
        line: fswLine(),
        draft: laborBook(FSW_3),
        verdict: "retired_under_draft",
      },
      {
        what: "a line naming no catalog item at all",
        line: plainLine("material", { description: '3" PIPE', unitPrice: 42 }),
        draft,
        verdict: "no_catalog_reference",
      },
    ];

    for (const item of cases) {
      const disposition = classifyLaborLine(item.line, laborBook(FSW_1), item.draft);

      expect([item.what, disposition.line, disposition.craft, disposition.weld]).toEqual([
        item.what,
        item.verdict,
        item.verdict,
        item.verdict,
      ]);
    }
  });

  it("never reprices an equipment line that happens to carry a labor snapshot", () => {
    // `activities` permits it — "only one should be populated" is a comment on
    // the table, not a validator — and repricing it would move the headline
    // delta by dollars the accounting has already filed as carried.
    const hybrid = breakerLine({
      description: "FSW - 1",
      laborPoolId: 1527,
      labor: { craftConstant: 0.7, welderConstant: 0.7 },
    });
    const result = run({ activities: [hybrid] });

    expect(
      classifyLaborLine(
        hybrid,
        laborBook(FSW_1),
        laborBook(withLabor(FSW_1, { craftConstant: 0.9 }))
      ).line
    ).toBe("no_catalog_reference");
    expect(round2(result.counterfactual.costs.totalCost)).toBe(
      round2(result.baseline.costs.totalCost)
    );
    expect(round2(result.carriedDollars.equipment)).toBe(round2(result.baseline.costs.totalCost));
    expect(result.coveredDollars).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The welder pairing
// ---------------------------------------------------------------------------

describe("the welder leg, whose pairing fails silently when it is wrong", () => {
  // Book #1 ships 1524 at 1.5 craft and 1.5 weld — equal, like most of the
  // pool, so a welder leg read off the craft column would agree by accident and
  // the shipped row cannot catch the bug. Moving the parent's weld constant to
  // 0.7 is what separates the two columns; every other value here is the file's.
  const parentRow = withLabor(FSW_3, { craftConstant: 1.5, weldConstant: 0.7 });
  const draftRow = withLabor(parentRow, { weldConstant: 0.9 });
  const line = fswLine({
    description: "FSW - 3",
    laborPoolId: 1524,
    labor: { craftConstant: 1.5, welderConstant: 0.7 },
  });

  it("compares activities.labor.welderConstant against laborPool.weldConstant, never craftConstant", () => {
    const disposition = classifyLaborLine(line, laborBook(parentRow), laborBook(draftRow));

    // Paired against craftConstant (1.5) instead, this leg reads
    // estimator_override and every welder delta in every report is exactly zero
    // while every other number still looks plausible.
    expect(disposition.weld).toBe("repriced");
    expect(disposition.draftWelderConstant).toBe(0.9);
    expect(disposition.craft).toBe("repriced_no_delta");
  });

  it("moves welder hours from 70 to 90 and leaves the 150 craft hours alone", () => {
    const result = run({
      activities: [line],
      parentLabor: laborBook(parentRow),
      draftLabor: laborBook(draftRow),
    });

    expect(round2(result.baseline.costs.welderManHours)).toBe(70);
    expect(round2(result.counterfactual.costs.welderManHours)).toBe(90);
    expect(round2(result.counterfactual.costs.craftManHours)).toBe(150);
    expect(round2(result.baseline.costs.craftManHours)).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// The counterfactual line
// ---------------------------------------------------------------------------

describe("the counterfactual line, which changes one variable", () => {
  it("holds the quantity and both per-line rate overrides exactly as stored", () => {
    const line = fswLine({
      quantity: 37.5,
      labor: {
        craftConstant: 0.7,
        welderConstant: 0.7,
        customCraftRate: 12.5,
        customSubsistenceRate: 0,
      },
    });
    const substituted = counterfactualActivity(line, {
      craft: "repriced",
      weld: "repriced_no_delta",
      line: "repriced",
      draftCraftConstant: 0.9,
      draftWelderConstant: 0.7,
    });

    expect(substituted.quantity).toBe(37.5);
    expect(substituted.labor?.customCraftRate).toBe(12.5);
    expect(substituted.labor?.customSubsistenceRate).toBe(0);
    expect(substituted.labor?.craftConstant).toBe(0.9);
    expect(substituted.labor?.welderConstant).toBe(0.7);
    expect({ ...substituted, labor: undefined }).toEqual({ ...line, labor: undefined });
  });

  it("returns the very same line object when the draft did not move it", () => {
    const line = fswLine();
    const substituted = counterfactualActivity(line, {
      craft: "repriced_no_delta",
      weld: "repriced_no_delta",
      line: "repriced_no_delta",
      draftCraftConstant: 0.7,
      draftWelderConstant: 0.7,
    });

    expect(substituted).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// The self-check
// ---------------------------------------------------------------------------

describe("the self-check against the total the app itself recorded", () => {
  // 100 EA of FSW - 1 under proposal 2020's rates: 70 craft hours at $65.060194
  // and 70 welder hours at $88.78321 — $10,769.04.
  const CACHED_TOTAL = 10769.04;

  /**
   * What `recomputeProposalTotal` would write into `proposals.costTotal`.
   *
   * The identical call: `precision.ts` aliases `roundAccumulator` to
   * `roundCosts` and rolls up with an empty indirect WBS set. Made here rather
   * than asserted in a comment, because the self-check is an EQUALITY with this
   * number and a hand-computed literal cannot notice if the engine moves.
   */
  const recordedTotal = (activities: readonly BenchmarkActivity[]): number =>
    roundCosts(rollUpProposal(activities, RATES_2020, new Set<string>()).costs).totalCost;

  it("computes exactly what recomputeProposalTotal caches, not a number that resembles it", () => {
    const activities = [fswLine()];
    const result = run({ activities, cachedCostTotal: recordedTotal(activities) });

    expect(recordedTotal(activities)).toBe(CACHED_TOTAL);
    expect(result.selfCheck.computed).toBe(recordedTotal(activities));
    expect(result.selfCheck.matches).toBe(true);
  });

  it("reproduces the $10,769.04 recomputeProposalTotal caches for this estimate", () => {
    const result = run({ cachedCostTotal: CACHED_TOTAL });

    expect(result.selfCheck.computed).toBe(CACHED_TOTAL);
    expect(result.selfCheck.matches).toBe(true);
  });

  it("fails an estimate whose recorded total is a cent out, and names the estimate", () => {
    const result = run({ proposalNumber: "1956.01", cachedCostTotal: 10769.05 });
    const failures = report([result]).selfCheckFailures;

    expect(result.selfCheck.matches).toBe(false);
    expect(failures.map((failure) => failure.proposalNumber)).toEqual(["1956.01"]);
    expect(failures[0]?.cached).toBe(10769.05);
    expect(failures[0]?.computed).toBe(CACHED_TOTAL);
  });

  it("fails an estimate that has never been totalled rather than passing it silently", () => {
    const result = run({ proposalNumber: "2101" });
    const failures = report([result]).selfCheckFailures;

    expect(result.selfCheck.matches).toBe(false);
    expect(failures[0]).toEqual({
      proposalNumber: "2101",
      cached: undefined,
      computed: CACHED_TOTAL,
    });
  });

  it("leads the caveats with the self-check, because a report that cannot reproduce the app's own total is not a report", () => {
    const caveats = report([run({ proposalNumber: "2101" })]).caveats;

    expect(caveats[0]).toContain("READ NOTHING BELOW YET");
    expect(caveats[0]).toContain("never been totalled");
  });
});

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

describe("equipment, which is traced and never repriced", () => {
  it("moves no equipment dollar at all, even when the rate it was priced from changed", () => {
    const result = run({
      activities: [breakerLine()],
      draftEquipment: equipmentBook(withEquipment(AIR_BREAKER, { weekRate: 300 })),
    });

    expect(round2(result.counterfactual.costs.totalCost)).toBe(
      round2(result.baseline.costs.totalCost)
    );
    expect(result.equipment.exposedToChange).toBe(1);
  });

  it("recovers the tier when one non-zero rate explains the price: 224 is the week rate on id 5", () => {
    const trace = traceEquipmentLine(breakerLine(), equipmentBook(AIR_BREAKER));

    expect(trace?.tier).toBe("week");
    expect(trace?.ambiguous).toBe(false);
    expect(trace?.descriptionCorroborated).toBe(true);
  });

  // No row in book #1 carries two equal non-zero tiers, but nothing in the
  // schema or the importer prevents an edit from creating one.
  it("refuses to guess a tier when two rates match, because an unknown tier cannot be substituted", () => {
    const flatRow = withEquipment(AIR_BREAKER, { hourRate: 10, dayRate: 10 });
    const trace = traceEquipmentLine(breakerLine({ unitPrice: 10 }), equipmentBook(flatRow));

    expect(trace?.ambiguous).toBe(true);
    expect(trace?.tier).toBeUndefined();
  });

  it("reports a MANLIFT - 60' line pointing at an air breaker as uncorroborated — 199 of 245 do", () => {
    const trace = traceEquipmentLine(
      breakerLine({ description: MANLIFT_60.description }),
      equipmentBook(AIR_BREAKER)
    );

    expect(trace?.descriptionCorroborated).toBe(false);
  });

  it("returns nothing at all for a line carrying no equipment reference", () => {
    expect(traceEquipmentLine(fswLine(), equipmentBook(AIR_BREAKER))).toBeNull();
  });

  it("keeps the corroborated equipment delta under its own key, outside the cost headline", () => {
    const result = run({
      activities: [breakerLine()],
      draftEquipment: equipmentBook(withEquipment(AIR_BREAKER, { weekRate: 300 })),
    });
    const finished = report([result], { changedEquipmentPoolIds: [5] });

    // 224 -> 300 on a rental line: $76 before markup, $88.35 after — rounded at
    // this boundary, and appearing nowhere near the labor delta.
    expect(finished.equipment.corroboratedDelta).toBe(88.35);
    expect(finished.cost.delta).toBe(0);
  });

  it("prices no delta for a MANLIFT line pointing at an air breaker, whatever its rate did", () => {
    const result = run({
      activities: [breakerLine({ description: MANLIFT_60.description })],
      draftEquipment: equipmentBook(withEquipment(AIR_BREAKER, { weekRate: 300 })),
    });

    // 199 of 245 sampled lines look exactly like this. The rate moved and the
    // line is exposed, but the row it names is not the item it describes, so
    // there is no number to substitute.
    expect(result.equipment.exposedToChange).toBe(1);
    expect(result.equipment.corroborated).toBe(0);
    expect(result.equipment.corroboratedDelta).toBe(0);
  });

  it("counts no exposure at all when the draft leaves the row alone", () => {
    const result = run({ activities: [breakerLine()] });

    expect(result.equipment.lines).toBe(1);
    expect(result.equipment.exposedToChange).toBe(0);
  });

  it("counts a row the draft deactivates as exposed: every picker queries by_book_active", () => {
    const result = run({
      activities: [breakerLine()],
      // Re-rated AND retired: the rate would have moved the line by $88.35 if
      // the row were still offered, which is exactly the number that must not
      // appear. A retired row is not a price.
      draftEquipment: equipmentBook(withEquipment(AIR_BREAKER, { isActive: false, weekRate: 300 })),
    });

    expect(result.equipment.exposedToChange).toBe(1);
    expect(result.equipment.corroboratedDelta).toBe(0);
  });

  it("reports changedRows 0 beside one exposed line when the draft only retires the row", () => {
    const retiredOnly = equipmentBook(withEquipment(AIR_BREAKER, { isActive: false }));
    const finished = report([run({ activities: [breakerLine()], draftEquipment: retiredOnly })], {
      equipmentFacts: equipmentRateFacts(equipmentBook(AIR_BREAKER), retiredOnly),
      changedEquipmentPoolIds: [AIR_BREAKER.poolId],
    });

    // Two equipment numbers on one report that are meant to disagree, and the
    // draft that separates them is the ordinary one: a yard retiring rows and
    // re-rating none. `changedRows` answers what the catalog's rates did;
    // `linesExposedToChange` answers what happened to a line, and a retired row
    // is as gone as a deleted one to every picker.
    expect(finished.equipment.facts.changedRows).toBe(0);
    expect(finished.equipment.linesExposedToChange).toBe(1);
  });

  it("flags a tier inversion on its face: 7/56/224/672 is cumulative, so a week below a day is wrong", () => {
    const facts = equipmentRateFacts(
      equipmentBook(AIR_BREAKER, MANLIFT_60),
      equipmentBook(withEquipment(AIR_BREAKER, { weekRate: 50 }), MANLIFT_60)
    );

    expect(facts.inversions).toEqual([5]);
  });

  it("finds no inversion in book #1, whose 129 rows are all in order", () => {
    const facts = equipmentRateFacts(
      equipmentBook(AIR_BREAKER, MANLIFT_60),
      equipmentBook(AIR_BREAKER, MANLIFT_60)
    );

    expect(facts.inversions).toEqual([]);
    expect(facts.changedRows).toBe(0);
  });

  it("reports a movement for the week rate and nothing for the month rate nobody touched", () => {
    const facts = equipmentRateFacts(
      equipmentBook(AIR_BREAKER),
      equipmentBook(withEquipment(AIR_BREAKER, { weekRate: 246.4 }))
    );

    expect(facts.tierChangePct.week).toEqual({ min: 10, median: 10, max: 10 });
    expect(facts.tierChangePct.month).toBeNull();
    expect(facts.changedRows).toBe(1);
  });

  it("finds no inversion in a row that simply has no month rate", () => {
    const noMonth = withEquipment(AIR_BREAKER, { monthRate: 0 });
    const facts = equipmentRateFacts(equipmentBook(noMonth), equipmentBook(noMonth));

    // 224 > 0 is not a week priced above a month; it is a month nobody prices.
    expect(facts.inversions).toEqual([]);
  });

  it("counts a tier that was free and now is not, without printing an infinite percentage", () => {
    const free = withEquipment(AIR_BREAKER, { hourRate: 0 });
    const facts = equipmentRateFacts(equipmentBook(free), equipmentBook(AIR_BREAKER));

    expect(facts.changedRows).toBe(1);
    expect(facts.tierChangePct.hour).toBeNull();
  });

  it("does not call a row the draft adds a rate change, since it has no before", () => {
    const facts = equipmentRateFacts(
      equipmentBook(AIR_BREAKER),
      equipmentBook(AIR_BREAKER, MANLIFT_60)
    );

    expect(facts.changedRows).toBe(0);
  });

  it("takes the median of an even spread from both middle rows, not the upper one", () => {
    // +10%, +20%, +30% and +100% on the week rate: the median is 25, which is a
    // number no row carries and is the point of a median.
    const facts = equipmentRateFacts(
      equipmentBook(
        withEquipment(AIR_BREAKER, { poolId: 1, weekRate: 100 }),
        withEquipment(AIR_BREAKER, { poolId: 2, weekRate: 100 }),
        withEquipment(AIR_BREAKER, { poolId: 3, weekRate: 100 }),
        withEquipment(AIR_BREAKER, { poolId: 4, weekRate: 100 })
      ),
      equipmentBook(
        withEquipment(AIR_BREAKER, { poolId: 1, weekRate: 110 }),
        withEquipment(AIR_BREAKER, { poolId: 2, weekRate: 120 }),
        withEquipment(AIR_BREAKER, { poolId: 3, weekRate: 130 }),
        withEquipment(AIR_BREAKER, { poolId: 4, weekRate: 200 })
      )
    );

    expect(facts.tierChangePct.week).toEqual({ min: 10, median: 25, max: 100 });
  });
});

// ---------------------------------------------------------------------------
// The accounting
// ---------------------------------------------------------------------------

describe("the accounting for what the figure is not about", () => {
  const mixed: readonly BenchmarkActivity[] = [
    fswLine(),
    fswLine({ labor: { craftConstant: 0.9, welderConstant: 0.7 } }),
    fswLine({ description: MANLIFT_60.description }),
    fswLine({ laborPoolId: 99999 }),
    fswLine({
      laborPoolId: 1524,
      description: "FSW - 3",
      labor: { craftConstant: 1.5, welderConstant: 1.5 },
    }),
    plainLine("custom_labor", {
      description: "NIGHT SHIFT SUPERVISION",
      labor: { craftConstant: 8, welderConstant: 0 },
    }),
    breakerLine({ equipment: { ownership: "owned", time: 1 }, unitPrice: 100 }),
    plainLine("cost_only", { description: "PERMIT", unitPrice: 250 }),
  ];

  const mixedRun = run({
    activities: mixed,
    parentLabor: laborBook(FSW_1, FSW_3),
    draftLabor: laborBook(withLabor(FSW_1, { craftConstant: 0.9 })),
  });

  it("puts every line in exactly one line bucket, and the buckets sum to the eight lines", () => {
    const byLine = mixedRun.lines.byLine;

    expect(mixedRun.lines.total).toBe(8);
    expect(Object.values(byLine).reduce((sum, count) => sum + count, 0)).toBe(8);
    expect(byLine.repriced).toBe(1);
    expect(byLine.estimator_override).toBe(1);
    expect(byLine.description_mismatch).toBe(1);
    expect(byLine.dangling_reference).toBe(1);
    expect(byLine.retired_under_draft).toBe(1);
    expect(byLine.no_catalog_reference).toBe(3);
  });

  it("splits the estimate's own total to the cent between covered and carried dollars", () => {
    const carried = mixedRun.carriedDollars;
    const sum =
      mixedRun.coveredDollars +
      carried.overriddenLabor +
      carried.mismatchedLabor +
      carried.retiredUnderDraftLabor +
      carried.unitRedefinedLabor +
      carried.danglingLabor +
      carried.unlinkedLabor +
      carried.equipment +
      carried.materialAndSub;

    expect(round2(sum)).toBe(round2(mixedRun.baseline.costs.totalCost));
  });

  it("files each excluded labor line under the reason it was excluded, not just somewhere", () => {
    // The partition closes whichever bucket a line lands in, so the buckets are
    // asserted one at a time: 100 EA at 0.7/0.7 under proposal 2020's rates is
    // $10,769.04, and the mismatched, retired and dangling lines are each one of
    // those. Swap two of these and every total in the report still ties.
    const carried = mixedRun.carriedDollars;

    expect(round2(carried.mismatchedLabor)).toBe(10769.04);
    expect(round2(carried.danglingLabor)).toBe(10769.04);
    // 100 EA at 1.5/1.5: FSW - 3, which this draft does not carry at all.
    expect(round2(carried.retiredUnderDraftLabor)).toBe(23076.51);
    expect(carried.unitRedefinedLabor).toBe(0);
  });

  it("files a redefined unit under its own reason rather than under the retired pile", () => {
    const perFoot = withLabor(FSW_1, { craftUnits: "LF", weldUnits: "LF" });
    const redefined = run({
      parentLabor: laborBook(perFoot),
      draftLabor: laborBook(withLabor(perFoot, { craftUnits: "EA", weldUnits: "EA" })),
    });

    expect(round2(redefined.carriedDollars.unitRedefinedLabor)).toBe(10769.04);
    expect(redefined.carriedDollars.retiredUnderDraftLabor).toBe(0);
    expect(redefined.coveredDollars).toBe(0);
    expect(redefined.lines.byLine.unit_redefined).toBe(1);
    // Neither leg is exercised: `neverExercised` exists to name the changed rows
    // nothing measured, and this line measured neither of them.
    expect(redefined.exercisedLaborPoolIds).toEqual([]);
  });

  it("carries the owned breaker's $100 as equipment and the $250 permit as material-and-sub", () => {
    expect(round2(mixedRun.carriedDollars.equipment)).toBe(100);
    expect(round2(mixedRun.carriedDollars.materialAndSub)).toBe(250);
  });

  it("reports that same equipment money once more in the equipment block, not a second figure", () => {
    // A reader comparing the equipment section against the carried partition is
    // comparing one number to itself; the report says so by construction rather
    // than by two accumulators that happen to agree today.
    const finished = report([mixedRun]);

    expect(finished.equipment.carriedDollars).toBe(finished.carriedDollars.equipment);
    expect(round2(finished.equipment.carriedDollars)).toBe(100);
  });

  it("hands the buckets over unrounded, because eight roundings need not add back up", () => {
    // 100 EA of FSW - 1 under proposal 2020's rates is $10,769.03828 — the
    // partition closes to the cent only because nothing rounds it on the way
    // out. The render layer rounds; this boundary does not.
    const mismatched = mixedRun.carriedDollars.mismatchedLabor;

    expect(mismatched).not.toBe(round2(mismatched));
    expect(round2(mismatched)).toBe(10769.04);
  });

  it("names custom labor with no catalog link as its own bucket rather than covering it", () => {
    // 1 x 8 craft hours at $65.060194 — real labor cost that no rate book can move.
    expect(round2(mixedRun.carriedDollars.unlinkedLabor)).toBe(520.48);
    expect(mixedRun.coveredDollars).toBeLessThan(mixedRun.baseline.costs.totalCost);
  });

  it("counts a half-overridden line once as carried and twice across the legs", () => {
    const halfOverridden = run({
      activities: [fswLine({ labor: { craftConstant: 0.7, welderConstant: 0.9 } })],
      draftLabor: laborBook(withLabor(FSW_1, { craftConstant: 0.9 })),
    });

    expect(halfOverridden.lines.byLine.estimator_override).toBe(1);
    expect(halfOverridden.lines.byCraftLeg.repriced).toBe(1);
    expect(halfOverridden.lines.byWeldLeg.estimator_override).toBe(1);
    expect(halfOverridden.coveredDollars).toBe(0);
    expect(halfOverridden.carriedDollars.overriddenLabor).toBeGreaterThan(0);
  });

  it("counts a line as exercising its catalog item only when the item actually priced it", () => {
    expect(mixedRun.exercisedLaborPoolIds).toEqual([1527]);
  });
});

// ---------------------------------------------------------------------------
// The checkpoint
// ---------------------------------------------------------------------------

describe("the checkpoint a run of ~713 estimates is resumed from", () => {
  it("writes the exercised ids and the per-item deltas as arrays a document can hold", () => {
    const acc = emptyBenchmarkAccumulator();
    accumulateProposal(acc, run());
    const snapshot = serializeAccumulator(acc);

    // 100 EA of FSW - 1 at 0.7 becoming 0.9: twenty craft hours on one line.
    expect(snapshot.exercisedLaborPoolIds).toEqual([1527]);
    expect(snapshot.perItemDelta).toEqual([
      {
        poolId: 1527,
        description: "FSW - 1",
        craftHours: 20,
        welderHours: 0,
        cost: acc.perItemDelta.get(1527)?.cost,
        lines: 1,
      },
    ]);
  });

  it("keeps every field it holds through the document write, not only the two collections", () => {
    const acc = emptyBenchmarkAccumulator();
    accumulateProposal(acc, run());
    const snapshot = serializeAccumulator(acc);

    // A third `Set` or `Map` added to the accumulator reaches this snapshot
    // through the spread, comes back from the document as `{}`, and nothing
    // else notices: the resume test below only sees what its own two estimates
    // happen to exercise. This sees the whole checkpoint.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("resumes to the same report an unbroken run produces", () => {
    const first = run({ proposalNumber: "2020" });
    const second = run({ proposalNumber: "2021", activities: [fswLine({ quantity: 3 })] });

    const unbroken = emptyBenchmarkAccumulator();
    accumulateProposal(unbroken, first);
    accumulateProposal(unbroken, second);

    const beforeTheRedeploy = emptyBenchmarkAccumulator();
    accumulateProposal(beforeTheRedeploy, first);
    // What the storage layer really does to a checkpoint. A `Set` and a `Map`
    // written straight into a document both come back as `{}`, so a run that
    // died at estimate 600 would resume claiming no catalog item was exercised
    // and no item moved any money — the two figures the coverage section exists
    // to report.
    const stored = JSON.parse(
      JSON.stringify(serializeAccumulator(beforeTheRedeploy))
    ) as BenchmarkAccumulatorSnapshot;
    const resumed = reviveAccumulator(stored);
    accumulateProposal(resumed, second);

    const finished = finish(resumed);

    expect(finished.movers.byItem[0]?.poolId).toBe(1527);
    expect(finished.movers.byItem[0]?.lines).toBe(2);
    expect(finished.coverage.neverExercised).toEqual([]);
    expect(finished.coverage.exercisedLaborPoolIds).toBe(1);
    expect(finished).toEqual(finish(unbroken));
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe("the finished run, and what it says it could not measure", () => {
  it("names the changed rows no estimate exercises instead of averaging them away", () => {
    const finished = report([run()], { changedLaborPoolIds: [1527, 1524, 4725] });

    expect(finished.coverage.neverExercised).toEqual([1524, 4725]);
    expect(finished.coverage.exercisedLaborPoolIds).toBe(1);
    expect(finished.coverage.changedLaborPoolIds).toBe(3);
  });

  it("counts the estimates that did not move, which is the evidence nothing is being fabricated", () => {
    const still = run({
      proposalNumber: "1605",
      activities: [
        fswLine({
          laborPoolId: 1524,
          description: "FSW - 3",
          labor: { craftConstant: 1.5, welderConstant: 1.5 },
        }),
      ],
      parentLabor: laborBook(FSW_1, FSW_3),
      draftLabor: laborBook(withLabor(FSW_1, { craftConstant: 0.9 }), FSW_3),
    });
    const finished = report([run(), still]);

    expect(finished.proposalsCompared).toBe(2);
    expect(finished.estimatesUnmoved).toBe(1);
  });

  it("says an equipment-only draft told you nothing rather than reporting $0.00", () => {
    const finished = report([run({ activities: [breakerLine()] })], {
      changedLaborPoolIds: [],
      changedEquipmentPoolIds: [5, 61],
    });

    expect(finished.measuredNothing).toBe(true);
    expect(finished.caveats.at(-1)).toContain("It has told you nothing about this draft.");
    expect(finished.caveats.at(-1)).toContain("2 equipment rows");
  });

  it("labels an empty population a catalog delta profile, not a money figure", () => {
    const finished = report([]);

    expect(finished.proposalsCompared).toBe(0);
    expect(finished.measuredNothing).toBe(true);
    expect(finished.caveats.at(-1)).toContain("catalog delta profile");
  });

  it("keeps the ten largest decreases beside the ten largest increases, and does not mix them", () => {
    const cheaper = laborBook(withLabor(FSW_1, { craftConstant: 0.5 }));
    const dearer = laborBook(withLabor(FSW_1, { craftConstant: 0.9 }));
    const results = [
      run({ proposalNumber: "up", draftLabor: dearer }),
      run({ proposalNumber: "down", draftLabor: cheaper }),
    ];
    const finished = report(results);

    expect(finished.movers.byDollarUp.map((mover) => mover.proposalNumber)).toEqual(["up"]);
    expect(finished.movers.byDollarDown.map((mover) => mover.proposalNumber)).toEqual(["down"]);
    expect(finished.movers.byDollarDown[0]?.delta).toBeLessThan(0);
    // Ranking every mover into both lists and truncating at ten would have put
    // "down" second in the increases, under a heading that says the opposite.
    expect(finished.movers.byPercentUp.map((mover) => mover.proposalNumber)).toEqual(["up"]);
    expect(finished.movers.byPercentDown.map((mover) => mover.proposalNumber)).toEqual(["down"]);
  });

  it("keeps the ten catalog items that moved the most money, out of fourteen that moved", () => {
    // MOVER_LIMIT does two jobs, and this is the second one: `byItem` has no
    // direction, so ten is the whole list rather than ten per side. Fourteen
    // real rows from the shipped file, each priced on a different quantity, so
    // the ranking is known before the report runs.
    const items = LABOR_V1.filter((row) => Number(row.craftConstant) > 0)
      .slice(0, 14)
      .map((row) => laborFixture(Number(row.id)));
    const activities = items.map((item, index) =>
      fswLine({
        description: item.description,
        laborPoolId: item.poolId,
        quantity: index + 1,
        labor: { craftConstant: item.craftConstant, welderConstant: item.weldConstant },
      })
    );
    const finished = report([
      run({
        activities,
        parentLabor: laborBook(...items),
        draftLabor: laborBook(
          ...items.map((item) => withLabor(item, { craftConstant: item.craftConstant + 1 }))
        ),
      }),
    ]);
    const smallest = items[0];
    const largest = items[13];

    expect(finished.movers.byItem).toHaveLength(10);
    expect(finished.movers.byItem[0]?.description).toBe(largest?.description);
    expect(finished.movers.byItem.map((mover) => mover.poolId)).not.toContain(smallest?.poolId);
  });

  it("prints no percentage of repriced labor when the labor it repriced cost nothing", () => {
    // 134 of the 5,897 labor rows carry a zero craftConstant. A line on one is
    // repriced — the snapshot matches the parent, the draft moves it — so it is
    // covered, and the covered dollars are $0.00. The delta is real money
    // against a denominator that does not exist, and "+∞%" is not a percentage,
    // it is a division nobody checked.
    const zeroed = withLabor(FSW_1, { craftConstant: 0, weldConstant: 0 });
    const fromNothing = run({
      activities: [
        fswLine({ labor: { craftConstant: 0, welderConstant: 0 } }),
        plainLine("cost_only", { description: "PERMIT", unitPrice: 50000 }),
      ],
      parentLabor: laborBook(zeroed),
      draftLabor: laborBook(withLabor(zeroed, { craftConstant: 0.9 })),
    });
    const finished = report([fromNothing]);

    expect(fromNothing.coveredDollars).toBe(0);
    expect(finished.cost.delta).toBeGreaterThan(0);
    expect(finished.deltaPctOfRepricedLabor).toBe(0);
    expect(finished.deltaPctOfGrandTotal).toBeGreaterThan(0);
  });

  it("keeps each mover list to ten however many estimates moved", () => {
    const dearer = laborBook(withLabor(FSW_1, { craftConstant: 0.9 }));
    const results = Array.from({ length: 14 }, (_unused, index) =>
      run({ proposalNumber: `2${index}`, draftLabor: dearer })
    );
    const finished = report(results);

    expect(finished.proposalsCompared).toBe(14);
    expect(finished.movers.byDollarUp).toHaveLength(10);
  });

  it("keeps an estimate with a $0 baseline out of the percentage lists, but not the dollar list", () => {
    // 134 of the 5,897 labor rows carry a zero craftConstant. An estimate built
    // only from those has no labor cost at all until a draft gives them numbers,
    // and the move is real money against a denominator that does not exist.
    const zeroed = withLabor(FSW_1, { craftConstant: 0, weldConstant: 0 });
    const fromNothing = run({
      proposalNumber: "from-nothing",
      activities: [fswLine({ labor: { craftConstant: 0, welderConstant: 0 } })],
      parentLabor: laborBook(zeroed),
      draftLabor: laborBook(withLabor(zeroed, { craftConstant: 0.9 })),
    });
    const finished = report([fromNothing, run({ proposalNumber: "2020" })]);

    expect(round2(fromNothing.baseline.costs.totalCost)).toBe(0);
    expect(round2(fromNothing.counterfactual.costs.totalCost)).toBeGreaterThan(0);
    expect(finished.movers.byDollarUp.map((mover) => mover.proposalNumber)).toEqual([
      "from-nothing",
      "2020",
    ]);
    expect(finished.movers.byPercentUp.map((mover) => mover.proposalNumber)).toEqual(["2020"]);
  });

  it("leaves the 36 zero-rate estimates out of every list, because no constant can move them", () => {
    const zeroRated = run({ proposalNumber: "zero-rated", rates: RATES_ALL_ZERO });
    const finished = report([zeroRated, run({ proposalNumber: "2020" })]);

    expect(round2(zeroRated.baseline.costs.totalCost)).toBe(0);
    expect(finished.estimatesUnmoved).toBe(1);
    expect(finished.movers.byDollarUp.map((mover) => mover.proposalNumber)).toEqual(["2020"]);
    expect(finished.movers.byPercentUp.map((mover) => mover.proposalNumber)).toEqual(["2020"]);
  });

  it("moves the run's craft hours and ties baseline plus delta to the repriced figure", () => {
    // Three each, deliberately: 3 x 0.7 is 2.0999999999999996 unrounded, so an
    // hour figure that is not rounded at this boundary shows it.
    const finished = report([run({ activities: [fswLine({ quantity: 3 })] })]);

    expect(finished.craftHours).toEqual({
      baseline: 2.1,
      repriced: 2.7,
      delta: 0.6,
      deltaPct: (0.6 / 2.1) * 100,
    });
    // The welder leg is 0.7 in both books, so it must be dead still.
    expect(finished.welderHours.baseline).toBe(2.1);
    expect(finished.welderHours.delta).toBe(0);
  });

  it("carries the item's description on a mover, since a poolId alone is not actionable", () => {
    const finished = report([run()]);

    expect(finished.movers.byItem[0]?.poolId).toBe(1527);
    expect(finished.movers.byItem[0]?.description).toBe("FSW - 1");
    expect(finished.movers.byItem[0]?.lines).toBe(1);
  });

  it("counts an item as a mover only on the lines it actually moved", () => {
    // Two lines on item 1527: one still carrying the catalog's constant, one the
    // estimator typed over. Only the first one moved, and a mover claiming two
    // lines would send somebody looking for a change that is not there.
    const finished = report([
      run({
        activities: [fswLine(), fswLine({ labor: { craftConstant: 0.75, welderConstant: 0.7 } })],
      }),
    ]);

    expect(finished.movers.byItem).toHaveLength(1);
    expect(finished.movers.byItem[0]?.lines).toBe(1);
    expect(finished.movers.byItem[0]?.craftHours).toBe(20);
  });

  it("ranks items by how far they moved the money, in either direction", () => {
    // One item falls by more than the other rises. A signed sort would rank the
    // small increase first and bury the item doing the damage.
    const cheaper = run({
      activities: [
        fswLine({ quantity: 1000 }),
        fswLine({
          laborPoolId: 1524,
          description: "FSW - 3",
          quantity: 1,
          labor: { craftConstant: 1.5, welderConstant: 1.5 },
        }),
      ],
      parentLabor: laborBook(FSW_1, FSW_3),
      draftLabor: laborBook(
        withLabor(FSW_1, { craftConstant: 0.1 }),
        withLabor(FSW_3, { craftConstant: 2 })
      ),
    });
    const finished = report([cheaper]);

    expect(finished.movers.byItem.map((mover) => mover.poolId)).toEqual([1527, 1524]);
    expect(finished.movers.byItem[0]?.cost).toBeLessThan(0);
    expect(finished.movers.byItem[1]?.cost).toBeGreaterThan(0);
  });

  it("flags a population 60% corroborated against the 92% measured across 18 proposals", () => {
    // Corroboration is the ONLY thing off the sample here: 21 of these 25 lines
    // still carry the catalog's craftConstant, which is 84% on the nose, so the
    // flag can only have come from the description half of the test.
    const clean = fswLine();
    const overridden = fswLine({ labor: { craftConstant: 0.75, welderConstant: 0.7 } });
    const mismatched = fswLine({ description: MANLIFT_60.description });
    const mismatchedAndOverridden = fswLine({
      description: MANLIFT_60.description,
      labor: { craftConstant: 0.75, welderConstant: 0.7 },
    });
    const activities = [
      ...Array.from({ length: 13 }, () => clean),
      overridden,
      overridden,
      ...Array.from({ length: 8 }, () => mismatched),
      mismatchedAndOverridden,
      mismatchedAndOverridden,
    ];
    const finished = report([run({ activities })]);

    expect(finished.measuredRates.laborLinesWithCatalogReference).toBe(25);
    expect(finished.measuredRates.descriptionCorroborated).toBe(0.6);
    expect(finished.measuredRates.constantUnchanged).toBe(0.84);
    expect(finished.measuredRates.divergesFromSample).toBe(true);
    expect(SAMPLED_DESCRIPTION_CORROBORATED).toBe(0.92);
  });

  it("flags a population where every line was typed over, though every one corroborates", () => {
    // The mirror of the test above: 100% corroborated, 0% still carrying the
    // catalog's number. A draft cannot move a single line of this estimate, and
    // a run that reported the delta without saying so would be describing five
    // lines it never touched.
    const overridden = fswLine({ labor: { craftConstant: 0.75, welderConstant: 0.7 } });
    const finished = report([run({ activities: Array.from({ length: 5 }, () => overridden) })]);

    expect(finished.measuredRates.descriptionCorroborated).toBe(1);
    expect(finished.measuredRates.constantUnchanged).toBe(0);
    expect(finished.measuredRates.divergesFromSample).toBe(true);
  });

  it("counts a dangling reference in the denominator, because it corroborates nothing", () => {
    const finished = report([run({ activities: [fswLine(), fswLine({ laborPoolId: 99999 })] })]);

    // The line names a catalog item; the fact that the item is not there is the
    // reason it fails, not a reason to leave it out of the count it fails.
    expect(finished.measuredRates.laborLinesWithCatalogReference).toBe(2);
    expect(finished.measuredRates.descriptionCorroborated).toBe(0.5);
  });

  it("does not flag divergence for a population that looks like the 18-proposal sample", () => {
    const clean = fswLine();
    const overridden = fswLine({ labor: { craftConstant: 0.9, welderConstant: 0.7 } });
    const mismatched = fswLine({
      description: MANLIFT_60.description,
      labor: { craftConstant: 0.9, welderConstant: 0.7 },
    });
    // 23 of 25 corroborated (92%), 21 of 25 still carrying the catalog's
    // craftConstant (84%) — the two sampled proportions, reproduced exactly.
    const activities = [
      ...Array.from({ length: 21 }, () => clean),
      overridden,
      overridden,
      mismatched,
      mismatched,
    ];
    const finished = report([run({ activities })]);

    expect(finished.measuredRates.descriptionCorroborated).toBe(0.92);
    expect(finished.measuredRates.constantUnchanged).toBe(0.84);
    expect(finished.measuredRates.divergesFromSample).toBe(false);
  });

  it("names every excluded estimate rather than dropping it from the count", () => {
    const finished = report([run()], {
      excludedProposals: [{ proposalNumber: "2200", bookId: "book_2" }],
    });

    expect(finished.proposalsExcluded).toEqual([{ proposalNumber: "2200", bookId: "book_2" }]);
  });

  it("distinguishes reach unavailable from a reach of zero", () => {
    const building = report([run()], { reachAvailable: false, laborReach: new Map() });
    const counted = report([run()], { reachAvailable: true, laborReach: new Map([[1527, 41]]) });

    expect(building.reachAvailable).toBe(false);
    expect(building.laborReach.get(1527)).toBeUndefined();
    expect(counted.laborReach.get(1527)).toBe(41);
  });

  it("counts labor 61 and equipment 61 separately: 8 CY TRUCK - 4 MILE is not a MANLIFT", () => {
    // Equipment ids run 0-133 and every one of them is also a labor id, so the
    // two counts collide at every equipment row in the catalog. Held in one map
    // keyed by a bare poolId, whichever was written second wins and the report
    // states one item's line count under the other item's name.
    const finished = report([run()], {
      changedLaborPoolIds: [TRUCK_4_MILE.poolId],
      changedEquipmentPoolIds: [MANLIFT_60.poolId],
      laborReach: new Map([[TRUCK_4_MILE.poolId, 412]]),
      equipmentReach: new Map([[MANLIFT_60.poolId, 3]]),
    });

    expect(TRUCK_4_MILE.poolId).toBe(MANLIFT_60.poolId);
    expect(TRUCK_4_MILE.description).toBe("8 CY TRUCK - 4 MILE");
    expect(finished.laborReach.get(61)).toBe(412);
    expect(finished.equipmentReach.get(61)).toBe(3);
  });

  it("prints the delta against both denominators, never against one alone", () => {
    const finished = report([
      run({
        activities: [
          fswLine(),
          plainLine("cost_only", { description: "PERMIT", unitPrice: 50000 }),
        ],
      }),
    ]);

    expect(finished.deltaPctOfRepricedLabor).toBeGreaterThan(finished.deltaPctOfGrandTotal);
    expect(finished.cost.delta).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The caveats
// ---------------------------------------------------------------------------

describe("the caveats, which travel as data rather than as screen furniture", () => {
  const finished = report([run({ cachedCostTotal: 10769.04 })]);

  it("says first that nothing happens to a finished estimate", () => {
    expect(finished.caveats[0]).toContain("This is a counterfactual");
    expect(finished.caveats[0]).toContain("Publishing moves no money on any existing bid");
  });

  it("names the covered dollars and the share of the money they are", () => {
    const coverage = finished.caveats.find((line) => line.startsWith("This figure covers"));

    expect(coverage).toContain("$10,769.04");
    expect(coverage).toContain("100.0% of the money");
  });

  it("names each excluded pile in dollars, so the exclusions cannot be found out later", () => {
    const mixedFinished = report([
      run({
        activities: [
          fswLine(),
          fswLine({ labor: { craftConstant: 0.9, welderConstant: 0.7 } }),
          breakerLine({ equipment: { ownership: "owned", time: 1 }, unitPrice: 100 }),
        ],
      }),
    ]);
    const coverage = mixedFinished.caveats.find((line) => line.startsWith("This figure covers"));

    expect(coverage).toContain("of overridden labor");
    expect(coverage).toContain("$100.00 of equipment");
  });

  describe("the excluded money, all eight kinds of it at once", () => {
    /** The formatter the caveats print with, so these assertions quote the
     *  string a reader actually sees. */
    const usd = (amount: number): string => {
      const [whole = "0", cents = "00"] = Math.abs(amount).toFixed(2).split(".");
      return `${amount < 0 ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
    };

    // One line per bucket, so nothing here is nameable by accident: a clean
    // line covers the money, and the eight below are the eight reasons a dollar
    // is not covered. FSW - 1.5 is restated from EA to LF by the draft; FSW - 3
    // is not in the draft at all.
    const restated = withLabor(FSW_1_5, { craftUnits: "LF", weldUnits: "LF" });
    const eightBuckets = report([
      run({
        activities: [
          fswLine(),
          fswLine({ labor: { craftConstant: 0.75, welderConstant: 0.7 } }),
          fswLine({ description: MANLIFT_60.description }),
          fswLine({
            laborPoolId: FSW_3.poolId,
            description: FSW_3.description,
            labor: { craftConstant: FSW_3.craftConstant, welderConstant: FSW_3.weldConstant },
          }),
          fswLine({
            laborPoolId: FSW_1_5.poolId,
            description: FSW_1_5.description,
            labor: { craftConstant: FSW_1_5.craftConstant, welderConstant: FSW_1_5.weldConstant },
          }),
          fswLine({ laborPoolId: 99999 }),
          plainLine("custom_labor", {
            description: "NIGHT SHIFT SUPERVISION",
            labor: { craftConstant: 8, welderConstant: 0 },
          }),
          breakerLine(),
          plainLine("cost_only", { description: "PERMIT", unitPrice: 250 }),
        ],
        parentLabor: laborBook(FSW_1, FSW_3, FSW_1_5),
        draftLabor: laborBook(withLabor(FSW_1, { craftConstant: 0.9 }), restated),
      }),
    ]);
    const coverage = eightBuckets.caveats.find((line) => line.startsWith("This figure covers"));

    it("has a phrase for every bucket the run produces, so no excluded dollar is nameless", () => {
      expect(Object.keys(CARRIED_BUCKET_PHRASES).sort()).toEqual(
        Object.keys(eightBuckets.carriedDollars).sort()
      );
    });

    it("names all eight buckets with their own figures beside the total that includes them", () => {
      // The total is a walk of the object. When the list was hand-written it
      // stopped at seven while the sum reached eight, and $4,000,000 of a stated
      // $5,000,000 was named nowhere — a reader adding up the categories got a
      // fifth of the number printed above them.
      for (const bucket of Object.keys(CARRIED_BUCKET_PHRASES) as CarriedBucket[]) {
        expect(eightBuckets.carriedDollars[bucket]).not.toBe(0);
        expect(coverage).toContain(
          `${usd(eightBuckets.carriedDollars[bucket])} of ${CARRIED_BUCKET_PHRASES[bucket]}`
        );
      }
    });

    it("still splits the estimate to the cent with all eight buckets carrying money", () => {
      const carried = eightBuckets.carriedDollars;
      const sum = Object.values(carried).reduce(
        (total, value) => total + value,
        eightBuckets.coveredDollars
      );

      expect(round2(sum)).toBe(eightBuckets.cost.baseline);
    });
  });

  it("says the repricing used each estimate's own historical rates", () => {
    expect(finished.caveats.some((line) => line.includes("own historical rates"))).toBe(true);
  });

  it("says the licence errs in both directions and cannot be assumed to cancel", () => {
    const licence = finished.caveats.find((line) => line.includes("both directions"));

    expect(licence).toContain("no reason to believe they cancel");
  });

  it("counts one linked line in the singular, which is what a young book's first run measures", () => {
    const licence = (of: BenchmarkReport): string | undefined =>
      of.caveats.find((line) => line.includes("both directions"));
    const two = report([run({ activities: [fswLine(), fswLine()] })]);

    // The paragraph asking a reader to trust a measured proportion is the last
    // place to tell them the software cannot count.
    expect(licence(finished)).toContain("100.0% of 1 linked labor line corroborates");
    expect(licence(two)).toContain("100.0% of 2 linked labor lines corroborate");
  });

  it("stamps the moment the run finished, because activities change constantly", () => {
    expect(finished.caveats.some((line) => line.includes("This run is a snapshot"))).toBe(true);
  });

  it("is never empty, whatever the run measured", () => {
    expect(benchmarkCaveats(report([])).length).toBeGreaterThan(0);
    expect(finished.caveats.length).toBeGreaterThan(0);
  });
});
