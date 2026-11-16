/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * `precision.ts` — the server, not React, decides who may read and edit
 * estimates.
 *
 * All 31 exported functions were reachable with no caller check of any kind.
 * `listProposals` was an unfiltered `.collect()` handing every one of the 713
 * real InDemand bids — rates, costs, client names — to anyone who could reach
 * the deployment, and every mutation was equally open. Nothing in
 * `apps/precision/src` read `precision_permission` either, so the stored
 * permission model was enforced at neither end.
 *
 * THE AXIS THAT MATTERS MOST IS NOT A REFUSAL. The production OWNER has no
 * `appPermissions` row at all, because `workspace-context.tsx` hardcodes owners
 * to `admin` and never queries permissions for them, and org admins reach full
 * access through their role too. A predicate that read the table alone would
 * resolve them to `none` and lock them out of their own product. That case is
 * tested first and deliberately.
 *
 * This file is the APP-LEVEL sweep under docs/ACCESS.md, using legacy writes
 * (`setPermission` read/write/none → Can view all / Can edit all / No access)
 * the way installed clients still make them. Per-estimate access — "Only
 * assigned", grants, creators — is `precisionItemAccess.test.ts`.
 *
 * The guard runs against the real Better Auth component: organizations, users,
 * members and sessions are seeded into the component's own tables and the caller
 * is set with `t.withIdentity({ subject, sessionId })`, because that is what
 * `safeGetAuthUser` reads. Faking the membership lookup would make every refusal
 * below pass regardless of what the guard did.
 *
 * @see docs/precision/DECISIONS.md D-precisionauthz
 */

import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  authHarness,
  seedOrganization,
  seedPrincipal,
  type Caller,
  type Principal,
} from "./authFixtures";
import { seedProposal, laborActivity, type TestRunner } from "./convexFixtures";
import { RATES_2020 } from "./rates";

/**
 * The refusal a caller with No access must see, from every function: since
 * docs/ACCESS.md there is one access wall, not a read wall and a write wall.
 */
const READ_REFUSED = "Precision access required.";

/** The refusal a Can view all caller sees when changing an estimate. */
const VIEW_ONLY_REFUSED = "You can view this estimate but not edit it.";

/** The refusal a Can view all caller sees when starting a new estimate. */
const START_REFUSED = "You can view estimates but not start new ones.";

/** The refusal a caller with no identity must see — distinct from the above. */
const UNAUTHENTICATED = "Not authenticated.";

/** One of everything, so every function has a real record to be refused on. */
interface Surface {
  proposalId: Id<"proposals">;
  bookId: Id<"rateBooks">;
  wbsId: Id<"wbs">;
  phaseId: Id<"phases">;
  activityId: Id<"activities">;
}

/** A named call, so a sweep failure says which function let a caller through. */
interface NamedCall {
  name: string;
  run: () => Promise<unknown>;
  /** Starts a new estimate, so a view-only caller is refused as a starter. */
  startsEstimate?: true;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/** Run a call that must be refused, and return the message the caller sees. */
async function refusalMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

/**
 * The whole cast, in one organization.
 *
 * `owner` and `orgAdmin` deliberately get NO `appPermissions` row — that is the
 * production shape, and writing one would hide the lockout this file exists to
 * catch. The Precision members are granted through the real legacy
 * `setPermission` mutation, which installed clients still call; the Momentum
 * member through the new `setMemberAppAccess`, because a legacy `admin` write
 * is refused now.
 */
async function seedCast(t: TestRunner): Promise<{
  owner: Principal;
  orgAdmin: Principal;
  writer: Principal;
  reader: Principal;
  denied: Principal;
  momentumEditor: Principal;
}> {
  const organizationId = await seedOrganization(t, "acme");

  const owner = await seedPrincipal(t, { organizationId, role: "owner", email: "owner@acme.test" });
  const orgAdmin = await seedPrincipal(t, {
    organizationId,
    role: "admin",
    email: "orgadmin@acme.test",
  });
  const writer = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "writer@acme.test",
  });
  const reader = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "reader@acme.test",
  });
  const denied = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "denied@acme.test",
  });
  const momentumEditor = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "momentum@acme.test",
  });

  await owner.as.mutation(api.appPermissions.setPermission, {
    memberId: writer.memberId,
    app: "precision",
    permission: "write",
  });
  await owner.as.mutation(api.appPermissions.setPermission, {
    memberId: reader.memberId,
    app: "precision",
    permission: "read",
  });
  await owner.as.mutation(api.appPermissions.setPermission, {
    memberId: denied.memberId,
    app: "precision",
    permission: "none",
  });
  // Momentum Can edit all, Precision nothing: access is per-app and must not
  // leak across. This principal is the whole reason the guard reads `app`.
  await owner.as.mutation(api.access.setMemberAppAccess, {
    memberId: momentumEditor.memberId,
    app: "momentum",
    access: "edit_all",
  });

  return { owner, orgAdmin, writer, reader, denied, momentumEditor };
}

