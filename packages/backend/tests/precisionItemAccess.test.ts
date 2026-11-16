/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Precision, one estimate at a time (docs/ACCESS.md).
 *
 * `precisionAuthorization.test.ts` sweeps the app-level wall. This file is
 * what the new model adds on top: an "Only assigned" estimator sees the
 * estimates they were added to and nothing else, a Can view grant cannot
 * change anything, a Can edit grant can, the app-wide settings reach every
 * estimate, and the creator of an estimate keeps it.
 *
 * THE RISK THIS FILE EXISTS FOR is a function keyed by a WBS, phase or
 * activity id that checks only the app: it would hand an assigned estimator
 * every other bid through the side door. So every refusal below is asserted
 * for one function of each key kind, not just for the proposal-keyed ones.
 *
 * Runs against the real Better Auth component, and grants are written through
 * the public `access.grantItemAccess` an Owner uses, so a passing refusal means
 * the rule refused rather than that nobody was signed in.
 */

import { ConvexError } from "convex/values";
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
import { laborActivity, seedProposal, type TestRunner } from "./convexFixtures";
import { RATES_2020 } from "./rates";

// ============================================================================
// REFUSALS — the sentences a person reads
// ============================================================================

const APP_REFUSED = "Precision access required.";
const ITEM_REFUSED = "You do not have access to this estimate.";
const VIEW_ONLY = "You can view this estimate but not edit it.";
const START_REFUSED = "You can view estimates but not start new ones.";
const ORG_ADMIN_REFUSED = "Organization admin access required.";

// ============================================================================
// FIXTURES
// ============================================================================

/** One estimate's ids at every level a function can be keyed by. */
interface Estimate {
  proposalId: Id<"proposals">;
  wbsId: Id<"wbs">;
  phaseId: Id<"phases">;
  activityId: Id<"activities">;
}

/** A named call, so a sweep failure says which function let a caller through. */
interface NamedCall {
  name: string;
  run: () => Promise<unknown>;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/** Seed a one-WBS, one-phase, one-line estimate. */
async function seedEstimate(t: TestRunner, proposalNumber: string): Promise<Estimate> {
  const tree = await seedProposal(t, {
    proposalNumber,
    rates: RATES_2020,
    wbs: [
      {
        poolId: 70000,
        name: "AG PIPING",
        phases: [{ phaseNumber: 1, phasePoolId: 70001, activities: [laborActivity(10)] }],
      },
    ],
  });
  return {
    proposalId: tree.proposalId,
    wbsId: must(tree.wbsByCode.get(70000), "wbs 70000"),
    phaseId: must(tree.phaseByNumber.get("70000:1"), "phase 70000:1"),
    activityId: must(tree.activityIds[0], "an activity"),
  };
}

/** Everyone, one of each kind of access, in one organization. */
interface Cast {
  owner: Principal;
  orgAdmin: Principal;
  assigned: Principal;
  viewAll: Principal;
  editAll: Principal;
  /** Production shape: a legacy `write` row, no `access` field. */
  legacyWriter: Principal;
  /** Production shape: a legacy `read` row, no `access` field. */
  legacyReader: Principal;
  /** A plain member holding the legacy app-level Precision `admin`. */
  legacyAdmin: Principal;
  /** A member with no row at all: Precision's default is No access. */
  nobody: Principal;
}

/** Insert a legacy row exactly as production holds them: `permission` only. */
async function legacyRow(
  t: TestRunner,
  memberId: string,
  permission: "none" | "read" | "write" | "admin"
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("appPermissions", { memberId, app: "precision", permission });
  });
}

