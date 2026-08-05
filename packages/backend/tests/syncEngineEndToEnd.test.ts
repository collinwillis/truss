/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * The estate pass driven end to end, against a stubbed Firestore REST API.
 *
 * `syncDiff.test.ts` proves the verdicts and `syncMirror.test.ts` proves the
 * mutations act on them. Neither exercises the ENGINE: the queue walk, the
 * self-scheduling chain, the per-proposal orphan scan, the closing sweep. This
 * one runs `startEstateSync` through to `completed` with `fetch` replaced, which
 * is the only place the central economic claim — a second pass over an unchanged
 * estate writes nothing — can actually be measured rather than argued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { ownerHarness } from "./authFixtures";

type FsValue = Record<string, unknown>;

/** Encode a plain object into Firestore REST's tagged-value shape. */
function encode(value: unknown): FsValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number")
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (value && typeof value === "object") {
    const fields: Record<string, FsValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = encode(v);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function doc(collection: string, id: string, data: Record<string, unknown>) {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(data)) fields[k] = encode(v);
  return {
    name: `projects/mcp-estimator/databases/(default)/documents/${collection}/${id}`,
    fields,
  };
}

interface Estate {
  proposals: Record<string, Record<string, unknown>>;
  wbs: ReturnType<typeof doc>[];
  phase: ReturnType<typeof doc>[];
  activities: ReturnType<typeof doc>[];
  /** Collections whose runQuery should fail, to model a partial Firestore read. */
  failQuery?: Set<string>;
}

