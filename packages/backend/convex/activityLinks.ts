import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePrecisionAdmin } from "./model/precisionAccess";
import {
  buildCatalogIndex,
  countResolution,
  emptyTally,
  resolveActivityLink,
  type CatalogIndex,
  type CatalogItem,
} from "./model/activityLinks";

/**
 * Re-pointing every estimate line at the catalog item it actually describes.
 *
 * See `model/activityLinks.ts` for what went wrong and why the name is the
 * authority. This file is the machinery: a dry run that changes nothing, a real
 * run that records every change, and a revert.
 *
 * ⚠️ ALWAYS DRY-RUN FIRST. A dry run does the identical work and writes no
 * link, so the tally it produces is the exact tally the real run will produce.
 * There is no reason to guess at the blast radius on 713 production estimates
 * when the true number is one mutation away.
 */

/**
 * Activities scanned per batch.
 *
 * Sized against the transaction ceiling rather than by feel: the catalog costs
 * ~6,030 reads (5,897 labor + 129 equipment) and is loaded once per batch, the
 * activities cost one read each, and their phases and proposals a few hundred
 * more. 1,500 keeps the whole batch near 8,000 of the 16,384 allowed, leaving
 * room for the largest estimates to be unusually phase-dense.
 */
const SCAN_BATCH = 1500;

/** Repair records deleted per batch when a run is discarded. */
const CLEANUP_BATCH = 500;

/**
 * Start a repair pass over every estimate line.
 *
 * One pass at a time: two concurrent passes would interleave their writes and
 * neither one's record of "what it was before" would be true afterwards.
 */
export const startLinkRepair = mutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const access = await requirePrecisionAdmin(ctx);
    return await beginRun(ctx, args.dryRun, access.userId);
  },
});

/**
 * The same two entry points, runnable from the Convex dashboard.
 *
 * The public versions require a Precision admin session, which a dashboard has
 * no way to present. `migrationStatus` learned this the hard way.
 */
export const startLinkRepairFromDashboard = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => await beginRun(ctx, args.dryRun, "dashboard"),
});

export const linkRepairStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db
      .query("activityLinkRuns")
      .withIndex("by_started")
      .order("desc")
      .take(5);
    return runs.map((run) => ({
      runId: run._id,
      dryRun: run.dryRun,
      state: run.state,
      error: run.error ?? null,
      tally: run.tally,
    }));
  },
});

/** Create the run record and kick off the scan. */
async function beginRun(ctx: MutationCtx, dryRun: boolean, startedBy: string) {
  const recent = await ctx.db
    .query("activityLinkRuns")
    .withIndex("by_started")
    .order("desc")
    .take(5);
  if (recent.some((run) => run.state === "running" || run.state === "reverting")) {
    throw new Error("A link repair is already running. Wait for it to finish.");
  }
  const runId = await ctx.db.insert("activityLinkRuns", {
    dryRun,
    state: "running",
    startedBy,
    startedAt: Date.now(),
    tally: emptyTally(),
  });
  await ctx.scheduler.runAfter(0, internal.activityLinks.repairBatch, { runId, cursor: null });
  return runId;
}

