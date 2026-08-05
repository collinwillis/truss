/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Looking at a draft, and changing one.
 *
 * THE FIRST TEST IS THE REASON THIS FILE EXISTS. `precision.getLaborPool`
 * filters `isActive: true`, so a row a draft RETIRED could not be seen from
 * anywhere in the application — not the pools screens, not the picker, not the
 * import preview. The only way to find out what a draft had withdrawn was to
 * export a spreadsheet. So the retired row is seeded first and both queries are
 * asked about it, side by side.
 *
 * The second one worth reading is the phase edit. `toStoredPatch` writes
 * `takeoffUnit` into every phase patch it returns, and `db.patch` treats an
 * `undefined` field as a deletion — so a one-field `name` edit routed through
 * it would silently drop the phase's takeoff unit and every estimate on that
 * phase would start printing a dash. Nothing about the call site would look
 * wrong.
 */
import { describe, expect, it, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ownerHarness, type Caller } from "./authFixtures";
import type { TestRunner } from "./convexFixtures";

const WBS_CODE = 70000;
const PHASE_CODE = 70001;

interface Draft {
  t: TestRunner;
  as: Caller;
  bookId: Id<"rateBooks">;
  phaseRowId: Id<"phasePool">;
  /** `FSW - ≤.75` (2738), `CUT - 2` (2739), and the withdrawn 2740. */
  labor: Id<"laborPool">[];
  equipment: Id<"equipmentPool">[];
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/** Run a call that must be refused, and return the message the caller sees. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

/**
 * A ready draft holding one WBS, one phase, three labor rows and two
 * equipment rows — one of the labor rows already retired.
 */
async function seedDraft(): Promise<Draft> {
  const { t, as } = await ownerHarness();

  const seeded = await t.run(async (ctx) => {
    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber: 2,
      name: "2026 Draft",
      status: "draft",
      isDefault: false,
      createdBy: "fixture",
      createdAt: 0,
      buildState: "ready",
      proposalCount: 0,
    });

    // Counters start high and sparse, exactly as the foundation migration
    // leaves them: an id is never a row position.
    for (const key of ["wbs", "phases", "labor", "equipment"]) {
      await ctx.db.insert("rateBookCounters", { key, next: 90000 });
    }

    await ctx.db.insert("wbsPool", {
      bookId,
      datasetVersion: "v1",
      poolId: WBS_CODE,
      name: "AG PIPING",
      sortOrder: 10,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });

    const phaseRowId = await ctx.db.insert("phasePool", {
      bookId,
      datasetVersion: "v1",
      poolId: PHASE_CODE,
      wbsPoolId: WBS_CODE,
      name: "CARBON STEEL - A106/A53 (SCH 10/40)",
      sortOrder: 10,
      takeoffUnit: "LF",
      reservedPhaseNumber: false,
      isCustom: false,
      isActive: true,
      rowRevision: 0,
    });

    const laborSpecs = [
      { poolId: 2738, description: "FSW - ≤.75", craft: 0.6, weld: 0.6, unit: "EA", sort: 10 },
      { poolId: 2739, description: "CUT - 2", craft: 0.25, weld: 0, unit: "", sort: 20 },
      { poolId: 2740, description: "WITHDRAWN LINE", craft: 1, weld: 0, unit: "", sort: 30 },
    ];
    const labor: Id<"laborPool">[] = [];
    for (const spec of laborSpecs) {
      const retired = spec.poolId === 2740;
      labor.push(
        await ctx.db.insert("laborPool", {
          bookId,
          datasetVersion: "v1",
          poolId: spec.poolId,
          phasePoolId: PHASE_CODE,
          description: spec.description,
          sortOrder: spec.sort,
          craftConstant: spec.craft,
          craftUnits: "LF",
          weldConstant: spec.weld,
          weldUnits: spec.unit,
          countsTowardTakeoff: false,
          isCustom: false,
          isActive: !retired,
          ...(retired ? { retiredInBookId: bookId } : {}),
          rowRevision: 0,
        })
      );
    }

    const equipmentSpecs = [
      { poolId: 1, description: "AIR COMPRESSOR 0-185 CFM", hour: 8, day: 64, week: 256, mo: 768 },
      { poolId: 2, description: "TRENCHER", hour: 6.25, day: 50, week: 200, mo: 600 },
    ];
    const equipment: Id<"equipmentPool">[] = [];
    for (const spec of equipmentSpecs) {
      equipment.push(
        await ctx.db.insert("equipmentPool", {
          bookId,
          datasetVersion: "v1",
          poolId: spec.poolId,
          description: spec.description,
          hourRate: spec.hour,
          dayRate: spec.day,
          weekRate: spec.week,
          monthRate: spec.mo,
          sortOrder: spec.poolId * 10,
          isCustom: false,
          isActive: true,
          rowRevision: 0,
        })
      );
    }

    return { bookId, phaseRowId, labor, equipment };
  });

  return { t, as, ...seeded };
}

