/**
 * copyActivitiesToPhase — subset selection and copy fidelity.
 *
 * The contracts under test: an absent `activityIds` copies the whole phase
 * (the original behavior, kept for parity); a subset copies exactly those
 * lines; an id from another phase is REFUSED, not silently skipped; and a
 * copied line keeps every cost-bearing and takeoff-bearing field while
 * deriving `wbsId` from the TARGET phase — the legacy corruption this
 * mutation exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { laborActivity, seedProposal } from "./convexFixtures";
import { RATES_2020 } from "./rates";

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`fixture missing ${label}`);
  return value;
}

async function seedTwoPhases() {
  const { t, as } = await ownerHarness();
  const tree = await seedProposal(t, {
    proposalNumber: "2080",
    rates: RATES_2020,
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [
          { phaseNumber: 1, activities: [laborActivity(10), laborActivity(20), laborActivity(30)] },
          { phaseNumber: 2 },
        ],
      },
      { poolId: 90000, name: "PAINTING", phases: [{ phaseNumber: 5 }] },
    ],
  });
  return {
    t,
    as,
    sourceId: must(tree.phaseByNumber.get("70000:1"), "phase 1"),
    targetId: must(tree.phaseByNumber.get("70000:2"), "phase 2"),
    crossWbsTargetId: must(tree.phaseByNumber.get("90000:5"), "phase 5"),
    activityIds: tree.activityIds,
  };
}

describe("copyActivitiesToPhase", () => {
  it("copies the whole phase when no subset is given", async () => {
    const { as, sourceId, targetId } = await seedTwoPhases();

    const inserted = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: sourceId,
      targetPhaseId: targetId,
    });

    expect(inserted).toHaveLength(3);
    const target = await as.query(api.precision.getActivitiesWithCosts, { phaseId: targetId });
    expect(target.map((a) => a.quantity).sort((x, y) => x - y)).toEqual([10, 20, 30]);
  });

  it("copies exactly the selected subset, preserving source order", async () => {
    const { as, sourceId, targetId, activityIds } = await seedTwoPhases();
    // Reversed on purpose: request order must NOT drive copy order. An
    // implementation iterating `args.activityIds` reads back [30, 10] here.
    const subset = [activityIds[2]!, activityIds[0]!];

    const inserted = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: sourceId,
      targetPhaseId: targetId,
      activityIds: subset,
    });

    expect(inserted).toHaveLength(2);
    const target = await as.query(api.precision.getActivitiesWithCosts, { phaseId: targetId });
    expect(target.map((a) => a.quantity)).toEqual([10, 30]);
  });

  it("refuses an id that is not in the source phase", async () => {
    const { as, sourceId, targetId, crossWbsTargetId, activityIds } = await seedTwoPhases();

    // Move one line's id out of reach by copying it first, then referencing
    // a target-phase id as if it were a source line.
    const [copied] = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: sourceId,
      targetPhaseId: targetId,
      activityIds: [activityIds[0]!],
    });

    await expect(
      as.mutation(api.precision.copyActivitiesToPhase, {
        sourcePhaseId: sourceId,
        targetPhaseId: crossWbsTargetId,
        activityIds: [copied!],
      })
    ).rejects.toThrow("not in the source phase");
  });

  it("refuses an empty selection without claiming the target estimate", async () => {
    const { t, as, sourceId, targetId } = await seedTwoPhases();
    const targetPhase = await t.run(async (ctx) => ctx.db.get(targetId));
    await t.run(async (ctx) => ctx.db.patch(targetPhase!.proposalId, { firestoreId: "fs-p" }));

    await expect(
      as.mutation(api.precision.copyActivitiesToPhase, {
        sourcePhaseId: sourceId,
        targetPhaseId: targetId,
        activityIds: [],
      })
    ).rejects.toThrow("Nothing to copy");

    // The refusal must land BEFORE claimForPrecision — a zero-insert write
    // must never detach a mirrored estimate from the sync (D1).
    const proposal = await t.run(async (ctx) => ctx.db.get(targetPhase!.proposalId));
    expect(proposal?.precisionOwnedAt).toBeUndefined();
  });

  it("dedupes repeated ids rather than inserting twice", async () => {
    const { as, sourceId, targetId, activityIds } = await seedTwoPhases();

    const inserted = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: sourceId,
      targetPhaseId: targetId,
      activityIds: [activityIds[0]!, activityIds[0]!],
    });

    expect(inserted).toHaveLength(1);
  });

  it("refuses copying between proposals on different catalog versions", async () => {
    const { t, as, sourceId } = await seedTwoPhases();
    const other = await seedProposal(t, {
      proposalNumber: "2081",
      rates: RATES_2020,
      wbs: [{ poolId: 70000, phases: [{ phaseNumber: 9 }] }],
    });
    const otherPhaseId = must(other.phaseByNumber.get("70000:9"), "other phase");
    await t.run(async (ctx) => ctx.db.patch(other.proposalId, { datasetVersion: "v2" }));

    // Pool ids are numbers scoped by datasetVersion — re-keying them into
    // another catalog would silently change costs and takeoff derivation.
    await expect(
      as.mutation(api.precision.copyActivitiesToPhase, {
        sourcePhaseId: sourceId,
        targetPhaseId: otherPhaseId,
      })
    ).rejects.toThrow("different dataset versions");
  });

  it("allows copying to another proposal on the same catalog version", async () => {
    const { t, as, sourceId } = await seedTwoPhases();
    const other = await seedProposal(t, {
      proposalNumber: "2082",
      rates: RATES_2020,
      wbs: [{ poolId: 70000, phases: [{ phaseNumber: 9 }] }],
    });
    const otherPhaseId = must(other.phaseByNumber.get("70000:9"), "other phase");

    const inserted = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: sourceId,
      targetPhaseId: otherPhaseId,
    });

    expect(inserted).toHaveLength(3);
    const copied = await t.run(async (ctx) => ctx.db.get(inserted[0]!));
    expect(copied?.proposalId).toBe(other.proposalId);
  });

  it("refuses copying a phase onto itself", async () => {
    const { as, sourceId } = await seedTwoPhases();
    await expect(
      as.mutation(api.precision.copyActivitiesToPhase, {
        sourcePhaseId: sourceId,
        targetPhaseId: sourceId,
      })
    ).rejects.toThrow("must differ");
  });

  it("derives wbsId from the TARGET and keeps the takeoff flag", async () => {
    const { t, as, sourceId, crossWbsTargetId, activityIds } = await seedTwoPhases();
    await t.run(async (ctx) => ctx.db.patch(activityIds[1]!, { countsTowardTakeoff: true }));

    await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: sourceId,
      targetPhaseId: crossWbsTargetId,
      activityIds: [activityIds[1]!],
    });

    const copied = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("activities")
        .withIndex("by_phase_sort", (q) => q.eq("phaseId", crossWbsTargetId))
        .collect();
      return rows[0];
    });
    const targetPhase = await t.run(async (ctx) => ctx.db.get(crossWbsTargetId));

    // The legacy bug: copies carried the SOURCE's wbsId. Ours must not.
    expect(copied?.wbsId).toBe(targetPhase?.wbsId);
    expect(copied?.countsTowardTakeoff).toBe(true);
    expect(copied?.quantity).toBe(20);
  });
});
