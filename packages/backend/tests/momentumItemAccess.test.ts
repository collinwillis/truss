/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Momentum on the access model (docs/ACCESS.md): one role, one Momentum
 * app-access setting per member, and people added to whole projects as Can
 * view or Can edit. Highest wins.
 *
 * Every level is driven through the real public functions against the real
 * Better Auth component, so a refusal here means the rule refused, not that
 * nobody was signed in.
 *
 * THE AXIS THAT MATTERS MOST IS "NOBODY LOSES ANYTHING": production's two
 * field members reach their projects only through legacy project-scope
 * assignments, so those must keep working exactly as before — `viewer` reads,
 * every other role logs. The new model removes only what never worked (WBS and
 * phase scoping) and what the spec moved to the Admin role (legacy app admin).
 */

import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api, components } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  APP_REFUSAL,
  ITEM_REFUSAL,
  ORG_ADMIN_REFUSAL,
  SUSPENDED_REFUSAL,
  VIEW_ONLY_REFUSAL,
} from "../convex/model/accessResolve";
import {
  authHarness,
  seedOrganization,
  seedPrincipal,
  type Caller,
  type Principal,
} from "./authFixtures";
import { seedProposal, type TestRunner } from "./convexFixtures";

// ============================================================================
// FIXTURES
// ============================================================================

const DAY = "2026-10-28";
const NEXT_DAY = "2026-10-29";

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

/** One project's ids: an estimate phase with one labor line, and a change order. */
interface Job {
  projectId: Id<"momentumProjects">;
  wbsId: Id<"momentumWbs">;
  phaseId: Id<"momentumPhases">;
  /** A second estimate phase in the same WBS, for moves and splits. */
  otherPhaseId: Id<"momentumPhases">;
  activityId: Id<"momentumActivities">;
  coWbsId: Id<"momentumWbs">;
  coPhaseId: Id<"momentumPhases">;
}

/** A Momentum project with an estimate WBS, two phases, a line and a change order. */
async function seedJob(t: TestRunner, proposalId: Id<"proposals">, name: string): Promise<Job> {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert("momentumProjects", {
      proposalId,
      name,
      proposalNumber: name,
      ownerName: "Test Owner",
      status: "active" as const,
    });
    const wbsId = await ctx.db.insert("momentumWbs", {
      projectId,
      name: "AG PIPING",
      sortOrder: 1,
      source: "estimate" as const,
    });
    const phase = (phaseNumber: number, description: string) =>
      ctx.db.insert("momentumPhases", {
        projectId,
        wbsId,
        poolName: "CARBON STEEL",
        phaseNumber,
        description,
        isCompleted: false,
        sortOrder: phaseNumber,
        source: "estimate" as const,
      });
    const phaseId = await phase(70001, "PIPE RACK");
    const otherPhaseId = await phase(70002, "TANK FARM");
    const activityId = await ctx.db.insert("momentumActivities", {
      projectId,
      wbsId,
      phaseId,
      type: "labor" as const,
      description: '3" CS PIPE',
      quantity: 100,
      unit: "LF",
      sortOrder: 1,
      source: "estimate" as const,
      labor: { craftConstant: 1, welderConstant: 0 },
    });
    const coWbsId = await ctx.db.insert("momentumWbs", {
      projectId,
      name: "CHANGE ORDERS",
      sortOrder: 2,
      source: "change_order" as const,
    });
    const coPhaseId = await ctx.db.insert("momentumPhases", {
      projectId,
      wbsId: coWbsId,
      poolName: "CHANGE ORDER",
      phaseNumber: 1,
      description: "CHANGE ORDER 1",
      isCompleted: false,
      sortOrder: 1,
      source: "change_order" as const,
      changeOrderStatus: "submitted" as const,
    });
    return { projectId, wbsId, phaseId, otherPhaseId, activityId, coWbsId, coPhaseId };
  });
}

/** Insert a legacy assignment row, as the old Team screen wrote them. */
async function legacyAssignment(
  t: TestRunner,
  projectId: Id<"momentumProjects">,
  userId: string,
  scopeType: "project" | "wbs" | "phase",
  role: "superintendent" | "supervisor" | "foreman" | "viewer",
  scopeId?: string
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("projectAssignments", {
      projectId,
      userId,
      scopeType,
      scopeId,
      newScopeId: scopeId,
      role,
      assignedAt: Date.now(),
    });
  });
}

