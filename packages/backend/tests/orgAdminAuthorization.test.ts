/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * D-orgauthz — the server, not React, decides who may administer an organization.
 *
 * Every function behind Admin → Members was enforced only in the client, so any
 * authenticated account could read the roster with emails, ban or remove
 * colleagues, change roles, and — through `setPermission` — grant ITSELF `admin`
 * on either application.
 *
 * These tests exercise the real guard through the real Better Auth component:
 * organizations, members, users and sessions are seeded into the component's own
 * tables, and the caller is set with `t.withIdentity({ subject, sessionId })`
 * because that is exactly what `safeGetAuthUser` reads. A harness that faked the
 * membership lookup would pass no matter what the guard did.
 *
 * The axis that matters most is NOT a refusal: `getMemberPermissions` is how a
 * plain member learns what they may open, in both apps, on every session. If it
 * became admin-only, every non-admin would be locked out of Momentum and
 * Precision entirely — a worse outcome than the hole being closed.
 *
 * @see docs/precision/DECISIONS.md D-orgauthz
 */

import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { describe, expect, it } from "vitest";

import { api, components } from "../convex/_generated/api";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";
import type { TestRunner } from "./convexFixtures";

const modules = import.meta.glob("../convex/**/*.*s");
const authModules = import.meta.glob("../convex/betterAuth/**/*.*s");

/** The refusal every unauthorized caller must see, verbatim. */
const REFUSED = "Organization admin access required.";

/** A seeded principal: their Better Auth ids plus a `t` bound to their session. */
interface Principal {
  userId: string;
  memberId: string;
  /** `t` scoped to this principal's identity — call functions through this. */
  as: ReturnType<TestRunner["withIdentity"]>;
}

/**
 * Build a test instance with the Better Auth component registered.
 *
 * WHY THE COMPONENT IS REGISTERED RATHER THAN STUBBED: the guard resolves the
 * caller's membership through `components.betterAuth.adapter`. Stub that and the
 * test stops proving anything about authorization.
 */
function harness(): TestRunner {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

/** The `create` argument shape, narrowed to the four models these tests seed. */
type CreateArgs = FunctionArgs<typeof components.betterAuth.adapter.create>;
type SeedableInput = Extract<
  CreateArgs["input"],
  { model: "user" | "session" | "organization" | "member" }
>;

/** Insert a row into a Better Auth component table. */
async function createAuthRow(t: TestRunner, input: SeedableInput): Promise<{ _id: string }> {
  const created = await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, { input })
  );
  return created as { _id: string };
}

/** Seed an organization and return its id. */
async function seedOrganization(t: TestRunner, slug: string): Promise<string> {
  const org = await createAuthRow(t, {
    model: "organization",
    data: { name: slug, slug, createdAt: Date.now() },
  });
  return org._id;
}

/**
 * Seed a user, their membership in `organizationId`, and a live session.
 *
 * The session is not decoration: `safeGetAuthUser` refuses an identity whose
 * session row is missing or expired, so without it every caller would read as
 * unauthenticated and every assertion below would pass vacuously.
 */
async function seedPrincipal(
  t: TestRunner,
  options: { organizationId: string; role: "owner" | "admin" | "member"; email: string }
): Promise<Principal> {
  const now = Date.now();

  const user = await createAuthRow(t, {
    model: "user",
    data: {
      name: options.email,
      email: options.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const member = await createAuthRow(t, {
    model: "member",
    data: {
      organizationId: options.organizationId,
      userId: user._id,
      role: options.role,
      createdAt: now,
    },
  });

  const session = await createAuthRow(t, {
    model: "session",
    data: {
      userId: user._id,
      token: `token-${options.email}`,
      expiresAt: now + 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    },
  });

  return {
    userId: user._id,
    memberId: member._id,
    as: t.withIdentity({ subject: user._id, sessionId: session._id }),
  };
}

/** Read a member's app permission straight from the table, bypassing the guard. */
async function storedPermission(
  t: TestRunner,
  memberId: string,
  app: "precision" | "momentum"
): Promise<string> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("appPermissions")
      .withIndex("by_member_app", (q) => q.eq("memberId", memberId).eq("app", app))
      .unique();
    return row?.permission ?? "none";
  });
}

