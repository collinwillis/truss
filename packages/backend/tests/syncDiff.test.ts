/**
 * Deciding what the Firestore mirror has to write.
 *
 * THE FIRST TEST IS THE WHOLE ECONOMIC CASE. A full-read/differential-write
 * mirror is only cheap if a tree that has not changed produces literally no
 * writes, so the first thing asserted here is idempotence: build a realistic
 * tree out of the real legacy catalog rows, run it through the real field
 * mappers, store it the way Convex stores it, feed the same mapper output back
 * in, and require every single row to come back UNCHANGED. If that property
 * breaks, the design is a full rewrite of 352,969 rows every six hours wearing
 * a differential's clothes.
 *
 * Everything after it is the set of ways that property has a real chance of
 * breaking: nested objects, absence, floats, and the catalog-link repair whose
 * stale ids Firestore is still serving.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapActivity, mapPhase, mapProposal, mapWBS } from "../convex/sync/fieldMapping";
import {
  MIRROR_TRANSPORT_FIELDS,
  changedMirroredFields,
  diffLevel,
  diffProposalTree,
  diffRow,
  isMirroredValueEqual,
  sumLevelCounts,
  treeHasWork,
  type ProposalTreeInput,
  type SyncRow,
} from "../convex/model/syncDiff";

// ============================================================================
// Real legacy catalog rows
// ============================================================================

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const read = (file: string) =>
  JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Array<Record<string, unknown>>;

const LABOR = read("labor_v1.json");
const EQUIPMENT = read("equipment_v1.json");

/** A real labor catalog row by its (positional, historically unstable) id. */
function laborRow(id: number): Record<string, unknown> {
  const row = LABOR.find((r) => Number(r.id) === id);
  if (!row) throw new Error(`labor_v1.json has no id ${id}`);
  return row;
}

/** A real equipment catalog row by its id. */
function equipmentRow(id: number): Record<string, unknown> {
  const row = EQUIPMENT.find((r) => Number(r.id) === id);
  if (!row) throw new Error(`equipment_v1.json has no id ${id}`);
  return row;
}

// ============================================================================
// Firestore documents, as `parseDocument` hands them to the mappers
// ============================================================================

const PROPOSAL_FS_ID = "OeQ2mS9pXk1vB7lJ4dRt";
const WBS_FS_ID = "wbs_AG_PIPING";
const PHASE_FS_IDS = ["phase_civil", "phase_tank", "phase_general"] as const;

const proposalDoc = (): Record<string, unknown> => ({
  _fsId: PROPOSAL_FS_ID,
  proposalNumber: "1956.01",
  proposalDescription: "TANK FARM PIPING REVAMP",
  proposalOwner: "PHILLIPS 66",
  proposalStatus: "Awarded",
  bidType: "Lump Sum",
  projectCity: "BORGER",
  projectState: "TX",
  jobSiteAddress: "1000 REFINERY RD",
  proposalEstimators: "C WILLIS, M SOTO",
  proposalDateReceived: "2025-04-14T00:00:00.000Z",
  proposalDateDue: "2025-05-01T00:00:00.000Z",
  job: "J-4471",
  // The 15 rates, at the awkward precisions estimators actually type.
  craftBaseRate: 42.75,
  weldBaseRate: 48.5,
  subsistenceRate: 110,
  burdenRate: 0.3875,
  overheadRate: 0.115,
  consumablesRate: 0.0325,
  fuelRate: 0.0185,
  rigRate: 12.5,
  useTaxRate: 0.0825,
  salesTaxRate: 0.0825,
  laborProfitRate: 0.15,
  materialProfitRate: 0.1,
  equipmentProfitRate: 0.12,
  subContractorProfitRate: 0.05,
  rigProfitRate: 0.1,
});

const wbsDoc = (): Record<string, unknown> => ({
  _fsId: WBS_FS_ID,
  proposalId: PROPOSAL_FS_ID,
  wbsDatabaseId: 70000,
  name: "AG PIPING",
});