const ALL_ROWS = { numItems: 50, cursor: null };

describe("looking at a draft", () => {
  it("shows the row a retirement made invisible everywhere else", async () => {
    const { as, bookId } = await seedDraft();

    const listed = await as.query(api.catalog.listCatalogRows, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      paginationOpts: ALL_ROWS,
    });
    expect(listed.page.map((row) => row.poolId)).toEqual([2738, 2739, 2740]);

    const withdrawn = must(
      listed.page.find((row) => row.poolId === 2740),
      "the retired row"
    );
    expect(withdrawn.isActive).toBe(false);
    expect(withdrawn.retiredInBookId).toBe(bookId);

    // The query this replaces cannot see it, and never could.
    const picker = await as.query(api.precision.getLaborPool, {
      bookId,
      phasePoolId: PHASE_CODE,
    });
    expect(picker.map((row) => row.poolId)).toEqual([2738, 2739]);
  });

  it("lists only what the draft withdrew, when that is the question", async () => {
    const { as, bookId } = await seedDraft();
    const listed = await as.query(api.catalog.listCatalogRows, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      status: "retired",
      paginationOpts: ALL_ROWS,
    });
    expect(listed.page.map((row) => row.poolId)).toEqual([2740]);
  });

  it("finds a row by an ASCII spelling of a character nobody can type", async () => {
    const { as, bookId } = await seedDraft();
    const listed = await as.query(api.catalog.listCatalogRows, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      search: "<=.75",
      paginationOpts: ALL_ROWS,
    });
    expect(listed.page.map((row) => row.poolId)).toEqual([2738]);
  });

  it("answers 'what is 2739' with one row", async () => {
    const { as, bookId } = await seedDraft();
    const listed = await as.query(api.catalog.listCatalogRows, {
      bookId,
      pool: "labor",
      search: "2739",
      paginationOpts: ALL_ROWS,
    });
    expect(listed.page.map((row) => row.poolId)).toEqual([2739]);
  });

  it("pages, rather than capping a collect", async () => {
    const { as, bookId } = await seedDraft();

    const first = await as.query(api.catalog.listCatalogRows, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map((row) => row.poolId)).toEqual([2738, 2739]);
    expect(first.isDone).toBe(false);

    const second = await as.query(api.catalog.listCatalogRows, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((row) => row.poolId)).toEqual([2740]);
    expect(second.isDone).toBe(true);
  });

  it("hands over the whole parent scope in one read", async () => {
    const { as, bookId } = await seedDraft();
    const scopes = await as.query(api.catalog.getBookScopes, { bookId });
    expect(scopes.wbs.map((row) => row.poolId)).toEqual([WBS_CODE]);
    expect(scopes.phases).toEqual([
      {
        poolId: PHASE_CODE,
        wbsPoolId: WBS_CODE,
        name: "CARBON STEEL - A106/A53 (SCH 10/40)",
        sortOrder: 10,
        isActive: true,
        takeoffUnit: "LF",
      },
    ]);
  });

  it("counts what is there and what was withdrawn", async () => {
    const { as, bookId } = await seedDraft();
    const summary = await as.query(api.catalog.getCatalogSummary, { bookId });
    expect(summary.counts.labor).toEqual({ total: 3, active: 2, retired: 1 });
    expect(summary.counts.equipment).toEqual({ total: 2, active: 2, retired: 0 });
    expect(summary.editable).toBe(true);
  });

  it("calls a published book what it is: not editable", async () => {
    const { t, as, bookId } = await seedDraft();
    await t.run(async (ctx) => ctx.db.patch(bookId, { status: "published" }));

    const summary = await as.query(api.catalog.getCatalogSummary, { bookId });
    expect(summary.editable).toBe(false);
  });
});