/** Read a Better Auth member row's role, bypassing the guard. */
async function storedRole(t: TestRunner, memberId: string): Promise<string | null> {
  const row = await t.run(async (ctx) =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "member",
      where: [{ field: "_id", value: memberId }],
    })
  );
  return (row as { role?: string } | null)?.role ?? null;
}

/** Read a Better Auth user row's ban flag, bypassing the guard. */
async function storedBanned(t: TestRunner, userId: string): Promise<boolean> {
  const row = await t.run(async (ctx) =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: userId }],
    })
  );
  return (row as { banned?: boolean } | null)?.banned === true;
}

/** A single organization with an owner, an admin, and a plain member. */
async function seedOrgWithCast(t: TestRunner, slug: string) {
  const organizationId = await seedOrganization(t, slug);
  const owner = await seedPrincipal(t, {
    organizationId,
    role: "owner",
    email: `owner@${slug}.test`,
  });
  const admin = await seedPrincipal(t, {
    organizationId,
    role: "admin",
    email: `admin@${slug}.test`,
  });
  const member = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: `member@${slug}.test`,
  });
  return { organizationId, owner, admin, member };
}

// ============================================================================
// THE HARNESS ITSELF
// ============================================================================

describe("the harness really authenticates", () => {
  it("an admin's identity resolves — so a refusal below means authorization, not a broken fixture", async () => {
    // Without this, every `rejects.toThrow` in this file could be passing
    // because `safeGetAuthUser` returned undefined for everybody.
    const t = harness();
    const { organizationId, admin } = await seedOrgWithCast(t, "acme");

    const roster = await admin.as.query(api.adminUsers.listOrganizationMembers, {
      organizationId,
    });

    expect(roster).toHaveLength(3);
    expect(roster.map((r) => r.email).sort()).toEqual([
      "admin@acme.test",
      "member@acme.test",
      "owner@acme.test",
    ]);
  });
});

// ============================================================================
// UNAUTHENTICATED
// ============================================================================