/** A proposal tree plus one row in each reference catalog. */
async function seedSurface(t: TestRunner): Promise<Surface> {
  const tree = await seedProposal(t, {
    proposalNumber: "2042",
    rates: RATES_2020,
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [{ phaseNumber: 1, phasePoolId: 70001, activities: [laborActivity(10)] }],
      },
    ],
  });

  // Seeded so "a permitted caller can read the catalogs" asserts on real rows
  // rather than passing vacuously against four empty tables.
  await t.run(async (ctx) => {
    await ctx.db.insert("wbsPool", {
      datasetVersion: "v1",
      bookId: tree.bookId,
      poolId: 70000,
      name: "AG PIPING",
      sortOrder: 7,
      isCustom: false,
      isActive: true,
    });
    await ctx.db.insert("phasePool", {
      datasetVersion: "v1",
      bookId: tree.bookId,
      poolId: 70001,
      wbsPoolId: 70000,
      name: "CARBON STEEL",
      sortOrder: 1,
      isCustom: false,
      isActive: true,
    });
    await ctx.db.insert("laborPool", {
      datasetVersion: "v1",
      bookId: tree.bookId,
      poolId: 2738,
      phasePoolId: 70001,
      description: "FSW - ≤.75",
      sortOrder: 10,
      craftConstant: 0.6,
      craftUnits: "LF",
      weldConstant: 0.6,
      weldUnits: "LF",
      isCustom: false,
      isActive: true,
    });
    await ctx.db.insert("equipmentPool", {
      datasetVersion: "v1",
      bookId: tree.bookId,
      poolId: 1,
      description: "AIR COMPRESSOR",
      hourRate: 8,
      dayRate: 64,
      weekRate: 256,
      monthRate: 768,
      sortOrder: 1,
      isCustom: false,
      isActive: true,
    });
  });

  return {
    proposalId: tree.proposalId,
    bookId: tree.bookId,
    wbsId: must(tree.wbsByCode.get(70000), "wbs 70000"),
    phaseId: must(tree.phaseByNumber.get("70000:1"), "phase 70000:1"),
    activityId: must(tree.activityIds[0], "an activity"),
  };
}

/**
 * Every exported query, with arguments that would succeed for a permitted
 * caller.
 *
 * WHY A TABLE RATHER THAN ONE TEST PER FUNCTION: the risk with 31 hand-edited
 * handlers is not that a guard is wrong, it is that one handler was MISSED. A
 * sweep fails loudly and by name when that happens; fifteen bespoke tests fail
 * only for the functions someone remembered to write a test for.
 */