/** Stand in for the Firestore REST API so the engine can be driven end to end. */
function stubFirestore(estate: Estate) {
  vi.stubEnv("FIREBASE_API_KEY", "test-key");
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (init?.method === "POST" && url.includes(":runQuery")) {
      const parsed = JSON.parse(init.body ?? "{}");
      const collection = parsed.structuredQuery.from[0].collectionId as string;
      if (estate.failQuery?.has(collection)) {
        return new Response("boom", { status: 500 });
      }
      const offset = parsed.structuredQuery.offset ?? 0;
      if (offset > 0) return ok([]);
      const rows =
        collection === "wbs"
          ? estate.wbs
          : collection === "phase"
            ? estate.phase
            : estate.activities;
      return ok(rows.map((document) => ({ document })));
    }

    const listMatch = url.match(/documents\/proposals\?/);
    if (listMatch) {
      return ok({
        documents: Object.entries(estate.proposals).map(([id, d]) => doc("proposals", id, d)),
      });
    }

    const getMatch = url.match(/documents\/proposals\/([^?]+)\?/);
    if (getMatch) {
      const id = getMatch[1]!;
      const data = estate.proposals[id];
      if (!data) return new Response("{}", { status: 404 });
      return ok(doc("proposals", id, data));
    }

    throw new Error(`unstubbed fetch: ${url}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ESTATE: Estate = {
  proposals: {
    "fs-prop": {
      proposalNumber: "2042",
      proposalDescription: "GND DEBOTTLENECKING",
      proposalOwner: "R. Sanchez",
      proposalStatus: "Bidding",
      craftBaseRate: 48.17,
      burdenRate: 0.3875,
    },
  },
  wbs: [doc("wbs", "fs-wbs", { proposalId: "fs-prop", wbsDatabaseId: 70000, name: "AG PIPING" })],
  phase: [
    doc("phase", "fs-phase", {
      proposalId: "fs-prop",
      wbsId: "fs-wbs",
      phaseDatabaseId: 70001,
      phaseDatabaseName: "CARBON STEEL",
      phaseNumber: 1,
      description: "PHASE ONE",
    }),
  ],
  activities: [
    doc("activities", "fs-act-1", {
      proposalId: "fs-prop",
      wbsId: "fs-wbs",
      phaseId: "fs-phase",
      activityType: "laborItem",
      description: "EXCAVATE, LIGHT (CLASS C - GRAVEL)",
      quantity: 12,
      unit: "CY",
      constant: { id: 28, craftConstant: 0.55, weldConstant: 0 },
    }),
  ],
};

describe("ENGINE PROBE", () => {
  it("runs a whole estate pass against a stubbed Firestore", async () => {
    const { t } = await ownerHarness();
    stubFirestore(ESTATE);

    const jobId = await t.action(internal.sync.syncEngine.startEstateSync, {});
    expect(jobId).not.toBeNull();

    const job = await t.run(async (ctx) => ctx.db.get(jobId!));
    expect(job?.totalProposals).toBe(1);
    expect(job?.proposalQueue).toEqual(["fs-prop"]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await t.run(async (ctx) => ctx.db.get(jobId!));
    expect(after?.status).toBe("completed");
    expect(after?.insertedRecords).toBe(4);

    const rows = await t.run(async (ctx) => ctx.db.query("activities").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.laborPoolId).toBe(28);
  });

  it("names the proposal on a report row written from the error path", async () => {
    const { t } = await ownerHarness();
    stubFirestore({ ...ESTATE, failQuery: new Set(["activities"]) });

    const jobId = await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const reports = await t.run(async (ctx) => ctx.db.query("syncProposalReports").collect());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toMatch(/activities/);
    expect(reports[0]?.proposalNumber).toBe("2042");
    void jobId;
  });

  it("THE CLAIM: a second estate pass over an unchanged estate writes nothing", async () => {
    const { t } = await ownerHarness();
    stubFirestore(ESTATE);

    await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const second = await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const job = await t.run(async (ctx) => ctx.db.get(second!));
    expect({
      inserted: job?.insertedRecords,
      updated: job?.updatedRecords,
      unchanged: job?.unchangedRecords,
      orphaned: job?.orphanedRecords,
    }).toEqual({ inserted: 0, updated: 0, unchanged: 4, orphaned: 0 });
    const reports = await t.run(async (ctx) =>
      ctx.db
        .query("syncProposalReports")
        .withIndex("by_job", (q) => q.eq("jobId", second!))
        .collect()
    );
    expect(reports).toHaveLength(0);
  });

  it("THE LINK RULE, end to end through the cron path", async () => {
    const { t } = await ownerHarness();
    stubFirestore(ESTATE);
    await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const act = await t.run(async (ctx) => ctx.db.query("activities").first());
    await t.run(async (ctx) => ctx.db.patch(act!._id, { laborPoolId: 1204 }));

    const second = await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run(async (ctx) => (await ctx.db.get(act!._id))?.laborPoolId)).toBe(1204);
    const job = await t.run(async (ctx) => ctx.db.get(second!));
    expect(job?.suppressedLinks).toBe(1);
    expect(job?.updatedRecords).toBe(0);
  });

  it("a 404 on the proposal document blanks nothing", async () => {
    const { t } = await ownerHarness();
    stubFirestore(ESTATE);
    await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const before = await t.run(async (ctx) => ctx.db.query("proposals").first());

    // The document vanishes between the walk and the visit.
    stubFirestore({ ...ESTATE, proposals: {} });
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
      if (url.match(/documents\/proposals\?/)) {
        return new Response(
          JSON.stringify({
            documents: [doc("proposals", "fs-prop", ESTATE.proposals["fs-prop"]!)],
          }),
          { status: 200 }
        );
      }
      if (url.match(/documents\/proposals\/[^?]+\?/)) return new Response("{}", { status: 404 });
      void init;
      throw new Error(`unstubbed ${url}`);
    });

    const second = await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ctx.db.query("proposals").first());
    expect(after?.description).toBe(before?.description);
    expect(after?.rates).toEqual(before?.rates);
    const reports = await t.run(async (ctx) =>
      ctx.db
        .query("syncProposalReports")
        .withIndex("by_job", (q) => q.eq("jobId", second!))
        .collect()
    );
    expect(reports[0]?.skipped).toBe("missing_upstream");
  });

  it("flags a line Firestore stopped returning, and never deletes it", async () => {
    const { t } = await ownerHarness();
    const twoLines: Estate = {
      ...ESTATE,
      activities: [
        ...ESTATE.activities,
        doc("activities", "fs-act-2", {
          proposalId: "fs-prop",
          wbsId: "fs-wbs",
          phaseId: "fs-phase",
          activityType: "laborItem",
          description: "SEAM WELDING 1/8 THK",
          quantity: 4,
          unit: "IN",
          constant: { id: 455, craftConstant: 0.2, weldConstant: 0.4 },
        }),
      ],
    };
    stubFirestore(twoLines);
    await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("activities").collect()).length)).toBe(2);

    stubFirestore(ESTATE); // fs-act-2 gone
    const second = await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run(async (ctx) => ctx.db.query("activities").collect());
    expect(rows).toHaveLength(2);
    const gone = rows.find((r) => r.firestoreId === "fs-act-2");
    expect(gone?.mirrorDeletedAt).toBeGreaterThan(0);
    expect(await t.run(async (ctx) => (await ctx.db.get(second!))?.orphanedRecords)).toBe(1);

    // And it heals when the line comes back. Asserted on the document rather
    // than on `t.run`'s return value, because a `t.run` that returns `undefined`
    // comes back as `null` through Convex's value encoding — which reads as a
    // failure and is nothing of the kind.
    stubFirestore(twoLines);
    await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const healed = await t.run(async (ctx) => ctx.db.get(gone!._id));
    expect(healed).not.toBeNull();
    expect(healed?.mirrorDeletedAt).toBeUndefined();
  });

  it("counts the stored rows the upsert structurally cannot see", async () => {
    // `localOnly` and `duplicate` are promised by both the differ and the schema
    // on the grounds that a report must never present "we ignored N rows" as
    // "nothing happened". `upsertProposalHierarchy` cannot keep that promise: it
    // looks each INCOMING row up by key and never walks the stored side, so a
    // Precision-born row and a second copy sharing one key are both invisible to
    // it. The orphan scan is the only pass that enumerates stored rows.
    //
    // The duplicate is the one that matters. The upsert's `.first()` updates one
    // copy for ever while the other drifts, and the orphan test sees the shared
    // key as present and correctly declines to flag it — so without this counter
    // nothing anywhere says the row exists.
    const { t } = await ownerHarness();
    stubFirestore(ESTATE);
    await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const seed = await t.run(async (ctx) => ctx.db.query("activities").first());
    await t.run(async (ctx) => {
      const born = {
        proposalId: seed!.proposalId,
        wbsId: seed!.wbsId,
        phaseId: seed!.phaseId,
        type: "labor" as const,
        description: "ADDED IN PRECISION",
        quantity: 1,
        unit: "EA",
        sortOrder: 2,
      };
      await ctx.db.insert("activities", born);
      // A migration that ran twice is how this happens in production.
      await ctx.db.insert("activities", { ...born, firestoreId: seed!.firestoreId, sortOrder: 3 });
    });

    const second = await t.action(internal.sync.syncEngine.startEstateSync, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const job = await t.run(async (ctx) => ctx.db.get(second!));
    // Neither is an orphan, and neither is a write.
    expect(job?.orphanedRecords).toBe(0);
    expect(job?.updatedRecords).toBe(0);

    const reports = await t.run(async (ctx) =>
      ctx.db
        .query("syncProposalReports")
        .withIndex("by_job", (q) => q.eq("jobId", second!))
        .collect()
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.byLevel.activity.localOnly).toBe(1);
    expect(reports[0]?.byLevel.activity.duplicate).toBe(1);
  });
});
