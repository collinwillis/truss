/**
 * Sync engine — processes ONE proposal per action, then schedules the next.
 *
 * WHY one-at-a-time: Cloudflare proxies Convex actions with a ~100s timeout.
 * Large proposals (10K+ activities) need the full time for Firestore REST
 * fetches + Convex mutation writes. Processing one proposal per action
 * ensures we never timeout mid-proposal. The self-scheduling chain handles
 * all 623 proposals across multiple action invocations.
 *
 * @module
 */

import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  getFirebaseAuthToken,
  fetchCollectionPage,
  fetchDocumentById,
  fetchByField,
  parseDocument,
} from "./firestoreClient";
import { mapProposal, mapWBS, mapPhase, mapActivity } from "./fieldMapping";

const PROJECT_ID = "mcp-estimator";
const PROPOSALS_PER_PAGE = 100;
const ACTIVITY_CHUNK = 2000;
const PHASE_CHUNK = 1000;

/**
 * Fetch one proposal's full tree (proposal + wbs + phases + activities) from
 * Firestore and upsert it into Convex, chunking large trees to stay within
 * Convex's per-mutation read limit. Shared by the full sync chain and the
 * on-demand pull that runs when a Momentum project is created.
 */
async function fetchAndUpsertProposalTree(
  ctx: ActionCtx,
  proposalFsId: string,
  authToken: string
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  const proposalDoc = await fetchDocumentById(PROJECT_ID, "proposals", proposalFsId, authToken);

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

  const proposalData = proposalDoc ? parseDocument(proposalDoc) : { _fsId: proposalFsId };
  const proposal = mapProposal(proposalData);
  const wbsList = wbsDocs.map((d) => mapWBS(parseDocument(d)));
  const phasesList = phaseDocs.map((d) => mapPhase(parseDocument(d)));
  const activitiesList = actDocs.map((d) => mapActivity(parseDocument(d)));

  const needsChunking = phasesList.length > PHASE_CHUNK || activitiesList.length > ACTIVITY_CHUNK;

  if (!needsChunking) {
    const r = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal,
      wbsList,
      phasesList,
      activitiesList,
    });
    inserted += r.inserted;
    updated += r.updated;
  } else {
    // Proposal + WBS first, then phases and activities in chunks.
    const r1 = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
      proposal,
      wbsList,
      phasesList: [],
      activitiesList: [],
    });
    inserted += r1.inserted;
    updated += r1.updated;
    for (let c = 0; c < phasesList.length; c += PHASE_CHUNK) {
      const r2 = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
        proposal,
        wbsList: [],
        phasesList: phasesList.slice(c, c + PHASE_CHUNK),
        activitiesList: [],
      });
      inserted += r2.inserted;
      updated += r2.updated;
    }
    for (let c = 0; c < activitiesList.length; c += ACTIVITY_CHUNK) {
      const r2 = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
        proposal,
        wbsList: [],
        phasesList: [],
        activitiesList: activitiesList.slice(c, c + ACTIVITY_CHUNK),
      });
      inserted += r2.inserted;
      updated += r2.updated;
    }
  }

  return { inserted, updated };
}

// ============================================================================
// Entry Point
// ============================================================================

/** Start a new sync. Fetches first page of proposal IDs and begins processing. */
export const startSync = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    console.log("[sync] Starting daily Firestore sync...");
    const authToken = await getFirebaseAuthToken(apiKey);

    // Fetch first page of proposals (just to get IDs + count)
    const page = await fetchCollectionPage({
      projectId: PROJECT_ID,
      collection: "proposals",
      authToken,
      pageSize: PROPOSALS_PER_PAGE,
    });

    const jobId = await ctx.runMutation(internal.sync.syncMutations.createSyncJob, {
      totalProposals: 623,
    });

    console.log(`[sync] Job ${jobId}. First page: ${page.documents.length} proposals.`);

    // Build list of all proposal Firestore IDs from this page
    const proposalIds = page.documents.map((d) => d.name.split("/").pop()!);

    // Schedule processing of the first proposal — pass auth token to avoid re-auth per proposal
    await ctx.scheduler.runAfter(0, internal.sync.syncEngine.processOneProposal, {
      jobId,
      proposalFsId: proposalIds[0],
      remainingIds: proposalIds.slice(1),
      nextPageToken: page.nextPageToken ?? "",
      processed: 0,
      inserted: 0,
      updated: 0,
      authToken,
      authTimestamp: Date.now(),
    });
  },
});

// ============================================================================
// Process One Proposal (self-scheduling chain)
// ============================================================================