async function seedCast(t: TestRunner): Promise<Cast> {
  const organizationId = await seedOrganization(t, "acme");
  const member = (email: string) =>
    seedPrincipal(t, { organizationId, role: "member", email: `${email}@acme.test` });

  const owner = await seedPrincipal(t, {
    organizationId,
    role: "owner",
    email: "owner@acme.test",
  });
  const orgAdmin = await seedPrincipal(t, {
    organizationId,
    role: "admin",
    email: "admin@acme.test",
  });
  const cast: Cast = {
    owner,
    orgAdmin,
    assigned: await member("assigned"),
    viewAll: await member("viewall"),
    editAll: await member("editall"),
    legacyWriter: await member("legacywriter"),
    legacyReader: await member("legacyreader"),
    legacyAdmin: await member("legacyadmin"),
    nobody: await member("nobody"),
  };

  for (const [who, access] of [
    [cast.assigned, "assigned"],
    [cast.viewAll, "view_all"],
    [cast.editAll, "edit_all"],
  ] as const) {
    await owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: who.memberId,
      app: "precision",
      access,
    });
  }
  await legacyRow(t, cast.legacyWriter.memberId, "write");
  await legacyRow(t, cast.legacyReader.memberId, "read");
  await legacyRow(t, cast.legacyAdmin.memberId, "admin");

  return cast;
}

/** Add someone to an estimate the way an Owner does from the Share panel. */
async function grant(
  cast: Cast,
  who: Principal,
  estimate: Estimate,
  level: "view" | "edit"
): Promise<void> {
  await cast.owner.as.mutation(api.access.grantItemAccess, {
    proposalId: estimate.proposalId,
    userId: who.userId,
    level,
  });
}

/** A harness with the cast and two estimates, A and B. */
async function setup(): Promise<{ t: TestRunner; cast: Cast; a: Estimate; b: Estimate }> {
  const t = authHarness();
  const cast = await seedCast(t);
  const a = await seedEstimate(t, "1001");
  const b = await seedEstimate(t, "1002");
  return { t, cast, a, b };
}

/** The sentence a refused call carries, unwrapped from a ConvexError. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConvexError) {
      const data: unknown = error.data;
      if (typeof data === "object" && data !== null && "message" in data) {
        if (typeof data.message === "string") return data.message;
      }
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

/**
 * Reads of one estimate, one per kind of key: proposal, WBS, phase, and the
 * proposal-keyed export (the function that hands over every number at once).
 */
function reads(caller: Caller, e: Estimate): NamedCall[] {
  return [
    {
      name: "getProposal",
      run: () => caller.query(api.precision.getProposal, { proposalId: e.proposalId }),
    },
    {
      name: "getWBSListWithCosts",
      run: () => caller.query(api.precision.getWBSListWithCosts, { proposalId: e.proposalId }),
    },
    {
      name: "getExportData",
      run: () => caller.query(api.precision.getExportData, { proposalId: e.proposalId }),
    },
    { name: "getWBS", run: () => caller.query(api.precision.getWBS, { wbsId: e.wbsId }) },
    {
      name: "getPhaseListWithCosts",
      run: () => caller.query(api.precision.getPhaseListWithCosts, { wbsId: e.wbsId }),
    },
    { name: "getPhase", run: () => caller.query(api.precision.getPhase, { phaseId: e.phaseId }) },
    {
      name: "getActivitiesWithCosts",
      run: () => caller.query(api.precision.getActivitiesWithCosts, { phaseId: e.phaseId }),
    },
  ];
}

/**
 * Changes to one estimate, one per kind of key. Each is repeatable, so the
 * same sweep can run for several permitted callers in one test.
 */
