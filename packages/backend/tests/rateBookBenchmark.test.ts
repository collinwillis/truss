/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The Convex layer of the reprice benchmark, driven end to end.
 *
 * `model/repriceBenchmark.ts` has its own suite and it runs in plain Node, so
 * nothing here re-tests the rules. What is only testable HERE is everything the
 * pure module cannot see: that the population really is every estimate on the
 * parent book, that the excluded ones are named rather than counted, that the
 * baseline reproduces the number `recomputeProposalTotal` wrote, that the two
 * reach maps are counted through two indexes because id 1 is two different
 * items, that an accumulator survives a reschedule with its `Set` and its `Map`
 * intact, and that an estimate a previous segment already recorded is skipped
 * rather than folded in twice.
 *
 * ⚠️ THE SELF-CHECK ASSERTION IS THE POINT OF THIS FILE. The module's comment
 * claims `round2(baseline.costs.totalCost)` equals what `recomputeProposalTotal`
 * writes into `proposals.costTotal`, and that claim is load-bearing: if the
 * harness is not reading these estimates the way the app does, every figure it
 * prints is measuring something else while looking authoritative. Here the
 * cached total is written by that mutation, not by a literal in a comment, so
 * the equality is enforced rather than asserted in prose.
 */
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { DEFAULT_DIFF_THRESHOLDS } from "../convex/model/rateBookDiff";
import { round2 } from "../convex/model/costEngine";
import {
  accumulateProposal,
  benchmarkProposal,
  emptyBenchmarkAccumulator,
  serializeAccumulator,
  type EquipmentCatalogRow,
  type LaborCatalogRow,
} from "../convex/model/repriceBenchmark";
import { ownerHarness, type Caller } from "./authFixtures";
import type { TestRunner } from "./convexFixtures";
import { RATES_2020 } from "./rates";

const DRAFT_REVISION = 4;

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/**
 * The `kind` a refusal carries, or a failure naming what it carried instead.
 *
 * ⚠️ ASSERTING THAT A CALL THREW IS NOT ASSERTING THAT IT REFUSED. Convex
 * redacts a plain `Error`'s message on a production deployment, so a refusal a
 * screen has to tell apart from every other failure has to arrive as a
 * `ConvexError` with a kind — and `.rejects.toThrow()` with no argument passes
 * for either. That is how `startBenchmark` came to answer "the comparison you
 * were told to run first is still running" with a message the customer never
 * sees, while `resumeBenchmark` answered the identical condition with a kind.
 */
async function refusalKind(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ConvexError)) {
      throw new Error(
        `that refusal was a plain Error, whose message production redacts: ${String(error)}`
      );
    }
    const data: unknown = error.data;
    if (typeof data === "object" && data !== null && "kind" in data) {
      return String((data as { kind: unknown }).kind);
    }
    throw new Error("that refusal carried no kind");
  }
  throw new Error("that call was supposed to be refused and was not");
}

// ---------------------------------------------------------------------------
// The catalogs, stated once
// ---------------------------------------------------------------------------
//
// Four labor items and one equipment item, chosen so every branch the report
// distinguishes is exercised by a real line rather than by a zero:
//
//   1     changed constant, exercised by two lines on one estimate — so its
//         labor reach is 2 while EQUIPMENT id 1, a different item entirely, has
//         a reach of 1. One map keyed by a bare poolId cannot hold both.
//   2738  changed craft AND weld constants, exercised by a line whose snapshot
//         matches the parent exactly — the only shape that is repriced. The
//         weld leg moves separately from the craft leg, which is what catches
//         the `welderConstant`/`weldConstant` pairing being crossed.
//   2739  changed only in `sortOrder`, and the estimate that uses it typed over
//         the craft constant. Its CRAFT leg is therefore an override and carried
//         money — but its weld leg is a pair of zeros, which the module reads as
//         `repriced_no_delta`, so the item still counts as exercised. Coverage is
//         about items the run could speak for, not about items that moved.
//   2740  changed constant, on no estimate anywhere. This is the "41 of 380
//         changed rows measured" population, and `neverExercised` names it.

interface LaborSpec extends LaborCatalogRow {
  phasePoolId: number;
  sortOrder: number;
}

