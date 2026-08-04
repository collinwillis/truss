import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePrecisionAdmin, requirePrecisionRead } from "./model/precisionAccess";
import {
  buildMatchIndex,
  matchRow,
  normalizeKey,
  type MatchCandidate,
} from "./model/rateBookMatch";
import { COLUMNS, detectPool, parseDelimited, serialize } from "./model/rateBookCsv";
import type { PoolKind } from "./model/rateBookCsv";
import { changedFields, shapeRow, toRawRows } from "./model/rateBookRows";
import { requireDraftBook, writePoolRow } from "./model/rateBookAccess";
import {
  beforeOf,
  candidateOf,
  candidatePayload,
  NO_REFS,
  toSheetRow,
  type PoolRow,
  type SheetRefs,
} from "./model/rateBookShape";

const POOL_TABLE_OF: Record<PoolKind, PoolTable> = {
  wbs: "wbsPool",
  phases: "phasePool",
  labor: "laborPool",
  equipment: "equipmentPool",
};

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
// EXPORT
// ============================================================================

/**
 * One pool of a book as a CSV, ready to open in Excel.
 *
 * Returned as text rather than a stored file: the largest pool is 5,897 rows
 * (~700KB), well inside a Convex response, and a round trip through file
 * storage would add a lifecycle to manage for no benefit the admin can see.
 *
 * ⚠️ The column list comes from `rateBookCsv.COLUMNS` and nowhere else. That
 * module's round-trip test proves a file written here and read back produces
 * zero changes; hand-rolling the header order at this call site is precisely
 * how that guarantee would be lost.
 */
export const exportPoolCsv = query({
  args: {
    bookId: v.id("rateBooks"),
    pool: v.union(
      v.literal("wbs"),
      v.literal("phases"),
      v.literal("labor"),
      v.literal("equipment")
    ),
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");

    // Reference columns need names the ids alone do not carry.
    const wbsNames = new Map<number, string>();
    const phaseNames = new Map<number, { name: string; wbsPoolId: number }>();
    if (args.pool === "phases" || args.pool === "labor") {
      for (const w of await ctx.db
        .query("wbsPool")
        .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
        .collect()) {
        wbsNames.set(w.poolId, w.name);
      }
    }
    if (args.pool === "labor") {
      for (const p of await ctx.db
        .query("phasePool")
        .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
        .collect()) {
        phaseNames.set(p.poolId, { name: p.name, wbsPoolId: p.wbsPoolId });
      }
    }

    const refs: SheetRefs =
      args.pool === "phases" || args.pool === "labor" ? { wbsNames, phases: phaseNames } : NO_REFS;

    const items = (await ctx.db
      .query(POOL_TABLE_OF[args.pool])
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .collect()) as PoolRow[];
    const rows = items
      .sort((a, b) => a.poolId - b.poolId)
      .map((row) => toSheetRow(args.pool, row, refs));

    return {
      fileName: `${book.name.replace(/[^\w.-]+/g, "_")}_${args.pool}.csv`,
      csv: serialize(COLUMNS[args.pool], rows),
      rowCount: rows.length,
    };
  },
});

// ============================================================================
// IMPORT
// ============================================================================

/**
 * Upload → parse → match → REVIEW → apply.
 *
 * ⚠️ NOTHING IS WRITTEN TO THE CATALOG BY AN UPLOAD. The whole file becomes
 * staged rows carrying a verdict, and an admin reads the verdicts before
 * anything moves. On the real labor sheet that means 1,064 rows stop and ask
 * rather than 1,064 ids quietly changing meaning.
 *
 * The work is split across an ACTION on purpose. A 5,897-row labor file read
 * and staged inside one mutation would be roughly 12,000 documents in a single
 * transaction — under Convex's 16,384 ceiling, but not by enough to bet the
 * catalog on. So the action holds the file, the pure matcher runs in its
 * memory, and the database only ever sees paginated reads and 500-row writes.
 */

/** Staged rows written per mutation. Well clear of any transaction ceiling. */
const STAGE_BATCH = 500;

/** Existing rows read per page while the action builds its match index. */
const CANDIDATE_PAGE = 2000;

/** Rows applied per scheduled batch. Each row is a read plus a guarded write. */
const APPLY_BATCH = 300;