/**
 * Production's shape and then some: an owner, an admin, and one member per
 * level, on two projects. A is the project people are added to; B nobody is.
 */
async function seedWorld() {
  const t = authHarness();
  const organizationId = await seedOrganization(t, "indemand");
  const person = (role: "owner" | "admin" | "member", email: string) =>
    seedPrincipal(t, { organizationId, role, email });

  const owner = await person("owner", "owner@indemand.test");
  const admin = await person("admin", "admin@indemand.test");
  const editor = await person("member", "editor@indemand.test");
  const viewer = await person("member", "viewer@indemand.test");
  const viewAll = await person("member", "viewall@indemand.test");
  const editAll = await person("member", "editall@indemand.test");
  const switchedOff = await person("member", "off@indemand.test");
  const legacySuper = await person("member", "super@indemand.test");
  const legacyViewer = await person("member", "legacyviewer@indemand.test");
  const legacyScoped = await person("member", "scoped@indemand.test");
  const legacyAdmin = await person("member", "appadmin@indemand.test");
  const outsider = await person("member", "outsider@indemand.test");

  const tree = await seedProposal(t, { proposalNumber: "2124" });
  const a = await seedJob(t, tree.proposalId, "A");
  const b = await seedJob(t, tree.proposalId, "B");

  const grant = (who: Principal, level: "view" | "edit") =>
    owner.as.mutation(api.access.grantItemAccess, {
      projectId: a.projectId,
      userId: who.userId,
      level,
    });
  const setAccess = (who: Principal, access: "none" | "assigned" | "view_all" | "edit_all") =>
    owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: who.memberId,
      app: "momentum",
      access,
    });

  await grant(editor, "edit");
  await grant(viewer, "view");
  await setAccess(viewAll, "view_all");
  await setAccess(editAll, "edit_all");
  // Granted first, then switched off: the grant must not survive "No access".
  await grant(switchedOff, "edit");
  await setAccess(switchedOff, "none");

  await legacyAssignment(t, a.projectId, legacySuper.userId, "project", "superintendent");
  await legacyAssignment(t, a.projectId, legacyViewer.userId, "project", "viewer");
  await legacyAssignment(t, a.projectId, legacyScoped.userId, "wbs", "superintendent", a.wbsId);
  await legacyAssignment(t, a.projectId, legacyScoped.userId, "phase", "foreman", a.phaseId);
  // The old Momentum app-level admin, on a plain member: written straight to
  // the table because the write path now refuses it.
  await t.run(async (ctx) => {
    await ctx.db.insert("appPermissions", {
      memberId: legacyAdmin.memberId,
      app: "momentum",
      permission: "admin",
    });
  });

  return {
    t,
    proposalId: tree.proposalId,
    a,
    b,
    owner,
    admin,
    editor,
    viewer,
    viewAll,
    editAll,
    switchedOff,
    legacySuper,
    legacyViewer,
    legacyScoped,
    legacyAdmin,
    outsider,
  };
}

/** Log one number on a project's line for `DAY`. */
function logOn(as: Caller, job: Job, quantityCompleted = 5) {
  return as.mutation(api.momentum.saveProgressEntries, {
    projectId: job.projectId,
    entryDate: DAY,
    entries: [{ activityId: job.activityId, quantityCompleted }],
  });
}

/** The quantities logged on a project, read straight from the table. */
async function logged(t: TestRunner, job: Job): Promise<number[]> {
  return t.run(async (ctx) =>
    (
      await ctx.db
        .query("progressEntries")
        .withIndex("by_project_date", (q) => q.eq("projectId", job.projectId))
        .collect()
    ).map((row) => row.quantityCompleted)
  );
}

/** What the caller's project list shows: name → access. */
async function listed(as: Caller): Promise<Record<string, string | null>> {
  const projects = await as.query(api.momentum.listProjects, {});
  return Object.fromEntries(projects.map((p) => [p.name, p.access]));
}

// ============================================================================
// THE PROJECT LIST, PER LEVEL
// ============================================================================

