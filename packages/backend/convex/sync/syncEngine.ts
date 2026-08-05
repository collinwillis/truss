/**
 * The reading half of the Firestore mirror: one proposal per action, then the
 * next.
 *
 * WHY FULL READ, DIFFERENTIAL WRITE. `src/api/activity.ts` in the legacy app
 * writes only to the `activities` collection, so editing a line never touches
 * the proposal document and `proposal.updateTime` is not a change signal for
 * tree edits. Activities carry no `updatedAt` at all, so Firestore cannot be
 * asked which ones changed. There is therefore no incremental read to be had:
 * the pass reads everything (~360,000 documents, about $0.21 at $0.06/100k) and
 * writes only the rows whose content actually moved. Every later pass costs the
 * same reads and almost no writes.
 *
 * WHY ONE PROPOSAL PER ACTION: Cloudflare proxies Convex actions with a ~100s
 * timeout, and the largest estimates run to 10K+ activities. One proposal per
 * action means the ceiling is never approached mid-proposal, and the
 * self-scheduling chain carries all 736 across as many invocations as it takes.
 *
 * WHY THE CHAIN CARRIES A CURSOR AND A HEARTBEAT: a chain 736 links long WILL
 * break. The queue lives on the job record and `processedProposals` is the index
 * into it, so a resume restarts at the proposal the broken chain was about to
 * reach — and because a re-visited proposal diffs to UNCHANGED, an over-eager
 * resume costs reads and no writes.
 *
 * @module
 */

import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  getFirebaseAuthToken,
  fetchCollectionPage,
  fetchDocumentById,
  fetchByField,
  parseDocument,
} from "./firestoreClient";
import { mapProposal, mapWBS, mapPhase, mapActivity } from "./fieldMapping";
import { emptyLevelCounts, sumLevelCounts, type LevelCounts } from "../model/syncDiff";
import type { MirrorKeyPage } from "./syncMutations";

const PROJECT_ID = "mcp-estimator";
const PROPOSALS_PER_PAGE = 100;

/**
 * Rows written per mutation transaction, sized against the ceiling rather than
 * guessed — the omission that aborted the link repair mid-run.
 *
 * ACTIVITY_CHUNK: one activity costs one indexed read (`by_firestore_id`) and at
 * most one write, so a chunk of 1,000 is ~1,001 documents read against Convex's
 * 16,384 limit (6%) and at most 1,000 written against 8,192 (12%). In system
 * operations it is ~2,000 at absolute worst — the pass where everything moves —
 * against the ~7,500 that actually triggered "timed out performing too many
 * system operations" in `activityLinks.repairBatch`. In steady state the writes
 * are near zero and a chunk is ~1,000 reads. The parent maps come in through
 * `resolved`, so a chunk never re-collects the phase list the way the first
 * repair re-collected the labor pool.
 *
 * PHASE_CHUNK: same arithmetic on a level that runs to hundreds, not thousands.
 *
 * ORPHAN_SCAN_PAGE: read-only, and one paginated index scan rather than N
 * lookups — 2,000 documents is 12% of the read ceiling and one system operation.
 */
const ACTIVITY_CHUNK = 1000;
const PHASE_CHUNK = 500;
const ORPHAN_SCAN_PAGE = 2000;

/**
 * Pages of stored rows one proposal's orphan scan will read before giving up.
 *
 * A cap is safe in the direction that matters: a partial scan can only MISS an
 * orphan, never invent one, because every row it flags is one it actually read
 * and genuinely did not find upstream. 12 pages is 24,000 rows — twice the
 * largest estimate — so it bounds a pathological tree without ever truncating a
 * real one, and the truncation is recorded either way.
 */
const ORPHAN_SCAN_MAX_PAGES = 12;

/** Orphan transitions per write transaction. Only transitions are written. */
const ORPHAN_FLAG_BATCH = 500;

/** Reuse a Firebase token for 50 minutes; they last an hour. */
const TOKEN_LIFETIME = 50 * 60 * 1000;

/** Per-level tallies for one tree. */
interface ByLevelCounts {
  proposal: LevelCounts;
  wbs: LevelCounts;
  phase: LevelCounts;
  activity: LevelCounts;
}

