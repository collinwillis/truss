import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { requirePrecisionAdmin, requirePrecisionRead } from "./model/precisionAccess";
import {
  BENCHMARK_ACK_KEY,
  DEACTIVATED_WITH_LIVE_LINES_CAP,
  composePublishNotes,
  evaluatePublishGates,
  requiredAcknowledgements,
  type AckRequirement,
  type Acknowledgement,
  type BenchmarkFacts,
  type DeactivatedWithLiveLines,
  type DiffFacts,
  type PublishFacts,
} from "./model/publishGates";
import {
  buildMatchIndex,
  matchRow,
  normalizeKey,
  type MatchCandidate,
} from "./model/rateBookMatch";
import { COLUMNS, detectPool, parseDelimited, serialize } from "./model/rateBookCsv";
import type { PoolKind } from "./model/rateBookCsv";
import { changedFields, shapeRow, toRawRows } from "./model/rateBookRows";
import { isLockStale, requireDraftBook, touchDraft, writePoolRow } from "./model/rateBookAccess";
import {
  beforeOf,
  candidateOf,
  candidatePayload,
  NO_REFS,
  toSheetRow,
  toStoredPatch,
  type PoolRow,
  type SheetRefs,
} from "./model/rateBookShape";

/**
 * Which table a pool's rows live in.
 *
 * Exported for `catalog.ts`. A second copy of this map is a way to point a
 * write at the wrong table, and `writePoolRow` takes the table name on trust
 * because by then the pool has already been decided.
 */
export const POOL_TABLE_OF: Record<PoolKind, PoolTable> = {
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
      revertSummary: r.revertSummary ?? null,
      trustedFileNames: r.policy?.trustFileNames ?? false,
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
      lastProgressAt: Date.now(),
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
          const revision = await writePoolRow(ctx, {
            bookId: record.bookId,
            table,
            rowId: target._id,
            patch: toStoredPatch(record.pool, staged.values),
          });
          await ctx.db.patch(staged._id, { appliedRevision: revision });
        } else {
          // A new row's id comes from the counter, NEVER from the file:
          // caller-chosen ids are exactly how ids get re-pointed.
          const poolId = await mintPoolId(ctx, record.pool, staged.description, record.bookId);
          await insertPoolRow(ctx, record.pool, record.bookId, poolId, staged.values);
          await ctx.db.patch(staged._id, { appliedPoolId: poolId, appliedRevision: 0 });
        }
        await ctx.db.patch(staged._id, { appliedAt: Date.now() });
      }
    } catch (error) {
      // The rows already marked applied stay applied and are skipped on retry,
      // so a failure costs the batch rather than the file.
      await ctx.db.patch(args.importId, {
        state: "failed",
        lastProgressAt: Date.now(),
        error: error instanceof Error ? error.message : "Apply failed.",
      });
      return { done: true, failed: true };
    }

    if (page.isDone) {
      await ctx.db.patch(args.importId, {
        state: "applied",
        appliedAt: Date.now(),
        lastProgressAt: Date.now(),
      });
      return { done: true };
    }
    // ⚠️ EVERY BATCH, not only the ones that wrote something. This is the only
    // sign of life an apply gives: it takes no lock, so nothing reaps it, and
    // `resumeImport` decides a run is dead by reading this and nothing else.
    await ctx.db.patch(args.importId, { lastProgressAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.rateBooks.applyImportBatch, {
      importId: args.importId,
      cursor: page.continueCursor,
    });
    return { done: false };
  },
});

/**
 * Pick up an apply that stopped part-way.
 *
 * ⚠️ IT ACCEPTS A STALLED `applying` RUN, NOT ONLY A `failed` ONE, and that is
 * the whole reason this mutation is not a trap. A batch killed by a runtime
 * limit is a hard abort that never reaches `applyImportBatch`'s catch, so it
 * records nothing and the import keeps saying `applying` for ever. Every other
 * door out of that state is shut — `discardImport` refuses it, `revertImport`
 * refuses it, and `reapStaleLocks` cannot help because an apply takes no
 * `rateBooks.lock` at all — while G9 blocks publish on it with "wait for it to
 * finish". A resume that took only `failed` therefore left the draft
 * unpublishable and the file unresolvable, permanently, from one killed
 * mutation. That is the wedge this codebase has already shipped twice.
 *
 * Re-reading the file from the first row is safe and deliberate:
 * `applyImportBatch` skips any row already carrying `appliedAt`, so a row can
 * never be written twice however many times this is pressed.
 */
export const resumeImport = mutation({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) throw new Error("Import not found.");
    if (record.state !== "failed" && !isStalled(record, "applying")) {
      throw new Error(
        record.state === "applying"
          ? `That import is still working — it made progress ${idleSeconds(record)}s ago.`
          : `That import is ${record.state}; there is nothing to resume.`
      );
    }
    await requireDraftBook(ctx, record.bookId, "import");
    await ctx.db.patch(args.importId, {
      state: "applying",
      error: undefined,
      lastProgressAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.rateBooks.applyImportBatch, {
      importId: args.importId,
      cursor: null,
    });
  },
});

/**
 * Issue a brand-new catalog id and record what it was issued for.
 *
 * Exported so `catalog.ts` mints the same way an import does. A second minter
 * — even a correct-looking one — would be a second place the counter can be
 * advanced, and an id issued twice is the one failure `rateBookItems` exists
 * to make impossible.
 */
