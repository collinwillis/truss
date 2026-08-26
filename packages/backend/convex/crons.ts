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
 * WHY IT SURVIVES THE ESTATE PASS BELOW, which does strictly more work. It is
 * not redundant, it is the cheap tier of a two-tier mirror. The estate pass runs
 * DAILY because it reads ~360,000 documents (~$0.21 a pass, ~$6.50 a month at
 * that cadence, ~$26 at every-6-hours) — so between two estate passes a
 * proposal's metadata could be up to 24 hours stale, and this closes that gap
 * for 736 documents, about $0.0004 a tick. If the estate pass is ever cheap
 * enough to run every 6 hours, this one becomes redundant and should go; until
 * then, deleting it makes the New Project list worse and saves nothing.
 *
 * The two never collide: `createSyncJob` gives one run the lane and the other
 * skips the tick with a log line rather than an error, because an overlap
 * between a 6-hourly tick and a pass that runs for tens of minutes is expected
 * operation, not an incident.
 */
crons.interval("proposals-sync", { hours: 6 }, internal.sync.syncEngine.syncProposals);

/**
 * Full-estate differential sync (Firestore → Convex), daily at 08:00 UTC.
 *
 * WHY THIS EXISTS AT ALL. The mirror used to pull a proposal's tree only when
 * somebody turned it into a Momentum project, so a tree existed only if that had
 * happened and was frozen at whatever it looked like that day: 121 of 736
 * proposals had no tree in Convex, and the 615 that did were pulled at 615
 * different moments and went stale silently every time an estimator touched one.
 *
 * WHY IT IS A FULL READ. Editing an activity in the MCP Estimator writes only to
 * the `activities` collection (`src/api/activity.ts`), so `proposal.updateTime`
 * never moves for a tree edit, and activities carry no `updatedAt` field at all.
 * Firestore therefore cannot be asked what changed — there is no incremental
 * read to have. So the pass reads everything and DIFFERENTIALLY WRITES: only
 * rows whose mirrored content actually moved are written, decided by
 * `model/syncDiff.ts`. That is the difference between 352,969 writes a pass and
 * a few dozen, and it is the only reason this is on a cron instead of on a shelf.
 *
 * WHY DAILY, AND AT THIS HOUR. Reads dominate the cost — ~360,000 documents at
 * $0.06/100k is ~$0.21 a pass, so daily is ~$6.50 a month and 6-hourly would be
 * ~$26 for a mirror that is already only as fresh as the estimator's last save.
 * 08:00 UTC is roughly 2–3am in InDemand's timezone, so the pass and the people
 * editing estimates are never in the same hour — which matters because a tree an
 * estimator has claimed in Precision is skipped, not merged.
 *
 * WHAT IT WILL NOT DO. It never deletes: a row Firestore stopped returning is
 * flagged `mirrorDeletedAt` and left in place, because
 * `momentumActivities.sourceActivityId` points at these rows from a live
 * product. It never touches a tree stamped `precisionOwnedAt`, and it never
 * re-inserts a tombstoned one (DECISIONS.md D1). And it never mirrors a
 * `laborPoolId`/`equipmentPoolId` back over a repaired one unless the line's
 * description changed — 8,944 links were re-pointed on 2026-08-05 and Firestore
 * still holds the ids that would undo them.
 *
 * ONE MECHANISM. The first run is the catch-up for the 121 empty proposals AND
 * the staleness in the other 615; every later run is the incremental. There is
 * no separate migration path, because a migration path that runs once is a
 * migration path nobody maintains.
 *
 * IF IT BREAKS: a chain 736 links long will. Every proposal writes
 * `lastProgressAt`, so a stall is provable rather than inferred, and
 * `sync.syncMutations.resumeEstateSync` picks the run back up at its cursor —
 * including a run still marked `running` because a hard runtime abort killed it
 * before its own error handler. Run `sync.syncEngine.startEstateSync` with
 * `{ dryRun: true }` first if you want the report without the writes.
 */
crons.daily(
  "estate-sync",
  { hourUTC: 8, minuteUTC: 0 },
  internal.sync.syncEngine.startEstateSync,
  {}
);

/**
 * Release rate-book locks whose owner died, every 5 minutes.
 *
 * WHY IT EXISTS. `rateBooks.lock` is the only thing stopping a clone, an import
 * apply, a revert, a bulk adjustment, a diff, a benchmark and a publish from
 * interleaving on one draft — and `lock.heartbeatAt` was written by four of them
 * and read by nothing. A scheduled mutation killed by a runtime limit never
 * reaches its own catch block; an action killed by a deploy never reaches
 * anything. Either way the lock stays set for ever, G0 blocks publish for ever,
 * every catalog edit is refused, and the at-most-one-open-draft rule means the
 * admin cannot discard the draft and start over. One dead job wedged the whole
 * subsystem permanently, with no way out that did not involve a console.
 *
 * WHY 5 MINUTES AGAINST A 10-MINUTE STALENESS BAR. The bar is
 * `model/rateBookAccess.STALE_LOCK_MS`; ticking at half of it means a dead lock
 * is cleared 10–15 minutes after the job stopped, which is short enough that an
 * admin who steps away and comes back finds a draft they can use, and long
 * enough that no live job is ever within two orders of magnitude of it —
 * every one of them refreshes the heartbeat once per batch, seconds apart.
 *
 * WHY IT IS CHEAP. `rateBooks` holds a handful of documents (one open draft at a
 * time by construction), so a tick that finds nothing reads a handful and writes
 * nothing at all.
 */
crons.interval("rate-book-lock-reaper", { minutes: 5 }, internal.rateBooks.reapStaleLocks, {});

export default crons;