const phaseDocs = (): Array<Record<string, unknown>> => [
  {
    _fsId: PHASE_FS_IDS[0],
    proposalId: PROPOSAL_FS_ID,
    wbsId: WBS_FS_ID,
    phaseDatabaseId: 20002,
    phaseDatabaseName: "EXCAVATION",
    phaseNumber: 1,
    description: "TANK RING FOUNDATION",
    area: "TF-4",
    sheet: 3,
    completed: false,
  },
  {
    // Carries the piping spec, so the nested optional object is exercised.
    _fsId: PHASE_FS_IDS[1],
    proposalId: PROPOSAL_FS_ID,
    wbsId: WBS_FS_ID,
    phaseDatabaseId: 40005,
    phaseDatabaseName: "TANK WORK",
    phaseNumber: 2,
    description: "SHELL COURSE 1",
    size: "6",
    spec: "A106B",
    flc: "150",
    system: "PROCESS",
    insulation: "CS",
    insulationSize: 2,
    completed: true,
  },
  {
    _fsId: PHASE_FS_IDS[2],
    proposalId: PROPOSAL_FS_ID,
    wbsId: WBS_FS_ID,
    phaseDatabaseId: 10001,
    phaseDatabaseName: "GENERAL",
    phaseNumber: 3,
    description: "GENERAL CONDITIONS",
    completed: false,
  },
];

/** A labor line built from a real catalog row, links and all. */
function laborDoc(fsId: string, phaseFsId: string, poolId: number, quantity: number) {
  const row = laborRow(poolId);
  return {
    _fsId: fsId,
    proposalId: PROPOSAL_FS_ID,
    wbsId: WBS_FS_ID,
    phaseId: phaseFsId,
    activityType: "laborItem",
    description: row.description,
    quantity,
    unit: row.craftUnits,
    sortOrder: row.sortOrder,
    constant: {
      id: row.id,
      craftConstant: row.craftConstant,
      weldConstant: row.weldConstant,
      craftUnits: row.craftUnits,
      sortOrder: row.sortOrder,
    },
  } satisfies Record<string, unknown>;
}

/** An equipment line built from a real catalog row. */
function equipmentDoc(fsId: string, phaseFsId: string, poolId: number, time: number) {
  const row = equipmentRow(poolId);
  return {
    _fsId: fsId,
    proposalId: PROPOSAL_FS_ID,
    wbsId: WBS_FS_ID,
    phaseId: phaseFsId,
    activityType: "equipmentItem",
    description: row.description,
    quantity: 1,
    unit: "DAY",
    sortOrder: 100,
    price: row.dayRate,
    equipmentOwnership: "Rental",
    time,
    equipment: { id: row.id, description: row.description },
  } satisfies Record<string, unknown>;
}

