/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * #26 — one project-access rule: admins see every project; everyone else
 * needs an assignment row. A project with ZERO assignments is admin-only,
 * not open.
 *
 * The old "opt-in" rule granted every member — and, through `if (user)`
 * skip-wrappers, every UNAUTHENTICATED caller — full read and write access
 * to any project nobody had been assigned to yet. That contradicted what
 * listProjects already promised (#43: non-admins see only assigned
 * projects) and left 16 of 21 production projects open.
 *
 * Both failure directions are pinned:
 *  - the strict rule actually refuses (member, unauthenticated), and
 *  - admins and assigned users keep working — locking out a foreman
 *    mid-shift would be a worse regression than the hole.
 *
 * Also covers #29: functions that previously had NO check at all.
 */

import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { authHarness, seedOrganization, seedPrincipal } from "./authFixtures";
import { seedProposal, laborActivity, type TestRunner } from "./convexFixtures";

/** A project with NO assignment rows — the case the two rules disagreed on. */
async function seedUnassignedProject(t: TestRunner): Promise<{
  projectId: Id<"momentumProjects">;
  momentumPhaseId: Id<"momentumPhases">;
  momentumActivityId: Id<"momentumActivities">;
}> {
  const tree = await seedProposal(t, {
    proposalNumber: "2020",
    wbs: [
      {
        poolId: 10000,
        name: "MOBILIZE",
        phases: [{ phaseNumber: 1, description: "Mobilize", activities: [laborActivity(10)] }],
      },
    ],
  });

  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("momentumProjects", {
      proposalId: tree.proposalId,
      name: "Nitron 8000",
      proposalNumber: "2020",
      ownerName: "Test Owner",
      status: "active" as const,
    });
    const wbsId = await ctx.db.insert("momentumWbs", {
      projectId,
      name: "MOBILIZE",
      sortOrder: 1,
      source: "estimate" as const,
      sourceWbsId: tree.wbsByCode.get(10000),
      sourceWbsPoolId: 10000,
    });
    const momentumPhaseId = await ctx.db.insert("momentumPhases", {
      projectId,
      wbsId,
      poolName: "MOBILIZE",
      description: "Mobilize",
      phaseNumber: 1,
      isCompleted: false,
      sortOrder: 1,
      source: "estimate" as const,
      sourcePhaseId: tree.phaseByNumber.get("10000:1"),
    });
    const momentumActivityId = await ctx.db.insert("momentumActivities", {
      projectId,
      wbsId,
      phaseId: momentumPhaseId,
      type: "labor" as const,
      description: "CHANGE TRAILER",
      quantity: 10,
      unit: "EA",
      sortOrder: 1,
      source: "estimate" as const,
      labor: { craftConstant: 1, welderConstant: 0 },
    });
    return { projectId, momentumPhaseId, momentumActivityId };
  });
}

async function twoMemberOrg(t: TestRunner) {
  const organizationId = await seedOrganization(t, "acme");
  const owner = await seedPrincipal(t, {
    organizationId,
    role: "owner",
    email: "owner@acme.test",
  });
  const member = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "member@acme.test",
  });
  return { owner, member };
}

