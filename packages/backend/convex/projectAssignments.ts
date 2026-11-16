/**
 * Momentum access, and the legacy project-assignment functions.
 *
 * Two halves, kept in one module because `momentum.ts` has always imported its
 * guards from here:
 *
 * MOMENTUM ACCESS — the Momentum shape of `model/accessResolve.ts`
 * (docs/ACCESS.md). Access is to a whole project: Owners and Admins have full
 * access, a Member has their Momentum app access plus any project they were
 * added to, highest wins. There is no WBS or phase scoping any more.
 *
 *   requireProject        one project by id, refusing below view/edit
 *   requireProjectPart    one project, keyed by a WBS, phase, activity, split,
 *                         entry or move in it
 *   readProjectLevel /    the same answers without throwing, for queries that
 *     readProjectPart     soft-fail so a live subscription degrades quietly
 *   readProjectList       which projects a list screen shows
 *   requireMomentumAdmin  project create/update/delete, reports, people
 *
 * GUARD BEFORE LOOKUP: the app gate runs before any read, and a missing id is
 * refused exactly like one the caller may not see. Callers who see every
 * project get the handler's own "not found", which tells them nothing they
 * could not already list.
 *
 * LEGACY TEAM SCREENS — the `projectAssignments` functions keep working on
 * their table for Momentum ≤ 0.1.13, Owner/Admin only. Project-scope rows count
 * as grants (`viewer` → view, any other role → edit); WBS- and phase-scoped
 * rows grant nothing, so new ones are refused. Every write to a project-scope
 * row moves the person's grant on that project to match, because the migration
 * copied the rows into grants and those screens can only see the rows.
 *
 * @see docs/ACCESS.md
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { components } from "./_generated/api";
import { byPhaseNumber, byWBSCode } from "./model/ordering";
import {
  higherRole,
  isAdminRole,
  itemLevelFor,
  meetsItemLevel,
  toOrgRole,
  type EffectiveAppAccess,
  type GrantLevel,
  type ItemLevel,
  type OrgRole,
} from "./model/access";
import {
  ITEM_REFUSAL,
  ORG_ADMIN_REFUSAL,
  VIEW_ONLY_REFUSAL,
  appAccessFor,
  findUser,
  grantOn,
  grantsOf,
  itemLevelOf,
  liftAppAccess,
  matchGrantToAssignments,
  memberKeysOf,
  membershipsOf,
  readCaller,
  refuseAccess,
  removeGrant,
  requireApp,
  requireCaller,
  requireOwnerOrAdmin,
  type AccessCaller,
  type ListScope,
} from "./model/accessResolve";

/** Shape of a Better Auth user record from the adapter. */
interface AuthUserRecord {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
}

/** Contexts these guards read from. */
type ReadCtx = QueryCtx | MutationCtx;

// ============================================================================
// MOMENTUM ACCESS
// ============================================================================

/** The caller, past Momentum's access wall. */
export interface MomentumCaller {
  caller: AccessCaller;
  /** Their Momentum access; `full` for an Owner or Admin. Never `none`. */
  appAccess: EffectiveAppAccess;
}

/** The caller and what they may do with one project. */
export interface ProjectAccess extends MomentumCaller {
  /** `full`, `edit` or `view` — never below what was required. */
  level: ItemLevel;
}

/** The tables whose rows belong to exactly one Momentum project. */
export type ProjectPart =
  | "momentumWbs"
  | "momentumPhases"
  | "momentumActivities"
  | "activitySplits"
  | "progressEntries"
  | "progressEntryMoves";

/**
 * The role name installed clients branch on (`scopeInfo.effectiveRole`).
 *
 * Momentum ≤ 0.1.13 hides every write control when this is `viewer` and
 * checks for nothing else, so two names carry the whole model.
 */
export type LegacyEffectiveRole = "viewer" | "superintendent";

/** The legacy role for a resolved level: `viewer` for view, else `superintendent`. */
export function legacyRoleFor(level: ItemLevel): LegacyEffectiveRole {
  return level === "view" ? "viewer" : "superintendent";
}

/**
 * Whether this caller sees every project, so a missing id may be named as
 * missing. Only assigned members get the item refusal for it instead.
 */
export function seesEveryProject(appAccess: EffectiveAppAccess): boolean {
  return appAccess === "full" || appAccess === "edit_all" || appAccess === "view_all";
}

