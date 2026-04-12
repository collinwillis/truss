#!/usr/bin/env bun
/**
 * Migration runner — placed in packages/backend so Bun resolves convex correctly.
 * Run: MIGRATION_SECRET=<secret> bun run packages/backend/run-migration.ts
 */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";
import { ConvexHttpClient } from "convex/browser";
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
  console.error(
    "ERROR: Set MIGRATION_SECRET env var. See scripts/remigration/migrate.ts for instructions."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FsProposal {
  craftBaseRate?: number;
  subsistenceRate?: number;
}

interface FsActivity {
  proposalId?: string;
  activityType?: string;
  constant?: { id?: number; craftConstant?: number; weldConstant?: number; craftUnits?: string };
  equipment?: { id?: number };
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

interface Patch {
  firestoreId: string;
  unitPrice?: number;
  labor?: {
    craftConstant: number;
    welderConstant: number;
    customCraftRate?: number;
    customSubsistenceRate?: number;
  };
  equipment?: { ownership: "rental" | "owned" | "purchase"; time: number };
  subcontractor?: { laborCost: number; materialCost: number; equipmentCost: number };
}

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

function buildPatch(docId: string, fs: FsActivity, rates: FsProposal): Patch {
  const patch: Patch = { firestoreId: docId };
  const type = TYPE_MAP[fs.activityType ?? ""] ?? "labor";

  if (type !== "subcontractor") {
    const labor: Patch["labor"] = {
      craftConstant: fs.craftConstant ?? fs.constant?.craftConstant ?? 0,
      welderConstant: fs.welderConstant ?? fs.constant?.weldConstant ?? 0,
    };
    if (
      fs.craftBaseRate != null &&
      fs.craftBaseRate !== 0 &&
      fs.craftBaseRate !== (rates.craftBaseRate ?? 0)
    ) {
      labor.customCraftRate = fs.craftBaseRate;
    }
    if (
      fs.subsistenceRate != null &&
      fs.subsistenceRate !== 0 &&
      fs.subsistenceRate !== (rates.subsistenceRate ?? 0)
    ) {
      labor.customSubsistenceRate = fs.subsistenceRate;
    }
    patch.labor = labor;
  }

  if (type === "material" || type === "equipment" || type === "cost_only") {
    patch.unitPrice = fs.price ?? 0;
  }

  if (type === "equipment") {
    patch.equipment = { ownership: mapOwnership(fs.equipmentOwnership), time: fs.time ?? 0 };
  }

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
  console.log("===================================\n");

  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const convex = new ConvexHttpClient(CONVEX_URL);

  console.log("📊 Counting Firestore proposals...");
  const proposalsSnap = await getDocs(collection(db, "proposals"));
  const totalProposals = proposalsSnap.size;
  console.log(`   ${totalProposals} proposals found\n`);

  const jobId = await convex.mutation(api.migration.createMigrationJob, {
    secret: MIGRATION_SECRET,
    type: JOB_TYPE,
    totalProposals,
    totalActivities: 0,
  });
  console.log(`   Job created: ${jobId}\n`);

  let completed = 0,
    patched = 0,
    skipped = 0,
    totalAct = 0;
  const errors: Array<{ firestoreId: string; error: string; timestamp: number }> = [];

  for (const pDoc of proposalsSnap.docs) {
    const pId = pDoc.id;
    const pData = pDoc.data() as FsProposal;

    const actSnap = await getDocs(
      query(collection(db, "activities"), where("proposalId", "==", pId))
    );
    if (actSnap.empty) {
      completed++;
      continue;
    }

    const patches: Patch[] = actSnap.docs.map((d) =>
      buildPatch(d.id, d.data() as FsActivity, pData)
    );

    for (let i = 0; i < patches.length; i += BATCH_SIZE) {
      const batch = patches.slice(i, i + BATCH_SIZE);
      try {
        const r = await convex.mutation(api.migration.patchActivityBatch, {
          secret: MIGRATION_SECRET,
          patches: batch,
        });
        patched += r.patched;
        skipped += r.skipped;
        for (const e of r.errors)
          errors.push({ firestoreId: e, error: "patch failed", timestamp: Date.now() });
      } catch (e) {
        console.error(`   ❌ Batch error (proposal ${pId}):`, e);
        errors.push({ firestoreId: pId, error: String(e), timestamp: Date.now() });
      }
    }

    totalAct += actSnap.size;
    completed++;

    if (completed % 10 === 0 || completed === totalProposals) {
      await convex.mutation(api.migration.updateJobProgress, {
        secret: MIGRATION_SECRET,
        jobId,
        completedProposals: completed,
        patchedActivities: patched,
        skippedActivities: skipped,
        lastProposalProcessed: pId,
        newErrors: errors.length > 0 ? errors.splice(0) : undefined,
      });
      const pct = Math.round((completed / totalProposals) * 100);
      console.log(
        `   [${pct}%] ${completed}/${totalProposals} proposals | ${patched} patched | ${skipped} skipped | ${totalAct} activities`
      );
    }
  }

  await convex.mutation(api.migration.completeMigrationJob, {
    secret: MIGRATION_SECRET,
    jobId,
    status: errors.length > 0 ? "failed" : "completed",
  });

  console.log(
    `\n✅ Done! ${completed} proposals, ${totalAct} activities, ${patched} patched, ${skipped} skipped, ${errors.length} errors`
  );
}

main().catch((e) => {
  console.error("💥 Failed:", e);
  process.exit(1);
});