/** Process a single proposal, then schedule the next one. */
export const processOneProposal = internalAction({
  args: {
    jobId: v.id("syncJobs"),
    proposalFsId: v.string(),
    remainingIds: v.array(v.string()),
    nextPageToken: v.string(),
    processed: v.number(),
    inserted: v.number(),
    updated: v.number(),
    authToken: v.optional(v.string()),
    authTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    // Reuse token if less than 50 minutes old, otherwise re-auth
    const TOKEN_LIFETIME = 50 * 60 * 1000;
    let authToken = args.authToken ?? "";
    let authTimestamp = args.authTimestamp ?? 0;
    if (!authToken || Date.now() - authTimestamp > TOKEN_LIFETIME) {
      authToken = await getFirebaseAuthToken(apiKey);
      authTimestamp = Date.now();
    }

    let { processed, inserted, updated } = args;

    try {
      const r = await fetchAndUpsertProposalTree(ctx, args.proposalFsId, authToken);
      inserted += r.inserted;
      updated += r.updated;
      processed++;
    } catch (error) {
      console.error(`[sync] Error on proposal ${args.proposalFsId}:`, String(error).slice(0, 300));
      processed++;
    }

    // Update progress every 10 proposals
    if (processed % 10 === 0) {
      await ctx.runMutation(internal.sync.syncMutations.updateSyncProgress, {
        jobId: args.jobId,
        processedProposals: processed,
        insertedRecords: inserted,
        updatedRecords: updated,
      });
      console.log(
        `[sync] Progress: ${processed} proposals, ${inserted} inserted, ${updated} updated`
      );
    }

    // Schedule the next proposal
    if (args.remainingIds.length > 0) {
      // More proposals in the current page
      await ctx.scheduler.runAfter(0, internal.sync.syncEngine.processOneProposal, {
        jobId: args.jobId,
        proposalFsId: args.remainingIds[0],
        remainingIds: args.remainingIds.slice(1),
        nextPageToken: args.nextPageToken,
        processed,
        inserted,
        updated,
        authToken,
        authTimestamp,
      });
    } else if (args.nextPageToken) {
      // Current page exhausted — fetch the next page
      await ctx.scheduler.runAfter(0, internal.sync.syncEngine.fetchNextPage, {
        jobId: args.jobId,
        pageToken: args.nextPageToken,
        processed,
        inserted,
        updated,
        authToken,
        authTimestamp,
      });
    } else {
      // All done!
      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId: args.jobId,
        status: "completed",
        processedProposals: processed,
        insertedRecords: inserted,
        updatedRecords: updated,
      });
      console.log(
        `[sync] ✅ Complete! ${processed} proposals, ${inserted} inserted, ${updated} updated`
      );
    }
  },
});

// ============================================================================
// Fetch Next Page of Proposals
// ============================================================================

/** Fetch the next page of proposals and schedule processing. */
export const fetchNextPage = internalAction({
  args: {
    jobId: v.id("syncJobs"),
    pageToken: v.string(),
    processed: v.number(),
    inserted: v.number(),
    updated: v.number(),
    authToken: v.optional(v.string()),
    authTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    // Reuse token if fresh enough
    const TOKEN_LIFETIME = 50 * 60 * 1000;
    let authToken = args.authToken ?? "";
    let authTimestamp = args.authTimestamp ?? 0;
    if (!authToken || Date.now() - authTimestamp > TOKEN_LIFETIME) {
      authToken = await getFirebaseAuthToken(apiKey);
      authTimestamp = Date.now();
    }

    const page = await fetchCollectionPage({
      projectId: PROJECT_ID,
      collection: "proposals",
      authToken,
      pageSize: PROPOSALS_PER_PAGE,
      pageToken: args.pageToken,
    });

    if (page.documents.length === 0) {
      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId: args.jobId,
        status: "completed",
        processedProposals: args.processed,
        insertedRecords: args.inserted,
        updatedRecords: args.updated,
      });
      return;
    }

    const proposalIds = page.documents.map((d) => d.name.split("/").pop()!);

    await ctx.scheduler.runAfter(0, internal.sync.syncEngine.processOneProposal, {
      jobId: args.jobId,
      proposalFsId: proposalIds[0],
      remainingIds: proposalIds.slice(1),
      nextPageToken: page.nextPageToken ?? "",
      processed: args.processed,
      inserted: args.inserted,
      updated: args.updated,
      authToken,
      authTimestamp,
    });
  },
});

// ============================================================================
// Proposals-only sync (daily cron) + single-tree pull (on project create)
// ============================================================================

/**
 * Daily proposals-only sync: page through the proposals collection and upsert
 * each (no child trees). Cheap enough to run nightly; keeps the New Project
 * list current. A proposal's full tree is pulled on demand at project creation.
 */
export const syncProposals = internalAction({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");

    const authToken = await getFirebaseAuthToken(apiKey);
    const jobId = await ctx.runMutation(internal.sync.syncMutations.createSyncJob, {
      totalProposals: 0,
    });

    let total = 0;
    let inserted = 0;
    let updated = 0;
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
          total += proposals.length;
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId,
        status: "completed",
        processedProposals: total,
        insertedRecords: inserted,
        updatedRecords: updated,
      });
      console.log(
        `[sync] Proposals-only sync complete: ${total} proposals (${inserted} new, ${updated} updated).`
      );
    } catch (error) {
      await ctx.runMutation(internal.sync.syncMutations.completeSyncJob, {
        jobId,
        status: "failed",
        processedProposals: total,
        insertedRecords: inserted,
        updatedRecords: updated,
      });
      throw error;
    }
  },
});

/**
 * Pull a single proposal's full tree from Firestore into Convex. Runs when a
 * Momentum project is created so the snapshot reflects the latest estimate.
 */
export const syncProposalTree = internalAction({
  args: { proposalFsId: v.string() },
  handler: async (ctx, args): Promise<{ inserted: number; updated: number }> => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) throw new Error("FIREBASE_API_KEY env var not set");
    const authToken = await getFirebaseAuthToken(apiKey);
    return fetchAndUpsertProposalTree(ctx, args.proposalFsId, authToken);
  },
});