/**
 * The caller's level on one project, or `null` for none.
 *
 * Reads the grant only when app access leaves the answer open: an Owner,
 * Admin or Can edit all member is decided without a read, which is every call
 * on the workbook for most of the company.
 */
async function levelOn(
  ctx: ReadCtx,
  who: MomentumCaller,
  projectId: Id<"momentumProjects">
): Promise<ItemLevel | null> {
  const grant =
    who.appAccess === "assigned" || who.appAccess === "view_all"
      ? await grantOn(ctx, who.caller.userId, { projectId })
      : undefined;
  return itemLevelFor(who.appAccess, grant);
}

/** Refuse a resolved level below `needed`, or return it. */
function requireLevel(level: ItemLevel | null, needed: GrantLevel): ItemLevel {
  if (level === null) throw refuseAccess(ITEM_REFUSAL.momentum);
  if (!meetsItemLevel(level, needed)) throw refuseAccess(VIEW_ONLY_REFUSAL.momentum);
  return level;
}

/**
 * Assert the caller may open Momentum at all.
 *
 * Refusals: not authenticated (plain Error), suspended, then "Momentum access
 * required." for No access and for a signed-in non-member.
 */
export async function requireMomentumApp(ctx: ReadCtx): Promise<MomentumCaller> {
  return requireApp(ctx, "momentum");
}

/**
 * Assert the caller may view or edit one project, before it is read.
 *
 * Refusals, in order: not authenticated; suspended; Momentum's access wall;
 * "You do not have access to this project."; "You can view this project but
 * not edit it." A missing project is refused like one the caller may not see.
 *
 * `who` lets a handler that already passed the app gate skip resolving the
 * caller a second time.
 */
export async function requireProject(
  ctx: ReadCtx,
  projectId: Id<"momentumProjects">,
  needed: GrantLevel,
  who?: MomentumCaller
): Promise<ProjectAccess> {
  const caller = who ?? (await requireMomentumApp(ctx));
  const level = requireLevel(await levelOn(ctx, caller, projectId), needed);
  return { ...caller, level };
}

/**
 * Assert the caller may view or edit the project a row belongs to, and return
 * that row.
 *
 * The row is read after the app gate and before the project check, because it
 * is the only way to learn which project it is in; nothing from it is returned
 * until the check passes. A missing row is `notFound` for callers who see
 * every project and the item refusal for everyone else, so an Only assigned
 * member cannot probe ids.
 */
export async function requireProjectPart<T extends ProjectPart>(
  ctx: ReadCtx,
  table: T,
  id: Id<T>,
  needed: GrantLevel,
  notFound: () => Error
): Promise<{ access: ProjectAccess; doc: Doc<T> }> {
  const who = await requireMomentumApp(ctx);
  const doc = await ctx.db.get(table, id);
  if (!doc) {
    if (seesEveryProject(who.appAccess)) throw notFound();
    throw refuseAccess(ITEM_REFUSAL.momentum);
  }
  const level = requireLevel(await levelOn(ctx, who, doc.projectId), needed);
  return { access: { ...who, level }, doc };
}

/**
 * The caller's access to one project, or `null` when they have none: signed
 * out, suspended, not a member, No access, or not on this project.
 *
 * For queries that answer "nothing" rather than throw, so a workbook whose
 * access was just removed shows Access Restricted instead of an error.
 */
export async function readProjectLevel(
  ctx: ReadCtx,
  projectId: Id<"momentumProjects">
): Promise<ProjectAccess | null> {
  const who = await readMomentumCaller(ctx);
  if (!who) return null;
  const level = await levelOn(ctx, who, projectId);
  return level === null ? null : { ...who, level };
}

/**
 * {@link requireProjectPart} without throwing: the row and the caller's
 * access, or `null` for any refusal and for a missing row alike.
 */
export async function readProjectPart<T extends ProjectPart>(
  ctx: ReadCtx,
  table: T,
  id: Id<T>,
  needed: GrantLevel
): Promise<{ access: ProjectAccess; doc: Doc<T> } | null> {
  const who = await readMomentumCaller(ctx);
  if (!who) return null;
  const doc = await ctx.db.get(table, id);
  if (!doc) return null;
  const level = await levelOn(ctx, who, doc.projectId);
  if (level === null || !meetsItemLevel(level, needed)) return null;
  return { access: { ...who, level }, doc };
}

