/**
 * One-time seed of the D-phasenumber reserved flags.
 *
 * Source of truth: legacy `add_phase_dialog.tsx`'s
 * `listOfPhaseNumbersForSetPhaseName`, transcribed verbatim. These catalog
 * phases carry their id as the phase number on every estimate; everything
 * else numbers sequentially from the WBS code.
 *
 * Idempotent — values are absolute, so re-running converges. Ids in the list
 * with no catalog row (if any) are reported, not invented.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Legacy's reserved list, verbatim. */
export const RESERVED_PHASE_POOL_IDS: readonly number[] = [
  10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010, 10011, 19999, 29987, 29998,
  29999, 39982, 39987, 39991, 39998, 39999, 49982, 49988, 49991, 49992, 49993, 49994, 49995, 49996,
  49998, 49999, 59982, 59991, 59998, 59999, 69982, 69990, 69998, 69999, 79984, 79988, 79989, 79990,
  79992, 79993, 79994, 79995, 79996, 79997, 79998, 79999, 89999, 99986, 99990, 99998, 99999, 100001,
  109999, 110001, 119999, 129998, 129999, 139983, 139984, 139985, 139989, 139990, 139992, 139993,
  139994, 139995, 139996, 139997, 139998, 139999, 140001, 149999, 159999, 180001, 180002, 180003,
  180004, 189999, 190001, 190002, 190003, 190004, 190005, 190006, 190007, 199999, 200100, 200200,
  200300, 200400, 200500, 200600, 200700, 200800, 200900, 201010, 201020, 201030, 201040, 201050,
  201060, 209980, 209981, 209982, 209998, 209999,
];

/** Flag `phasePool.reservedPhaseNumber` for one dataset version. */
export const seedReservedPhaseNumbers = internalMutation({
  args: { datasetVersion: v.union(v.literal("v1"), v.literal("v2")) },
  handler: async (ctx, args) => {
    let flagged = 0;
    const missing: number[] = [];

    for (const poolId of RESERVED_PHASE_POOL_IDS) {
      const pool = await ctx.db
        .query("phasePool")
        .withIndex("by_version_pool_id", (q) =>
          q.eq("datasetVersion", args.datasetVersion).eq("poolId", poolId)
        )
        .unique();
      if (!pool) {
        missing.push(poolId);
        continue;
      }
      if (pool.reservedPhaseNumber !== true) {
        await ctx.db.patch(pool._id, { reservedPhaseNumber: true });
      }
      flagged++;
    }

    return { listed: RESERVED_PHASE_POOL_IDS.length, flagged, missing };
  },
});
