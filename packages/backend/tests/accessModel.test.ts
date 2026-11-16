/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Access: one role, one app setting per app, and people added to items
 * (docs/ACCESS.md).
 *
 * Two halves. The pure rules in `model/access.ts` are tested as tables, every
 * value against every value, because they are small enough to be exhaustive.
 * The resolver in `model/accessResolve.ts` and the public surface in
 * `access.ts` run against the real Better Auth component, so a refusal below
 * means the rule refused, not that nobody was signed in.
 *
 * THE AXIS THAT MATTERS MOST IS THE MIGRATION: deploying this must change
 * nobody's access. The last block builds production's shape (an owner, an
 * admin holding legacy app-level admin rows, three Precision-write members
 * with no assignments, two Precision-read members with project-scope
 * assignments) and checks every person's level on every item is identical
 * before the migration, after it, after a second run, and after the legacy
 * assignments are gone.
 */

import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  appAccessFromLegacyWrite,
  highestLevel,
  itemLevelFor,
  legacyAssignmentLevel,
  legacyLevelFor,
  legacyToAppAccess,
  liftedAppAccess,
  mayOpenApp,
  mayStartEstimate,
  meetsItemLevel,
  type AppAccess,
  type EffectiveAppAccess,
  type LegacyPermission,
} from "../convex/model/access";
import {
  APP_REFUSAL,
  ITEM_REFUSAL,
  ORG_ADMIN_REFUSAL,
  START_ESTIMATE_REFUSAL,
  SUSPENDED_REFUSAL,
  VIEW_ONLY_REFUSAL,
  appAccessFor,
  itemLevelOf,
  legacyPermissionsFor,
  membershipsOf,
  requireItem,
  requireProjectList,
  requireProposalList,
  requireStartEstimate,
  subjectForMember,
  type ItemRef,
} from "../convex/model/accessResolve";
import { authHarness, seedOrganization, seedPrincipal, type Principal } from "./authFixtures";
import { seedProposal, type TestRunner } from "./convexFixtures";

// ============================================================================
// HELPERS
// ============================================================================

/** Run a call that must be refused, and return the sentence the caller sees. */
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

/** Insert a production-shaped legacy row: `permission` only, no `access`. */
async function legacyRow(
  t: TestRunner,
  memberId: string,
  app: "precision" | "momentum",
  permission: LegacyPermission
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("appPermissions", { memberId, app, permission });
  });
}

/** Insert a legacy Momentum assignment, as the old Team screen wrote them. */
async function legacyAssignment(
  t: TestRunner,
  projectId: Id<"momentumProjects">,
  userId: string,
  scopeType: "project" | "wbs" | "phase",
  role: "superintendent" | "supervisor" | "foreman" | "viewer"
): Promise<Id<"projectAssignments">> {
  return t.run(async (ctx) =>
    ctx.db.insert("projectAssignments", {
      projectId,
      userId,
      scopeType,
      ...(scopeType === "project" ? {} : { scopeId: "legacy-scope" }),
      role,
      assignedAt: 1_700_000_000_000,
    })
  );
}

/** A Momentum project on a seeded proposal. */
async function seedProject(
  t: TestRunner,
  proposalId: Id<"proposals">,
  name: string
): Promise<Id<"momentumProjects">> {
  return t.run(async (ctx) =>
    ctx.db.insert("momentumProjects", {
      proposalId,
      name,
      proposalNumber: name,
      ownerName: "Test Owner",
      status: "active" as const,
    })
  );
}

/** The stored `access` on one member's row, bypassing every guard. */
async function storedAccess(
  t: TestRunner,
  memberId: string,
  app: "precision" | "momentum"
): Promise<AppAccess | null> {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("appPermissions")
      .withIndex("by_member_app", (q) => q.eq("memberId", memberId).eq("app", app))
      .first();
    return row?.access ?? null;
  });
}

/** One person's level on one item, resolved as an admin screen would. */
async function levelFor(t: TestRunner, person: Principal, item: ItemRef) {
  return t.run(async (ctx) => {
    const [member] = await membershipsOf(ctx, person.userId);
    if (!member) throw new Error("fixture: no membership");
    return itemLevelOf(ctx, subjectForMember(member), item);
  });
}

/**
 * What a principal's estimate list shows. Unpacked inside the run because a
 * `ListScope` holds Maps and a function, which `t.run` cannot hand back.
 */
async function proposalList(person: Principal, ids: Array<Id<"proposals">>) {
  return person.as.run(async (ctx) => {
    const scope = await requireProposalList(ctx);
    return {
      seesAll: scope.seesAll,
      granted: [...scope.granted.keys()],
      levels: ids.map((id) => scope.levelOf(id)),
    };
  });
}

/** What a principal's project list shows; see {@link proposalList}. */
async function projectList(person: Principal, ids: Array<Id<"momentumProjects">>) {
  return person.as.run(async (ctx) => {
    const scope = await requireProjectList(ctx);
    return {
      seesAll: scope.seesAll,
      granted: [...scope.granted.keys()],
      levels: ids.map((id) => scope.levelOf(id)),
    };
  });
}

/** Ban a principal straight through the adapter, as `banMember` does. */
async function ban(t: TestRunner, userId: string): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: { model: "user", where: [{ field: "_id", value: userId }], update: { banned: true } },
    });
  });
}