function activityDocs(): Array<Record<string, unknown>> {
  return [
    laborDoc("act_exc_light", PHASE_FS_IDS[0], 28, 480),
    laborDoc("act_exc_heavy", PHASE_FS_IDS[0], 30, 120),
    laborDoc("act_haul", PHASE_FS_IDS[0], 33, 36),
    // Welding: both nested labor constants are non-zero.
    laborDoc("act_seam_weld", PHASE_FS_IDS[1], 455, 1240),
    laborDoc("act_lifting_lugs", PHASE_FS_IDS[1], 458, 48),
    {
      // A per-line rate override, so `labor` carries its two optional members.
      ...laborDoc("act_tank_lugs", PHASE_FS_IDS[1], 457, 16),
      craftBaseRate: 51.25,
      subsistenceRate: 125,
    },
    equipmentDoc("act_crane", PHASE_FS_IDS[1], 28, 12),
    equipmentDoc("act_compressor", PHASE_FS_IDS[0], 1, 20),
    {
      _fsId: "act_pipe_material",
      proposalId: PROPOSAL_FS_ID,
      wbsId: WBS_FS_ID,
      phaseId: PHASE_FS_IDS[1],
      activityType: "materialItem",
      description: '6" SCH40 A106B PIPE',
      quantity: 1240,
      unit: "LF",
      sortOrder: 200,
      price: 18.37,
    },
    {
      _fsId: "act_xray",
      proposalId: PROPOSAL_FS_ID,
      wbsId: WBS_FS_ID,
      phaseId: PHASE_FS_IDS[1],
      activityType: "subContractorItem",
      description: "X-RAY SERVICES",
      quantity: 1,
      unit: "LS",
      sortOrder: 300,
      craftCost: 12500.75,
      materialCost: 0,
      equipmentCost: 3200.5,
    },
    {
      _fsId: "act_permits",
      proposalId: PROPOSAL_FS_ID,
      wbsId: WBS_FS_ID,
      phaseId: PHASE_FS_IDS[2],
      activityType: "costOnlyItem",
      description: "PERMITS & FEES",
      quantity: 1,
      unit: "LS",
      sortOrder: 400,
      price: 4750,
    },
  ];
}

// ============================================================================
// The two sides of the comparison
// ============================================================================

/** Convex ids, stood in for by the strings the differ only ever compares. */
const CONVEX_IDS = {
  proposal: "j57proposal000000000000000",
  wbs: "j97wbs00000000000000000000",
  phases: {
    [PHASE_FS_IDS[0]]: "j17phase0000000000000000a0",
    [PHASE_FS_IDS[1]]: "j17phase0000000000000000b0",
    [PHASE_FS_IDS[2]]: "j17phase0000000000000000c0",
  } as Record<string, string>,
};

/**
 * A mapped row as the writer would submit it: mapper output plus the parent ids
 * only the caller can resolve.
 */
function asIncoming(
  mapped: Record<string, unknown>,
  derived: Record<string, unknown> = {}
): SyncRow {
  return { ...mapped, ...derived };
}

/**
 * A mapped row as Convex would hand it back on the NEXT pass.
 *
 * The JSON round trip is the wire and it is doing real work: it drops every
 * explicitly-undefined key exactly as Convex drops an undefined field on write,
 * which is the single most likely source of a phantom diff.
 */
function asStored(mapped: Record<string, unknown>, extra: Record<string, unknown> = {}): SyncRow {
  const mirrored = Object.fromEntries(
    Object.entries(mapped).filter(([key]) => !MIRROR_TRANSPORT_FIELDS.has(key))
  );
  const wire = JSON.parse(JSON.stringify(mirrored)) as Record<string, unknown>;
  return { ...wire, ...extra };
}

/** The full tree, on both sides, with nothing changed between them. */
function settledTree(): ProposalTreeInput {
  const proposal = mapProposal(proposalDoc());
  const wbs = mapWBS(wbsDoc());
  const phases = phaseDocs().map(mapPhase);
  const activities = activityDocs().map((doc) => mapActivity(doc));

  const wbsDerived = { proposalId: CONVEX_IDS.proposal };
  const phaseDerived = { proposalId: CONVEX_IDS.proposal, wbsId: CONVEX_IDS.wbs };
  const activityDerived = (fsPhaseId: unknown) => ({
    proposalId: CONVEX_IDS.proposal,
    wbsId: CONVEX_IDS.wbs,
    phaseId: CONVEX_IDS.phases[String(fsPhaseId)],
  });

  return {
    incoming: {
      proposal: asIncoming(proposal),
      wbs: [asIncoming(wbs, wbsDerived)],
      phases: phases.map((p) => asIncoming(p, phaseDerived)),
      activities: activities.map((a) => asIncoming(a, activityDerived(a.fsPhaseId))),
    },
    existing: {
      // The Convex-only columns the mappers never emit, on the row that has them.
      proposal: asStored(proposal, {
        _id: CONVEX_IDS.proposal,
        _creationTime: 1_744_000_000_000,
        bookId: "j37book0000000000000000000",
        costTotal: 1_284_907.42,
        costTotalAt: 1_754_000_000_000,
        contactId: "j77contact000000000000000",
      }),
      wbs: [
        asStored(wbs, { _id: CONVEX_IDS.wbs, _creationTime: 1_744_000_000_001, ...wbsDerived }),
      ],
      phases: phases.map((p, i) =>
        asStored(p, {
          _id: CONVEX_IDS.phases[String(p.firestoreId)],
          _creationTime: 1_744_000_000_100 + i,
          ...phaseDerived,
        })
      ),
      activities: activities.map((a, i) =>
        asStored(a, {
          _id: `j27activity${String(i).padStart(14, "0")}`,
          _creationTime: 1_744_000_001_000 + i,
          ...activityDerived(a.fsPhaseId),
        })
      ),
    },
  };
}

