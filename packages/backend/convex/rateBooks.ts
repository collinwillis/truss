import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePrecisionAdmin, requirePrecisionRead } from "./model/precisionAccess";
import { normalizeKey } from "./model/rateBookMatch";
import { requireDraftBook } from "./model/rateBookAccess";

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
 * Step 3c — stamp Momentum projects.
 *
 * A project's catalog pickers resolve LIVE through its book, so a project
 * left unstamped would fall back to the default — correct today, and quietly
 * wrong the moment a second book exists. The health check treats a missing
 * `bookId` as unhealthy for the same reason.
 */
export const migrateStampProjects = internalMutation({
  args: { bookId: v.id("rateBooks"), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("momentumProjects")
      .paginate({ cursor: args.cursor ?? null, numItems: STAMP_BATCH });

    let stamped = 0;
    for (const project of page.page) {
      if (project.bookId === undefined) {
        await ctx.db.patch(project._id, { bookId: args.bookId });
        stamped += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampProjects, {
        bookId: args.bookId,
        cursor: page.continueCursor,
      });
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
    await ctx.scheduler.runAfter(0, internal.rateBooks.migrateStampProjects, {
      bookId: seeded.bookId,
    });
    return { bookId: seeded.bookId, createdBook: seeded.created, quarantined: quarantine.archived };
  },
});

// ============================================================================
// LIFECYCLE
// ============================================================================

/** Rows copied per clone batch. ~13 batches for a 6,272-row catalog. */
const CLONE_BATCH = 500;

/**
 * Start a new draft from an existing book.
 *
 * AT MOST ONE OPEN DRAFT, enforced here. A once-a-year overhaul does not need
 * parallel drafts, and two of them makes every sentence of the interface
 * ambiguous — "the draft" stops meaning anything.
 *
 * The 6,272 rows are cloned in the background because they do not fit in one
 * mutation, so the book is unusable until `buildState` reaches `ready`.
 */
export const createDraft = mutation({
  args: { parentBookId: v.id("rateBooks"), name: v.string() },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);

    const name = args.name.trim();
    if (!name) throw new Error("Give the new rate book a name.");

    const open = (await ctx.db.query("rateBooks").collect()).find(
      (b) => b.status === "draft" || b.buildState === "building"
    );
    if (open) {
      throw new Error(
        `"${open.name}" is already open as a draft. Publish or discard it before starting another.`
      );
    }

    const parent = await ctx.db.get(args.parentBookId);
    if (!parent) throw new Error("Rate book not found.");

    const counter = await ctx.db
      .query("rateBookCounters")
      .withIndex("by_key", (q) => q.eq("key", "book"))
      .first();
    const bookNumber = counter?.next ?? 2;
    if (counter) await ctx.db.patch(counter._id, { next: bookNumber + 1 });
    else await ctx.db.insert("rateBookCounters", { key: "book", next: bookNumber + 1 });

    const now = Date.now();
    const bookId = await ctx.db.insert("rateBooks", {
      bookNumber,
      name,
      status: "draft",
      parentBookId: args.parentBookId,
      isDefault: false,
      createdBy: access.userId,
      createdAt: now,
      buildState: "building",
      proposalCount: 0,
      lock: { op: "clone", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });

    await ctx.scheduler.runAfter(0, internal.rateBooks.cloneBatch, {
      bookId,
      parentBookId: args.parentBookId,
      poolIndex: 0,
      lastPoolId: -1,
    });

    return bookId;
  },
});

/**
 * Copy one batch of the parent's rows into the draft.
 *
 * Wrapped so a throw records `buildState: "failed"` rather than vanishing: a
 * scheduled Convex mutation that throws does not get to write its own failure
 * state, so without the catch a wedged clone would look identical to a slow
 * one and hold the single draft slot forever.
 */