const PARENT_LABOR: LaborSpec[] = [
  {
    poolId: 1,
    description: "MANLIFT OP",
    craftConstant: 1,
    weldConstant: 0,
    craftUnits: "HR",
    weldUnits: "",
    isActive: true,
    phasePoolId: 70001,
    sortOrder: 10,
  },
  {
    poolId: 2738,
    description: "FSW - ≤.75",
    craftConstant: 0.6,
    weldConstant: 0.4,
    craftUnits: "LF",
    weldUnits: "LF",
    isActive: true,
    phasePoolId: 70001,
    sortOrder: 20,
  },
  {
    poolId: 2739,
    description: "CUT - 2",
    craftConstant: 0.25,
    weldConstant: 0,
    craftUnits: "EA",
    weldUnits: "",
    isActive: true,
    phasePoolId: 70001,
    sortOrder: 30,
  },
  {
    poolId: 2740,
    description: "BEVEL - 4",
    craftConstant: 0.9,
    weldConstant: 0,
    craftUnits: "EA",
    weldUnits: "",
    isActive: true,
    phasePoolId: 70001,
    sortOrder: 40,
  },
];

const DRAFT_LABOR: LaborSpec[] = [
  { ...must(PARENT_LABOR[0], "labor 1"), craftConstant: 1.5 },
  { ...must(PARENT_LABOR[1], "labor 2738"), craftConstant: 0.72, weldConstant: 0.5 },
  // Moved in the list and nowhere else: a change the comparison sees and no
  // estimate can feel.
  { ...must(PARENT_LABOR[2], "labor 2739"), sortOrder: 35 },
  { ...must(PARENT_LABOR[3], "labor 2740"), craftConstant: 1.1 },
];

interface EquipmentSpec extends EquipmentCatalogRow {
  sortOrder: number;
}

const PARENT_EQUIPMENT: EquipmentSpec[] = [
  {
    poolId: 1,
    description: "AIR COMPRESSOR 0-185 CFM",
    hourRate: 8,
    dayRate: 64,
    weekRate: 256,
    monthRate: 768,
    isActive: true,
    sortOrder: 10,
  },
];

const DRAFT_EQUIPMENT: EquipmentSpec[] = [
  { ...must(PARENT_EQUIPMENT[0], "equipment 1"), hourRate: 9, dayRate: 72 },
];

/** Every line of the two estimates the parent book priced. */
interface LineSpec {
  type: Doc<"activities">["type"];
  description: string;
  quantity: number;
  laborPoolId?: number;
  equipmentPoolId?: number;
  unitPrice?: number;
  labor?: { craftConstant: number; welderConstant: number };
  equipment?: { ownership: "rental" | "owned" | "purchase"; time: number };
}

const ESTIMATES: { proposalNumber: string; lines: LineSpec[] }[] = [
  {
    proposalNumber: "1956.01",
    lines: [
      // Repriced: id, description and both constants all agree with the parent.
      {
        type: "labor",
        description: "FSW - ≤.75",
        quantity: 100,
        laborPoolId: 2738,
        labor: { craftConstant: 0.6, welderConstant: 0.4 },
      },
      // Overridden: 0.3 is not the catalog's 0.25, so nothing here is repriced
      // and every dollar of it is carried.
      {
        type: "labor",
        description: "CUT - 2",
        quantity: 40,
        laborPoolId: 2739,
        labor: { craftConstant: 0.3, welderConstant: 0 },
      },
      // Equipment: never repriced, always carried, and traceable to exactly one
      // tier because 64 is the day rate and no other.
      {
        type: "equipment",
        description: "AIR COMPRESSOR 0-185 CFM",
        quantity: 1,
        equipmentPoolId: 1,
        unitPrice: 64,
        equipment: { ownership: "rental", time: 5 },
      },
      { type: "material", description: "PIPE", quantity: 5, unitPrice: 10 },
    ],
  },
  {
    proposalNumber: "1957",
    lines: [
      {
        type: "labor",
        description: "MANLIFT OP",
        quantity: 10,
        laborPoolId: 1,
        labor: { craftConstant: 1, welderConstant: 0 },
      },
      {
        type: "labor",
        description: "MANLIFT OP",
        quantity: 6,
        laborPoolId: 1,
        labor: { craftConstant: 1, welderConstant: 0 },
      },
    ],
  },
];

interface Fixture {
  t: TestRunner;
  as: Caller;
  parentBookId: Id<"rateBooks">;
  draftBookId: Id<"rateBooks">;
  otherBookId: Id<"rateBooks">;
  priced: Id<"proposals">[];
}

