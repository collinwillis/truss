/// <reference types="vite/client" />

/**
 * Fixture builder for the Convex query suites.
 *
 * ⚠️ THE MOST IMPORTANT DESIGN DECISION IN THIS FILE: `sortOrder` defaults are
 * deliberately **adversarial** — they run *opposite* to the domain order
 * (`wbsPoolId` for WBS, `phaseNumber` for phases).
 *
 * WHY: the queries used to order by `sortOrder` and now order by the domain
 * field. A fixture where the two agree would pass under either implementation,
 * so the test would look like coverage while proving nothing. An earlier review
 * caught exactly that class of vacuous pass. Seed them in conflict and the
 * assertion has teeth.
 *
 * Override `sortOrder` explicitly when a test needs a specific arrangement.
 *
 * TEST-ONLY. Never import from production code.
 */

import type { TestConvexForDataModelAndIdentity } from "convex-test";

import type { DataModel, Id } from "../convex/_generated/dataModel";
import type { RateFixture } from "./rates";
import { RATES_2020 } from "./rates";

/**
 * The convex-test instance, typed against this deployment's data model.
 *
 * Aliased rather than re-declared structurally: an approximate hand-written
 * shape compiles until the harness changes, then fails somewhere unhelpful.
 */
export type TestRunner = TestConvexForDataModelAndIdentity<DataModel>;

/** Minimal activity spec. Cost-bearing fields mirror the engine's inputs. */
export interface ActivitySpec {
  type: "labor" | "custom_labor" | "material" | "equipment" | "subcontractor" | "cost_only";
  quantity: number;
  description?: string;
  unit?: string;
  sortOrder?: number;
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

/** A phase and its activities. */
export interface PhaseSpec {
  phaseNumber: number;
  description?: string;
  phasePoolId?: number;
  poolName?: string;
  /** Defaults to the reverse of declaration order — see the file header. */
  sortOrder?: number;
  isCompleted?: boolean;
  activities?: ActivitySpec[];
}

/** A WBS and its phases. `poolId` is the numeric WBS code (10000, 70000, …). */
export interface WbsSpec {
  poolId: number;
  name?: string;
  /** Defaults to the reverse of declaration order — see the file header. */
  sortOrder?: number;
  phases?: PhaseSpec[];
}

/** A whole proposal tree. */
export interface ProposalSpec {
  proposalNumber?: string;
  description?: string;
  ownerName?: string;
  rates?: RateFixture;
  wbs?: WbsSpec[];
}

/** Ids of everything created, keyed for assertions. */
export interface SeededTree {
  proposalId: Id<"proposals">;
  /** Keyed by WBS code. */
  wbsByCode: Map<number, Id<"wbs">>;
  /** Keyed by `${wbsCode}:${phaseNumber}`. */
  phaseByNumber: Map<string, Id<"phases">>;
  activityIds: Id<"activities">[];
}

/**
 * Seed a proposal → WBS → phase → activity tree.
 *
 * Returns ids so a test can assert on ordering and totals without re-querying
 * for identity.
 *
 * NOTE: whatever `t.run()` returns is passed through Convex's value serializer,
 * which rejects `Map` (and `Set`, `Date`, class instances…). So the seeding
 * closure returns plain arrays and the ergonomic `Map`s are built out here.
 */
export async function seedProposal(t: TestRunner, spec: ProposalSpec): Promise<SeededTree> {
  const wbsSpecs = spec.wbs ?? [];

  const seeded = await t.run(async (ctx) => {
    const proposalId = await ctx.db.insert("proposals", {
      proposalNumber: spec.proposalNumber ?? "2020",
      description: spec.description ?? "Tank 8 installation",
      ownerName: spec.ownerName ?? "Test Owner",
      rates: { ...(spec.rates ?? RATES_2020) },
      datasetVersion: "v1",
    });

    const wbsEntries: Array<{ code: number; id: Id<"wbs"> }> = [];
    const phaseEntries: Array<{ key: string; id: Id<"phases"> }> = [];
    const activityIds: Id<"activities">[] = [];

    for (const [wbsIndex, wbsSpec] of wbsSpecs.entries()) {
      // Adversarial default: reverse of declaration order, so `sortOrder` and
      // `wbsPoolId` cannot both be satisfied by the same ordering.
      const wbsSortOrder = wbsSpec.sortOrder ?? wbsSpecs.length - wbsIndex;

      const wbsId = await ctx.db.insert("wbs", {
        proposalId,
        wbsPoolId: wbsSpec.poolId,
        name: wbsSpec.name ?? `WBS ${wbsSpec.poolId}`,
        sortOrder: wbsSortOrder,
      });
      wbsEntries.push({ code: wbsSpec.poolId, id: wbsId });

      const phaseSpecs = wbsSpec.phases ?? [];
      for (const [phaseIndex, phaseSpec] of phaseSpecs.entries()) {
        const phaseSortOrder = phaseSpec.sortOrder ?? phaseSpecs.length - phaseIndex;

        const phaseId = await ctx.db.insert("phases", {
          proposalId,
          wbsId,
          phasePoolId: phaseSpec.phasePoolId ?? 70001,
          poolName: phaseSpec.poolName ?? "CARBON STEEL",
          phaseNumber: phaseSpec.phaseNumber,
          description: phaseSpec.description ?? `Phase ${phaseSpec.phaseNumber}`,
          isCompleted: phaseSpec.isCompleted ?? false,
          sortOrder: phaseSortOrder,
        });
        phaseEntries.push({ key: `${wbsSpec.poolId}:${phaseSpec.phaseNumber}`, id: phaseId });

        for (const [actIndex, act] of (phaseSpec.activities ?? []).entries()) {
          const activityId = await ctx.db.insert("activities", {
            proposalId,
            wbsId,
            phaseId,
            type: act.type,
            description: act.description ?? `${act.type} line`,
            quantity: act.quantity,
            unit: act.unit ?? "EA",
            sortOrder: act.sortOrder ?? actIndex + 1,
            ...(act.unitPrice !== undefined ? { unitPrice: act.unitPrice } : {}),
            ...(act.labor ? { labor: act.labor } : {}),
            ...(act.equipment ? { equipment: act.equipment } : {}),
            ...(act.subcontractor ? { subcontractor: act.subcontractor } : {}),
          });
          activityIds.push(activityId);
        }
      }
    }

    return { proposalId, wbsEntries, phaseEntries, activityIds };
  });

  return {
    proposalId: seeded.proposalId,
    wbsByCode: new Map(seeded.wbsEntries.map((e) => [e.code, e.id])),
    phaseByNumber: new Map(seeded.phaseEntries.map((e) => [e.key, e.id])),
    activityIds: seeded.activityIds,
  };
}

/**
 * A labor activity, the 93%-of-production case (labor + custom_labor).
 *
 * Constants chosen so `quantity × constant` is non-terminating in binary, which
 * is what makes rounding-policy regressions visible.
 */
export function laborActivity(quantity: number, craftConstant = 0.55): ActivitySpec {
  return {
    type: "labor",
    quantity,
    labor: { craftConstant, welderConstant: 0 },
  };
}