function everyQuery(caller: Caller, s: Surface): NamedCall[] {
  return [
    { name: "listProposals", run: () => caller.query(api.precision.listProposals, {}) },
    {
      name: "getProposal",
      run: () => caller.query(api.precision.getProposal, { proposalId: s.proposalId }),
    },
    {
      name: "getWBSForProposal",
      run: () => caller.query(api.precision.getWBSForProposal, { proposalId: s.proposalId }),
    },
    {
      name: "getWBSWithPhasesForNav",
      run: () => caller.query(api.precision.getWBSWithPhasesForNav, { proposalId: s.proposalId }),
    },
    {
      name: "getActivitiesWithCosts",
      run: () => caller.query(api.precision.getActivitiesWithCosts, { phaseId: s.phaseId }),
    },
    {
      name: "getPhaseListWithCosts",
      run: () => caller.query(api.precision.getPhaseListWithCosts, { wbsId: s.wbsId }),
    },
    {
      name: "getWBSListWithCosts",
      run: () => caller.query(api.precision.getWBSListWithCosts, { proposalId: s.proposalId }),
    },
    {
      name: "getProposalSummary",
      run: () => caller.query(api.precision.getProposalSummary, { proposalId: s.proposalId }),
    },
    { name: "getWBS", run: () => caller.query(api.precision.getWBS, { wbsId: s.wbsId }) },
    { name: "getPhase", run: () => caller.query(api.precision.getPhase, { phaseId: s.phaseId }) },
    {
      name: "getPhaseTakeoffCatalog",
      run: () =>
        caller.query(api.precision.getPhaseTakeoffCatalog, {
          bookId: s.bookId,
          phasePoolId: 70001,
        }),
    },
    {
      name: "getWBSPool",
      run: () => caller.query(api.precision.getWBSPool, { bookId: s.bookId }),
    },
    {
      name: "getPhasePool",
      run: () => caller.query(api.precision.getPhasePool, { bookId: s.bookId, wbsPoolId: 70000 }),
    },
    {
      name: "getLaborPool",
      run: () => caller.query(api.precision.getLaborPool, { bookId: s.bookId, phasePoolId: 70001 }),
    },
    {
      name: "getEquipmentPool",
      run: () => caller.query(api.precision.getEquipmentPool, { bookId: s.bookId }),
    },
    {
      name: "getExportData",
      run: () => caller.query(api.precision.getExportData, { proposalId: s.proposalId }),
    },
  ];
}

/** Every exported mutation, with arguments that would succeed if permitted. */
function everyMutation(caller: Caller, s: Surface): NamedCall[] {
  return [
    {
      name: "createProposal",
      startsEstimate: true,
      run: () =>
        caller.mutation(api.precision.createProposal, {
          proposalNumber: "9001",
          description: "NEW",
          ownerName: "InDemand",
          rates: { ...RATES_2020 },
          datasetVersion: "v1",
        }),
    },
    {
      name: "updateProposal",
      run: () =>
        caller.mutation(api.precision.updateProposal, {
          proposalId: s.proposalId,
          description: "CHANGED BY AN UNAUTHORIZED CALLER",
        }),
    },
    {
      name: "updateProposalRates",
      run: () =>
        caller.mutation(api.precision.updateProposalRates, {
          proposalId: s.proposalId,
          rates: { ...RATES_2020, craftBaseRate: 999 },
        }),
    },
    {
      name: "deleteProposal",
      run: () => caller.mutation(api.precision.deleteProposal, { proposalId: s.proposalId }),
    },
    {
      name: "addWBS",
      run: () =>
        caller.mutation(api.precision.addWBS, {
          proposalId: s.proposalId,
          wbsPoolId: 10000,
          name: "MOBILIZE",
        }),
    },
    { name: "deleteWBS", run: () => caller.mutation(api.precision.deleteWBS, { wbsId: s.wbsId }) },
    {
      name: "setWBSHidden",
      run: () => caller.mutation(api.precision.setWBSHidden, { wbsId: s.wbsId, hidden: true }),
    },
    {
      name: "addPhase",
      run: () =>
        caller.mutation(api.precision.addPhase, {
          wbsId: s.wbsId,
          phasePoolId: 70001,
          poolName: "CARBON STEEL",
          phaseNumber: 99,
          description: "ADDED",
        }),
    },
    {
      name: "updatePhase",
      run: () =>
        caller.mutation(api.precision.updatePhase, {
          phaseId: s.phaseId,
          description: "CHANGED BY AN UNAUTHORIZED CALLER",
        }),
    },
    {
      name: "deletePhase",
      run: () => caller.mutation(api.precision.deletePhase, { phaseId: s.phaseId }),
    },
    {
      name: "duplicatePhase",
      run: () =>
        caller.mutation(api.precision.duplicatePhase, {
          sourcePhaseId: s.phaseId,
          newPhaseNumber: 98,
        }),
    },
    {
      name: "copyActivitiesToPhase",
      run: () =>
        caller.mutation(api.precision.copyActivitiesToPhase, {
          sourcePhaseId: s.phaseId,
          targetPhaseId: s.phaseId,
        }),
    },
    {
      name: "addActivity",
      run: () =>
        caller.mutation(api.precision.addActivity, {
          phaseId: s.phaseId,
          type: "labor",
          description: "ADDED",
          quantity: 1,
          unit: "EA",
          labor: { craftConstant: 1, welderConstant: 0 },
        }),
    },
    {
      name: "updateActivity",
      run: () =>
        caller.mutation(api.precision.updateActivity, { activityId: s.activityId, quantity: 42 }),
    },
    {
      name: "batchDeleteActivities",
      run: () =>
        caller.mutation(api.precision.batchDeleteActivities, { activityIds: [s.activityId] }),
    },
    {
      name: "reorderActivities",
      run: () =>
        caller.mutation(api.precision.reorderActivities, {
          phaseId: s.phaseId,
          orderedActivityIds: [s.activityId],
        }),
    },
    {
      name: "duplicateProposal",
      startsEstimate: true,
      run: () =>
        caller.mutation(api.precision.duplicateProposal, {
          sourceProposalId: s.proposalId,
          newProposalNumber: "2042.01",
        }),
    },
  ];
}

