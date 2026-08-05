/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The wiring between `model/publishGates.ts` and the button.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM `publishGates.test.ts`. That file proves
 * the gates decide correctly from facts handed to them; this one proves the
 * facts handed to them are the ones the database holds. Every failure mode this
 * subsystem is built around lives in the gap between those two statements: a
 * finished import read as an unfinished one, a signature that outlives the
 * catalog it was about, a retirement list silently showing 50 of 400, a diff
 * summary that is absent being read as a diff that found nothing.
 *
 * So the fixtures build their `DiffSummary` and `BenchmarkReport` by CALLING the
 * pure modules rather than by writing out what they are believed to return —
 * the same rule `rateBookRevision.test.ts` follows, and for the same reason: a
 * field the modules and the schema disagree about has to fail here rather than
 * in front of somebody publishing a rate book.
 */
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  DEFAULT_DIFF_THRESHOLDS,
  diffPair,
  newDraftScanState,
  newPoolTally,
  observeDraftRow,
  poolIntegrity,
  summarizeDiff,
  tallyPair,
  type DiffRowInput,
  type DiffSummary,
} from "../convex/model/rateBookDiff";
import {
  emptyBenchmarkAccumulator,
  equipmentRateFacts,
  finalizeBenchmark,
  type BenchmarkReport,
} from "../convex/model/repriceBenchmark";
import { ownerHarness, type Caller } from "./authFixtures";
import { RATES_2020 } from "./rates";
import type { TestRunner } from "./convexFixtures";

const WBS_CODE = 70000;
const PHASE_CODE = 70001;

/** The one labor row this draft re-rates, doubled so it carries `large_change`. */
const EDITED_ID = 2738;

/** Filler rows, so a single retirement is not 50% of the pool and a mass change. */
const FILLER_ROWS = 40;

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/**
 * Step the clock between two mutations.
 *
 * `Date.now()` is fixed for the duration of a Convex mutation and `touchDraft`
 * compares against it, so two writes in one millisecond read as one transaction
 * and the revision moves once. Under fake timers every call in a test would
 * share that millisecond; stepping it is how the clock behaves in life.
 */
function nextTransaction(): void {
  vi.advanceTimersByTime(1);
}

/**
 * The refusal's `kind`, or the original error.
 *
 * Kinds exist because Convex redacts a plain `Error`'s message on a production
 * deployment, so a client matching on wording degrades to "an error occurred" in
 * front of a customer. A test that asserted on the message would be pinning the
 * half of the refusal that does not survive the boundary.
 */
function refusalKind(error: unknown): string {
  if (!(error instanceof ConvexError)) throw error;
  const data = error.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    typeof data.kind === "string"
  ) {
    return data.kind;
  }
  throw error;
}

async function kindOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return refusalKind(error);
  }
  throw new Error("that call was supposed to be refused and was not");
}

interface DraftSpec {
  /** Labor ids the draft retires. */
  retired?: number[];
  /** Of those, the ones an estimate still points at. Defaults to all of them. */
  retiredWithLines?: number[];
}

interface Fixture {
  t: TestRunner;
  as: Caller;
  parentBookId: Id<"rateBooks">;
  bookId: Id<"rateBooks">;
  diffId: Id<"rateBookDiffs">;
  benchmarkId: Id<"rateBookBenchmarks">;
  /** The revision every stamp in the fixture agrees on. */
  revision: number;
  laborRowIds: Map<number, Id<"laborPool">>;
}

function laborInput(
  poolId: number,
  values: Record<string, string | number | boolean>
): DiffRowInput {
  const description = `ITEM ${poolId}`;
  return {
    poolId,
    parentPoolId: PHASE_CODE,
    description,
    rowRevision: 0,
    values: {
      description,
      sortOrder: poolId,
      craftConstant: 0.6,
      craftUnits: "LF",
      weldConstant: 0,
      weldUnits: "",
      countsTowardTakeoff: false,
      isActive: true,
      phasePoolId: PHASE_CODE,
      ...values,
    },
  };
}

