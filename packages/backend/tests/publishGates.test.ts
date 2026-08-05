/**
 * The publish gates, stated as facts about what may become permanent.
 *
 * Every number in here comes from the real catalog or the real deployment:
 * 5,897 labor rows, 228 phases, 129 equipment items, 713 estimates priced from
 * book #1, and the one real version bump that moved 1,064 rows in three bands
 * at offsets -4, -455 and +8 without anybody noticing for a version. A gate
 * whose threshold is not anchored to one of those is a gate somebody invented,
 * and this file is where that shows up.
 */
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_ACK_KEY,
  acknowledgementSatisfied,
  benchmarkAcknowledgementText,
  composePublishNotes,
  evaluatePublishGates,
  requiredAcknowledgements,
  type AckRequirement,
  type Acknowledgement,
  type BenchmarkFacts,
  type DiffFacts,
  type DiffFlag,
  type EffectClass,
  type GateId,
  type GateResult,
  type PoolIntegrityFacts,
  type ShiftBandFacts,
  type PublishFacts,
  type PublishReadiness,
} from "../convex/model/publishGates";
import type { PoolKind } from "../convex/model/rateBookCsv";
import {
  DEFAULT_DIFF_THRESHOLDS,
  detectShiftBands,
  diffPair,
  groupSystematic,
  newDraftScanState,
  newPoolTally,
  poolIntegrity,
  summarizeDiff,
  type DiffFlag as DifferFlag,
  type DiffRow,
  type EffectClass as DifferEffectClass,
  type DiffSummary,
  type RenameObservation,
} from "../convex/model/rateBookDiff";
import { CARRIED_BUCKET_PHRASES } from "../convex/model/repriceBenchmark";
import type { BenchmarkReport } from "../convex/model/repriceBenchmark";

// ── Fixtures ────────────────────────────────────────────────────────────────
// The baseline is a draft that SHOULD publish. Every test below changes
// exactly one thing about it, so a failure names the one thing that drifted.

/** Real pool sizes, so a percentage in a message is a percentage of the truth. */
const REAL_ROW_COUNTS: Readonly<Record<PoolKind, number>> = {
  wbs: 18,
  phases: 228,
  labor: 5897,
  equipment: 129,
};

function poolOf(pool: PoolKind, over: Partial<PoolIntegrityFacts> = {}): PoolIntegrityFacts {
  const rows = REAL_ROW_COUNTS[pool];
  return {
    pool,
    draftRowCount: rows,
    parentRowCount: rows,
    duplicatePoolIds: [],
    missingFromDraft: [],
    keyCollisions: [],
    danglingParentRefs: [],
    addedCount: 0,
    deactivatedCount: 0,
    reactivatedCount: 0,
    editedCount: 0,
    ...over,
  };
}

const NO_FLAGS: Readonly<Record<DiffFlag, number>> = {
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
};

function diffFacts(over: Partial<DiffFacts> = {}): DiffFacts {
  return {
    pools: [poolOf("wbs"), poolOf("phases"), poolOf("labor"), poolOf("equipment")],
    changedRowCount: 51,
    unchangedRowCount: 6221,
    flagCounts: NO_FLAGS,
    effectCounts: { priced_at_creation: 51, read_live: 0 },
    shiftBands: [],
    systematicGroups: [],
    changedLaborPoolIds: [101, 102, 103],
    changedEquipmentPoolIds: [],
    bulkEditPools: [],
    massChangePools: [],
    takeoffFlagBulkPhases: [],
    thresholds: { largeChangeRatio: 2, massChangeFraction: 0.05 },
    ...over,
  };
}

function benchmarkFacts(over: Partial<BenchmarkFacts> = {}): BenchmarkFacts {
  return {
    parentBookName: "Original Rate Book",
    proposalsCompared: 713,
    selfCheckFailures: [],
    cost: { delta: -12_345.67 },
    deltaPctOfRepricedLabor: -0.4,
    deltaPctOfGrandTotal: -0.1,
    // All EIGHT buckets `CarriedDollars` carries, and this literal is the guard:
    // when it named seven it stayed assignable, so `unitRedefinedLabor` reached
    // the sum while the prose still named seven categories and $4,000,000 of a
    // stated $5,000,000 was money named nowhere. The labor buckets an earlier
    // sentence forgot are not zero here on purpose: 8% of sampled labor lines
    // point at a description that does not corroborate, and some carry no
    // catalog link at all.
    carriedDollars: {
      overriddenLabor: 1_000_000,
      mismatchedLabor: 500_000,
      retiredUnderDraftLabor: 0,
      unitRedefinedLabor: 4_000_000,
      danglingLabor: 250_000,
      unlinkedLabor: 750_000,
      equipment: 2_000_000,
      materialAndSub: 9_000_000,
    },
    estimatesUnmoved: 700,
    coverage: { changedLaborPoolIds: 380, exercisedLaborPoolIds: 41 },
    equipment: { linesTotal: 419, linesCorroborated: 40 },
    caveats: ["This is a counterfactual. Nothing below happens to a finished estimate."],
    measuredNothing: false,
    ...over,
  };
}

const REVISION = 15;

function publishFacts(over: Partial<PublishFacts> = {}): PublishFacts {
  const book: PublishFacts["book"] = {
    name: "2026 Rate Book",
    bookNumber: 3,
    parentBookName: "Original Rate Book",
    status: "draft",
    buildState: "ready",
    contentRevision: REVISION,
    confirmName: "2026 Rate Book",
    typedName: "2026 Rate Book",
    typedNotes: "Annual labor constant review.",
    recordedRowCounts: REAL_ROW_COUNTS,
    expectedContentRevision: REVISION,
    ...over.book,
  };
  // `in` rather than `??`, so a test can say "there is NO diff" by passing
  // `diff: undefined` — which is exactly the case where a gate must report
  // that it has not checked rather than that it passed.
  return {
    ...over,
    book,
    diff:
      "diff" in over
        ? over.diff
        : {
            state: "ready",
            summary: diffFacts(),
            startedAtContentRevision: REVISION,
            finishedAtContentRevision: REVISION,
            reviewedBy: "user_admin",
            reviewedAtContentRevision: REVISION,
          },
    benchmark:
      "benchmark" in over
        ? over.benchmark
        : {
            state: "ready",
            report: benchmarkFacts(),
            basedOnContentRevision: REVISION,
            acknowledgedBy: "user_admin",
            acknowledgedAtContentRevision: REVISION,
          },
    acknowledgements: over.acknowledgements ?? [],
    unpinnedProposals: over.unpinnedProposals ?? false,
    unpinnedProjects: over.unpinnedProjects ?? false,
    openImports: over.openImports ?? [],
    deactivatedWithLiveLines: over.deactivatedWithLiveLines ?? [],
    deactivatedWithLiveLinesBeyondCap: over.deactivatedWithLiveLinesBeyondCap ?? 0,
  };
}

/**
 * The one real version bump's three bands, as `detectShiftBands` mints them.
 *
 * Built by running the detector rather than hand-writing its output, because
 * the hand-written form (`shift:-4:12-480`) is a key it has never produced: the
 * pool went into the id so equipment id 12 and labor id 12 cannot share one
 * signature, and a fixture missing it agrees with nothing the review screen
 * will store.
 */