describe("listProjects shows each level its projects", () => {
  it("everything for Owner/Admin and the *_all settings, granted ones for Only assigned, none for No access", async () => {
    const w = await seedWorld();

    expect(await listed(w.owner.as)).toEqual({ A: "full", B: "full" });
    expect(await listed(w.admin.as)).toEqual({ A: "full", B: "full" });
    expect(await listed(w.editAll.as)).toEqual({ A: "edit", B: "edit" });
    expect(await listed(w.viewAll.as)).toEqual({ A: "view", B: "view" });
    expect(await listed(w.editor.as)).toEqual({ A: "edit" });
    expect(await listed(w.viewer.as)).toEqual({ A: "view" });
    expect(await listed(w.legacySuper.as)).toEqual({ A: "edit" });
    expect(await listed(w.legacyViewer.as)).toEqual({ A: "view" });
    // Nothing reaches these: a WBS/phase row, a switched-off app, no grant.
    expect(await listed(w.legacyScoped.as)).toEqual({});
    expect(await listed(w.switchedOff.as)).toEqual({});
    expect(await listed(w.outsider.as)).toEqual({});
    expect(await listed(w.legacyAdmin.as)).toEqual({});
    expect(await w.t.query(api.momentum.listProjects, {})).toEqual([]);
  });

  it("highest wins: Can view all plus Can edit on one project is edit there", async () => {
    const w = await seedWorld();
    await w.owner.as.mutation(api.access.grantItemAccess, {
      projectId: w.a.projectId,
      userId: w.viewAll.userId,
      level: "edit",
    });

    expect(await listed(w.viewAll.as)).toEqual({ A: "edit", B: "view" });
    await logOn(w.viewAll.as, w.a);
    expect(await refusal(() => logOn(w.viewAll.as, w.b))).toBe(VIEW_ONLY_REFUSAL.momentum);
  });
});

// ============================================================================
// THE WORKBOOK'S scopeInfo
// ============================================================================

describe("getBrowseData().scopeInfo", () => {
  it("keeps the legacy fields and adds access: full, edit, view, or none at all", async () => {
    const w = await seedWorld();
    const scopeFor = async (as: Caller, job: Job) =>
      (await as.query(api.momentum.getBrowseData, { projectId: job.projectId }))?.scopeInfo;

    expect(await scopeFor(w.owner.as, w.b)).toEqual({
      isScoped: true,
      hasAccess: true,
      effectiveRole: "superintendent",
      access: "full",
    });
    expect(await scopeFor(w.editor.as, w.a)).toEqual({
      isScoped: true,
      hasAccess: true,
      effectiveRole: "superintendent",
      access: "edit",
    });
    expect(await scopeFor(w.viewer.as, w.a)).toEqual({
      isScoped: true,
      hasAccess: true,
      effectiveRole: "viewer",
      access: "view",
    });
    expect(await scopeFor(w.editor.as, w.b)).toEqual({
      isScoped: true,
      hasAccess: false,
      effectiveRole: null,
      access: null,
    });
  });

  it("a caller without access gets no project data — and a missing project reads the same", async () => {
    const w = await seedWorld();
    const ghost = await seedJob(w.t, w.proposalId, "Ghost");
    await w.t.run(async (ctx) => ctx.db.delete(ghost.projectId));

    for (const projectId of [w.b.projectId, ghost.projectId]) {
      const workbook = await w.editor.as.query(api.momentum.getBrowseData, { projectId });
      expect(workbook?.scopeInfo.hasAccess).toBe(false);
      expect(workbook?.project.name).toBe("");
      expect(workbook?.project.owner).toBe("");
      expect(workbook?.rows).toEqual([]);
      expect(workbook?.wbsSummaries).toEqual({});
    }

    // Someone who sees every project is simply told it is gone.
    expect(
      await w.owner.as.query(api.momentum.getBrowseData, { projectId: ghost.projectId })
    ).toBeNull();
  });

  it("everyone who can open a project sees all of it, Change Orders included", async () => {
    const w = await seedWorld();
    const owner = await w.owner.as.query(api.momentum.getBrowseData, { projectId: w.a.projectId });
    const viewer = await w.viewer.as.query(api.momentum.getBrowseData, {
      projectId: w.a.projectId,
    });

    expect(viewer?.rows).toEqual(owner?.rows);
    expect(Object.keys(viewer?.wbsSummaries ?? {})).toContain(w.a.coWbsId);
    expect(viewer?.phasesByWbs).toEqual(owner?.phasesByWbs);
  });
});

// ============================================================================
// CAN EDIT
// ============================================================================