/** The caller past Momentum's access wall, or `null`. Never throws. */
async function readMomentumCaller(ctx: ReadCtx): Promise<MomentumCaller | null> {
  const state = await readCaller(ctx);
  if (state.status !== "member") return null;
  const appAccess = await appAccessFor(ctx, state.caller, "momentum");
  if (appAccess === "none") return null;
  return { caller: state.caller, appAccess };
}

/**
 * Which projects the caller's list shows, or `null` for none at all.
 *
 * `seesAll` lists the table; otherwise fetch only the ids in `granted`, which
 * include legacy project-scope assignments. Never throws, because the project
 * list is the first screen and a refusal there would read as a crash.
 */
export async function readProjectList(
  ctx: ReadCtx
): Promise<ListScope<Id<"momentumProjects">> | null> {
  const who = await readMomentumCaller(ctx);
  if (!who) return null;
  const { caller, appAccess } = who;
  // Full and Can edit all already edit everything; grants add nothing.
  const granted =
    appAccess === "full" || appAccess === "edit_all"
      ? new Map<Id<"momentumProjects">, GrantLevel>()
      : (await grantsOf(ctx, caller.userId)).projects;
  return {
    caller,
    appAccess,
    seesAll: appAccess !== "assigned",
    granted,
    levelOf: (id) => itemLevelFor(appAccess, granted.get(id)),
  };
}

/**
 * Assert the caller may create, configure or delete projects, run reports and
 * manage people: an organization Owner or Admin, and nobody else.
 *
 * WHY THE LEGACY MOMENTUM `admin` NO LONGER COUNTS: it meant "administrator of
 * this app", which is now the Admin role. In production every such grant sits
 * on an org admin, so nobody loses anything.
 */
export async function requireMomentumAdmin(ctx: ReadCtx): Promise<AccessCaller> {
  return requireOwnerOrAdmin(ctx);
}

/** The caller if they are an Owner or Admin, else `null`. Never throws. */
export async function readMomentumAdmin(ctx: ReadCtx): Promise<AccessCaller | null> {
  const state = await readCaller(ctx);
  if (state.status !== "member" || !isAdminRole(state.caller.role)) return null;
  return state.caller;
}

/**
 * Whether a user, by id, is an Owner or Admin who is not suspended.
 *
 * For actions, which reach the database only through an internal query and so
 * pass the id they authenticated rather than a ctx the resolver can read.
 */
export async function isMomentumAdmin(ctx: ReadCtx, userId: string): Promise<boolean> {
  const user = await findUser(ctx, userId);
  if (!user || user.banned === true) return false;
  const members = await membershipsOf(ctx, userId);
  return members.some((member) => isAdminRole(member.role));
}

/**
 * The name the caller's work is stamped with: their name, else their email.
 *
 * The same fallback `saveProgressEntries` always used, so entries logged
 * before and after this read alike in History.
 */
export async function callerDisplayName(
  ctx: ReadCtx,
  caller: AccessCaller
): Promise<string | undefined> {
  const user = await findUser(ctx, caller.userId);
  return user?.name ?? user?.email ?? undefined;
}

/** One person's access to one project, as the legacy scope functions report it. */
export interface ProjectScope {
  hasAccess: boolean;
  /** `full`, `edit` or `view`; `null` with no access. */
  level: ItemLevel | null;
  effectiveRole: LegacyEffectiveRole | null;
}

/**
 * Any user's access to one project, by id.
 *
 * For `getUserProjectScope`, where an admin asks about someone else. The
 * caller's own checks use {@link requireProject}, which resolves the session
 * instead of trusting an id.
 */
export async function resolveUserScope(
  ctx: ReadCtx,
  projectId: Id<"momentumProjects">,
  userId: string
): Promise<ProjectScope> {
  const none: ProjectScope = { hasAccess: false, level: null, effectiveRole: null };

  const user = await findUser(ctx, userId);
  if (!user || user.banned === true) return none;
  const members = await membershipsOf(ctx, userId);
  if (members.length === 0) return none;

  const role = members.reduce<OrgRole>((best, m) => higherRole(best, toOrgRole(m.role)), "member");
  const level = await itemLevelOf(
    ctx,
    { userId, role, memberKeys: [...new Set(members.flatMap(memberKeysOf))] },
    { projectId }
  );
  if (level === null) return none;
  return { hasAccess: true, level, effectiveRole: legacyRoleFor(level) };
}

// ============================================================================
// LEGACY TEAM SCREENS — CALLER AUTHORIZATION
// ============================================================================