/** An organization with an owner, an admin and two plain members, plus items. */
async function seedWorld() {
  const t = authHarness();
  const organizationId = await seedOrganization(t, "indemand");
  const owner = await seedPrincipal(t, { organizationId, role: "owner", email: "own@x.test" });
  const admin = await seedPrincipal(t, { organizationId, role: "admin", email: "adm@x.test" });
  const alice = await seedPrincipal(t, { organizationId, role: "member", email: "al@x.test" });
  const bob = await seedPrincipal(t, { organizationId, role: "member", email: "bo@x.test" });

  const estimateA = await seedProposal(t, { proposalNumber: "2101", description: "Tank 8" });
  const estimateB = await seedProposal(t, { proposalNumber: "2102", description: "Pipe rack" });
  const projectA = await seedProject(t, estimateA.proposalId, "2101 Tank 8");
  const projectB = await seedProject(t, estimateB.proposalId, "2102 Pipe rack");

  return {
    t,
    organizationId,
    owner,
    admin,
    alice,
    bob,
    estimateA: { proposalId: estimateA.proposalId },
    estimateB: { proposalId: estimateB.proposalId },
    projectA: { projectId: projectA },
    projectB: { projectId: projectB },
  };
}

// ============================================================================
// THE RULES (PURE)
// ============================================================================

describe("legacy permission → app access (Migration section)", () => {
  it("maps every Precision value, and no row, as the spec says", () => {
    expect(legacyToAppAccess("precision", undefined)).toBe("none");
    expect(legacyToAppAccess("precision", "none")).toBe("none");
    expect(legacyToAppAccess("precision", "read")).toBe("view_all");
    expect(legacyToAppAccess("precision", "write")).toBe("edit_all");
    expect(legacyToAppAccess("precision", "admin")).toBe("edit_all");
  });

  it("maps every Momentum value, and no row, to assigned", () => {
    for (const legacy of [undefined, "none", "read", "write", "admin"] as const) {
      expect(legacyToAppAccess("momentum", legacy)).toBe("assigned");
    }
  });

  it("maps legacy writes, and refuses admin", () => {
    expect(appAccessFromLegacyWrite("precision", "none")).toBe("none");
    expect(appAccessFromLegacyWrite("precision", "read")).toBe("view_all");
    expect(appAccessFromLegacyWrite("precision", "write")).toBe("edit_all");
    expect(appAccessFromLegacyWrite("precision", "admin")).toBeNull();
    for (const legacy of ["none", "read", "write"] as const) {
      expect(appAccessFromLegacyWrite("momentum", legacy)).toBe("assigned");
    }
    expect(appAccessFromLegacyWrite("momentum", "admin")).toBeNull();
  });

  it("counts only project-scope legacy assignments, viewer as view", () => {
    expect(legacyAssignmentLevel("project", "viewer")).toBe("view");
    for (const role of ["foreman", "supervisor", "superintendent"] as const) {
      expect(legacyAssignmentLevel("project", role)).toBe("edit");
      expect(legacyAssignmentLevel("wbs", role)).toBeUndefined();
      expect(legacyAssignmentLevel("phase", role)).toBeUndefined();
    }
    expect(legacyAssignmentLevel("wbs", "viewer")).toBeUndefined();
  });
});

describe("resolving one person on one item", () => {
  it("highest wins", () => {
    expect(highestLevel("view", "edit")).toBe("edit");
    expect(highestLevel("edit", "view")).toBe("edit");
    expect(highestLevel("full", "edit")).toBe("full");
    expect(highestLevel(undefined, "view")).toBe("view");
    expect(highestLevel("view", undefined)).toBe("view");
    expect(highestLevel(undefined, undefined)).toBeUndefined();
  });

  it("matches the spec's table for every app access and every grant", () => {
    const grants = [undefined, "view", "edit"] as const;
    const expected: Record<EffectiveAppAccess, Array<string | null>> = {
      full: ["full", "full", "full"],
      none: [null, null, null],
      assigned: [null, "view", "edit"],
      view_all: ["view", "view", "edit"],
      edit_all: ["edit", "edit", "edit"],
    };
    for (const [appAccess, levels] of Object.entries(expected)) {
      expect(grants.map((grant) => itemLevelFor(appAccess as EffectiveAppAccess, grant))).toEqual(
        levels
      );
    }
  });

  it("none ignores grants, so switching an app off switches it off", () => {
    expect(itemLevelFor("none", "edit")).toBeNull();
  });

  it("checks a level against what is required", () => {
    expect(meetsItemLevel("full", "edit")).toBe(true);
    expect(meetsItemLevel("edit", "edit")).toBe(true);
    expect(meetsItemLevel("edit", "view")).toBe(true);
    expect(meetsItemLevel("view", "edit")).toBe(false);
    expect(meetsItemLevel(null, "view")).toBe(false);
  });
});