describe("an Only assigned member added as Can edit", () => {
  it("logs progress on that project, and on no other", async () => {
    const w = await seedWorld();

    await logOn(w.editor.as, w.a);
    expect(await logged(w.t, w.a)).toEqual([5]);

    expect(await refusal(() => logOn(w.editor.as, w.b))).toBe(ITEM_REFUSAL.momentum);
    expect(await logged(w.t, w.b)).toEqual([]);
  });

  it("does the rest of the editing too: activities, phases, change orders, moves", async () => {
    const w = await seedWorld();
    const as = w.editor.as;

    await as.mutation(api.momentum.addActivity, {
      phaseId: w.a.phaseId,
      type: "labor",
      description: "FIELD ADDED",
      quantity: 1,
      unit: "EA",
      labor: { craftConstant: 1, welderConstant: 0 },
    });
    await as.mutation(api.momentum.addPhase, { wbsId: w.a.coWbsId, description: "CO 2" });
    await as.mutation(api.momentum.updateChangeOrderPhase, {
      phaseId: w.a.coPhaseId,
      changeOrderStatus: "approved",
    });
    await logOn(as, w.a);
    await as.mutation(api.momentum.moveEntriesToDate, {
      projectId: w.a.projectId,
      fromDate: DAY,
      toDate: NEXT_DAY,
    });
    await as.mutation(api.momentum.splitActivityToPhase, {
      projectId: w.a.projectId,
      activityId: w.a.activityId,
      targetPhaseId: w.a.otherPhaseId,
      quantity: 10,
    });

    const phase = await w.t.run((ctx) => ctx.db.get(w.a.coPhaseId));
    expect(phase?.changeOrderStatus).toBe("approved");
  });

  it("is still not an admin: no reports, no project settings, no imports", async () => {
    const w = await seedWorld();

    expect(
      await w.editor.as.query(api.momentum.getWeeklyBreakdown, { projectId: w.a.projectId })
    ).toBeNull();
    expect(
      await refusal(() =>
        w.editor.as.mutation(api.momentum.updateProject, { projectId: w.a.projectId, name: "X" })
      )
    ).toBe(ORG_ADMIN_REFUSAL);
  });
});

// ============================================================================
// CAN VIEW
// ============================================================================