describe("a zero-assignment project is admin-only, not open (#26)", () => {
  it("the workbook refuses a plain member softly, via scopeInfo", async () => {
    const t = authHarness();
    const { member } = await twoMemberOrg(t);
    const { projectId } = await seedUnassignedProject(t);

    const data = await member.as.query(api.momentum.getBrowseData, { projectId });
    expect(data).not.toBeNull();
    // Soft-fail is deliberate: this shape drives the client's Access
    // Restricted screen rather than an error toast on a live subscription.
    expect(data!.scopeInfo.hasAccess).toBe(false);
    expect(data!.scopeInfo.isScoped).toBe(true);
    expect(data!.rows).toHaveLength(0);
  });

  it("the workbook still opens fully for an admin", async () => {
    const t = authHarness();
    const { owner } = await twoMemberOrg(t);
    const { projectId } = await seedUnassignedProject(t);

    const data = await owner.as.query(api.momentum.getBrowseData, { projectId });
    expect(data!.scopeInfo.hasAccess).toBe(true);
    expect(data!.rows.length).toBeGreaterThan(0);
  });

  it("a member cannot write progress to an unassigned project", async () => {
    const t = authHarness();
    const { member } = await twoMemberOrg(t);
    const { projectId, momentumActivityId } = await seedUnassignedProject(t);

    await expect(
      member.as.mutation(api.momentum.saveProgressEntries, {
        projectId,
        entryDate: "2026-07-29",
        entries: [{ activityId: momentumActivityId, quantityCompleted: 2 }],
      })
    ).rejects.toThrow(/do not have access/i);
  });

  it("an unauthenticated caller cannot write progress at all", async () => {
    const t = authHarness();
    await twoMemberOrg(t);
    const { projectId, momentumActivityId } = await seedUnassignedProject(t);

    // The old `if (user)` wrapper skipped every check for a missing user.
    await expect(
      t.mutation(api.momentum.saveProgressEntries, {
        projectId,
        entryDate: "2026-07-29",
        entries: [{ activityId: momentumActivityId, quantityCompleted: 2 }],
      })
    ).rejects.toThrow(/not authenticated/i);
  });

  it("a member cannot add activities to an unassigned project; an admin can", async () => {
    const t = authHarness();
    const { owner, member } = await twoMemberOrg(t);
    const { projectId, momentumPhaseId } = await seedUnassignedProject(t);

    await expect(
      member.as.mutation(api.momentum.addActivity, {
        phaseId: momentumPhaseId,
        type: "labor",
        description: "SNEAKED IN",
        quantity: 1,
        unit: "EA",
        labor: { craftConstant: 1, welderConstant: 0 },
      })
    ).rejects.toThrow(/do not have access/i);

    const added = await owner.as.mutation(api.momentum.addActivity, {
      phaseId: momentumPhaseId,
      type: "labor",
      description: "ADMIN ADDED",
      quantity: 1,
      unit: "EA",
      labor: { craftConstant: 1, welderConstant: 0 },
    });
    expect(added).toBeTruthy();
    void projectId;
  });

  it("an assigned member keeps full access — the non-refusal axis", async () => {
    const t = authHarness();
    const { member } = await twoMemberOrg(t);
    const { projectId, momentumActivityId } = await seedUnassignedProject(t);

    await t.run(async (ctx) => {
      await ctx.db.insert("projectAssignments", {
        projectId,
        userId: member.userId,
        scopeType: "project" as const,
        role: "foreman" as const,
        assignedAt: Date.now(),
      });
    });

    const data = await member.as.query(api.momentum.getBrowseData, { projectId });
    expect(data!.scopeInfo.hasAccess).toBe(true);
    expect(data!.scopeInfo.effectiveRole).toBe("foreman");

    await member.as.mutation(api.momentum.saveProgressEntries, {
      projectId,
      entryDate: "2026-07-29",
      entries: [{ activityId: momentumActivityId, quantityCompleted: 2 }],
    });
  });
});

describe("the formerly unguarded functions refuse (#29)", () => {
  it("getEntryHistory is admin-only, like the rest of the #39 family", async () => {
    const t = authHarness();
    const { owner, member } = await twoMemberOrg(t);
    const { projectId } = await seedUnassignedProject(t);

    expect(await member.as.query(api.momentum.getEntryHistory, { projectId })).toBeNull();
    expect(await t.query(api.momentum.getEntryHistory, { projectId })).toBeNull();
    expect(await owner.as.query(api.momentum.getEntryHistory, { projectId })).not.toBeNull();
  });

  it("getEntriesForDate returns nothing to a caller without standing", async () => {
    const t = authHarness();
    const { owner, member } = await twoMemberOrg(t);
    const { projectId } = await seedUnassignedProject(t);

    expect(
      await member.as.query(api.momentum.getEntriesForDate, {
        projectId,
        entryDate: "2026-07-29",
      })
    ).toEqual({});
    expect(
      await owner.as.query(api.momentum.getEntriesForDate, {
        projectId,
        entryDate: "2026-07-29",
      })
    ).toEqual({});
  });

  it("reassignActivityPhase refuses unauthenticated and unassigned callers", async () => {
    const t = authHarness();
    const { member } = await twoMemberOrg(t);
    const { projectId, momentumPhaseId, momentumActivityId } = await seedUnassignedProject(t);

    await expect(
      t.mutation(api.momentum.reassignActivityPhase, {
        projectId,
        activityId: momentumActivityId,
        targetPhaseId: momentumPhaseId,
      })
    ).rejects.toThrow(/not authenticated/i);

    await expect(
      member.as.mutation(api.momentum.reassignActivityPhase, {
        projectId,
        activityId: momentumActivityId,
        targetPhaseId: momentumPhaseId,
      })
    ).rejects.toThrow(/do not have access/i);
  });
});
