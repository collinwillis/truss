#!/usr/bin/env bun
/**
 * Insert Missing Activities — Count-First Approach
 *
 * 1. Compare activity count per proposal (Firestore vs Convex) — ONE query each
 * 2. For mismatches, find which specific IDs are missing — batch check
 * 3. Insert the missing ones with proper field mapping
 */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDg6KtukKDDeiNmbDdLIrHvAb4hteFbP1g",
  authDomain: "mcp-estimator.firebaseapp.com",
  projectId: "mcp-estimator",
  storageBucket: "mcp-estimator.appspot.com",
  messagingSenderId: "555763742472",
  appId: "1:555763742472:web:39e2cd665ba4c1799fdebd",
};

const CONVEX_URL = process.env.CONVEX_URL ?? "https://focused-civet-250.convex.cloud";
const MIGRATION_SECRET = process.env.MIGRATION_SECRET!;
if (!MIGRATION_SECRET) {
  console.error("Set MIGRATION_SECRET");
  process.exit(1);
}

const TYPE_MAP: Record<
  string,
  "labor" | "material" | "equipment" | "subcontractor" | "cost_only" | "custom_labor"
> = {
  laborItem: "labor",
  materialItem: "material",
  equipmentItem: "equipment",
  subContractorItem: "subcontractor",
  costOnlyItem: "cost_only",
  customLaborItem: "custom_labor",
};

function mapOwn(r?: string): "rental" | "owned" | "purchase" {
  switch (r?.toLowerCase()) {
    case "owned":
      return "owned";
    case "purchase":
      return "purchase";
    default:
      return "rental";
  }
}

function num(v: any): number {
  if (v == null || v === "") return 0;
  const x = Number(v);
  return isNaN(x) ? 0 : x;
}

async function main() {
  console.log("🔄 Insert Missing Activities (Count-First)\n");

  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const convex = new ConvexHttpClient(CONVEX_URL);

  const proposalsSnap = await getDocs(collection(db, "proposals"));
  const total = proposalsSnap.size;
  console.log(`${total} proposals\n`);

  let ins = 0,
    noParent = 0,
    errs = 0,
    done = 0,
    mismatches = 0;
  const parentCache = new Map<string, any>();

  for (const pDoc of proposalsSnap.docs) {
    const pFsId = pDoc.id;
    const pData = pDoc.data();
    done++;

    // Step 1: Count comparison
    const fsSnap = await getDocs(
      query(collection(db, "activities"), where("proposalId", "==", pFsId))
    );
    if (fsSnap.empty) continue;

    const convexInfo = await convex.query(api.migration.getActivityCountForProposal, {
      proposalFirestoreId: pFsId,
    });

    if (!convexInfo.proposalId) {
      noParent += fsSnap.size;
      continue;
    }

    if (fsSnap.size === convexInfo.count) {
      // Counts match — skip
      if (done % 100 === 0)
        console.log(
          `[${Math.round((done / total) * 100)}%] ${done}/${total} | ${ins} inserted | ${noParent} no-parent | ${mismatches} mismatches`
        );
      continue;
    }

    mismatches++;
    const diff = fsSnap.size - convexInfo.count;
    console.log(
      `   Proposal ${pFsId}: Firestore=${fsSnap.size} Convex=${convexInfo.count} (${diff} missing)`
    );

    // Step 2: Find which IDs are missing (batch of 500 at a time)
    const allFsIds = fsSnap.docs.map((d) => d.id);
    const missingIds = new Set<string>();

    for (let i = 0; i < allFsIds.length; i += 500) {
      const batch = allFsIds.slice(i, i + 500);
      const missing = await convex.query(api.migration.findMissingFirestoreIds, {
        firestoreIds: batch,
      });
      for (const id of missing) missingIds.add(id);
    }

    if (missingIds.size === 0) continue;
    console.log(`   → ${missingIds.size} missing activities to insert`);

    // Step 3: Build and insert missing activities
    const toInsert: any[] = [];

    for (const actDoc of fsSnap.docs) {
      if (!missingIds.has(actDoc.id)) continue;
      const a = actDoc.data();
      const wbsFsId = a.wbsId;
      const phaseFsId = a.phaseId;
      if (!wbsFsId || !phaseFsId) {
        noParent++;
        continue;
      }

      const ck = `${pFsId}|${wbsFsId}|${phaseFsId}`;
      let parents = parentCache.get(ck);
      if (parents === undefined) {
        const r = await convex.query(api.migration.resolveParentIds, {
          proposalFirestoreId: pFsId,
          wbsFirestoreId: wbsFsId,
          phaseFirestoreId: phaseFsId,
        });
        parents = r.proposalId && r.wbsId && r.phaseId ? r : null;
        parentCache.set(ck, parents);
      }
      if (!parents) {
        noParent++;
        continue;
      }

      const type = TYPE_MAP[a.activityType ?? ""] ?? "labor";
      const rec: any = {
        firestoreId: actDoc.id,
        proposalId: parents.proposalId,
        wbsId: parents.wbsId,
        phaseId: parents.phaseId,
        type,
        description: a.description ?? "UNKNOWN",
        quantity: num(a.quantity),
        unit: a.unit ?? "EA",
        sortOrder: num(a.sortOrder),
      };

      if (a.constant?.id != null) rec.laborPoolId = num(a.constant.id);
      if (a.equipment?.id != null) rec.equipmentPoolId = num(a.equipment.id);

      if (type !== "subcontractor") {
        const labor: any = {
          craftConstant: num(a.craftConstant ?? a.constant?.craftConstant),
          welderConstant: num(a.welderConstant ?? a.constant?.weldConstant),
        };
        if (
          a.craftBaseRate != null &&
          a.craftBaseRate !== 0 &&
          a.craftBaseRate !== num(pData.craftBaseRate)
        )
          labor.customCraftRate = num(a.craftBaseRate);
        if (
          a.subsistenceRate != null &&
          a.subsistenceRate !== 0 &&
          a.subsistenceRate !== num(pData.subsistenceRate)
        )
          labor.customSubsistenceRate = num(a.subsistenceRate);
        rec.labor = labor;
      }
      if (["material", "equipment", "cost_only"].includes(type)) rec.unitPrice = num(a.price);
      if (type === "equipment")
        rec.equipment = { ownership: mapOwn(a.equipmentOwnership), time: num(a.time) };
      if (type === "subcontractor")
        rec.subcontractor = {
          laborCost: num(a.craftCost),
          materialCost: num(a.materialCost),
          equipmentCost: num(a.equipmentCost),
        };

      toInsert.push(rec);
    }

    for (let i = 0; i < toInsert.length; i += 50) {
      try {
        const r = await convex.mutation(api.migration.insertMissingActivityBatch, {
          secret: MIGRATION_SECRET,
          activities: toInsert.slice(i, i + 50),
        });
        ins += r.inserted;
        if (r.errors.length > 0) {
          errs += r.errors.length;
          console.error("   Errors:", r.errors);
        }
      } catch (e) {
        errs++;
        console.error(`   ❌ Insert error:`, String(e).slice(0, 200));
      }
    }
  }

  console.log(
    `\n✅ Done! Mismatches: ${mismatches} | Inserted: ${ins} | No-parent: ${noParent} | Errors: ${errs}`
  );
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