/** A file larger than this is not a rate sheet; it is an accident. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const EMPTY_STATS = {
  total: 0,
  unchanged: 0,
  edited: 0,
  added: 0,
  conflict: 0,
  invalid: 0,
  idDisagrees: 0,
  blankNumericKept: 0,
};

/** Rows a preview says will actually be written if the admin applies it. */
export function applicableCount(stats: {
  total: number;
  unchanged: number;
  conflict: number;
  invalid: number;
}): number {
  return stats.total - stats.unchanged - stats.conflict - stats.invalid;
}

const verdictValidator = v.union(
  v.literal("unchanged"),
  v.literal("edited"),
  v.literal("added"),
  v.literal("conflict"),
  v.literal("invalid")
);

const fieldValue = v.union(v.string(), v.number(), v.boolean());

const blockKindValidator = v.union(
  v.literal("id_disagrees"),
  v.literal("possible_rename"),
  v.literal("unverified_id"),
  v.literal("invalid")
);

const stagedRowValidator = v.object({
  rowNumber: v.number(),
  verdict: verdictValidator,
  blocking: v.boolean(),
  blockKind: v.optional(blockKindValidator),
  reason: v.optional(v.string()),
  errors: v.array(v.string()),
  targetPoolId: v.optional(v.number()),
  description: v.string(),
  values: v.record(v.string(), fieldValue),
  before: v.optional(v.record(v.string(), fieldValue)),
});

/** Where the browser PUTs the file before anything else happens. */
export const generateImportUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePrecisionAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Parse a file, match every row against the draft, and stage the result.
 *
 * The uploaded file is KEPT. When someone asks in three months what the sheet
 * actually said, the answer is the sheet, not a reconstruction of it.
 */
