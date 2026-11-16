/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * `projectAssignments` — the legacy Team-screen functions, kept for Momentum
 * ≤ 0.1.13, and still the server's to guard.
 *
 * All ten exported functions were once reachable unauthenticated. Two distinct
 * holes, and the second is the reason this file leads with mutations:
 *
 *  - PII: `listProjectAssignments` handed out every assignee's name and email.
 *  - ESCALATION: `assignUserToProject` and `bulkAssignUser` called
 *    `safeGetAuthUser` only to stamp `assignedBy` as `currentUser?._id ??
 *    undefined`. The optional chain meant a NULL USER PROCEEDED. The role that
 *    write stores is not cosmetic — a project-scope row is a grant
 *    (docs/ACCESS.md), so self-granting "superintendent" was edit access to a
 *    live project in one call.
 *
 * Under the access model these functions are Owner/Admin only, reads
 * included: who is on a project is people administration, like the People
 * panel that replaces them. The legacy Momentum app-level `admin` no longer
 * counts. WBS- and phase-scoped rows grant nothing, so writing one is refused.
 *
 * The guard runs against the real Better Auth component: organizations, users,
 * members and sessions are seeded into the component's own tables and the
 * caller is set with `t.withIdentity({ subject, sessionId })`, because that is
 * what `safeGetAuthUser` reads. Faking the membership lookup would make every
 * refusal below pass regardless of what the guard did.
 */

import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ORG_ADMIN_REFUSAL } from "../convex/model/accessResolve";
import { SCOPED_ASSIGNMENT_REFUSAL } from "../convex/projectAssignments";
import { authHarness as harness, seedOrganization, seedPrincipal } from "./authFixtures";
import { seedProposal, type TestRunner } from "./convexFixtures";

/** The refusal every caller who is not an Owner or Admin must see. */
const ADMIN_REFUSED = ORG_ADMIN_REFUSAL;

/** A seeded project and the scope targets a caller can be assigned to. */
interface SeededProject {
  projectId: Id<"momentumProjects">;
  wbsId: Id<"wbs">;
  phaseId: Id<"phases">;
}

/**
 * Narrow a fixture lookup that the type system cannot prove is present.
 *
 * `noUncheckedIndexedAccess` makes every `Map.get` optional; a fixture that
 * silently yielded `undefined` would produce an assertion failure far from the
 * seeding bug that caused it.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture did not seed ${what}`);
  return value;
}

/** Seed a proposal tree and the Momentum project mirroring it. */
async function seedProject(t: TestRunner): Promise<SeededProject> {
  const tree = await seedProposal(t, {
    proposalNumber: "2020",
    wbs: [
      {
        poolId: 10000,
        name: "Foundations",
        phases: [{ phaseNumber: 1, description: "Excavate" }],
      },
    ],
  });

  const projectId = await t.run(async (ctx) =>
    ctx.db.insert("momentumProjects", {
      proposalId: tree.proposalId,
      name: "Tank 8",
      proposalNumber: "2020",
      ownerName: "Test Owner",
      status: "active" as const,
    })
  );

  return {
    projectId,
    wbsId: must(tree.wbsByCode.get(10000), "wbs 10000"),
    phaseId: must(tree.phaseByNumber.get("10000:1"), "phase 10000:1"),
  };
}

/** Every assignment row on a project, read straight from the table. */
async function storedAssignments(
  t: TestRunner,
  projectId: Id<"momentumProjects">
): Promise<Array<{ userId: string; role: string; scopeType: string; assignedBy: string | null }>> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return rows.map((r) => ({
      userId: r.userId,
      role: r.role as string,
      scopeType: r.scopeType as string,
      // `t.run` serializes `undefined` to `null`; normalise so a test never
      // asserts on which of the two it happens to observe.
      assignedBy: r.assignedBy ?? null,
    }));
  });
}