function realShiftBands(): readonly ShiftBandFacts[] {
  const moved = (offset: number, startPoolId: number, rowCount: number): RenameObservation[] =>
    Array.from({ length: rowCount }, (_, i) => ({
      pool: "labor" as const,
      draftPoolId: startPoolId + i,
      parentPoolIdOfKey: startPoolId + i - offset,
    }));
  return detectShiftBands(
    [...moved(-4, 12, 469), ...moved(-455, 900, 501), ...moved(8, 5200, 94)],
    DEFAULT_DIFF_THRESHOLDS.shiftBandMin
  ).bands;
}

/**
 * 43 labor rows under phase 412 that all moved `craftConstant` by one ratio, as
 * `diffPair` really reports them.
 *
 * The ratio has to clear `largeChangeRatio` (2) or `groupSystematic` never sees
 * the rows at all — it groups only rows carrying exactly one `large_change`.
 * The fixture this replaced claimed a 1.1x re-rate produced a group, which the
 * real function would never do.
 */
function reRatedRows(ratio: number, count: number): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const poolId = 1500 + i;
    const description = `CARBON STEEL - A106/A53 - ${i}`;
    const row = diffPair(
      "labor",
      {
        poolId,
        parent: {
          poolId,
          parentPoolId: 412,
          description,
          rowRevision: 0,
          values: { description, craftConstant: 1 },
        },
        draft: {
          poolId,
          parentPoolId: 412,
          description,
          rowRevision: 1,
          values: { description, craftConstant: ratio },
        },
      },
      DEFAULT_DIFF_THRESHOLDS
    );
    if (row) rows.push(row);
  }
  return rows;
}

function gate(readiness: PublishReadiness, id: GateId): GateResult {
  const found = readiness.gates.find((g) => g.id === id);
  if (!found) throw new Error(`No gate ${id} was evaluated.`);
  return found;
}

/** Asserting on gate IDS rather than counts: a failure says WHICH gate moved. */
const blockingIds = (readiness: PublishReadiness): GateId[] => readiness.blocking.map((g) => g.id);

const ack = (over: Partial<Acknowledgement> & { key: string }): Acknowledgement => ({
  coveredRowCount: 1,
  atContentRevision: REVISION,
  by: "user_admin",
  at: 1_770_000_000_000,
  ...over,
});

const requirementFor = (requirements: readonly AckRequirement[], key: string): AckRequirement => {
  const found = requirements.find((r) => r.key === key);
  if (!found)
    throw new Error(`No requirement "${key}" among: ${requirements.map((r) => r.key).join(", ")}`);
  return found;
};

// ── The fact contract ───────────────────────────────────────────────────────

/**
 * `publishGates` declares only the fields it reads instead of importing the
 * whole report, so that a new field on either report cannot quietly become a
 * publish precondition nobody reviewed. That is only safe while the two still
 * line up — and `never` here turns a drift into a compile error in this file
 * rather than a surprise at the call site inside `publishBook`.
 */
type DiffContractHolds = DiffSummary extends DiffFacts ? true : never;
type BenchmarkContractHolds = BenchmarkReport extends BenchmarkFacts ? true : never;

/**
 * The flag rosters checked in BOTH directions, which the assignability above
 * cannot do.
 *
 * `DiffSummary extends DiffFacts` passes when `rateBookDiff` ADDS a flag — a
 * `Record` with more keys stays assignable to one with fewer — and
 * `PER_ROW_ACK_FLAGS` is where that bites: a new error-shape flag that nothing
 * here knows about gets no requirement at all, so the shape of error nobody
 * thought to add reaches publish with nobody's name against it.
 */
type FlagsAgree = [DifferFlag] extends [DiffFlag]
  ? [DiffFlag] extends [DifferFlag]
    ? true
    : never
  : never;

/**
 * `EffectClass` checked the same way, for the same reason.
 *
 * A third member added in `rateBookDiff` would reach `effectCounts` and be read
 * by nothing: the acknowledgement sentence and the permanent notes both name
 * `read_live` alone, so a new way for a change to reach a finished estimate
 * would arrive counted and unmentioned.
 */
type EffectsAgree = [DifferEffectClass] extends [EffectClass]
  ? [EffectClass] extends [DifferEffectClass]
    ? true
    : never
  : never;

const CONTRACTS: [DiffContractHolds, BenchmarkContractHolds, FlagsAgree, EffectsAgree] = [
  true,
  true,
  true,
  true,
];

describe("the facts these gates are decided from", () => {
  it("are exactly a subset of what rateBookDiff and repriceBenchmark actually produce", () => {
    expect(CONTRACTS).toEqual([true, true, true, true]);
  });

  it("take a summary the differ itself built, with no adapter standing in between", () => {
    // The assertion above is a compile-time one and would pass at runtime no
    // matter what it said. This is the runtime half: a real `DiffSummary`,
    // built by `summarizeDiff` from the differ's own accumulators, driven
    // straight through the gates. A draft that changed nothing is refused by
    // G5 and by nothing else.
    const summary = summarizeDiff({
      pools: (["wbs", "phases", "labor", "equipment"] as const).map((pool) =>
        poolIntegrity(pool, newPoolTally(), newDraftScanState())
      ),
      rows: [],
      bands: [],
      groups: [],
      takeoffFlagsByPhase: new Map(),
      thresholds: DEFAULT_DIFF_THRESHOLDS,
    });
    const readiness = evaluatePublishGates(
      publishFacts({
        book: { ...publishFacts().book, recordedRowCounts: undefined },
        diff: {
          state: "ready",
          summary,
          startedAtContentRevision: REVISION,
          finishedAtContentRevision: REVISION,
          reviewedBy: "user_admin",
          reviewedAtContentRevision: REVISION,
        },
      })
    );
    expect(blockingIds(readiness)).toEqual(["G5"]);
    expect(gate(readiness, "G5").message).toContain('identical to "Original Rate Book"');
  });
});

// ── The baseline ────────────────────────────────────────────────────────────

describe("a draft that is ready in every way", () => {
  it("publishes, and not one of the eleven gates objects", () => {
    const readiness = evaluatePublishGates(publishFacts());
    expect(blockingIds(readiness)).toEqual([]);
    expect(readiness.canPublish).toBe(true);
    expect(readiness.outstandingAcknowledgements).toEqual([]);
  });

  it("always reports every gate, G0 through G10, whether or not it passed", () => {
    // The screen must not reveal its objections one at a time: an admin who
    // fixes G1 and is then shown G5 stops believing the list is finished.
    const readiness = evaluatePublishGates(publishFacts({ unpinnedProposals: true }));
    expect(readiness.gates.map((g) => g.id)).toEqual([
      "G0",
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
      "G8",
      "G9",
      "G10",
    ]);
    // One objection, ten verdicts still reported beside it — and every gate
    // that passed says so out loud rather than going quiet.
    expect(readiness.gates.filter((g) => g.verdict === "block").map((g) => g.id)).toEqual(["G8"]);
    expect(readiness.gates.filter((g) => g.verdict === "pass")).toHaveLength(10);
  });
});

// ── G0 ──────────────────────────────────────────────────────────────────────