describe("editing one field", () => {
  it("changes the value and bumps the revision", async () => {
    const { t, as, bookId, labor } = await seedDraft();
    const rowId = must(labor[0], "the first labor row");

    const result = await as.mutation(api.catalog.updateCatalogRow, {
      bookId,
      pool: "labor",
      rowId,
      field: "craftConstant",
      value: 0.75,
      expectedRevision: 0,
    });
    expect(result.rowRevision).toBe(1);

    const stored = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(stored?.craftConstant).toBe(0.75);
  });

  it("refuses an edit made against a view that has moved on", async () => {
    const { as, bookId, labor } = await seedDraft();
    const rowId = must(labor[0], "the first labor row");

    await as.mutation(api.catalog.updateCatalogRow, {
      bookId,
      pool: "labor",
      rowId,
      field: "craftConstant",
      value: 0.75,
      expectedRevision: 0,
    });

    const message = await refusal(() =>
      as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId,
        field: "craftConstant",
        value: 0.9,
        expectedRevision: 0,
      })
    );
    expect(message).toContain("changed since you loaded it");
  });

  it("refuses a negative constant and a weld constant with nothing to multiply", async () => {
    const { as, bookId, labor } = await seedDraft();
    const rowId = must(labor[1], "the second labor row");

    expect(
      await refusal(() =>
        as.mutation(api.catalog.updateCatalogRow, {
          bookId,
          pool: "labor",
          rowId,
          field: "craftConstant",
          value: -1,
          expectedRevision: 0,
        })
      )
    ).toContain("cannot be negative");

    // Row 2739 carries a blank `weldUnits`, so giving it a weld constant alone
    // would leave hours with no unit behind them.
    expect(
      await refusal(() =>
        as.mutation(api.catalog.updateCatalogRow, {
          bookId,
          pool: "labor",
          rowId,
          field: "weldConstant",
          value: 0.5,
          expectedRevision: 0,
        })
      )
    ).toContain("weld unit");
  });

  it("does not drop a phase's takeoff unit when its name is edited", async () => {
    const { t, as, bookId, phaseRowId } = await seedDraft();

    await as.mutation(api.catalog.updateCatalogRow, {
      bookId,
      pool: "phases",
      rowId: phaseRowId,
      field: "name",
      value: "CARBON STEEL - A106 (SCH 40)",
      expectedRevision: 0,
    });

    const stored = await t.run(async (ctx) => ctx.db.get(phaseRowId));
    expect(stored?.takeoffUnit).toBe("LF");
  });

  it("removes the takeoff unit when the takeoff unit is what was blanked", async () => {
    const { t, as, bookId, phaseRowId } = await seedDraft();

    await as.mutation(api.catalog.updateCatalogRow, {
      bookId,
      pool: "phases",
      rowId: phaseRowId,
      field: "takeoffUnit",
      value: "",
      expectedRevision: 0,
    });

    // Absent, not empty: `loadTakeoffCatalog` tests `!== undefined` to decide
    // whether the phase has a takeoff quantity at all.
    const stored = await t.run(async (ctx) => ctx.db.get(phaseRowId));
    expect(stored?.takeoffUnit).toBeUndefined();
  });

  it("refuses a row that belongs to another pool", async () => {
    const { as, bookId, equipment } = await seedDraft();
    const message = await refusal(() =>
      as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId: must(equipment[0], "an equipment row"),
        field: "craftConstant",
        value: 1,
        expectedRevision: 0,
      })
    );
    expect(message).toContain("not in the labor catalog");
  });

  it("refuses a column that is not a cell edit", async () => {
    const { as, bookId, labor } = await seedDraft();
    const message = await refusal(() =>
      as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId: must(labor[0], "the first labor row"),
        field: "phasePoolId",
        value: 70002,
        expectedRevision: 0,
      })
    );
    expect(message).toContain("not an editable column");
  });

  it("refuses every write to a published book", async () => {
    const { t, as, bookId, labor } = await seedDraft();
    await t.run(async (ctx) => ctx.db.patch(bookId, { status: "published" }));

    const message = await refusal(() =>
      as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId: must(labor[0], "the first labor row"),
        field: "craftConstant",
        value: 0.75,
        expectedRevision: 0,
      })
    );
    expect(message).toContain("Duplicate it as a draft");
  });
});

