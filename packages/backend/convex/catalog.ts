import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { PaginationOptions, PaginationResult } from "convex/server";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePrecisionAdmin, requirePrecisionRead } from "./model/precisionAccess";
import { requireDraftBook, writePoolRow } from "./model/rateBookAccess";
import type { PoolKind } from "./model/rateBookCsv";
import type { FieldValue } from "./model/rateBookRows";
import { beforeOf, candidateOf, type PoolRow } from "./model/rateBookShape";
import {
  adjustByPercent,
  CATALOG_NAME_FIELD,
  CATALOG_PARENT_FIELD,
  checkAdjustPercent,
  checkFieldValue,
  checkNewRow,
  checkRowInvariants,
  editableField,
  editableFieldNames,
  isAdjustable,
  matchesCatalogFilter,
  type CatalogFieldSpec,
} from "./model/catalogEdit";
import { insertPoolRow, mintPoolId, POOL_TABLE_OF } from "./rateBooks";

/**
 * Looking at a rate book, and changing one.
 *
 * WHAT WAS MISSING. `precision.getLaborPool` and `getEquipmentPool` filter
 * `isActive: true` and are pointed at the published default, so after
 * importing 388 changes into a draft the only way to see the result was to
 * export a spreadsheet — and a row the draft RETIRED could not be seen at all,
 * from anywhere, because the only query that reads the pool excludes it. This
 * file is the read that shows a draft as it actually is, and the writes that
 * change it a row at a time.
 *
 * ⚠️ EVERY WRITE GOES THROUGH `writePoolRow`. Not "should" — there is no other
 * writer here, including the bulk adjustment, because that function re-asserts
 * draft status PER ROW and is what makes "a published book never changes" a
 * property rather than a convention. The one exception is `addCatalogRow`,
 * which INSERTS: `writePoolRow` patches a row that already exists, so an
 * insert cannot go through it and instead reuses `insertPoolRow` from the
 * import path so a row added in the grid and a row added from a sheet land as
 * the same document.
 *
 * @module
 */

/** Every table a pool can live in, derived rather than re-listed. */
type PoolTable = (typeof POOL_TABLE_OF)[PoolKind];

const poolValidator = v.union(
  v.literal("wbs"),
  v.literal("phases"),
  v.literal("labor"),
  v.literal("equipment")
);

/** The two pools with a column a percentage means anything to. */
const adjustablePoolValidator = v.union(v.literal("labor"), v.literal("equipment"));

/** Mirrors `FieldValue` — the three things a catalog cell can hold. */
const fieldValueValidator = v.union(v.string(), v.number(), v.boolean());

const rowIdValidator = v.union(
  v.id("wbsPool"),
  v.id("phasePool"),
  v.id("laborPool"),
  v.id("equipmentPool")
);

/**
 * Rows read off the index per page WHILE A FILTER IS NARROWING THEM.
 *
 * A text filter cannot be an index lookup — it is a substring, and the pools
 * carry no search index — so the filter runs over a page and the page comes
 * back short. 400 rows is 2.4% of the 16,384-document read ceiling, and it
 * bounds the worst case honestly: a term matching nothing walks all 5,897
 * labor rows in 15 round trips rather than 59 at the client's page size.
 * `scanned` is returned so the screen can say "nothing in the first 400" and
 * mean it.
 */
const FILTER_SCAN = 400;

/**
 * Rows a new row's parent group is scanned for, to place it at the end.
 *
 * The largest phase in the real catalog holds 219 labor rows, so 1,000 is 4.6×
 * the biggest group that exists. A group that outgrew it is TOLD so rather
 * than having its new row quietly placed somewhere that is not the tail.
 */
const SIBLING_SCAN = 1000;

/**
 * Rows written per bulk-adjustment batch.
 *
 * THE ARITHMETIC. Each row costs four database operations: one get to read the
 * value the percentage applies to, then `writePoolRow`'s own get of the book,
 * get of the row, and patch. At 250 rows that is 751 reads (250 + 250 + 250,
 * plus the run document) and 251 writes — 4.6% of the 16,384-document read
 * ceiling and 3.1% of the 8,192-document write ceiling. `applyImportBatch`
 * already runs 300 rows at roughly six operations each against the real
 * 5,897-row labor file, so this batch is a little over half of one that is
 * known to survive.
 *
 * ⚠️ WHAT THE NUMBER IS REALLY GUARDING. The batch reads the run document and
 * the rows it is about to write, AND NOTHING ELSE — no pool is loaded here.
 * The activity-link repair that had to be rewritten reloaded the whole
 * 5,897-row labor pool inside every batch, which is 12× this batch's entire
 * read budget on its own, and the runtime killed it with "timed out performing
 * too many system operations" — an abort a mutation cannot catch, which left
 * the run marked `running` for ever with nothing recorded to say why.
 */
