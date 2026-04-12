#!/usr/bin/env bun
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where, doc, getDoc } from "firebase/firestore";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const app = initializeApp({
  apiKey: "AIzaSyDg6KtukKDDeiNmbDdLIrHvAb4hteFbP1g",
  authDomain: "mcp-estimator.firebaseapp.com",
  projectId: "mcp-estimator",
  storageBucket: "mcp-estimator.appspot.com",
  messagingSenderId: "555763742472",
  appId: "1:555763742472:web:39e2cd665ba4c1799fdebd",
});
const db = getFirestore(app);
const convex = new ConvexHttpClient("https://focused-civet-250.convex.cloud");
const targetPropFsId = "4QidalvItV2HOoBENSq1";

// Get Firestore activities
const fsSnap = await getDocs(
  query(collection(db, "activities"), where("proposalId", "==", targetPropFsId))
);

// Get Convex firestoreIds — check each activity
const missing: any[] = [];
for (const d of fsSnap.docs) {
  const exists = await convex.query(api.migration.activityExistsByFirestoreId, {
    firestoreId: d.id,
  });
  if (!exists) {
    const a = d.data();
    // Check if parent phase exists in Convex
    const parents = await convex.query(api.migration.resolveParentIds, {
      proposalFirestoreId: targetPropFsId,
      wbsFirestoreId: a.wbsId ?? "",
      phaseFirestoreId: a.phaseId ?? "",
    });

    // Also get the phase from Firestore to see what it is
    let phaseName = "unknown";
    let wbsName = "unknown";
    if (a.phaseId) {
      const phaseDoc = await getDoc(doc(db, "phase", a.phaseId));
      if (phaseDoc.exists()) {
        const pd = phaseDoc.data();
        phaseName = pd.description ?? pd.phaseDatabaseName ?? "?";
      }
    }
    if (a.wbsId) {
      const wbsDoc = await getDoc(doc(db, "wbs", a.wbsId));
      if (wbsDoc.exists()) {
        wbsName = wbsDoc.data().name ?? "?";
      }
    }

    missing.push({
      activityFsId: d.id,
      description: a.description,
      qty: a.quantity,
      craftConst: a.craftConstant ?? a.constant?.craftConstant ?? 0,
      type: a.activityType,
      phaseFsId: a.phaseId,
      wbsFsId: a.wbsId,
      phaseName,
      wbsName,
      convexProposalId: parents.proposalId,
      convexWbsId: parents.wbsId,
      convexPhaseId: parents.phaseId,
    });
  }
}

console.log(`\n${missing.length} missing activities for Nederland Blue ASU:\n`);
for (const m of missing) {
  console.log(`  "${m.description}" (${m.type}, qty=${m.qty}, craft=${m.craftConst})`);
  console.log(`    WBS: ${m.wbsName} (fsId=${m.wbsFsId}) → Convex: ${m.convexWbsId ?? "MISSING"}`);
  console.log(
    `    Phase: ${m.phaseName} (fsId=${m.phaseFsId}) → Convex: ${m.convexPhaseId ?? "MISSING"}`
  );
  console.log();
}