describe("what each app access allows", () => {
  it("only none is walled out", () => {
    expect(mayOpenApp("none")).toBe(false);
    for (const access of ["assigned", "view_all", "edit_all", "full"] as const) {
      expect(mayOpenApp(access)).toBe(true);
    }
  });

  it("full, edit_all and assigned may start an estimate; view_all and none may not", () => {
    expect(mayStartEstimate("full")).toBe(true);
    expect(mayStartEstimate("edit_all")).toBe(true);
    expect(mayStartEstimate("assigned")).toBe(true);
    expect(mayStartEstimate("view_all")).toBe(false);
    expect(mayStartEstimate("none")).toBe(false);
  });

  it("adding someone lifts none to assigned and leaves anything higher", () => {
    expect(liftedAppAccess("none")).toBe("assigned");
    expect(liftedAppAccess("assigned")).toBe("assigned");
    expect(liftedAppAccess("view_all")).toBe("view_all");
    expect(liftedAppAccess("edit_all")).toBe("edit_all");
  });

  it("derives the legacy level installed apps are told", () => {
    expect(legacyLevelFor("full", undefined)).toBe("admin");
    expect(legacyLevelFor("edit_all", undefined)).toBe("write");
    expect(legacyLevelFor("view_all", "edit")).toBe("read");
    expect(legacyLevelFor("assigned", "edit")).toBe("write");
    expect(legacyLevelFor("assigned", "view")).toBe("read");
    expect(legacyLevelFor("assigned", undefined)).toBe("none");
    expect(legacyLevelFor("none", "edit")).toBe("none");
  });
});

// ============================================================================
// THE RESOLVER
// ============================================================================

describe("owners and admins have full access with no rows at all", () => {
  it("full on both apps, every estimate and every project", async () => {
    const w = await seedWorld();
    for (const person of [w.owner, w.admin]) {
      for (const item of [w.estimateA, w.projectA]) {
        const access = await person.as.run((ctx) => requireItem(ctx, item, "edit"));
        expect(access.level).toBe("full");
      }
      expect((await proposalList(person, [])).seesAll).toBe(true);
    }

    await expect(w.owner.as.query(api.access.getMyAccess, {})).resolves.toEqual({
      role: "owner",
      precision: "full",
      momentum: "full",
      suspended: false,
    });
    await expect(w.admin.as.query(api.access.getMyAccess, {})).resolves.toEqual({
      role: "admin",
      precision: "full",
      momentum: "full",
      suspended: false,
    });
  });

  it("getMyAccess is null when signed out, not an error", async () => {
    const w = await seedWorld();
    await expect(w.t.query(api.access.getMyAccess, {})).resolves.toBeNull();
  });
});

describe("legacy rows with no access field resolve per the spec", () => {
  it("a member with no rows: Precision walled, Momentum only assigned", async () => {
    const w = await seedWorld();

    await expect(w.alice.as.query(api.access.getMyAccess, {})).resolves.toEqual({
      role: "member",
      precision: "none",
      momentum: "assigned",
      suspended: false,
    });
    expect(
      await refusal(() => w.alice.as.run((ctx) => requireItem(ctx, w.estimateA, "view")))
    ).toBe(APP_REFUSAL.precision);
    expect(await refusal(() => w.alice.as.run((ctx) => requireItem(ctx, w.projectA, "view")))).toBe(
      ITEM_REFUSAL.momentum
    );
    expect(await projectList(w.alice, [w.projectA.projectId])).toEqual({
      seesAll: false,
      granted: [],
      levels: [null],
    });
  });

  it("Precision write + Momentum read, no assignments: edits every estimate, sees no project", async () => {
    const w = await seedWorld();
    await legacyRow(w.t, w.alice.memberId, "precision", "write");
    await legacyRow(w.t, w.alice.memberId, "momentum", "read");

    const estimate = await w.alice.as.run((ctx) => requireItem(ctx, w.estimateB, "edit"));
    expect(estimate.level).toBe("edit");
    await expect(w.alice.as.run((ctx) => requireStartEstimate(ctx))).resolves.toBeTruthy();
    expect(await refusal(() => w.alice.as.run((ctx) => requireItem(ctx, w.projectA, "view")))).toBe(
      ITEM_REFUSAL.momentum
    );
  });

  it("Precision read + Momentum write + project assignments: views estimates, works their projects", async () => {
    const w = await seedWorld();
    await legacyRow(w.t, w.bob.memberId, "precision", "read");
    await legacyRow(w.t, w.bob.memberId, "momentum", "write");
    await legacyAssignment(w.t, w.projectA.projectId, w.bob.userId, "project", "superintendent");
    await legacyAssignment(w.t, w.projectB.projectId, w.bob.userId, "project", "viewer");

    expect((await w.bob.as.run((ctx) => requireItem(ctx, w.estimateA, "view"))).level).toBe("view");
    expect(await refusal(() => w.bob.as.run((ctx) => requireItem(ctx, w.estimateA, "edit")))).toBe(
      VIEW_ONLY_REFUSAL.precision
    );
    expect(await refusal(() => w.bob.as.run((ctx) => requireStartEstimate(ctx)))).toBe(
      START_ESTIMATE_REFUSAL
    );
    expect((await w.bob.as.run((ctx) => requireItem(ctx, w.projectA, "edit"))).level).toBe("edit");
    expect(await refusal(() => w.bob.as.run((ctx) => requireItem(ctx, w.projectB, "edit")))).toBe(
      VIEW_ONLY_REFUSAL.momentum
    );

    const projects = await projectList(w.bob, [w.projectA.projectId, w.projectB.projectId]);
    expect(projects.seesAll).toBe(false);
    expect(projects.levels).toEqual(["edit", "view"]);
  });

  it("WBS- and phase-scoped legacy rows grant nothing", async () => {
    const w = await seedWorld();
    await legacyAssignment(w.t, w.projectA.projectId, w.alice.userId, "wbs", "superintendent");
    await legacyAssignment(w.t, w.projectA.projectId, w.alice.userId, "phase", "foreman");

    expect(await levelFor(w.t, w.alice, w.projectA)).toBeNull();
  });

  it("legacy app-level admin on a member is edit_all, not admin", async () => {
    const w = await seedWorld();
    await legacyRow(w.t, w.alice.memberId, "precision", "admin");
    await legacyRow(w.t, w.alice.memberId, "momentum", "admin");

    await expect(w.alice.as.query(api.access.getMyAccess, {})).resolves.toMatchObject({
      precision: "edit_all",
      momentum: "assigned",
    });
    expect(await refusal(() => w.alice.as.query(api.access.listItemAccess, w.estimateA))).toBe(
      ORG_ADMIN_REFUSAL
    );
  });
});