/** What a pass did to one proposal's tree. */
interface TreeOutcome {
  byLevel: ByLevelCounts;
  suppressedLinks: number;
  unresolved: number;
  skipped: "precision_owned" | "deleted_in_precision" | "missing_upstream" | null;
  proposalId: Id<"proposals"> | null;
  proposalNumber: string;
  orphanScanIncomplete: boolean;
  orphanScanRefused: boolean;
  /** Kept so the on-demand Momentum pull can report what it moved. */
  inserted: number;
  updated: number;
  unchanged: number;
}

function emptyByLevel(): ByLevelCounts {
  return {
    proposal: emptyLevelCounts(),
    wbs: emptyLevelCounts(),
    phase: emptyLevelCounts(),
    activity: emptyLevelCounts(),
  };
}

/** Add one call's per-level tallies into a running roster. */
function addByLevel(into: ByLevelCounts, part: ByLevelCounts): ByLevelCounts {
  return {
    proposal: sumLevelCounts(into.proposal, part.proposal),
    wbs: sumLevelCounts(into.wbs, part.wbs),
    phase: sumLevelCounts(into.phase, part.phase),
    activity: sumLevelCounts(into.activity, part.activity),
  };
}

/** Split a list into fixed-size chunks; always at least one chunk. */
function chunk<T>(rows: readonly T[], size: number): T[][] {
  if (rows.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Flag the stored rows of one level that Firestore no longer returns, and clear
 * the flag on any that came back.
 *
 * ⚠️ REFUSES TO SCAN A LEVEL THAT READ BACK EMPTY WHILE CONVEX HOLDS ROWS.
 * The mirror finds a tree with a `proposalId` equality query, so one bad query
 * result — a legacy row whose parent pointer was never written, a transient
 * Firestore hiccup — would otherwise condemn an entire estimate's lines in a
 * single pass. An estimator deleting all 680 lines of a live estimate and
 * leaving the proposal behind is not a thing that happens; a bad read is.
 *
 * Nothing here deletes. See `flagMirrorOrphans`.
 *
 * ⚠️ ALSO THE ONLY PLACE `localOnly` AND `duplicate` CAN BE COUNTED. Both the
 * differ and the schema promise those two numbers, on the grounds that a report
 * must never present "we ignored 8,000 rows" as "nothing happened" — but
 * `upsertProposalHierarchy` cannot supply either. It looks each INCOMING row up
 * by `firestoreId` and never enumerates the stored set, so a Precision-born row
 * (no mirror key) and a second copy sharing one key are both invisible to it,
 * and the fields it reports were hard zeros. This scan is the one pass that
 * walks the stored rows, so it is the one place the promise can be kept.
 *
 * The duplicate count is the one worth having. A second copy is matched by
 * neither loop — the upsert's `.first()` updates one of them for ever and the
 * other drifts silently — while the orphan test sees the shared key as present
 * and correctly declines to flag it. Without this counter nothing anywhere says
 * the row exists.
 */
async function scanOrphans(
  ctx: ActionCtx,
  level: "wbs" | "phase" | "activity",
  proposalId: Id<"proposals">,
  incomingIds: ReadonlySet<string>,
  dryRun: boolean
): Promise<{
  orphaned: number;
  cleared: number;
  localOnly: number;
  duplicate: number;
  incomplete: boolean;
  refused: boolean;
}> {
  let cursor: string | null = null;
  let pages = 0;
  let orphaned = 0;
  let cleared = 0;
  let localOnly = 0;
  let duplicate = 0;
  // Bounded by ORPHAN_SCAN_MAX_PAGES * ORPHAN_SCAN_PAGE = 24,000 keys, which is
  // what makes holding them all in the action safe to say rather than hope.
  const seen = new Set<string>();
  const toFlag: string[] = [];
  const toClear: string[] = [];
  const at = Date.now();

  const flush = async (force: boolean) => {
    if (!force && toFlag.length < ORPHAN_FLAG_BATCH && toClear.length < ORPHAN_FLAG_BATCH) return;
    if (toFlag.length === 0 && toClear.length === 0) return;
    if (!dryRun) {
      await ctx.runMutation(internal.sync.syncMutations.flagMirrorOrphans, {
        level,
        flag: toFlag.splice(0, toFlag.length),
        clear: toClear.splice(0, toClear.length),
        at,
      });
    } else {
      toFlag.length = 0;
      toClear.length = 0;
    }
  };

  while (pages < ORPHAN_SCAN_MAX_PAGES) {
    const page: MirrorKeyPage = await ctx.runQuery(internal.sync.syncMutations.listMirrorKeys, {
      level,
      proposalId,
      cursor,
      numItems: ORPHAN_SCAN_PAGE,
    });
    pages++;

    if (incomingIds.size === 0 && page.keys.length > 0) {
      return {
        orphaned: 0,
        cleared: 0,
        localOnly: 0,
        duplicate: 0,
        incomplete: true,
        refused: true,
      };
    }

    for (const key of page.keys) {
      // Born in Precision, never mirrored — Firestore's silence says nothing.
      if (key.firestoreId === null) {
        localOnly++;
        continue;
      }
      if (seen.has(key.firestoreId)) duplicate++;
      else seen.add(key.firestoreId);
      const present = incomingIds.has(key.firestoreId);
      if (!present && !key.flagged) {
        toFlag.push(key.id);
        orphaned++;
      } else if (present && key.flagged) {
        toClear.push(key.id);
        cleared++;
      }
    }
    await flush(false);

    if (page.isDone) {
      await flush(true);
      return { orphaned, cleared, localOnly, duplicate, incomplete: false, refused: false };
    }
    cursor = page.cursor;
  }

  await flush(true);
  return { orphaned, cleared, localOnly, duplicate, incomplete: true, refused: false };
}

/**
 * Read one proposal's tree from Firestore and write only what changed.
 *
 * Shared by the estate pass and by the on-demand pull that runs when a Momentum
 * project is created — ONE MECHANISM, so there is no separate migration path to
 * drift out of step with the incremental one. The first pass is the catch-up for
 * the 121 proposals with no tree AND the staleness in the other 615; every later
 * pass is the incremental, and neither is a different code path.
 */
async function fetchAndUpsertProposalTree(
  ctx: ActionCtx,
  proposalFsId: string,
  authToken: string,
  opts?: {
    progressToken?: string;
    dryRun?: boolean;
    scanOrphans?: boolean;
    /**
     * Called the moment the estimate has a name, so a caller that only sees a
     * thrown error can still say WHICH estimate it was. A return value cannot
     * do this: the throw is what stops there being one.
     */
    onIdentified?: (proposalNumber: string) => void;
  }
): Promise<TreeOutcome> {
  const dryRun = opts?.dryRun === true;
  let byLevel = emptyByLevel();
  let suppressedLinks = 0;
  let unresolved = 0;

  /** Report determinate import progress when a client is subscribed. */
  const report = async (fields: Record<string, unknown>) => {
    if (!opts?.progressToken) return;
    await ctx.runMutation(internal.momentum.updateImportJob, {
      token: opts.progressToken,
      ...fields,
    });
  };

  const proposalDoc = await fetchDocumentById(PROJECT_ID, "proposals", proposalFsId, authToken);

  // ⚠️ NO DOCUMENT, NO WRITE. `mapProposal({})` yields an empty description, an
  // empty owner and fifteen zeroed rates, so mirroring an absent document would
  // blank a live estimate on the strength of a 404. The proposal is reported as
  // gone upstream and left exactly as it is.
  if (!proposalDoc) {
    return {
      byLevel,
      suppressedLinks: 0,
      unresolved: 0,
      skipped: "missing_upstream",
      proposalId: null,
      proposalNumber: "",
      orphanScanIncomplete: false,
      orphanScanRefused: false,
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };
  }

  // Mapped BEFORE the tree read, not after, purely so the number survives a
  // failure of that read. A tree query that 500s is the likeliest way a proposal
  // ends up on the error path, and a report row that names a live estimate by
  // nothing but a Firestore id is the row somebody most needs to read.
  const proposal = mapProposal(parseDocument(proposalDoc));
  opts?.onIdentified?.(proposal.proposalNumber);

  const [wbsDocs, phaseDocs, actDocs] = await Promise.all([
    fetchByField({
      projectId: PROJECT_ID,
      collection: "wbs",
      authToken,
      fieldPath: "proposalId",
      fieldValue: proposalFsId,
    }),
    fetchByField({
      projectId: PROJECT_ID,
      collection: "phase",
      authToken,
      fieldPath: "proposalId",
      fieldValue: proposalFsId,
    }),
    fetchByField({
      projectId: PROJECT_ID,
      collection: "activities",
      authToken,
      fieldPath: "proposalId",
      fieldValue: proposalFsId,
    }),
  ]);

  const wbsList = wbsDocs.map((d) => mapWBS(parseDocument(d)));
  const phasesList = phaseDocs.map((d) => mapPhase(parseDocument(d)));
  const activitiesList = actDocs.map((d) => mapActivity(parseDocument(d)));

  // Counts are known now that the fetch is done — switch the indicator from the
  // indeterminate "pulling" phase to a determinate "importing" bar.
  await report({
    status: "importing",
    stage: activitiesList.length > 0 ? "Importing activities" : "Importing estimate",
    wbsCount: wbsList.length,
    phaseCount: phasesList.length,
    activityCount: activitiesList.length,
    total: activitiesList.length,
    processed: 0,
  });

  const phaseChunks = chunk(phasesList, PHASE_CHUNK);
  const activityChunks = chunk(activitiesList, ACTIVITY_CHUNK);
  // The overwhelming majority of estimates fit in one transaction — 352,969
  // activities across 615 proposals averages 574 — so they cost exactly one
  // mutation, as they did before chunking existed.
  const singleCall = phaseChunks.length === 1 && activityChunks.length === 1;

  const firstCall = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
    proposal,
    wbsList,
    phasesList: phaseChunks[0] ?? [],
    activitiesList: singleCall ? (activityChunks[0] ?? []) : [],
    dryRun,
  });
  byLevel = addByLevel(byLevel, firstCall.byLevel);
  suppressedLinks += firstCall.suppressedLinks;
  unresolved += firstCall.unresolved;

  if (firstCall.skipReason !== null) {
    return {
      byLevel,
      suppressedLinks,
      unresolved,
      skipped: firstCall.skipReason,
      proposalId: null,
      proposalNumber: proposal.proposalNumber,
      orphanScanIncomplete: false,
      orphanScanRefused: false,
      inserted: 0,
      updated: 0,
      unchanged: 0,
    };
  }

  let resolved = firstCall.resolved;

  if (!singleCall) {
    for (const phases of phaseChunks.slice(1)) {
      const r = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
        proposal,
        wbsList: [],
        phasesList: phases,
        activitiesList: [],
        resolved: resolved ?? undefined,
        continuation: true,
        dryRun,
      });
      byLevel = addByLevel(byLevel, r.byLevel);
      suppressedLinks += r.suppressedLinks;
      unresolved += r.unresolved;
      // `resolved` is cumulative on the mutation's side — it returns what it was
      // handed plus what it added — so taking it whole is both correct and the
      // only way to stay correct. Merging here meant naming the levels that
      // chunk, and the version that named only `phases` silently dropped the WBS
      // map, which would leave every activity in the tree unresolved.
      resolved = r.resolved ?? resolved;
    }

    let processed = 0;
    for (const activities of activityChunks) {
      if (activities.length === 0) break;
      const r = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
        proposal,
        wbsList: [],
        phasesList: [],
        activitiesList: activities,
        resolved: resolved ?? undefined,
        continuation: true,
        dryRun,
      });
      byLevel = addByLevel(byLevel, r.byLevel);
      suppressedLinks += r.suppressedLinks;
      unresolved += r.unresolved;
      processed += activities.length;
      await report({ processed });
    }
  } else {
    await report({ processed: activitiesList.length });
  }

  const proposalId = resolved?.proposalId ?? null;

  // ------------------------------------------------------------------
  // Orphans: flagged, reported, never deleted
  // ------------------------------------------------------------------
  let orphanScanIncomplete = false;
  let orphanScanRefused = false;
  if (proposalId !== null && opts?.scanOrphans === true) {
    const scanned: Record<"wbs" | "phase" | "activity", LevelCounts> = {
      wbs: emptyLevelCounts(),
      phase: emptyLevelCounts(),
      activity: emptyLevelCounts(),
    };
    const levels = [
      { level: "wbs" as const, ids: new Set(wbsList.map((r) => r.firestoreId)) },
      { level: "phase" as const, ids: new Set(phasesList.map((r) => r.firestoreId)) },
      { level: "activity" as const, ids: new Set(activitiesList.map((r) => r.firestoreId)) },
    ];
    for (const { level, ids } of levels) {
      const result = await scanOrphans(ctx, level, proposalId, ids, dryRun);
      orphanScanIncomplete = orphanScanIncomplete || result.incomplete;
      orphanScanRefused = orphanScanRefused || result.refused;
      // The three the upsert structurally cannot see: it matches incoming rows
      // to stored ones by key and never walks the stored side.
      scanned[level] = {
        ...emptyLevelCounts(),
        orphaned: result.orphaned,
        localOnly: result.localOnly,
        duplicate: result.duplicate,
      };
    }
    byLevel = {
      proposal: byLevel.proposal,
      wbs: sumLevelCounts(byLevel.wbs, scanned.wbs),
      phase: sumLevelCounts(byLevel.phase, scanned.phase),
      activity: sumLevelCounts(byLevel.activity, scanned.activity),
    };
  }

  const totals = sumLevelCounts(byLevel.proposal, byLevel.wbs, byLevel.phase, byLevel.activity);
  return {
    byLevel,
    suppressedLinks,
    unresolved,
    skipped: null,
    proposalId,
    proposalNumber: proposal.proposalNumber,
    orphanScanIncomplete,
    orphanScanRefused,
    inserted: totals.insert,
    updated: totals.patch,
    unchanged: totals.unchanged,
  };
}