/**
 * Assigning by WBS or phase: refused, because it would grant nothing.
 *
 * An old Team screen still offers it. Writing the row would show the person on
 * the team while they could not open the project, which is worse than saying so.
 */
export const SCOPED_ASSIGNMENT_REFUSAL =
  "People are added to a whole project now, not to a WBS or phase. Choose Entire Project.";

/**
 * Assert the caller is `userId` themselves, or an Owner or Admin.
 *
 * WHY SELF IS ENOUGH: these reads answer "what am I on" — the caller's own
 * access is not privileged information to the caller. Reading someone else's
 * is administration and takes the admin rule.
 */
async function requireSelfOrMomentumAdmin(ctx: ReadCtx, userId: string): Promise<void> {
  const caller = await requireCaller(ctx);
  if (caller.userId === userId) return;
  if (!isAdminRole(caller.role)) throw refuseAccess(ORG_ADMIN_REFUSAL);
}

/**
 * Resolve a human-readable scope name from scope type and ID.
 */
function resolveScopeName(
  scopeType: string,
  scopeId: string | undefined,
  wbsMap: Map<string, Doc<"wbs">>,
  phaseMap: Map<string, Doc<"phases">>
): string {
  if (scopeType === "project") return "Entire Project";

  if (scopeType === "wbs" && scopeId) {
    const wbs = wbsMap.get(scopeId);
    return wbs ? `${wbs.name} (${wbs.wbsPoolId})` : `WBS ${scopeId}`;
  }

  if (scopeType === "phase" && scopeId) {
    const phase = phaseMap.get(scopeId);
    return phase ? `${phase.description} (${phase.phasePoolId})` : `Phase ${scopeId}`;
  }

  return "Unknown";
}

// ============================================================================
// VALIDATORS
// ============================================================================

const scopeTypeValidator = v.union(v.literal("project"), v.literal("wbs"), v.literal("phase"));

const projectRoleValidator = v.union(
  v.literal("superintendent"),
  v.literal("supervisor"),
  v.literal("foreman"),
  v.literal("viewer")
);

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Return the WBS + phases tree for a project's scope picker.
 *
 * Kept for the old Assign Member dialog, which renders it; only "Entire
 * Project" can be saved from it now.
 */
export const getProjectScopeTree = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    await requireMomentumAdmin(ctx);

    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const allPhases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    // Ordered by the shared domain rule so the scope pickers list WBS and
    // phases exactly as Precision and the workbook do (#17). This was the one
    // surface still rendering raw insertion order.
    return {
      wbs: byWBSCode(wbsItems).map((w) => ({
        id: w._id as string,
        code: String(w.wbsPoolId),
        name: w.name,
      })),
      phases: byPhaseNumber(allPhases).map((p) => ({
        id: p._id as string,
        wbsId: p.wbsId as string,
        code: String(p.phasePoolId),
        description: p.description,
        phaseNumber: p.phaseNumber,
      })),
    };
  },
});

/**
 * List all assignments for a project with scope names.
 *
 * Carries every assignee's name, email and avatar. Owner/Admin only, like the
 * People panel that replaces it: who is on a project is administration.
 */
export const listProjectAssignments = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    await requireMomentumAdmin(ctx);

    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    if (assignments.length === 0) return [];

    const project = await ctx.db.get(args.projectId);
    if (!project) return [];

    // Build lookup maps for scope name resolution
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();
    const wbsMap = new Map(wbsItems.map((w) => [w._id as string, w]));

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();
    const phaseMap = new Map(phases.map((p) => [p._id as string, p]));

    // Batch-fetch user details from Better Auth component
    const userIds = [...new Set(assignments.map((a) => a.userId))];
    const userMap = new Map<string, { name: string; email: string; image?: string }>();

    for (const userId of userIds) {
      try {
        const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", value: userId }],
        });
        if (raw) {
          const user = raw as unknown as AuthUserRecord;
          userMap.set(userId, {
            name: user.name ?? "",
            email: user.email ?? "",
            image: user.image,
          });
        }
      } catch {
        // User lookup failed — use userId as fallback
      }
    }

    return assignments.map((a) => ({
      id: a._id as string,
      projectId: a.projectId as string,
      userId: a.userId,
      userName: userMap.get(a.userId)?.name ?? a.userId,
      userEmail: userMap.get(a.userId)?.email ?? "",
      userImage: userMap.get(a.userId)?.image,
      scopeType: a.scopeType,
      scopeId: a.scopeId,
      scopeName: resolveScopeName(a.scopeType, a.scopeId, wbsMap, phaseMap),
      role: a.role,
      assignedBy: a.assignedBy,
      assignedAt: a.assignedAt,
    }));
  },
});