export const stageImport = action({
  args: {
    bookId: v.id("rateBooks"),
    fileName: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args): Promise<Id<"rateBookImports">> => {
    // Authorisation BEFORE the file is read, so an upload url that leaked
    // cannot be turned into a read of somebody's catalog.
    await ctx.runQuery(internal.rateBooks.assertImportable, { bookId: args.bookId });

    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("That upload is no longer available. Try again.");
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `That file is ${Math.round(blob.size / 1024 / 1024)} MB. Rate sheets are not.`
      );
    }

    const grid = parseDelimited(await blob.text());
    if (grid.length < 2) throw new Error("That file has no rows under its header.");

    const pool = detectPool(grid[0] ?? []);
    if (!pool) {
      throw new Error(
        "Could not tell which catalog this file is for. Export a sheet from this rate book and edit that copy."
      );
    }

    const importId: Id<"rateBookImports"> = await ctx.runMutation(internal.rateBooks.beginImport, {
      bookId: args.bookId,
      fileName: args.fileName,
      storageId: args.storageId,
      pool,
    });

    try {
      // ── The existing book, paged into memory ──
      const existing: StagingCandidate[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: {
          rows: StagingCandidate[];
          continueCursor: string;
          isDone: boolean;
        } = await ctx.runQuery(internal.rateBooks.loadImportCandidates, {
          bookId: args.bookId,
          pool,
          cursor,
          numItems: CANDIDATE_PAGE,
        });
        existing.push(...page.rows);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }

      const index = buildMatchIndex(existing);
      const beforeById = new Map(existing.map((row) => [row.poolId, row.before]));

      // A new row with no sort_order goes to the END of its parent group. Zero
      // would put every addition at the top of a list people have memorised.
      const tailOrder = new Map<string, number>();
      for (const row of existing) {
        const key = String(row.parentPoolId ?? "");
        const order = typeof row.before.sortOrder === "number" ? row.before.sortOrder : 0;
        tailOrder.set(key, Math.max(tailOrder.get(key) ?? 0, order));
      }

      const { rows } = toRawRows(grid);
      const stats = { ...EMPTY_STATS, total: rows.length };
      const seenIds = new Map<number, number>();
      const seenTargets = new Map<number, number>();
      let batch: StagedRow[] = [];

      for (const raw of rows) {
        // Shape once to learn the identity, match, then shape again with the
        // answer: whether a blank number means "keep this" or "you forgot
        // something" genuinely depends on whether there is anything to keep.
        const probe = shapeRow(pool, raw, false);
        const match = matchRow(
          {
            poolId: probe.declaredId ?? -1,
            description: probe.description,
            parentPoolId: probe.parentPoolId,
            payload: candidatePayload(pool, probe.values),
            declaredId: probe.declaredId,
          },
          index
        );
        const isNew = match.matched === null;
        const shaped = shapeRow(pool, raw, isNew);
        const errors = [...shaped.errors];

        if (probe.declaredId !== undefined) {
          const duplicate = seenIds.get(probe.declaredId);
          if (duplicate !== undefined) {
            errors.push(
              `Id ${probe.declaredId} is also on row ${duplicate}. Excel fills ids down; it does not make two rows the same item.`
            );
          } else seenIds.set(probe.declaredId, raw.rowNumber);

          if (!index.byId.has(probe.declaredId)) {
            errors.push(
              `Id ${probe.declaredId} has never been issued in this rate book. Leave the id blank to add a new row.`
            );
          }
        }

        // Two lines resolving to one catalog row is a duplicated row in the
        // file, not two edits. Applying both would silently keep the last one.
        if (match.matched) {
          const first = seenTargets.get(match.matched.poolId);
          if (first !== undefined) {
            errors.push(
              `Row ${first} describes "${match.matched.description}" too. Delete one of them.`
            );
          } else seenTargets.set(match.matched.poolId, raw.rowNumber);
        }

        const before = match.matched ? beforeById.get(match.matched.poolId) : undefined;
        const changed = before ? changedFields(shaped.values, before) : [];

        let verdict: "unchanged" | "edited" | "added" | "conflict" | "invalid";
        if (errors.length > 0) verdict = "invalid";
        else if (match.blocking) verdict = "conflict";
        else if (isNew) verdict = "added";
        else if (changed.length === 0) verdict = "unchanged";
        else verdict = "edited";

        if (verdict === "added" && shaped.values.sortOrder === undefined) {
          const key = String(shaped.parentPoolId ?? "");
          const next = (tailOrder.get(key) ?? 0) + 10;
          tailOrder.set(key, next);
          shaped.values.sortOrder = next;
        }

        const blockKind =
          verdict === "invalid"
            ? ("invalid" as const)
            : verdict === "conflict"
              ? match.blockKind
              : undefined;
        stats[verdict] += 1;
        if (blockKind === "id_disagrees") stats.idDisagrees += 1;
        stats.blankNumericKept += shaped.keptBlank.length;

        batch.push({
          rowNumber: raw.rowNumber,
          verdict,
          blocking: verdict === "conflict" || verdict === "invalid",
          blockKind,
          reason: match.reason,
          errors,
          targetPoolId: match.matched?.poolId,
          description: shaped.description,
          values: shaped.values,
          before,
        });

        if (batch.length >= STAGE_BATCH) {
          await ctx.runMutation(internal.rateBooks.stageRows, { importId, rows: batch });
          batch = [];
        }
      }
      if (batch.length > 0) {
        await ctx.runMutation(internal.rateBooks.stageRows, { importId, rows: batch });
      }

      await ctx.runMutation(internal.rateBooks.finishStaging, {
        importId,
        stats,
        coverage: { inFile: rows.length, inBook: existing.length },
      });
      return importId;
    } catch (error) {
      // A half-staged file must not read as a reviewable one.
      await ctx.runMutation(internal.rateBooks.failStaging, {
        importId,
        error: error instanceof Error ? error.message : "Could not read that file.",
      });
      throw error;
    }
  },
});

export const assertImportable = internalQuery({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "draft") {
      throw new Error(
        `"${book.name}" is ${book.status} and can no longer be edited. Duplicate it as a draft to make changes.`
      );
    }
    return true;
  },
});

export const beginImport = internalMutation({
  args: {
    bookId: v.id("rateBooks"),
    fileName: v.string(),
    storageId: v.id("_storage"),
    pool: v.union(
      v.literal("wbs"),
      v.literal("phases"),
      v.literal("labor"),
      v.literal("equipment")
    ),
  },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    await requireDraftBook(ctx, args.bookId, "import");
    return await ctx.db.insert("rateBookImports", {
      bookId: args.bookId,
      pool: args.pool,
      fileName: args.fileName,
      storageId: args.storageId,
      uploadedBy: access.userId,
      uploadedAt: Date.now(),
      state: "staging",
      stats: EMPTY_STATS,
      coverage: { inFile: 0, inBook: 0 },
    });
  },
});