// ============================================================================
// Full-estate pass — entry point
// ============================================================================

/**
 * Start a full differential pass over every proposal in the MCP Estimator.
 *
 * COUNTS WHAT IS ACTUALLY THERE. The previous entry point hard-coded
 * `totalProposals: 623` against a live 736, so its own progress bar lied by 15%
 * from the first tick — and a progress report nobody trusts is the same as no
 * progress report. The queue is built by walking the collection, so the total is
 * a measurement.
 *
 * The walk happens AFTER the job is created, so a pass that is declined because
 * another is in flight costs nothing.
 */
export const startEstateSync = internalAction({
  args: {
    /** Read and diff everything, write nothing. Costs the reads, changes no row. */
    dryRun: v.optional(v.boolean()),
  },
  // Annotated because `resumeEstateSync` schedules back into this module, and
  // a cycle with no declared type is one TypeScript refuses to infer.
  handler: async (ctx, args): Promise<Id<"syncJobs"> | null> => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    const jobId: Id<"syncJobs"> | null = await ctx.runMutation(
      internal.sync.syncMutations.createSyncJob,
      {
        mode: "full",
        dryRun: args.dryRun,
        totalProposals: 0,
      }
    );
    if (!jobId) {
      console.log("[sync] estate pass skipped: another sync is in flight.");
      return null;
    }

    try {
      const authToken = await getFirebaseAuthToken(apiKey);
      const proposalIds: string[] = [];
      let pageToken: string | undefined = undefined;
      do {
        const page = await fetchCollectionPage({
          projectId: PROJECT_ID,
          collection: "proposals",
          authToken,
          pageSize: PROPOSALS_PER_PAGE,
          pageToken,
        });
        for (const doc of page.documents) {
          const id = doc.name.split("/").pop();
          if (id) proposalIds.push(id);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      await ctx.runMutation(internal.sync.syncMutations.setSyncJobQueue, {
        jobId,
        proposalQueue: proposalIds,
      });
      console.log(
        `[sync] estate pass ${jobId}${args.dryRun ? " (dry run)" : ""}: ${proposalIds.length} proposals queued.`
      );

      await ctx.scheduler.runAfter(0, internal.sync.syncEngine.syncNextProposal, {
        jobId,
        authToken,
        authTimestamp: Date.now(),
      });
      return jobId;
    } catch (error) {
      // The walk is the only part with nothing to resume from — the queue is not
      // written yet — so a failure here ends the run rather than stranding it.
      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId,
        status: "failed",
        error: `Building the proposal queue failed: ${String(error).slice(0, 300)}`,
      });
      throw error;
    }
  },
});

