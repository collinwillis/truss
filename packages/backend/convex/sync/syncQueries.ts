/**
 * Public queries for monitoring sync status in the admin UI.
 *
 * @module
 */

import { query } from "../_generated/server";
import { v } from "convex/values";

/** Get the most recent sync jobs for the admin dashboard. */
export const getLatestSyncJobs = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("syncJobs").order("desc").take(10);
  },
});

/** Get error details for a specific sync job. */
export const getSyncJobErrors = query({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return { status: job.status, errors: job.errors };
  },
});