export const cloneBatch = internalMutation({
  args: {
    bookId: v.id("rateBooks"),
    parentBookId: v.id("rateBooks"),
    poolIndex: v.number(),
    lastPoolId: v.number(),
  },
  handler: async (ctx, args) => {
    const table = POOL_TABLES[args.poolIndex];
    try {
      if (!table) {
        const counts = await countBookRows(ctx, args.bookId);
        await ctx.db.patch(args.bookId, {
          buildState: "ready",
          lock: undefined,
          buildCursor: undefined,
          rowCounts: counts,
        });
        return { done: true };
      }

      const rows = await ctx.db
        .query(table)
        .withIndex("by_book_pool_id", (q) =>
          q.eq("bookId", args.parentBookId).gt("poolId", args.lastPoolId)
        )
        .take(CLONE_BATCH);

      for (const row of rows) {
        const {
          _id: _rowId,
          _creationTime: _created,
          bookId: _book,
          rowRevision: _rev,
          ...rest
        } = row;
        await ctx.db.insert(table, { ...rest, bookId: args.bookId, rowRevision: 0 });
      }

      const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
      const nextPoolIndex = rows.length < CLONE_BATCH ? args.poolIndex + 1 : args.poolIndex;
      const nextLastPoolId = rows.length < CLONE_BATCH ? -1 : (last?.poolId ?? args.lastPoolId);

      await ctx.db.patch(args.bookId, {
        buildCursor: { pool: table, lastPoolId: nextLastPoolId, done: 0, total: 0 },
        lock: {
          op: "clone" as const,
          startedBy: "system",
          startedAt: Date.now(),
          heartbeatAt: Date.now(),
        },
      });

      await ctx.scheduler.runAfter(0, internal.rateBooks.cloneBatch, {
        bookId: args.bookId,
        parentBookId: args.parentBookId,
        poolIndex: nextPoolIndex,
        lastPoolId: nextLastPoolId,
      });
      return { done: false, copied: rows.length, pool: table };
    } catch (error) {
      await ctx.db.patch(args.bookId, {
        buildState: "failed",
        lock: undefined,
        buildError: error instanceof Error ? error.message : "Clone failed.",
      });
      return { done: true, failed: true };
    }
  },
});

async function countBookRows(
  ctx: MutationCtx,
  bookId: Id<"rateBooks">
): Promise<{ wbs: number; phases: number; labor: number; equipment: number }> {
  const count = async (table: PoolTable) =>
    (
      await ctx.db
        .query(table)
        .withIndex("by_book", (q) => q.eq("bookId", bookId))
        .collect()
    ).length;
  return {
    wbs: await count("wbsPool"),
    phases: await count("phasePool"),
    labor: await count("laborPool"),
    equipment: await count("equipmentPool"),
  };
}

/**
 * Publish a draft. One document write, and no catalog row moves.
 *
 * That is the whole payoff of keeping drafts in the same tables: publishing
 * is a status flip, so a half-published book cannot exist.
 *
 * ⚠️ ONE WAY. There is no unpublish and no edit-published. A typo in a
 * published book costs a book number, and that price is exactly what makes
 * "your estimate's numbers cannot move" a fact rather than a promise.
 */
export const publishBook = mutation({
  args: { bookId: v.id("rateBooks"), confirmName: v.string(), notes: v.string() },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const book = await requireDraftBook(ctx, args.bookId, "publish");

    // G0 — a half-built or busy book publishes a half-built state.
    if (book.buildState !== "ready") {
      throw new Error("This draft is still being built. Wait for it to finish.");
    }
    if (book.lock) {
      throw new Error(`"${book.name}" is busy (${book.lock.op}). Wait for that to finish.`);
    }

    // G4 — typed confirmation and release notes. The remaining gates (a clean
    // diff, acknowledged judgment calls, a fresh benchmark) arrive with the
    // diff in a later slice; they are deliberately absent rather than faked,
    // because a gate that does not really check is worse than no gate.
    if (args.confirmName.trim() !== book.name) {
      throw new Error("The typed name does not match this rate book.");
    }
    if (!args.notes.trim()) {
      throw new Error("Say what changed in this rate book before publishing it.");
    }

    const previousDefault = await ctx.db
      .query("rateBooks")
      .withIndex("by_default", (q) => q.eq("isDefault", true))
      .first();
    if (previousDefault && previousDefault._id !== args.bookId) {
      await ctx.db.patch(previousDefault._id, { isDefault: false });
    }

    await ctx.db.patch(args.bookId, {
      status: "published",
      isDefault: true,
      publishedAt: Date.now(),
      publishedBy: access.userId,
      notes: args.notes.trim(),
      lock: undefined,
    });

    return { bookNumber: book.bookNumber };
  },
});

/**
 * Which book new estimates pin to.
 *
 * Separate from publishing so a mis-publish has a fast remedy that does not
 * require another book.
 */