/**
 * Two books, two estimates on the parent, and two estimates that are not.
 *
 * The excluded pair is deliberate: one estimate pinned to a DIFFERENT published
 * book, and one pinned to nothing at all. The second is not exotic — the
 * six-hourly proposals sync inserts proposals with no `bookId`, which is the
 * population G8 blocks publish on — and it is the case where "excluded" has no
 * id to print.
 */
async function seedBooks(): Promise<Fixture> {
  const { t, as } = await ownerHarness();

  const seeded = await t.run(async (ctx) => {
    const parentBookId = await ctx.db.insert("rateBooks", {
      bookNumber: 1,
      name: "Original Rate Book",
      status: "published",
      isDefault: true,
      createdBy: "fixture",
      createdAt: 0,
      publishedBy: "fixture",
      publishedAt: 0,
      buildState: "ready",
      proposalCount: 2,
    });
    const otherBookId = await ctx.db.insert("rateBooks", {
      bookNumber: 9,
      name: "Someone Else's Book",
      status: "published",
      isDefault: false,
      createdBy: "fixture",
      createdAt: 0,
      buildState: "ready",
      proposalCount: 1,
    });
    const draftBookId = await ctx.db.insert("rateBooks", {
      bookNumber: 2,
      name: "2026 Rate Book",
      status: "draft",
      parentBookId,
      isDefault: false,
      createdBy: "fixture",
      createdAt: 0,
      buildState: "ready",
      proposalCount: 0,
      contentRevision: DRAFT_REVISION,
      contentRevisionAt: 0,
    });

    for (const [bookId, labor, equipment] of [
      [parentBookId, PARENT_LABOR, PARENT_EQUIPMENT] as const,
      [draftBookId, DRAFT_LABOR, DRAFT_EQUIPMENT] as const,
    ]) {
      for (const row of labor) {
        await ctx.db.insert("laborPool", {
          bookId,
          datasetVersion: "v1",
          poolId: row.poolId,
          phasePoolId: row.phasePoolId,
          description: row.description,
          sortOrder: row.sortOrder,
          craftConstant: row.craftConstant,
          craftUnits: row.craftUnits,
          weldConstant: row.weldConstant,
          weldUnits: row.weldUnits,
          isCustom: false,
          isActive: row.isActive,
          rowRevision: 0,
        });
      }
      for (const row of equipment) {
        await ctx.db.insert("equipmentPool", {
          bookId,
          datasetVersion: "v1",
          poolId: row.poolId,
          description: row.description,
          hourRate: row.hourRate,
          dayRate: row.dayRate,
          weekRate: row.weekRate,
          monthRate: row.monthRate,
          sortOrder: row.sortOrder,
          isCustom: false,
          isActive: row.isActive,
          rowRevision: 0,
        });
      }
    }

    const priced: Id<"proposals">[] = [];
    for (const estimate of ESTIMATES) {
      const proposalId = await ctx.db.insert("proposals", {
        proposalNumber: estimate.proposalNumber,
        description: "Tank 8 installation",
        ownerName: "Test Owner",
        rates: { ...RATES_2020 },
        datasetVersion: "v1",
        bookId: parentBookId,
      });
      const wbsId = await ctx.db.insert("wbs", {
        proposalId,
        wbsPoolId: 70000,
        name: "AG PIPING",
        sortOrder: 1,
      });
      const phaseId = await ctx.db.insert("phases", {
        proposalId,
        wbsId,
        phasePoolId: 70001,
        poolName: "CARBON STEEL",
        phaseNumber: 1,
        description: "Phase 1",
        isCompleted: false,
        sortOrder: 1,
      });
      for (const [index, line] of estimate.lines.entries()) {
        await ctx.db.insert("activities", {
          proposalId,
          wbsId,
          phaseId,
          type: line.type,
          description: line.description,
          quantity: line.quantity,
          unit: "EA",
          sortOrder: index + 1,
          ...(line.laborPoolId !== undefined ? { laborPoolId: line.laborPoolId } : {}),
          ...(line.equipmentPoolId !== undefined ? { equipmentPoolId: line.equipmentPoolId } : {}),
          ...(line.unitPrice !== undefined ? { unitPrice: line.unitPrice } : {}),
          ...(line.labor ? { labor: line.labor } : {}),
          ...(line.equipment ? { equipment: line.equipment } : {}),
        });
      }
      priced.push(proposalId);
    }

    await ctx.db.insert("proposals", {
      proposalNumber: "1900",
      description: "On another book",
      ownerName: "Test Owner",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
      bookId: otherBookId,
    });
    await ctx.db.insert("proposals", {
      proposalNumber: "2001",
      description: "Pinned to nothing",
      ownerName: "Test Owner",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });

    return { parentBookId, otherBookId, draftBookId, priced };
  });

  return { t, as, ...seeded };
}

