/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Editing a phase's attributes — and, above all, UNEDITING one.
 *
 * The phase table is being made editable in place, the way the tool it replaces
 * was. That turns a question the read path never had to answer into the central
 * one: what does an emptied cell mean? A grid hands back `""`, and storing that
 * says the phase HAS an area whose name is nothing. `loadTakeoffCatalog` tests
 * `takeoffUnit !== undefined` and `computePhaseTakeoff` tests
 * `customUnit === undefined`, so a stored blank does not merely look untidy —
 * it makes a phase claim a takeoff it does not have (commit 4749a03, one table
 * over). An emptied attribute has to become ABSENT.
 *
 * So every clearable field carries three meanings, not two: absent leaves it
 * alone, a value sets it, `null` (or a blank) removes it. These tests pin all
 * three, plus the two refusals the screen has to be able to tell apart from a
 * lost connection.
 *
 * @see docs/precision/DECISIONS.md D1, D3, D-takeoff, D-phasenumber
 */

import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { ownerHarness } from "./authFixtures";
import { ensureTestBook, seedProposal, type TestRunner } from "./convexFixtures";

/**
 * A stored value reduced to a string, so ABSENT and `""` are different results.
 *
 * ⚠️ NEITHER `toBeUndefined()` NOR `"area" in phase` WOULD BE ASSERTING ON THE
 * WRITE. `t.run`'s return value goes through Convex's serializer, which turns
 * `undefined` into `null` — so a cleared field and a field holding null read
 * identically outside the closure. And convex-test's `patch` merges a cleared
 * field in as a key holding `undefined` rather than deleting the key, where the
 * real backend removes it, so `in` would be asserting on the harness. Reducing
 * INSIDE the closure is what keeps the assertion about the mutation.
 */
async function storedField(
  t: TestRunner,
  phaseId: Id<"phases">,
  field: keyof Doc<"phases">
): Promise<string> {
  return t.run(async (ctx) => {
    const phase = await ctx.db.get(phaseId);
    if (!phase) return "NO PHASE";
    const value = phase[field];
    return value === undefined ? "ABSENT" : JSON.stringify(value);
  });
}

/** The piping spec as stored, or `null` when the phase carries none at all. */
async function storedSpec(t: TestRunner, phaseId: Id<"phases">) {
  return t.run(async (ctx) => (await ctx.db.get(phaseId))?.pipingSpec ?? null);
}

/** The D1 stamp: `null` until Precision has written something real. */
async function ownership(t: TestRunner, proposalId: Id<"proposals">): Promise<number | null> {
  return t.run(async (ctx) => (await ctx.db.get(proposalId))?.precisionOwnedAt ?? null);
}

/**
 * The `kind` a refusal carries, or a failure naming what it carried instead.
 *
 * ⚠️ ASSERTING THAT A CALL THREW IS NOT ASSERTING THAT IT REFUSED. Convex
 * redacts a plain `Error`'s message on a production deployment, so a refusal
 * the grid has to act on has to arrive as a `ConvexError` with a kind —
 * `.rejects.toThrow()` passes for either.
 */
async function refusal(call: Promise<unknown>): Promise<{ kind: string; field?: string }> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ConvexError)) {
      throw new Error(
        `that refusal was a plain Error, whose message production redacts: ${String(error)}`
      );
    }
    const data: unknown = error.data;
    if (typeof data !== "object" || data === null || !("kind" in data)) {
      throw new Error("that refusal carried no kind");
    }
    const shape = data as { kind: unknown; field?: unknown };
    return {
      kind: String(shape.kind),
      ...(shape.field === undefined ? {} : { field: String(shape.field) }),
    };
  }
  throw new Error("that call was supposed to be refused and was not");
}

/**
 * Two phase types: one that has a takeoff unit in the catalog and one that has
 * none — the pair that makes "a blank unit is not a unit" testable.
 */
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
    await ctx.db.insert("laborPool", {
      datasetVersion: "v1",
      bookId,
      poolId: 104,
      phasePoolId: 30001,
      description: "CLEAN UP",
      sortOrder: 104,
      craftConstant: 1,
      craftUnits: "CY",
      weldConstant: 0,
      weldUnits: "",
      isCustom: false,
      isActive: true,
      countsTowardTakeoff: true,
    });
  });
}

