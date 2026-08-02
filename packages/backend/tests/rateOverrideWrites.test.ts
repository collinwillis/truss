/**
 * M4 write path for per-activity rate overrides.
 *
 * D3's three distinct meanings, pinned end to end: ABSENT inherits the
 * proposal's rate, `0` is a real $0.00/hr override, and `null` CLEARS back to
 * inheritance. `v.optional(v.number())` could express only two of the three,
 * which is why the validator is a union — and why the stored document is
 * normalized so "inherits" has exactly one spelling.
 *
 * D6 eligibility is enforced on BOTH write paths: legacy checked it in React
 * twice and on the server never.
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

/** SUPPORT (200000) is override-eligible; AG PIPING (70000) is not. */
async function seedEligibleAndNot() {
  const { t, as } = await ownerHarness();
  const tree = await seedProposal(t, {
    proposalNumber: "2090",
    rates: RATES_2020,
    wbs: [
      {
        poolId: 200000,
        name: "SUPPORT",
        phases: [{ phaseNumber: 1, activities: [laborActivity(8)] }],
      },
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [{ phaseNumber: 2, activities: [laborActivity(8)] }],
      },
    ],
  });
  return {
    t,
    as,
    eligibleId: must(tree.activityIds[0], "support activity"),
    ineligibleId: must(tree.activityIds[1], "piping activity"),
    eligiblePhaseId: must(tree.phaseByNumber.get("200000:1"), "support phase"),
    ineligiblePhaseId: must(tree.phaseByNumber.get("70000:2"), "piping phase"),
  };
}

const LABOR = { craftConstant: 0.55, welderConstant: 0 };