/** A snapshot of everything the mutation sweep would disturb if it got through. */
async function snapshot(t: TestRunner): Promise<{
  proposals: number;
  wbs: number;
  phases: number;
  activities: number;
  description: string | null;
  craftBaseRate: number | null;
  precisionOwnedAt: number | null;
}> {
  return await t.run(async (ctx) => {
    const proposals = await ctx.db.query("proposals").collect();
    const first = proposals[0] ?? null;
    return {
      proposals: proposals.length,
      wbs: (await ctx.db.query("wbs").collect()).length,
      phases: (await ctx.db.query("phases").collect()).length,
      activities: (await ctx.db.query("activities").collect()).length,
      description: first?.description ?? null,
      craftBaseRate: first?.rates.craftBaseRate ?? null,
      // `t.run` serializes `undefined` to `null`; normalise so the assertion
      // never depends on which of the two it happens to observe.
      precisionOwnedAt: first?.precisionOwnedAt ?? null,
    };
  });
}

// ============================================================================
// THE LOCKOUT AXIS — the tests that matter most
// ============================================================================

describe("an organization owner with no appPermissions row keeps full access", () => {
  it("can read every query", async () => {
    const t = authHarness();
    const { owner } = await seedCast(t);
    const surface = await seedSurface(t);

    // Not a smoke test: production's owner has no row in `appPermissions`, so a
    // predicate built only on that table resolves them to "none" and signs them
    // out of the product they own.
    for (const { name, run } of everyQuery(owner.as, surface)) {
      await expect(run(), `${name} refused the owner`).resolves.toBeDefined();
    }
  });

  it("can write", async () => {
    const t = authHarness();
    const { owner } = await seedCast(t);
    const surface = await seedSurface(t);

    await owner.as.mutation(api.precision.updateProposal, {
      proposalId: surface.proposalId,
      description: "EDITED BY THE OWNER",
    });

    const after = await owner.as.query(api.precision.getProposal, {
      proposalId: surface.proposalId,
    });
    expect(after.description).toBe("EDITED BY THE OWNER");
  });

  it("holds no appPermissions row — so the role branch is what granted access", async () => {
    // Without this the test above would still pass if some fixture had quietly
    // granted the owner `admin`, and the lockout would ship undetected.
    const t = authHarness();
    const { owner } = await seedCast(t);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("appPermissions")
        .withIndex("by_member", (q) => q.eq("memberId", owner.memberId))
        .collect()
    );
    expect(rows).toHaveLength(0);
  });
});

describe("an organization admin with no appPermissions row keeps full access", () => {
  it("can read and write", async () => {
    const t = authHarness();
    const { orgAdmin } = await seedCast(t);
    const surface = await seedSurface(t);

    const proposals = await orgAdmin.as.query(api.precision.listProposals, {});
    expect(proposals).toHaveLength(1);

    await orgAdmin.as.mutation(api.precision.updateProposal, {
      proposalId: surface.proposalId,
      description: "EDITED BY AN ORG ADMIN",
    });

    const after = await orgAdmin.as.query(api.precision.getProposal, {
      proposalId: surface.proposalId,
    });
    expect(after.description).toBe("EDITED BY AN ORG ADMIN");
  });
});

// ============================================================================
// UNAUTHENTICATED
// ============================================================================