const BULK_BATCH = 250;

/**
 * The most rows one adjustment may name.
 *
 * The selection is stored on the run, so it has to fit in a document: 6,000
 * ids at ~34 bytes each is about 200 KB, a fifth of Convex's 1 MB ceiling, and
 * it covers the whole 5,897-row labor pool in a single run.
 */
const MAX_SELECTION = 6000;

/** Refusals kept verbatim on the run. Enough to name rows, not to be a log. */
const SKIP_SAMPLE = 50;

// ============================================================================
// READS
// ============================================================================

/**
 * Which callers may read a book's catalog.
 *
 * A PUBLISHED book's catalog is already readable by any estimator — it is what
 * `getLaborPool` serves on every phase screen — so requiring an administrator
 * to look at it would be theatre. A DRAFT is unpublished work that
 * `listRateBooks` deliberately keeps away from estimators, and it stays that
 * way here.
 *
 * The read guard runs BEFORE the first `ctx.db.get`, as every guard in
 * `precisionAccess` does: a refusal that came after the lookup would tell an
 * unauthorised caller whether a book id exists.
 */
async function requireCatalogRead(
  ctx: QueryCtx,
  bookId: Id<"rateBooks">
): Promise<Doc<"rateBooks">> {
  await requirePrecisionRead(ctx);
  const book = await ctx.db.get(bookId);
  if (!book) throw new Error("Rate book not found.");
  if (book.status !== "published") await requirePrecisionAdmin(ctx);
  return book;
}

/**
 * One page of a pool, scoped to a book and optionally to a parent.
 *
 * Written out per pool rather than reached through a cast, for the reason
 * `insertPoolRow` gives: these are four different tables with four different
 * shapes, and a cast that silenced the compiler would be the compiler telling
 * us we had picked the wrong index.
 *
 * ⚠️ NONE OF THESE INDEXES CARRY `isActive`, and that is the whole point. The
 * screens this replaces read `by_book_active` and `by_book_phase_active`, so a
 * row the draft retired was invisible to every query in the app. Ordering is
 * by `poolId` because it is unique within a book — a total order, so a
 * pagination cursor cannot drift — and because it is the order
 * `exportPoolCsv` writes, so the screen and the spreadsheet an admin is
 * comparing it against read the same way down the page.
 */