/** Every stored activity, keyed by the Firestore id both sides agree on. */
function storedActivity(tree: ProposalTreeInput, firestoreId: string): SyncRow {
  const row = tree.existing.activities.find((a) => a.firestoreId === firestoreId);
  if (!row) throw new Error(`no stored activity ${firestoreId}`);
  return row;
}

/** Every incoming activity, keyed the same way. */
function incomingActivity(tree: ProposalTreeInput, firestoreId: string): SyncRow {
  const row = tree.incoming.activities.find((a) => a.firestoreId === firestoreId);
  if (!row) throw new Error(`no incoming activity ${firestoreId}`);
  return row;
}

// ============================================================================
// 1. Idempotence
// ============================================================================

describe("idempotence — a settled tree produces no writes at all", () => {
  it("every row of a real-shaped tree comes back UNCHANGED", () => {
    const tree = settledTree();
    const diff = diffProposalTree(tree);

    // Guard the guard: a fixture that accidentally emptied would pass vacuously.
    expect(tree.incoming.activities.length).toBe(11);
    expect(tree.incoming.phases.length).toBe(3);

    expect(diff.skipped).toBeNull();
    expect(diff.counts.total).toEqual({
      insert: 0,
      patch: 0,
      unchanged: 1 + 1 + 3 + 11,
      orphaned: 0,
      localOnly: 0,
      duplicate: 0,
    });
    expect(treeHasWork(diff)).toBe(false);
  });

  it("carries the nested objects that would otherwise diff every pass", () => {
    const tree = settledTree();

    // rates (15 doubles), projectAddress, estimators on the proposal…
    const proposal = tree.existing.proposal;
    expect(proposal?.rates).toMatchObject({ burdenRate: 0.3875, craftBaseRate: 42.75 });
    expect(proposal?.projectAddress).toEqual({ city: "BORGER", state: "TX" });
    expect(proposal?.estimators).toEqual(["C WILLIS", "M SOTO"]);
    // …pipingSpec on a phase…
    expect(tree.existing.phases[1]?.pipingSpec).toMatchObject({ size: "6", spec: "A106B" });
    // …and labor / equipment / subcontractor on the activities.
    expect(storedActivity(tree, "act_seam_weld").labor).toEqual({
      craftConstant: 0.1,
      welderConstant: 0.3,
    });
    expect(storedActivity(tree, "act_tank_lugs").labor).toEqual({
      craftConstant: 4,
      welderConstant: 4,
      customCraftRate: 51.25,
      customSubsistenceRate: 125,
    });
    expect(storedActivity(tree, "act_crane").equipment).toEqual({ ownership: "rental", time: 12 });
    expect(storedActivity(tree, "act_xray").subcontractor).toEqual({
      laborCost: 12500.75,
      materialCost: 0,
      equipmentCost: 3200.5,
    });
  });

  it("ignores every Convex-only column, including Momentum's and Precision's", () => {
    const tree = settledTree();
    const stored = {
      ...storedActivity(tree, "act_exc_light"),
      // Repaired by activityLinks, added by takeoff seeding, added by Momentum.
      countsTowardTakeoff: true,
      momentumNote: "installed 2026-07-30",
      isHidden: false,
    };

    const diff = diffRow("activity", incomingActivity(tree, "act_exc_light"), stored);
    expect(diff.verdict).toBe("unchanged");
    expect(diff.changed).toEqual({});
  });
});

