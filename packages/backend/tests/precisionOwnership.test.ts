/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * D1 — detach-on-edit. These are the tests that make the guarantee real rather
 * than asserted.
 *
 * The Firestore sync is a one-way mirror that patched blindly, so a 6-hourly
 * cron reverted proposal metadata and all 15 rates, and creating a Momentum
 * project reverted the whole tree. Edits vanished with no error.
 *
 * Two failure directions matter equally, and the tests are organised around
 * them:
 *  - UNDER-CLAIMING lets the mirror eat a real edit. That is the original bug.
 *  - OVER-CLAIMING detaches an estimate nobody meaningfully edited, silently
 *    cutting it off from every future estimator update. Just as damaging, and
 *    much harder to notice.
 *
 * @see docs/precision/DECISIONS.md D1
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedProposal, laborActivity } from "./convexFixtures";
import { RATES_2020, RATES_2069 } from "./rates";

const modules = import.meta.glob("../convex/**/*.*s");

/** A proposal as the sync would have imported it: mirrored, with a firestoreId. */
async function seedMirroredProposal(t: ReturnType<typeof convexTest>) {
  const { proposalId, wbsByCode, phaseByNumber } = await seedProposal(t, {
    proposalNumber: "2020",
    rates: RATES_2020,
    wbs: [{ poolId: 70000, phases: [{ phaseNumber: 1, activities: [laborActivity(10)] }] }],
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(proposalId, { firestoreId: "fs-2020" });
  });
  return { proposalId, wbsByCode, phaseByNumber };
}

/** What the 6-hourly cron would push for that proposal. */
function mirrorPayload() {
  return {
    firestoreId: "fs-2020",
    proposalNumber: "2020",
    description: "LEGACY DESCRIPTION",
    ownerName: "Legacy Owner",
    rates: { ...RATES_2069 },
    datasetVersion: "v1" as const,
  };
}

/**
 * The ownership stamp, normalised to `null` when absent.
 *
 * `t.run` passes its return value through Convex's serializer, which turns
 * `undefined` into `null` — so normalise explicitly here rather than letting a
 * test assert on which of the two it happens to see.
 */
async function ownership(
  t: ReturnType<typeof convexTest>,
  proposalId: string
): Promise<number | null> {
  return await t.run(async (ctx) => {
    const p = await ctx.db.get(proposalId as never);
    return (p as { precisionOwnedAt?: number } | null)?.precisionOwnedAt ?? null;
  });
}

describe("the mirror reverts an unowned estimate (the behaviour being guarded)", () => {
  it("overwrites metadata and rates when Precision has never written", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [mirrorPayload()],
    });

    const after = await t.query(api.precision.getProposal, { proposalId });
    // This is not a bug — it is the mirror doing its job on an estimate nobody
    // has claimed. It is also exactly what must STOP happening after an edit.
    expect(after.description).toBe("LEGACY DESCRIPTION");
    expect(after.rates.craftBaseRate).toBe(RATES_2069.craftBaseRate);
  });
});

describe("a real edit survives the mirror", () => {
  it("rate edits are not reverted by the 6-hourly cron", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    const edited = { ...RATES_2020, craftBaseRate: 99.5 };
    await t.mutation(api.precision.updateProposalRates, { proposalId, rates: edited });
    expect(await ownership(t, proposalId)).toBeTypeOf("number");

    await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [mirrorPayload()],
    });

    const after = await t.query(api.precision.getProposal, { proposalId });
    expect(after.rates.craftBaseRate).toBe(99.5);
    expect(after.isPrecisionOwned).toBe(true);
  });

  it("metadata edits are not reverted either", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    await t.mutation(api.precision.updateProposal, {
      proposalId,
      description: "EDITED IN PRECISION",
    });

    await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [mirrorPayload()],
    });

    const after = await t.query(api.precision.getProposal, { proposalId });
    expect(after.description).toBe("EDITED IN PRECISION");
  });

  it("an activity edit protects the whole tree, not just that activity", async () => {
    // The claim lives on the proposal, so touching any descendant detaches the
    // entire estimate. That is intended: the tree is one estimate, and partial
    // mirroring is what produced the four-surfaces-disagree class of bug.
    const t = convexTest(schema, modules);
    const { proposalId, phaseByNumber } = await seedMirroredProposal(t);
    const phaseId = phaseByNumber.get("70000:1");
    if (!phaseId) throw new Error("fixture did not seed phase 70000:1");

    await t.mutation(api.precision.addActivity, {
      phaseId,
      type: "labor",
      description: "ADDED IN PRECISION",
      quantity: 5,
      unit: "EA",
      labor: { craftConstant: 1, welderConstant: 0 },
    });

    expect(await ownership(t, proposalId)).toBeTypeOf("number");

    await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [mirrorPayload()],
    });

    const after = await t.query(api.precision.getProposal, { proposalId });
    expect(after.rates.craftBaseRate).toBe(RATES_2020.craftBaseRate);
    expect(after.description).not.toBe("LEGACY DESCRIPTION");
  });

  it("the tree sync also refuses an owned estimate", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    await t.mutation(api.precision.updateProposal, { proposalId, description: "MINE" });

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal: mirrorPayload(),
      wbsList: [
        {
          firestoreId: "w-1",
          fsProposalId: "fs-2020",
          wbsPoolId: 10000,
          name: "MOBILIZE",
          sortOrder: 1,
        },
      ],
      phasesList: [],
      activitiesList: [],
    });

    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);

    // The WBS from the payload must not have landed.
    const wbsCount = await t.run(async (ctx) => (await ctx.db.query("wbs").collect()).length);
    expect(wbsCount).toBe(1); // only the fixture's own WBS 70000
  });
});