async function paginatePool(
  ctx: QueryCtx,
  bookId: Id<"rateBooks">,
  pool: PoolKind,
  parentPoolId: number | undefined,
  opts: PaginationOptions
): Promise<PaginationResult<PoolRow>> {
  if (pool === "labor") {
    if (parentPoolId !== undefined) {
      return await ctx.db
        .query("laborPool")
        .withIndex("by_book_phase_pool_id", (q) =>
          q.eq("bookId", bookId).eq("phasePoolId", parentPoolId)
        )
        .paginate(opts);
    }
    return await ctx.db
      .query("laborPool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
      .paginate(opts);
  }

  if (pool === "phases") {
    if (parentPoolId !== undefined) {
      return await ctx.db
        .query("phasePool")
        .withIndex("by_book_wbs_pool_id", (q) =>
          q.eq("bookId", bookId).eq("wbsPoolId", parentPoolId)
        )
        .paginate(opts);
    }
    return await ctx.db
      .query("phasePool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
      .paginate(opts);
  }

  if (pool === "wbs") {
    return await ctx.db
      .query("wbsPool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
      .paginate(opts);
  }

  return await ctx.db
    .query("equipmentPool")
    .withIndex("by_book_pool_id", (q) => q.eq("bookId", bookId))
    .paginate(opts);
}

/**
 * One stored row as the grid renders it.
 *
 * Built from `candidateOf` and `beforeOf` rather than from a fifth per-pool
 * mapping written here. `beforeOf` is defined as "every field `shapeRow` can
 * write", which is exactly the set of cells the grid may edit, so the grid and
 * the import preview cannot come to disagree about what a row consists of.
 */
function toCatalogRow(pool: PoolKind, row: PoolRow) {
  const candidate = candidateOf(pool, row);
  return {
    _id: row._id,
    poolId: candidate.poolId,
    description: candidate.description,
    /** Phase for a labor row, WBS for a phase; `null` where there is none. */
    parentPoolId: candidate.parentPoolId ?? null,
    /** What an edit must pass back as `expectedRevision`. */
    rowRevision: row.rowRevision ?? 0,
    isActive: row.isActive,
    retiredInBookId: row.retiredInBookId ?? null,
    values: beforeOf(pool, row),
  };
}

/**
 * One page of a book's catalog, retired rows included.
 *
 * `status` defaults to `all` deliberately: the reason this query exists is
 * that nothing in the app could show a retirement, and defaulting to `active`
 * would rebuild the blind spot on the first screen that forgot to pass it.
 *
 * `search` matches the row's own name — through the matcher's normalizer, so
 * `FSW <= .75` finds `FSW - ≤.75` — or an id exactly.
 */
export const listCatalogRows = query({
  args: {
    bookId: v.id("rateBooks"),
    pool: poolValidator,
    /** Phase id for labor, WBS id for phases. Absent lists the whole pool. */
    parentPoolId: v.optional(v.number()),
    search: v.optional(v.string()),
    status: v.optional(v.union(v.literal("all"), v.literal("active"), v.literal("retired"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireCatalogRead(ctx, args.bookId);

    if (args.parentPoolId !== undefined && CATALOG_PARENT_FIELD[args.pool] === null) {
      throw new Error(`The ${args.pool} catalog has no parent scope to filter by.`);
    }

    const term = (args.search ?? "").trim();
    const status = args.status ?? "all";
    const narrowing = term !== "" || status !== "all";

    const page = await paginatePool(ctx, args.bookId, args.pool, args.parentPoolId, {
      ...args.paginationOpts,
      // Widening the scan, never the client's page: a filter that matches one
      // row in four hundred must not hand back three hundred and ninety-nine
      // empty pages.
      numItems: narrowing ? FILTER_SCAN : args.paginationOpts.numItems,
    });

    const rows = page.page
      .map((row) => toCatalogRow(args.pool, row))
      .filter((row) => (status === "all" ? true : row.isActive === (status === "active")))
      .filter((row) => matchesCatalogFilter(row, term));

    // Spread first so `splitCursor` and `pageStatus` survive — dropping them
    // would break the client's own splitting on a page it found too large.
    return { ...page, page: rows, scanned: page.page.length };
  },
});

/**
 * Every WBS and phase in a book, in one read.
 *
 * THIS IS THE ANSWER TO THE N+1. A labor row carries `phasePoolId` and nothing
 * else, and a page of 400 of them resolved one parent at a time would be 400
 * lookups per page — 400 lookups to render 400 rows. The whole scope tree is
 * 18 WBS and 228 phases, so the screen fetches all 246 documents once and
 * joins locally, and the join costs nothing when the page turns.
 *
 * Retired scopes are included for the same reason rows are: a phase this draft
 * retired still has labor rows filed under it, and they have to be reachable.
 */
export const getBookScopes = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requireCatalogRead(ctx, args.bookId);

    const wbs = await ctx.db
      .query("wbsPool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", args.bookId))
      .collect();
    const phases = await ctx.db
      .query("phasePool")
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", args.bookId))
      .collect();

    return {
      wbs: wbs.map((row) => ({
        poolId: row.poolId,
        name: row.name,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
      })),
      phases: phases.map((row) => ({
        poolId: row.poolId,
        wbsPoolId: row.wbsPoolId,
        name: row.name,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
        takeoffUnit: row.takeoffUnit ?? null,
      })),
    };
  },
});

/**
 * A book's catalog in four numbers, and whether it can be changed.
 *
 * ⚠️ COUNTED LIVE RATHER THAN READ OFF `rateBooks.rowCounts`, which is neither
 * present nor current: `seedFoundationBook` never wrote it, so book #1 — the
 * one 736 estimates are priced from — has none at all, and `applyImportBatch`
 * inserts rows without touching it, so a draft that imported 40 new items
 * under-reports by 40 from then on. A header that is quietly short by 40 is
 * worse than one that costs a read.
 *
 * The read is 6,272 documents on the real catalog (18 + 228 + 5,897 + 129),
 * 38% of the 16,384-document query ceiling, and `countBookRows` already does
 * exactly this walk inside a MUTATION at the end of every clone. The retired
 * split cannot come from a stored total at any price, and it is the number
 * this whole slice exists to surface.
 */
/**
 * A book's identity, whether it can be changed, and its four totals.
 *
 * ⚠️ COUNTED FROM `rateBooks.rowCounts`, NOT BY SCANNING. The first version of
 * this collected every row of all four pools — 6,272 documents — to produce
 * four integers, as a LIVE subscription. Convex re-runs a subscribed query on
 * every write it touches, so the screen re-scanned the whole catalog on every
 * batch of a clone AND on every single cell an admin committed. It locked the
 * app up on the first real draft, which is exactly when somebody first uses it.
 *
 * `cloneBatch` writes `rowCounts` when a clone finishes, so every draft carries
 * them; `seedFoundationBook` never did, so book 1 is backfilled by
 * `backfillRowCounts` below. Absent counts render as absent rather than as a
 * confident zero — a wrong number here is worse than no number.
 */
export const getCatalogSummary = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    const book = await requireCatalogRead(ctx, args.bookId);
    return {
      _id: book._id,
      bookNumber: book.bookNumber,
      name: book.name,
      status: book.status,
      buildState: book.buildState,
      isDefault: book.isDefault,
      /** A draft, finished cloning, with nothing long-running holding it. */
      editable: book.status === "draft" && book.buildState === "ready" && book.lock === undefined,
      lockedBy: book.lock?.op ?? null,
      counts: book.rowCounts ?? null,
    };
  },
});

