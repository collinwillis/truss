/**
 * Convex cron job definitions.
 *
 * @module
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Daily proposals-only sync (Firestore → Convex).
 *
 * WHY proposals-only: keeps the New Project list current by upserting the small
 * `proposals` collection nightly — cheap, because it skips every proposal's
 * wbs/phase/activity tree. A proposal's full tree is pulled on demand the
 * moment a Momentum project is created (`momentum.createProjectFromProposal`),
 * so we only ever pay the expensive tree read for proposals that become
 * projects.
 *
 * The full-tree sync (`sync.syncEngine.startSync`) is intentionally kept on the
 * shelf — not on a cron — for the one-time migration when Precision sunsets the
 * MCP Estimator and everything must land in Convex.
 */
crons.daily(
  "daily-proposals-sync",
  { hourUTC: 6, minuteUTC: 0 },
  internal.sync.syncEngine.syncProposals
);

export default crons;