/** One AG PIPING phase carrying every attribute the table lets an estimator edit. */
async function seedFurnishedPhase(t: TestRunner) {
  const { proposalId, wbsByCode, phaseByNumber } = await seedProposal(t, {
    proposalNumber: "2020",
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [
          { phaseNumber: 70001, description: "TK 8 FEED" },
          { phaseNumber: 70002, description: "TK 8 RETURN" },
        ],
      },
    ],
  });
  const wbsId = wbsByCode.get(70000);
  const phaseId = phaseByNumber.get("70000:70001");
  const siblingId = phaseByNumber.get("70000:70002");
  if (!wbsId || !phaseId || !siblingId) throw new Error("fixture did not seed the piping tree");

  await t.run(async (ctx) => {
    await ctx.db.patch(phaseId, {
      area: "TANK FARM",
      status: "IFC",
      sheet: 12,
      pipingSpec: { size: "6", spec: "A106", flc: "150#", insulation: "CALSIL" },
    });
  });

  return { proposalId, wbsId, phaseId, siblingId };
}

describe("an emptied attribute becomes ABSENT", () => {
  it("clears AREA rather than storing an empty string", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, area: null });

    // The assertion this whole file exists for: `""` would be a phase whose
    // area is named nothing, which is not what the estimator said.
    expect(await storedField(t, phaseId, "area")).toBe("ABSENT");
  });

  it("treats a blank the grid hands back as the same clear, never as a value", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, area: "   " });

    expect(await storedField(t, phaseId, "area")).toBe("ABSENT");
  });

  it("clears STATUS and SHEET the same way", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, status: null, sheet: null });

    expect(await storedField(t, phaseId, "status")).toBe("ABSENT");
    expect(await storedField(t, phaseId, "sheet")).toBe("ABSENT");
  });

  it("leaves everything the caller did not mention alone", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, description: "TK 8 FEED, REV B" });

    expect(await storedField(t, phaseId, "description")).toBe('"TK 8 FEED, REV B"');
    expect(await storedField(t, phaseId, "area")).toBe('"TANK FARM"');
    expect(await storedField(t, phaseId, "sheet")).toBe("12");
  });

  it("clearing something already absent is not an edit (D1)", async () => {
    // Under D1 the first real write detaches the estimate from the estimator
    // mirror for good. A grid blurring an empty cell must not cost an estimate
    // every future upstream update.
    const { t, as } = await ownerHarness();
    const { proposalId, phaseId, siblingId } = await seedFurnishedPhase(t);
    expect(await ownership(t, proposalId)).toBeNull();

    await as.mutation(api.precision.updatePhase, { phaseId: siblingId, area: null, status: "" });

    expect(await ownership(t, proposalId)).toBeNull();

    // A real clear on the furnished phase still claims it — the guard is about
    // "nothing changed", not about clears being second-class writes.
    await as.mutation(api.precision.updatePhase, { phaseId, area: null });
    expect(await ownership(t, proposalId)).not.toBeNull();
  });
});

describe("the piping spec, one member at a time", () => {
  it("clears one member and leaves the rest of the spec standing", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, pipingSpec: { insulation: null } });

    // `ctx.db.patch` replaces a nested object wholesale, so a one-cell edit that
    // did not merge would take SIZE, SPEC and FLC with it.
    expect(await storedSpec(t, phaseId)).toEqual({ size: "6", spec: "A106", flc: "150#" });
  });

  it("sets one member without disturbing the others", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, { phaseId, pipingSpec: { spec: "A312" } });

    expect(await storedSpec(t, phaseId)).toEqual({
      size: "6",
      spec: "A312",
      flc: "150#",
      insulation: "CALSIL",
    });
  });

  it("removes the spec entirely once its last member is cleared", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, {
      phaseId,
      pipingSpec: { size: null, spec: "", flc: null, insulation: "  " },
    });

    // `{}` would read as "this phase has a piping spec" to anything testing the
    // object's presence — the same false claim a stored `""` makes.
    expect(await storedSpec(t, phaseId)).toBeNull();
    expect(await storedField(t, phaseId, "pipingSpec")).toBe("ABSENT");
  });
});