/**
 * Fill in `rowCounts` for a book that predates them.
 *
 * Only `seedFoundationBook`'s book is missing them; every cloned draft is
 * counted when its clone finishes. Internal, because it is an operational
 * one-shot rather than something the app should ever call.
 */
export const backfillRowCounts = internalMutation({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    const count = async (table: PoolTable): Promise<number> =>
      (
        await ctx.db
          .query(table)
          .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
          .collect()
      ).length;
    const rowCounts = {
      wbs: await count("wbsPool"),
      phases: await count("phasePool"),
      labor: await count("laborPool"),
      equipment: await count("equipmentPool"),
    };
    await ctx.db.patch(args.bookId, { rowCounts });
    return rowCounts;
  },
});

// ============================================================================
// WRITES
// ============================================================================

/**
 * The book a hand edit may land in.
 *
 * DELIBERATELY STRICTER THAN `requireDraftBook`, which passes when the lock's
 * op matches the caller's. That tolerance is right for the batches OF a long
 * operation — an import's own batches must get past the import's own lock —
 * and wrong for a person typing into a grid while one is running, because the
 * import is about to overwrite the cell they just changed.
 *
 * This is the front door and it is allowed to be friendly about it.
 * `writePoolRow` is the guarantee, and it re-checks per row.
 */
async function requireEditableBook(
  ctx: MutationCtx,
  bookId: Id<"rateBooks">
): Promise<Doc<"rateBooks">> {
  const book = await ctx.db.get(bookId);
  if (!book) throw new Error("Rate book not found.");
  if (book.status !== "draft") {
    throw new Error(
      `"${book.name}" is ${book.status} and can no longer be edited. Duplicate it as a draft to make changes.`
    );
  }
  if (book.buildState !== "ready") {
    throw new Error(`"${book.name}" is still being built. Wait for it to finish.`);
  }
  if (book.lock) {
    throw new Error(`"${book.name}" is busy (${book.lock.op}). Wait for that to finish.`);
  }
  return book;
}

/** The row `rowId` names, proven to be in the pool the caller says it is. */
async function loadRowInPool(
  ctx: MutationCtx,
  pool: PoolKind,
  bookId: Id<"rateBooks">,
  rowId: string
): Promise<{ rowId: Id<PoolTable>; row: PoolRow }> {
  // An id from another pool would otherwise be patched with this pool's
  // fields — `writePoolRow` writes to whatever table the id names, and by then
  // the mistake has already happened.
  const normalized = ctx.db.normalizeId(POOL_TABLE_OF[pool], rowId);
  if (!normalized) throw new Error(`That row is not in the ${pool} catalog.`);
  const row = await ctx.db.get(normalized);
  if (!row) throw new Error("Catalog row not found.");
  if (row.bookId !== bookId) throw new Error("Catalog row belongs to a different rate book.");
  return { rowId: normalized, row };
}

/**
 * One field turned into the patch that is actually stored.
 *
 * ⚠️ `toStoredPatch` CANNOT BE USED HERE, AND THE REASON IS EASY TO MISS. It
 * returns `{ ...values, takeoffUnit: ... }` for every phase patch, so running a
 * one-field `name` edit through it would hand `db.patch` a `takeoffUnit` of
 * `undefined` — which DELETES the field. Every phase edit would silently drop
 * the phase's takeoff unit, and `loadTakeoffCatalog` would start displaying a
 * dash on every estimate that used it. So the blank-means-absent rule is
 * applied to the one field it is about, and only when that field is the one
 * being written.
 */
function storedPatchFor(pool: PoolKind, field: string, value: FieldValue): Record<string, unknown> {
  if (pool === "phases" && field === "takeoffUnit" && value === "") {
    return { takeoffUnit: undefined };
  }
  return { [field]: value };
}

/**
 * Change one field of one row.
 *
 * `expectedRevision` is the revision the client last READ, not one it invents.
 * An edit made against a stale view is refused rather than applied, because
 * the alternative is overwriting somebody's work and recording a "before"
 * value that was never current — which falsifies the audit trail of the one
 * subsystem whose entire justification is a trustworthy audit trail.
 */
