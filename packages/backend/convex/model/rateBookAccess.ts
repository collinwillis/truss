import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * The guard that makes "a published book never changes" a property rather
 * than a convention.
 *
 * ⚠️ WHY IMMUTABILITY IS ABSOLUTE, and not merely tidy. It is tempting to
 * think a published book is already safe because an activity copies its
 * constants at creation — `addActivity` writes `craftConstant` onto the row
 * and `costEngine` reads it from there, never from the catalog. That is true
 * of the MONEY and false of everything else:
 *
 *   - `loadTakeoffCatalog` reads `phasePool.takeoffUnit` and
 *     `laborPool.countsTowardTakeoff` LIVE, on every phase-list render and
 *     inside the export.
 *   - `deriveNextPhaseNumber` reads `phasePool.reservedPhaseNumber` live.
 *
 * So editing one published row changes what 736 finished estimates display
 * and print, with no write to any estimate and no trace anywhere. There is no
 * safe in-place edit of a published book. Duplicate it as a draft instead.
 */

/**
 * The refusal a client must be able to tell apart from every other failure.
 *
 * A stale edit is not a fault — somebody else got there first, and the value on
 * screen is now theirs and current. That deserves a different sentence from a
 * permission failure or a lost connection, and telling them apart by matching
 * on prose breaks the moment the wording is edited.
 */
export const STALE_ROW = "stale_row" as const;

export type RateBookOp =
  | "clone"
  | "import"
  | "revert"
  | "publish"
  | "discard"
  | "bulkEdit"
  | "diff"
  | "benchmark";

/**
 * How long a lock may go unrefreshed before {@link isLockStale} calls it dead.
 *
 * TEN MINUTES, AND THE MARGIN IS ENORMOUS ON PURPOSE. Every job that holds a
 * lock refreshes `heartbeatAt` once per batch, and a batch is a Convex mutation
 * — seconds at the outside. `cloneBatch` refreshes ~13 times in a few seconds,
 * `applyBulkAdjustBatch` once per 250 rows, and the diff and benchmark actions
 * once per flush. So ten minutes is not "how long a slow job might take"; it is
 * hundreds of times longer than the longest gap any healthy job leaves, chosen
 * so that reaping a live job is not a thing that happens.
 */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Whether a lock has stopped being refreshed.
 *
 * WHAT A STALLED LOCK LOOKS LIKE FROM OUTSIDE: `rateBooks.lock` is set, the job
 * that set it is gone, and nothing will ever clear it. A scheduled mutation
 * killed by a runtime limit ("timed out performing too many system operations")
 * does not get to run its own catch block, and an action killed by a deploy does
 * not either — so the lock is not a sign of work in progress, it is the
 * fingerprint of work that died. It is indistinguishable from a healthy lock by
 * inspection, which is the whole reason `heartbeatAt` is written.
 */
export function isLockStale(heartbeatAt: number, now: number): boolean {
  return now - heartbeatAt > STALE_LOCK_MS;
}

/**
 * Record that this transaction changed the draft's catalog content.
 *
 * ⚠️ CALL IT FROM EVERY WRITER OF A POOL ROW, AND FROM NOWHERE ELSE. It is
 * called from {@link writePoolRow}, from `insertPoolRow`, and from
 * `revertImportBatch`'s delete path — create, change, remove — because
 * `rateBooks.contentRevision` is the whole staleness story: G5 compares it
 * against the diff's stamps, G7 against the benchmark's, G10 against the
 * revision the publish screen rendered, and every acknowledgement is void the
 * moment it moves. A writer that skips this makes all three pass on a
 * comparison of a catalog that no longer exists, while the screen goes on
 * saying somebody checked.
 *
 * ⚠️ ONCE PER TRANSACTION, NOT ONCE PER ROW, and that is what
 * `contentRevisionAt` is for. This sits inside the per-row chokepoint, so a
 * 300-row import calls it 300 times; Convex mutations read their own writes, so
 * a plain read-increment-write would land the revision 300 higher and G5 would
 * tell an admin the draft "has been written to 300 times since you looked"
 * about one import. `Date.now()` is fixed for the duration of a Convex
 * mutation, so a transaction recognises its own earlier bump and returns it.
 * Convex coalesces the repeated patches into one document write.
 *
 * The one seam left: two transactions landing in the same millisecond, where the
 * second reads the first's stamp and skips its own bump. It is not a staleness
 * hole — the first transaction moved the revision, so every diff, benchmark and
 * signature from before both is already void — it costs only the magnitude of
 * one sentence, and Convex's own conflict detection makes the pair rare to begin
 * with.
 *
 * WHAT IT COSTS THE BIGGEST BATCH, against the ceiling that killed the link
 * repair. `applyImportBatch` writes 300 rows a transaction and
 * `applyBulkAdjustBatch` 250, so this adds ONE document read per row — 300
 * reads of one already-cached document, against Convex's 16,384 — and exactly
 * ONE write, because every call after the first matches the stamp and returns.
 * Nothing here reloads a pool, which is the shape of the mistake that aborted a
 * mutation mid-run with no way to record why.
 *
 * Status is deliberately NOT re-checked here. `writePoolRow` refuses a non-draft
 * book per row and is the guard; a second refusal with different wording for one
 * condition is how a subsystem ends up with two answers to one question.
 *
 * @returns the revision the draft now sits at.
 */