export async function mintPoolId(
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
 * Move the book's own count of a pool by one, in the same transaction as the row.
 *
 * ⚠️ CALL IT FROM EVERY PATH THAT ADDS OR REMOVES A ROW, AND FROM NOWHERE ELSE
 * — {@link insertPoolRow} and `revertImportBatch`'s delete, which are the only
 * two there are. It lives beside {@link touchDraft}'s call for the same reason
 * that one does: bumping at the entry mutations instead leaves a new entry point
 * free to forget, and this one was forgotten. `applyImportBatch` added rows
 * through `insertPoolRow` and never moved the count, so a file that added a
 * single labor row left the book claiming 5,897 rows while holding 5,898.
 *
 * WHAT THAT COSTS, and why it is not cosmetic. G1 compares `rowCounts` against
 * the number of rows the comparison counted and blocks when they differ, and its
 * remedy is "clone this draft again" — which throws away the import, and
 * importing the same file into the new draft reproduces the drift exactly. So a
 * count that is one out is a draft that can never be published and whose work
 * cannot be recovered, arriving from the most ordinary thing an admin does.
 *
 * ABSENT STAYS ABSENT. `backfillRowCounts` owns filling the field in for a book
 * that predates it, and G1 skips its check when there is none; inventing a count
 * from one row's arrival would turn an honest absence into a confident wrong
 * number that blocks publish instead of being ignored.
 */
async function countPoolRow(
  ctx: MutationCtx,
  bookId: Id<"rateBooks">,
  pool: PoolKind,
  by: number
): Promise<void> {
  const book = await ctx.db.get(bookId);
  if (!book?.rowCounts) return;
  await ctx.db.patch(bookId, {
    rowCounts: { ...book.rowCounts, [pool]: Math.max(0, book.rowCounts[pool] + by) },
  });
}

/**
 * Insert a brand-new catalog row.
 *
 * Written out per pool rather than spread through a cast: every one of these
 * tables has required fields, and a cast that silences the compiler here would
 * be the compiler telling us about a malformed document and us ignoring it.
 *
 * Exported for the same reason as {@link mintPoolId}: a row added in the grid
 * and a row added by an import must land as the same document, down to
 * `isCustom` and `rowRevision`, or the two paths produce catalogs that differ
 * in ways no screen shows.
 */
export async function insertPoolRow(
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

  // A row appearing is as much a content change as a row moving, and this is
  // the only path that makes one — the grid and the importer both arrive here.
  // Order against the insert does not matter: a malformed row throws and takes
  // the whole transaction, revision and count included, with it.
  await touchDraft(ctx, bookId);
  await countPoolRow(ctx, bookId, pool, 1);

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

/**
 * How long an apply or a revert may go without progress before it is treated as
 * dead.
 *
 * A batch is one Convex mutation over 300 staged rows — seconds at the outside —
 * so two minutes of silence means the chain is broken rather than slow. It is
 * the same number `activityLinks.resumeLinkRepair` and `rateBookDiff.resumeDiff`
 * already use, and it is deliberately far shorter than `STALE_LOCK_MS`: that one
 * is the unattended backstop, this is the button an admin watching a wedged
 * import can press.
 */
const STALL_AFTER_MS = 120_000;

/** How long since this import last said anything, in whole seconds. */
function idleSeconds(record: Doc<"rateBookImports">): number {
  return Math.round((Date.now() - (record.lastProgressAt ?? record.uploadedAt)) / 1000);
}

/**
 * Whether an import is sitting in a writing state that has stopped moving.
 *
 * `uploadedAt` is the fallback for records written before `lastProgressAt`
 * existed. Every one of those is long finished, so reading as stalled costs a
 * resume that finds nothing left to do — and the opposite default would leave
 * exactly the records this check exists for permanently unreachable.
 */
function isStalled(record: Doc<"rateBookImports">, state: "applying" | "reverting"): boolean {
  if (record.state !== state) return false;
  return Date.now() - (record.lastProgressAt ?? record.uploadedAt) > STALL_AFTER_MS;
}

/**
 * Put back what an import changed.
 *
 * ⚠️ ONLY rows still sitting at the revision this import produced. A row edited
 * since is left exactly as it is and counted, because an undo is not a licence
 * to overwrite somebody's later work — that is the same failure the revision
 * guard exists to prevent, arriving through a friendlier door.
 *
 * ⚠️ IT IS ALSO THE RESUME FOR ITS OWN LANE, for the reason {@link resumeImport}
 * gives at length: a revert batch killed by a runtime limit leaves the record in
 * `reverting` with nothing that will ever move it, and G9 blocks publish on that
 * state. Restarting from the first staged row is safe — `revertImportBatch`
 * skips any row already carrying `revertedAt`.
 */
export const revertImport = mutation({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) throw new Error("Import not found.");
    // A part-applied file is exactly when someone wants this, so a failed
    // apply is revertable too.
    const resumable = isStalled(record, "reverting");
    if (record.state !== "applied" && record.state !== "failed" && !resumable) {
      throw new Error(
        record.state === "reverting"
          ? `That revert is still working — it made progress ${idleSeconds(record)}s ago.`
          : "Only an applied import can be reverted."
      );
    }
    await requireDraftBook(ctx, record.bookId, "revert");

    await ctx.db.patch(args.importId, {
      state: "reverting",
      lastProgressAt: Date.now(),
      // ⚠️ THE SUMMARY COUNTS THIS PASS, NOT THE FILE. A row already put back
      // carries `revertedAt` and is passed over silently, so a revert resumed
      // half way reports fewer rows than it undid in total. That is the honest
      // trade for the property that matters more: no row is ever put back twice,
      // however many times this is pressed. It was already true of a resumed
      // `failed` revert; a stalled one reaches it by the same road.
      revertSummary: { restored: 0, skipped: 0 },
    });
    await ctx.scheduler.runAfter(0, internal.rateBooks.revertImportBatch, {
      importId: args.importId,
      cursor: null,
    });
  },
});