function edits(caller: Caller, e: Estimate): NamedCall[] {
  return [
    {
      name: "updateProposal",
      run: () =>
        caller.mutation(api.precision.updateProposal, {
          proposalId: e.proposalId,
          description: `EDITED ${Math.random()}`,
        }),
    },
    {
      name: "setWBSHidden",
      run: () => caller.mutation(api.precision.setWBSHidden, { wbsId: e.wbsId, hidden: false }),
    },
    {
      name: "addActivity",
      run: () =>
        caller.mutation(api.precision.addActivity, {
          phaseId: e.phaseId,
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
        caller.mutation(api.precision.updateActivity, {
          activityId: e.activityId,
          quantity: Math.round(Math.random() * 1000) + 1,
        }),
    },
  ];
}

async function expectAllAllowed(calls: NamedCall[], who: string): Promise<void> {
  for (const { name, run } of calls) {
    try {
      await run();
    } catch (error) {
      const sentence = await refusal(() => Promise.reject(error));
      throw new Error(`${name} refused ${who}: ${sentence}`);
    }
  }
}

async function expectAllRefused(calls: NamedCall[], who: string, sentence: string): Promise<void> {
  for (const { name, run } of calls) {
    expect(await refusal(run), `${name} let ${who} through`).toBe(sentence);
  }
}

/** The estimates a caller's list shows, as `proposalNumber → access`. */
async function listed(caller: Caller): Promise<Record<string, string>> {
  const rows = await caller.query(api.precision.listProposals, {});
  return Object.fromEntries(rows.map((row) => [row.proposalNumber, row.access]));
}

/** Everything a stray write would disturb, to prove a refusal changed nothing. */
async function fingerprint(t: TestRunner, e: Estimate): Promise<string> {
  return t.run(async (ctx) => {
    const proposal = await ctx.db.get(e.proposalId);
    const wbs = await ctx.db.get(e.wbsId);
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", e.proposalId))
      .collect();
    return JSON.stringify({
      description: proposal?.description,
      owned: proposal?.precisionOwnedAt ?? null,
      hidden: wbs?.isHidden ?? null,
      lines: activities.map((a) => [a._id, a.quantity]),
    });
  });
}

// ============================================================================
// ONLY ASSIGNED
// ============================================================================

describe("an Only assigned member", () => {
  it("opens Precision with nothing added yet: an empty list, and the catalog", async () => {
    const { cast } = await setup();

    expect(await listed(cast.assigned.as)).toEqual({});
    await expect(cast.assigned.as.query(api.rateBooks.getDefaultBook, {})).resolves.not.toBeNull();
  });

  it("sees only the estimates they were added to, each badged with its level", async () => {
    const { cast, a, b } = await setup();

    await grant(cast, cast.assigned, a, "view");
    expect(await listed(cast.assigned.as)).toEqual({ "1001": "view" });

    await grant(cast, cast.assigned, b, "edit");
    expect(await listed(cast.assigned.as)).toEqual({ "1001": "view", "1002": "edit" });

    const opened = await cast.assigned.as.query(api.precision.getProposal, {
      proposalId: a.proposalId,
    });
    expect(opened.access).toBe("view");
  });

  it("is refused on an estimate they were not added to, by every kind of key", async () => {
    const { t, cast, a, b } = await setup();
    await grant(cast, cast.assigned, a, "edit");
    const before = await fingerprint(t, b);

    await expectAllRefused(reads(cast.assigned.as, b), "an unassigned reader", ITEM_REFUSED);
    await expectAllRefused(edits(cast.assigned.as, b), "an unassigned editor", ITEM_REFUSED);
    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.deleteProposal, { proposalId: b.proposalId })
      )
    ).toBe(ITEM_REFUSED);
    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.batchDeleteActivities, {
          activityIds: [a.activityId, b.activityId],
        })
      ),
      "a batch reaching into another estimate must change nothing in either"
    ).toBe(ITEM_REFUSED);

    expect(await fingerprint(t, b)).toBe(before);
    // The half of the batch they could edit was not deleted either.
    await expect(
      cast.assigned.as.query(api.precision.getActivitiesWithCosts, { phaseId: a.phaseId })
    ).resolves.toHaveLength(1);
  });

  it("cannot copy lines out of an estimate they were not added to", async () => {
    const { cast, a, b } = await setup();
    await grant(cast, cast.assigned, a, "edit");

    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.copyActivitiesToPhase, {
          sourcePhaseId: b.phaseId,
          targetPhaseId: a.phaseId,
        })
      )
    ).toBe(ITEM_REFUSED);
  });

  it("cannot tell a deleted estimate, WBS, phase or line from one they were not added to", async () => {
    const { t, cast, a } = await setup();
    const gone = await seedEstimate(t, "1003");
    await grant(cast, cast.assigned, a, "edit");
    await cast.owner.as.mutation(api.precision.deleteProposal, { proposalId: gone.proposalId });

    // Every one must be the refusal an existing, ungranted estimate gets. A
    // "not found" here would confirm which ids are real.
    await expectAllRefused(reads(cast.assigned.as, gone), "a deleted-id probe", ITEM_REFUSED);
    await expectAllRefused(edits(cast.assigned.as, gone), "a deleted-id probe", ITEM_REFUSED);
    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.batchDeleteActivities, {
          activityIds: [gone.activityId],
        })
      )
    ).toBe(ITEM_REFUSED);
  });

  it("loses every estimate when switched to No access, and gets them back when lifted", async () => {
    const { cast, a } = await setup();
    await grant(cast, cast.assigned, a, "edit");

    await cast.owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: cast.assigned.memberId,
      app: "precision",
      access: "none",
    });
    expect(await refusal(() => cast.assigned.as.query(api.precision.listProposals, {}))).toBe(
      APP_REFUSED
    );
    await expectAllRefused(reads(cast.assigned.as, a), "a No access member", APP_REFUSED);

    await cast.owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: cast.assigned.memberId,
      app: "precision",
      access: "assigned",
    });
    expect(await listed(cast.assigned.as)).toEqual({ "1001": "edit" });
  });
});

