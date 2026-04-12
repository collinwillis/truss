#!/usr/bin/env bun
/**
 * Fast approach: get all Firestore activity IDs, get all Convex firestoreIds,
 * diff locally, then trace only the missing ones.
 */
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where, doc, getDoc } from "firebase/firestore";

const app = initializeApp({
  apiKey: "AIzaSyDg6KtukKDDeiNmbDdLIrHvAb4hteFbP1g",
  authDomain: "mcp-estimator.firebaseapp.com",
  projectId: "mcp-estimator",
  storageBucket: "mcp-estimator.appspot.com",
  messagingSenderId: "555763742472",
  appId: "1:555763742472:web:39e2cd665ba4c1799fdebd",
});
const db = getFirestore(app);

// Use the run-migration Convex client to get firestoreIds in bulk
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
const convex = new ConvexHttpClient("https://focused-civet-250.convex.cloud");

const PROPOSAL_FS_ID = "PFf6UCe17BmzVr6yjBYz"; // 1734.9

// Step 1: Get Firestore activity IDs
console.log("Getting Firestore activity IDs...");
const fsSnap = await getDocs(
  query(collection(db, "activities"), where("proposalId", "==", PROPOSAL_FS_ID))
);
const fsIds = new Set(fsSnap.docs.map((d) => d.id));
console.log(`Firestore: ${fsIds.size}`);

// Step 2: Get Convex count via the count query
const convexInfo = await convex.query(api.migration.getActivityCountForProposal, {
  proposalFirestoreId: PROPOSAL_FS_ID,
});
console.log(`Convex: ${convexInfo.count}`);
console.log(`Missing: ${fsIds.size - convexInfo.count}`);

// Step 3: Use findMissingFirestoreIds in batches of 500
console.log("\nFinding which IDs are missing...");
const allFsIds = [...fsIds];
const missingIds: string[] = [];
for (let i = 0; i < allFsIds.length; i += 500) {
  const batch = allFsIds.slice(i, i + 500);
  const missing = await convex.query(api.migration.findMissingFirestoreIds, {
    firestoreIds: batch,
  });
  missingIds.push(...missing);
  if (i % 2000 === 0) console.log(`  Checked ${i + batch.length}/${allFsIds.length}...`);
}

console.log(`\n${missingIds.length} missing activities found:\n`);

// Step 4: Trace each missing activity's parent chain in Firestore
for (const id of missingIds) {
  const actDoc = fsSnap.docs.find((d) => d.id === id);
  if (!actDoc) continue;
  const a = actDoc.data();

  console.log(`Activity: ${id} — "${a.description}"`);
  console.log(`  type=${a.activityType} qty=${a.quantity} craftConst=${a.craftConstant}`);
  console.log(`  proposalId=${a.proposalId} wbsId=${a.wbsId} phaseId=${a.phaseId}`);

  // Check WBS
  if (a.wbsId) {
    const wbsDoc = await getDoc(doc(db, "wbs", a.wbsId));
    if (wbsDoc.exists()) {
      const w = wbsDoc.data();
      console.log(
        `  WBS: "${w.name}" proposalId=${w.proposalId} (match=${w.proposalId === PROPOSAL_FS_ID})`
      );
    } else {
      console.log(`  WBS: NOT FOUND IN FIRESTORE`);
    }
  } else {
    console.log(`  WBS: NO wbsId ON ACTIVITY`);
  }

  // Check Phase
  if (a.phaseId) {
    const phaseDoc = await getDoc(doc(db, "phase", a.phaseId));
    if (phaseDoc.exists()) {
      const p = phaseDoc.data();
      console.log(
        `  Phase: "#${p.phaseNumber} ${p.description}" proposalId=${p.proposalId} wbsId=${p.wbsId} (proposalMatch=${p.proposalId === PROPOSAL_FS_ID})`
      );
    } else {
      console.log(`  Phase: NOT FOUND IN FIRESTORE`);
    }
  } else {
    console.log(`  Phase: NO phaseId ON ACTIVITY`);
  }

  // Check Convex resolution
  const resolved = await convex.query(api.migration.resolveParentIds, {
    proposalFirestoreId: PROPOSAL_FS_ID,
    wbsFirestoreId: a.wbsId ?? "",
    phaseFirestoreId: a.phaseId ?? "",
  });
  console.log(
    `  Convex resolution: proposal=${resolved.proposalId ? "OK" : "MISSING"} wbs=${resolved.wbsId ? "OK" : "MISSING"} phase=${resolved.phaseId ? "OK" : "MISSING"}`
  );
  console.log();
}