describe("over-claiming is prevented", () => {
  it("resending identical rates does not detach the estimate", async () => {
    // RatesGrid debounce-writes on every keystroke, and `parseFloat(raw) || 0`
    // means retyping the same number produces an identical payload. If that
    // claimed, opening the rates screen would cut the estimate off from the
    // mirror forever.
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    await t.mutation(api.precision.updateProposalRates, {
      proposalId,
      rates: { ...RATES_2020 },
    });

    expect(await ownership(t, proposalId)).toBeNull();

    const after = await t.query(api.precision.getProposal, { proposalId });
    expect(after.isPrecisionOwned).toBe(false);
  });

  it("resending an identical description does not detach the estimate", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);
    const before = await t.query(api.precision.getProposal, { proposalId });

    await t.mutation(api.precision.updateProposal, {
      proposalId,
      description: before.description,
      ownerName: before.ownerName,
    });

    expect(await ownership(t, proposalId)).toBeNull();
  });

  it("a mutation that throws leaves the estimate attached", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    // A duplicate WBS code is rejected, and the rejection must not detach.
    await expect(
      t.mutation(api.precision.addWBS, { proposalId, wbsPoolId: 70000, name: "AG PIPING" })
    ).rejects.toThrow();

    expect(await ownership(t, proposalId)).toBeNull();
  });

  it("reading an estimate never detaches it", async () => {
    const t = convexTest(schema, modules);
    const { proposalId, wbsByCode } = await seedMirroredProposal(t);
    const wbsId = wbsByCode.get(70000);
    if (!wbsId) throw new Error("fixture did not seed WBS 70000");

    await t.query(api.precision.getProposal, { proposalId });
    await t.query(api.precision.getWBSListWithCosts, { proposalId });
    await t.query(api.precision.getPhaseListWithCosts, { wbsId });
    await t.query(api.precision.getProposalSummary, { proposalId });
    await t.query(api.precision.getExportData, { proposalId });

    expect(await ownership(t, proposalId)).toBeNull();
  });
});

describe("ownership semantics", () => {
  it("the stamp is not moved by a second edit", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    await t.mutation(api.precision.updateProposal, { proposalId, description: "FIRST" });
    const first = await ownership(t, proposalId);

    await t.mutation(api.precision.updateProposal, { proposalId, description: "SECOND" });
    const second = await ownership(t, proposalId);

    // The field records WHEN the estimate forked, so it must not drift forward
    // on every subsequent write.
    expect(second).toBe(first);
  });

  it("a natively-created estimate is owned at birth and carries no firestoreId", async () => {
    // Otherwise it reports "mirroring from MCP Estimator" until something edits
    // it — and a copied firestoreId would let the mirror overwrite it outright.
    const t = convexTest(schema, modules);

    const proposalId = await t.mutation(api.precision.createProposal, {
      proposalNumber: "9001",
      description: "NATIVE ESTIMATE",
      ownerName: "InDemand",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });

    const created = await t.query(api.precision.getProposal, { proposalId });
    expect(created.isPrecisionOwned).toBe(true);
    expect(created.firestoreId).toBeUndefined();
  });

  it("a duplicate is owned at birth and does not inherit the source's firestoreId", async () => {
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);

    const copyId = await t.mutation(api.precision.duplicateProposal, {
      sourceProposalId: proposalId,
      newProposalNumber: "2020.01",
    });

    const copy = await t.query(api.precision.getProposal, { proposalId: copyId });
    expect(copy.isPrecisionOwned).toBe(true);
    expect(copy.firestoreId).toBeUndefined();

    // Duplicating is a read of the source, so the source stays attached.
    expect(await ownership(t, proposalId)).toBeNull();
  });

  it("skips per-proposal rather than aborting the whole batch", async () => {
    // One owned estimate must not stop the other ~622 from staying current.
    const t = convexTest(schema, modules);
    const { proposalId } = await seedMirroredProposal(t);
    await t.mutation(api.precision.updateProposal, { proposalId, description: "MINE" });

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [
        mirrorPayload(),
        {
          firestoreId: "fs-3000",
          proposalNumber: "3000",
          description: "A DIFFERENT ESTIMATE",
          ownerName: "Legacy Owner",
          rates: { ...RATES_2069 },
          datasetVersion: "v1" as const,
        },
      ],
    });

    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(1);

    const mine = await t.query(api.precision.getProposal, { proposalId });
    expect(mine.description).toBe("MINE");
  });

  it("still inserts a proposal the mirror has never seen", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(internal.sync.syncMutations.upsertProposalsBatch, {
      proposals: [mirrorPayload()],
    });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