// ============================================================================
// CAN VIEW / CAN EDIT GRANTS
// ============================================================================

describe("a Can view grant", () => {
  it("opens the estimate through every kind of key and changes nothing", async () => {
    const { t, cast, a } = await setup();
    await grant(cast, cast.assigned, a, "view");
    const before = await fingerprint(t, a);

    await expectAllAllowed(reads(cast.assigned.as, a), "a Can view member");
    await expectAllRefused(edits(cast.assigned.as, a), "a Can view member", VIEW_ONLY);
    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.deleteProposal, { proposalId: a.proposalId })
      )
    ).toBe(VIEW_ONLY);

    // A refused write must not detach the estimate from the mirror (D1).
    expect(await fingerprint(t, a)).toBe(before);
  });

  it("may copy lines out, into an estimate they can edit", async () => {
    const { cast, a, b } = await setup();
    await grant(cast, cast.assigned, a, "view");
    await grant(cast, cast.assigned, b, "edit");

    const copied = await cast.assigned.as.mutation(api.precision.copyActivitiesToPhase, {
      sourcePhaseId: a.phaseId,
      targetPhaseId: b.phaseId,
    });
    expect(copied).toHaveLength(1);

    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.copyActivitiesToPhase, {
          sourcePhaseId: b.phaseId,
          targetPhaseId: a.phaseId,
        })
      ),
      "the target is the estimate being written, so it needs edit"
    ).toBe(VIEW_ONLY);
  });
});

describe("a Can edit grant", () => {
  it("reads and changes the estimate through every kind of key", async () => {
    const { cast, a } = await setup();
    await grant(cast, cast.assigned, a, "edit");

    await expectAllAllowed(reads(cast.assigned.as, a), "a Can edit member");
    await expectAllAllowed(edits(cast.assigned.as, a), "a Can edit member");
  });

  it("may delete the estimate, and the grants on it go with it", async () => {
    const { t, cast, a } = await setup();
    await grant(cast, cast.assigned, a, "edit");
    await grant(cast, cast.viewAll, a, "view");

    await cast.assigned.as.mutation(api.precision.deleteProposal, { proposalId: a.proposalId });

    const leftover = await t.run(async (ctx) =>
      ctx.db
        .query("accessGrants")
        .withIndex("by_proposal_user", (q) => q.eq("proposalId", a.proposalId))
        .collect()
    );
    expect(leftover).toHaveLength(0);
    expect(await listed(cast.assigned.as)).toEqual({});
  });
});

// ============================================================================
// APP-WIDE SETTINGS
// ============================================================================