describe("G0 — built and unlocked", () => {
  it("a draft still copying its 6,272 rows is not a book", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, buildState: "building" } })
    );
    expect(blockingIds(readiness)).toEqual(["G0"]);
    expect(gate(readiness, "G0").message).toBe(
      "This draft is still being built. Wait for it to finish."
    );
  });

  it("a draft whose clone FAILED is not told to wait for something that will never finish", () => {
    // cloneBatch commits the rows inserted before it threw, so this draft is a
    // partial copy that no amount of waiting completes.
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, buildState: "failed" } })
    );
    expect(gate(readiness, "G0").message).not.toContain("Wait for it to finish");
    expect(gate(readiness, "G0").message).toContain("not a complete copy of its parent");
  });

  it("a draft an import is holding is named as busy, with the operation that holds it", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, lockOp: "import" } })
    );
    expect(blockingIds(readiness)).toEqual(["G0"]);
    expect(gate(readiness, "G0").message).toBe(
      '"2026 Rate Book" is busy (import). Wait for that to finish.'
    );
  });
});

// ── G1 ──────────────────────────────────────────────────────────────────────

describe("G1 — the draft is a faithful copy of its parent", () => {
  it("one poolId appearing twice blocks: loadTakeoffCatalog resolves a catalog phase with .unique()", () => {
    // A retried build replays the range the failed batch already inserted, and
    // Convex has no unique constraint to refuse the second copy. The phase
    // list then stops loading for every estimate on the book.
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases", { duplicatePoolIds: [79996] }),
        poolOf("labor"),
        poolOf("equipment"),
      ],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(blockingIds(readiness)).toEqual(["G1"]);
    expect(gate(readiness, "G1").message).toContain("79996");
    expect(gate(readiness, "G1").detail).toEqual({ pool: "phases", duplicates: 1 });
  });

  it("ONE row missing from the draft blocks — nothing in this system deletes a cloned row", () => {
    // revertImportBatch deletes only rows an import ADDED; discardBatch
    // removes the whole book. So a percentage is the wrong shape of question:
    // the threshold is one.
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { missingFromDraft: [4211] }),
        poolOf("equipment"),
      ],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(blockingIds(readiness)).toEqual(["G1"]);
    expect(gate(readiness, "G1").detail).toEqual({ pool: "labor", missing: 1 });
  });

  it("a counted 5,896 against a recorded 5,897 blocks, because one of the two is lying", () => {
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { draftRowCount: 5896 }),
        poolOf("equipment"),
      ],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(gate(readiness, "G1").detail).toEqual({ pool: "labor", recorded: 5897, counted: 5896 });
  });

  it("says it has not checked, rather than passing, when no comparison has run", () => {
    const readiness = evaluatePublishGates(publishFacts({ diff: undefined }));
    expect(gate(readiness, "G1").verdict).toBe("block");
    expect(gate(readiness, "G2").verdict).toBe("block");
    expect(gate(readiness, "G3").verdict).toBe("block");
    expect(gate(readiness, "G1").message).toContain("has not been checked");
  });
});

// ── G2 ──────────────────────────────────────────────────────────────────────

describe("G2 — every reference inside the draft resolves", () => {
  it("a labor row under a phase that does not exist blocks: it counts toward the totals and appears nowhere", () => {
    // shapeRow parses phase_code but never checks the phase exists, matchRow
    // cannot match against a nonexistent parent so the row becomes an
    // addition, and insertPoolRow writes it at a dangling phasePoolId.
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { danglingParentRefs: [{ poolId: 6001, parentPoolId: 999 }] }),
        poolOf("equipment"),
      ],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(blockingIds(readiness)).toEqual(["G2"]);
    expect(gate(readiness, "G2").message).toContain("id 6001 points at 999");
  });
});

// ── G3 ──────────────────────────────────────────────────────────────────────

describe("G3 — natural keys are unique", () => {
  it("two items sharing a name block, because from then on the importer cannot tell them apart", () => {
    // normalizeKey produces ZERO collisions across all 5,897 v1 and 5,968 v2
    // labor rows. That is a property of the data, and a bulk edit can break it.
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { keyCollisions: ["412|FSW - <=.75"] }),
        poolOf("equipment"),
      ],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(blockingIds(readiness)).toEqual(["G3"]);
    expect(gate(readiness, "G3").message).toContain("412|FSW - <=.75");
  });
});

// ── G4 ──────────────────────────────────────────────────────────────────────

describe("G4 — typed confirmation and release notes", () => {
  it("a mistyped confirmation is refused with the sentence publishBook already used", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, typedName: "2026 Rate book" } })
    );
    expect(blockingIds(readiness)).toEqual(["G4"]);
    expect(gate(readiness, "G4").message).toBe("The typed name does not match this rate book.");
  });

  it("a stray space around the typed name is not a mistyped name", () => {
    // `publishBook` compares `args.confirmName.trim()`, and this gate stands in
    // front of that mutation: a rule that refuses what the mutation would have
    // accepted is a second, quieter rule.
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, typedName: "  2026 Rate Book  " } })
    );
    expect(gate(readiness, "G4").verdict).toBe("pass");
  });

  it("whitespace is not a release note", () => {
    // `typedNotes`, not `notes`: what the book keeps is `composePublishNotes`'s
    // output, and while both were called `notes` this gate read a field the
    // fact type no longer had and passed on an empty release note.
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, typedNotes: "   \n  " } })
    );
    expect(gate(readiness, "G4").message).toBe(
      "Say what changed in this rate book before publishing it."
    );
  });
});

// ── G5 ──────────────────────────────────────────────────────────────────────

describe("G5 — a current, untorn, reviewed comparison", () => {
  it("a comparison that started at revision 12 and finished at 15 describes a catalog that never existed", () => {
    // The diff reads wbs and phases before an import lands and labor after. A
    // single end-of-run stamp cannot see that; two stamps can.
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: {
          ...publishFacts().diff!,
          startedAtContentRevision: 12,
          finishedAtContentRevision: 15,
        },
      })
    );
    expect(blockingIds(readiness)).toEqual(["G5"]);
    expect(gate(readiness, "G5").detail).toEqual({ startedAt: 12, finishedAt: 15 });
    expect(gate(readiness, "G5").message).toContain("never existed at any one moment");
  });

  it("a comparison of revision 12 does not describe revision 15, and the message counts the writes since", () => {
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: {
          ...publishFacts().diff!,
          startedAtContentRevision: 12,
          finishedAtContentRevision: 12,
          reviewedAtContentRevision: 12,
        },
      })
    );
    expect(gate(readiness, "G5").detail).toEqual({ reviewedRevision: 12, currentRevision: 15 });
    expect(gate(readiness, "G5").message).toContain("written to 3 times since you looked");
  });

  it("a comparison nobody has marked as read is not a review", () => {
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: {
          ...publishFacts().diff!,
          reviewedBy: undefined,
          reviewedAtContentRevision: undefined,
        },
      })
    );
    expect(blockingIds(readiness)).toEqual(["G5"]);
    expect(gate(readiness, "G5").message).toContain("marked this comparison as read");
  });

  it("a draft identical to its parent is refused by name and told to set the default instead", () => {
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: { ...publishFacts().diff!, summary: diffFacts({ changedRowCount: 0 }) },
      })
    );
    expect(gate(readiness, "G5").message).toContain('identical to "Original Rate Book"');
    expect(gate(readiness, "G5").message).toContain("set the default instead");
  });

  it("a running comparison is not a finished one", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, state: "running" } })
    );
    expect(gate(readiness, "G5").message).toContain("still running");
  });

  it("a failed comparison is not a comparison", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, state: "failed" } })
    );
    expect(gate(readiness, "G5").message).toContain("publishing blind");
  });
});

// ── G6 ──────────────────────────────────────────────────────────────────────