/** One page of the draft's catalog, shaped for matching and for before/after. */
export const loadImportCandidates = internalQuery({
  args: {
    bookId: v.id("rateBooks"),
    pool: v.union(
      v.literal("wbs"),
      v.literal("phases"),
      v.literal("labor"),
      v.literal("equipment")
    ),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const page = await ctx.db
      .query(POOL_TABLE_OF[args.pool])
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      rows: page.page.map((row) => ({
        ...candidateOf(args.pool, row as PoolRow),
        before: beforeOf(args.pool, row as PoolRow),
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const stageRows = internalMutation({
  args: { importId: v.id("rateBookImports"), rows: v.array(stagedRowValidator) },
  handler: async (ctx, args) => {
    for (const row of args.rows) {
      await ctx.db.insert("rateBookImportRows", { importId: args.importId, ...row });
    }
  },
});

export const finishStaging = internalMutation({
  args: {
    importId: v.id("rateBookImports"),
    stats: v.object({
      total: v.number(),
      unchanged: v.number(),
      edited: v.number(),
      added: v.number(),
      conflict: v.number(),
      invalid: v.number(),
      idDisagrees: v.number(),
      blankNumericKept: v.number(),
    }),
    coverage: v.object({ inFile: v.number(), inBook: v.number() }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.importId, {
      state: "review",
      stats: args.stats,
      coverage: args.coverage,
    });
  },
});

export const failStaging = internalMutation({
  args: { importId: v.id("rateBookImports"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.importId, { state: "failed", error: args.error });
    await ctx.scheduler.runAfter(0, internal.rateBooks.deleteImportRows, {
      importId: args.importId,
    });
  },
});

type StagingCandidate = MatchCandidate & { before: Record<string, string | number | boolean> };
type StagedRow = {
  rowNumber: number;
  verdict: "unchanged" | "edited" | "added" | "conflict" | "invalid";
  blocking: boolean;
  blockKind?: "id_disagrees" | "possible_rename" | "unverified_id" | "invalid";
  reason?: string;
  errors: string[];
  targetPoolId?: number;
  description: string;
  values: Record<string, string | number | boolean>;
  before?: Record<string, string | number | boolean>;
};

/** The staged file, summarised, with the rows that need a decision first. */
export const getImportPreview = query({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) return null;

    // Capped per kind, never over a mixed list. 1,064 conflicts is a real
    // answer to "what happened" and rendering all of them helps nobody decide
    // anything — but the three renames hiding under them must still be seen.
    const ofKind = async (kind: "id_disagrees" | "possible_rename" | "unverified_id" | "invalid") =>
      await ctx.db
        .query("rateBookImportRows")
        .withIndex("by_import_block_kind", (q) =>
          q.eq("importId", args.importId).eq("blockKind", kind)
        )
        .take(50);
    const ofVerdict = async (verdict: "edited" | "added") =>
      await ctx.db
        .query("rateBookImportRows")
        .withIndex("by_import_verdict", (q) =>
          q.eq("importId", args.importId).eq("verdict", verdict)
        )
        .take(100);

    const [idDisagrees, renames, unverified, invalid, edited, added] = await Promise.all([
      ofKind("id_disagrees"),
      ofKind("possible_rename"),
      ofKind("unverified_id"),
      ofKind("invalid"),
      ofVerdict("edited"),
      ofVerdict("added"),
    ]);

    const slim = (r: Doc<"rateBookImportRows">) => ({
      rowNumber: r.rowNumber,
      verdict: r.verdict,
      description: r.description,
      reason: r.reason ?? null,
      errors: r.errors,
      targetPoolId: r.targetPoolId ?? null,
      blockKind: r.blockKind ?? null,
      values: r.values,
      before: r.before ?? null,
    });

    return {
      _id: record._id,
      bookId: record.bookId,
      pool: record.pool,
      fileName: record.fileName,
      state: record.state,
      stats: record.stats,
      applicable: applicableCount(record.stats),
      coverage: record.coverage,
      error: record.error ?? null,
      policy: record.policy ?? null,
      /** The systematic one: one decision, not N. */
      idDisagrees: idDisagrees.map(slim),
      /** Ambiguous per row. No policy un-blocks these; a person decides. */
      ambiguous: [...renames, ...unverified].map(slim),
      ambiguousCount: record.stats.conflict - record.stats.idDisagrees,
      /** Not a decision — a correction. The cell could not be read at all. */
      unreadable: invalid.map(slim),
      unreadableCount: record.stats.invalid,
      edited: edited.map(slim),
      added: added.map(slim),
    };
  },
});

/** Every staged import for a book, newest first. */
export const listImports = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const records = await ctx.db
      .query("rateBookImports")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .order("desc")
      .take(25);
    return records.map((r) => ({
      _id: r._id,
      pool: r.pool,
      fileName: r.fileName,
      state: r.state,
      stats: r.stats,
      uploadedAt: r.uploadedAt,
      error: r.error ?? null,
    }));
  },
});

/**
 * Apply the staged rows that are safe to apply.
 *
 * Blocking rows are SKIPPED, never guessed at — the file gets corrected and
 * re-uploaded. Every write goes through `writePoolRow`, which re-asserts draft
 * status per row, so a publish landing mid-apply stops the apply instead of
 * writing into a book that is supposed to be frozen.
 */
export const applyImport = mutation({
  args: {
    importId: v.id("rateBookImports"),
    /**
     * Ignore the file's id column and write to the row its NAME identifies.
     *
     * Un-blocks only `id_disagrees` rows — the systematic case where the whole
     * id column has slid. Renames and unverifiable ids stay blocked, because
     * those are ambiguous per row and no policy can make them not be.
     */
    trustFileNames: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) throw new Error("Import not found.");
    if (record.state !== "review") {
      throw new Error(`This import is ${record.state}; there is nothing left to apply.`);
    }
    await requireDraftBook(ctx, record.bookId, "import");

    const trustFileNames = args.trustFileNames ?? false;
    await ctx.db.patch(args.importId, {
      state: "applying",
      // Kept on the record: "who decided to ignore the ids, and when" is
      // exactly the question someone will ask about this import later.
      policy: { trustFileNames, decidedBy: access.userId, decidedAt: Date.now() },
    });
    await ctx.scheduler.runAfter(0, internal.rateBooks.applyImportBatch, {
      importId: args.importId,
      cursor: null,
    });
    return {
      applying: applicableCount(record.stats) + (trustFileNames ? record.stats.idDisagrees : 0),
    };
  },
});

