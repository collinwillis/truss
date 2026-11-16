/**
 * Access: who can see and change what, for the Members, Share and People
 * screens (docs/ACCESS.md).
 *
 * One role per person, one app-access setting per Member per app, and people
 * added to single estimates or projects. The rules live in `model/access.ts`
 * and are resolved in `model/accessResolve.ts`; this module is the public
 * surface for reading your own access and for Owners/Admins to change others'.
 *
 * Legacy compatibility (`appPermissions.*`, `projectAssignments.*`) stays in
 * those modules; nothing here is called by installed apps.
 *
 * @module
 */

import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  highestLevel,
  isAdminRole,
  legacyAssignmentLevel,
  legacyToAppAccess,
  type EffectiveAppAccess,
  type GrantLevel,
  type OrgRole,
} from "./model/access";
import {
  appAccessFor,
  appOf,
  findMembership,
  findUser,
  membersOfOrganization,
  readCaller,
  refuseAccess,
  removeGrant,
  requireOwnerOrAdmin,
  setAppAccess,
  subjectForMember,
  writeGrant,
  type ItemRef,
} from "./model/accessResolve";
import { findMemberById, requireOrgAdminForMember } from "./model/orgAdmin";

// ============================================================================
// VALIDATORS AND REFUSALS
// ============================================================================

const appValidator = v.union(v.literal("precision"), v.literal("momentum"));

const appAccessValidator = v.union(
  v.literal("none"),
  v.literal("assigned"),
  v.literal("view_all"),
  v.literal("edit_all")
);

const grantLevelValidator = v.union(v.literal("view"), v.literal("edit"));

/**
 * One item, by exactly one of its ids.
 *
 * Two optional fields rather than a union, because function args must be an
 * object; {@link itemFromArgs} enforces "exactly one".
 */
const itemArgs = {
  proposalId: v.optional(v.id("proposals")),
  projectId: v.optional(v.id("momentumProjects")),
};

/** Owner and Admin rows show Full access, locked: there is nothing to set. */
export const ADMINS_HAVE_FULL_ACCESS = "Admins have full access.";

/** Turn the two optional ids into one item, refusing zero or two. */
function itemFromArgs(args: {
  proposalId?: Id<"proposals">;
  projectId?: Id<"momentumProjects">;
}): ItemRef {
  if (args.proposalId && !args.projectId) return { proposalId: args.proposalId };
  if (args.projectId && !args.proposalId) return { projectId: args.projectId };
  throw new Error("Pass exactly one of proposalId or projectId.");
}

/** Refuse an item that does not exist. Admin-only callers, so no oracle. */
async function requireItemExists(ctx: QueryCtx, item: ItemRef): Promise<void> {
  if ("proposalId" in item) {
    if (!(await ctx.db.get(item.proposalId))) throw refuseAccess("That estimate no longer exists.");
    return;
  }
  if (!(await ctx.db.get(item.projectId))) throw refuseAccess("That project no longer exists.");
}

// ============================================================================
// QUERIES
// ============================================================================

/** The signed-in person's role and app access, as `getMyAccess` returns it. */
export interface MyAccess {
  /** `null` when signed in but suspended or not a member. */
  role: OrgRole | null;
  precision: EffectiveAppAccess;
  momentum: EffectiveAppAccess;
  /**
   * Suspended, so the access walls can say so: asking to be added to an
   * estimate is the wrong advice for someone whose account is switched off.
   */
  suspended: boolean;
}

/**
 * The signed-in person's role and access to each app.
 *
 * `null` when signed out, rather than an error: both apps call this before
 * they know whether there is a session. Suspended and not-a-member answer
 * No access everywhere, because that is what they have.
 */
export const getMyAccess = query({
  args: {},
  handler: async (ctx): Promise<MyAccess | null> => {
    const state = await readCaller(ctx);
    if (state.status === "signed_out") return null;
    if (state.status !== "member") {
      return {
        role: null,
        precision: "none",
        momentum: "none",
        suspended: state.status === "suspended",
      };
    }

    const { caller } = state;
    return {
      role: caller.role,
      precision: await appAccessFor(ctx, caller, "precision"),
      momentum: await appAccessFor(ctx, caller, "momentum"),
      suspended: false,
    };
  },
});