describe("adding a row", () => {
  it("takes its id from the counter, never from the caller", async () => {
    const { t, as, bookId } = await seedDraft();

    const added = await as.mutation(api.catalog.addCatalogRow, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      values: {
        description: "BEVEL - 2",
        craftConstant: 0.4,
        craftUnits: "EA",
        weldConstant: 0,
        weldUnits: "",
        countsTowardTakeoff: false,
      },
    });
    expect(added.poolId).toBe(90000);

    const counter = await t.run(async (ctx) =>
      ctx.db
        .query("rateBookCounters")
        .withIndex("by_key", (q) => q.eq("key", "labor"))
        .first()
    );
    expect(counter?.next).toBe(90001);

    // The identity is recorded outside any book, so the id means one thing
    // across every version of the catalog.
    const identity = await t.run(async (ctx) =>
      ctx.db
        .query("rateBookItems")
        .withIndex("by_pool_id", (q) => q.eq("pool", "labor").eq("poolId", 90000))
        .first()
    );
    expect(identity?.originBookId).toBe(bookId);
  });

  it("places the new row after everything already in its phase", async () => {
    const { t, as, bookId } = await seedDraft();

    const added = await as.mutation(api.catalog.addCatalogRow, {
      bookId,
      pool: "labor",
      parentPoolId: PHASE_CODE,
      values: {
        description: "BEVEL - 2",
        craftConstant: 0.4,
        craftUnits: "EA",
        weldConstant: 0,
        weldUnits: "",
      },
    });

    const stored = await t.run(async (ctx) => ctx.db.get(added.rowId));
    // The phase's highest sort order is 30; a new row goes after it, not to
    // the top of a list people have memorised.
    expect(stored?.sortOrder).toBe(40);
  });

  it("refuses a parent this book does not contain", async () => {
    const { as, bookId } = await seedDraft();
    const message = await refusal(() =>
      as.mutation(api.catalog.addCatalogRow, {
        bookId,
        pool: "labor",
        parentPoolId: 79999,
        values: {
          description: "ORPHAN",
          craftConstant: 1,
          craftUnits: "EA",
          weldConstant: 0,
          weldUnits: "",
        },
      })
    );
    expect(message).toContain("not in this rate book");
  });

  it("refuses a missing number rather than pricing work at zero", async () => {
    const { as, bookId } = await seedDraft();
    const message = await refusal(() =>
      as.mutation(api.catalog.addCatalogRow, {
        bookId,
        pool: "labor",
        parentPoolId: PHASE_CODE,
        values: { description: "NO CONSTANT", craftUnits: "EA", weldConstant: 0, weldUnits: "" },
      })
    );
    expect(message).toContain("craftConstant is required");
  });
});

describe("retiring and restoring", () => {
  it("records which book withdrew the row, and clears it on the way back", async () => {
    const { t, as, bookId, labor } = await seedDraft();
    const rowId = must(labor[1], "the second labor row");

    const retired = await as.mutation(api.catalog.setCatalogRowRetired, {
      bookId,
      pool: "labor",
      rowId,
      retired: true,
      expectedRevision: 0,
    });
    let stored = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(stored?.isActive).toBe(false);
    expect(stored?.retiredInBookId).toBe(bookId);

    await as.mutation(api.catalog.setCatalogRowRetired, {
      bookId,
      pool: "labor",
      rowId,
      retired: false,
      expectedRevision: retired.rowRevision,
    });
    stored = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(stored?.isActive).toBe(true);
    expect(stored?.retiredInBookId).toBeUndefined();
  });

  it("is not a delete", async () => {
    const { t, as, bookId, labor } = await seedDraft();
    await as.mutation(api.catalog.setCatalogRowRetired, {
      bookId,
      pool: "labor",
      rowId: must(labor[1], "the second labor row"),
      retired: true,
      expectedRevision: 0,
    });
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("laborPool")
        .withIndex("by_book", (q) => q.eq("bookId", bookId))
        .collect()
    );
    expect(remaining).toHaveLength(3);
  });
});