describe("G6 — the judgement calls have a name against them", () => {
  it("the three real bands at -4, -455 and +8 are three signatures, not 1,064", () => {
    // This is the whole argument for grouping: 1,064 checkboxes is how you
    // teach somebody to click without reading.
    //
    // The bands come OUT of `detectShiftBands` — see {@link realShiftBands} —
    // rather than being hand-written under a comment claiming they match it.
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, shifted_payload: 1064 },
      shiftBands: realShiftBands(),
    });
    const requirements = requiredAcknowledgements(summary, undefined, []);
    const banded = requirements.filter((r) => r.scope === "band");
    expect(banded.map((r) => r.key)).toEqual([
      "band:shift:labor:-4:12-480",
      "band:shift:labor:-455:900-1400",
      "band:shift:labor:8:5200-5293",
    ]);
    expect(banded.reduce((sum, r) => sum + r.coveredRowCount, 0)).toBe(1064);
    expect(banded.every((r) => r.requiresTypedReason)).toBe(true);
    // And the pool is in the sentence, not only in the key: "ids 12 to 480"
    // names a range that exists in labor and in equipment and identifies
    // neither.
    expect(banded[0]?.text).toContain("between labor ids 12 and 480");
  });

  it("an honest 2.5x re-rate of 43 lines under one phase family is ONE signature", () => {
    // The group comes out of `groupSystematic`, so its key is the one an
    // admin's signature is really stored against:
    // `systematic:labor|412|craftConstant|2.5`. The literal that stood here,
    // `labor:412:craftConstant:1.1`, was wrong twice — the separators are `|`
    // after a `systematic:` prefix, and 1.1x is under the 2x convention, so no
    // group would ever have formed around it.
    const { groups } = groupSystematic(
      reRatedRows(2.5, 43),
      DEFAULT_DIFF_THRESHOLDS.systematicGroupMin
    );
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, large_change: 43 },
      systematicGroups: groups,
    });
    const requirements = requiredAcknowledgements(summary, undefined, []);
    const group = requirementFor(requirements, "group:systematic:labor|412|craftConstant|2.5");
    expect(group.scope).toBe("group");
    expect(group.coveredRowCount).toBe(43);
    // A size of change, not a shape of error: no reason has to be typed.
    expect(group.requiresTypedReason).toBe(false);
    // And nothing is left over asking about the same 43 rows a second time.
    expect(requirements.filter((r) => r.key === "flag:large_change")).toEqual([]);
  });

  it("the 8 large moves that belong to no group are still asked about, once, for the 8", () => {
    // Grouping is a way of asking fewer questions, not of asking about fewer
    // rows: 51 rows moved by 2x or more and 43 of them moved together, so the
    // remaining 8 are their own decision.
    const { groups } = groupSystematic(
      reRatedRows(2.5, 43),
      DEFAULT_DIFF_THRESHOLDS.systematicGroupMin
    );
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, large_change: 51 },
      systematicGroups: groups,
    });
    const leftover = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "flag:large_change"
    );
    expect(leftover.scope).toBe("row");
    expect(leftover.coveredRowCount).toBe(8);
    expect(leftover.requiresTypedReason).toBe(false);
    expect(leftover.text).toContain("2x is a CONVENTION, not a measurement");
  });

  it("a row that changed parent is one pool decision with a reason typed", () => {
    // Reparenting is the one edit that makes an id and its meaning disagree
    // deliberately, which is the shape 1,064 rows arrived in by accident.
    const summary = diffFacts({ flagCounts: { ...NO_FLAGS, reparented: 1 } });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "flag:reparented"
    );
    expect(requirement.scope).toBe("pool");
    expect(requirement.requiresTypedReason).toBe(true);
    expect(requirement.text).toContain("1 row moved to a different parent");
  });

  it("400 retired labor rows are asked about as a retirement, not as an addition of nothing", () => {
    // `massChangePools` membership is max(added, deactivated) / parent, so it
    // does not say WHICH of the two happened. Asking for a typed reason under
    // "0 rows were added to labor — 0.0% of the pool" teaches an admin that
    // these sentences are generated rather than meant.
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { addedCount: 0, deactivatedCount: 400 }),
        poolOf("equipment"),
      ],
      massChangePools: ["labor"],
    });
    const requirements = requiredAcknowledgements(summary, undefined, []);
    expect(requirements.map((r) => r.key)).not.toContain("pool:labor:mass_addition");
    const retired = requirementFor(requirements, "pool:labor:mass_deactivation");
    expect(retired.coveredRowCount).toBe(400);
    expect(retired.text).toContain("400 labor rows were retired — 6.8% of the pool");
  });

  it("an id column deleted in Excel turns every row into an addition, and that is asked about", () => {
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { draftRowCount: 11_794, addedCount: 5897 }),
        poolOf("equipment"),
      ],
      massChangePools: ["labor"],
    });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "pool:labor:mass_addition"
    );
    expect(requirement.coveredRowCount).toBe(5897);
    expect(requirement.text).toContain("100.0% of the pool");
  });

  it("a signature with nobody's name on it is not a signature", () => {
    const requirement: AckRequirement = {
      key: "flag:large_change",
      scope: "row",
      coveredRowCount: 1,
      requiresTypedReason: false,
      text: "",
    };
    expect(
      acknowledgementSatisfied(
        requirement,
        [ack({ key: "flag:large_change", by: "   " })],
        REVISION
      )
    ).toBe(false);
    expect(
      acknowledgementSatisfied(requirement, [ack({ key: "flag:large_change" })], REVISION)
    ).toBe(true);
  });

  it("a decimal shift is confirmed row by row with a reason typed, and never grouped", () => {
    const summary = diffFacts({ flagCounts: { ...NO_FLAGS, decimal_shift: 2 } });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "flag:decimal_shift"
    );
    expect(requirement.scope).toBe("row");
    expect(requirement.requiresTypedReason).toBe(true);
    expect(requirement.text).toContain("factor of exactly ten");
  });

  it("a 40x move that arrives as implausible_magnitude and NOT large_change is still asked about", () => {
    // The differ resolves flags worst-first, so the two flags do not both
    // appear. Asking only about large_change would let the larger move
    // through with nobody deciding anything.
    const summary = diffFacts({ flagCounts: { ...NO_FLAGS, implausible_magnitude: 1 } });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "flag:implausible_magnitude"
    );
    expect(requirement.requiresTypedReason).toBe(true);
  });

  it("hours disappearing is confirmed per row; hours appearing is one signature for all of them", () => {
    // The asymmetry is the point: a constant driven to 0 destroys work
    // invisibly, while 0 -> a number creates hours the benchmark will show.
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, zeroed_constant: 3, constant_activated: 9 },
    });
    const requirements = requiredAcknowledgements(summary, undefined, []);
    expect(requirementFor(requirements, "flag:zeroed_constant").scope).toBe("row");
    expect(requirementFor(requirements, "flag:constant_activated").scope).toBe("run");
    expect(requirementFor(requirements, "flag:constant_activated").requiresTypedReason).toBe(false);
  });

  it("a units flip is asked about even though the number beside it never moved", () => {
    // 0.6 LF and 0.6 EA differ by ten times on a ten-foot spool.
    const summary = diffFacts({ flagCounts: { ...NO_FLAGS, unit_changed: 4 } });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "flag:unit_changed"
    );
    expect(requirement.text).toContain("0.6 LF and 0.6 EA");
  });

  it("a signature over 47 rows does not cover the 51 there are now", () => {
    const requirement: AckRequirement = {
      key: "flag:large_change",
      scope: "row",
      flag: "large_change",
      coveredRowCount: 51,
      requiresTypedReason: false,
      text: "51 values moved by 2x or more.",
    };
    expect(
      acknowledgementSatisfied(
        requirement,
        [ack({ key: "flag:large_change", coveredRowCount: 47 })],
        REVISION
      )
    ).toBe(false);
    expect(
      acknowledgementSatisfied(
        requirement,
        [ack({ key: "flag:large_change", coveredRowCount: 51 })],
        REVISION
      )
    ).toBe(true);
  });

  it("a signature made at revision 12 does not survive the import that made revision 13", () => {
    const requirement: AckRequirement = {
      key: "flag:large_change",
      scope: "row",
      coveredRowCount: 1,
      requiresTypedReason: false,
      text: "",
    };
    const signed = [ack({ key: "flag:large_change", atContentRevision: 12 })];
    expect(acknowledgementSatisfied(requirement, signed, 12)).toBe(true);
    expect(acknowledgementSatisfied(requirement, signed, 13)).toBe(false);
  });

  it("a zeroed constant acknowledged without saying why does not count", () => {
    const requirement: AckRequirement = {
      key: "flag:zeroed_constant",
      scope: "row",
      coveredRowCount: 1,
      requiresTypedReason: true,
      text: "",
    };
    expect(
      acknowledgementSatisfied(requirement, [ack({ key: "flag:zeroed_constant" })], REVISION)
    ).toBe(false);
    expect(
      acknowledgementSatisfied(
        requirement,
        [ack({ key: "flag:zeroed_constant", reason: "Owner supplies this material now." })],
        REVISION
      )
    ).toBe(true);
  });

  it("retiring an item that 84 live activity lines point at is confirmed by name, one item at a time", () => {
    const requirements = requiredAcknowledgements(diffFacts(), undefined, [
      { pool: "equipment", poolId: 42, description: "MANLIFT - 60'", lines: 84 },
      { pool: "equipment", poolId: 43, description: "DRIVE IMPACT - 1", lines: 3 },
    ]);
    const first = requirementFor(requirements, "retire:equipment:42");
    expect(first.poolId).toBe(42);
    expect(first.requiresTypedReason).toBe(true);
    expect(first.text).toContain(`MANLIFT - 60'`);
    expect(first.text).toContain("84 live activity lines");
    expect(requirementFor(requirements, "retire:equipment:43").text).toContain(
      "3 live activity lines"
    );
  });

  it("equipment 42 and labor 42 are two items, and one signature cannot be made to cover both", () => {
    // Equipment ids start at 0 and stop around 129, so every equipment id is
    // also a labor id. A key made of the number alone retires two unrelated
    // items on one confirmation.
    const requirements = requiredAcknowledgements(diffFacts(), undefined, [
      { pool: "equipment", poolId: 42, description: "MANLIFT - 60'", lines: 84 },
      { pool: "labor", poolId: 42, description: "FSW - <=.75", lines: 3 },
    ]);
    expect(requirements.filter((r) => r.poolId === 42).map((r) => r.key)).toEqual([
      "retire:equipment:42",
      "retire:labor:42",
    ]);
    const signed = [ack({ key: "retire:equipment:42", reason: "Sold the lift." })];
    expect(
      acknowledgementSatisfied(
        requirementFor(requirements, "retire:equipment:42"),
        signed,
        REVISION
      )
    ).toBe(true);
    expect(
      acknowledgementSatisfied(requirementFor(requirements, "retire:labor:42"), signed, REVISION)
    ).toBe(false);
  });

  it("quotes the anecdote as 1,199 of 5,897 — the same quantity the threshold divides", () => {
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { editedCount: 1064 }),
        poolOf("equipment"),
      ],
      bulkEditPools: ["labor"],
    });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "pool:labor:bulk_edit"
    );
    expect(requirement.scope).toBe("pool");
    expect(requirement.coveredRowCount).toBe(1064);
    expect(requirement.text).toContain("1,064 of 5,897 labor rows changed — 18.0% of the pool");
    // `bulkEditFraction` is measured as editedCount / parentRowCount: 1,199 of
    // 5,897 on the one real change event, 20.3%. The sentence used to quote the
    // shift-band figure instead (1,064 of 5,968, 17.8%), which put a third
    // percentage for a single event on one screen and taught its reader that
    // the numbers on it are approximate.
    expect(requirement.text).toContain("edited 1,199 of 5,897 labor rows — 20.3%");
    expect(requirement.text).not.toContain("17.8%");
    expect(requirement.text).not.toContain("5,968");
  });

  it("lists 50 retirements by name and says how many more there are, rather than dropping them", () => {
    // The cap is a read budget, not taste: past 50 the publish mutation is
    // doing hundreds of document reads to compose a list nobody works through
    // one at a time, and that is how the no-`ctx` rule gets broken from
    // outside. The remainder is named out loud.
    const retired = Array.from({ length: 60 }, (_, i) => ({
      pool: "labor" as const,
      poolId: 100 + i,
      description: `FSW - <=.75 (${i})`,
      lines: 2,
    }));
    const requirements = requiredAcknowledgements(diffFacts(), undefined, retired, 340);
    const keys = requirements.map((r) => r.key);
    // The 50th row handed over is asked about by name; the 51st is not.
    expect(keys).toContain("retire:labor:149");
    expect(keys).not.toContain("retire:labor:150");
    const remainder = requirementFor(requirements, "retire:beyond_cap");
    // 340 the caller counted and never handed over, plus the 10 it handed over
    // past the cap.
    expect(remainder.coveredRowCount).toBe(350);
    expect(remainder.text).toContain(
      "50 retired rows with live activity lines are listed one at a time above, and 350 more are not"
    );
    expect(remainder.requiresTypedReason).toBe(true);
  });

  it("carries the caller's beyond-cap count through evaluatePublishGates, not just the composer", () => {
    // The count sits on `PublishFacts` and had no route to the requirement:
    // the gate asked about the rows it was handed and said nothing at all
    // about the other 350.
    const readiness = evaluatePublishGates(
      publishFacts({
        deactivatedWithLiveLines: [
          { pool: "labor", poolId: 100, description: "FSW - <=.75", lines: 2 },
        ],
        deactivatedWithLiveLinesBeyondCap: 350,
      })
    );
    const remainder = requirementFor(readiness.outstandingAcknowledgements, "retire:beyond_cap");
    expect(remainder.coveredRowCount).toBe(350);
    expect(remainder.text).toContain("and 350 more are not");
  });

  it("400 labor rows coming BACK is a question too, because massChangePools counts them", () => {
    // `massChangePools` is max(added, deactivated, reactivated) / parent, so a
    // pool can clear the threshold on reactivations alone — and until this
    // branch existed such a pool produced no requirement whatsoever. A
    // returning row reappears in `by_book_active` and so in
    // `loadTakeoffCatalog` on every estimate; it is the same size of event as
    // the same number of rows leaving, arriving in the direction nobody
    // watches.
    const summary = diffFacts({
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { reactivatedCount: 400 }),
        poolOf("equipment"),
      ],
      massChangePools: ["labor"],
    });
    const returned = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "pool:labor:mass_reactivation"
    );
    expect(returned.coveredRowCount).toBe(400);
    expect(returned.text).toContain("400 labor rows were brought back — 6.8% of the pool");
    expect(returned.requiresTypedReason).toBe(true);
  });

  it("reports that it has not looked, rather than passing, when nothing has been compared", () => {
    // Every judgement call this gate counts is derived from the comparison, so
    // with no comparison the outstanding list is empty — and G6 reported
    // "The judgement calls have a name against them: pass" about a draft
    // nobody has looked at. G1, G2 and G3 all say NOT_COMPARED in this state;
    // G6 was the one that went quiet.
    const readiness = evaluatePublishGates(publishFacts({ diff: undefined }));
    expect(gate(readiness, "G6").verdict).toBe("block");
    expect(gate(readiness, "G6").message).toContain("Nothing has been compared yet");
    expect(blockingIds(readiness)).toEqual(["G1", "G2", "G3", "G5", "G6"]);
  });

  it("names five phases and counts the rest, rather than printing all eight", () => {
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, takeoff_flags_bulk: 61 },
      takeoffFlagBulkPhases: [1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208],
    });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "pool:labor:takeoff_flags_bulk"
    );
    expect(requirement.text).toContain("(phases 1201, 1202, 1203, 1204, 1205 and 3 more)");
  });

  it("a takeoff-flag sweep across more than three lines per phase is one pool decision, and says it is read live", () => {
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, takeoff_flags_bulk: 61 },
      takeoffFlagBulkPhases: [1201, 1202, 1203],
    });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "pool:labor:takeoff_flags_bulk"
    );
    expect(requirement.coveredRowCount).toBe(61);
    expect(requirement.text).toContain("in 3 phases, more than three in each");
    expect(requirement.text).toContain("(phases 1201, 1202, 1203)");
    expect(requirement.text).toContain("61 of them by an edit to an existing row");
    expect(requirement.text).toContain("read LIVE");
  });

  it("a phase whose new takeoff flags all arrived on ADDED rows is still named, and claims no rows", () => {
    // The two numbers come from different passes. `observeDraftRow` counts
    // every newly flagged draft row, additions included; `flagCounts` counts
    // rows carrying a `countsTowardTakeoff` FIELD change, and an added row has
    // no field changes at all. A file that adds ten flagged lines under one
    // phase therefore lands here with a row count of zero, and "0 labor rows
    // were newly flagged, across 1 phases" is a sentence that discredits the
    // gate printing it.
    const summary = diffFacts({ takeoffFlagBulkPhases: [1201] });
    const requirement = requirementFor(
      requiredAcknowledgements(summary, undefined, []),
      "pool:labor:takeoff_flags_bulk"
    );
    expect(requirement.text).toContain("in 1 phase, more than three in each (phase 1201)");
    expect(requirement.text).not.toContain("0 labor rows");
    expect(requirement.text).not.toContain("1 phases");
    expect(requirement.text).toContain("read LIVE");
  });

  it("an unsigned judgement call blocks publish and quotes the first one on the screen", () => {
    const summary = diffFacts({ flagCounts: { ...NO_FLAGS, zeroed_constant: 3 } });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(blockingIds(readiness)).toEqual(["G6"]);
    expect(readiness.outstandingAcknowledgements.map((r) => r.key)).toEqual([
      "flag:zeroed_constant",
    ]);
    expect(gate(readiness, "G6").message).toContain("price that work at nothing");
  });

  it("counts the decisions and never the rows, because the decisions cover the same rows twice", () => {
    // A pool-wide bulk edit covers all 1,064 edited rows, and 3 of those rows
    // are the zeroed constants. Adding the two gives 1,067 rows of a pool that
    // moved 1,064 — a number nothing on any other screen agrees with.
    const summary = diffFacts({
      flagCounts: { ...NO_FLAGS, zeroed_constant: 3 },
      pools: [
        poolOf("wbs"),
        poolOf("phases"),
        poolOf("labor", { editedCount: 1064 }),
        poolOf("equipment"),
      ],
      bulkEditPools: ["labor"],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ diff: { ...publishFacts().diff!, summary } })
    );
    expect(gate(readiness, "G6").detail).toEqual({ outstanding: 2 });
    expect(gate(readiness, "G6").message).not.toContain("1,067");
  });

  it("the same call, signed at this revision with a reason, lets the book through", () => {
    const summary = diffFacts({ flagCounts: { ...NO_FLAGS, zeroed_constant: 3 } });
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: { ...publishFacts().diff!, summary },
        acknowledgements: [
          ack({
            key: "flag:zeroed_constant",
            coveredRowCount: 3,
            reason: "Scope moved to the owner.",
          }),
        ],
      })
    );
    expect(blockingIds(readiness)).toEqual([]);
  });
});