describe("an unauthenticated caller reaches nothing", () => {
  it("is refused every function on the members surface", async () => {
    const t = harness();
    const { organizationId, member } = await seedOrgWithCast(t, "acme");

    await expect(
      t.query(api.adminUsers.listOrganizationMembers, { organizationId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.adminUsers.getMemberDetail, { memberId: member.memberId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.mutation(api.adminUsers.updateMemberRole, { memberId: member.memberId, role: "admin" })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.mutation(api.adminUsers.banMember, { memberId: member.memberId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.mutation(api.adminUsers.unbanMember, { memberId: member.memberId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.mutation(api.adminUsers.removeMember, { memberId: member.memberId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.mutation(api.appPermissions.setPermission, {
        memberId: member.memberId,
        app: "precision",
        permission: "admin",
      })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.appPermissions.getMemberPermissions, { memberId: member.memberId })
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.appPermissions.checkPermission, {
        memberId: member.memberId,
        app: "precision",
        requiredPermission: "read",
      })
    ).rejects.toThrow(/Not authenticated/);
  });

  it("an identity with no live session counts as unauthenticated", async () => {
    // safeGetAuthUser validates the session row, so a forged subject alone is
    // not enough. If it were, every guard here would be bypassable.
    const t = harness();
    const { organizationId, admin } = await seedOrgWithCast(t, "acme");

    const forged = t.withIdentity({ subject: admin.userId, sessionId: "no-such-session" });

    await expect(
      forged.query(api.adminUsers.listOrganizationMembers, { organizationId })
    ).rejects.toThrow(/Not authenticated/);
  });
});

// ============================================================================
// PLAIN MEMBER
// ============================================================================

describe("a plain member of the organization is refused every admin function", () => {
  it("cannot read the roster", async () => {
    const t = harness();
    const { organizationId, member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.query(api.adminUsers.listOrganizationMembers, { organizationId })
    ).rejects.toThrow(REFUSED);
  });

  it("cannot read a colleague's detail", async () => {
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.query(api.adminUsers.getMemberDetail, { memberId: admin.memberId })
    ).rejects.toThrow(REFUSED);
  });

  it("cannot promote themselves", async () => {
    const t = harness();
    const { member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.mutation(api.adminUsers.updateMemberRole, {
        memberId: member.memberId,
        role: "admin",
      })
    ).rejects.toThrow(REFUSED);

    expect(await storedRole(t, member.memberId)).toBe("member");
  });

  it("cannot ban, unban or remove a colleague", async () => {
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.mutation(api.adminUsers.banMember, { memberId: admin.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      member.as.mutation(api.adminUsers.unbanMember, { memberId: admin.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      member.as.mutation(api.adminUsers.removeMember, { memberId: admin.memberId })
    ).rejects.toThrow(REFUSED);

    expect(await storedBanned(t, admin.userId)).toBe(false);
    expect(await storedRole(t, admin.memberId)).toBe("admin");
  });

  it("cannot grant ITSELF admin on an application — the escalation that made this urgent", async () => {
    const t = harness();
    const { member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.mutation(api.appPermissions.setPermission, {
        memberId: member.memberId,
        app: "precision",
        permission: "admin",
      })
    ).rejects.toThrow(REFUSED);

    expect(await storedPermission(t, member.memberId, "precision")).toBe("none");
  });

  it("cannot read a colleague's app permissions", async () => {
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.query(api.appPermissions.getMemberPermissions, { memberId: admin.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      member.as.query(api.appPermissions.checkPermission, {
        memberId: admin.memberId,
        app: "momentum",
        requiredPermission: "read",
      })
    ).rejects.toThrow(REFUSED);
  });
});

// ============================================================================
// LOCKOUT — THE OUTCOME WORSE THAN THE HOLE
// ============================================================================

describe("a plain member can still resolve their OWN permissions", () => {
  it("getMemberPermissions returns their grants without any admin role", async () => {
    // WorkspaceProvider calls exactly this, with the signed-in user's own
    // memberId, on every session in both apps. If it threw, every non-admin
    // would land on "none/none" and be locked out of Momentum and Precision.
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await admin.as.mutation(api.appPermissions.setPermission, {
      memberId: member.memberId,
      app: "momentum",
      permission: "write",
    });

    const permissions = await member.as.query(api.appPermissions.getMemberPermissions, {
      memberId: member.memberId,
    });

    expect(permissions).toEqual({ precision: "none", momentum: "write" });
  });

  it("checkPermission answers for their own membership too", async () => {
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await admin.as.mutation(api.appPermissions.setPermission, {
      memberId: member.memberId,
      app: "precision",
      permission: "read",
    });

    await expect(
      member.as.query(api.appPermissions.checkPermission, {
        memberId: member.memberId,
        app: "precision",
        requiredPermission: "read",
      })
    ).resolves.toBe(true);
    await expect(
      member.as.query(api.appPermissions.checkPermission, {
        memberId: member.memberId,
        app: "precision",
        requiredPermission: "admin",
      })
    ).resolves.toBe(false);
  });

  it("a member with no grants reads none/none rather than an error", async () => {
    // The zero-permission case is the one a fresh hire hits, and it must be a
    // value, not a thrown error the provider would surface as a broken session.
    const t = harness();
    const { member } = await seedOrgWithCast(t, "acme");

    await expect(
      member.as.query(api.appPermissions.getMemberPermissions, { memberId: member.memberId })
    ).resolves.toEqual({ precision: "none", momentum: "none" });
  });
});

// ============================================================================
// ADMIN AND OWNER SUCCEED
// ============================================================================

describe("an owner or admin of the organization can administer it", () => {
  it("an admin reads the roster and a member's detail", async () => {
    const t = harness();
    const { organizationId, member, admin } = await seedOrgWithCast(t, "acme");

    const roster = await admin.as.query(api.adminUsers.listOrganizationMembers, {
      organizationId,
    });
    expect(roster).toHaveLength(3);

    const detail = await admin.as.query(api.adminUsers.getMemberDetail, {
      memberId: member.memberId,
    });
    expect(detail?.email).toBe("member@acme.test");
  });

  it("an admin promotes, bans, unbans and removes a member", async () => {
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await admin.as.mutation(api.adminUsers.updateMemberRole, {
      memberId: member.memberId,
      role: "admin",
    });
    expect(await storedRole(t, member.memberId)).toBe("admin");

    await admin.as.mutation(api.adminUsers.banMember, {
      memberId: member.memberId,
      reason: "policy",
    });
    expect(await storedBanned(t, member.userId)).toBe(true);

    await admin.as.mutation(api.adminUsers.unbanMember, { memberId: member.memberId });
    expect(await storedBanned(t, member.userId)).toBe(false);

    await admin.as.mutation(api.adminUsers.removeMember, { memberId: member.memberId });
    expect(await storedRole(t, member.memberId)).toBeNull();
  });

  it("an admin sets a member's app permission", async () => {
    const t = harness();
    const { admin, member } = await seedOrgWithCast(t, "acme");

    await admin.as.mutation(api.appPermissions.setPermission, {
      memberId: member.memberId,
      app: "precision",
      permission: "write",
    });

    expect(await storedPermission(t, member.memberId, "precision")).toBe("write");
  });

  it("an owner can administer too", async () => {
    const t = harness();
    const { organizationId, owner, member } = await seedOrgWithCast(t, "acme");

    await expect(
      owner.as.query(api.adminUsers.listOrganizationMembers, { organizationId })
    ).resolves.toHaveLength(3);

    await owner.as.mutation(api.adminUsers.updateMemberRole, {
      memberId: member.memberId,
      role: "admin",
    });
    expect(await storedRole(t, member.memberId)).toBe("admin");
  });
});

// ============================================================================
// CROSS-ORGANIZATION
// ============================================================================

describe("authorization is scoped to the TARGET's organization, not the caller's", () => {
  it("an admin of org B cannot read org A's roster", async () => {
    const t = harness();
    const orgA = await seedOrgWithCast(t, "acme");
    const orgB = await seedOrgWithCast(t, "globex");

    await expect(
      orgB.admin.as.query(api.adminUsers.listOrganizationMembers, {
        organizationId: orgA.organizationId,
      })
    ).rejects.toThrow(REFUSED);
  });

  it("an admin of org B cannot act on a member of org A by passing their memberId", async () => {
    // This is the subtle failure the guard exists to prevent: checking the
    // caller against their OWN organization would let every one of these
    // through, and would look correct while doing it.
    const t = harness();
    const orgA = await seedOrgWithCast(t, "acme");
    const orgB = await seedOrgWithCast(t, "globex");
    const victim = orgA.member;

    await expect(
      orgB.admin.as.query(api.adminUsers.getMemberDetail, { memberId: victim.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      orgB.admin.as.mutation(api.adminUsers.updateMemberRole, {
        memberId: victim.memberId,
        role: "admin",
      })
    ).rejects.toThrow(REFUSED);
    await expect(
      orgB.admin.as.mutation(api.adminUsers.banMember, { memberId: victim.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      orgB.admin.as.mutation(api.adminUsers.unbanMember, { memberId: victim.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      orgB.admin.as.mutation(api.adminUsers.removeMember, { memberId: victim.memberId })
    ).rejects.toThrow(REFUSED);
    await expect(
      orgB.admin.as.mutation(api.appPermissions.setPermission, {
        memberId: victim.memberId,
        app: "momentum",
        permission: "admin",
      })
    ).rejects.toThrow(REFUSED);
    await expect(
      orgB.admin.as.query(api.appPermissions.getMemberPermissions, { memberId: victim.memberId })
    ).rejects.toThrow(REFUSED);

    expect(await storedRole(t, victim.memberId)).toBe("member");
    expect(await storedBanned(t, victim.userId)).toBe(false);
    expect(await storedPermission(t, victim.memberId, "momentum")).toBe("none");
  });

  it("an owner of org B has no standing in org A either", async () => {
    const t = harness();
    const orgA = await seedOrgWithCast(t, "acme");
    const orgB = await seedOrgWithCast(t, "globex");

    await expect(
      orgB.owner.as.mutation(api.adminUsers.removeMember, { memberId: orgA.member.memberId })
    ).rejects.toThrow(REFUSED);
  });

  it("a signed-in user who belongs to no organization is refused", async () => {
    const t = harness();
    const orgA = await seedOrgWithCast(t, "acme");
    // Membership in a throwaway org, then act against acme: authentication
    // succeeds, authorization must not.
    const orphanOrg = await seedOrganization(t, "orphan");
    const orphan = await seedPrincipal(t, {
      organizationId: orphanOrg,
      role: "owner",
      email: "orphan@orphan.test",
    });

    await expect(
      orphan.as.query(api.adminUsers.listOrganizationMembers, {
        organizationId: orgA.organizationId,
      })
    ).rejects.toThrow(REFUSED);
  });
});

// ============================================================================
// INFORMATION LEAKS
// ============================================================================

describe("failure messages do not distinguish outsider from non-admin", () => {
  it("an outsider and a plain member get the identical refusal", async () => {
    // Two different messages would confirm to an outsider that the organization
    // exists and that they are not in it.
    const t = harness();
    const orgA = await seedOrgWithCast(t, "acme");
    const orgB = await seedOrgWithCast(t, "globex");

    const insider = await orgA.member.as
      .query(api.adminUsers.listOrganizationMembers, { organizationId: orgA.organizationId })
      .catch((err: Error) => err.message);
    const outsider = await orgB.admin.as
      .query(api.adminUsers.listOrganizationMembers, { organizationId: orgA.organizationId })
      .catch((err: Error) => err.message);

    expect(insider).toContain(REFUSED);
    expect(outsider).toContain(REFUSED);
    expect(outsider).toBe(insider);
  });

  it("an organization id that does not exist reads the same as one the caller may not see", async () => {
    const t = harness();
    const orgA = await seedOrgWithCast(t, "acme");

    const unknown = await orgA.member.as
      .query(api.adminUsers.listOrganizationMembers, { organizationId: "no-such-org" })
      .catch((err: Error) => err.message);
    const forbidden = await orgA.member.as
      .query(api.adminUsers.listOrganizationMembers, { organizationId: orgA.organizationId })
      .catch((err: Error) => err.message);

    expect(unknown).toBe(forbidden);
  });
});

// ============================================================================
// OWNER RULES
// ============================================================================

describe("owner-target rules are per-action, not blanket", () => {
  it("an admin cannot demote, ban, remove, or downgrade the owner", async () => {
    const t = harness();
    const { admin, owner } = await seedOrgWithCast(t, "acme");

    await expect(
      admin.as.mutation(api.adminUsers.updateMemberRole, {
        memberId: owner.memberId,
        role: "member",
      })
    ).rejects.toThrow(/Cannot change the role of the organization owner/);
    await expect(
      admin.as.mutation(api.adminUsers.banMember, { memberId: owner.memberId })
    ).rejects.toThrow(/Cannot ban the organization owner/);
    await expect(
      admin.as.mutation(api.adminUsers.removeMember, { memberId: owner.memberId })
    ).rejects.toThrow(/Cannot remove the organization owner/);
    await expect(
      admin.as.mutation(api.appPermissions.setPermission, {
        memberId: owner.memberId,
        app: "precision",
        permission: "none",
      })
    ).rejects.toThrow(/Cannot change app access for the organization owner/);

    expect(await storedRole(t, owner.memberId)).toBe("owner");
    expect(await storedBanned(t, owner.userId)).toBe(false);
  });

  it("the owner cannot demote or remove THEMSELVES either", async () => {
    // The rule is about the target, not the caller — otherwise an owner could
    // strand the organization with a misclick.
    const t = harness();
    const { owner } = await seedOrgWithCast(t, "acme");

    await expect(
      owner.as.mutation(api.adminUsers.updateMemberRole, {
        memberId: owner.memberId,
        role: "member",
      })
    ).rejects.toThrow(/Cannot change the role of the organization owner/);
    await expect(
      owner.as.mutation(api.adminUsers.removeMember, { memberId: owner.memberId })
    ).rejects.toThrow(/Cannot remove the organization owner/);
  });

  it("unbanning the owner IS allowed — a locked-out owner must be recoverable", async () => {
    const t = harness();
    const { admin, owner } = await seedOrgWithCast(t, "acme");

    // Ban the owner out-of-band, as an earlier bug or a direct write could.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "user",
          where: [{ field: "_id", value: owner.userId }],
          update: { banned: true, banReason: "stranded" },
        },
      });
    });
    expect(await storedBanned(t, owner.userId)).toBe(true);

    await admin.as.mutation(api.adminUsers.unbanMember, { memberId: owner.memberId });

    expect(await storedBanned(t, owner.userId)).toBe(false);
  });
});