export const applyImportBatch = internalMutation({
  args: {
    importId: v.id("rateBookImports"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.importId);
    if (!record || record.state !== "applying") return { done: true };
    const table = POOL_TABLE_OF[record.pool];

    const page = await ctx.db
      .query("rateBookImportRows")
      .withIndex("by_import", (q) => q.eq("importId", args.importId))
      .paginate({ cursor: args.cursor, numItems: APPLY_BATCH });

    try {
      const trustNames = record.policy?.trustFileNames === true;
      for (const staged of page.page) {
        // The one class a policy can un-block: the file's id column disagrees
        // with the catalog, and the admin has said to go by the names.
        const unblocked = trustNames && staged.blockKind === "id_disagrees";
        const skip =
          (staged.blocking && !unblocked) ||
          staged.verdict === "unchanged" ||
          staged.appliedAt !== undefined;
        if (skip) continue;

        if (staged.targetPoolId !== undefined) {
          const target = await ctx.db
            .query(table)
            .withIndex("by_book_pool_id", (q) =>
              q.eq("bookId", record.bookId).eq("poolId", staged.targetPoolId as number)
            )
            .first();
          if (!target) {
            throw new Error(
              `Row ${staged.rowNumber} targets id ${staged.targetPoolId}, which is no longer in this book.`
            );
          }
          await writePoolRow(ctx, {
            bookId: record.bookId,
            table,
            rowId: target._id,
            patch: staged.values,
          });
        } else {
          // A new row's id comes from the counter, NEVER from the file:
          // caller-chosen ids are exactly how ids get re-pointed.
          const poolId = await mintPoolId(ctx, record.pool, staged.description, record.bookId);
          await insertPoolRow(ctx, record.pool, record.bookId, poolId, staged.values);
        }
        await ctx.db.patch(staged._id, { appliedAt: Date.now() });
      }
    } catch (error) {
      // The rows already marked applied stay applied and are skipped on retry,
      // so a failure costs the batch rather than the file.
      await ctx.db.patch(args.importId, {
        state: "failed",
        error: error instanceof Error ? error.message : "Apply failed.",
      });
      return { done: true, failed: true };
    }

    if (page.isDone) {
      await ctx.db.patch(args.importId, { state: "applied", appliedAt: Date.now() });
      return { done: true };
    }
    await ctx.scheduler.runAfter(0, internal.rateBooks.applyImportBatch, {
      importId: args.importId,
      cursor: page.continueCursor,
    });
    return { done: false };
  },
});