/** List all project assignments for a specific user across all projects. */
export const listUserAssignments = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await requireSelfOrMomentumAdmin(ctx, args.userId);

    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (assignments.length === 0) return [];

    // Fetch project info and scope names
    const projectIds = [...new Set(assignments.map((a) => a.projectId as string))];
    const projectMap = new Map<string, Doc<"momentumProjects">>();
    for (const id of projectIds) {
      const project = await ctx.db.get(id as Id<"momentumProjects">);
      if (project) projectMap.set(id, project);
    }

    // Resolve scope names
    const scopeNames = new Map<string, string>();
    for (const a of assignments) {
      if (a.scopeType === "project") {
        scopeNames.set(a._id as string, "Entire Project");
        continue;
      }

      if (!a.scopeId) {
        scopeNames.set(a._id as string, "Unknown");
        continue;
      }

      if (a.scopeType === "wbs") {
        const wbs = await ctx.db.get(a.scopeId as Id<"wbs">);
        scopeNames.set(
          a._id as string,
          wbs ? `${wbs.name} (${wbs.wbsPoolId})` : `WBS ${a.scopeId}`
        );
      } else if (a.scopeType === "phase") {
        const phase = await ctx.db.get(a.scopeId as Id<"phases">);
        scopeNames.set(
          a._id as string,
          phase ? `${phase.description} (${phase.phasePoolId})` : `Phase ${a.scopeId}`
        );
      }
    }

    return assignments.map((a) => ({
      id: a._id as string,
      projectId: a.projectId as string,
      projectName: projectMap.get(a.projectId as string)?.name ?? "Unknown Project",
      userId: a.userId,
      scopeType: a.scopeType,
      scopeId: a.scopeId,
      scopeName: scopeNames.get(a._id as string) ?? "Unknown",
      role: a.role,
      assignedAt: a.assignedAt,
    }));
  },
});

/**
 * One user's access to one project, in the shape released clients read.
 *
 * Access is to a whole project now, so the WBS and phase lists are `"all"`
 * with access and empty without; `isUnscoped` stays `false`, as it has been
 * since #26. `access` is the resolved level, for clients that know it.
 */
export const getUserProjectScope = query({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireSelfOrMomentumAdmin(ctx, args.userId);

    const scope = await resolveUserScope(ctx, args.projectId, args.userId);
    const everything = scope.hasAccess ? ("all" as const) : ([] as string[]);

    return {
      hasAccess: scope.hasAccess,
      isUnscoped: false,
      effectiveRole: scope.effectiveRole,
      access: scope.level,
      allowedWbsIds: everything,
      allowedPhaseIds: everything,
    };
  },
});

/** Quick summary of all members assigned to a project. Owner/Admin only. */
export const getProjectMembers = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    await requireMomentumAdmin(ctx);

    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Group by userId
    const byUser = new Map<string, { roles: Set<string>; scopeCount: number }>();
    for (const a of assignments) {
      const entry = byUser.get(a.userId) ?? { roles: new Set(), scopeCount: 0 };
      entry.roles.add(a.role);
      entry.scopeCount++;
      byUser.set(a.userId, entry);
    }

    return [...byUser.entries()].map(([userId, data]) => ({
      userId,
      roles: [...data.roles],
      scopeCount: data.scopeCount,
    }));
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Add a user to a whole project. WBS and phase scopes are refused.
 *
 * Authorized before the project is read, so a refusal is never an id oracle.
 * The returned id is stamped with the authenticated admin as `assignedBy`.
 * Their grant on the project is set to the chosen role's level, so adding
 * someone as Viewer here leaves them view-only even if the People panel had
 * given them edit.
 */