/** Insert a project-scope assignment directly, bypassing the guard being tested. */
async function grantAssignment(
  t: TestRunner,
  options: {
    projectId: Id<"momentumProjects">;
    userId: string;
    role: "superintendent" | "supervisor" | "foreman" | "viewer";
  }
): Promise<Id<"projectAssignments">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("projectAssignments", {
      projectId: options.projectId,
      userId: options.userId,
      scopeType: "project" as const,
      role: options.role,
      assignedAt: Date.now(),
    })
  );
}

/** A production-shaped legacy app-permission row: `permission` only. */
async function legacyPermission(
  t: TestRunner,
  memberId: string,
  app: "precision" | "momentum",
  permission: "none" | "read" | "write" | "admin"
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("appPermissions", { memberId, app, permission });
  });
}

/**
 * The full cast, on one project.
 *
 * `legacyMomentumAdmin` is a plain org member holding the old Momentum
 * app-level "admin" row, inserted directly because the write path now refuses
 * it. Under the old rule that made them a Momentum admin; under the new one it
 * makes them nothing more than a member.
 */
async function seedCast(t: TestRunner) {
  const organizationId = await seedOrganization(t, "acme");
  const owner = await seedPrincipal(t, {
    organizationId,
    role: "owner",
    email: "owner@acme.test",
  });
  const orgAdmin = await seedPrincipal(t, {
    organizationId,
    role: "admin",
    email: "orgadmin@acme.test",
  });
  const legacyMomentumAdmin = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "appadmin@acme.test",
  });
  const assigned = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "foreman@acme.test",
  });
  const outsider = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "outsider@acme.test",
  });

  await legacyPermission(t, legacyMomentumAdmin.memberId, "momentum", "admin");

  const project = await seedProject(t);
  await grantAssignment(t, {
    projectId: project.projectId,
    userId: assigned.userId,
    role: "foreman",
  });

  return { organizationId, owner, orgAdmin, legacyMomentumAdmin, assigned, outsider, project };
}

// ============================================================================
// THE HARNESS ITSELF
// ============================================================================

describe("the harness really authenticates", () => {
  it("an admin's identity resolves — so a refusal below means authorization, not a broken fixture", async () => {
    // Without this, every `rejects.toThrow` in this file could be passing
    // because `safeGetAuthUser` returned undefined for everybody.
    const t = harness();
    const { orgAdmin, assigned, project } = await seedCast(t);

    const roster = await orgAdmin.as.query(api.projectAssignments.listProjectAssignments, {
      projectId: project.projectId,
    });

    expect(roster).toHaveLength(1);
    expect(roster[0]?.userId).toBe(assigned.userId);
    expect(roster[0]?.userEmail).toBe("foreman@acme.test");
    expect(roster[0]?.scopeName).toBe("Entire Project");
  });
});

// ============================================================================
// THE ESCALATION — UNAUTHENTICATED WRITES
// ============================================================================