describe("a member added as Can view", () => {
  it("reads the workbook, a day, the history and a line's history", async () => {
    const w = await seedWorld();
    await logOn(w.owner.as, w.a);
    const as = w.viewer.as;

    const day = await as.query(api.momentum.getEntriesForDate, {
      projectId: w.a.projectId,
      entryDate: DAY,
    });
    expect(Object.keys(day)).toEqual([w.a.activityId]);
    const history = await as.query(api.momentum.getEntryHistory, { projectId: w.a.projectId });
    expect(history?.days.map((d) => d.date)).toEqual([DAY]);
    const cell = await as.query(api.momentum.getCellHistory, {
      projectId: w.a.projectId,
      activityId: w.a.activityId,
      entryDate: DAY,
    });
    expect(cell?.current?.quantity).toBe(5);
  });

  it("cannot write anything, and nothing is written", async () => {
    const w = await seedWorld();
    await logOn(w.owner.as, w.a);
    const entryId = await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("progressEntries")
        .withIndex("by_project_date", (q) => q.eq("projectId", w.a.projectId))
        .first();
      if (!row) throw new Error("fixture: no entry");
      return row._id;
    });
    const as = w.viewer.as;

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["saveProgressEntries", () => logOn(as, w.a, 7)],
      // Saving 0 deletes the day's number: still a write.
      ["saveProgressEntries 0", () => logOn(as, w.a, 0)],
      [
        "moveEntriesToDate",
        () =>
          as.mutation(api.momentum.moveEntriesToDate, {
            projectId: w.a.projectId,
            fromDate: DAY,
            toDate: NEXT_DAY,
          }),
      ],
      [
        // Viewers could approve a change order here before: the hole the map found.
        "updateChangeOrderPhase",
        () =>
          as.mutation(api.momentum.updateChangeOrderPhase, {
            phaseId: w.a.coPhaseId,
            changeOrderStatus: "approved",
          }),
      ],
      [
        "addActivity",
        () =>
          as.mutation(api.momentum.addActivity, {
            phaseId: w.a.phaseId,
            type: "labor",
            description: "SNEAKED IN",
            quantity: 1,
            unit: "EA",
          }),
      ],
      ["deleteProgressEntry", () => as.mutation(api.momentum.deleteProgressEntry, { entryId })],
      [
        "reassignActivityPhase",
        () =>
          as.mutation(api.momentum.reassignActivityPhase, {
            projectId: w.a.projectId,
            activityId: w.a.activityId,
            targetPhaseId: w.a.otherPhaseId,
          }),
      ],
      [
        "revertActivityPhase",
        () =>
          as.mutation(api.momentum.revertActivityPhase, {
            projectId: w.a.projectId,
            activityId: w.a.activityId,
          }),
      ],
      [
        "splitActivityToPhase",
        () =>
          as.mutation(api.momentum.splitActivityToPhase, {
            projectId: w.a.projectId,
            activityId: w.a.activityId,
            targetPhaseId: w.a.otherPhaseId,
            quantity: 1,
          }),
      ],
    ];

    for (const [name, attempt] of attempts) {
      expect(await refusal(attempt), name).toBe(VIEW_ONLY_REFUSAL.momentum);
    }

    expect(await logged(w.t, w.a)).toEqual([5]);
    const after = await w.t.run(async (ctx) => ({
      co: (await ctx.db.get(w.a.coPhaseId))?.changeOrderStatus,
      activities: (
        await ctx.db
          .query("momentumActivities")
          .withIndex("by_project", (q) => q.eq("projectId", w.a.projectId))
          .collect()
      ).length,
      splits: (
        await ctx.db
          .query("activitySplits")
          .withIndex("by_project", (q) => q.eq("projectId", w.a.projectId))
          .collect()
      ).length,
    }));
    expect(after).toEqual({ co: "submitted", activities: 1, splits: 0 });
  });

  it("cannot unsplit either", async () => {
    const w = await seedWorld();
    const splitId = await w.owner.as.mutation(api.momentum.splitActivityToPhase, {
      projectId: w.a.projectId,
      activityId: w.a.activityId,
      targetPhaseId: w.a.otherPhaseId,
      quantity: 10,
    });

    expect(
      await refusal(() => w.viewer.as.mutation(api.momentum.revertActivitySplit, { splitId }))
    ).toBe(VIEW_ONLY_REFUSAL.momentum);
    expect(await w.t.run((ctx) => ctx.db.get(splitId))).not.toBeNull();
  });
});

// ============================================================================
// THE APP-WIDE SETTINGS
// ============================================================================

describe("Can view all and Can edit all", () => {
  it("Can view all opens every project read-only", async () => {
    const w = await seedWorld();
    const workbook = await w.viewAll.as.query(api.momentum.getBrowseData, {
      projectId: w.b.projectId,
    });
    expect(workbook?.scopeInfo).toMatchObject({ hasAccess: true, effectiveRole: "viewer" });
    expect(workbook?.rows.length).toBeGreaterThan(0);

    expect(await refusal(() => logOn(w.viewAll.as, w.b))).toBe(VIEW_ONLY_REFUSAL.momentum);
    expect(await logged(w.t, w.b)).toEqual([]);
  });

  it("Can edit all logs on every project with no grant at all", async () => {
    const w = await seedWorld();
    await logOn(w.editAll.as, w.a);
    await logOn(w.editAll.as, w.b);
    expect(await logged(w.t, w.a)).toEqual([5]);
    expect(await logged(w.t, w.b)).toEqual([5]);
  });

  it("Can edit all is still not an admin", async () => {
    const w = await seedWorld();
    expect(await refusal(() => w.editAll.as.query(api.momentum.listProposalsForImport, {}))).toBe(
      ORG_ADMIN_REFUSAL
    );
  });
});

describe("No access", () => {
  it("sees nothing, even on a project they were added to", async () => {
    const w = await seedWorld();

    const workbook = await w.switchedOff.as.query(api.momentum.getBrowseData, {
      projectId: w.a.projectId,
    });
    expect(workbook?.scopeInfo.hasAccess).toBe(false);
    expect(
      await w.switchedOff.as.query(api.momentum.getEntryHistory, { projectId: w.a.projectId })
    ).toBeNull();
    expect(await refusal(() => logOn(w.switchedOff.as, w.a))).toBe(APP_REFUSAL.momentum);
  });
});