describe("the takeoff unit override (D3 on customUnit)", () => {
  it("a typed unit wins over the catalog's, on the screen and in the document", async () => {
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsByCode, phaseByNumber } = await seedProposal(t, {
      proposalNumber: "2021",
      wbs: [
        {
          poolId: 30000,
          name: "CONCRETE",
          phases: [
            {
              phaseNumber: 1,
              phasePoolId: 30001,
              activities: [{ type: "labor", quantity: 4, unit: "CY", laborPoolId: 104 }],
            },
          ],
        },
      ],
    });
    const wbsId = wbsByCode.get(30000);
    const phaseId = phaseByNumber.get("30000:1");
    if (!wbsId || !phaseId) throw new Error("fixture did not seed the concrete tree");

    let rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 4, unit: "CY", isOverridden: false });

    await as.mutation(api.precision.updatePhase, { phaseId, takeoffUnit: "LF" });

    // Nothing had ever written `customUnit` — 0 of 12,000 live phases carry one
    // — though `computePhaseTakeoff` has always preferred it to the catalog's.
    expect(await storedField(t, phaseId, "customUnit")).toBe('"LF"');
    rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 4, unit: "LF", isOverridden: false });

    await as.mutation(api.precision.updatePhase, { phaseId, takeoffUnit: null });

    expect(await storedField(t, phaseId, "customUnit")).toBe("ABSENT");
    rows = await as.query(api.precision.getPhaseListWithCosts, { wbsId });
    expect(rows[0]!.takeoff).toEqual({ quantity: 4, unit: "CY", isOverridden: false });
  });

  it("a blank unit leaves a no-takeoff phase showing a dash", async () => {
    // THE 4749a03 FAILURE, in the other table. `computePhaseTakeoff` reads
    // `customUnit === undefined` as "this phase type has no takeoff at all", so
    // a stored `""` would turn the dash into a quantity nobody measured.
    const { t, as } = await ownerHarness();
    await seedCatalog(t);
    const { wbsByCode, phaseByNumber } = await seedProposal(t, {
      proposalNumber: "2022",
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
    const phaseId = phaseByNumber.get("10000:1");
    if (!wbsId || !phaseId) throw new Error("fixture did not seed the mobilize tree");

    await as.mutation(api.precision.updatePhase, { phaseId, takeoffUnit: "" });

    expect(await storedField(t, phaseId, "customUnit")).toBe("ABSENT");
    expect((await as.query(api.precision.getPhaseListWithCosts, { wbsId }))[0]!.takeoff).toBeNull();

    // A REAL unit on the same phase does give it a takeoff — the guard is about
    // the blank, not about the override being ignored here.
    await as.mutation(api.precision.updatePhase, { phaseId, takeoffUnit: "EA" });
    expect((await as.query(api.precision.getPhaseListWithCosts, { wbsId }))[0]!.takeoff).toEqual({
      quantity: 0,
      unit: "EA",
      isOverridden: false,
    });
  });
});

describe("refusals the screen has to tell apart", () => {
  it("refuses a phase number another phase in the breakdown already answers to", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    const refused = await refusal(
      as.mutation(api.precision.updatePhase, { phaseId, phaseNumber: 70002 })
    );

    expect(refused.kind).toBe("phase_number_taken");
    expect(await storedField(t, phaseId, "phaseNumber")).toBe("70001");
  });

  it("does not call a phase's own number a collision with itself", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    await as.mutation(api.precision.updatePhase, {
      phaseId,
      phaseNumber: 70001,
      description: "TK 8 FEED, REV B",
    });

    expect(await storedField(t, phaseId, "description")).toBe('"TK 8 FEED, REV B"');
  });

  it("refuses numbers the field cannot hold, and names which cell", async () => {
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);

    const negativeSheet = await refusal(
      as.mutation(api.precision.updatePhase, { phaseId, sheet: -3 })
    );
    expect(negativeSheet).toEqual({ kind: "phase_field_invalid", field: "sheet" });

    const notANumber = await refusal(
      as.mutation(api.precision.updatePhase, { phaseId, sheet: Number.NaN })
    );
    expect(notANumber).toEqual({ kind: "phase_field_invalid", field: "sheet" });

    const negativeInsulation = await refusal(
      as.mutation(api.precision.updatePhase, { phaseId, pipingSpec: { insulationSize: -2 } })
    );
    expect(negativeInsulation).toEqual({ kind: "phase_field_invalid", field: "insulationSize" });

    // Refused, not stored: the whole point of naming the condition.
    expect(await storedField(t, phaseId, "sheet")).toBe("12");
    expect(await storedSpec(t, phaseId)).toEqual({
      size: "6",
      spec: "A106",
      flc: "150#",
      insulation: "CALSIL",
    });
  });

  it("still lets a phase carrying legacy junk be edited in its other columns", async () => {
    // Judged on what MOVES, not on the payload: a mirrored row whose sheet is
    // already -3 would otherwise be frozen in every column, since a grid resends
    // the value it is showing.
    const { t, as } = await ownerHarness();
    const { phaseId } = await seedFurnishedPhase(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(phaseId, { sheet: -3 });
    });

    await as.mutation(api.precision.updatePhase, { phaseId, sheet: -3, area: "PIPE RACK" });

    expect(await storedField(t, phaseId, "area")).toBe('"PIPE RACK"');
    expect(await storedField(t, phaseId, "sheet")).toBe("-3");
  });
});