describe("Can view all", () => {
  it("lists and opens every estimate, and changes none", async () => {
    const { t, cast, a, b } = await setup();
    const before = [await fingerprint(t, a), await fingerprint(t, b)];

    expect(await listed(cast.viewAll.as)).toEqual({ "1001": "view", "1002": "view" });
    for (const e of [a, b]) {
      await expectAllAllowed(reads(cast.viewAll.as, e), "a Can view all member");
      await expectAllRefused(edits(cast.viewAll.as, e), "a Can view all member", VIEW_ONLY);
    }
    expect([await fingerprint(t, a), await fingerprint(t, b)]).toEqual(before);
  });

  it("cannot start an estimate, from scratch or as a revision", async () => {
    const { cast, a } = await setup();

    expect(
      await refusal(() =>
        cast.viewAll.as.mutation(api.precision.createProposal, {
          proposalNumber: "9001",
          description: "NEW",
          ownerName: "InDemand",
          rates: { ...RATES_2020 },
          datasetVersion: "v1",
        })
      )
    ).toBe(START_REFUSED);
    expect(
      await refusal(() =>
        cast.viewAll.as.mutation(api.precision.duplicateProposal, {
          sourceProposalId: a.proposalId,
          newProposalNumber: "1001.01",
        })
      )
    ).toBe(START_REFUSED);
  });

  it("is raised to edit on one estimate by a Can edit grant — highest wins", async () => {
    const { cast, a, b } = await setup();
    await grant(cast, cast.viewAll, a, "edit");

    expect(await listed(cast.viewAll.as)).toEqual({ "1001": "edit", "1002": "view" });
    await expectAllAllowed(edits(cast.viewAll.as, a), "a Can view all member raised to edit");
    await expectAllRefused(edits(cast.viewAll.as, b), "a Can view all member", VIEW_ONLY);
  });
});

describe("Can edit all", () => {
  it("lists and changes every estimate", async () => {
    const { cast, a, b } = await setup();

    expect(await listed(cast.editAll.as)).toEqual({ "1001": "edit", "1002": "edit" });
    for (const e of [a, b]) {
      await expectAllAllowed(reads(cast.editAll.as, e), "a Can edit all member");
      await expectAllAllowed(edits(cast.editAll.as, e), "a Can edit all member");
    }
  });
});

// ============================================================================
// STARTING AN ESTIMATE
// ============================================================================

describe("starting an estimate", () => {
  it("stamps the creator and gives an Only assigned creator Can edit on it", async () => {
    const { t, cast } = await setup();

    const proposalId = await cast.assigned.as.mutation(api.precision.createProposal, {
      proposalNumber: "9001",
      description: "STARTED BY AN ASSIGNED ESTIMATOR",
      ownerName: "InDemand",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });

    const stored = await t.run(async (ctx) => ctx.db.get(proposalId));
    expect(stored?.createdBy).toBe(cast.assigned.userId);
    expect(await listed(cast.assigned.as)).toEqual({ "9001": "edit" });
    await cast.assigned.as.mutation(api.precision.updateProposal, {
      proposalId,
      description: "AND THEY CAN KEEP WORKING ON IT",
    });
  });

  it("lets an Only assigned estimator re-bid an estimate they may only view", async () => {
    const { cast, a, b } = await setup();
    await grant(cast, cast.assigned, a, "view");

    const revisionId = await cast.assigned.as.mutation(api.precision.duplicateProposal, {
      sourceProposalId: a.proposalId,
      newProposalNumber: "1001.01",
    });

    expect(await listed(cast.assigned.as)).toEqual({ "1001": "view", "1001.01": "edit" });
    const revision = await cast.assigned.as.query(api.precision.getProposal, {
      proposalId: revisionId,
    });
    expect(revision.createdBy).toBe(cast.assigned.userId);
    expect(revision.wbsCount).toBe(1);

    expect(
      await refusal(() =>
        cast.assigned.as.mutation(api.precision.duplicateProposal, {
          sourceProposalId: b.proposalId,
          newProposalNumber: "1002.01",
        })
      ),
      "a revision still needs view on its source"
    ).toBe(ITEM_REFUSED);
  });

  it("writes no grant for a creator who already edits everything", async () => {
    const { t, cast } = await setup();

    const proposalId = await cast.editAll.as.mutation(api.precision.createProposal, {
      proposalNumber: "9002",
      description: "STARTED BY AN EDIT-ALL ESTIMATOR",
      ownerName: "InDemand",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });

    const stored = await t.run(async (ctx) => ({
      proposal: await ctx.db.get(proposalId),
      grants: await ctx.db
        .query("accessGrants")
        .withIndex("by_proposal_user", (q) => q.eq("proposalId", proposalId))
        .collect(),
    }));
    expect(stored.proposal?.createdBy).toBe(cast.editAll.userId);
    expect(stored.grants).toHaveLength(0);
  });
});