describe("grants", () => {
  it("raise a Can view all member to edit on one estimate", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.alice.memberId,
      app: "precision",
      access: "view_all",
    });
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateA,
      userId: w.alice.userId,
      level: "edit",
    });

    expect(await levelFor(w.t, w.alice, w.estimateA)).toBe("edit");
    expect(await levelFor(w.t, w.alice, w.estimateB)).toBe("view");
    const list = await proposalList(w.alice, [w.estimateA.proposalId, w.estimateB.proposalId]);
    expect(list.seesAll).toBe(true);
    expect(list.levels).toEqual(["edit", "view"]);
  });

  it("lift No access to Only assigned, so adding someone is one step", async () => {
    const w = await seedWorld();
    expect(await storedAccess(w.t, w.alice.memberId, "precision")).toBeNull();

    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateA,
      userId: w.alice.userId,
      level: "view",
    });

    expect(await storedAccess(w.t, w.alice.memberId, "precision")).toBe("assigned");
    expect((await w.alice.as.run((ctx) => requireItem(ctx, w.estimateA, "view"))).level).toBe(
      "view"
    );
    expect(
      await refusal(() => w.alice.as.run((ctx) => requireItem(ctx, w.estimateB, "view")))
    ).toBe(ITEM_REFUSAL.precision);
    const list = await proposalList(w.alice, [w.estimateA.proposalId, w.estimateB.proposalId]);
    expect(list).toEqual({
      seesAll: false,
      granted: [w.estimateA.proposalId],
      levels: ["view", null],
    });
  });

  it("lift only when someone is added: changing a level leaves No access off", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateA,
      userId: w.alice.userId,
      level: "view",
    });
    await w.admin.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.alice.memberId,
      app: "precision",
      access: "none",
    });

    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateA,
      userId: w.alice.userId,
      level: "edit",
    });

    expect(await storedAccess(w.t, w.alice.memberId, "precision")).toBe("none");
  });

  it("are ignored while app access is switched to none", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateA,
      userId: w.alice.userId,
      level: "edit",
    });
    await w.admin.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.alice.memberId,
      app: "precision",
      access: "none",
    });

    expect(await levelFor(w.t, w.alice, w.estimateA)).toBeNull();
    expect(
      await refusal(() => w.alice.as.run((ctx) => requireItem(ctx, w.estimateA, "view")))
    ).toBe(APP_REFUSAL.precision);
  });

  it("changing a level moves legacy project rows with it, so Can view really is view", async () => {
    const w = await seedWorld();
    const row = await legacyAssignment(
      w.t,
      w.projectA.projectId,
      w.alice.userId,
      "project",
      "foreman"
    );
    expect(await levelFor(w.t, w.alice, w.projectA)).toBe("edit");

    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.projectA,
      userId: w.alice.userId,
      level: "view",
    });

    expect(await levelFor(w.t, w.alice, w.projectA)).toBe("view");
    const legacy = await w.t.run(async (ctx) => ctx.db.get(row));
    expect(legacy?.role).toBe("viewer");
  });

  it("revoking removes the grant and the legacy project-scope rows, not WBS rows", async () => {
    const w = await seedWorld();
    await legacyAssignment(w.t, w.projectA.projectId, w.alice.userId, "project", "superintendent");
    const wbsRow = await legacyAssignment(
      w.t,
      w.projectA.projectId,
      w.alice.userId,
      "wbs",
      "foreman"
    );
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.projectA,
      userId: w.alice.userId,
      level: "edit",
    });

    await w.admin.as.mutation(api.access.revokeItemAccess, {
      ...w.projectA,
      userId: w.alice.userId,
    });

    expect(await levelFor(w.t, w.alice, w.projectA)).toBeNull();
    const remaining = await w.t.run(async (ctx) =>
      ctx.db
        .query("projectAssignments")
        .withIndex("by_user", (q) => q.eq("userId", w.alice.userId))
        .collect()
    );
    expect(remaining.map((r) => r._id)).toEqual([wbsRow]);
  });

  it("only an owner or admin may grant or revoke, and only to active members", async () => {
    const w = await seedWorld();
    await legacyRow(w.t, w.alice.memberId, "precision", "write");

    expect(
      await refusal(() =>
        w.alice.as.mutation(api.access.grantItemAccess, {
          ...w.estimateA,
          userId: w.bob.userId,
          level: "edit",
        })
      )
    ).toBe(ORG_ADMIN_REFUSAL);
    expect(
      await refusal(() =>
        w.alice.as.mutation(api.access.revokeItemAccess, { ...w.estimateA, userId: w.bob.userId })
      )
    ).toBe(ORG_ADMIN_REFUSAL);
    expect(
      await refusal(() =>
        w.owner.as.mutation(api.access.grantItemAccess, {
          ...w.estimateA,
          userId: w.admin.userId,
          level: "view",
        })
      )
    ).toBe("Admins have full access.");

    const outsiderOrg = await seedOrganization(w.t, "elsewhere");
    const outsider = await seedPrincipal(w.t, {
      organizationId: outsiderOrg,
      role: "member",
      email: "out@y.test",
    });
    expect(
      await refusal(() =>
        w.owner.as.mutation(api.access.grantItemAccess, {
          ...w.estimateA,
          userId: outsider.userId,
          level: "view",
        })
      )
    ).toBe("They are not a member of this organization.");

    await ban(w.t, w.bob.userId);
    expect(
      await refusal(() =>
        w.owner.as.mutation(api.access.grantItemAccess, {
          ...w.estimateA,
          userId: w.bob.userId,
          level: "view",
        })
      )
    ).toBe("Their account is suspended. Restore it before adding them.");
  });

  it("refuse an item given by neither or both ids", async () => {
    const w = await seedWorld();
    await expect(
      w.owner.as.mutation(api.access.grantItemAccess, { userId: w.alice.userId, level: "view" })
    ).rejects.toThrow(/exactly one/);
    await expect(
      w.owner.as.query(api.access.listItemAccess, { ...w.estimateA, ...w.projectA })
    ).rejects.toThrow(/exactly one/);
  });
});