// ============================================================================
// 2. The catalog-link rule
// ============================================================================

describe("the catalog-link rule is part of the diff, not a footnote in the mutation", () => {
  it("a repaired laborPoolId does not rewrite while the description stands", () => {
    const tree = settledTree();
    // What activityLinks.repairBatch left behind: the line points at the item it
    // describes, while Firestore still serves the id the sliding list once had.
    const repaired = { ...storedActivity(tree, "act_exc_light"), laborPoolId: 1204 };
    const incoming = incomingActivity(tree, "act_exc_light");
    expect(incoming.laborPoolId).toBe(28);

    const diff = diffRow("activity", incoming, repaired);
    expect(diff.verdict).toBe("unchanged");
    expect(diff.changed).toEqual({});
    expect(diff.suppressed).toEqual(["laborPoolId"]);
  });

  it("does the same for a repaired equipmentPoolId", () => {
    const tree = settledTree();
    const repaired = { ...storedActivity(tree, "act_crane"), equipmentPoolId: 132 };
    const diff = diffRow("activity", incomingActivity(tree, "act_crane"), repaired);
    expect(diff.verdict).toBe("unchanged");
    expect(diff.suppressed).toEqual(["equipmentPoolId"]);
  });

  it("takes the incoming id when the description changed, because the item did", () => {
    const tree = settledTree();
    const repaired = {
      ...storedActivity(tree, "act_exc_light"),
      laborPoolId: 1204,
      description: "EXCAVATE, LIGHT (CLASS D - TOPSOIL)",
    };
    const diff = diffRow("activity", incomingActivity(tree, "act_exc_light"), repaired);
    expect(diff.verdict).toBe("patch");
    expect(diff.changed).toEqual({
      description: "EXCAVATE, LIGHT (CLASS C - GRAVEL)",
      laborPoolId: 28,
    });
    expect(diff.suppressed).toEqual([]);
  });

  it("suppresses the link only on activities — a phase field of that name would not be", () => {
    const stale = changedMirroredFields(
      "phase",
      { firestoreId: "p1", laborPoolId: 28 },
      { firestoreId: "p1", laborPoolId: 1204 }
    );
    expect(stale.changed).toEqual({ laborPoolId: 28 });
    expect(stale.suppressed).toEqual([]);
  });

  it("still patches the rest of a repaired row when something real moved", () => {
    const tree = settledTree();
    const repaired = {
      ...storedActivity(tree, "act_exc_light"),
      laborPoolId: 1204,
      quantity: 400,
    };
    const diff = diffRow("activity", incomingActivity(tree, "act_exc_light"), repaired);
    expect(diff.verdict).toBe("patch");
    expect(diff.changed).toEqual({ quantity: 480 });
    expect(diff.suppressed).toEqual(["laborPoolId"]);
  });
});

// ============================================================================
// 3. Real changes, minimally described
// ============================================================================