/**
 * A real `DiffSummary` for a draft that re-rated one row and retired some.
 *
 * Built through `diffPair`/`tallyPair`/`observeDraftRow`/`poolIntegrity` rather
 * than assembled by hand, so the counts, the flags and the deactivated ids are
 * the ones the differ actually produces. `poolIntegrity` throws when the scan
 * and the tally disagree, which is what makes a fixture that skipped a row fail
 * loudly instead of producing a plausible summary.
 */
function buildSummary(retired: readonly number[]): DiffSummary {
  const scan = newDraftScanState(new Set([PHASE_CODE]));
  const tally = newPoolTally();
  const rows = [];

  const pairs: { parent: DiffRowInput; draft: DiffRowInput }[] = [
    // A doubling: `largeChangeRatio` is 2, so this is the one judgement call
    // that is a SIZE of change — grouped, and no reason typed.
    {
      parent: laborInput(EDITED_ID, {}),
      draft: laborInput(EDITED_ID, { craftConstant: 1.2 }),
    },
    ...retired.map((poolId) => ({
      parent: laborInput(poolId, {}),
      draft: laborInput(poolId, { isActive: false }),
    })),
  ];
  for (let index = 0; index < FILLER_ROWS; index += 1) {
    const row = laborInput(3000 + index, {});
    pairs.push({ parent: row, draft: row });
  }

  for (const { parent, draft } of pairs) {
    observeDraftRow(scan, "labor", draft, parent);
    const pair = { poolId: draft.poolId, parent, draft };
    const row = diffPair("labor", pair, DEFAULT_DIFF_THRESHOLDS);
    tallyPair(tally, pair, row);
    if (row) rows.push(row);
  }

  return summarizeDiff({
    pools: [poolIntegrity("labor", tally, scan)],
    rows,
    bands: [],
    groups: [],
    takeoffFlagsByPhase: new Map(),
    thresholds: DEFAULT_DIFF_THRESHOLDS,
  });
}

/** The readonly → mutable copies Convex's generated validators ask for. */
function storedSummary(summary: DiffSummary): NonNullable<Doc<"rateBookDiffs">["summary"]> {
  return {
    ...summary,
    pools: summary.pools.map((pool) => ({
      ...pool,
      duplicatePoolIds: [...pool.duplicatePoolIds],
      missingFromDraft: [...pool.missingFromDraft],
      keyCollisions: [...pool.keyCollisions],
      danglingParentRefs: [...pool.danglingParentRefs],
    })),
    shiftBands: summary.shiftBands.map((band) => ({ ...band, poolIds: [...band.poolIds] })),
    systematicGroups: summary.systematicGroups.map((group) => ({
      ...group,
      exampleDescriptions: [...group.exampleDescriptions],
    })),
    changedLaborPoolIds: [...summary.changedLaborPoolIds],
    changedEquipmentPoolIds: [...summary.changedEquipmentPoolIds],
    deactivatedPoolIds: {
      wbs: [...summary.deactivatedPoolIds.wbs],
      phases: [...summary.deactivatedPoolIds.phases],
      labor: [...summary.deactivatedPoolIds.labor],
      equipment: [...summary.deactivatedPoolIds.equipment],
    },
    bulkEditPools: [...summary.bulkEditPools],
    massChangePools: [...summary.massChangePools],
    takeoffFlagBulkPhases: [...summary.takeoffFlagBulkPhases],
  };
}

function storedReport(report: BenchmarkReport): NonNullable<Doc<"rateBookBenchmarks">["report"]> {
  return {
    ...report,
    proposalsExcluded: [...report.proposalsExcluded],
    selfCheckFailures: [...report.selfCheckFailures],
    coverage: { ...report.coverage, neverExercised: [...report.coverage.neverExercised] },
    laborReach: [...report.laborReach].map(([poolId, lines]) => ({ poolId, lines })),
    equipmentReach: [...report.equipmentReach].map(([poolId, lines]) => ({ poolId, lines })),
    equipment: {
      ...report.equipment,
      facts: { ...report.equipment.facts, inversions: [...report.equipment.facts.inversions] },
    },
    movers: {
      byDollarUp: [...report.movers.byDollarUp],
      byDollarDown: [...report.movers.byDollarDown],
      byPercentUp: [...report.movers.byPercentUp],
      byPercentDown: [...report.movers.byPercentDown],
      byItem: [...report.movers.byItem],
    },
    caveats: [...report.caveats],
  };
}