// ── G7 ──────────────────────────────────────────────────────────────────────

describe("G7 — a benchmark that checked itself", () => {
  it("a benchmark whose baseline cannot reproduce an estimate's own cached total blocks, and names the estimate", () => {
    // recomputeProposalTotal is the only writer of that number and derives it
    // from the identical rollUpProposal call. A mismatch means the harness is
    // not reading these estimates the way the app does, and every figure it
    // printed is about something else while looking authoritative.
    const report = benchmarkFacts({
      selfCheckFailures: [
        { proposalNumber: "P-2231", cached: 1_204_552.11, computed: 1_204_002.11 },
      ],
    });
    const readiness = evaluatePublishGates(
      publishFacts({ benchmark: { ...publishFacts().benchmark!, report } })
    );
    expect(blockingIds(readiness)).toEqual(["G7"]);
    expect(gate(readiness, "G7").detail).toEqual({ failures: 1, proposal: "P-2231" });
    expect(gate(readiness, "G7").message).toContain("$1,204,552.11");
    expect(gate(readiness, "G7").message).toContain("$1,204,002.11");
  });

  it("a benchmark of revision 12 is not a benchmark of revision 15", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ benchmark: { ...publishFacts().benchmark!, basedOnContentRevision: 12 } })
    );
    expect(gate(readiness, "G7").detail).toEqual({ benchmarkRevision: 12, currentRevision: 15 });
  });

  it("NO gate blocks on the size of the movement: a $1.2M swing publishes once it has been read", () => {
    // There is no correct answer to "how much may a rate book move a bid".
    // Encoding one would be the software inventing an authority it does not
    // have; the number goes into the book's notes instead.
    const report = benchmarkFacts({
      cost: { delta: 1_200_000 },
      deltaPctOfRepricedLabor: 6.2,
      deltaPctOfGrandTotal: 2.5,
    });
    const readiness = evaluatePublishGates(
      publishFacts({ benchmark: { ...publishFacts().benchmark!, report } })
    );
    expect(blockingIds(readiness)).toEqual([]);
  });

  it("an equipment-only run does not get to say $0.00 — it says it told you nothing", () => {
    // 199 of 245 sampled equipment lines point at an entirely different item,
    // and which of the four rate tiers a line was priced from is stored
    // nowhere. A confident, correct, meaningless zero is the worst output.
    const text = benchmarkAcknowledgementText(
      benchmarkFacts({ measuredNothing: true }),
      diffFacts({ changedLaborPoolIds: [], changedEquipmentPoolIds: [5, 6, 7] })
    );
    expect(text).toContain("changes 3 equipment rates and 0 labor constants");
    expect(text).toContain("IT HAS TOLD YOU NOTHING ABOUT THIS DRAFT");
    expect(text).toContain("This is not a zero; it is no answer");
    expect(text).not.toContain("$");
  });

  it("with no estimate pinned to the parent book, the run is labelled a catalog delta profile", () => {
    const text = benchmarkAcknowledgementText(
      benchmarkFacts({ proposalsCompared: 0 }),
      diffFacts()
    );
    expect(text).toContain('No estimate is pinned to "Original Rate Book"');
    expect(text).toContain("explicitly not a money figure");
  });

  it("a draft whose changes are read live still has to be read, and the sentence says no dollar covers them", () => {
    // takeoffUnit and countsTowardTakeoff are read live on every phase-list
    // render and inside the export, so these are the ONLY changes that reach
    // an estimate that is already finished.
    //
    // `effectCounts` folds each row's changes through a Set before counting, so
    // 7 is 7 ROWS however many live-read fields each of them moved. The
    // sentence has to say rows or it names a number smaller than itself.
    const text = benchmarkAcknowledgementText(
      benchmarkFacts(),
      diffFacts({ effectCounts: { priced_at_creation: 0, read_live: 7 } })
    );
    expect(text).toContain("7 rows in this draft changed something read LIVE");
    expect(text).toContain("no dollar figure here covers those");
  });

  it("the sentence a person agrees to carries both denominators and EVERY excluded dollar", () => {
    const text = benchmarkAcknowledgementText(benchmarkFacts(), diffFacts());
    expect(text).toContain("-$12,345.67");
    expect(text).toContain("-0.4% of the labor this run could reprice");
    expect(text).toContain("-0.1% of the grand total");
    // All EIGHT carried buckets: $1,000,000 overridden + $500,000
    // uncorroborated + $0 retired-under-draft + $4,000,000 restated in another
    // unit + $250,000 dangling + $750,000 unlinked + $2,000,000 equipment +
    // $9,000,000 material and sub. Naming a subset and calling the sum "the
    // money this does not cover" understates it by whatever nobody typed out —
    // which is the same artifact, one indirection down, as a benchmark that
    // quietly excludes 81% of equipment while presenting a confident delta.
    expect(text).toContain("$17,500,000.00");
    expect(text).toContain("labor pointing at ids the parent book does not contain");
    expect(text).toContain("labor with no catalog link at all");
    expect(text).toContain("labor on items this draft restates in another unit");
    expect(text).toContain("41 of 380 changed labor items are used by any estimate");
  });

  it("states a sum that is exactly the eight buckets, and names every one of them", () => {
    // The sentence walks `CarriedDollars` for the sum, so the list has to walk
    // it too. When the list was hand-written it went stale in silence:
    // `unitRedefinedLabor` reached the sum and never reached the prose, so a
    // reader adding up the named categories arrived $4,000,000 short of a
    // stated $17,500,000 and both files compiled.
    const report = benchmarkFacts();
    expect(Object.values(report.carriedDollars).reduce((sum, n) => sum + n, 0)).toBe(17_500_000);
    const text = benchmarkAcknowledgementText(report, diffFacts());
    expect(text).toContain("$17,500,000.00");
    for (const phrase of Object.values(CARRIED_BUCKET_PHRASES)) {
      expect(text).toContain(`of ${phrase}`);
    }
  });

  it("an unread benchmark blocks and shows the sentence rather than asking for a tick", () => {
    const readiness = evaluatePublishGates(
      publishFacts({
        benchmark: {
          ...publishFacts().benchmark!,
          acknowledgedBy: undefined,
          acknowledgedAtContentRevision: undefined,
        },
      })
    );
    expect(blockingIds(readiness)).toEqual(["G7"]);
    expect(gate(readiness, "G7").message).toContain("713 estimates already built");
    expect(readiness.outstandingAcknowledgements.map((r) => r.key)).toEqual([BENCHMARK_ACK_KEY]);
  });

  it("does not quote a comparison that failed: the sentence has one composition and one source", () => {
    // `outstandingAcknowledgements` composes this same sentence from the READY
    // diff. Reading the raw record here would put a failed run's live-read
    // count into one rendering of it and not the other, and the two would sit
    // on the same screen disagreeing.
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: {
          state: "failed",
          summary: diffFacts({ effectCounts: { priced_at_creation: 0, read_live: 7 } }),
          startedAtContentRevision: REVISION,
          finishedAtContentRevision: REVISION,
        },
        benchmark: {
          ...publishFacts().benchmark!,
          acknowledgedBy: undefined,
          acknowledgedAtContentRevision: undefined,
        },
      })
    );
    expect(blockingIds(readiness)).toEqual(["G1", "G2", "G3", "G5", "G6", "G7"]);
    expect(gate(readiness, "G7").message).toContain("713 estimates already built");
    expect(gate(readiness, "G7").message).not.toContain("read LIVE");
  });

  it("still shows the benchmark signature on the outstanding list when the comparison failed", () => {
    // G7 blocks on this signature whether or not a comparison exists, but the
    // outstanding list was built only when a diff was ready — so a failed diff
    // and an unread benchmark blocked publish saying "Nobody has said they
    // read this benchmark" while `outstandingAcknowledgements` was empty. A
    // screen telling somebody to sign something it will not show them is the
    // same defect `named()` was written to close.
    const readiness = evaluatePublishGates(
      publishFacts({
        diff: {
          state: "failed",
          summary: diffFacts(),
          startedAtContentRevision: REVISION,
          finishedAtContentRevision: REVISION,
        },
        benchmark: {
          ...publishFacts().benchmark!,
          acknowledgedBy: undefined,
          acknowledgedAtContentRevision: undefined,
        },
      })
    );
    expect(gate(readiness, "G7").verdict).toBe("block");
    expect(readiness.outstandingAcknowledgements.map((r) => r.key)).toEqual([BENCHMARK_ACK_KEY]);
  });

  it('a benchmark "read" by nobody is unread on the gate AND on the list of what is left to sign', () => {
    // The gate asked `!acknowledgedBy` and the outstanding list asked
    // `!== undefined`, so a blank name blocked publish while showing an empty
    // list of things to do about it.
    const readiness = evaluatePublishGates(
      publishFacts({ benchmark: { ...publishFacts().benchmark!, acknowledgedBy: "   " } })
    );
    expect(blockingIds(readiness)).toEqual(["G7"]);
    expect(readiness.outstandingAcknowledgements.map((r) => r.key)).toEqual([BENCHMARK_ACK_KEY]);
  });

  it("a running benchmark that has read 600 of 713 estimates is not a result", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ benchmark: { ...publishFacts().benchmark!, state: "running" } })
    );
    expect(gate(readiness, "G7").message).toContain("still running");
  });
});