/**
 * A comparison the benchmark is allowed to measure its coverage against.
 *
 * Hand-built rather than produced by a real diff run, and only two of its fields
 * are ever read here: `changedLaborPoolIds` and `changedEquipmentPoolIds` are
 * the coverage denominator and the reach roster. Building it through
 * `summarizeDiff` would tie this suite to the shape of a run it does not test,
 * and the compiler already refuses a summary the table would not accept.
 */
async function seedReadyDiff(
  t: TestRunner,
  bookId: Id<"rateBooks">,
  parentBookId: Id<"rateBooks">,
  revision = DRAFT_REVISION
): Promise<Id<"rateBookDiffs">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("rateBookDiffs", {
      bookId,
      parentBookId,
      state: "ready",
      startedBy: "fixture",
      startedAt: 0,
      finishedAt: 1,
      startedAtContentRevision: revision,
      finishedAtContentRevision: revision,
      summary: {
        pools: [],
        changedRowCount: 4,
        unchangedRowCount: 0,
        flagCounts: {
          shifted_payload: 0,
          description_swap: 0,
          decimal_shift: 0,
          implausible_magnitude: 0,
          large_change: 0,
          zeroed_constant: 0,
          constant_activated: 0,
          unit_changed: 0,
          rate_tier_inversion: 0,
          reparented: 0,
          takeoff_flags_bulk: 0,
          live_read_field: 0,
        },
        effectCounts: { priced_at_creation: 4, read_live: 0 },
        shiftBands: [],
        systematicGroups: [],
        changedLaborPoolIds: [1, 2738, 2739, 2740],
        changedEquipmentPoolIds: [1],
        deactivatedPoolIds: { wbs: [], phases: [], labor: [], equipment: [] },
        bulkEditPools: [],
        massChangePools: [],
        takeoffFlagBulkPhases: [],
        thresholds: { ...DEFAULT_DIFF_THRESHOLDS },
      },
    })
  );
}

/** Cache each priced estimate's total through its ONLY writer. */
async function cacheTotals(t: TestRunner, proposalIds: readonly Id<"proposals">[]): Promise<void> {
  for (const proposalId of proposalIds) {
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId });
  }
}

/** The finished run for a draft, or a failure of the test rather than a null. */
async function finishedRun(
  t: TestRunner,
  benchmarkId: Id<"rateBookBenchmarks">
): Promise<Doc<"rateBookBenchmarks">> {
  return must(await t.run(async (ctx) => ctx.db.get(benchmarkId)), "the benchmark");
}

/** Seed, cache the totals, run the whole thing, and hand back what it wrote. */
async function runBenchmark(): Promise<{
  fixture: Fixture;
  run: Doc<"rateBookBenchmarks">;
  report: NonNullable<Doc<"rateBookBenchmarks">["report"]>;
}> {
  const fixture = await seedBooks();
  await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId);
  await cacheTotals(fixture.t, fixture.priced);

  const { benchmarkId } = await fixture.as.mutation(api.rateBookBenchmark.startBenchmark, {
    bookId: fixture.draftBookId,
  });
  await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);

  const run = await finishedRun(fixture.t, benchmarkId);
  return { fixture, run, report: must(run.report, "the report") };
}