/**
 * A draft that passes every gate once its judgement calls are signed.
 *
 * Everything is stamped at ONE revision — the comparison's two stamps, the
 * review, the benchmark and its acknowledgement — because that agreement is the
 * whole precondition, and a fixture that fudged it would let a test pass while
 * the staleness rules were broken.
 */
async function seedPublishableDraft(spec: DraftSpec = {}): Promise<Fixture> {
  const { t, as } = await ownerHarness();
  const retired = spec.retired ?? [2739];
  const withLines = spec.retiredWithLines ?? retired;
  const revision = 4;
  const summary = buildSummary(retired);

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
      proposalCount: 1,
    });

    const laborTotal = 1 + retired.length + FILLER_ROWS;
    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber: 2,
      name: "2026 Rate Book",
      status: "draft",
      parentBookId,
      isDefault: false,
      createdBy: "fixture",
      createdAt: 0,
      buildState: "ready",
      proposalCount: 0,
      contentRevision: revision,
      // G1 compares this against the comparison's own count, so the two have to
      // be the same statement about one pool or the gate is being tested against
      // a fixture that is already lying.
      rowCounts: { wbs: 1, phases: 1, labor: laborTotal, equipment: 0 },
    });

    await ctx.db.insert("wbsPool", {
      bookId,
      datasetVersion: "v1",
      poolId: WBS_CODE,
      name: "AG PIPING",
      sortOrder: 10,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });
    await ctx.db.insert("phasePool", {
      bookId,
      datasetVersion: "v1",
      poolId: PHASE_CODE,
      wbsPoolId: WBS_CODE,
      name: "CARBON STEEL - A106/A53 (SCH 10/40)",
      sortOrder: 10,
      takeoffUnit: "LF",
      reservedPhaseNumber: false,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });

    const laborRows: { poolId: number; rowId: Id<"laborPool"> }[] = [];
    const laborIds = [
      EDITED_ID,
      ...retired,
      ...Array.from({ length: FILLER_ROWS }, (_, index) => 3000 + index),
    ];
    for (const poolId of laborIds) {
      laborRows.push({
        poolId,
        rowId: await ctx.db.insert("laborPool", {
          bookId,
          datasetVersion: "v1",
          poolId,
          phasePoolId: PHASE_CODE,
          description: `ITEM ${poolId}`,
          sortOrder: poolId,
          craftConstant: poolId === EDITED_ID ? 1.2 : 0.6,
          craftUnits: "LF",
          weldConstant: 0,
          weldUnits: "",
          countsTowardTakeoff: false,
          isCustom: false,
          isActive: !retired.includes(poolId),
          rowRevision: 0,
        }),
      });
    }

    // One estimate on the PARENT book, holding a line per retirement that is
    // supposed to be asked about. `bookId` is set, so G8 has nothing to say.
    const proposalId = await ctx.db.insert("proposals", {
      proposalNumber: "1956",
      description: "Tank 8",
      ownerName: "Test Owner",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
      bookId: parentBookId,
    });
    const wbsId = await ctx.db.insert("wbs", {
      proposalId,
      wbsPoolId: WBS_CODE,
      name: "AG PIPING",
      sortOrder: 1,
    });
    const phaseId = await ctx.db.insert("phases", {
      proposalId,
      wbsId,
      phasePoolId: PHASE_CODE,
      poolName: "CARBON STEEL",
      phaseNumber: 1,
      description: "Phase 1",
      isCompleted: false,
      sortOrder: 1,
    });
    for (const poolId of withLines) {
      await ctx.db.insert("activities", {
        proposalId,
        wbsId,
        phaseId,
        type: "labor",
        description: `ITEM ${poolId}`,
        quantity: 10,
        unit: "LF",
        sortOrder: 1,
        laborPoolId: poolId,
        labor: { craftConstant: 0.6, welderConstant: 0 },
      });
    }

    const diffId = await ctx.db.insert("rateBookDiffs", {
      bookId,
      parentBookId,
      state: "ready",
      startedBy: "fixture",
      startedAt: 1,
      finishedAt: 2,
      startedAtContentRevision: revision,
      finishedAtContentRevision: revision,
      summary: storedSummary(summary),
      reviewedBy: "owner",
      reviewedAtContentRevision: revision,
    });

    const report = finalizeBenchmark({
      acc: emptyBenchmarkAccumulator(),
      changedLaborPoolIds: [...summary.changedLaborPoolIds],
      changedEquipmentPoolIds: [],
      equipmentFacts: equipmentRateFacts(new Map(), new Map()),
      laborReach: new Map(),
      equipmentReach: new Map(),
      reachAvailable: true,
      excludedProposals: [],
      parentBookName: "Original Rate Book",
      basedOnContentRevision: revision,
      triggeredBy: "fixture",
      startedAt: 1,
      finishedAt: 2,
      activityDocumentsRead: 0,
    });
    const benchmarkId = await ctx.db.insert("rateBookBenchmarks", {
      bookId,
      parentBookId,
      state: "ready",
      startedBy: "fixture",
      startedAt: 1,
      finishedAt: 2,
      basedOnContentRevision: revision,
      report: storedReport(report),
      acknowledgedBy: "owner",
      acknowledgedAtContentRevision: revision,
    });

    return { parentBookId, bookId, diffId, benchmarkId, laborRows };
  });

  return {
    t,
    as,
    parentBookId: seeded.parentBookId,
    bookId: seeded.bookId,
    diffId: seeded.diffId,
    benchmarkId: seeded.benchmarkId,
    revision,
    laborRowIds: new Map(seeded.laborRows.map((row) => [row.poolId, row.rowId])),
  };
}