export async function touchDraft(ctx: MutationCtx, bookId: Id<"rateBooks">): Promise<number> {
  const book = await ctx.db.get(bookId);
  if (!book) throw new Error("Rate book not found.");

  const now = Date.now();
  const current = book.contentRevision ?? 0;
  if (book.contentRevisionAt === now) return current;

  const next = current + 1;
  await ctx.db.patch(bookId, { contentRevision: next, contentRevisionAt: now });
  return next;
}

/** Refuse anything that would write to a book that is not an open draft. */
export async function requireDraftBook(
  ctx: MutationCtx,
  bookId: Id<"rateBooks">,
  op: RateBookOp
): Promise<Doc<"rateBooks">> {
  const book = await ctx.db.get(bookId);
  if (!book) throw new Error("Rate book not found.");
  if (book.status !== "draft") {
    throw new Error(
      `"${book.name}" is ${book.status} and can no longer be edited. Duplicate it as a draft to make changes.`
    );
  }
  if (book.lock && book.lock.op !== op) {
    throw new Error(
      `"${book.name}" is busy (${book.lock.op}). Wait for that to finish, or clear it if it has stalled.`
    );
  }
  return book;
}

export interface PoolRowWrite {
  bookId: Id<"rateBooks">;
  table: "wbsPool" | "phasePool" | "laborPool" | "equipmentPool";
  rowId: Id<"wbsPool"> | Id<"phasePool"> | Id<"laborPool"> | Id<"equipmentPool">;
  patch: Record<string, unknown>;
  /** Optimistic-concurrency guard from the row the caller last read. */
  expectedRevision?: number;
}

/**
 * THE ONLY function that writes a pool row.
 *
 * Every edit, every import batch, every bulk adjustment goes through here, so
 * the draft check cannot be forgotten at a call site. It re-asserts draft
 * status PER ROW rather than only at the entry mutation, which is what closes
 * the race where a publish lands between two batches of a long import.
 *
 * `rowRevision` is bumped on every write, returned so a caller can record what
 * it produced, and checked when the caller supplies one, so an edit made between an import's preview and its apply cannot be
 * silently clobbered — that would also record a "before" value that was never
 * current, falsifying the audit trail of the one subsystem whose entire
 * justification is a trustworthy audit trail.
 */
export async function writePoolRow(ctx: MutationCtx, args: PoolRowWrite): Promise<number> {
  const book = await ctx.db.get(args.bookId);
  if (!book || book.status !== "draft") {
    throw new Error("This rate book is no longer a draft; the change was not applied.");
  }

  const row = await ctx.db.get(args.rowId);
  if (!row) throw new Error("Catalog row not found.");
  if (row.bookId !== args.bookId) {
    throw new Error("Catalog row belongs to a different rate book.");
  }

  const current = row.rowRevision ?? 0;
  if (args.expectedRevision !== undefined && args.expectedRevision !== current) {
    // ⚠️ ConvexError, NOT Error, and the `kind` is the load-bearing part.
    //
    // Convex redacts the message of a plain `throw new Error` on a production
    // deployment, so a client that recognises this refusal by its wording works
    // in development and silently degrades to "an error occurred" in front of a
    // customer — which is the generic failure the whole revision guard exists to
    // avoid. `ConvexError` data crosses that boundary intact.
    throw new ConvexError({
      kind: STALE_ROW,
      message:
        "This row changed since you loaded it. Reload the catalog and reapply, so nothing is overwritten unseen.",
    });
  }

  await ctx.db.patch(args.rowId, { ...args.patch, rowRevision: current + 1 });
  // The book's revision moves with the row's, in the same transaction, from the
  // one function every edit already has to pass through. Bumping it at the
  // mutation entry points instead would leave a new entry point free to forget.
  await touchDraft(ctx, args.bookId);
  return current + 1;
}