describe("banned users are refused everywhere", () => {
  it("even an admin, on every surface", async () => {
    const w = await seedWorld();
    await ban(w.t, w.admin.userId);

    expect(
      await refusal(() => w.admin.as.run((ctx) => requireItem(ctx, w.estimateA, "view")))
    ).toBe(SUSPENDED_REFUSAL);
    expect(await refusal(() => w.admin.as.query(api.access.listItemAccess, w.projectA))).toBe(
      SUSPENDED_REFUSAL
    );
    expect(
      await refusal(() =>
        w.admin.as.query(api.adminUsers.listOrganizationMembers, {
          organizationId: w.organizationId,
        })
      )
    ).toBe(SUSPENDED_REFUSAL);
    // Installed apps run this above every route with no error screen, so it
    // answers No access instead of refusing: a refusal there replaced the
    // whole app, sign-out included. The same answer for anyone they ask about.
    for (const memberId of [w.admin.memberId, w.alice.memberId]) {
      await expect(
        w.admin.as.query(api.appPermissions.getMemberPermissions, { memberId })
      ).resolves.toEqual({ precision: "none", momentum: "none" });
    }
    // Suspended, said as such, so the walls give the right advice.
    await expect(w.admin.as.query(api.access.getMyAccess, {})).resolves.toEqual({
      role: null,
      precision: "none",
      momentum: "none",
      suspended: true,
    });
  });
});

// ============================================================================
// THE PUBLIC SURFACE
// ============================================================================

describe("setMemberAppAccess", () => {
  it("an admin sets a member's access; owners and admins are refused as targets", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.alice.memberId,
      app: "momentum",
      access: "view_all",
    });
    expect(await storedAccess(w.t, w.alice.memberId, "momentum")).toBe("view_all");
    expect(await levelFor(w.t, w.alice, w.projectB)).toBe("view");

    for (const target of [w.owner, w.admin]) {
      expect(
        await refusal(() =>
          w.owner.as.mutation(api.access.setMemberAppAccess, {
            memberId: target.memberId,
            app: "precision",
            access: "none",
          })
        )
      ).toBe("Admins have full access.");
    }
  });

  it("a member cannot set anyone's access, their own included", async () => {
    const w = await seedWorld();
    await expect(
      w.alice.as.mutation(api.access.setMemberAppAccess, {
        memberId: w.alice.memberId,
        app: "precision",
        access: "edit_all",
      })
    ).rejects.toThrow(ORG_ADMIN_REFUSAL);
    expect(await storedAccess(w.t, w.alice.memberId, "precision")).toBeNull();
  });
});

describe("listItemAccess and listMemberGrants", () => {
  it("lists the people added, legacy rows included, and who else has access", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.bob.memberId,
      app: "momentum",
      access: "edit_all",
    });
    await legacyAssignment(w.t, w.projectA.projectId, w.alice.userId, "project", "viewer");
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.projectA,
      userId: w.bob.userId,
      level: "view",
    });

    const panel = await w.owner.as.query(api.access.listItemAccess, w.projectA);
    expect(panel.people.map((p) => [p.email, p.level, p.appAccess])).toEqual([
      ["al@x.test", "view", "assigned"],
      ["bo@x.test", "view", "edit_all"],
    ]);
    expect(panel.implicit).toEqual({ admins: 2, editAll: 1, viewAll: 0 });
  });

  it("lists the estimates and projects one member was added to, with names", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateB,
      userId: w.alice.userId,
      level: "edit",
    });
    await legacyAssignment(w.t, w.projectA.projectId, w.alice.userId, "project", "foreman");

    const grants = await w.owner.as.query(api.access.listMemberGrants, {
      memberId: w.alice.memberId,
    });
    expect(grants.estimates.map((e) => [e.proposalNumber, e.description, e.level])).toEqual([
      ["2102", "Pipe rack", "edit"],
    ]);
    expect(grants.projects.map((p) => [p.name, p.level])).toEqual([["2101 Tank 8", "edit"]]);

    await expect(
      w.bob.as.query(api.access.listMemberGrants, { memberId: w.alice.memberId })
    ).rejects.toThrow(ORG_ADMIN_REFUSAL);
  });

  it("removing a member deletes their grants", async () => {
    const w = await seedWorld();
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.estimateA,
      userId: w.alice.userId,
      level: "edit",
    });
    await w.admin.as.mutation(api.adminUsers.removeMember, { memberId: w.alice.memberId });

    const left = await w.t.run(async (ctx) =>
      ctx.db
        .query("accessGrants")
        .withIndex("by_user", (q) => q.eq("userId", w.alice.userId))
        .collect()
    );
    expect(left).toEqual([]);
  });

  it("the roster carries the new access columns beside the legacy ones", async () => {
    const w = await seedWorld();
    await legacyRow(w.t, w.alice.memberId, "precision", "read");

    const roster = await w.admin.as.query(api.adminUsers.listOrganizationMembers, {
      organizationId: w.organizationId,
    });
    const alice = roster.find((row) => row.memberId === w.alice.memberId);
    expect(alice).toMatchObject({
      appPermissions: { precision: "read", momentum: "none" },
      precisionAccess: "view_all",
      momentumAccess: "assigned",
    });
    const owner = roster.find((row) => row.memberId === w.owner.memberId);
    expect(owner).toMatchObject({
      appPermissions: { precision: "admin", momentum: "admin" },
      precisionAccess: "full",
      momentumAccess: "full",
    });

    const detail = await w.admin.as.query(api.adminUsers.getMemberDetail, {
      memberId: w.alice.memberId,
    });
    expect(detail?.precisionAccess).toBe("view_all");
  });
});

