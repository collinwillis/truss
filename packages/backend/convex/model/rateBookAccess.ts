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

export type RateBookOp = "clone" | "import" | "revert" | "publish" | "discard" | "bulkEdit";

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
  return current + 1;
}
