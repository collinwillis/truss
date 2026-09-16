/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activityLinks from "../activityLinks.js";
import type * as adminUsers from "../adminUsers.js";
import type * as appPermissions from "../appPermissions.js";
import type * as auth from "../auth.js";
import type * as catalog from "../catalog.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as migration from "../migration.js";
import type * as model_activityLinks from "../model/activityLinks.js";
import type * as model_appPermissionLevels from "../model/appPermissionLevels.js";
import type * as model_catalogEdit from "../model/catalogEdit.js";
import type * as model_costEngine from "../model/costEngine.js";
import type * as model_ordering from "../model/ordering.js";
import type * as model_orgAdmin from "../model/orgAdmin.js";
import type * as model_phaseNumbering from "../model/phaseNumbering.js";
import type * as model_precisionAccess from "../model/precisionAccess.js";
import type * as model_proposalTotalCache from "../model/proposalTotalCache.js";
import type * as model_proposalTotals from "../model/proposalTotals.js";
import type * as model_publishGates from "../model/publishGates.js";
import type * as model_rateBookAccess from "../model/rateBookAccess.js";
import type * as model_rateBookCsv from "../model/rateBookCsv.js";
import type * as model_rateBookDiff from "../model/rateBookDiff.js";
import type * as model_rateBookMatch from "../model/rateBookMatch.js";
import type * as model_rateBookResolve from "../model/rateBookResolve.js";
import type * as model_rateBookRows from "../model/rateBookRows.js";
import type * as model_rateBookShape from "../model/rateBookShape.js";
import type * as model_rateOverrides from "../model/rateOverrides.js";
import type * as model_repriceBenchmark from "../model/repriceBenchmark.js";
import type * as model_subcontractorQuote from "../model/subcontractorQuote.js";
import type * as model_syncDiff from "../model/syncDiff.js";
import type * as model_takeoff from "../model/takeoff.js";
import type * as momentum from "../momentum.js";
import type * as orgMaintenance from "../orgMaintenance.js";
import type * as precision from "../precision.js";
import type * as projectAssignments from "../projectAssignments.js";
import type * as rateBookBenchmark from "../rateBookBenchmark.js";
import type * as rateBookDiff from "../rateBookDiff.js";
import type * as rateBooks from "../rateBooks.js";
import type * as reservedPhaseSeed from "../reservedPhaseSeed.js";
import type * as seed from "../seed.js";
import type * as sync_fieldMapping from "../sync/fieldMapping.js";
import type * as sync_firestoreClient from "../sync/firestoreClient.js";
import type * as sync_syncEngine from "../sync/syncEngine.js";
import type * as sync_syncMutations from "../sync/syncMutations.js";
import type * as sync_syncQueries from "../sync/syncQueries.js";
import type * as takeoffSeed from "../takeoffSeed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activityLinks: typeof activityLinks;
  adminUsers: typeof adminUsers;
  appPermissions: typeof appPermissions;
  auth: typeof auth;
  catalog: typeof catalog;
  crons: typeof crons;
  http: typeof http;
  migration: typeof migration;
  "model/activityLinks": typeof model_activityLinks;
  "model/appPermissionLevels": typeof model_appPermissionLevels;
  "model/catalogEdit": typeof model_catalogEdit;
  "model/costEngine": typeof model_costEngine;
  "model/ordering": typeof model_ordering;
  "model/orgAdmin": typeof model_orgAdmin;
  "model/phaseNumbering": typeof model_phaseNumbering;
  "model/precisionAccess": typeof model_precisionAccess;
  "model/proposalTotalCache": typeof model_proposalTotalCache;
  "model/proposalTotals": typeof model_proposalTotals;
  "model/publishGates": typeof model_publishGates;
  "model/rateBookAccess": typeof model_rateBookAccess;
  "model/rateBookCsv": typeof model_rateBookCsv;
  "model/rateBookDiff": typeof model_rateBookDiff;
  "model/rateBookMatch": typeof model_rateBookMatch;
  "model/rateBookResolve": typeof model_rateBookResolve;
  "model/rateBookRows": typeof model_rateBookRows;
  "model/rateBookShape": typeof model_rateBookShape;
  "model/rateOverrides": typeof model_rateOverrides;
  "model/repriceBenchmark": typeof model_repriceBenchmark;
  "model/subcontractorQuote": typeof model_subcontractorQuote;
  "model/syncDiff": typeof model_syncDiff;
  "model/takeoff": typeof model_takeoff;
  momentum: typeof momentum;
  orgMaintenance: typeof orgMaintenance;
  precision: typeof precision;
  projectAssignments: typeof projectAssignments;
  rateBookBenchmark: typeof rateBookBenchmark;
  rateBookDiff: typeof rateBookDiff;
  rateBooks: typeof rateBooks;
  reservedPhaseSeed: typeof reservedPhaseSeed;
  seed: typeof seed;
  "sync/fieldMapping": typeof sync_fieldMapping;
  "sync/firestoreClient": typeof sync_firestoreClient;
  "sync/syncEngine": typeof sync_syncEngine;
  "sync/syncMutations": typeof sync_syncMutations;
  "sync/syncQueries": typeof sync_syncQueries;
  takeoffSeed: typeof takeoffSeed;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