// ── G8 ──────────────────────────────────────────────────────────────────────

describe("G8 — nothing is riding on the default", () => {
  it("an unpinned estimate blocks, and the message says whose bug created it", () => {
    // upsertProposalsBatch inserts proposals from the 6-hourly sync payload
    // with no bookId; only the full-tree path sets one. So unpinned estimates
    // appear on their own, and publishing flips the default they resolve
    // through — which changes what they display with no write to any of them.
    const readiness = evaluatePublishGates(publishFacts({ unpinnedProposals: true }));
    expect(blockingIds(readiness)).toEqual(["G8"]);
    expect(gate(readiness, "G8").detail).toEqual({
      unpinnedProposals: true,
      unpinnedProjects: false,
    });
    expect(gate(readiness, "G8").message).toContain("This is not the rate book's bug");
    expect(gate(readiness, "G8").message).toContain("6-hourly proposals sync");
  });

  it("puts no number on an existence read, so 4,000 unpinned estimates are not '1 estimates'", () => {
    // The documented read is `.withIndex(q => q.eq("bookId", undefined)).take(1)`
    // — one document, exact, impossible to be stale — which answers whether,
    // not how many. Rendering that boolean through `int()` told an admin with
    // four thousand unpinned estimates that there was "1 estimates", and got
    // the plural wrong even at one.
    const readiness = evaluatePublishGates(publishFacts({ unpinnedProposals: true }));
    expect(gate(readiness, "G8").message).toContain("Estimates are pinned to no rate book");
    expect(gate(readiness, "G8").message).not.toContain("1 estimates");
  });

  it("an unpinned Momentum project counts too — it reads the same catalog live", () => {
    const readiness = evaluatePublishGates(publishFacts({ unpinnedProjects: true }));
    expect(blockingIds(readiness)).toEqual(["G8"]);
    // Named on its own, without a sentence about estimates that are all pinned.
    expect(gate(readiness, "G8").message).toContain("Momentum projects are pinned to no rate book");
    expect(gate(readiness, "G8").message).not.toContain("Estimates and");
  });

  it("names both subjects when both have something unpinned", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ unpinnedProposals: true, unpinnedProjects: true })
    );
    expect(gate(readiness, "G8").message).toContain(
      "Estimates and Momentum projects are pinned to no rate book"
    );
  });
});