// ============================================================================
// LEGACY ROWS — deploying this changes nobody's access
// ============================================================================

describe("a legacy appPermissions row with no access field", () => {
  it("`write` still edits every estimate, and starts new ones", async () => {
    const { cast, a, b } = await setup();

    expect(await listed(cast.legacyWriter.as)).toEqual({ "1001": "edit", "1002": "edit" });
    for (const e of [a, b]) {
      await expectAllAllowed(reads(cast.legacyWriter.as, e), "a legacy writer");
      await expectAllAllowed(edits(cast.legacyWriter.as, e), "a legacy writer");
    }
    await cast.legacyWriter.as.mutation(api.precision.createProposal, {
      proposalNumber: "9003",
      description: "STARTED BY A LEGACY WRITER",
      ownerName: "InDemand",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
    });
  });

  it("`read` still views every estimate and changes none", async () => {
    const { cast, a, b } = await setup();

    expect(await listed(cast.legacyReader.as)).toEqual({ "1001": "view", "1002": "view" });
    for (const e of [a, b]) {
      await expectAllAllowed(reads(cast.legacyReader.as, e), "a legacy reader");
      await expectAllRefused(edits(cast.legacyReader.as, e), "a legacy reader", VIEW_ONLY);
    }
  });

  it("no row at all is still the access wall", async () => {
    const { cast, a } = await setup();

    expect(await refusal(() => cast.nobody.as.query(api.precision.listProposals, {}))).toBe(
      APP_REFUSED
    );
    await expectAllRefused(reads(cast.nobody.as, a), "a member with no row", APP_REFUSED);
    await expectAllRefused(edits(cast.nobody.as, a), "a member with no row", APP_REFUSED);
  });
});

// ============================================================================
// OWNER, ADMIN, AND THE RATE BOOKS
// ============================================================================

describe("an Owner or Admin", () => {
  it("has full access to every estimate, with no row and no grant", async () => {
    const { cast, a, b } = await setup();

    for (const who of [cast.owner, cast.orgAdmin]) {
      expect(await listed(who.as)).toEqual({ "1001": "full", "1002": "full" });
      for (const e of [a, b]) {
        await expectAllAllowed(reads(who.as, e), "an Owner or Admin");
        await expectAllAllowed(edits(who.as, e), "an Owner or Admin");
      }
      const opened = await who.as.query(api.precision.getProposal, { proposalId: a.proposalId });
      expect(opened.access).toBe("full");
    }
  });

  it("still sees 'not found' for a missing id — they could list it anyway", async () => {
    const { t, cast } = await setup();
    const gone = await seedEstimate(t, "1003");
    await cast.owner.as.mutation(api.precision.deleteProposal, { proposalId: gone.proposalId });

    expect(
      await refusal(() => cast.orgAdmin.as.query(api.precision.getPhase, { phaseId: gone.phaseId }))
    ).toBe("Phase not found");
  });
});