export const updateCatalogRow = mutation({
  args: {
    bookId: v.id("rateBooks"),
    pool: poolValidator,
    rowId: rowIdValidator,
    field: v.string(),
    value: fieldValueValidator,
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    await requireEditableBook(ctx, args.bookId);

    const spec = editableField(args.pool, args.field);
    if (!spec) {
      throw new Error(
        `${args.field} is not an editable column of the ${args.pool} catalog. ` +
          `These are: ${editableFieldNames(args.pool).join(", ")}.`
      );
    }

    const checked = checkFieldValue(spec, args.value);
    if (!checked.ok) throw new Error(checked.error);

    const { rowId, row } = await loadRowInPool(ctx, args.pool, args.bookId, args.rowId);

    // Checked against the row AS IT WILL BE, so a single cell cannot walk a row
    // into a state the add form would have refused outright.
    const broken = checkRowInvariants(args.pool, {
      ...beforeOf(args.pool, row),
      [args.field]: checked.value,
    });
    if (broken.length > 0) throw new Error(broken.join(" "));

    const rowRevision = await writePoolRow(ctx, {
      bookId: args.bookId,
      table: POOL_TABLE_OF[args.pool],
      rowId,
      patch: storedPatchFor(args.pool, args.field, checked.value),
      expectedRevision: args.expectedRevision,
    });

    return { rowRevision };
  },
});

/**
 * Where a new row sorts: after everything already in its parent group.
 *
 * The same rule the importer applies, and for the same reason — zero would put
 * every addition at the top of a list people have memorised.
 */
async function tailSortOrder(
  ctx: MutationCtx,
  bookId: Id<"rateBooks">,
  pool: PoolKind,
  parentPoolId: number | undefined
): Promise<number> {
  const page = await paginatePool(ctx, bookId, pool, parentPoolId, {
    cursor: null,
    numItems: SIBLING_SCAN,
  });
  if (!page.isDone) {
    throw new Error(
      `This group already holds more than ${SIBLING_SCAN} rows; set a sort order explicitly.`
    );
  }
  let highest = 0;
  for (const row of page.page) highest = Math.max(highest, row.sortOrder);
  return highest + 10;
}

/**
 * Add a row to a draft.
 *
 * ⚠️ THE ID IS NEVER THE CALLER'S. It comes from `rateBookCounters` through
 * `mintPoolId` and is recorded in `rateBookItems`, exactly as an import's
 * additions are. Caller-chosen ids are how the legacy catalog came to have
 * 1,064 labor rows carrying their values at somebody else's number.
 *
 * The book's `rowCounts` is moved by `insertPoolRow`, not here. Keeping the
 * count beside the insert is what makes the importer's additions count too — a
 * bump at this door alone left an imported row uncounted, and G1 blocks on a
 * count that disagrees with the catalog.
 */
export const addCatalogRow = mutation({
  args: {
    bookId: v.id("rateBooks"),
    pool: poolValidator,
    /** The phase a labor row joins, or the WBS a phase joins. */
    parentPoolId: v.optional(v.number()),
    values: v.record(v.string(), fieldValueValidator),
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    await requireEditableBook(ctx, args.bookId);

    const parentField = CATALOG_PARENT_FIELD[args.pool];
    if (parentField === null && args.parentPoolId !== undefined) {
      throw new Error(`A ${args.pool} row does not belong to a parent.`);
    }
    if (parentField !== null && args.parentPoolId === undefined) {
      throw new Error(`A new ${args.pool} row needs the ${parentField} it belongs to.`);
    }

    // The parent must be in THIS book. A labor row filed under a phase the
    // draft does not contain would be unreachable from every screen and would
    // still be cloned forward for ever.
    if (parentField !== null && args.parentPoolId !== undefined) {
      const parentTable = args.pool === "labor" ? "phasePool" : "wbsPool";
      const parentPoolId = args.parentPoolId;
      const parent = await ctx.db
        .query(parentTable)
        .withIndex("by_book_pool_id", (q) => q.eq("bookId", args.bookId).eq("poolId", parentPoolId))
        .first();
      if (!parent) {
        throw new Error(`${parentField} ${parentPoolId} is not in this rate book.`);
      }
    }

    const checked = checkNewRow(args.pool, args.values);
    if (!checked.ok) throw new Error(checked.errors.join(" "));

    const values: Record<string, FieldValue> = { ...checked.values };
    if (values.sortOrder === undefined) {
      values.sortOrder = await tailSortOrder(ctx, args.bookId, args.pool, args.parentPoolId);
    }
    if (parentField !== null && args.parentPoolId !== undefined) {
      values[parentField] = args.parentPoolId;
    }

    const name = values[CATALOG_NAME_FIELD[args.pool]];
    const poolId = await mintPoolId(
      ctx,
      args.pool,
      typeof name === "string" ? name : "",
      args.bookId
    );
    await insertPoolRow(ctx, args.pool, args.bookId, poolId, values);

    // `insertPoolRow` reports nothing back, so the row is read once to hand the
    // grid the id it needs to select and edit what was just added.
    const inserted = await ctx.db
      .query(POOL_TABLE_OF[args.pool])
      .withIndex("by_book_pool_id", (q) => q.eq("bookId", args.bookId).eq("poolId", poolId))
      .first();
    if (!inserted) throw new Error("The new row could not be read back.");

    return { poolId, rowId: inserted._id, rowRevision: 0 };
  },
});