/**
 * Mirror the proposal at the run's cursor, then schedule the next.
 *
 * A failure on one proposal is recorded against that proposal and the chain
 * continues: one estimate with a broken parent pointer must not cost the other
 * 735 their pass. A failure the action cannot survive at all leaves the job's
 * `lastProgressAt` where it was, which is what makes `resumeEstateSync` able to
 * prove the run is dead rather than infer it.
 */
export const syncNextProposal = internalAction({
  args: {
    jobId: v.id("syncJobs"),
    authToken: v.optional(v.string()),
    authTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    const next = await ctx.runQuery(internal.sync.syncMutations.nextQueuedProposal, {
      jobId: args.jobId,
    });
    // Completed, failed, or reclaimed while this hop was queued. Stop quietly —
    // a second chain writing into a finished run is worse than a lost tick.
    if (!next.active) return;

    if (next.proposalFsId === null) {
      await finishEstateSync(ctx, args.jobId);
      return;
    }

    let authToken = args.authToken ?? "";
    let authTimestamp = args.authTimestamp ?? 0;
    if (!authToken || Date.now() - authTimestamp > TOKEN_LIFETIME) {
      authToken = await getFirebaseAuthToken(apiKey);
      authTimestamp = Date.now();
    }

    const startedAt = Date.now();
    const proposalFsId = next.proposalFsId;
    // Captured as soon as the estimate has a name, because the failure this most
    // needs to describe is the one that stops it having a return value.
    let identified = "";
    try {
      const outcome = await fetchAndUpsertProposalTree(ctx, proposalFsId, authToken, {
        dryRun: next.dryRun,
        scanOrphans: true,
        onIdentified: (proposalNumber) => {
          identified = proposalNumber;
        },
      });
      await ctx.runMutation(internal.sync.syncMutations.recordProposalOutcome, {
        jobId: args.jobId,
        atIndex: next.index,
        firestoreId: proposalFsId,
        proposalNumber: outcome.proposalNumber,
        proposalId: outcome.proposalId ?? undefined,
        skipped: outcome.skipped ?? undefined,
        byLevel: outcome.byLevel,
        suppressedLinks: outcome.suppressedLinks,
        unresolved: outcome.unresolved,
        orphanScanIncomplete: outcome.orphanScanIncomplete || undefined,
        orphanScanRefused: outcome.orphanScanRefused || undefined,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error(`[sync] proposal ${proposalFsId}:`, String(error).slice(0, 300));
      await ctx.runMutation(internal.sync.syncMutations.recordProposalOutcome, {
        jobId: args.jobId,
        atIndex: next.index,
        firestoreId: proposalFsId,
        proposalNumber: identified,
        byLevel: {
          proposal: emptyLevelCounts(),
          wbs: emptyLevelCounts(),
          phase: emptyLevelCounts(),
          activity: emptyLevelCounts(),
        },
        suppressedLinks: 0,
        unresolved: 0,
        error: String(error),
        durationMs: Date.now() - startedAt,
      });
    }

    if ((next.index + 1) % 25 === 0) {
      console.log(`[sync] estate pass ${args.jobId}: ${next.index + 1}/${next.total} proposals.`);
    }

    await ctx.scheduler.runAfter(0, internal.sync.syncEngine.syncNextProposal, {
      jobId: args.jobId,
      authToken,
      authTimestamp,
    });
  },
});

/**
 * Close out a completed pass: flag proposals that vanished from Firestore.
 *
 * DONE ONLY HERE, AND ONLY ON A COMPLETE WALK. A proposal orphan is a statement
 * about the whole collection, so a run that stopped halfway cannot make it — it
 * would flag every proposal it had not reached yet. The queue this compares
 * against is the one the walk built, which is why the queue is kept whole rather
 * than consumed.
 */
async function finishEstateSync(ctx: ActionCtx, jobId: Id<"syncJobs">): Promise<void> {
  const { proposalQueue, dryRun } = await ctx.runQuery(
    internal.sync.syncMutations.getSyncJobQueue,
    { jobId }
  );
  const upstream = new Set(proposalQueue);

  let orphaned = 0;
  if (upstream.size > 0) {
    let cursor: string | null = null;
    const at = Date.now();
    for (let page = 0; page < ORPHAN_SCAN_MAX_PAGES; page++) {
      const result: MirrorKeyPage = await ctx.runQuery(internal.sync.syncMutations.listMirrorKeys, {
        level: "proposal",
        cursor,
        numItems: ORPHAN_SCAN_PAGE,
      });
      const flag: string[] = [];
      const clear: string[] = [];
      for (const key of result.keys) {
        // No firestoreId means Precision-born: it was never mirrored, so the
        // estimator's silence about it says nothing.
        if (key.firestoreId === null) continue;
        const present = upstream.has(key.firestoreId);
        if (!present && !key.flagged) flag.push(key.id);
        else if (present && key.flagged) clear.push(key.id);
      }
      if ((flag.length > 0 || clear.length > 0) && !dryRun) {
        await ctx.runMutation(internal.sync.syncMutations.flagMirrorOrphans, {
          level: "proposal",
          flag,
          clear,
          at,
        });
      }
      orphaned += flag.length;
      if (result.isDone) break;
      cursor = result.cursor;
    }
  }

  await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
    jobId,
    status: "completed",
    addOrphanedRecords: orphaned,
  });
  console.log(`[sync] estate pass ${jobId} complete. ${orphaned} proposal(s) gone upstream.`);
}

