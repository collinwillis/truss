/**
 * One-time seed of the D-takeoff catalog flags.
 *
 * Source of truth: InDemand's phase-maintenance workbook
 * (`InDemandIS-PhaseMaintenance - MJB.xlsx`, received from the business
 * 2026-07-30). Its Phases sheet names, per phase type, which labor-catalog
 * lines carry the takeoff and in what unit. This mutation writes that
 * knowledge onto the catalog rows: `phasePool.takeoffUnit` and
 * `laborPool.countsTowardTakeoff`.
 *
 * STRING MATCHING HAPPENS HERE AND ONLY HERE. Runtime takeoff computation
 * (`model/takeoff.ts`) reads flags, never descriptions — matching at seed
 * time against catalog rows is auditable (the run reports every match
 * count); matching at runtime against user-typed descriptions is how legacy
 * double-counted concrete.
 *
 * Idempotent: values are absolute, so re-running converges. Additive: no
 * field is removed and no unlisted row is touched.
 *
 * KNOWN WORKBOOK GAPS (seeded with unit but zero flagged lines — derived
 * quantity stays 0 until the business fixes the catalog or overrides):
 *  - 60008 LADDER & CAGE FABRICATION: rule says CLEAN UP, but the phase's
 *    items are OFFLOAD/FABRICATE/LOAD — no CLEAN UP line exists.
 *  - 130002 HDPE - D2239: rule says HE, but HDPE items are FUSE/V/BU — fused
 *    pipe has no HE lines.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

interface TakeoffRule {
  phasePoolId: number;
  unit: string;
  /** Matched against catalog item descriptions, uppercased, at seed time. */
  match: string;
}

/** The Phases sheet, verbatim: 65 phase types with a takeoff rule. */
const TAKEOFF_RULES: readonly TakeoffRule[] = [
  { phasePoolId: 20002, unit: "CY", match: "EXCAVATE" },
  { phasePoolId: 20003, unit: "CY", match: "EXCAVATE" },
  { phasePoolId: 20004, unit: "CY", match: "EXCAVATE" },
  { phasePoolId: 20005, unit: "CY", match: "EXCAVATE" },
  { phasePoolId: 20006, unit: "CY", match: "EXCAVATE" },
  { phasePoolId: 20009, unit: "CY", match: "BACKFILL / COMPACT" },
  { phasePoolId: 20010, unit: "CY", match: "BACKFILL / COMPACT" },
  { phasePoolId: 20011, unit: "CY", match: "BACKFILL / COMPACT" },
  { phasePoolId: 20012, unit: "CY", match: "BACKFILL / COMPACT" },
  { phasePoolId: 20013, unit: "CY", match: "BACKFILL / COMPACT" },
  { phasePoolId: 30001, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30002, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30003, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30004, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30005, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30006, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30007, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30008, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30009, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30010, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30011, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 30012, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 30013, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 30014, unit: "CY", match: "CLEAN UP" },
  { phasePoolId: 30015, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 40001, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 40002, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 40003, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 40004, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 50001, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 50002, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 50003, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 50004, unit: "EA", match: "CLEAN UP" },
  { phasePoolId: 60008, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 60009, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 60010, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 60011, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 60012, unit: "TON", match: "CLEAN UP" },
  { phasePoolId: 70001, unit: "LF", match: "HE" },
  { phasePoolId: 70002, unit: "LF", match: "HE" },
  { phasePoolId: 70003, unit: "LF", match: "HE" },
  { phasePoolId: 70004, unit: "LF", match: "HE" },
  { phasePoolId: 70005, unit: "LF", match: "HE" },
  { phasePoolId: 70006, unit: "LF", match: "HE" },
  { phasePoolId: 70007, unit: "LF", match: "HE" },
  { phasePoolId: 70008, unit: "LF", match: "HE" },
  { phasePoolId: 70009, unit: "LF", match: "HE" },
  { phasePoolId: 70010, unit: "LF", match: "HE" },
  { phasePoolId: 70011, unit: "LF", match: "HE" },
  { phasePoolId: 70012, unit: "LF", match: "HE" },
  { phasePoolId: 70013, unit: "LF", match: "HE" },
  { phasePoolId: 70014, unit: "LF", match: "HE" },
  { phasePoolId: 70015, unit: "LF", match: "HE" },
  { phasePoolId: 70016, unit: "LF", match: "HE" },
  { phasePoolId: 70017, unit: "LF", match: "HE" },
  { phasePoolId: 70018, unit: "LF", match: "HE" },
  { phasePoolId: 79989, unit: "LF", match: "OFF" },
  { phasePoolId: 79996, unit: "LF", match: "HYDRO" },
  { phasePoolId: 79997, unit: "LF", match: "PNEU" },
  { phasePoolId: 130001, unit: "LF", match: "HE" },
  { phasePoolId: 130002, unit: "LF", match: "HE" },
  { phasePoolId: 130003, unit: "LF", match: "HE" },
  { phasePoolId: 139989, unit: "LF", match: "OFF" },
  { phasePoolId: 139996, unit: "LF", match: "HYDRO" },
  { phasePoolId: 139997, unit: "LF", match: "PNEU" },
];

/**
 * Whether a catalog item description matches a rule.
 *
 * "CLEAN UP" tolerates the spacing variants legacy data contains; every
 * other keyword is a plain substring of the uppercased description, which
 * was verified against all 65 ruled phases to produce zero false positives
 * — catalog items are literally named `HE - 60`, `OFF - 54`, `EXCAVATE, …`.
 */
function matchesRule(description: string, match: string): boolean {
  const upper = description.toUpperCase();
  if (match === "CLEAN UP") return /CLEAN\s*UP/.test(upper);
  return upper.includes(match);
}

/**
 * Seed `phasePool.takeoffUnit` and `laborPool.countsTowardTakeoff` for one
 * dataset version. Returns per-rule match counts so the run is auditable.
 */
export const seedTakeoffCatalog = internalMutation({
  args: { datasetVersion: v.union(v.literal("v1"), v.literal("v2")) },
  handler: async (ctx, args) => {
    const results: Array<{ phasePoolId: number; unit: string; flagged: number }> = [];

    for (const rule of TAKEOFF_RULES) {
      const pool = await ctx.db
        .query("phasePool")
        .withIndex("by_version_pool_id", (q) =>
          q.eq("datasetVersion", args.datasetVersion).eq("poolId", rule.phasePoolId)
        )
        .unique();
      if (pool && pool.takeoffUnit !== rule.unit) {
        await ctx.db.patch(pool._id, { takeoffUnit: rule.unit });
      }

      const items = await ctx.db
        .query("laborPool")
        .withIndex("by_version_phase", (q) =>
          q.eq("datasetVersion", args.datasetVersion).eq("phasePoolId", rule.phasePoolId)
        )
        .collect();

      let flagged = 0;
      for (const item of items) {
        const shouldFlag = matchesRule(item.description, rule.match);
        if (shouldFlag) flagged++;
        if ((item.countsTowardTakeoff ?? false) !== shouldFlag) {
          await ctx.db.patch(item._id, { countsTowardTakeoff: shouldFlag });
        }
      }
      results.push({ phasePoolId: rule.phasePoolId, unit: rule.unit, flagged });
    }

    const zeroMatch = results.filter((r) => r.flagged === 0).map((r) => r.phasePoolId);
    return {
      rules: results.length,
      totalFlagged: results.reduce((s, r) => s + r.flagged, 0),
      zeroMatch,
    };
  },
});
