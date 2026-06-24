/**
 * Convex cron job definitions.
 *
 * @module
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Proposals-only sync (Firestore → Convex), every 6 hours.
 *
 * WHY proposals-only: keeps the New Project list current by upserting the small
 * `proposals` collection — cheap, because it skips every proposal's
 * wbs/phase/activity tree. A proposal's full tree is pulled on demand the
 * moment a Momentum project is created (`momentum.createProjectFromProposal`),
 * so we only ever pay the expensive tree read for proposals that become
 * projects.
 *
 * WHY every 6h (was daily): a PM who awards an estimate in the MCP Estimator
 * expects to convert it to tracking shortly after, so an up-to-24h lag was too
 * coarse. The pull is cheap enough to run often, and `createSyncJob` now
 * reclaims a hung run, so a stuck job can't wedge the next tick.
 *
 * The full-tree sync (`sync.syncEngine.startSync`) is intentionally kept on the
 * shelf — not on a cron — for the one-time migration when Precision sunsets the
 * MCP Estimator and everything must land in Convex.
 */
crons.interval("proposals-sync", { hours: 6 }, internal.sync.syncEngine.syncProposals);

export default crons;