describe("a real change patches exactly the fields that moved", () => {
  it("a quantity edit patches quantity and nothing else", () => {
    const tree = settledTree();
    const stale = { ...storedActivity(tree, "act_haul"), quantity: 24 };
    const diff = diffRow("activity", incomingActivity(tree, "act_haul"), stale);
    expect(diff.verdict).toBe("patch");
    expect(diff.changed).toEqual({ quantity: 36 });
  });

  it("a constant edit patches the whole nested labor object, since patch is shallow", () => {
    const tree = settledTree();
    const stale = {
      ...storedActivity(tree, "act_seam_weld"),
      labor: { craftConstant: 0.1, welderConstant: 0.28 },
    };
    const diff = diffRow("activity", incomingActivity(tree, "act_seam_weld"), stale);
    expect(diff.changed).toEqual({ labor: { craftConstant: 0.1, welderConstant: 0.3 } });
  });

  it("does not mistake key order inside a nested object for a change", () => {
    const tree = settledTree();
    const reordered = {
      ...storedActivity(tree, "act_seam_weld"),
      labor: { welderConstant: 0.3, craftConstant: 0.1 },
    };
    expect(diffRow("activity", incomingActivity(tree, "act_seam_weld"), reordered).verdict).toBe(
      "unchanged"
    );
  });

  it("catches a line moved to another phase, through the resolved phaseId", () => {
    const tree = settledTree();
    const incoming = incomingActivity(tree, "act_haul");
    const elsewhere = {
      ...storedActivity(tree, "act_haul"),
      phaseId: CONVEX_IDS.phases[PHASE_FS_IDS[2]],
    };
    const diff = diffRow("activity", incoming, elsewhere);
    expect(diff.verdict).toBe("patch");
    expect(diff.changed).toEqual({ phaseId: CONVEX_IDS.phases[PHASE_FS_IDS[0]] });
  });

  it("never proposes a transport key as a field to write", () => {
    const tree = settledTree();
    const stale = { ...storedActivity(tree, "act_haul"), quantity: 24 };
    const patch = diffRow("activity", incomingActivity(tree, "act_haul"), stale);
    const insert = diffRow("activity", incomingActivity(tree, "act_haul"), null);
    for (const key of MIRROR_TRANSPORT_FIELDS) {
      expect(patch.changed).not.toHaveProperty(key);
      expect(insert.changed).not.toHaveProperty(key);
    }
  });
});

// ============================================================================
// 4. Floating point
// ============================================================================

describe("floating point is compared exactly, and that is the decision", () => {
  it("rates that round-tripped through JSON are equal, not merely close", () => {
    const proposal = mapProposal(proposalDoc());
    const stored = asStored(proposal);
    expect(isMirroredValueEqual(stored.rates, proposal.rates)).toBe(true);
    expect(diffRow("proposal", proposal, stored).verdict).toBe("unchanged");
  });

  it("patches an edit far smaller than any tolerance would have kept", () => {
    const proposal = mapProposal(proposalDoc());
    const stored = asStored(proposal) as Record<string, unknown>;
    const rates = { ...(stored.rates as Record<string, unknown>), burdenRate: 0.3875001 };
    const diff = diffRow("proposal", proposal, { ...stored, rates });
    expect(diff.verdict).toBe("patch");
    expect(diff.changed).toHaveProperty("rates");
  });

  it("treats -0 and 0 as the same number", () => {
    expect(isMirroredValueEqual(-0, 0)).toBe(true);
    const diff = diffRow(
      "activity",
      { firestoreId: "a", quantity: 0 },
      { firestoreId: "a", quantity: -0 }
    );
    expect(diff.verdict).toBe("unchanged");
  });

  it("does not rewrite a NaN row on every pass for ever", () => {
    expect(isMirroredValueEqual(NaN, NaN)).toBe(true);
    expect(isMirroredValueEqual(NaN, 0)).toBe(false);
  });

  it("reports accumulated float error as a change, because nothing here accumulates", () => {
    expect(isMirroredValueEqual(0.1 + 0.2, 0.3)).toBe(false);
  });
});

// ============================================================================
// 5. undefined, absent, null, ""
// ============================================================================