/** Pick up an apply that a transient failure stopped part-way. */
export const resumeImport = mutation({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) throw new Error("Import not found.");
    if (record.state !== "failed") throw new Error("That import has not failed.");
    await requireDraftBook(ctx, record.bookId, "import");
    await ctx.db.patch(args.importId, { state: "applying", error: undefined });
    await ctx.scheduler.runAfter(0, internal.rateBooks.applyImportBatch, {
      importId: args.importId,
      cursor: null,
    });
  },
});

/** Issue a brand-new catalog id and record what it was issued for. */
async function mintPoolId(
  ctx: MutationCtx,
  pool: PoolKind,
  description: string,
  bookId: Id<"rateBooks">
): Promise<number> {
  const counter = await ctx.db
    .query("rateBookCounters")
    .withIndex("by_key", (q) => q.eq("key", pool))
    .first();
  if (!counter) throw new Error(`No id counter for ${pool}. Run the foundation migration first.`);
  const poolId = counter.next;
  await ctx.db.patch(counter._id, { next: poolId + 1 });

  await ctx.db.insert("rateBookItems", {
    pool,
    poolId,
    mintKey: normalizeKey(description),
    originBookId: bookId,
    mintedBy: "import",
    mintedAt: Date.now(),
  });
  return poolId;
}

/**
 * Insert a brand-new catalog row.
 *
 * Written out per pool rather than spread through a cast: every one of these
 * tables has required fields, and a cast that silences the compiler here would
 * be the compiler telling us about a malformed document and us ignoring it.
 */
async function insertPoolRow(
  ctx: MutationCtx,
  pool: PoolKind,
  bookId: Id<"rateBooks">,
  poolId: number,
  values: Record<string, string | number | boolean>
): Promise<void> {
  const text = (key: string): string => {
    const value = values[key];
    if (typeof value !== "string") throw new Error(`New row is missing ${key}.`);
    return value;
  };
  const number = (key: string): number => {
    const value = values[key];
    if (typeof value !== "number") throw new Error(`New row is missing ${key}.`);
    return value;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const value = values[key];
    return typeof value === "boolean" ? value : fallback;
  };
  const base = {
    bookId,
    poolId,
    rowRevision: 0,
    isCustom: false,
    datasetVersion: "v1" as const,
    sortOrder: number("sortOrder"),
    isActive: flag("isActive", true),
  };

  if (pool === "wbs") {
    await ctx.db.insert("wbsPool", { ...base, name: text("name") });
    return;
  }
  if (pool === "phases") {
    await ctx.db.insert("phasePool", {
      ...base,
      name: text("name"),
      wbsPoolId: number("wbsPoolId"),
      takeoffUnit: text("takeoffUnit") || undefined,
      reservedPhaseNumber: flag("reservedPhaseNumber", false),
    });
    return;
  }
  if (pool === "labor") {
    await ctx.db.insert("laborPool", {
      ...base,
      description: text("description"),
      phasePoolId: number("phasePoolId"),
      craftConstant: number("craftConstant"),
      craftUnits: text("craftUnits"),
      weldConstant: number("weldConstant"),
      weldUnits: text("weldUnits"),
      countsTowardTakeoff: flag("countsTowardTakeoff", false),
    });
    return;
  }
  await ctx.db.insert("equipmentPool", {
    ...base,
    description: text("description"),
    hourRate: number("hourRate"),
    dayRate: number("dayRate"),
    weekRate: number("weekRate"),
    monthRate: number("monthRate"),
  });
}

/** Throw a staged file away without applying any of it. */
export const discardImport = mutation({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) return;
    if (record.state === "applying") {
      throw new Error("That import is being applied. Wait for it to finish.");
    }
    await ctx.db.patch(args.importId, { state: "discarded" });
    await ctx.scheduler.runAfter(0, internal.rateBooks.deleteImportRows, {
      importId: args.importId,
    });
  },
});

export const deleteImportRows = internalMutation({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rateBookImportRows")
      .withIndex("by_import", (q) => q.eq("importId", args.importId))
      .take(STAGE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === STAGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.rateBooks.deleteImportRows, {
        importId: args.importId,
      });
    }
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
