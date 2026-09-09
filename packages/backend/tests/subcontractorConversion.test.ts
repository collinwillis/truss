/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Converting a subcontractor line to the one number the sub quoted.
 *
 * The three legacy buckets were never a breakdown — 411 of 414 live lines fill
 * exactly ONE — so a line entered now carries a single `cost`. The migration
 * converts the lines where that costs nothing and refuses the rest.
 *
 * ⚠️ WHAT THESE ACTUALLY GUARD IS THE MONEY. Every one of these rows sits on a
 * construction bid, most of them already submitted. The property worth proving
 * is not "the field moved" but "the price did not": a converted line has to
 * compute to the same figure it computed to before, to the last bit, or the
 * migration is a repricing wearing a migration's clothes.
 *
 * The mixed-bucket line is here for the opposite reason. It CANNOT convert
 * without moving — one taxed leg beside two untaxed ones has no single-cost
 * equivalent — so the test pins that the migration leaves it alone rather than
 * rounding the problem away.
 */
import { describe, expect, it } from "vitest";
import { internal } from "../convex/_generated/api";
import { computeActivityCosts } from "../convex/model/costEngine";
import { ownerHarness } from "./authFixtures";
import { seedProposal } from "./convexFixtures";
import { RATES_2020 } from "./rates";

/** The price a line computes to, through the engine the app actually uses. */
function priceOf(sub: {
  laborCost: number;
  materialCost: number;
  equipmentCost: number;
  cost?: number;
  addSalesTax?: boolean;
}): number {
  return computeActivityCosts(
    { type: "subcontractor", quantity: 12, labor: null, subcontractor: sub },
    RATES_2020
  ).subcontractorCost;
}

describe("convertSubcontractorLines", () => {
  it("converts a single-bucket line without moving its price", async () => {
    const { t } = await ownerHarness();
    await seedProposal(t, {
      proposalNumber: "2049",
      rates: RATES_2020,
      wbs: [
        {
          poolId: 70000,
          name: "AG PIPING",
          phases: [
            {
              phaseNumber: 1,
              activities: [
                // Labor-only: untaxed under both rules.
                {
                  type: "subcontractor",
                  quantity: 12,
                  description: "WELD INSPECTION",
                  subcontractor: { laborCost: 137.5, materialCost: 0, equipmentCost: 0 },
                },
                // Material-only: the taxed leg, so the flag must come out true.
                {
                  type: "subcontractor",
                  quantity: 12,
                  description: "GASKET SUPPLY",
                  subcontractor: { laborCost: 0, materialCost: 137.5, equipmentCost: 0 },
                },
              ],
            },
          ],
        },
      ],
    });

    const before = await t.run(async (ctx) => {
      const rows = await ctx.db.query("activities").collect();
      return rows
        .filter((r) => r.type === "subcontractor")
        .map((r) => ({ description: r.description, price: priceOf(r.subcontractor!) }));
    });

    await t.mutation(internal.precision.convertSubcontractorLines, { dryRun: false });

    const after = await t.run(async (ctx) => {
      const rows = await ctx.db.query("activities").collect();
      return rows
        .filter((r) => r.type === "subcontractor")
        .map((r) => ({
          description: r.description,
          price: priceOf(r.subcontractor!),
          cost: r.subcontractor?.cost,
          addSalesTax: r.subcontractor?.addSalesTax,
        }));
    });

    const labor = after.find((r) => r.description === "WELD INSPECTION");
    const material = after.find((r) => r.description === "GASKET SUPPLY");

    // Converted, and carrying the tax decision the old bucket implied.
    expect(labor?.cost).toBe(137.5);
    expect(labor?.addSalesTax).toBe(false);
    expect(material?.cost).toBe(137.5);
    expect(material?.addSalesTax).toBe(true);

    // ⚠️ The point of the whole exercise: identical, not merely close.
    for (const row of before) {
      const now = after.find((r) => r.description === row.description);
      expect(now?.price).toBe(row.price);
    }
  });

  it("leaves a line that mixed buckets exactly as it was", async () => {
    const { t } = await ownerHarness();
    await seedProposal(t, {
      proposalNumber: "2050",
      rates: RATES_2020,
      wbs: [
        {
          poolId: 70000,
          name: "AG PIPING",
          phases: [
            {
              phaseNumber: 1,
              activities: [
                {
                  type: "subcontractor",
                  quantity: 12,
                  description: "PAINT — LABOR AND MATERIAL",
                  subcontractor: { laborCost: 100, materialCost: 50, equipmentCost: 0 },
                },
              ],
            },
          ],
        },
      ],
    });

    await t.mutation(internal.precision.convertSubcontractorLines, { dryRun: false });

    const row = await t.run(async (ctx) => {
      const rows = await ctx.db.query("activities").collect();
      return rows.find((r) => r.type === "subcontractor");
    });

    // No `cost`, so `costEngine` keeps pricing it the old way — which is the
    // only thing that keeps its bid worth what it was bid at.
    expect(row?.subcontractor?.cost).toBeUndefined();
    expect(row?.subcontractor?.laborCost).toBe(100);
    expect(row?.subcontractor?.materialCost).toBe(50);
  });

  it("writes nothing on a dry run, and is a no-op the second time", async () => {
    const { t } = await ownerHarness();
    await seedProposal(t, {
      proposalNumber: "2051",
      rates: RATES_2020,
      wbs: [
        {
          poolId: 70000,
          name: "AG PIPING",
          phases: [
            {
              phaseNumber: 1,
              activities: [
                {
                  type: "subcontractor",
                  quantity: 12,
                  description: "WELD INSPECTION",
                  subcontractor: { laborCost: 137.5, materialCost: 0, equipmentCost: 0 },
                },
              ],
            },
          ],
        },
      ],
    });

    const dry = await t.mutation(internal.precision.convertSubcontractorLines, { dryRun: true });
    expect(dry.converted).toBe(1);

    // Asked as a boolean: Convex serialises `undefined` to `null` on the way
    // out of `t.run`, so a `toBeUndefined()` here would fail for a reason that
    // has nothing to do with the migration.
    const converted = await t.run(async (ctx) => {
      const rows = await ctx.db.query("activities").collect();
      return rows.some((r) => r.type === "subcontractor" && r.subcontractor?.cost !== undefined);
    });
    expect(converted).toBe(false);

    await t.mutation(internal.precision.convertSubcontractorLines, { dryRun: false });
    // A second run must find nothing left to do, so an interrupted chain can
    // simply be started again.
    const second = await t.mutation(internal.precision.convertSubcontractorLines, {
      dryRun: false,
    });
    expect(second.converted).toBe(0);
    expect(second.alreadyConverted).toBe(1);
  });
});
