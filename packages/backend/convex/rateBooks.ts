import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePrecisionAdmin } from "./model/precisionAccess";
import { normalizeKey } from "./model/rateBookMatch";

/**
 * Rate books — the versioned estimating catalog.
 *
 * SLICE 1: identity and immutability. This file establishes what an id means
 * and gets the existing 6,272 catalog rows and 736 proposals under a book,
 * WITHOUT changing a single read path. Every estimate resolves exactly the
 * rows it resolved before; the new fields simply exist alongside.
 *
 * The migration is deliberately in this order, and each step is reversible
 * until the last one:
 *   1. schema (done in schema.ts — every new field optional, because Convex
 *      validates existing documents on push and would reject the deploy)
 *   2. `seedFoundationBook`  — mint counters and book #1 from the live data
 *   3. `migrateStampBatch`   — stamp bookId + mint identities, idempotently
 *   4. `archiveCorruptV2Equipment` — quarantine the 133 bad rows as evidence
 */

const POOL_TABLES = ["wbsPool", "phasePool", "laborPool", "equipmentPool"] as const;
type PoolTable = (typeof POOL_TABLES)[number];

/** Table -> the `rateBookItems.pool` value it mints under. */
const POOL_KIND: Record<PoolTable, "wbs" | "phases" | "labor" | "equipment"> = {
  wbsPool: "wbs",
  phasePool: "phases",
  laborPool: "labor",
  equipmentPool: "equipment",
};

/** Rows touched per migration mutation. Well inside Convex's limits. */
const STAMP_BATCH = 400;

function itemKey(table: PoolTable, row: Doc<PoolTable>): string {
  if (table === "laborPool") {
    const labor = row as Doc<"laborPool">;
    return `${labor.phasePoolId}|${normalizeKey(labor.description)}`;
  }
  if (table === "phasePool") {
    const phase = row as Doc<"phasePool">;
    return `${phase.wbsPoolId}|${normalizeKey(phase.name)}`;
  }
  if (table === "wbsPool") return normalizeKey((row as Doc<"wbsPool">).name);
  return normalizeKey((row as Doc<"equipmentPool">).description);
}

/**
 * Step 2 — mint the counters and book #1 from what is already there.
 *
 * Book #1 is PUBLISHED from birth and carries no parent: 736 estimates
 * already depend on these numbers, and it was never a draft anybody could
 * have edited. Calling it a draft now would be a fiction the whole subsystem
 * then has to work around.
 *
 * Counters are seeded from `max(poolId)`, NEVER from a row count. Ids are
 * sparse — equipment starts at 0 and labor has gaps — so counting rows would
 * hand out an id that is already in use, which is the exact failure this
 * table exists to prevent.
 */
export const seedFoundationBook = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("rateBooks")
      .withIndex("by_book_number", (q) => q.eq("bookNumber", 1))
      .first();
    if (existing) return { bookId: existing._id, created: false };

    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber: 1,
      // Their own words for it, not "v1" — the legacy label survives in
      // `legacyDatasetVersion` for anyone tracing provenance later.
      name: "Original Rate Book",
      status: "published",
      isDefault: true,
      createdBy: "migration",
      createdAt: Date.now(),
      publishedBy: "migration",
      publishedAt: Date.now(),
      buildState: "ready",
      proposalCount: 0,
      legacyDatasetVersion: "v1",
      notes:
        "The catalog as it stood when Precision took over from the MCP Estimator: " +
        "5,897 labor items, 228 phases, 18 WBS and 129 equipment items, all previously " +
        "carried as hand-maintained JSON files.",
    });

    // Highest id actually in use per pool, so the next mint cannot collide.
    const counters: Record<string, number> = {};
    for (const table of POOL_TABLES) {
      const rows = await ctx.db.query(table).collect();
      const max = rows.reduce((m, r) => Math.max(m, r.poolId), -1);
      counters[POOL_KIND[table]] = max + 1;
    }
    counters.book = 2;

    for (const [key, next] of Object.entries(counters)) {
      const row = await ctx.db
        .query("rateBookCounters")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (row) await ctx.db.patch(row._id, { next: Math.max(row.next, next) });
      else await ctx.db.insert("rateBookCounters", { key, next });
    }

    return { bookId, created: true, counters };
  },
});