// ============================================================================
// Proposals-only pass (6-hourly cron) + single-tree pull (on project create)
// ============================================================================

/**
 * Proposals-only pass: page through the proposals collection and write the ones
 * that moved. No child trees.
 *
 * Cheap enough to run every 6 hours — 736 documents, well under a cent a month —
 * and it is what keeps the New Project list current between the daily full
 * passes. Differential like everything else here: a page whose eight proposals
 * are all identical costs eight reads and no writes.
 */
export const syncProposals = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    const jobId = await ctx.runMutation(internal.sync.syncMutations.createSyncJob, {
      mode: "proposals",
      totalProposals: 0,
    });
    // A full pass runs for tens of minutes and already refreshes every proposal,
    // so the 6-hourly tick landing inside one is expected, not an incident.
    if (!jobId) {
      console.log("[sync] proposals pass skipped: another sync is in flight.");
      return;
    }

    const authToken = await getFirebaseAuthToken(apiKey);
    let total = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let pageToken: string | undefined = undefined;

    try {
      do {
        const page = await fetchCollectionPage({
          projectId: PROJECT_ID,
          collection: "proposals",
          authToken,
          pageSize: PROPOSALS_PER_PAGE,
          pageToken,
        });
        const proposals = page.documents.map((d) => mapProposal(parseDocument(d)));
        if (proposals.length > 0) {
          const r = await ctx.runMutation(internal.sync.syncMutations.upsertProposalsBatch, {
            proposals,
          });
          inserted += r.inserted;
          updated += r.updated;
          unchanged += r.unchanged;
          skipped += r.skipped;
          total += proposals.length;
        }
        pageToken = page.nextPageToken;
        // Per page, not per run: the heartbeat is what lets a hung pass be
        // reclaimed instead of wedging the next tick.
        await ctx.runMutation(internal.sync.syncMutations.updateSyncProgress, {
          jobId,
          processedProposals: total,
          insertedRecords: inserted,
          updatedRecords: updated,
          unchangedRecords: unchanged,
          skippedProposals: skipped,
          lastProposalPageToken: pageToken,
        });
      } while (pageToken);

      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId,
        status: "completed",
        processedProposals: total,
      });
      console.log(
        `[sync] proposals pass complete: ${total} read, ${inserted} new, ${updated} changed, ${unchanged} identical, ${skipped} left alone.`
      );
    } catch (error) {
      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId,
        status: "failed",
        processedProposals: total,
        error: String(error),
      });
      throw error;
    }
  },
});

/**
 * Pull a single proposal's full tree from Firestore into Convex. Runs when a
 * Momentum project is created so the snapshot reflects the latest estimate.
 *
 * NO ORPHAN SCAN HERE, deliberately. This runs inside a dialog the user is
 * watching, and flagging is a background judgement about the whole estate, not
 * something to spend an impatient user's seconds on. The daily pass will make
 * it.
 */
export const syncProposalTree = internalAction({
  args: { proposalFsId: v.string(), importToken: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ inserted: number; updated: number; unchanged: number }> => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");
    const authToken = await getFirebaseAuthToken(apiKey);
    const outcome = await fetchAndUpsertProposalTree(ctx, args.proposalFsId, authToken, {
      progressToken: args.importToken,
    });
    return {
      inserted: outcome.inserted,
      updated: outcome.updated,
      unchanged: outcome.unchanged,
    };
  },
});
