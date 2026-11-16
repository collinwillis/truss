/**
 * Sync status, for the dashboard and `npx convex run`.
 *
 * Internal: no app reads sync jobs, and their errors carry Firestore ids and
 * raw failure text that are no signed-in member's business. They were public
 * with no caller check, so anyone holding the deployment URL, which ships
 * inside both desktop bundles, could read them.
 *
 * @module
 */

import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

/** The ten most recent sync jobs, newest first. */
export const getLatestSyncJobs = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("syncJobs").order("desc").take(10);
  },
});

/** One sync job's status and errors, or `null` when it does not exist. */
export const getSyncJobErrors = internalQuery({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return { status: job.status, errors: job.errors };
  },
});