describe("a bulk percentage adjustment", () => {
  it("moves the named columns, rounds to the cent, and says what it did", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, bookId, equipment } = await seedDraft();

      const started = await as.mutation(api.catalog.startBulkAdjust, {
        bookId,
        pool: "equipment",
        fields: ["hourRate", "dayRate", "weekRate", "monthRate"],
        percent: 3,
        rowIds: equipment,
      });
      expect(started.rows).toBe(2);

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("equipmentPool")
          .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
          .collect()
      );
      const compressor = must(
        rows.find((row) => row.poolId === 1),
        "the compressor"
      );
      const trencher = must(
        rows.find((row) => row.poolId === 2),
        "the trencher"
      );
      expect([
        compressor.hourRate,
        compressor.dayRate,
        compressor.weekRate,
        compressor.monthRate,
      ]).toEqual([8.24, 65.92, 263.68, 791.04]);
      expect([trencher.hourRate, trencher.dayRate, trencher.weekRate, trencher.monthRate]).toEqual([
        6.44, 51.5, 206, 618,
      ]);

      const run = await as.query(api.catalog.getBulkAdjustRun, { runId: started.runId });
      expect(run?.state).toBe("done");
      expect(run?.tally).toEqual({ selected: 2, adjusted: 2, missing: 0, unchanged: 0 });

      // The draft is handed back, or the next operation would find it busy for
      // ever.
      const book = await t.run(async (ctx) => ctx.db.get(bookId));
      expect(book?.lock).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a selection that names the same row twice", async () => {
    const { as, bookId, equipment } = await seedDraft();
    const rowId = must(equipment[0], "an equipment row");
    const message = await refusal(() =>
      as.mutation(api.catalog.startBulkAdjust, {
        bookId,
        pool: "equipment",
        fields: ["hourRate"],
        percent: 3,
        rowIds: [rowId, rowId],
      })
    );
    expect(message).toContain("applied twice");
  });

  it("refuses a selection holding a row from the other pool", async () => {
    const { as, bookId, labor, equipment } = await seedDraft();
    const message = await refusal(() =>
      as.mutation(api.catalog.startBulkAdjust, {
        bookId,
        pool: "equipment",
        fields: ["hourRate"],
        percent: 3,
        rowIds: [must(equipment[0], "equipment"), must(labor[0], "labor")],
      })
    );
    expect(message).toContain("not in the equipment catalog");
  });

  it("refuses a column a percentage means nothing to", async () => {
    const { as, bookId, labor } = await seedDraft();
    const message = await refusal(() =>
      as.mutation(api.catalog.startBulkAdjust, {
        bookId,
        pool: "labor",
        fields: ["craftUnits"],
        percent: 3,
        rowIds: [must(labor[0], "labor")],
      })
    );
    expect(message).toContain("percentage can move");
  });

  it("holds the draft while it runs, so no hand edit lands inside it", async () => {
    const { as, bookId, labor, equipment } = await seedDraft();

    await as.mutation(api.catalog.startBulkAdjust, {
      bookId,
      pool: "equipment",
      fields: ["hourRate"],
      percent: 3,
      rowIds: [must(equipment[0], "equipment")],
    });

    const message = await refusal(() =>
      as.mutation(api.catalog.updateCatalogRow, {
        bookId,
        pool: "labor",
        rowId: must(labor[0], "labor"),
        field: "craftConstant",
        value: 0.9,
        expectedRevision: 0,
      })
    );
    expect(message).toContain("busy (bulkEdit)");
  });

  it("resumes from the cursor, and never re-applies a percentage", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, bookId, equipment } = await seedDraft();

      // A run that died after its first row: the cursor says one landed, so
      // the resume must start at the second and leave the first alone.
      const runId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("catalogBulkRuns", {
          bookId,
          pool: "equipment",
          fields: ["hourRate"],
          percent: 3,
          rowIds: equipment,
          state: "failed",
          cursor: 1,
          startedBy: "fixture",
          startedAt: 0,
          error: "the batch stopped",
          tally: { selected: 2, adjusted: 1, missing: 0, unchanged: 0 },
          skipped: [],
        });
        return id;
      });

      await as.mutation(api.catalog.resumeBulkAdjust, { runId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("equipmentPool")
          .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
          .collect()
      );
      expect(rows.find((row) => row.poolId === 1)?.hourRate).toBe(8);
      expect(rows.find((row) => row.poolId === 2)?.hourRate).toBe(6.44);

      const run = await as.query(api.catalog.getBulkAdjustRun, { runId });
      expect(run?.state).toBe("done");
      expect(run?.tally.adjusted).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the book stops being a draft, rather than writing into it", async () => {
    vi.useFakeTimers();
    try {
      const { t, as, bookId, equipment } = await seedDraft();

      const started = await as.mutation(api.catalog.startBulkAdjust, {
        bookId,
        pool: "equipment",
        fields: ["hourRate"],
        percent: 3,
        rowIds: equipment,
      });
      // A publish landing between the start and the first batch.
      await t.run(async (ctx) => ctx.db.patch(bookId, { status: "published", lock: undefined }));

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("equipmentPool")
          .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
          .collect()
      );
      expect(rows.map((row) => row.hourRate)).toEqual([8, 6.25]);

      const run = await as.query(api.catalog.getBulkAdjustRun, { runId: started.runId });
      expect(run?.state).toBe("failed");
      expect(run?.tally.adjusted).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