type Readiness = NonNullable<Awaited<ReturnType<typeof readinessOf>>>;

async function readinessOf(fixture: Fixture, typed: { name?: string; notes?: string } = {}) {
  return await fixture.as.query(api.rateBooks.getPublishReadiness, {
    bookId: fixture.bookId,
    typedName: typed.name ?? "2026 Rate Book",
    typedNotes: typed.notes ?? "Re-rated welding and retired one item.",
  });
}

function blockingIds(readiness: Readiness): string[] {
  return readiness.blocking.map((gate) => gate.id);
}

/** A gate's sentence. A passing gate carries none, and asking for one is a bug. */
function gateMessage(readiness: Readiness, id: string): string {
  const gate = must(
    readiness.gates.find((entry) => entry.id === id),
    `gate ${id}`
  );
  return must(gate.message, `a message on ${id}`);
}

/** Put a name against everything the draft is still asking about. */
async function signEverything(fixture: Fixture, readiness: Readiness): Promise<void> {
  for (const item of readiness.outstandingAcknowledgements) {
    await fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
      bookId: fixture.bookId,
      key: item.key,
      reason: item.requiresTypedReason
        ? "Deliberate — reviewed against the 2026 wage sheet."
        : undefined,
    });
  }
}

describe("what the publish screen is told", () => {
  it("blocks on the judgement calls, then publishes once they have a name against them", async () => {
    const fixture = await seedPublishableDraft();

    const before = must(await readinessOf(fixture), "the readiness");
    expect(before.canPublish).toBe(false);
    expect(blockingIds(before)).toEqual(["G6"]);

    // A size of change and a retirement. The size needs no reason; the
    // retirement does, because it is a statement about something that breaks.
    expect(before.outstandingAcknowledgements.map((item) => item.key).sort()).toEqual([
      "flag:large_change",
      "retire:labor:2739",
    ]);
    expect(
      must(
        before.outstandingAcknowledgements.find((item) => item.key === "retire:labor:2739"),
        "the retirement question"
      ).requiresTypedReason
    ).toBe(true);

    await signEverything(fixture, before);

    const after = must(await readinessOf(fixture), "the readiness");
    expect(after.canPublish).toBe(true);
    expect(after.blocking).toEqual([]);

    const result = await fixture.as.mutation(api.rateBooks.publishBook, {
      bookId: fixture.bookId,
      typedName: "2026 Rate Book",
      typedNotes: "Re-rated welding and retired one item.",
      expectedContentRevision: after.contentRevision,
    });
    expect(result.bookNumber).toBe(2);

    const book = must(await fixture.t.run(async (ctx) => ctx.db.get(fixture.bookId)), "the book");
    expect(book.status).toBe("published");
    expect(book.isDefault).toBe(true);

    // ⚠️ WHAT THE BOOK KEEPS IS NOT WHAT WAS TYPED. `composePublishNotes` welds
    // the numbers that were on the screen to the prose, so "what did we know at
    // the time" has an answer that does not depend on anyone remembering.
    const notes = must(book.notes, "the release notes");
    expect(notes).toContain("Re-rated welding and retired one item.");
    expect(notes).toContain("Measured at publish:");
    expect(notes).toContain("2 rows changed");
    expect(notes).toContain("1 large_change");
    expect(notes).toContain("it measured nothing about this draft");

    const parent = must(
      await fixture.t.run(async (ctx) => ctx.db.get(fixture.parentBookId)),
      "the parent"
    );
    expect(parent.isDefault).toBe(false);
  });

  it("asks about a retirement estimates still point at, and not about one nobody uses", async () => {
    const fixture = await seedPublishableDraft({
      retired: [2739, 2740],
      retiredWithLines: [2739],
    });

    const readiness = must(await readinessOf(fixture), "the readiness");
    const retirements = readiness.outstandingAcknowledgements.filter((item) =>
      item.key.startsWith("retire:")
    );

    // 2740 is retired too. Nothing points at it, so retiring it breaks nothing
    // and asking about it would teach a reader that this list is generated
    // rather than meant.
    expect(retirements.map((item) => item.key)).toEqual(["retire:labor:2739"]);
    expect(retirements[0]?.text).toContain('Retiring "ITEM 2739"');
    expect(retirements[0]?.text).toContain("1 live activity line");
    expect(readiness.retirements).toEqual({ listed: 1, beyondCap: 0 });
  });

  it("caps the retirement questions and says how many it is not asking", async () => {
    const retired = Array.from({ length: 60 }, (_, index) => 2739 + index);
    const fixture = await seedPublishableDraft({ retired });

    const readiness = must(await readinessOf(fixture), "the readiness");
    const perRow = readiness.outstandingAcknowledgements.filter(
      (item) => item.key.startsWith("retire:") && item.key !== "retire:beyond_cap"
    );

    // Fifty questions, and the other ten NAMED. Reading all 400 to ask 50 is
    // how the no-`ctx` rule in `publishGates` gets broken from the outside;
    // asking about 50 and saying nothing about the rest is how a gate lies.
    expect(perRow).toHaveLength(50);
    expect(readiness.retirements).toEqual({ listed: 50, beyondCap: 10 });

    const remainder = must(
      readiness.outstandingAcknowledgements.find((item) => item.key === "retire:beyond_cap"),
      "the beyond-cap question"
    );
    expect(remainder.coveredRowCount).toBe(10);
    expect(remainder.text).toContain("10 more are not");
    expect(remainder.requiresTypedReason).toBe(true);
  });

  it("hands over every unfinished import and no finished one", async () => {
    const fixture = await seedPublishableDraft();
    const before = must(await readinessOf(fixture), "the readiness");
    await signEverything(fixture, before);

    const stats = {
      total: 3,
      unchanged: 0,
      edited: 3,
      added: 0,
      conflict: 0,
      invalid: 0,
      idDisagrees: 0,
      blankNumericKept: 0,
    };
    const addImport = async (state: Doc<"rateBookImports">["state"]) =>
      await fixture.t.run(async (ctx) =>
        ctx.db.insert("rateBookImports", {
          bookId: fixture.bookId,
          pool: "labor",
          fileName: `${state}.csv`,
          uploadedBy: "fixture",
          uploadedAt: 0,
          state,
          stats,
          coverage: { inFile: 3, inBook: 41 },
        })
      );

    // Three finished files. G9 used to print `"applied.csv" is still being read
    // (applied)` — a confident sentence about a file that completed, from the
    // gate whose entire job is to be believed.
    for (const state of ["applied", "reverted", "discarded"] as const) await addImport(state);
    expect(must(await readinessOf(fixture), "the readiness").canPublish).toBe(true);

    // ⚠️ ONE STATE AT A TIME, AND ALL FIVE. The dangerous drift is not a finished
    // import being handed over — the gate filters those — but an unfinished one
    // that never is: a state this file does not query reaches no gate, and the
    // book freezes mid-file with the rows already written stranded inside it.
    for (const state of ["staging", "review", "applying", "reverting", "failed"] as const) {
      const importId = await addImport(state);
      const readiness = must(await readinessOf(fixture), "the readiness");
      expect(blockingIds(readiness)).toEqual(["G9"]);
      expect(gateMessage(readiness, "G9")).toContain(`${state}.csv`);
      expect(gateMessage(readiness, "G9")).not.toContain("applied.csv");
      await fixture.t.run(async (ctx) => ctx.db.delete(importId));
    }

    expect(must(await readinessOf(fixture), "the readiness").canPublish).toBe(true);
  });

  it("says a running comparison is running, never that it found nothing", async () => {
    const fixture = await seedPublishableDraft();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.diffId, {
        state: "running",
        summary: undefined,
        finishedAtContentRevision: undefined,
      });
    });

    const readiness = must(await readinessOf(fixture), "the readiness");
    expect(gateMessage(readiness, "G5")).toContain("still running");

    // The three that read a summary all refuse to speak without one, and G6 is
    // the one that used to go quiet — an unqualified pass reading as "somebody
    // looked at these and was content" about a draft nobody has looked at.
    for (const id of ["G1", "G2", "G3", "G6"]) {
      expect(gateMessage(readiness, id)).toContain("Nothing has been compared yet");
    }

    // The placeholder summary a running run is handed is zeroed, and "this draft
    // is identical to its parent" is a sentence that spends a book number.
    expect(gateMessage(readiness, "G5")).not.toContain("identical to");
  });

  it("calls a comparison that says it finished and produced nothing a failed one", async () => {
    const fixture = await seedPublishableDraft();
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.diffId, { summary: undefined });
    });

    // ⚠️ THE ONE STATE THAT MUST NOT REACH THE GATES AS ITSELF. A `ready` run
    // carrying no summary would otherwise be handed the zeroed placeholder, and
    // G5 answers "nothing was compared" and "nothing changed" with two different
    // sentences — one of which tells an admin to set the default instead, about a
    // draft that may have re-rated the whole book.
    const readiness = must(await readinessOf(fixture), "the readiness");
    expect(gateMessage(readiness, "G5")).toContain("The comparison failed");
    expect(gateMessage(readiness, "G5")).not.toContain("identical to");
    expect(gateMessage(readiness, "G1")).toContain("Nothing has been compared yet");
  });

  it("blocks while something else owns the draft, in G0's own words", async () => {
    const fixture = await seedPublishableDraft();
    const before = must(await readinessOf(fixture), "the readiness");
    await signEverything(fixture, before);

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.bookId, {
        lock: { op: "import", startedBy: "someone", startedAt: 0, heartbeatAt: Date.now() },
      });
    });

    const readiness = must(await readinessOf(fixture), "the readiness");
    expect(blockingIds(readiness)).toEqual(["G0"]);
    expect(gateMessage(readiness, "G0")).toBe(
      '"2026 Rate Book" is busy (import). Wait for that to finish.'
    );

    expect(
      await kindOf(
        fixture.as.mutation(api.rateBooks.publishBook, {
          bookId: fixture.bookId,
          typedName: "2026 Rate Book",
          typedNotes: "Anything.",
          expectedContentRevision: readiness.contentRevision,
        })
      )
    ).toBe("publish_blocked");
  });

  it("blocks on an estimate pinned to no book, and stops when it is pinned", async () => {
    const fixture = await seedPublishableDraft();
    const before = must(await readinessOf(fixture), "the readiness");
    await signEverything(fixture, before);

    const orphanId = await fixture.t.run(async (ctx) =>
      ctx.db.insert("proposals", {
        proposalNumber: "9001",
        description: "Arrived from the 6-hourly sync",
        ownerName: "Test Owner",
        rates: { ...RATES_2020 },
        datasetVersion: "v1",
      })
    );

    const blocked = must(await readinessOf(fixture), "the readiness");
    expect(blockingIds(blocked)).toEqual(["G8"]);
    // NAMES NO NUMBER. The read is `.take(1)`, so the honest rendering of it is
    // a subject: printing a count of that told an admin with four thousand
    // unpinned estimates that there was "1 estimates".
    expect(gateMessage(blocked, "G8")).toContain("Estimates are pinned to no rate book");
    expect(gateMessage(blocked, "G8")).not.toContain("1 estimates");

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(orphanId, { bookId: fixture.parentBookId });
    });
    expect(must(await readinessOf(fixture), "the readiness").canPublish).toBe(true);
  });
});

