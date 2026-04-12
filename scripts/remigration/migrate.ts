#!/usr/bin/env bun
/**
 * Firestore Activity Re-Migration Script
 *
 * Reads all activities from Firebase Firestore, applies corrected field
 * mappings, and patches the corresponding Convex documents.
 *
 * Usage:
 *   1. Set MIGRATION_SECRET on your Convex deployment:
 *      npx convex env set MIGRATION_SECRET <random-uuid> --project-dir packages/backend
 *
 *   2. Run:
 *      MIGRATION_SECRET=<same-uuid> bun run scripts/remigration/migrate.ts
 *
 *   3. After successful migration, remove the secret:
 *      npx convex env unset MIGRATION_SECRET --project-dir packages/backend
 *
 * @module
 */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where, doc, getDoc } from "firebase/firestore";
// @ts-ignore - resolved relative to execution CWD (packages/backend)
import { ConvexHttpClient } from "convex/browser";
// @ts-ignore - resolved relative to execution CWD (packages/backend)
import { api } from "./convex/_generated/api.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDg6KtukKDDeiNmbDdLIrHvAb4hteFbP1g",
  authDomain: "mcp-estimator.firebaseapp.com",
  projectId: "mcp-estimator",
  storageBucket: "mcp-estimator.appspot.com",
  messagingSenderId: "555763742472",
  appId: "1:555763742472:web:39e2cd665ba4c1799fdebd",
};

const CONVEX_URL = process.env.CONVEX_URL ?? "https://focused-civet-250.convex.cloud";
const MIGRATION_SECRET = process.env.MIGRATION_SECRET;
const BATCH_SIZE = 200;
const JOB_TYPE = "firestore_activity_remigration_v2";

if (!MIGRATION_SECRET) {
  console.error("ERROR: MIGRATION_SECRET env var not set.");
  console.error(
    "Set it on Convex: npx convex env set MIGRATION_SECRET <uuid> --project-dir packages/backend"
  );
  console.error("Then run: MIGRATION_SECRET=<uuid> bun run scripts/remigration/migrate.ts");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FirestoreProposal {
  craftBaseRate?: number;
  weldBaseRate?: number;
  subsistenceRate?: number;
}

interface FirestoreActivity {
  proposalId?: string;
  activityType?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  sortOrder?: number;
  constant?: {
    id?: number;
    craftConstant?: number;
    weldConstant?: number;
    craftUnits?: string;
    weldUnits?: string;
  };
  equipment?: {
    id?: number;
  };
  craftConstant?: number;
  welderConstant?: number;
  price?: number;
  time?: number;
  craftBaseRate?: number;
  subsistenceRate?: number;
  equipmentOwnership?: string;
  craftCost?: number;
  materialCost?: number;
  equipmentCost?: number;
}

interface ActivityPatch {
  firestoreId: string;
  unitPrice?: number;
  labor?: {
    craftConstant: number;
    welderConstant: number;
    customCraftRate?: number;
    customSubsistenceRate?: number;
  };
  equipment?: {
    ownership: "rental" | "owned" | "purchase";
    time: number;
  };
  subcontractor?: {
    laborCost: number;
    materialCost: number;
    equipmentCost: number;
  };
}

// ---------------------------------------------------------------------------
// Activity type mapping
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  laborItem: "labor",
  materialItem: "material",
  equipmentItem: "equipment",
  subContractorItem: "subcontractor",
  costOnlyItem: "cost_only",
  customLaborItem: "custom_labor",
};

function mapOwnership(raw?: string): "rental" | "owned" | "purchase" {
  switch (raw?.toLowerCase()) {
    case "owned":
      return "owned";
    case "purchase":
      return "purchase";
    default:
      return "rental";
  }
}

// ---------------------------------------------------------------------------
// Core transformation
// ---------------------------------------------------------------------------