export const repairBatch = internalMutation({
  args: { runId: v.id("activityLinkRuns"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.state !== "running") return { done: true };

    try {
      const page = await ctx.db
        .query("activities")
        .paginate({ cursor: args.cursor, numItems: SCAN_BATCH });

      const tally = { ...run.tally };
      // The catalog is loaded once per batch and shared by every line in it.
      const catalogs = new Map<string, { labor: CatalogIndex; equipment: CatalogIndex }>();
      const phasePoolIds = new Map<string, number | undefined>();
      const bookIds = new Map<string, Id<"rateBooks"> | undefined>();

      for (const activity of page.page) {
        const bookId = await bookIdFor(ctx, activity.proposalId, bookIds);
        if (!bookId) {
          countResolution(tally, { verdict: "not_applicable" });
          continue;
        }
        const catalog = await catalogFor(ctx, bookId, catalogs);
        const pool = activity.type === "labor" ? "labor" : "equipment";
        const currentPoolId =
          activity.type === "labor" ? activity.laborPoolId : activity.equipmentPoolId;

        const resolution = resolveActivityLink(
          {
            type: activity.type,
            description: activity.description,
            currentPoolId,
            phasePoolId:
              activity.type === "labor"
                ? await phasePoolIdFor(ctx, activity.phaseId, phasePoolIds)
                : undefined,
            numbers: lineNumbers(activity),
          },
          pool === "labor" ? catalog.labor : catalog.equipment
        );
        countResolution(tally, resolution);

        if (resolution.verdict === "relink") {
          if (!run.dryRun) {
            await ctx.db.patch(
              activity._id,
              pool === "labor"
                ? { laborPoolId: resolution.poolId }
                : { equipmentPoolId: resolution.poolId }
            );
          }
          await ctx.db.insert("activityLinkRepairs", {
            runId: args.runId,
            activityId: activity._id,
            proposalId: activity.proposalId,
            pool,
            outcome: "relink",
            description: activity.description,
            fromPoolId: currentPoolId as number,
            toPoolId: resolution.poolId,
            confidence: resolution.confidence,
          });
        } else if (resolution.verdict === "no_match" || resolution.verdict === "ambiguous") {
          // Refusals are recorded as deliberately as changes: "nothing in this
          // book is called that" is the answer to a question somebody will ask.
          await ctx.db.insert("activityLinkRepairs", {
            runId: args.runId,
            activityId: activity._id,
            proposalId: activity.proposalId,
            pool,
            outcome: resolution.verdict,
            description: activity.description,
            fromPoolId: currentPoolId as number,
            reason: resolution.reason,
          });
        }
      }

      if (page.isDone) {
        await ctx.db.patch(args.runId, { state: "done", tally, finishedAt: Date.now() });
        return { done: true };
      }
      await ctx.db.patch(args.runId, { tally, cursor: page.continueCursor });
      await ctx.scheduler.runAfter(0, internal.activityLinks.repairBatch, {
        runId: args.runId,
        cursor: page.continueCursor,
      });
      return { done: false };
    } catch (error) {
      await ctx.db.patch(args.runId, {
        state: "failed",
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : "Link repair failed.",
      });
      return { done: true, failed: true };
    }
  },
});

/** Resume a run that a transient failure stopped part-way. */
export const resumeLinkRepair = mutation({
  args: { runId: v.id("activityLinkRuns") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found.");
    if (run.state !== "failed") throw new Error("That run has not failed.");
    await ctx.db.patch(args.runId, { state: "running", error: undefined });
    await ctx.scheduler.runAfter(0, internal.activityLinks.repairBatch, {
      runId: args.runId,
      cursor: run.cursor ?? null,
    });
  },
});

/**
 * Put every link this run moved back where it was.
 *
 * Unconditional, unlike the rate-book import's revert: a link carries no
 * estimator intent to protect. Nobody hand-picks a catalog id — they pick an
 * item, and the id is bookkeeping. If the repair was wrong, the honest response
 * is to restore the state we found and look again.
 */
export const revertLinkRepair = mutation({
  args: { runId: v.id("activityLinkRuns") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found.");
    if (run.dryRun) throw new Error("A dry run changed nothing; there is nothing to put back.");
    if (run.state !== "done" && run.state !== "failed") {
      throw new Error("Wait for the run to finish before reverting it.");
    }
    await ctx.db.patch(args.runId, { state: "reverting" });
    await ctx.scheduler.runAfter(0, internal.activityLinks.revertBatch, { runId: args.runId });
  },
});