describe("the rate books", () => {
  it("are an Owner and Admin surface only", async () => {
    const { cast } = await setup();

    await expect(cast.owner.as.query(api.rateBooks.listRateBooks, {})).resolves.toHaveLength(1);
    await expect(cast.orgAdmin.as.query(api.rateBooks.listRateBooks, {})).resolves.toHaveLength(1);
    for (const who of [cast.editAll, cast.assigned]) {
      expect(await refusal(() => who.as.query(api.rateBooks.listRateBooks, {}))).toBe(
        ORG_ADMIN_REFUSED
      );
    }
  });

  it("are no longer managed by a plain member holding the legacy Precision admin", async () => {
    const { cast, a } = await setup();

    // Legacy `admin` on a member reads as Can edit all: every estimate stays
    // theirs to work on (docs/ACCESS.md, Migration)...
    await expectAllAllowed(edits(cast.legacyAdmin.as, a), "a legacy Precision admin");
    // ...but the books belong to the Admin role now.
    expect(await refusal(() => cast.legacyAdmin.as.query(api.rateBooks.listRateBooks, {}))).toBe(
      ORG_ADMIN_REFUSED
    );
  });

  it("publish a catalog any Precision member may browse; a draft stays with admins", async () => {
    const { t, cast } = await setup();
    const { published, draft } = await t.run(async (ctx) => {
      const book = await ctx.db
        .query("rateBooks")
        .withIndex("by_default", (q) => q.eq("isDefault", true))
        .first();
      const draftId = await ctx.db.insert("rateBooks", {
        bookNumber: 2,
        name: "Next Year",
        status: "draft",
        isDefault: false,
        createdBy: "fixture",
        createdAt: 0,
        buildState: "ready",
        proposalCount: 0,
      });
      return { published: book?._id ?? null, draft: draftId };
    });
    const bookId = must(published ?? undefined, "the default book");
    const page = { cursor: null, numItems: 10 };

    // An assigned member with no estimates at all still reads the catalog.
    await expect(
      cast.assigned.as.query(api.catalog.listCatalogRows, {
        bookId,
        pool: "wbs",
        paginationOpts: page,
      })
    ).resolves.toBeDefined();
    expect(
      await refusal(() =>
        cast.assigned.as.query(api.catalog.listCatalogRows, {
          bookId: draft,
          pool: "wbs",
          paginationOpts: page,
        })
      )
    ).toBe(ORG_ADMIN_REFUSED);
    expect(
      await refusal(() =>
        cast.nobody.as.query(api.catalog.listCatalogRows, {
          bookId,
          pool: "wbs",
          paginationOpts: page,
        })
      )
    ).toBe(APP_REFUSED);
  });

  it("serve the pools an estimate is built from, but never a draft's to a non-admin", async () => {
    const { t, cast } = await setup();
    const { published, draft, archived } = await t.run(async (ctx) => {
      const book = {
        isDefault: false,
        createdBy: "fixture",
        createdAt: 0,
        buildState: "ready" as const,
        proposalCount: 0,
      };
      const current = await ctx.db
        .query("rateBooks")
        .withIndex("by_default", (q) => q.eq("isDefault", true))
        .first();
      return {
        published: current?._id,
        draft: await ctx.db.insert("rateBooks", {
          ...book,
          bookNumber: 2,
          name: "Next Year",
          status: "draft",
        }),
        archived: await ctx.db.insert("rateBooks", {
          ...book,
          bookNumber: 3,
          name: "Last Year",
          status: "archived",
        }),
      };
    });
    const pools = (bookId: typeof draft) => [
      () => cast.editAll.as.query(api.precision.getWBSPool, { bookId }),
      () => cast.editAll.as.query(api.precision.getPhasePool, { bookId, wbsPoolId: 1 }),
      () => cast.editAll.as.query(api.precision.getLaborPool, { bookId, phasePoolId: 1 }),
      () => cast.editAll.as.query(api.precision.getEquipmentPool, { bookId }),
      () => cast.editAll.as.query(api.precision.getPhaseTakeoffCatalog, { bookId, phasePoolId: 1 }),
    ];

    // The book an estimate was priced with, and a retired one it may be pinned to.
    for (const read of [...pools(must(published, "the default book")), ...pools(archived)]) {
      await expect(read()).resolves.toBeDefined();
    }
    // Unpublished pricing is the admins' alone, whichever pool it is read through.
    for (const read of pools(draft)) {
      expect(await refusal(read)).toBe(ORG_ADMIN_REFUSED);
    }
    await expect(cast.owner.as.query(api.precision.getWBSPool, { bookId: draft })).resolves.toEqual(
      []
    );
  });
});
