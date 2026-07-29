/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * `projectAssignments` — the server, not React, decides who may assign people
 * to a Momentum project.
 *
 * All ten exported functions were reachable unauthenticated. Two distinct
 * holes, and the second is the reason this file leads with mutations:
 *
 *  - PII: `listProjectAssignments` handed out every assignee's name and email.
 *  - ESCALATION: `assignUserToProject` and `bulkAssignUser` called
 *    `safeGetAuthUser` only to stamp `assignedBy` as `currentUser?._id ??
 *    undefined`. The optional chain meant a NULL USER PROCEEDED. The role that
 *    write stores is not cosmetic — `resolveUserScope` feeds it to
 *    `momentum.saveProgressEntries`, which authorizes data entry from
 *    `scope.effectiveRole`. Self-granting "superintendent" was one call.
 *
 * The guard runs against the real Better Auth component: organizations, users,
 * members and sessions are seeded into the component's own tables and the
 * caller is set with `t.withIdentity({ subject, sessionId })`, because that is
 * what `safeGetAuthUser` reads. Faking the membership lookup would make every
 * refusal below pass regardless of what the guard did.
 *
 * The axis that is NOT a refusal matters just as much: an assigned non-admin
 * must still be able to read their own project's team. Momentum is in daily
 * production use; locking assigned foremen out of the team list would be a
 * worse regression than the hole.
 */

import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { authHarness as harness, seedOrganization, seedPrincipal } from "./authFixtures";
import { seedProposal, type TestRunner } from "./convexFixtures";

/** The refusal every caller without Momentum admin standing must see. */
const ADMIN_REFUSED = "Momentum admin access required.";

/** The refusal every caller who may not see a project must see. */
const PROJECT_REFUSED = "Project access required.";

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
): Promise<Array<{ userId: string; role: string; assignedBy: string | null }>> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return rows.map((r) => ({
      userId: r.userId,
      role: r.role as string,
      // `t.run` serializes `undefined` to `null`; normalise so a test never
      // asserts on which of the two it happens to observe.
      assignedBy: r.assignedBy ?? null,
    }));
  });
}

/** Insert an assignment directly, bypassing the guard being tested. */
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

