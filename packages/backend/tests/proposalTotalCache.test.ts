/**
 * The cached grand total.
 *
 * The log needs a total for every one of 731 rows at once, which cannot be
 * summed on read — so it is maintained on write, and the whole design rests
 * on one claim: the cached figure equals what the estimate screen computes,
 * always. A cached total that drifts is worse than no total, because it is
 * indistinguishable from a correct one.
 *
 * So every test here asserts the cache against `getProposalSummary` rather
 * than against a hardcoded number: if the two ever disagree, that is the
 * failure, whichever of them is wrong.
 */
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { laborActivity, seedProposal } from "./convexFixtures";
import { RATES_2020 } from "./rates";

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`fixture missing ${label}`);
  return value;
}

async function seedEstimate() {
  const { t, as } = await ownerHarness();
  const tree = await seedProposal(t, {
    proposalNumber: "2100",
    rates: RATES_2020,
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [
          {
            phaseNumber: 1,
            activities: [
              laborActivity(10),
              laborActivity(20),
              { type: "material", quantity: 5, unitPrice: 100 },
            ],
          },
        ],
      },
    ],
  });
  return { t, as, tree, phaseId: must(tree.phaseByNumber.get("70000:1"), "phase 1") };
}

describe("the cached total", () => {
  it("equals what the estimate screen computes", async () => {
    const { t, as, tree } = await seedEstimate();

    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });

    const summary = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });
    const listed = await as.query(api.precision.listProposals, {});
    const row = must(
      listed.find((p) => p._id === tree.proposalId),
      "proposal row"
    );

    expect(row.amount).toBe(summary.totalCost);
    expect(row.amount).toBeGreaterThan(0);
  });

  it("is null before anything has rolled it up", async () => {
    const { as, tree } = await seedEstimate();
    const listed = await as.query(api.precision.listProposals, {});
    const row = must(
      listed.find((p) => p._id === tree.proposalId),
      "proposal row"
    );
    // Not zero — "not computed" and "costs nothing" are different statements,
    // and showing $0 for the first would be the lie this design exists to
    // avoid.
    expect(row.amount).toBeNull();
  });

  it("follows an edited quantity", async () => {
    const { t, as, tree } = await seedEstimate();
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });
    const before = must(
      (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
      "row"
    ).amount;

    await as.mutation(api.precision.updateActivity, {
      activityId: must(tree.activityIds[0], "first activity"),
      quantity: 999,
    });
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });

    const summary = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });
    const after = must(
      (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
      "row"
    ).amount;

    expect(after).not.toBe(before);
    expect(after).toBe(summary.totalCost);
  });

  it("follows a rate change, which re-prices every line at once", async () => {
    const { t, as, tree } = await seedEstimate();
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });
    const before = must(
      (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
      "row"
    ).amount;

    await as.mutation(api.precision.updateProposalRates, {
      proposalId: tree.proposalId,
      rates: { ...RATES_2020, craftBaseRate: RATES_2020.craftBaseRate * 2 },
    });
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });

    const summary = await as.query(api.precision.getProposalSummary, {
      proposalId: tree.proposalId,
    });
    const after = must(
      (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
      "row"
    ).amount;

    expect(after).toBeGreaterThan(must(before ?? undefined, "before"));
    expect(after).toBe(summary.totalCost);
  });

  it("follows deleted lines back down", async () => {
    const { t, as, tree } = await seedEstimate();

    await as.mutation(api.precision.batchDeleteActivities, { activityIds: tree.activityIds });
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });

    const row = must(
      (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
      "row"
    );
    // An estimate stripped of every line really does cost nothing, and here
    // zero is the honest answer rather than a missing one.
    expect(row.amount).toBe(0);
  });

  /**
   * The tests above call the rollup directly, which proves the ARITHMETIC.
   * This one proves the WIRING: an edit alone, with nothing invoked by hand,
   * must leave the total correct once the debounce elapses. Without it the
   * whole design could be right and simply never fire.
   */
  it("updates from an edit alone, once the debounce elapses", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, tree } = await seedEstimate();

      await as.mutation(api.precision.updateActivity, {
        activityId: must(tree.activityIds[0], "first activity"),
        quantity: 42,
      });

      // Nothing has run yet — the rollup is queued, not immediate.
      const queued = must(
        (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
        "row"
      );
      expect(queued.amount).toBeNull();

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const summary = await as.query(api.precision.getProposalSummary, {
        proposalId: tree.proposalId,
      });
      const settled = must(
        (await as.query(api.precision.listProposals, {})).find((p) => p._id === tree.proposalId),
        "row"
      );
      expect(settled.amount).toBe(summary.totalCost);
      expect(settled.amount).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a duplicated estimate its own total", async () => {
    const { t, as, tree } = await seedEstimate();

    const copyId = await as.mutation(api.precision.duplicateProposal, {
      sourceProposalId: tree.proposalId,
      newProposalNumber: "2100.01",
    });
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: copyId });
    await t.mutation(internal.precision.recomputeProposalTotal, { proposalId: tree.proposalId });

    const listed = await as.query(api.precision.listProposals, {});
    const original = must(
      listed.find((p) => p._id === tree.proposalId),
      "original"
    );
    const copy = must(
      listed.find((p) => p._id === copyId),
      "copy"
    );
    expect(copy.amount).toBe(original.amount);
    expect(copy.amount).toBeGreaterThan(0);
  });
});