function buildPatch(
  docId: string,
  fs: FirestoreActivity,
  proposalRates: FirestoreProposal
): ActivityPatch {
  const patch: ActivityPatch = { firestoreId: docId };
  const type = TYPE_MAP[fs.activityType ?? ""] ?? "labor";

  // Labor fields — all types except subcontractor
  if (type !== "subcontractor") {
    const craftConstant = fs.craftConstant ?? fs.constant?.craftConstant ?? 0;
    const welderConstant = fs.welderConstant ?? fs.constant?.weldConstant ?? 0;

    const labor: ActivityPatch["labor"] = { craftConstant, welderConstant };

    // Rate overrides: only if Firestore value differs from proposal default
    if (
      fs.craftBaseRate != null &&
      fs.craftBaseRate !== 0 &&
      fs.craftBaseRate !== (proposalRates.craftBaseRate ?? 0)
    ) {
      labor.customCraftRate = fs.craftBaseRate;
    }
    if (
      fs.subsistenceRate != null &&
      fs.subsistenceRate !== 0 &&
      fs.subsistenceRate !== (proposalRates.subsistenceRate ?? 0)
    ) {
      labor.customSubsistenceRate = fs.subsistenceRate;
    }

    patch.labor = labor;
  }

  // Unit price — material, equipment, cost_only
  if (type === "material" || type === "equipment" || type === "cost_only") {
    patch.unitPrice = fs.price ?? 0;
  }

  // Equipment fields
  if (type === "equipment") {
    patch.equipment = {
      ownership: mapOwnership(fs.equipmentOwnership),
      time: fs.time ?? 0,
    };
  }

  // Subcontractor fields — use the stored INPUT costs from Firestore
  if (type === "subcontractor") {
    patch.subcontractor = {
      laborCost: fs.craftCost ?? 0,
      materialCost: fs.materialCost ?? 0,
      equipmentCost: fs.equipmentCost ?? 0,
    };
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("🔄 Firestore Activity Re-Migration");
  console.log("===================================");

  // Initialize Firebase
  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);

  // Initialize Convex
  const convex = new ConvexHttpClient(CONVEX_URL);

  // Step 1: Count proposals and activities in Firestore
  console.log("\n📊 Counting Firestore documents...");
  const proposalsSnap = await getDocs(collection(db, "proposals"));
  const totalProposals = proposalsSnap.size;
  console.log(`   Found ${totalProposals} proposals`);

  // Step 2: Create migration job
  const jobId = await convex.mutation(api.migration.createMigrationJob, {
    secret: MIGRATION_SECRET,
    type: JOB_TYPE,
    totalProposals,
    totalActivities: 0, // Will update as we go
  });
  console.log(`   Created migration job: ${jobId}`);

  // Step 3: Process each proposal
  let completedProposals = 0;
  let totalPatched = 0;
  let totalSkipped = 0;
  let totalActivitiesProcessed = 0;
  const allErrors: Array<{ firestoreId: string; error: string; timestamp: number }> = [];

  for (const proposalDoc of proposalsSnap.docs) {
    const proposalFirestoreId = proposalDoc.id;
    const proposalData = proposalDoc.data() as FirestoreProposal;

    // Read all activities for this proposal
    const activitiesQuery = query(
      collection(db, "activities"),
      where("proposalId", "==", proposalFirestoreId)
    );
    const activitiesSnap = await getDocs(activitiesQuery);

    if (activitiesSnap.empty) {
      completedProposals++;
      continue;
    }

    // Build patches
    const patches: ActivityPatch[] = [];
    for (const actDoc of activitiesSnap.docs) {
      const actData = actDoc.data() as FirestoreActivity;
      patches.push(buildPatch(actDoc.id, actData, proposalData));
    }

    // Send patches in batches
    for (let i = 0; i < patches.length; i += BATCH_SIZE) {
      const batch = patches.slice(i, i + BATCH_SIZE);
      try {
        const result = await convex.mutation(api.migration.patchActivityBatch, {
          secret: MIGRATION_SECRET,
          patches: batch,
        });
        totalPatched += result.patched;
        totalSkipped += result.skipped;
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            allErrors.push({ firestoreId: err, error: "patch failed", timestamp: Date.now() });
          }
        }
      } catch (error) {
        console.error(`   ❌ Batch error on proposal ${proposalFirestoreId}:`, error);
        allErrors.push({
          firestoreId: proposalFirestoreId,
          error: String(error),
          timestamp: Date.now(),
        });
      }
    }

    totalActivitiesProcessed += activitiesSnap.size;
    completedProposals++;

    // Update job progress every 10 proposals
    if (completedProposals % 10 === 0 || completedProposals === totalProposals) {
      await convex.mutation(api.migration.updateJobProgress, {
        secret: MIGRATION_SECRET,
        jobId,
        completedProposals,
        patchedActivities: totalPatched,
        skippedActivities: totalSkipped,
        lastProposalProcessed: proposalFirestoreId,
        newErrors: allErrors.length > 0 ? allErrors.splice(0) : undefined,
      });

      const pct = Math.round((completedProposals / totalProposals) * 100);
      console.log(
        `   [${pct}%] ${completedProposals}/${totalProposals} proposals | ` +
          `${totalPatched} patched | ${totalSkipped} skipped | ` +
          `${totalActivitiesProcessed} activities`
      );
    }
  }

  // Step 4: Complete the job
  await convex.mutation(api.migration.completeMigrationJob, {
    secret: MIGRATION_SECRET,
    jobId,
    status: allErrors.length > 0 ? "failed" : "completed",
  });

  console.log("\n✅ Migration complete!");
  console.log(`   Proposals: ${completedProposals}`);
  console.log(`   Activities processed: ${totalActivitiesProcessed}`);
  console.log(`   Patched: ${totalPatched}`);
  console.log(`   Skipped: ${totalSkipped}`);
  console.log(`   Errors: ${allErrors.length}`);
}

main().catch((error) => {
  console.error("💥 Migration failed:", error);
  process.exit(1);
});