// ============================================================================
// LEGACY ASSIGNMENTS — EXACTLY AS BEFORE
// ============================================================================

describe("legacy project assignments still work exactly as today", () => {
  it("a project-scope superintendent logs; a project-scope viewer reads only", async () => {
    const w = await seedWorld();

    await logOn(w.legacySuper.as, w.a);
    expect(await logged(w.t, w.a)).toEqual([5]);

    const viewed = await w.legacyViewer.as.query(api.momentum.getBrowseData, {
      projectId: w.a.projectId,
    });
    expect(viewed?.scopeInfo).toMatchObject({ hasAccess: true, effectiveRole: "viewer" });
    expect(await refusal(() => logOn(w.legacyViewer.as, w.a, 6))).toBe(VIEW_ONLY_REFUSAL.momentum);
  });

  it("a foreman or supervisor row is edit too: only viewer ever did anything", async () => {
    const w = await seedWorld();
    await legacyAssignment(w.t, w.b.projectId, w.outsider.userId, "project", "foreman");
    await logOn(w.outsider.as, w.b);
    expect(await logged(w.t, w.b)).toEqual([5]);
  });

  it("WBS- and phase-scoped rows grant nothing", async () => {
    const w = await seedWorld();
    const workbook = await w.legacyScoped.as.query(api.momentum.getBrowseData, {
      projectId: w.a.projectId,
    });
    expect(workbook?.scopeInfo.hasAccess).toBe(false);
    expect(await refusal(() => logOn(w.legacyScoped.as, w.a))).toBe(ITEM_REFUSAL.momentum);
  });
});

// ============================================================================
// OWNERS AND ADMINS
// ============================================================================

describe("Momentum admin is the Owner/Admin role, and only that", () => {
  it("a legacy Momentum app admin on a plain member is no longer an admin", async () => {
    const w = await seedWorld();
    const as = w.legacyAdmin.as;

    expect(await refusal(() => as.query(api.momentum.listProposalsForImport, {}))).toBe(
      ORG_ADMIN_REFUSAL
    );
    expect(
      await refusal(() => as.mutation(api.momentum.createProject, { proposalId: w.proposalId }))
    ).toBe(ORG_ADMIN_REFUSAL);
    expect(
      await as.query(api.momentum.getWeeklyBreakdown, { projectId: w.a.projectId })
    ).toBeNull();
    expect(
      await as.query(api.momentum.getProjectContributors, { projectId: w.a.projectId })
    ).toEqual({});
  });

  it("an Owner and an Admin run reports and edit everything", async () => {
    const w = await seedWorld();
    await logOn(w.admin.as, w.b);
    expect(
      await w.owner.as.query(api.momentum.getWeeklyBreakdown, { projectId: w.b.projectId })
    ).not.toBeNull();
    expect(
      await w.admin.as.query(api.momentum.getPhaseBreakdown, { projectId: w.b.projectId })
    ).not.toBeNull();
  });

  it("getImportJob answers an Owner/Admin, and null to everyone else", async () => {
    const w = await seedWorld();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("momentumImportJobs", {
        token: "tok-1",
        proposalId: w.proposalId,
        proposalNumber: "2124",
        proposalDescription: "Tank farm",
        status: "importing" as const,
        stage: "Importing",
        wbsCount: 1,
        phaseCount: 1,
        activityCount: 1,
        processed: 0,
        total: 1,
        startedAt: 1,
        updatedAt: 1,
      });
    });

    expect(await w.owner.as.query(api.momentum.getImportJob, { token: "tok-1" })).toMatchObject({
      proposalDescription: "Tank farm",
    });
    expect(await w.editAll.as.query(api.momentum.getImportJob, { token: "tok-1" })).toBeNull();
    expect(await w.t.query(api.momentum.getImportJob, { token: "tok-1" })).toBeNull();
  });

  it("deleting a project removes the people added to it", async () => {
    const w = await seedWorld();
    await w.owner.as.mutation(api.momentum.deleteProject, { projectId: w.a.projectId });

    const left = await w.t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("accessGrants")
            .withIndex("by_project_user", (q) => q.eq("projectId", w.a.projectId))
            .collect()
        ).length
    );
    expect(left).toBe(0);
    expect(await listed(w.editor.as)).toEqual({});
  });
});

