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

import { internalAction } from "../_generated/server";
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
      skipped: 0,
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
    skipped: v.number(),
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

    let { processed, inserted, skipped } = args;

    try {
      // Fetch proposal doc directly via REST GET (not runQuery — __name__ filter doesn't work)
      const proposalDoc = await fetchDocumentById(
        PROJECT_ID,
        "proposals",
        args.proposalFsId,
        authToken
      );

      // Fetch all children in parallel
      const [wbsDocs, phaseDocs, actDocs] = await Promise.all([
        fetchByField({
          projectId: PROJECT_ID,
          collection: "wbs",
          authToken,
          fieldPath: "proposalId",
          fieldValue: args.proposalFsId,
        }),
        fetchByField({
          projectId: PROJECT_ID,
          collection: "phase",
          authToken,
          fieldPath: "proposalId",
          fieldValue: args.proposalFsId,
        }),
        fetchByField({
          projectId: PROJECT_ID,
          collection: "activities",
          authToken,
          fieldPath: "proposalId",
          fieldValue: args.proposalFsId,
        }),
      ]);

      // Debug: log counts for first 5 proposals
      if (args.processed < 5) {
        console.log(
          `[sync] Proposal ${args.proposalFsId}: proposal=${proposalDoc ? 1 : 0}, wbs=${wbsDocs.length}, phases=${phaseDocs.length}, activities=${actDocs.length}`
        );
      }

      // Parse and map
      const proposalData = proposalDoc ? parseDocument(proposalDoc) : { _fsId: args.proposalFsId };

      const proposal = mapProposal(proposalData);
      const wbsList = wbsDocs.map((d) => mapWBS(parseDocument(d)));
      const phasesList = phaseDocs.map((d) => mapPhase(parseDocument(d)));
      const activitiesList = actDocs.map((d) => mapActivity(parseDocument(d)));

      // Upsert — chunk phases AND activities to stay within Convex transaction limits.
      // Each firestoreId existence check = 1 read. Convex limits ~8K reads per mutation.
      // With PHASE_CHUNK=1000 and ACTIVITY_CHUNK=2000, we stay well under.
      const PHASE_CHUNK = 1000;
      const needsChunking =
        phasesList.length > PHASE_CHUNK || activitiesList.length > ACTIVITY_CHUNK;

      if (!needsChunking) {
        const r = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
          proposal,
          wbsList,
          phasesList,
          activitiesList,
        });
        inserted += r.inserted;
        skipped += r.skipped;
      } else {
        // Step 1: Proposal + WBS only
        const r1 = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
          proposal,
          wbsList,
          phasesList: [],
          activitiesList: [],
        });
        inserted += r1.inserted;
        skipped += r1.skipped;

        // Step 2: Phases in chunks
        for (let c = 0; c < phasesList.length; c += PHASE_CHUNK) {
          const r2 = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
            proposal,
            wbsList: [],
            phasesList: phasesList.slice(c, c + PHASE_CHUNK),
            activitiesList: [],
          });
          inserted += r2.inserted;
          skipped += r2.skipped;
        }

        // Step 3: Activities in chunks
        for (let c = 0; c < activitiesList.length; c += ACTIVITY_CHUNK) {
          const r2 = await ctx.runMutation(internal.sync.syncMutations.upsertProposalHierarchy, {
            proposal,
            wbsList: [],
            phasesList: [],
            activitiesList: activitiesList.slice(c, c + ACTIVITY_CHUNK),
          });
          inserted += r2.inserted;
          skipped += r2.skipped;
        }
      }

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
        skippedRecords: skipped,
      });
      console.log(
        `[sync] Progress: ${processed} proposals, ${inserted} inserted, ${skipped} skipped`
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
        skipped,
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
        skipped,
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
        skippedRecords: skipped,
      });
      console.log(
        `[sync] ✅ Complete! ${processed} proposals, ${inserted} inserted, ${skipped} skipped`
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
    skipped: v.number(),
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
        skippedRecords: args.skipped,
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
      skipped: args.skipped,
      authToken,
      authTimestamp,
    });
  },
});