describe("rate override writes (D3 × D6)", () => {
  it("sets an override, and 0 is a real $0.00/hr — not an inherit", async () => {
    const { t, as, eligibleId } = await seedEligibleAndNot();

    await as.mutation(api.precision.updateActivity, {
      activityId: eligibleId,
      labor: { ...LABOR, customCraftRate: 0 },
    });

    const stored = await t.run(async (ctx) => ctx.db.get(eligibleId));
    expect(stored?.labor?.customCraftRate).toBe(0);
  });

  it("null CLEARS the override, and never lands in the document", async () => {
    const { t, as, eligibleId } = await seedEligibleAndNot();

    await as.mutation(api.precision.updateActivity, {
      activityId: eligibleId,
      labor: { ...LABOR, customCraftRate: 52.5, customSubsistenceRate: 12 },
    });
    expect((await t.run(async (ctx) => ctx.db.get(eligibleId)))?.labor?.customCraftRate).toBe(52.5);

    await as.mutation(api.precision.updateActivity, {
      activityId: eligibleId,
      labor: { ...LABOR, customCraftRate: null, customSubsistenceRate: 12 },
    });

    const stored = await t.run(async (ctx) => ctx.db.get(eligibleId));
    // Absent, not null — one spelling of "inherits" in the data.
    expect(stored?.labor?.customCraftRate).toBeUndefined();
    expect("customCraftRate" in (stored?.labor ?? {})).toBe(false);
    expect(stored?.labor?.customSubsistenceRate).toBe(12);
  });

  it("re-prices the line: an override moves craft cost, clearing restores it", async () => {
    const { as, eligibleId, eligiblePhaseId } = await seedEligibleAndNot();

    const before = await as.query(api.precision.getActivitiesWithCosts, {
      phaseId: eligiblePhaseId,
    });
    const baseCost = must(before[0], "row").costs.craftCost;

    await as.mutation(api.precision.updateActivity, {
      activityId: eligibleId,
      labor: { ...LABOR, customCraftRate: RATES_2020.craftBaseRate * 2 },
    });
    const overridden = await as.query(api.precision.getActivitiesWithCosts, {
      phaseId: eligiblePhaseId,
    });
    expect(must(overridden[0], "row").costs.craftCost).toBeGreaterThan(baseCost);

    await as.mutation(api.precision.updateActivity, {
      activityId: eligibleId,
      labor: { ...LABOR, customCraftRate: null },
    });
    const restored = await as.query(api.precision.getActivitiesWithCosts, {
      phaseId: eligiblePhaseId,
    });
    expect(must(restored[0], "row").costs.craftCost).toBe(baseCost);
  });

  it("refuses an override on an ineligible line (D6), on update", async () => {
    const { as, ineligibleId } = await seedEligibleAndNot();

    await expect(
      as.mutation(api.precision.updateActivity, {
        activityId: ineligibleId,
        labor: { ...LABOR, customCraftRate: 52.5 },
      })
    ).rejects.toThrow("only allowed on custom labor lines");
  });

  it("refuses an override on an ineligible line at CREATION too", async () => {
    const { as, ineligiblePhaseId } = await seedEligibleAndNot();

    await expect(
      as.mutation(api.precision.addActivity, {
        phaseId: ineligiblePhaseId,
        type: "labor",
        description: "SNUCK IN THROUGH THE CREATE PATH",
        quantity: 1,
        unit: "EA",
        labor: { ...LABOR, customCraftRate: 52.5 },
      })
    ).rejects.toThrow("only allowed on custom labor lines");
  });

  it("allows CLEARING on an ineligible line — removing an illegal value is not setting one", async () => {
    const { t, as, ineligibleId } = await seedEligibleAndNot();
    // A value that predates the rule (or arrived by sync) must be removable.
    await t.run(async (ctx) =>
      ctx.db.patch(ineligibleId, {
        labor: { ...LABOR, customCraftRate: 99, customSubsistenceRate: 12 },
      })
    );

    // Clearing ONE while the other rides along untouched: judging the payload
    // alone would read the passenger as "setting" and refuse the removal.
    await as.mutation(api.precision.updateActivity, {
      activityId: ineligibleId,
      labor: { ...LABOR, customCraftRate: null, customSubsistenceRate: 12 },
    });

    const stored = await t.run(async (ctx) => ctx.db.get(ineligibleId));
    expect(stored?.labor?.customCraftRate).toBeUndefined();
    expect(stored?.labor?.customSubsistenceRate).toBe(12);
  });

  it("strips an override when a copy lands where D6 forbids it", async () => {
    const { t, as, eligibleId, eligiblePhaseId, ineligiblePhaseId } = await seedEligibleAndNot();
    await as.mutation(api.precision.updateActivity, {
      activityId: eligibleId,
      labor: { ...LABOR, customCraftRate: 99 },
    });

    // SUPPORT → AG PIPING: legal where it started, illegal where it lands —
    // and invisible there, since the grid hides the columns.
    const [copiedId] = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: eligiblePhaseId,
      targetPhaseId: ineligiblePhaseId,
    });

    const copied = await t.run(async (ctx) => ctx.db.get(copiedId!));
    expect(copied?.labor?.customCraftRate).toBeUndefined();
    expect(copied?.labor?.craftConstant).toBe(LABOR.craftConstant);
  });

  it("keeps the override when the copied line is custom_labor — eligible anywhere", async () => {
    const { t, as, eligiblePhaseId, ineligiblePhaseId } = await seedEligibleAndNot();
    const customId = await as.mutation(api.precision.addActivity, {
      phaseId: eligiblePhaseId,
      type: "custom_labor",
      description: "SUPERVISION",
      quantity: 1,
      unit: "HR",
      labor: { ...LABOR, customCraftRate: 75 },
    });

    const inserted = await as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: eligiblePhaseId,
      targetPhaseId: ineligiblePhaseId,
      activityIds: [customId],
    });

    const copied = await t.run(async (ctx) => ctx.db.get(inserted[0]!));
    expect(copied?.labor?.customCraftRate).toBe(75);
  });

  it("custom_labor is eligible anywhere, including under ineligible WBS", async () => {
    const { as, ineligiblePhaseId } = await seedEligibleAndNot();

    const id = await as.mutation(api.precision.addActivity, {
      phaseId: ineligiblePhaseId,
      type: "custom_labor",
      description: "SUPERVISION",
      quantity: 1,
      unit: "HR",
      labor: { ...LABOR, customCraftRate: 75 },
    });

    expect(id).toBeDefined();
  });
});
