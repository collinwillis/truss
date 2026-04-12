/**
 * Convex cron job definitions.
 *
 * WHY: Scheduled tasks that run automatically. The daily Firestore sync
 * keeps Convex up to date while users still use the old MCP Estimator
 * during the transition period.
 *
 * @module
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Daily Firestore → Convex sync.
 *
 * DISABLED: Initial full sync complete. Re-enable when incremental sync
 * with updateTime optimization is implemented to reduce Firestore read costs.
 *
 * To re-enable: uncomment the crons.daily() call below.
 */
// crons.daily(
//   "daily-firestore-sync",
//   { hourUTC: 6, minuteUTC: 0 },
//   internal.sync.syncEngine.startSync
// );

export default crons;