// ============================================================================
// COMPATIBILITY WITH INSTALLED APPS
// ============================================================================

describe("getMemberPermissions tells old apps a legacy level derived from the new model", () => {
  it("admin, write, read, and assigned by best item", async () => {
    const w = await seedWorld();
    const read = (memberId: string) =>
      w.owner.as.query(api.appPermissions.getMemberPermissions, { memberId });

    await expect(read(w.admin.memberId)).resolves.toEqual({
      precision: "admin",
      momentum: "admin",
    });
    await expect(read(w.alice.memberId)).resolves.toEqual({ precision: "none", momentum: "none" });

    await w.owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.alice.memberId,
      app: "precision",
      access: "edit_all",
    });
    await w.owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.bob.memberId,
      app: "precision",
      access: "view_all",
    });
    await w.owner.as.mutation(api.access.grantItemAccess, {
      ...w.projectA,
      userId: w.alice.userId,
      level: "view",
    });
    await w.owner.as.mutation(api.access.grantItemAccess, {
      ...w.projectB,
      userId: w.bob.userId,
      level: "edit",
    });

    await expect(read(w.alice.memberId)).resolves.toEqual({
      precision: "write",
      momentum: "read",
    });
    await expect(read(w.bob.memberId)).resolves.toEqual({ precision: "read", momentum: "write" });

    // Self-service still works for a plain member: the old WorkspaceProvider
    // reads exactly this on every session.
    await expect(
      w.bob.as.query(api.appPermissions.getMemberPermissions, { memberId: w.bob.memberId })
    ).resolves.toEqual({ precision: "read", momentum: "write" });
    await expect(
      w.bob.as.query(api.appPermissions.checkPermission, {
        memberId: w.bob.memberId,
        app: "momentum",
        requiredPermission: "write",
      })
    ).resolves.toBe(true);
    await expect(
      w.bob.as.query(api.appPermissions.checkPermission, {
        memberId: w.bob.memberId,
        app: "precision",
        requiredPermission: "write",
      })
    ).resolves.toBe(false);
  });
});

describe("setPermission maps legacy writes onto app access", () => {
  it("Precision none/read/write and every Momentum value", async () => {
    const w = await seedWorld();
    const set = (app: "precision" | "momentum", permission: LegacyPermission) =>
      w.admin.as.mutation(api.appPermissions.setPermission, {
        memberId: w.alice.memberId,
        app,
        permission,
      });

    const cases: Array<["precision" | "momentum", LegacyPermission, AppAccess]> = [
      ["precision", "read", "view_all"],
      ["precision", "write", "edit_all"],
      ["precision", "none", "none"],
      ["momentum", "write", "assigned"],
      ["momentum", "read", "assigned"],
      ["momentum", "none", "assigned"],
    ];
    for (const [app, permission, access] of cases) {
      await set(app, permission);
      expect(await storedAccess(w.t, w.alice.memberId, app)).toBe(access);
    }
  });

  it("refuses admin, telling the old screen where the control moved", async () => {
    const w = await seedWorld();
    expect(
      await refusal(() =>
        w.admin.as.mutation(api.appPermissions.setPermission, {
          memberId: w.alice.memberId,
          app: "momentum",
          permission: "admin",
        })
      )
    ).toBe("Make them an Admin from the Role column instead.");
    expect(await storedAccess(w.t, w.alice.memberId, "momentum")).toBeNull();
  });

  it("refuses an admin target, and still refuses the owner by name", async () => {
    const w = await seedWorld();
    expect(
      await refusal(() =>
        w.owner.as.mutation(api.appPermissions.setPermission, {
          memberId: w.admin.memberId,
          app: "precision",
          permission: "write",
        })
      )
    ).toBe("Admins have full access.");
    await expect(
      w.admin.as.mutation(api.appPermissions.setPermission, {
        memberId: w.owner.memberId,
        app: "precision",
        permission: "none",
      })
    ).rejects.toThrow(/Cannot change app access for the organization owner/);
  });
});

