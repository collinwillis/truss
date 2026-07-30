/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * D-phasenumber — legacy's numbering scheme, server-derived and
 * collision-proof.
 *
 * The scheme (confirmed by Collin): ordinary phases number sequentially from
 * the WBS code (the first AG PIPING phase is 70001); the ~110 reserved
 * catalog phases carry their catalog id verbatim on every estimate
 * (Hydrotesting is always 79996); reserved numbers never influence the
 * sequential scan.
 *
 * The robustness deltas over legacy — each pinned here because legacy got
 * them wrong: legacy computed the number in the React dialog and trusted the
 * client, silently created duplicates, and copied numbers verbatim when
 * duplicating a phase.
 *
 * @see docs/precision/DECISIONS.md D-phasenumber
 */

import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { nextPhaseNumber, phaseNumberConflict } from "../convex/model/phaseNumbering";
import { RESERVED_PHASE_POOL_IDS } from "../convex/reservedPhaseSeed";
import { ownerHarness } from "./authFixtures";
import { seedProposal, type TestRunner } from "./convexFixtures";

const NO_RESERVED: ReadonlySet<number> = new Set();

describe("the numbering rule (pure)", () => {
  it("the first phase under a WBS numbers from the WBS code", () => {
    expect(
      nextPhaseNumber({
        wbsCode: 70000,
        phasePoolId: 70001,
        isReserved: false,
        existing: [],
        reservedNumbers: NO_RESERVED,
      })
    ).toBe(70001);
  });

  it("subsequent phases count up from the highest ordinary number", () => {
    expect(
      nextPhaseNumber({
        wbsCode: 70000,
        phasePoolId: 70003,
        isReserved: false,
        existing: [{ phaseNumber: 70001 }, { phaseNumber: 70002 }],
        reservedNumbers: NO_RESERVED,
      })
    ).toBe(70003);
  });

  it("a reserved phase takes its catalog id verbatim", () => {
    expect(
      nextPhaseNumber({
        wbsCode: 70000,
        phasePoolId: 79996,
        isReserved: true,
        existing: [{ phaseNumber: 70001 }],
        reservedNumbers: new Set([79996]),
      })
    ).toBe(79996);
  });

  it("reserved numbers are excluded from the sequential scan", () => {
    // Hydrotesting at 79996 must not push the next pipe phase to 79997.
    expect(
      nextPhaseNumber({
        wbsCode: 70000,
        phasePoolId: 70002,
        isReserved: false,
        existing: [{ phaseNumber: 70001 }, { phaseNumber: 79996 }],
        reservedNumbers: new Set([79996]),
      })
    ).toBe(70002);
  });

  it("the sequence skips over taken and reserved numbers instead of colliding", () => {
    // Legacy silently duplicated when the sequence reached an occupied number.
    expect(
      nextPhaseNumber({
        wbsCode: 100,
        phasePoolId: 199,
        isReserved: false,
        existing: [
          { phaseNumber: 101 },
          { phaseNumber: 102 },
          { phaseNumber: 103 },
          { phaseNumber: 104 },
        ],
        reservedNumbers: new Set([105]),
      })
    ).toBe(106);
  });

  it("a second instance of a reserved phase falls through to sequential", () => {
    // The reserved number identifies THE Hydrotesting phase, not its copies.
    expect(
      nextPhaseNumber({
        wbsCode: 70000,
        phasePoolId: 79996,
        isReserved: true,
        existing: [{ phaseNumber: 79996 }, { phaseNumber: 70001 }],
        reservedNumbers: new Set([79996]),
      })
    ).toBe(70002);
  });

  it("phaseNumberConflict flags exact duplicates only", () => {
    const existing = [{ phaseNumber: 70001 }];
    expect(phaseNumberConflict(70001, existing)).toBe(true);
    expect(phaseNumberConflict(70002, existing)).toBe(false);
  });
});

/** Catalog rows: 70002 ordinary, 79996 reserved (Hydrotesting). */
async function seedNumberingCatalog(t: TestRunner) {
  await t.run(async (ctx) => {
    const pool = (poolId: number, name: string, reserved: boolean) =>
      ctx.db.insert("phasePool", {
        datasetVersion: "v1",
        poolId,
        wbsPoolId: 70000,
        name,
        sortOrder: poolId,
        isCustom: false,
        isActive: true,
        ...(reserved ? { reservedPhaseNumber: true } : {}),
      });
    await pool(70002, "CARBON STEEL - A106/A53 (SCH 80/XS)", false);
    await pool(79996, "HYDROTESTING", true);
  });
}