export const revertBatch = internalMutation({
  args: { runId: v.id("activityLinkRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.state !== "reverting") return { done: true };

    const records = await ctx.db
      .query("activityLinkRepairs")
      .withIndex("by_run_outcome", (q) => q.eq("runId", args.runId).eq("outcome", "relink"))
      .take(CLEANUP_BATCH);
    const pending = records.filter((record) => record.revertedAt === undefined);

    for (const record of pending) {
      const activity = await ctx.db.get(record.activityId);
      if (activity) {
        await ctx.db.patch(
          record.activityId,
          record.pool === "labor"
            ? { laborPoolId: record.fromPoolId }
            : { equipmentPoolId: record.fromPoolId }
        );
      }
      await ctx.db.patch(record._id, { revertedAt: Date.now() });
    }

    if (pending.length === 0) {
      await ctx.db.patch(args.runId, { state: "reverted", finishedAt: Date.now() });
      return { done: true };
    }
    await ctx.scheduler.runAfter(0, internal.activityLinks.revertBatch, { runId: args.runId });
    return { done: false };
  },
});

/** The book an estimate is priced from, memoised for one batch. */
async function bookIdFor(
  ctx: MutationCtx,
  proposalId: Id<"proposals">,
  cache: Map<string, Id<"rateBooks"> | undefined>
): Promise<Id<"rateBooks"> | undefined> {
  const key = proposalId as string;
  if (cache.has(key)) return cache.get(key);
  const proposal = await ctx.db.get(proposalId);
  const bookId = proposal?.bookId;
  cache.set(key, bookId);
  return bookId;
}

/** The catalog phase a line sits in, taken from the PHASE, memoised. */
async function phasePoolIdFor(
  ctx: MutationCtx,
  phaseId: Id<"phases">,
  cache: Map<string, number | undefined>
): Promise<number | undefined> {
  const key = phaseId as string;
  if (cache.has(key)) return cache.get(key);
  const phase = await ctx.db.get(phaseId);
  const poolId = phase?.phasePoolId;
  cache.set(key, poolId);
  return poolId;
}

/** Both pools of one book, indexed by name, memoised for one batch. */
async function catalogFor(
  ctx: MutationCtx,
  bookId: Id<"rateBooks">,
  cache: Map<string, { labor: CatalogIndex; equipment: CatalogIndex }>
): Promise<{ labor: CatalogIndex; equipment: CatalogIndex }> {
  const key = bookId as string;
  const hit = cache.get(key);
  if (hit) return hit;

  const laborRows = await ctx.db
    .query("laborPool")
    .withIndex("by_book", (q) => q.eq("bookId", bookId))
    .collect();
  const equipmentRows = await ctx.db
    .query("equipmentPool")
    .withIndex("by_book", (q) => q.eq("bookId", bookId))
    .collect();

  const labor: CatalogItem[] = laborRows.map((r) => ({
    poolId: r.poolId,
    description: r.description,
    phasePoolId: r.phasePoolId,
    numbers: [r.craftConstant, r.weldConstant],
  }));
  const equipment: CatalogItem[] = equipmentRows.map((r) => ({
    poolId: r.poolId,
    description: r.description,
    numbers: [r.hourRate, r.dayRate, r.weekRate, r.monthRate],
  }));

  const built = { labor: buildCatalogIndex(labor), equipment: buildCatalogIndex(equipment) };
  cache.set(key, built);
  return built;
}

/**
 * The numbers a line carries, for corroborating a name match.
 *
 * An equipment line's rate lives in `unitPrice`, because the four catalog rates
 * collapse to whichever one matches the line's unit at the moment it is picked.
 */
function lineNumbers(activity: Doc<"activities">): number[] {
  if (activity.type === "labor") {
    return [activity.labor?.craftConstant ?? 0, activity.labor?.welderConstant ?? 0];
  }
  return activity.unitPrice === undefined ? [] : [activity.unitPrice];
}

/** The last few runs, for the screen that starts them. */
export const listLinkRepairs = query({
  args: {},
  handler: async (ctx) => {
    await requirePrecisionAdmin(ctx);
    const runs = await ctx.db
      .query("activityLinkRuns")
      .withIndex("by_started")
      .order("desc")
      .take(10);
    return runs.map((run) => ({
      _id: run._id,
      dryRun: run.dryRun,
      state: run.state,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      error: run.error ?? null,
      tally: run.tally,
    }));
  },
});

/**
 * One run, with the lines it could not resolve.
 *
 * The refusals are the interesting half. A relink is bookkeeping; a line whose
 * name is in no catalog is a real question about a real estimate.
 */
export const getLinkRepair = query({
  args: { runId: v.id("activityLinkRuns") },
  handler: async (ctx, args) => {
    await requirePrecisionAdmin(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const ofOutcome = async (outcome: "no_match" | "ambiguous" | "relink") =>
      await ctx.db
        .query("activityLinkRepairs")
        .withIndex("by_run_outcome", (q) => q.eq("runId", args.runId).eq("outcome", outcome))
        .take(50);
    const [noMatch, ambiguous, relinked] = await Promise.all([
      ofOutcome("no_match"),
      ofOutcome("ambiguous"),
      ofOutcome("relink"),
    ]);

    const slim = (r: Doc<"activityLinkRepairs">) => ({
      description: r.description,
      pool: r.pool,
      fromPoolId: r.fromPoolId,
      toPoolId: r.toPoolId ?? null,
      confidence: r.confidence ?? null,
      reason: r.reason ?? null,
    });

    return {
      _id: run._id,
      dryRun: run.dryRun,
      state: run.state,
      tally: run.tally,
      error: run.error ?? null,
      noMatch: noMatch.map(slim),
      ambiguous: ambiguous.map(slim),
      relinked: relinked.map(slim),
    };
  },
});