describe("an unauthenticated caller", () => {
  it("is refused by every query, and told to sign in rather than ask for access", async () => {
    const t = authHarness();
    await seedCast(t);
    const surface = await seedSurface(t);

    for (const { name, run } of everyQuery(t, surface)) {
      await expect(run(), `${name} served an unauthenticated caller`).rejects.toThrow(
        UNAUTHENTICATED
      );
    }
  });

  it("is refused by every mutation", async () => {
    const t = authHarness();
    await seedCast(t);
    const surface = await seedSurface(t);
    const before = await snapshot(t);

    for (const { name, run } of everyMutation(t, surface)) {
      await expect(run(), `${name} accepted an unauthenticated caller`).rejects.toThrow(
        UNAUTHENTICATED
      );
    }

    expect(await snapshot(t)).toEqual(before);
  });

  it("cannot forge a session for a real user", async () => {
    // Proves the refusals above are authorization rather than a harness that
    // never resolves anybody: the subject is a genuine user id.
    const t = authHarness();
    const { owner } = await seedCast(t);
    const forged = t.withIdentity({ subject: owner.userId, sessionId: "no-such-session" });

    await expect(forged.query(api.precision.listProposals, {})).rejects.toThrow(UNAUTHENTICATED);
  });
});

// ============================================================================
// PRECISION "none"
// ============================================================================

describe("a member with Precision 'none'", () => {
  it("is refused by every query", async () => {
    const t = authHarness();
    const { denied } = await seedCast(t);
    const surface = await seedSurface(t);

    for (const { name, run } of everyQuery(denied.as, surface)) {
      await expect(run(), `${name} served a caller with no Precision access`).rejects.toThrow(
        READ_REFUSED
      );
    }
  });

  it("is refused by every mutation, and changes nothing", async () => {
    const t = authHarness();
    const { denied } = await seedCast(t);
    const surface = await seedSurface(t);
    const before = await snapshot(t);

    // One wall for No access, whatever the function: it names the app, never
    // a record. (Before docs/ACCESS.md mutations said "edit access required";
    // there is no app-level edit wall any more, only the app and the estimate.)
    for (const { name, run } of everyMutation(denied.as, surface)) {
      await expect(run(), `${name} accepted a caller with no Precision access`).rejects.toThrow(
        READ_REFUSED
      );
    }

    expect(await snapshot(t)).toEqual(before);
  });
});

describe("a Momentum Can edit all member with Precision 'none'", () => {
  it("is refused — access is per-app and does not leak across", async () => {
    const t = authHarness();
    const { momentumEditor } = await seedCast(t);
    const surface = await seedSurface(t);

    await expect(momentumEditor.as.query(api.precision.listProposals, {})).rejects.toThrow(
      READ_REFUSED
    );
    await expect(
      momentumEditor.as.query(api.precision.getProposal, { proposalId: surface.proposalId })
    ).rejects.toThrow(READ_REFUSED);
    await expect(
      momentumEditor.as.mutation(api.precision.updateProposal, {
        proposalId: surface.proposalId,
        description: "CROSSED OVER FROM MOMENTUM",
      })
    ).rejects.toThrow(READ_REFUSED);
  });

  it("still holds their Momentum access — the refusal is scoping, not revocation", async () => {
    const t = authHarness();
    const { owner, momentumEditor } = await seedCast(t);

    // Read through the legacy surface installed clients use: Can edit all is
    // reported as `write` there (docs/ACCESS.md, Compatibility).
    const permissions = await owner.as.query(api.appPermissions.getMemberPermissions, {
      memberId: momentumEditor.memberId,
    });
    expect(permissions.momentum).toBe("write");
    expect(permissions.precision).toBe("none");
  });
});

// ============================================================================
// PRECISION "read" — both directions
// ============================================================================