describe("an unauthenticated caller cannot write an assignment", () => {
  it("cannot assign anyone to a project", async () => {
    const t = harness();
    const { outsider, project } = await seedCast(t);

    await expect(
      t.mutation(api.projectAssignments.assignUserToProject, {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "project",
        role: "superintendent",
      })
    ).rejects.toThrow(/Not authenticated/);

    // The pre-seeded foreman is the only row; nothing was inserted.
    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("cannot bulk-assign — the same hole, one call further down the file", async () => {
    const t = harness();
    const { outsider, project } = await seedCast(t);

    await expect(
      t.mutation(api.projectAssignments.bulkAssignUser, {
        projectId: project.projectId,
        userId: outsider.userId,
        assignments: [{ scopeType: "project", role: "superintendent" }],
      })
    ).rejects.toThrow(/Not authenticated/);

    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("cannot promote an existing assignment", async () => {
    const t = harness();
    const { assigned, project } = await seedCast(t);
    const assignmentId = must(
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("projectAssignments")
            .withIndex("by_project", (q) => q.eq("projectId", project.projectId))
            .first()
        )
      )?._id,
      "the seeded assignment"
    );

    await expect(
      t.mutation(api.projectAssignments.updateAssignment, {
        assignmentId,
        role: "superintendent",
      })
    ).rejects.toThrow(/Not authenticated/);

    expect(await storedAssignments(t, project.projectId)).toEqual([
      { userId: assigned.userId, role: "foreman", scopeType: "project", assignedBy: null },
    ]);
  });

  it("cannot remove an assignment, or all of a user's assignments", async () => {
    const t = harness();
    const { assigned, project } = await seedCast(t);
    const assignmentId = must(
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("projectAssignments")
            .withIndex("by_project", (q) => q.eq("projectId", project.projectId))
            .first()
        )
      )?._id,
      "the seeded assignment"
    );

    await expect(
      t.mutation(api.projectAssignments.removeAssignment, { assignmentId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.mutation(api.projectAssignments.removeAllUserAssignments, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).rejects.toThrow(/Not authenticated/);

    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });
});

// ============================================================================
// AUTHENTICATED NON-ADMIN
// ============================================================================

describe("an authenticated non-admin cannot write an assignment either", () => {
  it("cannot grant ITSELF superintendent — the escalation that made this urgent", async () => {
    // A project-scope row is a grant: a self-granted "superintendent" is
    // production edit access to a project the caller was never added to.
    const t = harness();
    const { outsider, project } = await seedCast(t);

    await expect(
      outsider.as.mutation(api.projectAssignments.assignUserToProject, {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "project",
        role: "superintendent",
      })
    ).rejects.toThrow(ADMIN_REFUSED);

    const rows = await storedAssignments(t, project.projectId);
    expect(rows.some((r) => r.userId === outsider.userId)).toBe(false);
  });

  it("an ASSIGNED non-admin cannot promote themselves", async () => {
    // Being on the project is access, not administration. A viewer who could
    // call updateAssignment would simply raise their own role.
    const t = harness();
    const { assigned, project } = await seedCast(t);
    const assignmentId = await grantAssignment(t, {
      projectId: project.projectId,
      userId: assigned.userId,
      role: "viewer",
    });

    await expect(
      assigned.as.mutation(api.projectAssignments.updateAssignment, {
        assignmentId,
        role: "superintendent",
      })
    ).rejects.toThrow(ADMIN_REFUSED);
    await expect(
      assigned.as.mutation(api.projectAssignments.bulkAssignUser, {
        projectId: project.projectId,
        userId: assigned.userId,
        assignments: [{ scopeType: "project", role: "superintendent" }],
      })
    ).rejects.toThrow(ADMIN_REFUSED);

    const roles = (await storedAssignments(t, project.projectId)).map((r) => r.role).sort();
    expect(roles).toEqual(["foreman", "viewer"]);
  });

  it("cannot remove a colleague's assignment", async () => {
    const t = harness();
    const { assigned, outsider, project } = await seedCast(t);
    const assignmentId = must(
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("projectAssignments")
            .withIndex("by_project", (q) => q.eq("projectId", project.projectId))
            .first()
        )
      )?._id,
      "the seeded assignment"
    );

    await expect(
      outsider.as.mutation(api.projectAssignments.removeAssignment, { assignmentId })
    ).rejects.toThrow(ADMIN_REFUSED);
    await expect(
      assigned.as.mutation(api.projectAssignments.removeAllUserAssignments, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).rejects.toThrow(ADMIN_REFUSED);

    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("a plain member with the legacy Momentum app 'admin' is no longer an admin", async () => {
    // docs/ACCESS.md: app-level admin is now the Admin role. In production
    // every such row sits on an org admin, so nobody loses anything.
    const t = harness();
    const { legacyMomentumAdmin, outsider, project } = await seedCast(t);

    await expect(
      legacyMomentumAdmin.as.mutation(api.projectAssignments.assignUserToProject, {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "project",
        role: "foreman",
      })
    ).rejects.toThrow(ADMIN_REFUSED);
    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("a member whose momentum permission is only 'write' is NOT an admin", async () => {
    const t = harness();
    const { owner, outsider, project } = await seedCast(t);

    await owner.as.mutation(api.appPermissions.setPermission, {
      memberId: outsider.memberId,
      app: "momentum",
      permission: "write",
    });

    await expect(
      outsider.as.mutation(api.projectAssignments.assignUserToProject, {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "project",
        role: "superintendent",
      })
    ).rejects.toThrow(ADMIN_REFUSED);
  });

  it("a legacy precision admin has no standing in Momentum", async () => {
    const t = harness();
    const { outsider, project } = await seedCast(t);
    await legacyPermission(t, outsider.memberId, "precision", "admin");

    await expect(
      outsider.as.mutation(api.projectAssignments.assignUserToProject, {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "project",
        role: "superintendent",
      })
    ).rejects.toThrow(ADMIN_REFUSED);
  });
});

// ============================================================================
// OWNERS AND ADMINS SUCCEED
// ============================================================================

describe("an Owner or Admin can administer assignments", () => {
  it("an org admin assigns, updates and removes", async () => {
    const t = harness();
    const { orgAdmin, outsider, project } = await seedCast(t);

    const assignmentId = await orgAdmin.as.mutation(api.projectAssignments.assignUserToProject, {
      projectId: project.projectId,
      userId: outsider.userId,
      scopeType: "project",
      role: "supervisor",
    });

    const afterAssign = await storedAssignments(t, project.projectId);
    expect(afterAssign).toHaveLength(2);
    // The stamp is the authenticated admin. It used to be `undefined`
    // whenever the caller was null, which is exactly how an anonymous write
    // left no trace.
    expect(afterAssign.find((r) => r.userId === outsider.userId)?.assignedBy).toBe(orgAdmin.userId);

    await orgAdmin.as.mutation(api.projectAssignments.updateAssignment, {
      assignmentId,
      role: "superintendent",
    });
    expect(
      (await storedAssignments(t, project.projectId)).find((r) => r.userId === outsider.userId)
        ?.role
    ).toBe("superintendent");

    await orgAdmin.as.mutation(api.projectAssignments.removeAssignment, { assignmentId });
    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("an org owner bulk-assigns and clears a user out", async () => {
    const t = harness();
    const { owner, outsider, project } = await seedCast(t);

    const ids = await owner.as.mutation(api.projectAssignments.bulkAssignUser, {
      projectId: project.projectId,
      userId: outsider.userId,
      assignments: [{ scopeType: "project", role: "supervisor" }],
    });
    expect(ids).toHaveLength(1);
    expect(await storedAssignments(t, project.projectId)).toHaveLength(2);

    const removed = await owner.as.mutation(api.projectAssignments.removeAllUserAssignments, {
      projectId: project.projectId,
      userId: outsider.userId,
    });
    expect(removed).toBe(1);
    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("assigning by WBS or phase is refused with a sentence, and writes nothing", async () => {
    // Those rows grant nothing now; writing one would list a person on the
    // team who cannot open the project.
    const t = harness();
    const { owner, outsider, project } = await seedCast(t);

    await expect(
      owner.as.mutation(api.projectAssignments.assignUserToProject, {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "wbs",
        scopeId: project.wbsId,
        role: "foreman",
      })
    ).rejects.toThrow(SCOPED_ASSIGNMENT_REFUSAL);

    // All or nothing: one scoped row refuses the whole batch.
    await expect(
      owner.as.mutation(api.projectAssignments.bulkAssignUser, {
        projectId: project.projectId,
        userId: outsider.userId,
        assignments: [
          { scopeType: "project", role: "supervisor" },
          { scopeType: "phase", scopeId: project.phaseId, role: "foreman" },
        ],
      })
    ).rejects.toThrow(SCOPED_ASSIGNMENT_REFUSAL);

    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("assigning someone whose Momentum is switched off lifts it to Only assigned", async () => {
    // docs/ACCESS.md: adding someone to a project is one step everywhere,
    // including through an old Team screen.
    const t = harness();
    const { owner, outsider, project } = await seedCast(t);
    await owner.as.mutation(api.access.setMemberAppAccess, {
      memberId: outsider.memberId,
      app: "momentum",
      access: "none",
    });
    const before = await outsider.as.query(api.momentum.getBrowseData, {
      projectId: project.projectId,
    });
    expect(before?.scopeInfo.hasAccess).toBe(false);

    await owner.as.mutation(api.projectAssignments.assignUserToProject, {
      projectId: project.projectId,
      userId: outsider.userId,
      scopeType: "project",
      role: "foreman",
    });

    const after = await outsider.as.query(api.momentum.getBrowseData, {
      projectId: project.projectId,
    });
    expect(after?.scopeInfo).toMatchObject({ hasAccess: true, access: "edit" });
    expect(await outsider.as.query(api.access.getMyAccess, {})).toMatchObject({
      momentum: "assigned",
    });
  });
});

// ============================================================================
// READS — OWNER/ADMIN ONLY
// ============================================================================

describe("a project's team is people administration: Owner/Admin only", () => {
  it("an assigned member is refused their project's team list", async () => {
    // docs/ACCESS.md puts people with Owner/Admin. The only caller, the Team
    // section of Momentum <= 0.1.13 (removed since), renders inside the
    // admin-gated settings page, so no field member ever reached this.
    const t = harness();
    const { assigned, project } = await seedCast(t);

    for (const read of [
      () =>
        assigned.as.query(api.projectAssignments.listProjectAssignments, {
          projectId: project.projectId,
        }),
      () =>
        assigned.as.query(api.projectAssignments.getProjectScopeTree, {
          projectId: project.projectId,
        }),
      () =>
        assigned.as.query(api.projectAssignments.getProjectMembers, {
          projectId: project.projectId,
        }),
    ]) {
      await expect(read()).rejects.toThrow(ADMIN_REFUSED);
    }
  });

  it("the scope tree and the member summary answer for an admin", async () => {
    const t = harness();
    const { orgAdmin, assigned, project } = await seedCast(t);

    const tree = await orgAdmin.as.query(api.projectAssignments.getProjectScopeTree, {
      projectId: project.projectId,
    });
    expect(tree?.wbs).toHaveLength(1);
    expect(tree?.phases).toHaveLength(1);

    const members = await orgAdmin.as.query(api.projectAssignments.getProjectMembers, {
      projectId: project.projectId,
    });
    expect(members).toEqual([{ userId: assigned.userId, roles: ["foreman"], scopeCount: 1 }]);
  });

  it("a project with no assignments lists none for an admin", async () => {
    const t = harness();
    const { orgAdmin } = await seedCast(t);
    const empty = await seedProject(t);

    await expect(
      orgAdmin.as.query(api.projectAssignments.listProjectAssignments, {
        projectId: empty.projectId,
      })
    ).resolves.toEqual([]);
  });

  it("an unauthenticated caller gets nothing — not the names, not the emails", async () => {
    const t = harness();
    const { project } = await seedCast(t);

    await expect(
      t.query(api.projectAssignments.listProjectAssignments, { projectId: project.projectId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.projectAssignments.getProjectScopeTree, { projectId: project.projectId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.projectAssignments.getProjectMembers, { projectId: project.projectId })
    ).rejects.toThrow(/Not authenticated/);
  });

  it("an identity with no live session counts as unauthenticated", async () => {
    // safeGetAuthUser validates the session row, so a forged subject alone is
    // not enough. If it were, every guard here would be bypassable.
    const t = harness();
    const { orgAdmin, project } = await seedCast(t);

    const forged = t.withIdentity({ subject: orgAdmin.userId, sessionId: "no-such-session" });

    await expect(
      forged.query(api.projectAssignments.listProjectAssignments, {
        projectId: project.projectId,
      })
    ).rejects.toThrow(/Not authenticated/);
  });
});

// ============================================================================
// PER-USER READS — SELF OR ADMIN
// ============================================================================

describe("listUserAssignments answers for yourself, or for an admin", () => {
  it("a user reads their OWN assignments", async () => {
    // The admin member-detail page calls this with the target's id, but a user
    // asking about themselves is not administration and must not be refused.
    const t = harness();
    const { assigned, project } = await seedCast(t);

    const own = await assigned.as.query(api.projectAssignments.listUserAssignments, {
      userId: assigned.userId,
    });

    expect(own).toHaveLength(1);
    expect(own[0]?.projectId).toBe(project.projectId);
    expect(own[0]?.projectName).toBe("Tank 8");
  });

  it("a non-admin cannot read SOMEONE ELSE's assignments", async () => {
    const t = harness();
    const { assigned, outsider } = await seedCast(t);

    await expect(
      outsider.as.query(api.projectAssignments.listUserAssignments, { userId: assigned.userId })
    ).rejects.toThrow(ADMIN_REFUSED);
  });

  it("a colleague on the SAME project still cannot read their assignments", async () => {
    // Sharing a project is not administration; only the admin rule opens this.
    const t = harness();
    const { assigned, outsider, project } = await seedCast(t);
    await grantAssignment(t, {
      projectId: project.projectId,
      userId: outsider.userId,
      role: "foreman",
    });

    await expect(
      outsider.as.query(api.projectAssignments.listUserAssignments, { userId: assigned.userId })
    ).rejects.toThrow(ADMIN_REFUSED);
  });

  it("an Owner or Admin reads anyone's; a legacy Momentum app admin does not", async () => {
    const t = harness();
    const { orgAdmin, legacyMomentumAdmin, assigned } = await seedCast(t);

    await expect(
      orgAdmin.as.query(api.projectAssignments.listUserAssignments, { userId: assigned.userId })
    ).resolves.toHaveLength(1);
    await expect(
      legacyMomentumAdmin.as.query(api.projectAssignments.listUserAssignments, {
        userId: assigned.userId,
      })
    ).rejects.toThrow(ADMIN_REFUSED);
  });

  it("an unauthenticated caller reads nobody's", async () => {
    const t = harness();
    const { assigned } = await seedCast(t);

    await expect(
      t.query(api.projectAssignments.listUserAssignments, { userId: assigned.userId })
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("getUserProjectScope follows the same self-or-admin rule", () => {
  it("a user resolves their own access: whole project, in the legacy shape", async () => {
    const t = harness();
    const { assigned, project } = await seedCast(t);

    await expect(
      assigned.as.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).resolves.toEqual({
      hasAccess: true,
      isUnscoped: false,
      // A legacy foreman row is edit, reported as superintendent.
      effectiveRole: "superintendent",
      access: "edit",
      allowedWbsIds: "all",
      allowedPhaseIds: "all",
    });
  });

  it("a viewer row reads as viewer, and a WBS-scoped row as no access at all", async () => {
    const t = harness();
    const { orgAdmin, outsider, legacyMomentumAdmin, project } = await seedCast(t);
    await grantAssignment(t, {
      projectId: project.projectId,
      userId: outsider.userId,
      role: "viewer",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("projectAssignments", {
        projectId: project.projectId,
        userId: legacyMomentumAdmin.userId,
        scopeType: "wbs" as const,
        scopeId: project.wbsId,
        role: "superintendent" as const,
        assignedAt: Date.now(),
      })
    );

    await expect(
      orgAdmin.as.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: outsider.userId,
      })
    ).resolves.toMatchObject({ hasAccess: true, effectiveRole: "viewer", access: "view" });
    await expect(
      orgAdmin.as.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: legacyMomentumAdmin.userId,
      })
    ).resolves.toMatchObject({
      hasAccess: false,
      effectiveRole: null,
      allowedWbsIds: [],
      allowedPhaseIds: [],
    });
  });

  it("a non-admin cannot resolve someone else's scope, and nobody can unauthenticated", async () => {
    const t = harness();
    const { assigned, outsider, project } = await seedCast(t);

    await expect(
      outsider.as.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).rejects.toThrow(ADMIN_REFUSED);
    await expect(
      t.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).rejects.toThrow(/Not authenticated/);
  });

  it("an admin resolves anyone's scope", async () => {
    const t = harness();
    const { orgAdmin, assigned, project } = await seedCast(t);

    await expect(
      orgAdmin.as.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).resolves.toMatchObject({ hasAccess: true, effectiveRole: "superintendent" });
  });
});

// ============================================================================
// INFORMATION LEAKS
// ============================================================================

describe("failure messages do not distinguish 'no such thing' from 'not yours'", () => {
  it("a project that does not exist reads the same as one the caller may not see", async () => {
    const t = harness();
    const { outsider, project } = await seedCast(t);
    // A well-formed id for a project that was deleted before the read.
    const ghost = await seedProject(t);
    await t.run(async (ctx) => ctx.db.delete(ghost.projectId));

    const unknown = await outsider.as
      .query(api.projectAssignments.listProjectAssignments, { projectId: ghost.projectId })
      .catch((err: Error) => err.message);
    const forbidden = await outsider.as
      .query(api.projectAssignments.listProjectAssignments, { projectId: project.projectId })
      .catch((err: Error) => err.message);

    expect(forbidden).toContain(ADMIN_REFUSED);
    expect(unknown).toBe(forbidden);
  });

  it("an assignment id that does not exist reads the same as one the caller may not touch", async () => {
    // updateAssignment/removeAssignment authorize BEFORE looking the row up.
    // Reversed, "Assignment not found." would let any signed-in user probe
    // which assignment ids are live without ever being allowed to read one.
    const t = harness();
    const { outsider, project } = await seedCast(t);
    const live = must(
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("projectAssignments")
            .withIndex("by_project", (q) => q.eq("projectId", project.projectId))
            .first()
        )
      )?._id,
      "the seeded assignment"
    );
    const dead = await grantAssignment(t, {
      projectId: project.projectId,
      userId: outsider.userId,
      role: "viewer",
    });
    await t.run(async (ctx) => ctx.db.delete(dead));

    const onDead = await outsider.as
      .mutation(api.projectAssignments.removeAssignment, { assignmentId: dead })
      .catch((err: Error) => err.message);
    const onLive = await outsider.as
      .mutation(api.projectAssignments.removeAssignment, { assignmentId: live })
      .catch((err: Error) => err.message);

    expect(onLive).toContain(ADMIN_REFUSED);
    expect(onDead).toBe(onLive);
  });
});

describe("getProjectScopeTree orders by the shared domain rule (#17)", () => {
  it("lists WBS by numeric code and phases by phase number, not insertion order", async () => {
    const t = harness();
    const organizationId = await seedOrganization(t, "acme");
    const owner = await seedPrincipal(t, {
      organizationId,
      role: "owner",
      email: "owner@acme.test",
    });

    // Declaration order is deliberately shuffled, and the fixture's default
    // sortOrder is adversarial (reverse of declaration) — so a pass proves the
    // sort is by code/number, not by storage or declaration order.
    const tree = await seedProposal(t, {
      proposalNumber: "2020",
      wbs: [
        {
          poolId: 200000,
          name: "SUPPORT",
          phases: [{ phaseNumber: 2, description: "Late" }],
        },
        {
          poolId: 10000,
          name: "MOBILIZE",
          phases: [
            { phaseNumber: 3, description: "Third" },
            { phaseNumber: 1, description: "First" },
          ],
        },
        { poolId: 70000, name: "AG PIPING" },
      ],
    });
    const projectId = await t.run(async (ctx) =>
      ctx.db.insert("momentumProjects", {
        proposalId: tree.proposalId,
        name: "Tank 8",
        proposalNumber: "2020",
        ownerName: "Test Owner",
        status: "active" as const,
      })
    );

    const result = await owner.as.query(api.projectAssignments.getProjectScopeTree, { projectId });
    if (!result) throw new Error("scope tree was null");

    expect(result.wbs.map((w) => w.code)).toEqual(["10000", "70000", "200000"]);
    expect(result.phases.map((p) => p.phaseNumber)).toEqual([1, 2, 3]);
  });
});