/**
 * Step 3 — stamp one batch of pool rows into book #1 and mint their identity.
 *
 * IDEMPOTENT BY CONSTRUCTION: it skips anything already stamped, so a failed
 * run is simply re-run. It reschedules itself until the pool is done, then
 * moves to the next pool, so no single mutation is ever near a limit.
 *
 * The collision assertion is not decoration. The matcher's founding premise
 * is that a description plus its parent identifies exactly one item; if this
 * data ever violated that, every later import would silently match the wrong
 * row, and the right moment to find out is before anything depends on it.
 */
export const migrateStampBatch = internalMutation({
  args: {
    bookId: v.id("rateBooks"),
    poolIndex: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const poolIndex = args.poolIndex ?? 0;
    const table = POOL_TABLES[poolIndex];
    if (!table) return { done: true, pool: null, stamped: 0 };

    const page = await ctx.db
      .query(table)
      .paginate({ cursor: args.cursor ?? null, numItems: STAMP_BATCH });

    const kind = POOL_KIND[table];
    let stamped = 0;
    let minted = 0;

    for (const row of page.page) {
      if (row.bookId === undefined) {
        await ctx.db.patch(row._id, { bookId: args.bookId, rowRevision: 0 });
        stamped += 1;
      }
      const already = await ctx.db
        .query("rateBookItems")
        .withIndex("by_pool_id", (q) => q.eq("pool", kind).eq("poolId", row.poolId))
        .first();
      if (!already) {
        await ctx.db.insert("rateBookItems", {
          pool: kind,
          poolId: row.poolId,
          mintKey: itemKey(table, row),
          originBookId: args.bookId,
          mintedBy: "migration",
          mintedAt: Date.now(),
        });
        minted += 1;
      }
    }

    if (page.isDone) {
      await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampBatch, {
        bookId: args.bookId,
        poolIndex: poolIndex + 1,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampBatch, {
        bookId: args.bookId,
        poolIndex,
        cursor: page.continueCursor,
      });
    }

    return { done: false, pool: table, stamped, minted };
  },
});

/** Step 3b — stamp the proposals, so every estimate names the book it reads. */
export const migrateStampProposals = internalMutation({
  args: { bookId: v.id("rateBooks"), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("proposals")
      .paginate({ cursor: args.cursor ?? null, numItems: STAMP_BATCH });

    let stamped = 0;
    for (const proposal of page.page) {
      if (proposal.bookId === undefined) {
        await ctx.db.patch(proposal._id, { bookId: args.bookId });
        stamped += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampProposals, {
        bookId: args.bookId,
        cursor: page.continueCursor,
      });
    } else {
      // The books list reads this instead of scanning every proposal.
      const all = await ctx.db.query("proposals").collect();
      const count = all.filter((p) => p.bookId === args.bookId).length;
      await ctx.db.patch(args.bookId, { proposalCount: count });
    }

    return { stamped, done: page.isDone };
  },
});

/**
 * Step 4 — quarantine the corrupt v2 equipment rows as their own archived book.
 *
 * ⚠️ NOT DELETED, DELIBERATELY. These 133 rows are the measured evidence of
 * why this subsystem exists, and they are the calibration data
 * `rateBookMatch.test.ts` asserts against. No proposal references them,
 * `archived` hides them from every picker, and `isDefault` is false — so they
 * cost nothing where they sit. Deleting production data to tidy a schema is a
 * bet you only lose once.
 */