// ── G9 ──────────────────────────────────────────────────────────────────────

describe("G9 — no import is unfinished or unread", () => {
  it("a file still applying blocks: publishing freezes the book mid-file and that cannot be undone", () => {
    // applyImport never takes book.lock, so G0 passes while a file is being
    // written. writePoolRow then throws on the next batch and insertPoolRow,
    // a raw db.insert with no draft check, has already written rows into a
    // book that is now permanent.
    const readiness = evaluatePublishGates(
      publishFacts({
        openImports: [{ fileName: "labor-2026.csv", state: "applying", pool: "labor" }],
      })
    );
    expect(blockingIds(readiness)).toEqual(["G9"]);
    expect(gate(readiness, "G9").message).toContain("freezes the book mid-file");
  });

  it("a file waiting in review blocks: publishing makes that decision impossible forever", () => {
    const readiness = evaluatePublishGates(
      publishFacts({
        openImports: [{ fileName: "labor-2026.csv", state: "review", pool: "labor" }],
      })
    );
    expect(gate(readiness, "G9").message).toContain("Nothing from that file is in this book");
  });

  it("an APPLIED import is not 'still being read (applied)' — the three finished states are dropped", () => {
    // `by_book_state` can hand this gate any of eight states. The three
    // finished ones — applied, reverted, discarded — belong to nobody's
    // decision, and passing one through produced a confident sentence about a
    // file that had completed, out of the gate whose whole job is to be
    // believed. It filters rather than trusting the caller's query.
    const readiness = evaluatePublishGates(
      publishFacts({
        openImports: [
          { fileName: "labor-2026.csv", state: "applied", pool: "labor" },
          { fileName: "phases.csv", state: "reverted", pool: "phases" },
          { fileName: "equipment.csv", state: "discarded", pool: "equipment" },
        ],
      })
    );
    expect(gate(readiness, "G9").verdict).toBe("pass");
    expect(blockingIds(readiness)).toEqual([]);
  });

  it("a file that failed part-way is reported ahead of one merely waiting for a decision", () => {
    const readiness = evaluatePublishGates(
      publishFacts({
        openImports: [
          { fileName: "phases.csv", state: "review", pool: "phases" },
          { fileName: "labor-2026.csv", state: "failed", pool: "labor" },
        ],
      })
    );
    expect(gate(readiness, "G9").detail).toEqual({ fileName: "labor-2026.csv", state: "failed" });
  });
});