/**
 * Retire a row, or put it back.
 *
 * ⚠️ NOT A DELETE, EVER. "Removed in the 2026 book" is a fact worth keeping:
 * the row stays, `isActive` goes false, and `retiredInBookId` records which
 * book did it, so a later reader can tell "this item never existed" from "this
 * item was withdrawn". Restoring clears the stamp rather than pointing it at
 * the restoring book, because the row is no longer retired anywhere.
 */
export const setCatalogRowRetired = mutation({
  args: {
    bookId: v.id("rateBooks"),
    pool: poolValidator,
    rowId: rowIdValidator,
    retired: v.boolean(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    await requireEditableBook(ctx, args.bookId);

    const { rowId } = await loadRowInPool(ctx, args.pool, args.bookId, args.rowId);

    const rowRevision = await writePoolRow(ctx, {
      bookId: args.bookId,
      table: POOL_TABLE_OF[args.pool],
      rowId,
      patch: args.retired
        ? { isActive: false, retiredInBookId: args.bookId }
        : { isActive: true, retiredInBookId: undefined },
      expectedRevision: args.expectedRevision,
    });

    return { rowRevision };
  },
});

// ============================================================================
// BULK PERCENTAGE ADJUSTMENT
// ============================================================================

/** The fields a percentage moves on one row, and the values it moves them to. */
function adjustPatch(
  pool: "labor" | "equipment",
  row: PoolRow,
  percent: number,
  specs: readonly CatalogFieldSpec[]
): Record<string, number> {
  const current = beforeOf(pool, row);
  const patch: Record<string, number> = {};
  for (const spec of specs) {
    const decimals = spec.adjustDecimals;
    const value = current[spec.field];
    if (decimals === undefined || typeof value !== "number") continue;
    const next = adjustByPercent(value, percent, decimals);
    if (next !== value) patch[spec.field] = next;
  }
  return patch;
}

/** Hand the draft back, but only if the lock is still this run's. */
async function releaseBulkLock(ctx: MutationCtx, bookId: Id<"rateBooks">): Promise<void> {
  const book = await ctx.db.get(bookId);
  if (book?.lock?.op === "bulkEdit") await ctx.db.patch(bookId, { lock: undefined });
}

/**
 * Move a percentage across a list of rows the admin was shown.
 *
 * ⚠️ THE SELECTION IS THE CALLER'S AND IS NEVER WIDENED. This mutation refuses
 * to re-derive "everything matching the filter", because a row added between
 * the preview and the apply would then be adjusted without anybody having seen
 * it — the admin approved a set of rows, not a description of one.
 *
 * The draft is LOCKED for the duration. That is what makes a per-row
 * `expectedRevision` unnecessary here and a hand edit landing mid-run
 * impossible: `requireEditableBook` refuses every lock, so nothing else can
 * write to the book while the run walks it.
 */
export const startBulkAdjust = mutation({
  args: {
    bookId: v.id("rateBooks"),
    pool: adjustablePoolValidator,
    /** Equipment's "+3%" means all four rates; labor's may mean one constant. */
    fields: v.array(v.string()),
    percent: v.number(),
    rowIds: v.array(v.union(v.id("laborPool"), v.id("equipmentPool"))),
  },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    await requireEditableBook(ctx, args.bookId);

    const percentCheck = checkAdjustPercent(args.percent);
    if (!percentCheck.ok) throw new Error(percentCheck.error);

    if (args.fields.length === 0) {
      throw new Error("Say which columns the percentage applies to.");
    }
    if (new Set(args.fields).size !== args.fields.length) {
      throw new Error("The same column is listed twice.");
    }
    for (const field of args.fields) {
      if (!isAdjustable(args.pool, field)) {
        throw new Error(`${field} is not a ${args.pool} column a percentage can move.`);
      }
    }

    if (args.rowIds.length === 0) {
      throw new Error("Select the rows first. This never picks them for you.");
    }
    if (args.rowIds.length > MAX_SELECTION) {
      throw new Error(
        `${args.rowIds.length} rows is more than one adjustment carries (${MAX_SELECTION}). ` +
          "Split it, or edit a sheet and import it."
      );
    }
    if (new Set(args.rowIds).size !== args.rowIds.length) {
      throw new Error("A row is in the selection twice; the percentage would be applied twice.");
    }

    // Proven up front rather than discovered on row 300: an id from the other
    // pool would be read with this pool's field names and adjust nothing,
    // which is a silent no-op in the middle of a run somebody is trusting.
    const table = POOL_TABLE_OF[args.pool];
    for (const rowId of args.rowIds) {
      if (!ctx.db.normalizeId(table, rowId)) {
        throw new Error(`The selection contains a row that is not in the ${args.pool} catalog.`);
      }
    }

    const now = Date.now();
    const runId = await ctx.db.insert("catalogBulkRuns", {
      bookId: args.bookId,
      pool: args.pool,
      fields: args.fields,
      percent: args.percent,
      rowIds: args.rowIds,
      state: "running",
      cursor: 0,
      startedBy: access.userId,
      startedAt: now,
      lastProgressAt: now,
      tally: { selected: args.rowIds.length, adjusted: 0, missing: 0, unchanged: 0 },
      skipped: [],
    });

    await ctx.db.patch(args.bookId, {
      lock: { op: "bulkEdit", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });
    await ctx.scheduler.runAfter(0, internal.catalog.applyBulkAdjustBatch, { runId });

    return { runId, rows: args.rowIds.length };
  },
});

/**
 * One batch of an adjustment.
 *
 * ⚠️ THE CURSOR ADVANCES IN THE SAME TRANSACTION AS THE WRITES, and that is
 * the whole resumability story. A Convex mutation commits or it does not, so a
 * batch killed by a runtime limit takes its writes AND its cursor advance with
 * it, and resuming from the stored cursor re-does exactly the rows that never
 * landed. A percentage can therefore never be applied to the same row twice.
 *
 * A recoverable throw is caught rather than allowed to escape, because a
 * scheduled mutation that throws does not get to write its own failure state —
 * the run would sit in `running` for ever holding the draft's lock, which is
 * exactly what `cloneBatch` was rewritten to avoid. The catch advances the
 * cursor by the rows that DID complete, so the retry starts in the right place.
 */
export const applyBulkAdjustBatch = internalMutation({
  args: { runId: v.id("catalogBulkRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.state !== "running") return { done: true };

    const specs: CatalogFieldSpec[] = [];
    let processed = 0;
    let adjusted = 0;
    let missing = 0;
    let unchanged = 0;
    const skipped: Array<{ poolId: number; reason: string }> = [];

    try {
      // Re-asserted per BATCH here and per ROW inside `writePoolRow`, so a
      // publish landing between two batches stops the run rather than writing
      // into a book that is meant to be frozen.
      await requireDraftBook(ctx, run.bookId, "bulkEdit");

      for (const field of run.fields) {
        const spec = editableField(run.pool, field);
        if (!spec || spec.adjustDecimals === undefined) {
          throw new Error(`${field} is no longer a column a percentage can move.`);
        }
        specs.push(spec);
      }

      const end = Math.min(run.cursor + BULK_BATCH, run.rowIds.length);
      for (let i = run.cursor; i < end; i += 1) {
        const rowId = run.rowIds[i];
        const row = rowId === undefined ? null : await ctx.db.get(rowId);

        if (row === null) {
          missing += 1;
        } else if (row.bookId !== run.bookId) {
          skipped.push({ poolId: row.poolId, reason: "moved to a different rate book" });
        } else {
          const patch = adjustPatch(run.pool, row, run.percent, specs);
          if (Object.keys(patch).length === 0) {
            unchanged += 1;
          } else {
            await writePoolRow(ctx, {
              bookId: run.bookId,
              table: POOL_TABLE_OF[run.pool],
              rowId: row._id,
              patch,
            });
            adjusted += 1;
          }
        }
        processed += 1;
      }
    } catch (error) {
      await ctx.db.patch(args.runId, {
        state: "failed",
        error: error instanceof Error ? error.message : "The adjustment stopped.",
        cursor: run.cursor + processed,
        tally: mergedTally(run, { adjusted, missing, unchanged }),
        skipped: [...run.skipped, ...skipped].slice(0, SKIP_SAMPLE),
        lastProgressAt: Date.now(),
        finishedAt: Date.now(),
      });
      await releaseBulkLock(ctx, run.bookId);
      return { done: true, failed: true };
    }

    const cursor = run.cursor + processed;
    const done = cursor >= run.rowIds.length;
    const now = Date.now();

    await ctx.db.patch(args.runId, {
      cursor,
      tally: mergedTally(run, { adjusted, missing, unchanged }),
      skipped: [...run.skipped, ...skipped].slice(0, SKIP_SAMPLE),
      lastProgressAt: now,
      ...(done ? { state: "done" as const, finishedAt: now } : {}),
    });

    if (done) {
      await releaseBulkLock(ctx, run.bookId);
      return { done: true };
    }

    const book = await ctx.db.get(run.bookId);
    if (book?.lock?.op === "bulkEdit") {
      // A heartbeat, so a stalled run is distinguishable from a slow one.
      await ctx.db.patch(run.bookId, { lock: { ...book.lock, heartbeatAt: now } });
    }
    await ctx.scheduler.runAfter(0, internal.catalog.applyBulkAdjustBatch, { runId: args.runId });
    return { done: false, adjusted, cursor };
  },
});

/** This batch's counts folded into the run's running totals. */
function mergedTally(
  run: Doc<"catalogBulkRuns">,
  batch: { adjusted: number; missing: number; unchanged: number }
): Doc<"catalogBulkRuns">["tally"] {
  return {
    selected: run.tally.selected,
    adjusted: run.tally.adjusted + batch.adjusted,
    missing: run.tally.missing + batch.missing,
    unchanged: run.tally.unchanged + batch.unchanged,
  };
}

/**
 * Pick up an adjustment that stopped part-way.
 *
 * Covers both stops: the recoverable throw that recorded `failed`, and the
 * hard runtime abort that could record nothing at all and left the run sitting
 * in `running` with a `lastProgressAt` that has not moved. Both resume from the
 * stored cursor, which is the last row known to have landed.
 */
export const resumeBulkAdjust = mutation({
  args: { runId: v.id("catalogBulkRuns") },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("That adjustment is not on record.");
    if (run.state === "done") throw new Error("That adjustment already finished.");
    if (run.state === "cancelled") throw new Error("That adjustment was cancelled.");

    const book = await ctx.db.get(run.bookId);
    if (!book) throw new Error("Rate book not found.");
    if (book.status !== "draft") {
      throw new Error(`"${book.name}" is ${book.status}; the rest of the adjustment cannot run.`);
    }
    if (book.lock && book.lock.op !== "bulkEdit") {
      throw new Error(`"${book.name}" is busy (${book.lock.op}). Wait for that to finish.`);
    }

    const now = Date.now();
    await ctx.db.patch(args.runId, {
      state: "running",
      error: undefined,
      finishedAt: undefined,
      lastProgressAt: now,
    });
    await ctx.db.patch(run.bookId, {
      lock: { op: "bulkEdit", startedBy: access.userId, startedAt: now, heartbeatAt: now },
    });
    await ctx.scheduler.runAfter(0, internal.catalog.applyBulkAdjustBatch, { runId: args.runId });

    return { remaining: run.rowIds.length - run.cursor };
  },
});

/**
 * Stop an adjustment and give the draft back.
 *
 * The rows already written STAY written — a percentage is not undone by
 * refusing to apply the rest of it, and pretending otherwise would need a
 * before-value per row that this run does not keep. The tally says exactly how
 * many landed, and a second run with the inverse percentage is the honest way
 * back if one is wanted.
 *
 * This exists because a batch killed by a runtime limit cannot record its own
 * failure, so without it the draft's lock would have no way to be released.
 */
export const cancelBulkAdjust = mutation({
  args: { runId: v.id("catalogBulkRuns") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("That adjustment is not on record.");
    if (run.state === "done") throw new Error("That adjustment already finished.");

    await ctx.db.patch(args.runId, { state: "cancelled", finishedAt: Date.now() });
    await releaseBulkLock(ctx, run.bookId);

    return { adjusted: run.tally.adjusted, remaining: run.rowIds.length - run.cursor };
  },
});

/**
 * What one adjustment did, without the selection itself.
 *
 * `rowIds` is deliberately not returned: at 6,000 ids it is ~200 KB, and a
 * progress indicator that shipped it on every poll would move more data than
 * the adjustment writes.
 */
function summarizeRun(run: Doc<"catalogBulkRuns">) {
  return {
    _id: run._id,
    bookId: run.bookId,
    pool: run.pool,
    fields: run.fields,
    percent: run.percent,
    state: run.state,
    /** Rows walked so far, of `tally.selected`. */
    done: run.cursor,
    tally: run.tally,
    skipped: run.skipped,
    startedAt: run.startedAt,
    lastProgressAt: run.lastProgressAt ?? null,
    finishedAt: run.finishedAt ?? null,
    error: run.error ?? null,
  };
}

/** One adjustment's progress, for the screen watching it. */
export const getBulkAdjustRun = query({
  args: { runId: v.id("catalogBulkRuns") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    return run ? summarizeRun(run) : null;
  },
});

/** Every adjustment made to a book, newest first. */
export const listBulkAdjustRuns = query({
  args: { bookId: v.id("rateBooks") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const runs = await ctx.db
      .query("catalogBulkRuns")
      .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
      .order("desc")
      .take(25);
    return runs.map(summarizeRun);
  },
});