describe("the reprice benchmark, run through Convex", () => {
  it("prices every estimate on the parent book and names the ones it did not", async () => {
    vi.useFakeTimers();
    try {
      const { fixture, run, report } = await runBenchmark();

      expect(run.state).toBe("ready");
      expect(report.proposalsCompared).toBe(2);

      // ⚠️ The population rule, and the reason it is not a sample: every
      // estimate NOT priced is named. "2 of 4" with no list is a number nobody
      // can check, and "who chose these?" is the first question a sampled
      // benchmark has to answer.
      expect(new Set(report.proposalsExcluded.map((entry) => entry.proposalNumber))).toEqual(
        new Set(["1900", "2001"])
      );
      const unpinned = must(
        report.proposalsExcluded.find((entry) => entry.proposalNumber === "2001"),
        "the unpinned exclusion"
      );
      expect(unpinned.bookId).toBe("unpinned");

      // Craft moved on two items (12 hours on 2738, 8 on id 1) and the welder
      // leg moved on one (0.1 x 100). A crossed `welderConstant`/`weldConstant`
      // pairing makes the second of those exactly zero while every other figure
      // still looks plausible, which is why it is asserted on its own.
      expect(report.craftHours.baseline).toBe(88);
      expect(report.craftHours.repriced).toBe(108);
      expect(report.craftHours.delta).toBe(20);
      expect(report.welderHours.delta).toBe(10);
      expect(report.cost.delta).toBeGreaterThan(0);
      expect(round2(report.cost.repriced - report.cost.baseline)).toBe(report.cost.delta);

      // "41 of 380 changed rows measured" is the true state of the evidence on
      // a real revision, and it has to be printable: three of the four changed
      // items appear on an estimate, and the fourth is NAMED rather than
      // averaged into a percentage.
      expect(report.coverage.changedLaborPoolIds).toBe(4);
      expect(report.coverage.exercisedLaborPoolIds).toBe(3);
      expect(report.coverage.neverExercised).toEqual([2740]);

      expect(report.lines.total).toBe(6);
      expect(report.lines.byLine.repriced).toBe(3);
      expect(report.lines.byLine.estimator_override).toBe(1);
      expect(report.lines.byLine.no_catalog_reference).toBe(2);

      expect(report.measuredRates.laborLinesWithCatalogReference).toBe(4);
      expect(report.measuredRates.descriptionCorroborated).toBe(1);
      expect(report.measuredRates.constantUnchanged).toBe(0.75);
      expect(report.measuredRates.divergesFromSample).toBe(false);

      // One row per estimate priced, which is what makes the resume idempotent
      // and "why did MY estimate not move" answerable.
      const rows = await fixture.t.run(async (ctx) =>
        ctx.db
          .query("rateBookBenchmarkProposals")
          .withIndex("by_benchmark", (q) => q.eq("benchmarkId", run._id))
          .collect()
      );
      expect(rows).toHaveLength(2);

      // Held only WHILE COMPUTING: an admin reading a benchmark must not block
      // the import that benchmark told them to run.
      const book = must(
        await fixture.t.run(async (ctx) => ctx.db.get(fixture.draftBookId)),
        "the draft"
      );
      expect(book.lock).toBeUndefined();
      expect(run.checkpoint).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reproduces the total recomputeProposalTotal itself wrote, to the cent", async () => {
    vi.useFakeTimers();
    try {
      const { fixture, run, report } = await runBenchmark();

      // BLOCKING in aggregate, and this is the assertion behind that word. The
      // cached figure here was written by the only writer of `costTotal`, from
      // `rollUpProposal` with an empty indirect set and `roundCosts` — the
      // identical call `benchmarkProposal` makes. Nothing is compared against a
      // hand-computed literal.
      expect(report.selfCheckFailures).toEqual([]);

      const rows = await fixture.t.run(async (ctx) =>
        ctx.db
          .query("rateBookBenchmarkProposals")
          .withIndex("by_benchmark", (q) => q.eq("benchmarkId", run._id))
          .collect()
      );
      for (const row of rows) {
        const proposal = must(
          await fixture.t.run(async (ctx) => ctx.db.get(row.proposalId)),
          "the estimate"
        );
        expect(row.selfCheckMatches).toBe(true);
        expect(row.selfCheckComputed).toBe(proposal.costTotal);
        expect(row.baselineCost).toBe(proposal.costTotal);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("accounts for every dollar in the estimates, covered or carried", async () => {
    vi.useFakeTimers();
    try {
      const { report } = await runBenchmark();

      // THE PARTITION, and it is the claim the whole report rests on: covered
      // plus the eight carried buckets is the money in these estimates, to the
      // cent. A headline that quietly leaves 81% of equipment out of both sides
      // is the artifact that destroys trust the day somebody finds out.
      const carried = Object.values(report.carriedDollars).reduce((sum, bucket) => sum + bucket, 0);
      expect(round2(report.coveredDollars + carried)).toBe(report.cost.baseline);

      // Each bucket the fixture exercises is non-zero, so the partition is not
      // closing because everything landed in one place.
      expect(report.carriedDollars.overriddenLabor).toBeGreaterThan(0);
      expect(report.carriedDollars.equipment).toBeGreaterThan(0);
      expect(report.carriedDollars.materialAndSub).toBeGreaterThan(0);
      expect(report.carriedDollars.danglingLabor).toBe(0);

      // Equipment is traced and never repriced. `corroboratedDelta` is a real
      // number over the one line whose tier is unambiguous, and it lives on its
      // own key so no UI can fold it into the headline — every equipment dollar
      // is still sitting in the carried column above.
      expect(report.equipment.linesTotal).toBe(1);
      expect(report.equipment.linesCorroborated).toBe(1);
      expect(report.equipment.linesExposedToChange).toBe(1);
      expect(report.equipment.corroboratedDelta).toBeGreaterThan(0);
      expect(report.equipment.facts.changedRows).toBe(1);
      expect(report.equipment.carriedDollars).toBe(report.carriedDollars.equipment);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts reach through two indexes, because id 1 is two different items", async () => {
    vi.useFakeTimers();
    try {
      const { report } = await runBenchmark();

      expect(report.reachAvailable).toBe(true);
      // The whole reason `laborReach` and `equipmentReach` are two arrays and
      // `activities` carries two indexes. Labor 1 is "MANLIFT OP" on two lines;
      // equipment 1 is "AIR COMPRESSOR 0-185 CFM" on one. A single map keyed by
      // a bare poolId reports one of these counts under the other's name.
      expect(report.laborReach).toContainEqual({ poolId: 1, lines: 2 });
      expect(report.laborReach).toContainEqual({ poolId: 2738, lines: 1 });
      expect(report.equipmentReach).toEqual([{ poolId: 1, lines: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resuming a benchmark", () => {
  /**
   * The state a run is in when an invocation dies after estimate one of two.
   *
   * Built by CALLING the pure module rather than by writing out what it is
   * believed to return: the accumulator holds a `Set` and a `Map`, and
   * `serializeAccumulator` is the function that knows which two. If the stored
   * snapshot revived wrongly, `proposalsCompared` and every dollar below it
   * would come out smaller than the truth and none of it would look wrong.
   */
  async function seedHalfFinishedRun(fixture: Fixture): Promise<Id<"rateBookBenchmarks">> {
    const first = must(fixture.priced[0], "the first estimate");
    const activities = await fixture.t.run(async (ctx) =>
      ctx.db
        .query("activities")
        .withIndex("by_proposal", (q) => q.eq("proposalId", first))
        .collect()
    );
    const proposal = must(await fixture.t.run(async (ctx) => ctx.db.get(first)), "the estimate");

    const catalog = async (
      bookId: Id<"rateBooks">
    ): Promise<{
      labor: Map<number, LaborCatalogRow>;
      equipment: Map<number, EquipmentCatalogRow>;
    }> => {
      const rows = await fixture.t.run(async (ctx) => ({
        labor: await ctx.db
          .query("laborPool")
          .withIndex("by_book", (q) => q.eq("bookId", bookId))
          .collect(),
        equipment: await ctx.db
          .query("equipmentPool")
          .withIndex("by_book", (q) => q.eq("bookId", bookId))
          .collect(),
      }));
      return {
        labor: new Map(rows.labor.map((row) => [row.poolId, row])),
        equipment: new Map(rows.equipment.map((row) => [row.poolId, row])),
      };
    };
    const parent = await catalog(fixture.parentBookId);
    const draft = await catalog(fixture.draftBookId);

    const accumulator = emptyBenchmarkAccumulator();
    const result = benchmarkProposal({
      proposalNumber: proposal.proposalNumber,
      cachedCostTotal: proposal.costTotal,
      rates: proposal.rates,
      activities,
      parentLabor: parent.labor,
      draftLabor: draft.labor,
      parentEquipment: parent.equipment,
      draftEquipment: draft.equipment,
    });
    accumulateProposal(accumulator, result);
    const snapshot = serializeAccumulator(accumulator);

    const now = Date.now();
    return await fixture.t.run(async (ctx) => {
      const benchmarkId = await ctx.db.insert("rateBookBenchmarks", {
        bookId: fixture.draftBookId,
        parentBookId: fixture.parentBookId,
        state: "running",
        startedBy: "fixture",
        startedAt: now,
        lastProgressAt: now,
        basedOnContentRevision: DRAFT_REVISION,
        progress: { done: 1, total: 2 },
        checkpoint: {
          // Still at the head of the population walk, which is where a
          // page-boundary cursor sits after the first estimate of a page.
          cursor: null,
          activityDocumentsRead: activities.length,
          accumulator: {
            ...snapshot,
            exercisedLaborPoolIds: [...snapshot.exercisedLaborPoolIds],
            perItemDelta: [...snapshot.perItemDelta],
          },
        },
      });
      await ctx.db.insert("rateBookBenchmarkProposals", {
        benchmarkId,
        proposalId: first,
        proposalNumber: proposal.proposalNumber,
        baselineCost: round2(result.baseline.costs.totalCost),
        repricedCost: round2(result.counterfactual.costs.totalCost),
        delta: 0,
        deltaPct: 0,
        selfCheckMatches: result.selfCheck.matches,
        selfCheckCached: result.selfCheck.cached,
        selfCheckComputed: result.selfCheck.computed,
        lines: { total: result.lines.total, byLine: { ...result.lines.byLine } },
        coveredDollars: result.coveredDollars,
        carriedDollars: { ...result.carriedDollars },
      });
      await ctx.db.patch(fixture.draftBookId, {
        lock: { op: "benchmark", startedBy: "fixture", startedAt: now, heartbeatAt: now },
      });
      return benchmarkId;
    });
  }

  it("folds an estimate an earlier segment already recorded exactly once", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await seedBooks();
      await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId);
      await cacheTotals(fixture.t, fixture.priced);
      const benchmarkId = await seedHalfFinishedRun(fixture);

      await fixture.t.action(internal.rateBookBenchmark.runBenchmarkSegment, { benchmarkId });
      await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);

      const report = must((await finishedRun(fixture.t, benchmarkId)).report, "the report");
      // Two, not three. The cursor only moves at a page boundary, so the resumed
      // segment re-reads the estimate the checkpoint already contains — and the
      // row in `rateBookBenchmarkProposals` is what tells it to skip rather than
      // add. Double-counting would read as 3 estimates and 176 craft hours.
      expect(report.proposalsCompared).toBe(2);
      expect(report.craftHours.baseline).toBe(88);
      expect(report.craftHours.delta).toBe(20);

      const rows = await fixture.t.run(async (ctx) =>
        ctx.db
          .query("rateBookBenchmarkProposals")
          .withIndex("by_benchmark", (q) => q.eq("benchmarkId", benchmarkId))
          .collect()
      );
      expect(rows).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("picks up a run that stalled in running, not only one that recorded failure", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await seedBooks();
      await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId);
      await cacheTotals(fixture.t, fixture.priced);
      const benchmarkId = await seedHalfFinishedRun(fixture);

      // An action killed by a deploy records nothing at all: the run sits in
      // `running` with a heartbeat that stopped moving. A resume that only
      // accepted `failed` would leave it unresumable for ever, holding the
      // single draft slot — which is exactly how the link repair wedged.
      await fixture.t.run(async (ctx) => {
        await ctx.db.patch(benchmarkId, { lastProgressAt: 0 });
      });

      const resumed = await fixture.as.mutation(api.rateBookBenchmark.resumeBenchmark, {
        benchmarkId,
      });
      expect(resumed).toEqual({ pricedSoFar: 1, of: 2 });
      await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);

      const run = await finishedRun(fixture.t, benchmarkId);
      expect(run.state).toBe("ready");
      expect(must(run.report, "the report").proposalsCompared).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to finish a run the draft has moved underneath", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await seedBooks();
      await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId);
      await cacheTotals(fixture.t, fixture.priced);

      const { benchmarkId } = await fixture.as.mutation(api.rateBookBenchmark.startBenchmark, {
        bookId: fixture.draftBookId,
      });
      // An import lands between the start and the first segment. The catalogs
      // are re-read per invocation, so finishing would produce a report about a
      // catalog that never existed at any single moment — the torn read G5
      // blocks on, arriving through the benchmark's own resume path.
      await fixture.t.run(async (ctx) => {
        await ctx.db.patch(fixture.draftBookId, { contentRevision: DRAFT_REVISION + 1 });
      });
      await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);

      const run = await finishedRun(fixture.t, benchmarkId);
      expect(run.state).toBe("failed");
      expect(run.error).toContain("changed while the benchmark was running");
      expect(run.report).toBeUndefined();

      const book = must(
        await fixture.t.run(async (ctx) => ctx.db.get(fixture.draftBookId)),
        "the draft"
      );
      expect(book.lock).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what a benchmark refuses", () => {
  it("will not start without a current comparison", async () => {
    const fixture = await seedBooks();

    // No comparison at all.
    await expect(
      fixture.as.mutation(api.rateBookBenchmark.startBenchmark, { bookId: fixture.draftBookId })
    ).rejects.toThrow();

    // One at the wrong revision is no better: the coverage denominator would be
    // counted over a catalog this draft no longer is.
    await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId, DRAFT_REVISION - 1);
    await expect(
      fixture.as.mutation(api.rateBookBenchmark.startBenchmark, { bookId: fixture.draftBookId })
    ).rejects.toThrow();
  });

  it("says the draft is busy in a way a screen can read, at both of its doors", async () => {
    const fixture = await seedBooks();
    await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId);

    // ⚠️ THE OP THAT IS NOT `benchmark`, and `diff` specifically, because that is
    // the one an admin meets: the benchmark refuses to start without a current
    // comparison, so "the comparison is still running" is the ordinary way this
    // refusal is reached — not an edge case.
    const benchmarkId = await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.draftBookId, {
        lock: { op: "diff", startedBy: "someone", startedAt: 0, heartbeatAt: Date.now() },
      });
      return await ctx.db.insert("rateBookBenchmarks", {
        bookId: fixture.draftBookId,
        parentBookId: fixture.parentBookId,
        state: "failed",
        startedBy: "fixture",
        startedAt: 0,
        basedOnContentRevision: DRAFT_REVISION,
      });
    });

    // Both doors into one job, answering one condition. They disagreed: the
    // resume named it and the start did not.
    expect(
      await refusalKind(
        fixture.as.mutation(api.rateBookBenchmark.startBenchmark, {
          bookId: fixture.draftBookId,
        })
      )
    ).toBe("benchmark_busy");
    expect(
      await refusalKind(fixture.as.mutation(api.rateBookBenchmark.resumeBenchmark, { benchmarkId }))
    ).toBe("benchmark_busy");
  });

  it("will not sign a benchmark the draft has outgrown", async () => {
    vi.useFakeTimers();
    try {
      const { fixture, run } = await runBenchmark();

      await fixture.as.mutation(api.rateBookBenchmark.acknowledgeBenchmark, {
        benchmarkId: run._id,
      });
      const signed = await finishedRun(fixture.t, run._id);
      expect(signed.acknowledgedAtContentRevision).toBe(DRAFT_REVISION);

      // One more write to the draft and the signature is about numbers that no
      // longer describe it, so a second one cannot be given either.
      await fixture.t.run(async (ctx) => {
        await ctx.db.patch(fixture.draftBookId, { contentRevision: DRAFT_REVISION + 1 });
      });
      await expect(
        fixture.as.mutation(api.rateBookBenchmark.acknowledgeBenchmark, { benchmarkId: run._id })
      ).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("will not sign a run whose baseline did not reproduce the app's own totals", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await seedBooks();
      await seedReadyDiff(fixture.t, fixture.draftBookId, fixture.parentBookId);
      // No `recomputeProposalTotal`, so nothing has a cached total. An ABSENT
      // total is a failure rather than a pass: we could not verify, so we do not
      // claim we did, and the remedy is the totals backfill.
      const { benchmarkId } = await fixture.as.mutation(api.rateBookBenchmark.startBenchmark, {
        bookId: fixture.draftBookId,
      });
      await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);

      const report = must((await finishedRun(fixture.t, benchmarkId)).report, "the report");
      expect(report.selfCheckFailures).toHaveLength(2);
      expect(report.caveats[0]).toContain("READ NOTHING BELOW YET");

      await expect(
        fixture.as.mutation(api.rateBookBenchmark.acknowledgeBenchmark, { benchmarkId })
      ).rejects.toThrow();

      // And they read as their own class rather than as a capped slice of a
      // mixed list, which is the only way three real failures are not hidden
      // under a hundred healthy estimates.
      const failures = await fixture.as.query(api.rateBookBenchmark.listSelfCheckFailures, {
        benchmarkId,
      });
      expect(failures).toHaveLength(2);
      expect(failures.every((failure) => failure.cached === null)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