// ============================================================================
// THE MIGRATION
// ============================================================================

/** Production's shape: who has which legacy rows and assignments. */
async function seedProduction() {
  const w = await seedWorld();
  const { t, organizationId } = w;
  const writers = [w.alice];
  for (const email of ["w2@x.test", "w3@x.test"]) {
    writers.push(await seedPrincipal(t, { organizationId, role: "member", email }));
  }
  const fieldTwo = await seedPrincipal(t, { organizationId, role: "member", email: "f2@x.test" });
  const field = [w.bob, fieldTwo];
  const newcomer = await seedPrincipal(t, { organizationId, role: "member", email: "new@x.test" });
  const walled = await seedPrincipal(t, { organizationId, role: "member", email: "wall@x.test" });
  const projectC = { projectId: await seedProject(t, w.estimateB.proposalId, "2102 Phase 2") };

  // The admin holds legacy app-level admin rows; the owner holds none.
  await legacyRow(t, w.admin.memberId, "precision", "admin");
  await legacyRow(t, w.admin.memberId, "momentum", "admin");
  for (const writer of writers) {
    await legacyRow(t, writer.memberId, "precision", "write");
    await legacyRow(t, writer.memberId, "momentum", "read");
  }
  for (const worker of field) {
    await legacyRow(t, worker.memberId, "precision", "read");
    await legacyRow(t, worker.memberId, "momentum", "write");
  }
  await legacyRow(t, walled.memberId, "precision", "none");

  await legacyAssignment(t, w.projectA.projectId, w.bob.userId, "project", "superintendent");
  await legacyAssignment(t, w.projectA.projectId, w.bob.userId, "project", "viewer");
  await legacyAssignment(t, w.projectB.projectId, w.bob.userId, "project", "viewer");
  await legacyAssignment(t, w.projectB.projectId, fieldTwo.userId, "project", "foreman");
  await legacyAssignment(t, projectC.projectId, fieldTwo.userId, "wbs", "superintendent");
  // An assignment on the admin, too — copied, though their role already covers it.
  await legacyAssignment(t, projectC.projectId, w.admin.userId, "project", "viewer");

  const people = [w.owner, w.admin, ...writers, ...field, newcomer, walled];
  const items: ItemRef[] = [w.estimateA, w.estimateB, w.projectA, w.projectB, projectC];
  return { ...w, people, items, fieldTwo, newcomer, projectC };
}

/** Every person's app access, legacy levels, and level on every item. */
async function accessMatrix(t: TestRunner, people: Principal[], items: ItemRef[]) {
  return t.run(async (ctx) => {
    const rows = [];
    for (const person of people) {
      const [member] = await membershipsOf(ctx, person.userId);
      if (!member) throw new Error("fixture: no membership");
      const subject = subjectForMember(member);
      const levels = [];
      for (const item of items) levels.push(await itemLevelOf(ctx, subject, item));
      rows.push({
        precision: await appAccessFor(ctx, subject, "precision"),
        momentum: await appAccessFor(ctx, subject, "momentum"),
        legacy: await legacyPermissionsFor(ctx, subject),
        levels,
      });
    }
    return rows;
  });
}

describe("migrateToSimpleAccess", () => {
  it("changes nobody's access, is idempotent, and leaves grants carrying the legacy rows", async () => {
    const w = await seedProduction();
    const before = await accessMatrix(w.t, w.people, w.items);

    // Sanity: the matrix has teeth — it is not all one value.
    expect(before.map((row) => row.levels[2])).toContain("edit");
    expect(before.map((row) => row.levels[2])).toContain(null);

    const dry = await w.t.mutation(internal.access.migrateToSimpleAccess, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, adminRowsDeleted: 2, accessWritten: 11 });
    expect(await storedAccess(w.t, w.alice.memberId, "precision")).toBeNull();

    const first = await w.t.mutation(internal.access.migrateToSimpleAccess, {});
    expect(first).toEqual({
      dryRun: false,
      accessWritten: 11,
      adminRowsDeleted: 2,
      grantsCreated: 4,
      grantsRaised: 0,
    });
    expect(await accessMatrix(w.t, w.people, w.items)).toEqual(before);

    const rows = await w.t.run(async (ctx) => ctx.db.query("appPermissions").collect());
    expect(rows.every((row) => row.access !== undefined)).toBe(true);
    expect(rows.some((row) => row.memberId === w.admin.memberId)).toBe(false);

    const second = await w.t.mutation(internal.access.migrateToSimpleAccess, {});
    expect(second).toEqual({
      dryRun: false,
      accessWritten: 0,
      adminRowsDeleted: 0,
      grantsCreated: 0,
      grantsRaised: 0,
    });
    expect(await accessMatrix(w.t, w.people, w.items)).toEqual(before);

    // The proof that grants now carry it: drop the legacy table entirely.
    await w.t.run(async (ctx) => {
      for (const row of await ctx.db.query("projectAssignments").collect()) {
        await ctx.db.delete(row._id);
      }
    });
    expect(await accessMatrix(w.t, w.people, w.items)).toEqual(before);
  });

  it("does not overwrite a setting an admin changed after the first run", async () => {
    const w = await seedProduction();
    await w.t.mutation(internal.access.migrateToSimpleAccess, {});
    await w.owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: w.alice.memberId,
      app: "precision",
      access: "assigned",
    });

    await w.t.mutation(internal.access.migrateToSimpleAccess, {});

    expect(await storedAccess(w.t, w.alice.memberId, "precision")).toBe("assigned");
  });
});