export const revertImportBatch = internalMutation({
  args: { importId: v.id("rateBookImports"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.importId);
    if (!record || record.state !== "reverting") return { done: true };
    const table = POOL_TABLE_OF[record.pool];

    const page = await ctx.db
      .query("rateBookImportRows")
      .withIndex("by_import", (q) => q.eq("importId", args.importId))
      .paginate({ cursor: args.cursor, numItems: APPLY_BATCH });

    let restored = 0;
    let skipped = 0;
    for (const staged of page.page) {
      if (staged.appliedAt === undefined || staged.revertedAt !== undefined) continue;

      const poolId = staged.appliedPoolId ?? staged.targetPoolId;
      if (poolId === undefined) continue;
      const row = await ctx.db
        .query(table)
        .withIndex("by_book_pool_id", (q) => q.eq("bookId", record.bookId).eq("poolId", poolId))
        .first();
      if (!row) {
        skipped += 1;
        continue;
      }
      if ((row.rowRevision ?? 0) !== staged.appliedRevision) {
        // Edited since. Left alone, and said so.
        skipped += 1;
        continue;
      }

      if (staged.appliedPoolId !== undefined) {
        // A row this import ADDED. Removing it is safe — a draft has no
        // estimates priced from it — and the id stays spent in rateBookItems
        // so it can never come to mean something else.
        await ctx.db.delete(row._id);
        // The third writer of a pool row, and the one that does not go through
        // `writePoolRow`. A revert that left the revision alone would leave a
        // diff of the catalog as it was BEFORE the undo reading as current, and
        // G5 would wave it through; one that left the count alone would leave
        // the book claiming a row it no longer holds, and G1 blocks on that with
        // no remedy but discarding the draft.
        await touchDraft(ctx, record.bookId);
        await countPoolRow(ctx, record.bookId, record.pool, -1);
      } else if (staged.before) {
        await writePoolRow(ctx, {
          bookId: record.bookId,
          table,
          rowId: row._id,
          patch: toStoredPatch(record.pool, staged.before),
        });
      }
      await ctx.db.patch(staged._id, { revertedAt: Date.now() });
      restored += 1;
    }

    const summary = record.revertSummary ?? { restored: 0, skipped: 0 };
    const next = { restored: summary.restored + restored, skipped: summary.skipped + skipped };
    if (page.isDone) {
      await ctx.db.patch(args.importId, {
        state: "reverted",
        revertSummary: next,
        lastProgressAt: Date.now(),
      });
      return { done: true };
    }
    // The revert's only sign of life, for the reason `applyImportBatch` gives.
    await ctx.db.patch(args.importId, { revertSummary: next, lastProgressAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.rateBooks.revertImportBatch, {
      importId: args.importId,
      cursor: page.continueCursor,
    });
    return { done: false };
  },
});

/** Throw a staged file away without applying any of it. */
export const discardImport = mutation({
  args: { importId: v.id("rateBookImports") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const record = await ctx.db.get(args.importId);
    if (!record) return;
    // Only an unapplied file may be thrown away. Once rows have been written,
    // these staged rows ARE the audit trail and the only thing a revert can
    // read — deleting them would quietly remove the undo.
    if (record.state !== "review") {
      throw new Error(
        record.state === "applying"
          ? "That import is being applied. Wait for it to finish."
          : "That import has already been applied. Revert it instead of discarding it."
      );
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

// ============================================================================
// PUBLISHING — the gates, the facts they read, and the signatures they demand
// ============================================================================
//
// `model/publishGates.ts` decides everything and touches no `ctx`, on purpose:
// every gate is answered from integers, bounded lists and stored summaries, so
// `publishBook` stays ONE transaction with ONE write to the book document. This
// half of the boundary is the half that can break that — it is the code doing
// the reading — so every read below is capped and the arithmetic is written
// down against Convex's 16,384-document ceiling, the one that killed the link
// repair with an abort no catch could record.

/**
 * A gate said no, and the screen has to show which.
 *
 * ⚠️ `ConvexError` with a `kind`, never a plain `Error`. Convex redacts a plain
 * error's message on a production deployment, so a client that recognises a
 * refusal by matching its wording works in development and degrades to "an
 * error occurred" in front of a customer — see `STALE_ROW` in
 * `model/rateBookAccess.ts`. Publishing is precisely where that strands
 * somebody: the three refusals here have three different remedies, and one of
 * them is not a failure at all.
 *
 * The error's data carries every blocking gate, so the button and the readiness
 * panel cannot disagree about why nothing happened.
 */
export const PUBLISH_BLOCKED = "publish_blocked" as const;

/**
 * The draft moved between the screen rendering and the button being pressed.
 *
 * Its own kind because the remedy is "reload and read the comparison again",
 * not "fix something" — nothing is wrong with the draft, the admin is simply
 * holding a description of a catalog that no longer exists.
 */
export const PUBLISH_SUPERSEDED = "publish_superseded" as const;

/**
 * It had already gone through, and that is not a failure.
 *
 * Two clicks are already safe — Convex mutations are serializable — but the
 * refusal used to read as an error, which teaches people to distrust the
 * button. This kind exists so the second click can be reported as the success
 * it describes.
 */
export const PUBLISH_ALREADY_DONE = "publish_already_done" as const;

/**
 * Nothing on this draft is asking that question.
 *
 * The commonest cause is not a typo: the draft moved, or the comparison was run
 * again, so the requirement the screen was showing no longer exists. The remedy
 * is to reload, and the UI has to be able to say so rather than showing a
 * generic failure over a signature the admin believes they just gave.
 */
export const ACK_NOT_REQUIRED = "ack_not_required" as const;

/** This requirement is one of the ones that says something is probably WRONG. */
export const ACK_NEEDS_REASON = "ack_needs_reason" as const;

/**
 * The benchmark's signature lives on the benchmark, not in this table.
 *
 * `publishGates` composes its sentence with every other requirement so the
 * wording is written once, but satisfies it from `rateBookBenchmarks`, so there
 * is exactly one source of truth for "this benchmark was read". A row written
 * here for that key would satisfy nothing and look signed.
 */
export const ACK_BENCHMARK_ELSEWHERE = "ack_benchmark_elsewhere" as const;

/**
 * Signatures read out of the acknowledgement table in one transaction.
 *
 * Read through `by_book_revision` at the CURRENT revision only, so the cost is
 * bounded by how many questions this draft is asking right now rather than by
 * how many it has ever asked. 500 is far past that: the outstanding list is at
 * most {@link DEACTIVATED_WITH_LIVE_LINES_CAP} retirements plus a fixed handful
 * of flag, pool and band requirements.
 *
 * Past the cap a signature simply is not seen, so its requirement stays
 * outstanding and publish is BLOCKED. The cap fails toward refusing, which is
 * the only direction a cap on this read may fail.
 */
const ACK_READ_CAP = 500;

/** Open imports read per state. G9 names one file per class; twenty is generous. */
const IMPORT_READ_CAP = 20;

/**
 * How many retirements are examined for live activity lines at all.
 *
 * ⚠️ THE ONE UNBOUNDED READ IN `PublishFacts`, capped here. Every other fact the
 * gates read is an integer, a bounded list or a stored summary; this one costs
 * an index read per deactivated row INSIDE the publish transaction, and a draft
 * that retires 400 rows at once is a designed-for case.
 *
 * 2,000 is chosen so the cap is unreachable by any book anybody would publish
 * rather than as a working limit: `massChangeFraction` is 0.05, so 295 labor
 * rows or 7 equipment rows already trip the pool-scoped `mass_deactivation`
 * requirement, and a draft retiring 2,000 labor rows is at 34% of the pool with
 * that requirement long since on the screen carrying the true figure.
 *
 * Past it the remainder is COUNTED INTO `beyondCap` WITHOUT BEING EXAMINED,
 * which deliberately overstates: some of those rows may have no live lines at
 * all. The alternative is a retirement nobody was asked about, and at this size
 * the question has already stopped being "is this item right" and become "is
 * this retirement right", which is what the beyond-cap requirement asks.
 */
const RETIREMENT_PROBE_CAP = 2000;

/**
 * Activity lines counted per listed retirement.
 *
 * ⚠️ IT IS A FLOOR, NOT A CENSUS. A row with 3,000 live lines is reported as
 * 100. The arithmetic is why: the 50 listed retirements are the expensive half
 * of this gathering, so an exact count of a popular labor id — some appear on
 * every phase of every estimate — would be tens of thousands of document reads
 * inside a transaction whose entire design property is that it is one atomic
 * write.
 *
 * 100 is roughly three times the average lines-per-labor-id across the ~200,000
 * activity lines, and the remedy the sentence asks for does not change between
 * 100 and 3,000: the item is in use, and retiring it breaks every one of them at
 * the next re-pick. Anyone quoting the number as exact is quoting a floor.
 */
const RETIREMENT_LINE_CAP = 100;

/**
 * What a draft with no parent is compared against, in the gates' prose.
 *
 * `createDraft` always sets `parentBookId`, so this reaches a sentence only for
 * book #1 — which is published and can never be a draft. Named rather than left
 * as `""`, which renders as a bug in the middle of a message about a real book.
 */
const NO_PARENT_BOOK_NAME = "(no parent book)";

/**
 * The revision stamp of a comparison that never finished.
 *
 * ⚠️ NOT `startedAtContentRevision`. A finish stamp defaulted to the start stamp
 * is exactly the torn read G5 exists to catch, arriving as a clean one. No gate
 * reads this field unless the run is `ready` — and a ready run always has a real
 * one — so the value's only job is to be obviously impossible if a future gate
 * ever does.
 */
const UNREADABLE_REVISION = -1;

/**
 * The import states that are still somebody's decision, derived rather than typed.
 *
 * ⚠️ THE DRIFT ONLY GOES ONE WAY HERE, AND THE OTHER LIST IS NOT SO LUCKY.
 * Naming the three FINISHED states and deriving the rest means a sixth
 * unfinished state added to the schema is gathered without anyone editing this
 * file — the safe direction, because a state nobody queries is an import that
 * reaches no gate. `publishGates` keeps its own hand-written list of five and
 * filters `openImports` through it, because a `completed` import handed over
 * once produced `"labor.csv" is still being read (applied)` — a confident
 * sentence about a file that finished.
 *
 * So the two halves fail in opposite directions and only one of them is derived:
 * a sixth unfinished state would be gathered here and then DROPPED by that
 * filter, and G9 would pass. Adding a state to `rateBookImports` therefore means
 * editing `OPEN_IMPORT_STATES` in `model/publishGates.ts` too, and nothing in
 * either file will say so.
 */
const FINISHED_IMPORT_STATES: ReadonlySet<Doc<"rateBookImports">["state"]> = new Set([
  "applied",
  "reverted",
  "discarded",
]);

const UNFINISHED_IMPORT_STATES: readonly Doc<"rateBookImports">["state"][] =
  schema.tables.rateBookImports.validator.fields.state.members
    .map((member) => member.value)
    .filter((state) => !FINISHED_IMPORT_STATES.has(state));

/** The stored `DiffSummary`, which carries more than the gates read. */
type StoredDiffSummary = NonNullable<Doc<"rateBookDiffs">["summary"]>;

/** What the admin typed and which revision they were looking at. */
interface PublishForm {
  typedName: string;
  typedNotes: string;
  /** Absent means the screen did not say — G10 blocks on that rather than guessing. */
  expectedContentRevision?: number;
}

/** Everything read out of the database once, for whichever caller needs it. */
interface PublishInputs {
  book: Doc<"rateBooks">;
  parentBookName: string;
  diffRun: Doc<"rateBookDiffs"> | null;
  benchmarkRun: Doc<"rateBookBenchmarks"> | null;
  /** The READY comparison's summary, or nothing. The gates' own narrowing. */
  diffFacts?: DiffFacts;
  benchmarkFacts?: BenchmarkFacts;
  diffRecord?: PublishFacts["diff"];
  benchmarkRecord?: PublishFacts["benchmark"];
  acknowledgements: Acknowledgement[];
  unpinnedProposals: boolean;
  unpinnedProjects: boolean;
  openImports: { fileName: string; state: string; pool: string }[];
  deactivatedWithLiveLines: DeactivatedWithLiveLines[];
  deactivatedWithLiveLinesBeyondCap: number;
}

/**
 * A comparison that produced no numbers, in the shape the gates expect.
 *
 * ⚠️ NEVER READ, AND {@link gatherPublishInputs} IS WHAT MAKES THAT TRUE. The
 * gates narrow to `state === "ready"` before touching a summary, and a stored
 * run that says `ready` while carrying no summary is reported as `failed` — so
 * there is no path from this object to a sentence. It exists because
 * `PublishFacts.diff.summary` is not optional: G5 has to distinguish "still
 * running" from "nothing has been compared", and it can only do that if the
 * record is handed over.
 *
 * Written out rather than derived: `Record<DiffFlag, number>` refuses to compile
 * without every flag, so a thirteenth one added to `publishGates` fails here
 * instead of arriving as a count that is quietly always zero.
 */
function zeroedDiffFacts(): DiffFacts {
  return {
    pools: [],
    changedRowCount: 0,
    unchangedRowCount: 0,
    flagCounts: {
      shifted_payload: 0,
      description_swap: 0,
      decimal_shift: 0,
      implausible_magnitude: 0,
      large_change: 0,
      zeroed_constant: 0,
      constant_activated: 0,
      unit_changed: 0,
      rate_tier_inversion: 0,
      reparented: 0,
      takeoff_flags_bulk: 0,
      live_read_field: 0,
    },
    effectCounts: { priced_at_creation: 0, read_live: 0 },
    shiftBands: [],
    systematicGroups: [],
    changedLaborPoolIds: [],
    changedEquipmentPoolIds: [],
    bulkEditPools: [],
    massChangePools: [],
    takeoffFlagBulkPhases: [],
    thresholds: { largeChangeRatio: 0, massChangeFraction: 0 },
  };
}

/**
 * A benchmark that measured nothing, in the shape the gates expect.
 *
 * Unreachable for the same reason as {@link zeroedDiffFacts}, and dangerous for
 * a sharper one: a confident, correct, meaningless `$0.00` is the single worst
 * thing this screen could print. `measuredNothing` is `true` so that even if a
 * future gate did reach it, the sentence it produces says "it has told you
 * nothing" rather than naming a number.
 */
function zeroedBenchmarkFacts(parentBookName: string): BenchmarkFacts {
  return {
    parentBookName,
    proposalsCompared: 0,
    selfCheckFailures: [],
    cost: { delta: 0 },
    deltaPctOfRepricedLabor: 0,
    deltaPctOfGrandTotal: 0,
    carriedDollars: {
      overriddenLabor: 0,
      mismatchedLabor: 0,
      retiredUnderDraftLabor: 0,
      unitRedefinedLabor: 0,
      danglingLabor: 0,
      unlinkedLabor: 0,
      equipment: 0,
      materialAndSub: 0,
    },
    estimatesUnmoved: 0,
    coverage: { changedLaborPoolIds: 0, exercisedLaborPoolIds: 0 },
    equipment: { linesTotal: 0, linesCorroborated: 0 },
    caveats: [],
    measuredNothing: true,
  };
}

/**
 * Retired draft rows that estimates are still pointing at, and how many more
 * there were.
 *
 * WHY THE DEACTIVATED SET COMES OFF THE COMPARISON rather than out of the draft:
 * finding it in the draft means scanning four pools for `isActive: false`, which
 * is the 12,000-row read the gates module calls a permanent constraint. The
 * comparison already computed it, bounded, and stored it. With no ready
 * comparison there is no list — and G1, G2, G3 and G5 are all blocking anyway.
 *
 * WBS and phases are not probed. `activities` references a catalog item by
 * `laborPoolId` or `equipmentPoolId` and by nothing else, so those are the only
 * two pools where "a live line points at this" is a question with an answer.
 *
 * COST, against the 16,384 ceiling: at most {@link RETIREMENT_PROBE_CAP} index
 * probes, of which the first {@link DEACTIVATED_WITH_LIVE_LINES_CAP} with a hit
 * read up to {@link RETIREMENT_LINE_CAP} lines and one row for the description —
 * 50 × 101 + 1,950 + 50 ≈ 7,050 documents, 43%, in the worst case this design
 * admits. The realistic case is a handful of retirements and a few dozen reads.
 */
async function gatherRetirements(
  ctx: QueryCtx,
  bookId: Id<"rateBooks">,
  summary: StoredDiffSummary | undefined
): Promise<{ listed: DeactivatedWithLiveLines[]; beyondCap: number }> {
  if (!summary) return { listed: [], beyondCap: 0 };

  const candidates = [
    ...summary.deactivatedPoolIds.labor.map((poolId) => ({ pool: "labor" as const, poolId })),
    ...summary.deactivatedPoolIds.equipment.map((poolId) => ({
      pool: "equipment" as const,
      poolId,
    })),
  ];

  const listed: DeactivatedWithLiveLines[] = [];
  let beyondCap = 0;

  for (const [index, candidate] of candidates.entries()) {
    if (index >= RETIREMENT_PROBE_CAP) {
      beyondCap += candidates.length - index;
      break;
    }

    // Once the list is full the only question left is "is there one at all", and
    // that is a single document instead of a hundred.
    const wanted = listed.length < DEACTIVATED_WITH_LIVE_LINES_CAP ? RETIREMENT_LINE_CAP : 1;
    const lines =
      candidate.pool === "labor"
        ? await ctx.db
            .query("activities")
            .withIndex("by_labor_pool", (q) => q.eq("laborPoolId", candidate.poolId))
            .take(wanted)
        : await ctx.db
            .query("activities")
            .withIndex("by_equipment_pool", (q) => q.eq("equipmentPoolId", candidate.poolId))
            .take(wanted);

    if (lines.length === 0) continue;
    if (listed.length >= DEACTIVATED_WITH_LIVE_LINES_CAP) {
      beyondCap += 1;
      continue;
    }

    const row =
      candidate.pool === "labor"
        ? await ctx.db
            .query("laborPool")
            .withIndex("by_book_pool_id", (q) =>
              q.eq("bookId", bookId).eq("poolId", candidate.poolId)
            )
            .first()
        : await ctx.db
            .query("equipmentPool")
            .withIndex("by_book_pool_id", (q) =>
              q.eq("bookId", bookId).eq("poolId", candidate.poolId)
            )
            .first();

    listed.push({
      pool: candidate.pool,
      poolId: candidate.poolId,
      // A row the comparison named and the draft no longer holds means the two
      // have diverged, which G5 blocks on. The id keeps the sentence readable in
      // the meantime rather than printing `undefined` inside a quotation mark.
      description: row?.description ?? `${candidate.pool} id ${candidate.poolId}`,
      lines: lines.length,
    });
  }

  return { listed, beyondCap };
}

/**
 * Every fact the gates decide from, read once.
 *
 * Shared by the readiness query, the publish mutation and the acknowledgement
 * mutation on purpose: a screen that says a draft is ready and a button that
 * refuses it is the failure this whole subsystem is trying to stop being
 * plausible, and two gatherings is how that happens.
 */
async function gatherPublishInputs(ctx: QueryCtx, book: Doc<"rateBooks">): Promise<PublishInputs> {
  const revision = book.contentRevision ?? 0;

  const parent = book.parentBookId ? await ctx.db.get(book.parentBookId) : null;
  const parentBookName = parent?.name ?? NO_PARENT_BOOK_NAME;

  const diffRun = await ctx.db
    .query("rateBookDiffs")
    .withIndex("by_book", (q) => q.eq("bookId", book._id))
    .order("desc")
    .first();
  const benchmarkRun = await ctx.db
    .query("rateBookBenchmarks")
    .withIndex("by_book", (q) => q.eq("bookId", book._id))
    .order("desc")
    .first();

  // ⚠️ A run that says `ready` and carries no result IS a failed run, and saying
  // so here is what keeps the zeroed placeholders unreachable. The alternative is
  // a gate reading a summary of nothing as a summary of a draft that changed
  // nothing — and G5 answers those two with different sentences, one of which
  // spends a book number.
  const diffSummary = diffRun?.state === "ready" ? diffRun.summary : undefined;
  const benchmarkReport = benchmarkRun?.state === "ready" ? benchmarkRun.report : undefined;

  const diffRecord: PublishFacts["diff"] = diffRun
    ? {
        state: diffRun.state === "ready" && !diffSummary ? "failed" : diffRun.state,
        summary: diffSummary ?? zeroedDiffFacts(),
        startedAtContentRevision: diffRun.startedAtContentRevision,
        finishedAtContentRevision: diffRun.finishedAtContentRevision ?? UNREADABLE_REVISION,
        reviewedBy: diffRun.reviewedBy,
        reviewedAtContentRevision: diffRun.reviewedAtContentRevision,
      }
    : undefined;

  const benchmarkRecord: PublishFacts["benchmark"] = benchmarkRun
    ? {
        state: benchmarkRun.state === "ready" && !benchmarkReport ? "failed" : benchmarkRun.state,
        report: benchmarkReport ?? zeroedBenchmarkFacts(parentBookName),
        basedOnContentRevision: benchmarkRun.basedOnContentRevision,
        acknowledgedBy: benchmarkRun.acknowledgedBy,
        acknowledgedAtContentRevision: benchmarkRun.acknowledgedAtContentRevision,
      }
    : undefined;

  const acknowledgements = (
    await ctx.db
      .query("rateBookAcknowledgements")
      .withIndex("by_book_revision", (q) =>
        q.eq("bookId", book._id).eq("atContentRevision", revision)
      )
      .take(ACK_READ_CAP)
  ).map((row) => ({
    key: row.key,
    coveredRowCount: row.coveredRowCount,
    atContentRevision: row.atContentRevision,
    by: row.by,
    at: row.at,
    reason: row.reason,
  }));

  const openImports: PublishInputs["openImports"] = [];
  for (const state of UNFINISHED_IMPORT_STATES) {
    const records = await ctx.db
      .query("rateBookImports")
      .withIndex("by_book_state", (q) => q.eq("bookId", book._id).eq("state", state))
      .take(IMPORT_READ_CAP);
    for (const record of records) {
      openImports.push({ fileName: record.fileName, state: record.state, pool: record.pool });
    }
  }

  // ⚠️ READ LIVE, and `.take(1)` is the whole read. The 6-hourly proposals sync
  // creates unpinned estimates on its own, so any precomputed figure is wrong
  // within six hours of being written — and G8's decision is an EXISTENCE, so
  // spending 500 reads inside the publish transaction to put a number on a
  // sentence nobody acts on differently would buy nothing.
  const unpinnedProposals =
    (
      await ctx.db
        .query("proposals")
        .withIndex("by_book", (q) => q.eq("bookId", undefined))
        .take(1)
    ).length > 0;
  const unpinnedProjects =
    (
      await ctx.db
        .query("momentumProjects")
        .withIndex("by_book", (q) => q.eq("bookId", undefined))
        .take(1)
    ).length > 0;

  const retirements = await gatherRetirements(ctx, book._id, diffSummary);

  return {
    book,
    parentBookName,
    diffRun,
    benchmarkRun,
    diffFacts: diffSummary,
    benchmarkFacts: benchmarkReport,
    diffRecord,
    benchmarkRecord,
    acknowledgements,
    unpinnedProposals,
    unpinnedProjects,
    openImports,
    deactivatedWithLiveLines: retirements.listed,
    deactivatedWithLiveLinesBeyondCap: retirements.beyondCap,
  };
}

/** The gathered facts plus what the admin typed, as the module wants them. */
function publishFacts(inputs: PublishInputs, form: PublishForm): PublishFacts {
  return {
    book: {
      name: inputs.book.name,
      bookNumber: inputs.book.bookNumber,
      parentBookName: inputs.parentBookName,
      status: inputs.book.status,
      buildState: inputs.book.buildState,
      lockOp: inputs.book.lock?.op,
      contentRevision: inputs.book.contentRevision ?? 0,
      // What the UI told them to type is the book's own name; what they typed is
      // the form field. One word for each, so neither can come to mean the other.
      confirmName: inputs.book.name,
      typedName: form.typedName,
      typedNotes: form.typedNotes,
      recordedRowCounts: inputs.book.rowCounts,
      expectedContentRevision: form.expectedContentRevision,
    },
    diff: inputs.diffRecord,
    benchmark: inputs.benchmarkRecord,
    acknowledgements: inputs.acknowledgements,
    unpinnedProposals: inputs.unpinnedProposals,
    unpinnedProjects: inputs.unpinnedProjects,
    openImports: inputs.openImports,
    deactivatedWithLiveLines: inputs.deactivatedWithLiveLines,
    deactivatedWithLiveLinesBeyondCap: inputs.deactivatedWithLiveLinesBeyondCap,
  };
}

/** Every question this draft is asking right now, whoever is asking for them. */
function requirementsOf(inputs: PublishInputs): readonly AckRequirement[] {
  return requiredAcknowledgements(
    inputs.diffFacts,
    inputs.benchmarkFacts,
    inputs.deactivatedWithLiveLines,
    inputs.deactivatedWithLiveLinesBeyondCap
  );
}

/** A gate as a screen renders it — `undefined` is not a Convex value. */
function gateRow(gate: {
  id: string;
  name: string;
  verdict: string;
  message?: string;
  detail?: Readonly<Record<string, number | string | boolean>>;
}) {
  return {
    id: gate.id,
    name: gate.name,
    verdict: gate.verdict,
    message: gate.message ?? null,
    detail: gate.detail ?? null,
  };
}

/** An outstanding requirement as a screen renders it. */
function requirementRow(item: AckRequirement) {
  return {
    key: item.key,
    scope: item.scope,
    flag: item.flag ?? null,
    pool: item.pool ?? null,
    poolId: item.poolId ?? null,
    coveredRowCount: item.coveredRowCount,
    requiresTypedReason: item.requiresTypedReason,
    text: item.text,
  };
}

/**
 * Every gate, what it blocks on, and what is left to sign.
 *
 * ⚠️ IT SUPPLIES `expectedContentRevision` FROM THE BOOK ITSELF, so G10 passes
 * here and does real work in `publishBook`. That is not the gate going soft: a
 * Convex query re-runs when the book changes, so at the moment this answer is
 * rendered the screen genuinely IS showing the draft that exists. What G10
 * actually catches is the gap between that render and the click, and only the
 * mutation can see it — which is why `contentRevision` comes back here and has
 * to be handed straight to `publishBook`.
 *
 * `typedName` and `typedNotes` are optional so the panel can be read before
 * anybody types anything; G4 then blocks, which is the truth at that moment.
 */
export const getPublishReadiness = query({
  args: {
    bookId: v.id("rateBooks"),
    typedName: v.optional(v.string()),
    typedNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) return null;

    const inputs = await gatherPublishInputs(ctx, book);
    const revision = book.contentRevision ?? 0;
    const readiness = evaluatePublishGates(
      publishFacts(inputs, {
        typedName: args.typedName ?? "",
        typedNotes: args.typedNotes ?? "",
        expectedContentRevision: revision,
      })
    );

    return {
      bookId: book._id,
      bookNumber: book.bookNumber,
      name: book.name,
      status: book.status,
      buildState: book.buildState,
      /** Hand this back to `publishBook` — it is the token G10 checks. */
      contentRevision: revision,
      canPublish: readiness.canPublish,
      gates: readiness.gates.map(gateRow),
      blocking: readiness.blocking.map(gateRow),
      outstandingAcknowledgements: readiness.outstandingAcknowledgements.map(requirementRow),
      diff: inputs.diffRun ? { _id: inputs.diffRun._id, state: inputs.diffRun.state } : null,
      benchmark: inputs.benchmarkRun
        ? { _id: inputs.benchmarkRun._id, state: inputs.benchmarkRun.state }
        : null,
      /**
       * The truncation, as a number rather than only as prose. Without it a
       * screen can render "and 340 more" and still have no way to know that it
       * is showing 50 questions out of 390.
       */
      retirements: {
        listed: inputs.deactivatedWithLiveLines.length,
        beyondCap: inputs.deactivatedWithLiveLinesBeyondCap,
      },
    };
  },
});

/**
 * Put a name against one judgement call, at the revision it is about.
 *
 * ⚠️ THE REQUIREMENT IS LOOKED UP, NEVER TAKEN FROM THE CALLER. `coveredRowCount`
 * is what makes a signature stop counting when four more rows arrive, and a
 * client that supplied its own could sign for 4,000 rows of a diff that found
 * three. So the key is matched against what the gates are demanding right now,
 * and everything else on the row — scope, flag, pool, how many rows it covers —
 * is copied from the requirement.
 *
 * Re-signing the same requirement at the same revision PATCHES rather than
 * inserts, so the table holds one signature per question per revision. Older
 * revisions' rows are left alone: they are already void by
 * `acknowledgementSatisfied`'s revision test, and they are the audit trail of
 * what somebody agreed to before the draft moved.
 */
export const acknowledgeJudgementCall = mutation({
  args: {
    bookId: v.id("rateBooks"),
    key: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "draft") {
      throw new Error(`"${book.name}" is ${book.status}; there is nothing left to decide.`);
    }

    if (args.key === BENCHMARK_ACK_KEY) {
      throw new ConvexError({
        kind: ACK_BENCHMARK_ELSEWHERE,
        message:
          "A benchmark is signed on the benchmark itself, so there is one record of who read " +
          "it. Open the benchmark and acknowledge it there.",
      });
    }

    const inputs = await gatherPublishInputs(ctx, book);
    const requirement = requirementsOf(inputs).find((item) => item.key === args.key);
    if (!requirement) {
      throw new ConvexError({
        kind: ACK_NOT_REQUIRED,
        message:
          "Nothing on this draft is asking that question any more. The draft may have changed, " +
          "or the comparison may have been run again — reload the publish screen and read what " +
          "it asks now.",
      });
    }

    const reason = (args.reason ?? "").trim();
    if (requirement.requiresTypedReason && reason === "") {
      throw new ConvexError({
        kind: ACK_NEEDS_REASON,
        message:
          "This one needs a reason in your own words. It is on the list because something looks " +
          "wrong rather than because something looks large, and the reason is the part a person " +
          "reads later.",
      });
    }

    // Which requirements survive with no comparison is the module's decision, so
    // it is asked rather than guessed at from the key's prefix. The ones that do
    // are gathered live from the draft and belong to no comparison.
    const fromDraft = new Set(
      requiredAcknowledgements(
        undefined,
        undefined,
        inputs.deactivatedWithLiveLines,
        inputs.deactivatedWithLiveLinesBeyondCap
      ).map((item) => item.key)
    );

    const revision = book.contentRevision ?? 0;
    const now = Date.now();
    const existing = (
      await ctx.db
        .query("rateBookAcknowledgements")
        .withIndex("by_book_key", (q) => q.eq("bookId", args.bookId).eq("key", args.key))
        .collect()
    ).find((row) => row.atContentRevision === revision);

    const record = {
      coveredRowCount: requirement.coveredRowCount,
      by: access.userId,
      at: now,
      reason: reason === "" ? undefined : reason,
    };

    if (existing) await ctx.db.patch(existing._id, record);
    else {
      await ctx.db.insert("rateBookAcknowledgements", {
        bookId: args.bookId,
        diffId: fromDraft.has(args.key) ? undefined : inputs.diffRun?._id,
        key: requirement.key,
        scope: requirement.scope,
        flag: requirement.flag,
        pool: requirement.pool,
        poolId: requirement.poolId,
        atContentRevision: revision,
        ...record,
      });
    }

    return { key: requirement.key, atContentRevision: revision, ...record };
  },
});

/**
 * Which refusal this is, decided from the gates rather than re-derived.
 *
 * Two of G10's branches are not really objections — one is a success and one is
 * a stale screen — and folding them into a red list of blocking checks is how
 * people learn to distrust the button. Everything else is a genuine block.
 */
function publishRefusalKind(
  facts: PublishFacts,
  blocking: readonly { id: string }[]
): typeof PUBLISH_BLOCKED | typeof PUBLISH_SUPERSEDED | typeof PUBLISH_ALREADY_DONE {
  if (!blocking.some((gate) => gate.id === "G10")) return PUBLISH_BLOCKED;
  if (facts.book.status === "published") return PUBLISH_ALREADY_DONE;
  if (facts.book.expectedContentRevision !== facts.book.contentRevision) {
    return PUBLISH_SUPERSEDED;
  }
  return PUBLISH_BLOCKED;
}

/**
 * Publish a draft. One document write, and no catalog row moves.
 *
 * That is the whole payoff of keeping drafts in the same tables: publishing is a
 * status flip, so a half-published book cannot exist. Every gate is decided from
 * facts already gathered, which is what keeps it that way — see the no-`ctx`
 * rule at the top of `model/publishGates.ts`.
 *
 * ⚠️ ONE WAY. There is no unpublish and no edit-published. A typo in a published
 * book costs a book number, and that price is exactly what makes "your
 * estimate's numbers cannot move" a fact rather than a promise.
 *
 * ⚠️ WHAT GOES INTO `notes` IS NOT WHAT WAS TYPED. `composePublishNotes` welds
 * the numbers that were on the screen to the prose, so "what did we know at the
 * time" has an answer that does not depend on anyone remembering.
 *
 * ⚠️ IT DOES NOT CALL `requireDraftBook`. The gates cover everything that guard
 * does and more — G10 owns status, G0 owns the lock and the build — and routing
 * status through the gate is what lets a second click be reported as the success
 * it was rather than as a failure.
 */
export const publishBook = mutation({
  args: {
    bookId: v.id("rateBooks"),
    /** What the admin typed to confirm; it must equal the book's own name. */
    typedName: v.string(),
    /** What they typed into the release-notes box, and only that. */
    typedNotes: v.string(),
    /**
     * The revision the publish screen was rendered from, straight off
     * `getPublishReadiness`. Required, because "the screen did not say" and
     * "the screen was current" must not be the same call.
     */
    expectedContentRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const book = await ctx.db.get(args.bookId);
    if (!book) throw new Error("Rate book not found.");

    const inputs = await gatherPublishInputs(ctx, book);
    const facts = publishFacts(inputs, {
      typedName: args.typedName,
      typedNotes: args.typedNotes,
      expectedContentRevision: args.expectedContentRevision,
    });
    const readiness = evaluatePublishGates(facts);

    if (!readiness.canPublish) {
      const kind = publishRefusalKind(facts, readiness.blocking);
      const first = readiness.blocking[0];
      throw new ConvexError({
        kind,
        message:
          kind === PUBLISH_BLOCKED
            ? `${readiness.blocking.length} ${readiness.blocking.length === 1 ? "check" : "checks"} ` +
              `stop "${book.name}" from being published. ${first?.message ?? ""}`.trim()
            : (first?.message ?? "This draft cannot be published right now."),
        blocking: readiness.blocking.map((gate) => ({
          id: gate.id,
          name: gate.name,
          message: gate.message ?? "",
        })),
        outstanding: readiness.outstandingAcknowledgements.length,
      });
    }

    // G5 cannot pass without a ready comparison, so this is an assertion about
    // this file rather than a case: reaching it would mean the gate list and the
    // notes disagree about what "ready" means, and writing a permanent record
    // composed from a summary of nothing is worse than refusing to publish.
    const diffFacts = inputs.diffFacts;
    if (!diffFacts) {
      throw new Error("Every gate passed without a finished comparison. Run it again.");
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
      notes: composePublishNotes(args.typedNotes, diffFacts, inputs.benchmarkFacts),
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

/**
 * Clear locks whose owner died, and mark the job that owned them failed.
 *
 * ⚠️ A PREREQUISITE, NOT A NICE-TO-HAVE. `rateBooks.lock` is what makes clone,
 * import, revert, publish, discard, diff and benchmark refuse to interleave, and
 * `heartbeatAt` is what tells a slow job from a dead one — but until this ran,
 * nothing read it. A scheduled mutation killed by a runtime limit ("timed out
 * performing too many system operations") never reaches its own catch block, and
 * an action killed by a deploy never reaches anything: the lock stays set for
 * ever. G0 then blocks publish for ever, `requireEditableBook` refuses every
 * edit, and the at-most-one-open-draft rule means the admin cannot even discard
 * it and start again. One killed job wedges the whole subsystem permanently.
 *
 * WHAT A STALLED LOCK LOOKS LIKE: `lock` is set and `lock.heartbeatAt` has not
 * moved for {@link STALE_LOCK_MS}. Every healthy job refreshes it once per batch
 * — seconds apart — so ten minutes is hundreds of times the longest gap any live
 * job leaves. ⚠️ A JOB THAT TAKES THE LOCK AND NEVER REFRESHES IT WILL BE REAPED
 * WHILE HEALTHY at the ten-minute mark; refreshing per batch is the contract.
 *
 * WHAT REAPING DOES: releases the lock and marks the owning record `failed` with
 * a sentence saying it stopped rather than finished — because a job that
 * silently disappears and a job that finished must never look the same, and the
 * resume paths (`resumeImport`, `resumeBulkAdjust`, and the diff and benchmark
 * resumes) all read a state. It never touches catalog rows: whatever the dead
 * job wrote stays written, and every one of those jobs advances its cursor in
 * the same transaction as its writes, so resuming re-does only what never
 * landed.
 *
 * The scan is the whole `rateBooks` table on purpose: one document per version
 * ever published plus at most one open draft, so a handful, growing at the rate
 * somebody publishes a rate book. `createDraft` already reads it the same way,
 * and a tick that finds nothing writes nothing at all.
 */
export const reapStaleLocks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const books = await ctx.db.query("rateBooks").collect();
    const reaped: { book: string; op: string; heldFor: number }[] = [];

    for (const book of books) {
      const lock = book.lock;
      if (!lock || !isLockStale(lock.heartbeatAt, now)) continue;

      const stopped =
        `The ${lock.op} of "${book.name}" stopped without finishing — it last reported ` +
        `progress ${Math.round((now - lock.heartbeatAt) / 60000)} minutes ago. ` +
        `Nothing it had already written was undone. Run it again to pick up where it stopped.`;

      await ctx.db.patch(book._id, { lock: undefined });
      reaped.push({ book: book.name, op: lock.op, heldFor: now - lock.startedAt });

      if (lock.op === "clone" && book.buildState === "building") {
        // NOT "wait for it to finish": a clone that died is never going to, and
        // `cloneBatch` commits the rows it inserted before it stopped, so this
        // draft is a partial copy. `retryDraftBuild` reads `failed` and resumes
        // from `buildCursor`.
        await ctx.db.patch(book._id, { buildState: "failed", buildError: stopped });
      }

      if (lock.op === "import" || lock.op === "revert") {
        const writing = lock.op === "import" ? "applying" : "reverting";
        const imports = await ctx.db
          .query("rateBookImports")
          .withIndex("by_book_state", (q) => q.eq("bookId", book._id).eq("state", writing))
          .collect();
        for (const record of imports) {
          await ctx.db.patch(record._id, { state: "failed", error: stopped });
        }
      }

      if (lock.op === "bulkEdit") {
        const runs = await ctx.db
          .query("catalogBulkRuns")
          .withIndex("by_book_state", (q) => q.eq("bookId", book._id).eq("state", "running"))
          .collect();
        for (const run of runs) {
          await ctx.db.patch(run._id, { state: "failed", error: stopped, finishedAt: now });
        }
      }

      if (lock.op === "diff") {
        const runs = await ctx.db
          .query("rateBookDiffs")
          .withIndex("by_book_state", (q) => q.eq("bookId", book._id).eq("state", "running"))
          .collect();
        for (const run of runs) {
          await ctx.db.patch(run._id, { state: "failed", error: stopped, finishedAt: now });
        }
      }

      if (lock.op === "benchmark") {
        const runs = await ctx.db
          .query("rateBookBenchmarks")
          .withIndex("by_book_state", (q) => q.eq("bookId", book._id).eq("state", "running"))
          .collect();
        for (const run of runs) {
          await ctx.db.patch(run._id, { state: "failed", error: stopped, finishedAt: now });
        }
      }

      // `publish` and `discard` own no record of their own. Publish is a single
      // mutation that either committed or did not, and a half-run discard leaves
      // a draft holding fewer rows than it did — running the discard again
      // finishes it, which is why the lock is all there is to release.
    }

    return { reaped };
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