describe("undefined, absent, null and empty string", () => {
  it("folds the mapper's explicit undefined into Convex's absent key", () => {
    const withUndefined = { firestoreId: "w1", name: "AG PIPING", customUnit: undefined };
    const absent = { firestoreId: "w1", name: "AG PIPING" };
    expect(diffRow("wbs", withUndefined, absent).verdict).toBe("unchanged");
  });

  it("folds it inside nested objects too", () => {
    const incoming = {
      firestoreId: "p1",
      pipingSpec: { size: "6", spec: "A106B", flc: undefined, insulationSize: undefined },
    };
    const stored = { firestoreId: "p1", pipingSpec: { size: "6", spec: "A106B" } };
    expect(diffRow("phase", incoming, stored).verdict).toBe("unchanged");
  });

  it("treats an empty string as a value, not an absence", () => {
    // The takeoff lesson: `""` and absent are different statements about a row,
    // and only the upstream system gets to say which one it means.
    const diff = diffRow("wbs", { firestoreId: "w1", customUnit: "" }, { firestoreId: "w1" });
    expect(diff.verdict).toBe("patch");
    expect(diff.changed).toEqual({ customUnit: "" });
  });

  it("clears a field Firestore stopped supplying rather than leaving it stale", () => {
    const diff = diffRow(
      "wbs",
      { firestoreId: "w1", customUnit: undefined },
      { firestoreId: "w1", customUnit: "LF" }
    );
    expect(diff.verdict).toBe("patch");
    expect(Object.keys(diff.changed)).toEqual(["customUnit"]);
    expect(diff.changed.customUnit).toBeUndefined();
  });

  it("does not fold null into absence — a stored null is a fault worth seeing", () => {
    expect(isMirroredValueEqual(null, undefined)).toBe(false);
    const diff = diffRow(
      "wbs",
      { firestoreId: "w1", customUnit: undefined },
      { firestoreId: "w1", customUnit: null }
    );
    expect(diff.verdict).toBe("patch");
  });

  it("does not fold 0 or false into absence", () => {
    expect(isMirroredValueEqual(0, undefined)).toBe(false);
    expect(isMirroredValueEqual(false, undefined)).toBe(false);
    expect(isMirroredValueEqual("", 0)).toBe(false);
  });
});

// ============================================================================
// 6. Inserts, orphans, and rows that were never mirrored
// ============================================================================

describe("rows on only one side", () => {
  it("carries every comparable field on an insert", () => {
    const tree = settledTree();
    const incoming = incomingActivity(tree, "act_pipe_material");
    const diff = diffRow("activity", incoming, null);
    expect(diff.verdict).toBe("insert");
    expect(diff.changed).toMatchObject({
      firestoreId: "act_pipe_material",
      type: "material",
      description: '6" SCH40 A106B PIPE',
      quantity: 1240,
      unitPrice: 18.37,
      proposalId: CONVEX_IDS.proposal,
      phaseId: CONVEX_IDS.phases[PHASE_FS_IDS[1]],
    });
  });

  it("reports a line deleted in MCP as ORPHANED and asks for nothing", () => {
    const tree = settledTree();
    const level = diffLevel(
      "activity",
      tree.incoming.activities.filter((a) => a.firestoreId !== "act_permits"),
      tree.existing.activities
    );
    expect(level.counts.orphaned).toBe(1);
    expect(level.orphans[0]?.firestoreId).toBe("act_permits");
    expect(level.orphans[0]?.changed).toEqual({});
    expect(level.counts.unchanged).toBe(10);
  });

  it("an orphan alone is not work — nothing may be deleted", () => {
    const tree = settledTree();
    const diff = diffProposalTree({
      ...tree,
      incoming: {
        ...tree.incoming,
        activities: tree.incoming.activities.filter((a) => a.firestoreId !== "act_permits"),
      },
    });
    expect(diff.counts.activity.orphaned).toBe(1);
    expect(treeHasWork(diff)).toBe(false);
  });

  it("never calls a Precision-created line deleted upstream", () => {
    const tree = settledTree();
    const local: SyncRow = {
      _id: "j27activity99999999999999",
      description: "OWNER-DIRECTED ADD",
      quantity: 1,
    };
    const level = diffLevel("activity", tree.incoming.activities, [
      ...tree.existing.activities,
      local,
    ]);
    expect(level.counts.localOnly).toBe(1);
    expect(level.counts.orphaned).toBe(0);
  });

  it("counts a duplicated firestoreId instead of reporting a phantom deletion", () => {
    const tree = settledTree();
    const level = diffLevel("activity", tree.incoming.activities, [
      ...tree.existing.activities,
      storedActivity(tree, "act_haul"),
    ]);
    expect(level.counts.duplicate).toBe(1);
    expect(level.counts.orphaned).toBe(0);
    expect(level.counts.unchanged).toBe(11);
  });
});