// ============================================================================
// OLD TEAM SCREENS AFTER THE MIGRATION
// ============================================================================

/** One person's legacy rows on one project, read straight from the table. */
async function assignmentsOn(t: TestRunner, projectId: Id<"momentumProjects">, userId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) => q.eq("projectId", projectId).eq("userId", userId))
      .collect()
  );
}

/** The project-scope row with `role`, which the fixture must have seeded. */
function rowWithRole(rows: Array<{ _id: Id<"projectAssignments">; role: string }>, role: string) {
  const row = rows.find((r) => r.role === role);
  if (!row) throw new Error(`fixture: no ${role} row`);
  return row._id;
}

describe("old Team screens keep the copied grants in step", () => {
  // The migration copies project-scope rows into grants and keeps the rows for
  // installed apps, whose Team screens see only the rows. Every write there
  // must reach the copy, or Remove shows someone gone who can still edit.

  it("Remove takes the project away, and a remaining row decides the level", async () => {
    const w = await seedProduction();
    await w.t.mutation(internal.access.migrateToSimpleAccess, {});
    const rows = await assignmentsOn(w.t, w.projectA.projectId, w.bob.userId);
    expect(await levelFor(w.t, w.bob, w.projectA)).toBe("edit");

    // Bob holds a superintendent and a viewer row; without the first he is a
    // viewer, exactly as before the migration.
    await w.admin.as.mutation(api.projectAssignments.removeAssignment, {
      assignmentId: rowWithRole(rows, "superintendent"),
    });
    expect(await levelFor(w.t, w.bob, w.projectA)).toBe("view");

    await w.admin.as.mutation(api.projectAssignments.removeAssignment, {
      assignmentId: rowWithRole(rows, "viewer"),
    });
    expect(await levelFor(w.t, w.bob, w.projectA)).toBeNull();
    const browse = await w.bob.as.query(api.momentum.getBrowseData, w.projectA);
    expect(browse?.scopeInfo.hasAccess).toBe(false);
    expect((await projectList(w.bob, [w.projectA.projectId])).levels).toEqual([null]);
    expect(await refusal(() => w.bob.as.run((ctx) => requireItem(ctx, w.projectA, "view")))).toBe(
      ITEM_REFUSAL.momentum
    );
  });

  it("changing someone to Viewer makes them view-only, and back again", async () => {
    const w = await seedProduction();
    await w.t.mutation(internal.access.migrateToSimpleAccess, {});
    const [row] = await assignmentsOn(w.t, w.projectB.projectId, w.fieldTwo.userId);
    if (!row) throw new Error("fixture: no foreman row");

    await w.admin.as.mutation(api.projectAssignments.updateAssignment, {
      assignmentId: row._id,
      role: "viewer",
    });
    expect(await levelFor(w.t, w.fieldTwo, w.projectB)).toBe("view");

    await w.admin.as.mutation(api.projectAssignments.updateAssignment, {
      assignmentId: row._id,
      role: "foreman",
    });
    expect(await levelFor(w.t, w.fieldTwo, w.projectB)).toBe("edit");
  });

  it("removing every row takes the project away", async () => {
    const w = await seedProduction();
    await w.t.mutation(internal.access.migrateToSimpleAccess, {});

    const removed = await w.owner.as.mutation(api.projectAssignments.removeAllUserAssignments, {
      ...w.projectA,
      userId: w.bob.userId,
    });

    expect(removed).toBe(2);
    expect(await levelFor(w.t, w.bob, w.projectA)).toBeNull();
    expect(await levelFor(w.t, w.bob, w.projectB)).toBe("view");
  });

  it("adding someone as Viewer makes them view-only, though the People panel gave edit", async () => {
    const w = await seedProduction();
    for (const person of [w.alice, w.newcomer]) {
      await w.admin.as.mutation(api.access.grantItemAccess, {
        ...w.projectA,
        userId: person.userId,
        level: "edit",
      });
    }

    await w.admin.as.mutation(api.projectAssignments.assignUserToProject, {
      ...w.projectA,
      userId: w.alice.userId,
      scopeType: "project",
      role: "viewer",
    });
    await w.admin.as.mutation(api.projectAssignments.bulkAssignUser, {
      ...w.projectA,
      userId: w.newcomer.userId,
      assignments: [{ scopeType: "project", role: "viewer" }],
    });

    expect(await levelFor(w.t, w.alice, w.projectA)).toBe("view");
    expect(await levelFor(w.t, w.newcomer, w.projectA)).toBe("view");
  });

  it("removing a WBS row leaves a People panel grant alone: that row granted nothing", async () => {
    const w = await seedProduction();
    await w.t.mutation(internal.access.migrateToSimpleAccess, {});
    await w.admin.as.mutation(api.access.grantItemAccess, {
      ...w.projectC,
      userId: w.fieldTwo.userId,
      level: "edit",
    });
    const [wbsRow] = await assignmentsOn(w.t, w.projectC.projectId, w.fieldTwo.userId);
    if (!wbsRow) throw new Error("fixture: no WBS row");

    await w.admin.as.mutation(api.projectAssignments.removeAssignment, {
      assignmentId: wbsRow._id,
    });

    expect(await levelFor(w.t, w.fieldTwo, w.projectC)).toBe("edit");
  });
});