/** One person on the Share or People panel. */
export interface ItemPerson {
  userId: string;
  name: string;
  email: string;
  image?: string;
  level: GrantLevel;
  /** When they were added; for a legacy assignment, when it was made. */
  grantedAt: number;
  /** Their app access, so the panel can say when it is switched off. */
  appAccess: EffectiveAppAccess;
  /** Suspended people keep their place but have no access while suspended. */
  suspended: boolean;
}

/** Who reaches an item without being added to it. */
export interface ImplicitAccess {
  /** Owners and Admins. */
  admins: number;
  /** Members set to Can edit all in this app. */
  editAll: number;
  /** Members set to Can view all in this app. */
  viewAll: number;
}

/**
 * The people added to one estimate or project, and a summary of who else
 * reaches it through their role or app access. Owner/Admin only.
 *
 * Legacy project-scope assignments are listed as people too (`viewer` → Can
 * view, other roles → Can edit), because they give access until migrated and
 * the panel has to show everyone who has it.
 */
export const listItemAccess = query({
  args: itemArgs,
  handler: async (ctx, args): Promise<{ people: ItemPerson[]; implicit: ImplicitAccess }> => {
    const caller = await requireOwnerOrAdmin(ctx);
    const item = itemFromArgs(args);
    const app = appOf(item);

    const added = new Map<string, { level: GrantLevel; grantedAt: number }>();
    const addPerson = (userId: string, level: GrantLevel, grantedAt: number) => {
      const current = added.get(userId);
      const best = highestLevel(current?.level, level);
      added.set(userId, {
        level: best,
        grantedAt: current && current.level === best ? current.grantedAt : grantedAt,
      });
    };

    if ("proposalId" in item) {
      const rows = await ctx.db
        .query("accessGrants")
        .withIndex("by_proposal_user", (q) => q.eq("proposalId", item.proposalId))
        .collect();
      for (const row of rows) addPerson(row.userId, row.level, row.grantedAt);
    } else {
      const rows = await ctx.db
        .query("accessGrants")
        .withIndex("by_project_user", (q) => q.eq("projectId", item.projectId))
        .collect();
      for (const row of rows) addPerson(row.userId, row.level, row.grantedAt);

      const legacy = await ctx.db
        .query("projectAssignments")
        .withIndex("by_project", (q) => q.eq("projectId", item.projectId))
        .collect();
      for (const row of legacy) {
        const level = legacyAssignmentLevel(row.scopeType, row.role);
        if (level) addPerson(row.userId, level, row.assignedAt);
      }
    }

    const implicit: ImplicitAccess = { admins: 0, editAll: 0, viewAll: 0 };
    const people: ItemPerson[] = [];

    for (const member of await membersOfOrganization(ctx, caller.organizationId)) {
      const user = await findUser(ctx, member.userId);
      if (!user) continue;
      const suspended = user.banned === true;
      const appAccess = await appAccessFor(ctx, subjectForMember(member), app);

      if (!suspended) {
        if (appAccess === "full") implicit.admins++;
        else if (appAccess === "edit_all") implicit.editAll++;
        else if (appAccess === "view_all") implicit.viewAll++;
      }

      const grant = added.get(member.userId);
      if (!grant) continue;
      people.push({
        userId: member.userId,
        name: user.name ?? "",
        email: user.email ?? "",
        image: user.image,
        level: grant.level,
        grantedAt: grant.grantedAt,
        appAccess,
        suspended,
      });
    }

    people.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    return { people, implicit };
  },
});

/** One estimate a member was added to, for the member detail page. */
export interface MemberEstimateGrant {
  proposalId: Id<"proposals">;
  proposalNumber: string;
  description: string;
  level: GrantLevel;
  grantedAt: number;
}

/** One project a member was added to, for the member detail page. */
export interface MemberProjectGrant {
  projectId: Id<"momentumProjects">;
  name: string;
  projectNumber?: string;
  level: GrantLevel;
  grantedAt: number;
}