// ============================================================================
// GUARD BEFORE LOOKUP
// ============================================================================

describe("a refusal never says whether the thing exists", () => {
  it("an Only assigned member gets one sentence for a missing phase and for another project's", async () => {
    const w = await seedWorld();
    const gone = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert("momentumPhases", {
        projectId: w.b.projectId,
        wbsId: w.b.coWbsId,
        poolName: "CHANGE ORDER",
        phaseNumber: 9,
        description: "GONE",
        isCompleted: false,
        sortOrder: 9,
        source: "change_order" as const,
      });
      await ctx.db.delete(id);
      return id;
    });
    const tryPhase = (phaseId: Id<"momentumPhases">) =>
      refusal(() =>
        w.editor.as.mutation(api.momentum.updateChangeOrderPhase, {
          phaseId,
          changeOrderStatus: "approved",
        })
      );

    expect(await tryPhase(gone)).toBe(ITEM_REFUSAL.momentum);
    expect(await tryPhase(w.b.coPhaseId)).toBe(ITEM_REFUSAL.momentum);

    // Someone who sees every project learns nothing new from "not found".
    expect(
      await refusal(() =>
        w.owner.as.mutation(api.momentum.updateChangeOrderPhase, {
          phaseId: gone,
          changeOrderStatus: "approved",
        })
      )
    ).toBe("Phase not found.");
  });

  it("an unassigned member's addActivity is refused before the phase is read", async () => {
    const w = await seedWorld();
    expect(
      await refusal(() =>
        w.outsider.as.mutation(api.momentum.addActivity, {
          phaseId: w.b.phaseId,
          type: "labor",
          description: "X",
          quantity: 1,
          unit: "EA",
        })
      )
    ).toBe(ITEM_REFUSAL.momentum);
  });
});

// ============================================================================
// SUSPENDED
// ============================================================================

describe("a suspended editor", () => {
  it("is refused, and lists nothing, though their session still works", async () => {
    const w = await seedWorld();
    await w.t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: w.editor.userId }],
          update: { banned: true },
        },
      });
    });

    expect(await refusal(() => logOn(w.editor.as, w.a))).toBe(SUSPENDED_REFUSAL);
    expect(await w.editor.as.query(api.momentum.listProjects, {})).toEqual([]);
  });
});

// ============================================================================
// PINS AND RECENT VIEWS
// ============================================================================

describe("pins and recent views", () => {
  it("name only projects the caller can open, and a pin can always be taken off", async () => {
    const w = await seedWorld();

    // B was never shared with the editor: nothing is recorded or pinned there.
    await w.editor.as.mutation(api.momentum.recordProjectView, { projectId: w.b.projectId });
    await w.editor.as.mutation(api.momentum.togglePinnedProject, { projectId: w.b.projectId });
    expect(await w.editor.as.query(api.momentum.getRecentProjectIds, {})).toEqual([]);
    expect(await w.editor.as.query(api.momentum.getPinnedProjectIds, {})).toEqual([]);

    await w.editor.as.mutation(api.momentum.recordProjectView, { projectId: w.a.projectId });
    await w.editor.as.mutation(api.momentum.togglePinnedProject, { projectId: w.a.projectId });
    expect(await w.editor.as.query(api.momentum.getRecentProjectIds, {})).toEqual([w.a.projectId]);
    expect(await w.editor.as.query(api.momentum.getPinnedProjectIds, {})).toEqual([w.a.projectId]);

    // Taken off A, the pin is still theirs to remove.
    await w.owner.as.mutation(api.access.revokeItemAccess, {
      projectId: w.a.projectId,
      userId: w.editor.userId,
    });
    await w.editor.as.mutation(api.momentum.togglePinnedProject, { projectId: w.a.projectId });
    expect(await w.editor.as.query(api.momentum.getPinnedProjectIds, {})).toEqual([]);
  });

  it("are empty for a suspended member", async () => {
    const w = await seedWorld();
    await w.editor.as.mutation(api.momentum.togglePinnedProject, { projectId: w.a.projectId });
    await w.t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: w.editor.userId }],
          update: { banned: true },
        },
      });
    });
    expect(await w.editor.as.query(api.momentum.getPinnedProjectIds, {})).toEqual([]);
    expect(await w.editor.as.query(api.momentum.getRecentProjectIds, {})).toEqual([]);
  });
});