describe("a member with Precision 'read'", () => {
  it("can call every query", async () => {
    const t = authHarness();
    const { reader } = await seedCast(t);
    const surface = await seedSurface(t);

    for (const { name, run } of everyQuery(reader.as, surface)) {
      await expect(run(), `${name} refused a read-granted caller`).resolves.toBeDefined();
    }
  });

  it("reads real catalog rows, not four empty tables", async () => {
    const t = authHarness();
    const { reader } = await seedCast(t);
    const s = await seedSurface(t);

    expect(await reader.as.query(api.precision.getWBSPool, { bookId: s.bookId })).toHaveLength(1);
    expect(
      await reader.as.query(api.precision.getPhasePool, { bookId: s.bookId, wbsPoolId: 70000 })
    ).toHaveLength(1);
    expect(
      await reader.as.query(api.precision.getLaborPool, {
        bookId: s.bookId,
        phasePoolId: 70001,
      })
    ).toHaveLength(1);
    expect(
      await reader.as.query(api.precision.getEquipmentPool, { bookId: s.bookId })
    ).toHaveLength(1);
  });

  it("is refused by every mutation, and changes nothing", async () => {
    // A legacy `read` is Can view all: every estimate opens, none changes, and
    // no new one starts. Each refusal names which of the two was asked for.
    const t = authHarness();
    const { reader } = await seedCast(t);
    const surface = await seedSurface(t);
    const before = await snapshot(t);

    for (const { name, run, startsEstimate } of everyMutation(reader.as, surface)) {
      await expect(run(), `${name} accepted a read-only caller`).rejects.toThrow(
        startsEstimate ? START_REFUSED : VIEW_ONLY_REFUSED
      );
    }

    expect(await snapshot(t)).toEqual(before);
  });

  it("does not detach an estimate from the mirror on a refused write (D1)", async () => {
    // The guard runs before `claimForPrecision`, so a refused write cannot stamp
    // `precisionOwnedAt` and cut the estimate off from the estimator sync.
    const t = authHarness();
    const { reader } = await seedCast(t);
    const surface = await seedSurface(t);

    await expect(
      reader.as.mutation(api.precision.updateProposalRates, {
        proposalId: surface.proposalId,
        rates: { ...RATES_2020, craftBaseRate: 999 },
      })
    ).rejects.toThrow(VIEW_ONLY_REFUSED);

    expect((await snapshot(t)).precisionOwnedAt).toBeNull();
  });
});

// ============================================================================
// PRECISION "write"
// ============================================================================

describe("a member with Precision 'write'", () => {
  it("can create, edit and delete", async () => {
    const t = authHarness();
    const { writer } = await seedCast(t);
    const surface = await seedSurface(t);

    await writer.as.mutation(api.precision.updateProposal, {
      proposalId: surface.proposalId,
      description: "EDITED BY A WRITER",
    });
    const edited = await writer.as.query(api.precision.getProposal, {
      proposalId: surface.proposalId,
    });
    expect(edited.description).toBe("EDITED BY A WRITER");

    const createdId = await writer.as.mutation(api.precision.createProposal, {
      proposalNumber: "9001",
      description: "CREATED BY A WRITER",
      ownerName: "InDemand",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });

    await writer.as.mutation(api.precision.deleteProposal, { proposalId: createdId });
    expect(await writer.as.query(api.precision.listProposals, {})).toHaveLength(1);
  });

  it("can read as well — write implies read under the shared hierarchy", async () => {
    const t = authHarness();
    const { writer } = await seedCast(t);
    const surface = await seedSurface(t);

    for (const { name, run } of everyQuery(writer.as, surface)) {
      await expect(run(), `${name} refused a write-granted caller`).resolves.toBeDefined();
    }
  });
});

// ============================================================================
// REFUSALS DO NOT LEAK
// ============================================================================

describe("a refusal never doubles as an existence check", () => {
  it("reports the same message for a real proposal and one that was deleted", async () => {
    const t = authHarness();
    const { owner, denied } = await seedCast(t);
    const surface = await seedSurface(t);

    // A syntactically valid id that no longer resolves to a document.
    const goneId = await owner.as.mutation(api.precision.createProposal, {
      proposalNumber: "9002",
      description: "SOON DELETED",
      ownerName: "InDemand",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });
    await owner.as.mutation(api.precision.deleteProposal, { proposalId: goneId });

    const real = await refusalMessage(() =>
      denied.as.query(api.precision.getProposal, { proposalId: surface.proposalId })
    );
    const gone = await refusalMessage(() =>
      denied.as.query(api.precision.getProposal, { proposalId: goneId })
    );

    // Both must be the permission refusal. If the missing one said "Proposal not
    // found", the refusal itself would confirm which ids exist.
    expect(real).toContain(READ_REFUSED);
    expect(gone).toContain(READ_REFUSED);
    expect(gone).not.toContain("not found");
  });
});