// ============================================================================
// 7. Trees the mirror must never touch
// ============================================================================

describe("trees the mirror must not touch", () => {
  it("skips a Precision-owned estimate whole, with zero counts", () => {
    const tree = settledTree();
    const owned: ProposalTreeInput = {
      ...tree,
      incoming: {
        ...tree.incoming,
        // Even with the entire tree rewritten upstream, nothing may be written.
        proposal: { ...tree.incoming.proposal, description: "REVERTED BY THE MIRROR" },
      },
      existing: {
        ...tree.existing,
        proposal: { ...(tree.existing.proposal ?? {}), precisionOwnedAt: 1_754_300_000_000 },
      },
    };
    const diff = diffProposalTree(owned);
    expect(diff.skipped).toBe("precision_owned");
    expect(diff.counts.total).toEqual({
      insert: 0,
      patch: 0,
      unchanged: 0,
      orphaned: 0,
      localOnly: 0,
      duplicate: 0,
    });
    expect(treeHasWork(diff)).toBe(false);
  });

  it("skips an estimate deleted in Precision, so the mirror cannot resurrect it", () => {
    const tree = settledTree();
    const diff = diffProposalTree({
      ...tree,
      existing: { proposal: null, wbs: [], phases: [], activities: [] },
      deletedInPrecision: true,
    });
    expect(diff.skipped).toBe("deleted_in_precision");
    expect(treeHasWork(diff)).toBe(false);
  });

  it("still mirrors an estimate Precision has never claimed", () => {
    const tree = settledTree();
    expect(diffProposalTree(tree).skipped).toBeNull();
  });
});

// ============================================================================
// 8. Counts, and settling
// ============================================================================

describe("the counts a run report needs", () => {
  it("rolls the four levels up into the total", () => {
    const tree = settledTree();
    const diff = diffProposalTree({
      ...tree,
      existing: { proposal: null, wbs: [], phases: [], activities: [] },
    });
    expect(diff.counts.proposal.insert).toBe(1);
    expect(diff.counts.wbs.insert).toBe(1);
    expect(diff.counts.phase.insert).toBe(3);
    expect(diff.counts.activity.insert).toBe(11);
    expect(diff.counts.total).toEqual(
      sumLevelCounts(diff.counts.proposal, diff.counts.wbs, diff.counts.phase, diff.counts.activity)
    );
    expect(treeHasWork(diff)).toBe(true);
  });

  it("settles: applying the patches makes the next pass UNCHANGED", () => {
    const tree = settledTree();
    const drifted = tree.existing.activities.map((a) =>
      a.firestoreId === "act_haul" ? { ...a, quantity: 24, laborPoolId: 1204 } : a
    );

    const first = diffLevel("activity", tree.incoming.activities, drifted);
    expect(first.counts.patch).toBe(1);

    const applied = drifted.map((a) =>
      a.firestoreId === "act_haul" ? { ...a, ...first.patches[0]?.changed } : a
    );
    const second = diffLevel("activity", tree.incoming.activities, applied);
    expect(second.counts).toEqual({
      insert: 0,
      patch: 0,
      unchanged: 11,
      orphaned: 0,
      localOnly: 0,
      duplicate: 0,
    });
    // The repair survived the write it triggered.
    expect(applied.find((a) => a.firestoreId === "act_haul")?.laborPoolId).toBe(1204);
  });
});