describe("publishing", () => {
  it("refuses the revision the admin was not looking at", async () => {
    const fixture = await seedPublishableDraft();
    const readiness = must(await readinessOf(fixture), "the readiness");
    await signEverything(fixture, readiness);

    expect(
      await kindOf(
        fixture.as.mutation(api.rateBooks.publishBook, {
          bookId: fixture.bookId,
          typedName: "2026 Rate Book",
          typedNotes: "Re-rated welding.",
          expectedContentRevision: readiness.contentRevision - 1,
        })
      )
    ).toBe("publish_superseded");

    const book = must(await fixture.t.run(async (ctx) => ctx.db.get(fixture.bookId)), "the book");
    expect(book.status).toBe("draft");
  });

  it("reports a second click as the success it describes", async () => {
    const fixture = await seedPublishableDraft();
    const readiness = must(await readinessOf(fixture), "the readiness");
    await signEverything(fixture, readiness);

    await fixture.as.mutation(api.rateBooks.publishBook, {
      bookId: fixture.bookId,
      typedName: "2026 Rate Book",
      typedNotes: "Re-rated welding.",
      expectedContentRevision: readiness.contentRevision,
    });
    const first = must(await fixture.t.run(async (ctx) => ctx.db.get(fixture.bookId)), "the book");

    // A refusal that reads as a failure when it was in fact a success is how
    // people learn to distrust the button.
    expect(
      await kindOf(
        fixture.as.mutation(api.rateBooks.publishBook, {
          bookId: fixture.bookId,
          typedName: "2026 Rate Book",
          typedNotes: "Re-rated welding.",
          expectedContentRevision: readiness.contentRevision,
        })
      )
    ).toBe("publish_already_done");

    const second = must(await fixture.t.run(async (ctx) => ctx.db.get(fixture.bookId)), "the book");
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(second.notes).toBe(first.notes);
  });

  it("refuses a draft nobody typed the name of, with the sentence it always used", async () => {
    const fixture = await seedPublishableDraft();
    const readiness = must(await readinessOf(fixture), "the readiness");
    await signEverything(fixture, readiness);

    const mistyped = must(await readinessOf(fixture, { name: "2026 rate book" }), "the readiness");
    expect(blockingIds(mistyped)).toEqual(["G4"]);
    expect(gateMessage(mistyped, "G4")).toBe("The typed name does not match this rate book.");

    const unsaid = must(await readinessOf(fixture, { notes: "  " }), "the readiness");
    expect(gateMessage(unsaid, "G4")).toBe(
      "Say what changed in this rate book before publishing it."
    );
  });
});