/**
 * The estimates and projects one member was added to. Owner/Admin of the
 * member's organization only.
 *
 * Includes legacy project-scope assignments, for the same reason as
 * {@link listItemAccess}. Items deleted since are left out.
 */
export const listMemberGrants = query({
  args: { memberId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<{ estimates: MemberEstimateGrant[]; projects: MemberProjectGrant[] }> => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);

    const proposals = new Map<Id<"proposals">, { level: GrantLevel; grantedAt: number }>();
    const projects = new Map<Id<"momentumProjects">, { level: GrantLevel; grantedAt: number }>();
    const keepHighest = <K>(
      map: Map<K, { level: GrantLevel; grantedAt: number }>,
      key: K,
      level: GrantLevel,
      grantedAt: number
    ) => {
      const current = map.get(key);
      if (!current || highestLevel(current.level, level) !== current.level) {
        map.set(key, { level, grantedAt });
      }
    };

    const rows = await ctx.db
      .query("accessGrants")
      .withIndex("by_user", (q) => q.eq("userId", target.userId))
      .collect();
    for (const row of rows) {
      if (row.proposalId) keepHighest(proposals, row.proposalId, row.level, row.grantedAt);
      else if (row.projectId) keepHighest(projects, row.projectId, row.level, row.grantedAt);
    }

    const legacy = await ctx.db
      .query("projectAssignments")
      .withIndex("by_user", (q) => q.eq("userId", target.userId))
      .collect();
    for (const row of legacy) {
      const level = legacyAssignmentLevel(row.scopeType, row.role);
      if (level) keepHighest(projects, row.projectId, level, row.assignedAt);
    }

    const estimates: MemberEstimateGrant[] = [];
    for (const [proposalId, grant] of proposals) {
      const proposal = await ctx.db.get(proposalId);
      if (!proposal) continue;
      estimates.push({
        proposalId,
        proposalNumber: proposal.proposalNumber,
        description: proposal.description,
        ...grant,
      });
    }

    const projectRows: MemberProjectGrant[] = [];
    for (const [projectId, grant] of projects) {
      const project = await ctx.db.get(projectId);
      if (!project) continue;
      projectRows.push({
        projectId,
        name: project.name,
        projectNumber: project.projectNumber,
        ...grant,
      });
    }

    estimates.sort((a, b) =>
      a.proposalNumber.localeCompare(b.proposalNumber, undefined, { numeric: true })
    );
    projectRows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { estimates, projects: projectRows };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Set one Member's access to one app. Owner/Admin of their organization only.
 *
 * Owner and Admin targets are refused: their role gives full access, and a
 * stored setting under them would only resurface, unasked, if they were ever
 * made a Member.
 */
export const setMemberAppAccess = mutation({
  args: { memberId: v.string(), app: appValidator, access: appAccessValidator },
  handler: async (ctx, args): Promise<null> => {
    const { target } = await requireOrgAdminForMember(ctx, args.memberId);
    if (isAdminRole(target.role)) throw refuseAccess(ADMINS_HAVE_FULL_ACCESS);

    await setAppAccess(ctx, target._id, args.app, args.access);
    return null;
  },
});

/**
 * Add a person to one estimate or project as Can view or Can edit, or change
 * their level there. Owner/Admin only.
 *
 * The person must be an active Member of the caller's organization. Adding
 * them lifts that app from No access to Only assigned, so "add them to the
 * job" is one step.
 */
export const grantItemAccess = mutation({
  args: { ...itemArgs, userId: v.string(), level: grantLevelValidator },
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireOwnerOrAdmin(ctx);
    const item = itemFromArgs(args);
    await requireItemExists(ctx, item);

    const target = await findMembership(ctx, args.userId, caller.organizationId);
    if (!target) throw refuseAccess("They are not a member of this organization.");
    if (isAdminRole(target.role)) throw refuseAccess(ADMINS_HAVE_FULL_ACCESS);

    const user = await findUser(ctx, args.userId);
    if (!user) throw refuseAccess("They are not a member of this organization.");
    if (user.banned === true) {
      throw refuseAccess("Their account is suspended. Restore it before adding them.");
    }

    await writeGrant(ctx, {
      item,
      userId: args.userId,
      level: args.level,
      grantedBy: caller.userId,
    });
    return null;
  },
});

/**
 * Remove a person from one estimate or project. Owner/Admin only.
 *
 * For a project this also deletes their legacy project-scope assignments, so
 * the People panel stays authoritative. Their app access is left alone.
 */
export const revokeItemAccess = mutation({
  args: { ...itemArgs, userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await requireOwnerOrAdmin(ctx);
    await removeGrant(ctx, itemFromArgs(args), args.userId);
    return null;
  },
});

// ============================================================================
// MIGRATION
// ============================================================================

/** What {@link migrateToSimpleAccess} did, or would do on a dry run. */
export interface SimpleAccessMigration {
  dryRun: boolean;
  /** `appPermissions` rows given an `access` value from their legacy one. */
  accessWritten: number;
  /** `appPermissions` rows deleted because their member is an Owner/Admin. */
  adminRowsDeleted: number;
  /** Project grants created from legacy project-scope assignments. */
  grantsCreated: number;
  /** Existing project grants raised to match a higher legacy assignment. */
  grantsRaised: number;
}

/**
 * Move stored access onto the new model, changing nobody's access.
 *
 * Writes `access` on every `appPermissions` row that lacks one (from its
 * legacy value, exactly as the resolver already reads it), deletes rows that
 * belong to Owners/Admins (their role gives full access), and copies every
 * legacy project-scope assignment into `accessGrants` at its level.
 *
 * IDEMPOTENT: a row that already has `access` is never rewritten, so a setting
 * an admin changed after a first run survives a second; grants are only ever
 * created or raised to the legacy level, which the resolver already counts.
 * Legacy rows are left in place for installed apps.
 *
 * Internal, and run once by hand with approval:
 * `npx convex run access:migrateToSimpleAccess '{"dryRun": true}'` first.
 * The two tables are tiny (one row per member per app, a handful of
 * assignments), so one transaction reads them whole.
 */
export const migrateToSimpleAccess = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<SimpleAccessMigration> => {
    const dryRun = args.dryRun ?? false;
    const result: SimpleAccessMigration = {
      dryRun,
      accessWritten: 0,
      adminRowsDeleted: 0,
      grantsCreated: 0,
      grantsRaised: 0,
    };

    const roles = new Map<string, string | null>();
    for (const row of await ctx.db.query("appPermissions").collect()) {
      if (!roles.has(row.memberId)) {
        roles.set(row.memberId, (await findMemberById(ctx, row.memberId))?.role ?? null);
      }
      if (isAdminRole(roles.get(row.memberId))) {
        result.adminRowsDeleted++;
        if (!dryRun) await ctx.db.delete(row._id);
        continue;
      }
      if (row.access !== undefined) continue;
      result.accessWritten++;
      if (!dryRun)
        await ctx.db.patch(row._id, { access: legacyToAppAccess(row.app, row.permission) });
    }

    const wanted = new Map<
      string,
      {
        projectId: Id<"momentumProjects">;
        userId: string;
        level: GrantLevel;
        grantedBy: string;
        grantedAt: number;
      }
    >();
    for (const row of await ctx.db.query("projectAssignments").collect()) {
      const level = legacyAssignmentLevel(row.scopeType, row.role);
      if (!level) continue;
      const key = `${row.projectId}:${row.userId}`;
      const current = wanted.get(key);
      if (current && highestLevel(current.level, level) === current.level) continue;
      wanted.set(key, {
        projectId: row.projectId,
        userId: row.userId,
        level,
        grantedBy: row.assignedBy ?? "migration",
        grantedAt: row.assignedAt,
      });
    }

    for (const grant of wanted.values()) {
      const existing = await ctx.db
        .query("accessGrants")
        .withIndex("by_project_user", (q) =>
          q.eq("projectId", grant.projectId).eq("userId", grant.userId)
        )
        .first();
      if (!existing) {
        result.grantsCreated++;
        if (!dryRun) await ctx.db.insert("accessGrants", grant);
      } else if (highestLevel(existing.level, grant.level) !== existing.level) {
        result.grantsRaised++;
        if (!dryRun) await ctx.db.patch(existing._id, { level: grant.level });
      }
    }

    return result;
  },
});