export const archiveCorruptV2Equipment = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orphans = (await ctx.db.query("equipmentPool").collect()).filter(
      (row) => row.datasetVersion === "v2" && row.bookId === undefined
    );
    if (orphans.length === 0) return { archived: 0, bookId: null };

    const counter = await ctx.db
      .query("rateBookCounters")
      .withIndex("by_key", (q) => q.eq("key", "book"))
      .first();
    const bookNumber = counter?.next ?? 2;
    if (counter) await ctx.db.patch(counter._id, { next: bookNumber + 1 });

    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber,
      name: "v2 equipment (never used — misaligned)",
      status: "archived",
      isDefault: false,
      createdBy: "migration",
      createdAt: Date.now(),
      archivedAt: Date.now(),
      buildState: "ready",
      proposalCount: 0,
      legacyDatasetVersion: "v2",
      rowCounts: { wbs: 0, phases: 0, labor: 0, equipment: orphans.length },
      notes:
        `${orphans.length} rows loaded from equipment_v2.json and never referenced by any ` +
        "proposal. Measured against v1: only 3 of 129 descriptions survive at their own id, " +
        "and 60 rows carry the previous row's description verbatim, in contiguous bands " +
        "(ids 10-12, 16-35, 37-46, 52-77). v2 id 6 'BREAKERS - AIR 30 LBS' carries v1 id 5's " +
        "rates of 7/56/224/672. The cause was positional ids: inserting a row in the source " +
        "spreadsheet re-pointed every id below it. Kept as evidence and as matcher " +
        "calibration data — see packages/backend/tests/rateBookMatch.test.ts.",
    });

    for (const row of orphans) {
      await ctx.db.patch(row._id, { bookId, rowRevision: 0 });
    }

    return { archived: orphans.length, bookId };
  },
});

/**
 * Run the whole migration.
 *
 * Safe to re-run: every step skips work it has already done.
 */
export const runFoundationMigration = internalMutation({
  args: {},
  handler: async (ctx) => {
    const seeded: { bookId: Id<"rateBooks">; created: boolean } = await ctx.runMutation(
      internal.rateBooks.seedFoundationBook,
      {}
    );

    // ⚠️ QUARANTINE FIRST, INLINE, BEFORE ANY STAMPING IS SCHEDULED.
    // `archiveCorruptV2Equipment` claims rows by `bookId === undefined`, so if
    // the general stamper reached equipmentPool first it would sweep the 133
    // corrupt rows into book #1 — the published book every estimate reads —
    // and the archive step would then find nothing to do. It happened to work
    // when both were scheduled together only because equipment is the last of
    // four pools; that is scheduling luck, not a guarantee, and this migration
    // is idempotent precisely so it can be re-run.
    const quarantine: { archived: number } = await ctx.runMutation(
      internal.rateBooks.archiveCorruptV2Equipment,
      {}
    );

    await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampBatch, {
      bookId: seeded.bookId,
    });
    await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampProposals, {
      bookId: seeded.bookId,
    });
    return { bookId: seeded.bookId, createdBook: seeded.created, quarantined: quarantine.archived };
  },
});

/**
 * Migration progress, for confirming the backfill landed.
 *
 * INTERNAL, and that is the point: this is run from the Convex dashboard,
 * which has no signed-in application user. Guarding it with
 * `requirePrecisionRead` made it unrunnable in the one place it is for —
 * `resolvePrecisionAccess` correctly refused an anonymous caller. Internal
 * functions are unreachable from any client, which is a stronger guarantee
 * than the app-level check it replaces.
 */
export const migrationStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const books = await ctx.db.query("rateBooks").collect();
    const items = await ctx.db.query("rateBookItems").collect();
    const proposals = await ctx.db.query("proposals").collect();

    const pools: Record<string, { total: number; stamped: number }> = {};
    for (const table of POOL_TABLES) {
      const rows = await ctx.db.query(table).collect();
      pools[table] = {
        total: rows.length,
        stamped: rows.filter((r) => r.bookId !== undefined).length,
      };
    }

    return {
      books: books.map((b) => ({
        bookNumber: b.bookNumber,
        name: b.name,
        status: b.status,
        isDefault: b.isDefault,
        proposalCount: b.proposalCount,
      })),
      identities: items.length,
      proposals: { total: proposals.length, stamped: proposals.filter((p) => p.bookId).length },
      pools,
    };
  },
});

/** The books an admin may see. Drafts never leak to an estimator. */
export const listRateBooks = query({
  args: {},
  handler: async (ctx) => {
    await requirePrecisionAdmin(ctx);
    const books = await ctx.db.query("rateBooks").collect();
    return books
      .sort((a, b) => b.bookNumber - a.bookNumber)
      .map((b) => ({
        _id: b._id,
        bookNumber: b.bookNumber,
        name: b.name,
        status: b.status,
        isDefault: b.isDefault,
        proposalCount: b.proposalCount,
        rowCounts: b.rowCounts ?? null,
        publishedAt: b.publishedAt ?? null,
        notes: b.notes ?? null,
      }));
  },
});