async function seedPipingWbs(t: TestRunner) {
  const { wbsByCode, phaseByNumber } = await seedProposal(t, {
    proposalNumber: "2020",
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [{ phaseNumber: 70001, phasePoolId: 70001, description: "CARBON STEEL" }],
      },
    ],
  });
  const wbsId = wbsByCode.get(70000);
  const phaseId = phaseByNumber.get("70000:70001");
  if (!wbsId || !phaseId) throw new Error("fixture did not seed the piping WBS");
  return { wbsId, phaseId };
}

describe("addPhase derives the number server-side", () => {
  it("an ordinary phase continues the sequence from the WBS code", async () => {
    const { t, as } = await ownerHarness();
    await seedNumberingCatalog(t);
    const { wbsId } = await seedPipingWbs(t);

    const phaseId = await as.mutation(api.precision.addPhase, {
      wbsId,
      phasePoolId: 70002,
      poolName: "CARBON STEEL - A106/A53 (SCH 80/XS)",
      description: "CARBON STEEL SCH 80",
    });
    const stored = await t.run(async (ctx) => ctx.db.get(phaseId));
    expect(stored?.phaseNumber).toBe(70002);
  });

  it("a reserved phase gets its catalog id, and the preview agrees", async () => {
    const { t, as } = await ownerHarness();
    await seedNumberingCatalog(t);
    const { wbsId } = await seedPipingWbs(t);

    const preview = await as.query(api.precision.getNextPhaseNumber, {
      wbsId,
      phasePoolId: 79996,
    });
    expect(preview).toBe(79996);

    const phaseId = await as.mutation(api.precision.addPhase, {
      wbsId,
      phasePoolId: 79996,
      poolName: "HYDROTESTING",
      description: "HYDROTESTING",
    });
    const stored = await t.run(async (ctx) => ctx.db.get(phaseId));
    expect(stored?.phaseNumber).toBe(79996);
  });

  it("a hand-typed duplicate is refused, not silently created", async () => {
    const { t, as } = await ownerHarness();
    await seedNumberingCatalog(t);
    const { wbsId } = await seedPipingWbs(t);

    await expect(
      as.mutation(api.precision.addPhase, {
        wbsId,
        phasePoolId: 70002,
        poolName: "CARBON STEEL - A106/A53 (SCH 80/XS)",
        phaseNumber: 70001,
        description: "COLLIDES",
      })
    ).rejects.toThrow(/already exists/i);
  });
});

describe("duplicatePhase numbers the copy sequentially", () => {
  it("never reuses the source's number", async () => {
    const { t, as } = await ownerHarness();
    await seedNumberingCatalog(t);
    const { phaseId } = await seedPipingWbs(t);

    const result = await as.mutation(api.precision.duplicatePhase, {
      sourcePhaseId: phaseId,
    });
    expect(result.phaseNumber).toBe(70002);
  });

  it("a copy of a reserved phase gets an ordinary number, not the reserved one", async () => {
    const { t, as } = await ownerHarness();
    await seedNumberingCatalog(t);
    const { wbsId } = await seedPipingWbs(t);

    const hydroId = await as.mutation(api.precision.addPhase, {
      wbsId,
      phasePoolId: 79996,
      poolName: "HYDROTESTING",
      description: "HYDROTESTING",
    });

    const copy = await as.mutation(api.precision.duplicatePhase, { sourcePhaseId: hydroId });
    // Sequential after 70001 — NOT 79996 (taken, reserved) and NOT 79997.
    expect(copy.phaseNumber).toBe(70002);
  });
});

describe("the reserved-number seed", () => {
  it("flags listed catalog rows and reports ids with no row", async () => {
    const { t } = await ownerHarness();
    await seedNumberingCatalog(t); // 79996 present (already flagged), 70002 ordinary

    const result = await t.mutation(internal.reservedPhaseSeed.seedReservedPhaseNumbers, {
      datasetVersion: "v1",
    });
    expect(result.listed).toBe(RESERVED_PHASE_POOL_IDS.length);
    expect(result.flagged).toBe(1); // only 79996 exists in this fixture
    expect(result.missing).toHaveLength(RESERVED_PHASE_POOL_IDS.length - 1);

    const flags = await t.run(async (ctx) => {
      const rows = await ctx.db.query("phasePool").collect();
      return rows.map((r) => [r.poolId, r.reservedPhaseNumber ?? false] as const);
    });
    expect(new Map(flags).get(79996)).toBe(true);
    expect(new Map(flags).get(70002)).toBe(false);
  });
});