export const setDefaultBook = mutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "published") {
      throw new Error("Only a published rate book can be the default.");
    }

    const current = await ctx.db
      .query("rateBooks")
      .withIndex("by_default", (q) => q.eq("isDefault", true))
      .first();
    if (current && current._id !== args.bookId) {
      await ctx.db.patch(current._id, { isDefault: false });
    }
    await ctx.db.patch(args.bookId, { isDefault: true });
  },
});

/** Retire a published book from the pickers. Estimates on it are untouched. */
export const archiveBook = mutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.isDefault) {
      throw new Error("Make another rate book the default before archiving this one.");
    }
    await ctx.db.patch(args.bookId, { status: "archived", archivedAt: Date.now() });
  },
});

/**
 * Throw away a draft and every row it cloned.
 *
 * Batched, because a draft holds ~6,272 rows. Only ever a DRAFT: this is the
 * one delete in the subsystem, and it can only remove rows no estimate has
 * ever been able to reference.
 */
export const discardDraft = mutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "draft") {
      throw new Error("Only a draft can be discarded. A published rate book is permanent.");
    }
    await ctx.db.patch(args.bookId, {
      lock: {
        op: "discard" as const,
        startedBy: "system",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      },
    });
    await ctx.scheduler.runAfter(0, internal.rateBooks.discardBatch, {
      bookId: args.bookId,
      poolIndex: 0,
    });
  },
});

export const discardBatch = internalMutation({
  args: { bookId: v.id("rateBooks"), poolIndex: v.number() },
  handler: async (ctx, args) => {
    const table = POOL_TABLES[args.poolIndex];
    if (!table) {
      // Rows are gone; the book goes last so a failure mid-way leaves a
      // discoverable husk rather than orphaned catalog rows.
      await ctx.db.delete(args.bookId);
      return { done: true };
    }
    const rows = await ctx.db
      .query(table)
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .take(CLONE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);

    await ctx.scheduler.runAfter(0, internal.rateBooks.discardBatch, {
      bookId: args.bookId,
      poolIndex: rows.length < CLONE_BATCH ? args.poolIndex + 1 : args.poolIndex,
    });
    return { done: false, deleted: rows.length };
  },
});

/** Resume a clone that failed, from wherever it stopped. */
export const retryDraftBuild = mutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.buildState !== "failed") throw new Error("This draft is not in a failed state.");
    if (!book.parentBookId) throw new Error("This draft has no parent to copy from.");

    const poolIndex = Math.max(
      0,
      POOL_TABLES.indexOf((book.buildCursor?.pool ?? "wbsPool") as PoolTable)
    );
    await ctx.db.patch(args.bookId, { buildState: "building", buildError: undefined });
    await ctx.scheduler.runAfter(0, internal.rateBooks.cloneBatch, {
      bookId: args.bookId,
      parentBookId: book.parentBookId,
      poolIndex,
      lastPoolId: book.buildCursor?.lastPoolId ?? -1,
    });
  },
});

/** One book, with its catalog counts — the detail screen's header. */
export const getRateBook = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) return null;
    return {
      _id: book._id,
      bookNumber: book.bookNumber,
      name: book.name,
      status: book.status,
      isDefault: book.isDefault,
      buildState: book.buildState,
      buildError: book.buildError ?? null,
      proposalCount: book.proposalCount,
      rowCounts: book.rowCounts ?? null,
      notes: book.notes ?? null,
      publishedAt: book.publishedAt ?? null,
      parentBookId: book.parentBookId ?? null,
      locked: book.lock?.op ?? null,
    };
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
    const projects = await ctx.db.query("momentumProjects").collect();

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
      projects: {
        total: projects.length,
        stamped: projects.filter((p) => p.bookId !== undefined).length,
      },
      pools,
    };
  },
});

/**
 * The book new estimates are priced from.
 *
 * Read-level: an estimator browsing the catalog needs to know which book they
 * are looking at. Returns the id only — the pools screens fetch their own rows.
 */
export const getDefaultBook = query({
  args: {},
  handler: async (ctx) => {
    await requirePrecisionRead(ctx);
    const book = await ctx.db
      .query("rateBooks")
      .withIndex("by_default", (q) => q.eq("isDefault", true))
      .first();
    if (!book) return null;
    return { _id: book._id, bookNumber: book.bookNumber, name: book.name };
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
        buildState: b.buildState,
        buildError: b.buildError ?? null,
        proposalCount: b.proposalCount,
        rowCounts: b.rowCounts ?? null,
        publishedAt: b.publishedAt ?? null,
        notes: b.notes ?? null,
      }));
  },
});