/**
 * The full cast, on one project.
 *
 * `momentumAppAdmin` is a plain org member whose Momentum app permission is
 * "admin" — granted through the real `setPermission` mutation, so the test
 * exercises the same write path production uses. That principal is the whole
 * point of the predicate: the client's `isWorkspaceAdmin` admits them, so the
 * server's `isMomentumAdmin` must too or the guard would be a capability cut.
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
  const momentumAppAdmin = await seedPrincipal(t, {
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

  await owner.as.mutation(api.appPermissions.setPermission, {
    memberId: momentumAppAdmin.memberId,
    app: "momentum",
    permission: "admin",
  });

  const project = await seedProject(t);
  await grantAssignment(t, {
    projectId: project.projectId,
    userId: assigned.userId,
    role: "foreman",
  });

  return { organizationId, owner, orgAdmin, momentumAppAdmin, assigned, outsider, project };
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
        assignments: [
          { scopeType: "project", role: "superintendent" },
          { scopeType: "wbs", scopeId: project.wbsId, role: "supervisor" },
        ],
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
      { userId: assigned.userId, role: "foreman", assignedBy: null },
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
    // `resolveUserScope` hands `effectiveRole` to momentum.saveProgressEntries,
    // which authorizes data entry from it. A self-granted "superintendent" is
    // production write access to a project the caller was never assigned to.
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

  it("an ASSIGNED non-admin cannot promote themselves out of their scope", async () => {
    // Being on the project is access, not administration. A foreman who could
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
});

// ============================================================================
// MOMENTUM ADMINS SUCCEED
// ============================================================================

describe("a Momentum admin can administer assignments", () => {
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
    // The stamp is now the authenticated admin. It used to be `undefined`
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
      assignments: [
        { scopeType: "wbs", scopeId: project.wbsId, role: "supervisor" },
        { scopeType: "phase", scopeId: project.phaseId, role: "foreman" },
      ],
    });
    expect(ids).toHaveLength(2);
    expect(await storedAssignments(t, project.projectId)).toHaveLength(3);

    const removed = await owner.as.mutation(api.projectAssignments.removeAllUserAssignments, {
      projectId: project.projectId,
      userId: outsider.userId,
    });
    expect(removed).toBe(2);
    expect(await storedAssignments(t, project.projectId)).toHaveLength(1);
  });

  it("a plain org member with momentum_permission=admin counts too — the client gate, verbatim", async () => {
    // apps/momentum/src/lib/permissions.ts admits owner OR admin OR
    // momentum_permission === "admin". If the server refused this principal,
    // the guard would be a capability cut rather than pure enforcement: the
    // assign dialog would render for them and every write would fail.
    const t = harness();
    const { momentumAppAdmin, outsider, project } = await seedCast(t);

    await momentumAppAdmin.as.mutation(api.projectAssignments.assignUserToProject, {
      projectId: project.projectId,
      userId: outsider.userId,
      scopeType: "project",
      role: "foreman",
    });

    expect(await storedAssignments(t, project.projectId)).toHaveLength(2);
  });

  it("a member whose momentum permission is only 'write' is NOT an admin", async () => {
    // The predicate is "admin", not "any grant". Without this the previous test
    // would pass for a permission row of any value.
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

  it("a precision admin has no standing in Momentum", async () => {
    const t = harness();
    const { owner, outsider, project } = await seedCast(t);

    await owner.as.mutation(api.appPermissions.setPermission, {
      memberId: outsider.memberId,
      app: "precision",
      permission: "admin",
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
});

// ============================================================================
// LOCKOUT — THE OUTCOME WORSE THAN THE HOLE
// ============================================================================

describe("an assigned non-admin can still read their own project's team", () => {
  it("listProjectAssignments answers for the foreman on the project", async () => {
    // project-team-section.tsx calls exactly this. If it became admin-only,
    // every assigned non-admin would lose the team list on a project they are
    // legitimately working — a visible production regression at InDemand.
    const t = harness();
    const { assigned, project } = await seedCast(t);

    const roster = await assigned.as.query(api.projectAssignments.listProjectAssignments, {
      projectId: project.projectId,
    });

    expect(roster).toHaveLength(1);
    expect(roster[0]?.userId).toBe(assigned.userId);
    expect(roster[0]?.scopeName).toBe("Entire Project");
  });

  it("the scope tree and the member summary answer for them too", async () => {
    const t = harness();
    const { assigned, project } = await seedCast(t);

    const tree = await assigned.as.query(api.projectAssignments.getProjectScopeTree, {
      projectId: project.projectId,
    });
    expect(tree?.wbs).toHaveLength(1);
    expect(tree?.phases).toHaveLength(1);

    const members = await assigned.as.query(api.projectAssignments.getProjectMembers, {
      projectId: project.projectId,
    });
    expect(members).toEqual([{ userId: assigned.userId, roles: ["foreman"], scopeCount: 1 }]);
  });

  it("a WBS-scoped assignment is access enough — not just project-wide ones", async () => {
    // resolveUserScope returns hasAccess for any assignment, so a narrowly
    // scoped foreman must not be refused the team list.
    const t = harness();
    const { outsider, project } = await seedCast(t);
    await t.run(async (ctx) =>
      ctx.db.insert("projectAssignments", {
        projectId: project.projectId,
        userId: outsider.userId,
        scopeType: "wbs" as const,
        scopeId: project.wbsId,
        newScopeId: project.wbsId,
        role: "foreman" as const,
        assignedAt: Date.now(),
      })
    );

    await expect(
      outsider.as.query(api.projectAssignments.listProjectAssignments, {
        projectId: project.projectId,
      })
    ).resolves.toHaveLength(2);
  });

  it("but a project with NO assignments is admin-only — the edge of the rule, recorded", async () => {
    // Elsewhere Momentum treats an unassigned project as open to everyone
    // (`getUserProjectScope`'s isUnscoped; the `if (anyAssignment)` branch in
    // saveProgressEntries). `resolveUserScope` does not, so the read guard
    // refuses a non-admin here where the empty-state copy says "all
    // organization members can access this project."
    //
    // Harmless today: the only caller, project-team-section.tsx, renders inside
    // the already admin-gated project settings page. If that section ever moves
    // to the ordinary project view, this refusal becomes a visible error where
    // an empty team list belongs — change the guard then, deliberately, rather
    // than discovering it in production.
    const t = harness();
    const { outsider, orgAdmin } = await seedCast(t);
    const empty = await seedProject(t);

    await expect(
      outsider.as.query(api.projectAssignments.listProjectAssignments, {
        projectId: empty.projectId,
      })
    ).rejects.toThrow(PROJECT_REFUSED);
    await expect(
      orgAdmin.as.query(api.projectAssignments.listProjectAssignments, {
        projectId: empty.projectId,
      })
    ).resolves.toEqual([]);
  });
});

// ============================================================================
// READS — EVERYONE ELSE IS REFUSED
// ============================================================================

describe("a project's assignments are not readable by outsiders", () => {
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

  it("an authenticated user with no assignment on the project is refused", async () => {
    const t = harness();
    const { outsider, project } = await seedCast(t);

    await expect(
      outsider.as.query(api.projectAssignments.listProjectAssignments, {
        projectId: project.projectId,
      })
    ).rejects.toThrow(PROJECT_REFUSED);
    await expect(
      outsider.as.query(api.projectAssignments.getProjectScopeTree, {
        projectId: project.projectId,
      })
    ).rejects.toThrow(PROJECT_REFUSED);
    await expect(
      outsider.as.query(api.projectAssignments.getProjectMembers, {
        projectId: project.projectId,
      })
    ).rejects.toThrow(PROJECT_REFUSED);
  });

  it("an assignment on project A is not access to project B", async () => {
    const t = harness();
    const { assigned } = await seedCast(t);
    const other = await seedProject(t);

    await expect(
      assigned.as.query(api.projectAssignments.listProjectAssignments, {
        projectId: other.projectId,
      })
    ).rejects.toThrow(PROJECT_REFUSED);
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

  it("an admin reads anyone's assignments", async () => {
    const t = harness();
    const { orgAdmin, momentumAppAdmin, assigned } = await seedCast(t);

    await expect(
      orgAdmin.as.query(api.projectAssignments.listUserAssignments, { userId: assigned.userId })
    ).resolves.toHaveLength(1);
    await expect(
      momentumAppAdmin.as.query(api.projectAssignments.listUserAssignments, {
        userId: assigned.userId,
      })
    ).resolves.toHaveLength(1);
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
  it("a user resolves their own scope on a project they are assigned to", async () => {
    const t = harness();
    const { assigned, project } = await seedCast(t);

    await expect(
      assigned.as.query(api.projectAssignments.getUserProjectScope, {
        projectId: project.projectId,
        userId: assigned.userId,
      })
    ).resolves.toMatchObject({ hasAccess: true, effectiveRole: "foreman" });
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
    ).resolves.toMatchObject({ hasAccess: true, effectiveRole: "foreman" });
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

    expect(forbidden).toContain(PROJECT_REFUSED);
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
