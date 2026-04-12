#!/usr/bin/env bun
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";

const app = initializeApp({
  apiKey: "AIzaSyDg6KtukKDDeiNmbDdLIrHvAb4hteFbP1g",
  authDomain: "mcp-estimator.firebaseapp.com",
  projectId: "mcp-estimator",
  storageBucket: "mcp-estimator.appspot.com",
  messagingSenderId: "555763742472",
  appId: "1:555763742472:web:39e2cd665ba4c1799fdebd",
});
const db = getFirestore(app);

const PROPOSAL_FS_ID = "PFf6UCe17BmzVr6yjBYz";

const phases = await getDocs(
  query(collection(db, "phase"), where("proposalId", "==", PROPOSAL_FS_ID))
);
console.log(`Firestore phases for 1734.9: ${phases.size}`);

// Check if our target phase is in the results
const target = phases.docs.find((d) => d.id === "uFiILjyQvfRQJq05qHxv");
console.log(`Target phase found: ${!!target}`);
if (target) {
  const p = target.data();
  console.log(`  #${p.phaseNumber} "${p.description}" wbsId=${p.wbsId}`);
}