// ── G10 ─────────────────────────────────────────────────────────────────────

describe("G10 — the screen you clicked from is the draft that exists", () => {
  it("publishing a book that is already published reports that nothing went wrong", () => {
    // Two clicks are already safe — Convex mutations are serializable — but
    // the refusal currently reads as a failure when it was in fact a success,
    // which teaches people to distrust the button.
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, status: "published" } })
    );
    expect(gate(readiness, "G10").message).toContain("already published as book 3");
    expect(gate(readiness, "G10").message).toContain("Nothing went wrong");
  });

  it("a draft that changed while the publish screen was open names both revisions", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, expectedContentRevision: 13 } })
    );
    expect(blockingIds(readiness)).toEqual(["G10"]);
    expect(gate(readiness, "G10").detail).toEqual({ expected: 13, actual: 15 });
  });

  it("a publish screen that never said which revision it was showing is refused", () => {
    const readiness = evaluatePublishGates(
      publishFacts({ book: { ...publishFacts().book, expectedContentRevision: undefined } })
    );
    expect(gate(readiness, "G10").message).toContain("Reload it and try again");
  });
});

// ── The permanent notes ─────────────────────────────────────────────────────

describe("the release notes a book keeps forever", () => {
  it("writes what was measured into the book, not just onto a screen", () => {
    const notes = composePublishNotes(
      "Annual labor constant review.",
      diffFacts({ flagCounts: { ...NO_FLAGS, large_change: 43, decimal_shift: 2 } }),
      benchmarkFacts()
    );
    expect(notes).toContain("Annual labor constant review.");
    expect(notes).toContain("51 rows changed, 6,221 unchanged");
    expect(notes).toContain("43 large_change");
    expect(notes).toContain("2 decimal_shift");
    expect(notes).toContain('Benchmark against "Original Rate Book": 713 estimates');
    expect(notes).toContain("-$12,345.67");
    expect(notes).toContain("700 did not move at all");
  });

  it("carries the counterfactual caveat, so the numbers can never be read as a repricing", () => {
    const notes = composePublishNotes("Re-rate.", diffFacts(), benchmarkFacts());
    expect(notes).toContain("Nothing below happens to a finished estimate");
  });

  it("records the three real shift bands with their offsets, so the ids that moved are on the record", () => {
    const notes = composePublishNotes(
      "Corrected the shifted id column.",
      diffFacts({ shiftBands: realShiftBands() }),
      benchmarkFacts()
    );
    expect(notes).toContain("3 bands, 1,064 rows, at offsets -4, -455, +8");
  });

  it("records that a run measured nothing, rather than recording a $0.00 that reads as a result", () => {
    const notes = composePublishNotes(
      "Equipment re-rate.",
      diffFacts(),
      benchmarkFacts({ measuredNothing: true })
    );
    expect(notes).toContain("it measured nothing about this draft");
    expect(notes).not.toContain("$");
  });

  it("says plainly when no benchmark was run at all", () => {
    const notes = composePublishNotes("Typo fix.", diffFacts(), undefined);
    expect(notes).toContain("- Benchmark: none was run.");
  });

  it("names the live-read changes, because those are the only ones that reach a finished estimate", () => {
    const notes = composePublishNotes(
      "Takeoff units.",
      diffFacts({ effectCounts: { priced_at_creation: 0, read_live: 7 } }),
      benchmarkFacts()
    );
    expect(notes).toContain("Read live by finished estimates: 7 rows");
  });
});