export const assignUserToProject = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
    scopeType: scopeTypeValidator,
    scopeId: v.optional(v.string()),
    role: projectRoleValidator,
  },
  handler: async (ctx, args) => {
    const caller = await requireMomentumAdmin(ctx);
    if (args.scopeType !== "project") throw refuseAccess(SCOPED_ASSIGNMENT_REFUSAL);
    if (args.scopeId) throw new Error("Project scope should not have a scopeId.");

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const existing = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId)
      )
      .collect();
    if (existing.some((a) => a.scopeType === "project")) {
      throw new Error("This user already has an assignment for this scope.");
    }

    const id = await ctx.db.insert("projectAssignments", {
      projectId: args.projectId,
      userId: args.userId,
      scopeType: "project",
      role: args.role,
      assignedBy: caller.userId,
      assignedAt: Date.now(),
    });
    await matchGrantToAssignments(ctx, {
      projectId: args.projectId,
      userId: args.userId,
      grantedBy: caller.userId,
    });
    // As adding them anywhere else does: else the row would grant nothing.
    await liftAppAccess(ctx, args.userId, "momentum");
    return id;
  },
});

/**
 * Update the role on an existing assignment.
 *
 * WHY AUTHORIZATION COMES BEFORE THE EXISTENCE CHECK: the admin predicate is
 * app-wide, so the assignment's project is irrelevant to it and resolving one
 * would buy nothing. Checking existence first, though, would leak — an
 * unauthorized caller could tell a live assignment id ("Assignment not found."
 * vs the refusal) apart from a dead one without ever being allowed to read it.
 *
 * On a project-scope row the person's grant follows, so changing them to
 * Viewer really makes them view-only.
 */
export const updateAssignment = mutation({
  args: {
    assignmentId: v.id("projectAssignments"),
    role: projectRoleValidator,
  },
  handler: async (ctx, args) => {
    const caller = await requireMomentumAdmin(ctx);

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found.");

    await ctx.db.patch(args.assignmentId, { role: args.role });
    if (assignment.scopeType === "project") {
      await matchGrantToAssignments(ctx, {
        projectId: assignment.projectId,
        userId: assignment.userId,
        grantedBy: caller.userId,
      });
    }
  },
});

/**
 * Remove an assignment. Authorized before existence — see {@link updateAssignment}.
 *
 * On a project-scope row the person's grant follows: with no project-scope
 * row left they lose the project, as the old screen tells the admin. Removing
 * a WBS or phase row leaves the grant alone, because that row never granted
 * anything.
 */
export const removeAssignment = mutation({
  args: { assignmentId: v.id("projectAssignments") },
  handler: async (ctx, args) => {
    const caller = await requireMomentumAdmin(ctx);

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found.");

    await ctx.db.delete(args.assignmentId);
    if (assignment.scopeType === "project") {
      await matchGrantToAssignments(ctx, {
        projectId: assignment.projectId,
        userId: assignment.userId,
        grantedBy: caller.userId,
      });
    }
  },
});

/**
 * Assign a user with several rows at once.
 *
 * All or nothing: one WBS or phase scope in the batch refuses the whole call
 * before anything is written, so an old dialog never half-saves.
 */
export const bulkAssignUser = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
    assignments: v.array(
      v.object({
        scopeType: scopeTypeValidator,
        scopeId: v.optional(v.string()),
        role: projectRoleValidator,
      })
    ),
  },
  handler: async (ctx, args) => {
    const caller = await requireMomentumAdmin(ctx);
    if (args.assignments.some((a) => a.scopeType !== "project")) {
      throw refuseAccess(SCOPED_ASSIGNMENT_REFUSAL);
    }

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const assignedAt = Date.now();
    const ids: Id<"projectAssignments">[] = [];
    for (const assignment of args.assignments) {
      const id = await ctx.db.insert("projectAssignments", {
        projectId: args.projectId,
        userId: args.userId,
        scopeType: "project",
        role: assignment.role,
        assignedBy: caller.userId,
        assignedAt,
      });
      ids.push(id);
    }
    if (ids.length > 0) {
      await matchGrantToAssignments(ctx, {
        projectId: args.projectId,
        userId: args.userId,
        grantedBy: caller.userId,
      });
      // As adding them anywhere else does: else the row would grant nothing.
      await liftAppAccess(ctx, args.userId, "momentum");
    }

    return ids;
  },
});

/**
 * Remove a user from one project: every assignment row, and their grant.
 *
 * The grant goes too because the migration copied their rows into it; left
 * behind, it would keep them on the project after this said they were off.
 * Returns how many assignment rows were removed.
 */
export const removeAllUserAssignments = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireMomentumAdmin(ctx);

    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId)
      )
      .collect();

    for (const assignment of assignments) {
      await ctx.db.delete(assignment._id);
    }
    await removeGrant(ctx, { projectId: args.projectId }, args.userId);

    return assignments.length;
  },
});