describe("signatures", () => {
  it("takes the requirement's own figures, never the caller's", async () => {
    const fixture = await seedPublishableDraft();

    await fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
      bookId: fixture.bookId,
      key: "retire:labor:2739",
      reason: "The item is gone from the 2026 workbook.",
    });

    const rows = await fixture.t.run(async (ctx) =>
      ctx.db
        .query("rateBookAcknowledgements")
        .withIndex("by_book_key", (q) =>
          q.eq("bookId", fixture.bookId).eq("key", "retire:labor:2739")
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    const row = must(rows[0], "the signature");

    // `coveredRowCount` is what makes a signature stop counting when four more
    // rows arrive, so a caller that supplied its own could sign for 4,000 rows
    // of a comparison that found three.
    expect(row.coveredRowCount).toBe(1);
    expect(row.scope).toBe("row");
    expect(row.pool).toBe("labor");
    expect(row.poolId).toBe(2739);
    expect(row.atContentRevision).toBe(fixture.revision);
    // Gathered live from the draft, so it belongs to no comparison.
    expect(row.diffId).toBeUndefined();

    // Signing it again is the same statement, not a second one.
    await fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
      bookId: fixture.bookId,
      key: "retire:labor:2739",
      reason: "Confirmed with the estimating lead.",
    });
    const again = await fixture.t.run(async (ctx) =>
      ctx.db
        .query("rateBookAcknowledgements")
        .withIndex("by_book_key", (q) =>
          q.eq("bookId", fixture.bookId).eq("key", "retire:labor:2739")
        )
        .collect()
    );
    expect(again).toHaveLength(1);
    expect(must(again[0], "the signature").reason).toBe("Confirmed with the estimating lead.");
  });

  it("records which comparison a diff-borne question came from", async () => {
    const fixture = await seedPublishableDraft();
    await fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
      bookId: fixture.bookId,
      key: "flag:large_change",
    });

    const rows = await fixture.t.run(async (ctx) =>
      ctx.db
        .query("rateBookAcknowledgements")
        .withIndex("by_book_key", (q) =>
          q.eq("bookId", fixture.bookId).eq("key", "flag:large_change")
        )
        .collect()
    );
    expect(must(rows[0], "the signature").diffId).toBe(fixture.diffId);
  });

  it("refuses a question nobody is asking, an unexplained one, and the benchmark's", async () => {
    const fixture = await seedPublishableDraft();

    expect(
      await kindOf(
        fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
          bookId: fixture.bookId,
          key: "flag:decimal_shift",
        })
      )
    ).toBe("ack_not_required");

    expect(
      await kindOf(
        fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
          bookId: fixture.bookId,
          key: "retire:labor:2739",
          reason: "   ",
        })
      )
    ).toBe("ack_needs_reason");

    // `publishGates` composes the benchmark's sentence with every other
    // requirement so the wording lives in one place, but satisfies it from the
    // benchmark record. A row written here would satisfy nothing and look signed.
    expect(
      await kindOf(
        fixture.as.mutation(api.rateBooks.acknowledgeJudgementCall, {
          bookId: fixture.bookId,
          key: "benchmark:read",
        })
      )
    ).toBe("ack_benchmark_elsewhere");
  });

  it("is void the moment the catalog moves under it", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await seedPublishableDraft();
      const before = must(await readinessOf(fixture), "the readiness");
      await signEverything(fixture, before);
      expect(must(await readinessOf(fixture), "the readiness").canPublish).toBe(true);

      // One real edit through the one chokepoint. A signature is a statement
      // about specific numbers at a specific moment, not a property of the draft.
      nextTransaction();
      await fixture.as.mutation(api.catalog.updateCatalogRow, {
        bookId: fixture.bookId,
        pool: "labor",
        rowId: must(fixture.laborRowIds.get(3000), "a filler row"),
        field: "craftConstant",
        value: 0.75,
        expectedRevision: 0,
      });

      const after = must(await readinessOf(fixture), "the readiness");
      expect(after.contentRevision).toBe(fixture.revision + 1);
      expect(after.canPublish).toBe(false);
      // G5 because the comparison is now of a catalog that has changed, G6
      // because every signature was about that catalog, and G7 because the
      // benchmark priced it.
      expect(blockingIds(after)).toEqual(["G5", "G6", "G7"]);
      expect(after.outstandingAcknowledgements.map((item) => item.key)).toContain(
        "retire:labor:2739"
      );
      expect(gateMessage(after, "G5")).toContain("it has been written to 1 time since you looked");

      // And the mutation refuses to publish on it, whatever the screen believed.
      expect(
        await kindOf(
          fixture.as.mutation(api.rateBooks.publishBook, {
            bookId: fixture.bookId,
            typedName: "2026 Rate Book",
            typedNotes: "Re-rated welding.",
            expectedContentRevision: after.contentRevision,
          })
        )
      ).toBe("publish_blocked");
    } finally {
      vi.useRealTimers();
    }
  });
});
