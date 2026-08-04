/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * D-takeoff — phase takeoff quantities: catalog-flag derived, always
 * overridable, dash when the phase type has no takeoff.
 *
 * The scenario that motivates every assertion here is the CONCRETE
 * double-count measured on production proposal 2020: a foundation phase's
 * pour and clean-up lines both carry CY, so summing by unit reported
 * 2,462 CY where the real takeoff was 86. Only the flagged line counts.
 *
 * The override slot is legacy's `customQuantity` (synced from Firestore,
 * populated on ~10% of production phases), with D3 semantics: absent =
 * derived, any present value including 0 = override, `null` in the mutation
 * arg clears it.
 *
 * @see docs/precision/DECISIONS.md D-takeoff
 */

import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";
import { ensureTestBook, seedProposal, type TestRunner } from "./convexFixtures";

/** Catalog rows for one concrete-like phase pool: one flagged line of four. */
async function seedCatalog(t: TestRunner) {
  await t.run(async (ctx) => {
    const bookId = await ensureTestBook(ctx);
    await ctx.db.insert("phasePool", {
      datasetVersion: "v1",
      bookId,
      poolId: 30001,
      wbsPoolId: 30000,
      name: "EQUIPMENT FOUNDATIONS (≤3 CY)",
      sortOrder: 1,
      isCustom: false,
      isActive: true,
      takeoffUnit: "CY",
    });
    // A no-takeoff phase type (MOBILIZE-style): no takeoffUnit at all.
    await ctx.db.insert("phasePool", {
      datasetVersion: "v1",
      bookId,
      poolId: 10001,
      wbsPoolId: 10000,
      name: "EQUIPMENT SETUP",
      sortOrder: 1,
      isCustom: false,
      isActive: true,
    });
    const item = (poolId: number, description: string, flagged: boolean) =>
      ctx.db.insert("laborPool", {
        datasetVersion: "v1",
        bookId,
        poolId,
        phasePoolId: 30001,
        description,
        sortOrder: poolId,
        craftConstant: 1,
        craftUnits: "CY",
        weldConstant: 0,
        weldUnits: "",
        isCustom: false,
        isActive: true,
        ...(flagged ? { countsTowardTakeoff: true } : {}),
      });
    await item(101, "FORMWORK - FOOTER", false);
    await item(102, "POUR CONCRETE", false);
    await item(103, "FINISH", false);
    await item(104, "CLEAN UP", true);
  });
}

/**
 * The production shape: pour and clean-up both in CY. Sum-by-unit would say
 * 8 CY; the takeoff is the flagged clean-up line's 4.
 */
async function seedConcretePhase(t: TestRunner) {
  const { proposalId, wbsByCode, phaseByNumber } = await seedProposal(t, {
    proposalNumber: "2020",
    wbs: [
      {
        poolId: 30000,
        name: "CONCRETE",
        phases: [
          {
            phaseNumber: 1,
            phasePoolId: 30001,
            description: "TK 9 PUMP PAD",
            activities: [
              { type: "labor", quantity: 4, unit: "CY", description: "POUR", laborPoolId: 102 },
              { type: "labor", quantity: 4, unit: "CY", description: "CLEAN UP", laborPoolId: 104 },
              { type: "labor", quantity: 155, unit: "SF", description: "FORM", laborPoolId: 101 },
            ],
          },
        ],
      },
    ],
  });
  const wbsId = wbsByCode.get(30000);
  const phaseId = phaseByNumber.get("30000:1");
  if (!wbsId || !phaseId) throw new Error("fixture did not seed the concrete tree");
  return { proposalId, wbsId, phaseId };
}

describe("derived takeoff sums only flagged lines", () => {
  it("does not double-count same-unit lines (the CONCRETE case)", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsId } = await seedConcretePhase(t);

    const rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows).toHaveLength(1);
    // 4 (CLEAN UP, flagged) — not 8 (POUR + CLEAN UP by unit).
    expect(rows[0]!.takeoff).toEqual({ quantity: 4, unit: "CY", isOverridden: false });
  });

  it("a custom line with an explicit flag counts; explicit false excludes a catalog line", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsId, phaseId } = await seedConcretePhase(t);

    await as.mutation(api.precision.addActivity, {
      phaseId,
      type: "custom_labor",
      description: "EXTRA POUR, EAST HALF",
      quantity: 2,
      unit: "CY",
      labor: { craftConstant: 1, welderConstant: 0 },
    });
    // The custom line has no catalog item; flag it explicitly.
    const rowsBefore = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rowsBefore[0]!.takeoff!.quantity).toBe(4);

    await t.run(async (ctx) => {
      const acts = await ctx.db.query("activities").collect();
      const custom = acts.find((a) => a.description === "EXTRA POUR, EAST HALF");
      const cleanUp = acts.find((a) => a.description === "CLEAN UP");
      if (!custom || !cleanUp) throw new Error("fixture rows missing");
      await ctx.db.patch(custom._id, { countsTowardTakeoff: true });
      // Explicit false beats the catalog's true.
      await ctx.db.patch(cleanUp._id, { countsTowardTakeoff: false });
    });

    const rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 2, unit: "CY", isOverridden: false });
  });

  it("a phase type with no takeoff unit shows a dash (null)", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsByCode } = await seedProposal(t, {
      proposalNumber: "2021",
      wbs: [
        {
          poolId: 10000,
          name: "MOBILIZE",
          phases: [
            {
              phaseNumber: 1,
              phasePoolId: 10001,
              activities: [{ type: "labor", quantity: 3, unit: "EA" }],
            },
          ],
        },
      ],
    });
    const wbsId = wbsByCode.get(10000);
    if (!wbsId) throw new Error("fixture did not seed WBS 10000");

    const rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toBeNull();
  });
});

describe("the override (D3 semantics on customQuantity)", () => {
  it("a set override wins over the derived sum, and 0 is a real override", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsId, phaseId } = await seedConcretePhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, takeoffQuantity: 86 });
    let rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 86, unit: "CY", isOverridden: true });

    await as.mutation(api.precision.updatePhase, { phaseId, takeoffQuantity: 0 });
    rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 0, unit: "CY", isOverridden: true });
  });

  it("null clears the override, returning to the derived sum", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsId, phaseId } = await seedConcretePhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, takeoffQuantity: 86 });
    await as.mutation(api.precision.updatePhase, { phaseId, takeoffQuantity: null });

    const rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 4, unit: "CY", isOverridden: false });

    const stored = await t.run(async (ctx) => (await ctx.db.get(phaseId))?.customQuantity);
    expect(stored ?? null).toBeNull();
  });

  it("a legacy override (synced customQuantity) is honoured even without a takeoff unit", async () => {
    // 299 production phases already carry customQuantity from Firestore,
    // including pools with no takeoff rule (e.g. WELDER TEST / QUALIFICATION).
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsByCode, phaseByNumber } = await seedProposal(t, {
      proposalNumber: "2022",
      wbs: [
        {
          poolId: 10000,
          phases: [{ phaseNumber: 1, phasePoolId: 10001, activities: [] }],
        },
      ],
    });
    const wbsId = wbsByCode.get(10000);
    const phaseId = phaseByNumber.get("10000:1");
    if (!wbsId || !phaseId) throw new Error("fixture did not seed the tree");
    await t.run(async (ctx) => {
      await ctx.db.patch(phaseId, { customQuantity: 1 });
    });

    const rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 1, unit: "", isOverridden: true });
  });
});

describe("the export uses the same computation as the screen", () => {
  it("exports the identical takeoff for the concrete phase", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { proposalId } = await seedConcretePhase(t);

    const data = await as.query(api.precision.getExportData, { proposalId });
    const phase = data.wbs[0]!.phases[0]!;
    expect(phase.takeoff).toEqual({ quantity: 4, unit: "CY", isOverridden: false });
  });
});

describe("the catalog seed", () => {
  it("flags exactly the matching items and reports zero-match rules", async () => {
    const { t } = await ownerHarness();
    // Seed catalog rows for two ruled pools: 30001 (CLEAN UP) and 70001 (HE).
    await t.run(async (ctx) => {
      const bookId = await ensureTestBook(ctx);
      await ctx.db.insert("phasePool", {
        datasetVersion: "v1",
        bookId,
        poolId: 30001,
        wbsPoolId: 30000,
        name: "EQUIPMENT FOUNDATIONS (≤3 CY)",
        sortOrder: 1,
        isCustom: false,
        isActive: true,
      });
      await ctx.db.insert("phasePool", {
        datasetVersion: "v1",
        bookId,
        poolId: 70001,
        wbsPoolId: 70000,
        name: "CARBON STEEL - A106/A53 (SCH 10/40)",
        sortOrder: 1,
        isCustom: false,
        isActive: true,
      });
      const item = (poolId: number, phasePoolId: number, description: string) =>
        ctx.db.insert("laborPool", {
          datasetVersion: "v1",
          bookId,
          poolId,
          phasePoolId,
          description,
          sortOrder: poolId,
          craftConstant: 1,
          craftUnits: "LF",
          weldConstant: 0,
          weldUnits: "",
          isCustom: false,
          isActive: true,
        });
      await item(1, 30001, "POUR CONCRETE");
      await item(2, 30001, "CLEANUP"); // spacing variant must still match
      await item(3, 70001, "HE - 60");
      await item(4, 70001, "BW - 60"); // must NOT match "HE"
    });

    const result = await t.mutation(internal.takeoffSeed.seedTakeoffCatalog, {
      datasetVersion: "v1",
    });
    expect(result.rules).toBe(65);
    expect(result.totalFlagged).toBe(2);

    const flags = await t.run(async (ctx) => {
      const rows = await ctx.db.query("laborPool").collect();
      return rows.map((r) => [r.description, r.countsTowardTakeoff ?? false] as const);
    });
    expect(new Map(flags).get("CLEANUP")).toBe(true);
    expect(new Map(flags).get("HE - 60")).toBe(true);
    expect(new Map(flags).get("BW - 60")).toBe(false);
    expect(new Map(flags).get("POUR CONCRETE")).toBe(false);

    const units = await t.run(async (ctx) => {
      const rows = await ctx.db.query("phasePool").collect();
      return rows.map((r) => [r.poolId, r.takeoffUnit ?? null] as const);
    });
    expect(new Map(units).get(30001)).toBe("CY");
    expect(new Map(units).get(70001)).toBe("LF");

    // Re-running converges (idempotent).
    const again = await t.mutation(internal.takeoffSeed.seedTakeoffCatalog, {
      datasetVersion: "v1",
    });
    expect(again.totalFlagged).toBe(2);
  });
});
