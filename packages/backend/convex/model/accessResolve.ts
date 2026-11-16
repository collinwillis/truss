/**
 * Who the caller is, and what they may see and change — the one chokepoint.
 *
 * Every Precision and Momentum function asks its access question here, so the
 * rules in `model/access.ts` (docs/ACCESS.md) are applied the same way
 * everywhere. Before this, four overlapping systems were each read in their own
 * module: the org role, a per-app level Momentum ignored, project roles, and
 * WBS/phase scoping.
 *
 * Which helper to call:
 *
 *   requireItem(ctx, { proposalId } | { projectId }, "view" | "edit")
 *                         one estimate or project; returns caller and level
 *   requireProposalList / requireProjectList
 *                         list screens: which items to show, at what level
 *   requireApp(ctx, app)  opening an app or reading app-wide reference data
 *   requireStartEstimate  creating an estimate (then writeGrant the creator)
 *   requireOwnerOrAdmin   rate books, members, sharing, project settings
 *   readCaller            null-safe identity, for queries that must not throw
 *   writeGrant / removeGrant / matchGrantToAssignments / setAppAccess
 *                         the only writers of `accessGrants` and `access`
 *
 * GUARD BEFORE LOOKUP: none of these read the item they authorize, so a caller
 * cannot tell a missing id from one they may not see. Call them before
 * `ctx.db.get`, never after.
 *
 * SINGLE-TENANT, deliberately: memberships are found by user id alone, as
 * `precisionAccess.ts` and `projectAssignments.ts` did, because proposals carry
 * no organization. That is safe only while `auth.ts` keeps
 * `allowUserToCreateOrganization: false`; scope this lookup first if
 * self-serve organizations are ever turned on.
 *
 * @module
 */

import { ConvexError } from "convex/values";

import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import {
  higherRole,
  highestAppAccess,
  highestLevel,
  isAdminRole,
  itemLevelFor,
  legacyAssignmentLevel,
  legacyLevelFor,
  legacyRoleForLevel,
  legacyToAppAccess,
  liftedAppAccess,
  mayOpenApp,
  mayStartEstimate,
  meetsItemLevel,
  toOrgRole,
  type AppAccess,
  type AppName,
  type EffectiveAppAccess,
  type GrantLevel,
  type ItemLevel,
  type LegacyPermission,
  type OrgRole,
} from "./access";

// ============================================================================
// REFUSALS
// ============================================================================

/**
 * The `kind` on every access refusal, so a client can tell "you may not" from
 * a crash and show the message.
 *
 * ConvexError rather than Error because Convex redacts a plain Error's message
 * in production, and these sentences are written for the person reading them.
 */
export const ACCESS_REFUSED = "access_refused" as const;

/**
 * The data an {@link ACCESS_REFUSED} error carries. A type alias, not an
 * interface, because ConvexError data must be a plain Convex value.
 */
export type AccessRefusal = {
  kind: typeof ACCESS_REFUSED;
  message: string;
};

/** Build an access refusal whose sentence the UI shows as written. */
export function refuseAccess(message: string): ConvexError<AccessRefusal> {
  return new ConvexError({ kind: ACCESS_REFUSED, message });
}

/**
 * No identity at all. A plain Error, as everywhere else in the backend: every
 * existing client and test recognises this sentence, and "sign in" is a
 * different remedy from "ask an administrator".
 */
export const NOT_AUTHENTICATED = "Not authenticated.";

/** A banned (suspended) account: refused everywhere, before anything else. */
export const SUSPENDED_REFUSAL = "Your account is suspended. Ask an administrator to restore it.";

/**
 * Owner/Admin-only surfaces. The sentence `model/orgAdmin.ts` uses, so every
 * administration refusal reads alike.
 */
export const ORG_ADMIN_REFUSAL = "Organization admin access required.";

/** A Member whose app access is No access: the access wall. */
export const APP_REFUSAL: Readonly<Record<AppName, string>> = {
  precision: "Precision access required.",
  momentum: "Momentum access required.",
};

/**
 * An item the caller may not open at all. A missing id gets the same
 * sentence, so the refusal is never an existence oracle.
 */
export const ITEM_REFUSAL: Readonly<Record<AppName, string>> = {
  precision: "You do not have access to this estimate.",
  momentum: "You do not have access to this project.",
};

/** An item the caller may open but not change. */
export const VIEW_ONLY_REFUSAL: Readonly<Record<AppName, string>> = {
  precision: "You can view this estimate but not edit it.",
  momentum: "You can view this project but not edit it.",
};

/** A Can view all member trying to start an estimate. */
export const START_ESTIMATE_REFUSAL = "You can view estimates but not start new ones.";

// ============================================================================
// IDENTITY AND MEMBERSHIP
// ============================================================================

/** Contexts the resolver reads from. */
type ReadCtx = QueryCtx | MutationCtx;

/** The Better Auth membership fields this module reasons about. */
export interface MemberRow {
  _id: string;
  /** Some adapter paths surface the id here too; see {@link memberKeysOf}. */
  id?: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt?: number;
}

/** The Better Auth user fields this backend reads. */
export interface AuthUserRow {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
  banned?: boolean;
  banReason?: string;
}

function asMember(record: Record<string, unknown>): MemberRow {
  return record as unknown as MemberRow;
}

function asUser(record: Record<string, unknown>): AuthUserRow {
  return record as unknown as AuthUserRow;
}

/**
 * Anyone whose access can be resolved: the caller, or a member an admin is
 * looking at.
 */
export interface AccessSubject {
  /** Better Auth user id; `accessGrants` and `projectAssignments` key on it. */
  userId: string;
  role: OrgRole;
  /** Every id this person's `appPermissions` rows may be keyed by. */
  memberKeys: readonly string[];
}

/** The signed-in caller: a subject plus the membership they act through. */
export interface AccessCaller extends AccessSubject {
  organizationId: string;
  /** The membership id their own `appPermissions` rows are written under. */
  memberId: string;
}

/**
 * The caller, without throwing, for queries that answer "nothing" instead.
 *
 * Suspended and outsider are kept apart from signed out because the remedies
 * differ (ask an administrator, versus sign in), though none has any access.
 */
export type CallerState =
  | { status: "signed_out" }
  | { status: "suspended"; userId: string }
  | { status: "outsider"; userId: string }
  | { status: "member"; caller: AccessCaller };

/**
 * The ids an `appPermissions` row for this membership may carry.
 *
 * WHY BOTH: rows are written with the member id the client passes as
 * `currentMember.id`, while the adapter surfaces `_id` on raw rows. They agree
 * in practice; matching only one would silently resolve a granted member to
 * the default if they ever did not.
 */
export function memberKeysOf(member: MemberRow): string[] {
  const keys = [member._id];
  if (typeof member.id === "string" && member.id !== member._id) keys.push(member.id);
  return keys;
}

/** The subject one membership row describes. */
export function subjectForMember(member: MemberRow): AccessSubject {
  return { userId: member.userId, role: toOrgRole(member.role), memberKeys: memberKeysOf(member) };
}

/** Every membership a user holds (one, in a single-tenant deployment). */
export async function membershipsOf(ctx: ReadCtx, userId: string): Promise<MemberRow[]> {
  const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "member",
    where: [{ field: "userId", value: userId }],
    paginationOpts: { cursor: null, numItems: 50 },
  });
  return ((result?.page ?? []) as Array<Record<string, unknown>>).map(asMember);
}

/** A user's membership in one organization, or `null`. */
export async function findMembership(
  ctx: ReadCtx,
  userId: string,
  organizationId: string
): Promise<MemberRow | null> {
  const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "member",
    where: [
      { field: "userId", value: userId },
      { field: "organizationId", value: organizationId },
    ],
  });
  return raw ? asMember(raw) : null;
}

/** Every membership of one organization (capped at 500, like the roster). */
export async function membersOfOrganization(
  ctx: ReadCtx,
  organizationId: string
): Promise<MemberRow[]> {
  const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "member",
    where: [{ field: "organizationId", value: organizationId }],
    paginationOpts: { cursor: null, numItems: 500 },
  });
  return ((result?.page ?? []) as Array<Record<string, unknown>>).map(asMember);
}

/** A Better Auth user row, or `null`. */
export async function findUser(ctx: ReadCtx, userId: string): Promise<AuthUserRow | null> {
  const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", value: userId }],
  });
  return raw ? asUser(raw) : null;
}

/**
 * The signed-in user, refusing a banned one.
 *
 * WHY HERE AND NOT ONLY AT SIGN-IN: `adminUsers.banMember` sets `banned` on the
 * user row directly and does not revoke sessions, so a suspended person's
 * session keeps working until something on the server refuses it. This is
 * that something, and every guard goes through it.
 */
export async function requireActiveUser(ctx: ReadCtx): Promise<{ _id: string }> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error(NOT_AUTHENTICATED);
  if (user.banned === true) throw refuseAccess(SUSPENDED_REFUSAL);
  return user;
}

/**
 * Resolve the caller without throwing.
 *
 * With several memberships (impossible today), the most privileged role wins
 * and every membership's app rows count, matching what `precisionAccess.ts`
 * did; the membership acted through is the one that carries that role.
 */
export async function readCaller(ctx: ReadCtx): Promise<CallerState> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return { status: "signed_out" };
  if (user.banned === true) return { status: "suspended", userId: user._id };

  const members = await membershipsOf(ctx, user._id);
  const [first] = members;
  if (!first) return { status: "outsider", userId: user._id };

  const role = members.reduce<OrgRole>((best, m) => higherRole(best, toOrgRole(m.role)), "member");
  const primary = members.find((m) => toOrgRole(m.role) === role) ?? first;

  return {
    status: "member",
    caller: {
      userId: user._id,
      role: toOrgRole(primary.role),
      memberKeys: [...new Set(members.flatMap(memberKeysOf))],
      organizationId: primary.organizationId,
      memberId: primary._id,
    },
  };
}

/**
 * The caller, or a refusal: not authenticated, suspended, or — for someone
 * signed in with no membership — `outsiderRefusal`.
 */
async function callerOr(ctx: ReadCtx, outsiderRefusal: string): Promise<AccessCaller> {
  const state = await readCaller(ctx);
  switch (state.status) {
    case "signed_out":
      throw new Error(NOT_AUTHENTICATED);
    case "suspended":
      throw refuseAccess(SUSPENDED_REFUSAL);
    case "outsider":
      throw refuseAccess(outsiderRefusal);
    case "member":
      return state.caller;
  }
}

/** The caller, who must be an active member of the organization. */
export async function requireCaller(ctx: ReadCtx): Promise<AccessCaller> {
  return callerOr(ctx, "Organization membership required.");
}

/** The caller, who must be an Owner or Admin. */
export async function requireOwnerOrAdmin(ctx: ReadCtx): Promise<AccessCaller> {
  const caller = await callerOr(ctx, ORG_ADMIN_REFUSAL);
  if (!isAdminRole(caller.role)) throw refuseAccess(ORG_ADMIN_REFUSAL);
  return caller;
}

// ============================================================================
// APP ACCESS
// ============================================================================

/**
 * A Member's stored app access, with the legacy fallback.
 *
 * `access` wins; a row with only the legacy `permission` maps per the spec's
 * Migration section; no row at all is the default (Precision none, Momentum
 * assigned). Several rows (one per member key) take the highest.
 */
export async function storedAppAccess(
  ctx: ReadCtx,
  memberKeys: readonly string[],
  app: AppName
): Promise<AppAccess> {
  let best: AppAccess | undefined;
  for (const memberId of new Set(memberKeys)) {
    const row = await ctx.db
      .query("appPermissions")
      .withIndex("by_member_app", (q) => q.eq("memberId", memberId).eq("app", app))
      .first();
    if (!row) continue;
    const value = row.access ?? legacyToAppAccess(app, row.permission);
    best = best === undefined ? value : highestAppAccess(best, value);
  }
  return best ?? legacyToAppAccess(app, undefined);
}

/** What someone's access to an app works out to: `full` for Owner/Admin. */
export async function appAccessFor(
  ctx: ReadCtx,
  subject: AccessSubject,
  app: AppName
): Promise<EffectiveAppAccess> {
  if (isAdminRole(subject.role)) return "full";
  return storedAppAccess(ctx, subject.memberKeys, app);
}

/** The caller and their access to one app, refusing No access. */
export async function requireApp(
  ctx: ReadCtx,
  app: AppName
): Promise<{ caller: AccessCaller; appAccess: EffectiveAppAccess }> {
  const caller = await callerOr(ctx, APP_REFUSAL[app]);
  const appAccess = await appAccessFor(ctx, caller, app);
  if (!mayOpenApp(appAccess)) throw refuseAccess(APP_REFUSAL[app]);
  return { caller, appAccess };
}

/**
 * The caller, who may start a new estimate.
 *
 * The handler must then stamp `createdBy` and `writeGrant` the creator Can
 * edit, or an Only assigned estimator loses the estimate they just started.
 */
export async function requireStartEstimate(
  ctx: ReadCtx
): Promise<{ caller: AccessCaller; appAccess: EffectiveAppAccess }> {
  const access = await requireApp(ctx, "precision");
  if (!mayStartEstimate(access.appAccess)) throw refuseAccess(START_ESTIMATE_REFUSAL);
  return access;
}

// ============================================================================
// ITEM ACCESS
// ============================================================================

/** One estimate or one project. */
export type ItemRef = { proposalId: Id<"proposals"> } | { projectId: Id<"momentumProjects"> };

/** The app an item belongs to. */
export function appOf(item: ItemRef): AppName {
  return "proposalId" in item ? "precision" : "momentum";
}

/**
 * Someone's grant on one item, counting legacy project-scope assignments.
 *
 * Two indexed reads at most. The legacy rows are read only for projects and
 * only until `projectAssignments` is retired (docs/ACCESS.md, Migration).
 */
export async function grantOn(
  ctx: ReadCtx,
  userId: string,
  item: ItemRef
): Promise<GrantLevel | undefined> {
  let best: GrantLevel | undefined;

  if ("proposalId" in item) {
    const rows = await ctx.db
      .query("accessGrants")
      .withIndex("by_proposal_user", (q) =>
        q.eq("proposalId", item.proposalId).eq("userId", userId)
      )
      .collect();
    for (const row of rows) best = highestLevel(best, row.level);
    return best;
  }

  const rows = await ctx.db
    .query("accessGrants")
    .withIndex("by_project_user", (q) => q.eq("projectId", item.projectId).eq("userId", userId))
    .collect();
  for (const row of rows) best = highestLevel(best, row.level);

  const legacy = await ctx.db
    .query("projectAssignments")
    .withIndex("by_project_user", (q) => q.eq("projectId", item.projectId).eq("userId", userId))
    .collect();
  for (const row of legacy)
    best = highestLevel(best, legacyAssignmentLevel(row.scopeType, row.role));

  return best;
}

/**
 * Someone's level on one item, or `null` for no access.
 *
 * Skips the grant reads when app access already decides the answer (`full`,
 * `edit_all`, `none`), which is every Owner and Admin call.
 */
export async function itemLevelOf(
  ctx: ReadCtx,
  subject: AccessSubject,
  item: ItemRef
): Promise<ItemLevel | null> {
  const appAccess = await appAccessFor(ctx, subject, appOf(item));
  return levelGiven(ctx, subject.userId, appAccess, item);
}

/** The level for a known app access, reading grants only when they can matter. */
async function levelGiven(
  ctx: ReadCtx,
  userId: string,
  appAccess: EffectiveAppAccess,
  item: ItemRef
): Promise<ItemLevel | null> {
  if (appAccess === "full" || appAccess === "none" || appAccess === "edit_all") {
    return itemLevelFor(appAccess, undefined);
  }
  return itemLevelFor(appAccess, await grantOn(ctx, userId, item));
}

/** What {@link requireItem} hands back. */
export interface ItemAccess {
  caller: AccessCaller;
  appAccess: EffectiveAppAccess;
  /** `full`, `edit` or `view` — never below what was required. */
  level: ItemLevel;
}

/**
 * Assert the caller may view or edit one estimate or project.
 *
 * Refusals, in order: not authenticated; suspended; the app's access wall (No
 * access, or not a member); no access to this item; view-only when edit was
 * needed. The item is never read, so a missing id is refused exactly like one
 * the caller may not see.
 */
export async function requireItem(
  ctx: ReadCtx,
  item: ItemRef,
  needed: GrantLevel
): Promise<ItemAccess> {
  const app = appOf(item);
  const { caller, appAccess } = await requireApp(ctx, app);
  const level = await levelGiven(ctx, caller.userId, appAccess, item);
  if (level === null) throw refuseAccess(ITEM_REFUSAL[app]);
  if (!meetsItemLevel(level, needed)) throw refuseAccess(VIEW_ONLY_REFUSAL[app]);
  return { caller, appAccess, level };
}

// ============================================================================
// LISTS
// ============================================================================

/** Everything one person was added to, with the highest level per item. */
export interface PersonGrants {
  proposals: Map<Id<"proposals">, GrantLevel>;
  /** Includes legacy project-scope assignments. */
  projects: Map<Id<"momentumProjects">, GrantLevel>;
}

/**
 * Every estimate and project one person was added to.
 *
 * Two indexed reads by user, bounded by how many items one person is on.
 */
export async function grantsOf(ctx: ReadCtx, userId: string): Promise<PersonGrants> {
  const proposals = new Map<Id<"proposals">, GrantLevel>();
  const projects = new Map<Id<"momentumProjects">, GrantLevel>();

  const rows = await ctx.db
    .query("accessGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) {
    if (row.proposalId) {
      proposals.set(row.proposalId, highestLevel(proposals.get(row.proposalId), row.level));
    } else if (row.projectId) {
      projects.set(row.projectId, highestLevel(projects.get(row.projectId), row.level));
    }
  }

  const legacy = await ctx.db
    .query("projectAssignments")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of legacy) {
    const level = legacyAssignmentLevel(row.scopeType, row.role);
    if (level) projects.set(row.projectId, highestLevel(projects.get(row.projectId), level));
  }

  return { proposals, projects };
}

/** What a list screen needs to filter and badge its rows. */
export interface ListScope<T extends string> {
  caller: AccessCaller;
  appAccess: EffectiveAppAccess;
  /**
   * True when every item is visible (`full`, `edit_all`, `view_all`): list the
   * table. False for Only assigned: fetch just the ids in {@link granted}.
   */
  seesAll: boolean;
  /** The items this person was added to. Empty when it cannot matter. */
  granted: ReadonlyMap<T, GrantLevel>;
  /** The caller's level on one item: the answer `requireItem` would give. */
  levelOf: (id: T) => ItemLevel | null;
}

function listScope<T extends string>(
  caller: AccessCaller,
  appAccess: EffectiveAppAccess,
  granted: ReadonlyMap<T, GrantLevel>
): ListScope<T> {
  return {
    caller,
    appAccess,
    seesAll: appAccess !== "assigned",
    granted,
    levelOf: (id) => itemLevelFor(appAccess, granted.get(id)),
  };
}

/** The estimates the caller may see in a list, refusing No access. */
export async function requireProposalList(ctx: ReadCtx): Promise<ListScope<Id<"proposals">>> {
  const { caller, appAccess } = await requireApp(ctx, "precision");
  // Full and edit_all already see and edit everything; grants add nothing.
  if (appAccess === "full" || appAccess === "edit_all")
    return listScope(caller, appAccess, new Map());
  const { proposals } = await grantsOf(ctx, caller.userId);
  return listScope(caller, appAccess, proposals);
}

/** The projects the caller may see in a list, refusing No access. */
export async function requireProjectList(ctx: ReadCtx): Promise<ListScope<Id<"momentumProjects">>> {
  const { caller, appAccess } = await requireApp(ctx, "momentum");
  if (appAccess === "full" || appAccess === "edit_all")
    return listScope(caller, appAccess, new Map());
  const { projects } = await grantsOf(ctx, caller.userId);
  return listScope(caller, appAccess, projects);
}

// ============================================================================
// COMPATIBILITY
// ============================================================================

/**
 * The legacy per-app levels an installed client is told, for one person.
 *
 * Feeds `appPermissions.getMemberPermissions` and the roster's legacy fields;
 * the rule itself is {@link legacyLevelFor}.
 */
export async function legacyPermissionsFor(
  ctx: ReadCtx,
  subject: AccessSubject
): Promise<Record<AppName, LegacyPermission>> {
  const precision = await appAccessFor(ctx, subject, "precision");
  const momentum = await appAccessFor(ctx, subject, "momentum");

  let grants: PersonGrants | undefined;
  if (precision === "assigned" || momentum === "assigned") {
    grants = await grantsOf(ctx, subject.userId);
  }

  return {
    precision: legacyLevelFor(precision, bestOf(grants?.proposals)),
    momentum: legacyLevelFor(momentum, bestOf(grants?.projects)),
  };
}

/** One person's whole access picture, for the Members screens. */
export interface AccessSummary {
  precision: EffectiveAppAccess;
  momentum: EffectiveAppAccess;
  /** What installed clients are told; see {@link legacyPermissionsFor}. */
  legacy: Record<AppName, LegacyPermission>;
  grants: PersonGrants;
}

/** Everything the Members screens show about one person's access. */
export async function accessSummaryFor(
  ctx: ReadCtx,
  subject: AccessSubject
): Promise<AccessSummary> {
  const precision = await appAccessFor(ctx, subject, "precision");
  const momentum = await appAccessFor(ctx, subject, "momentum");
  const grants = await grantsOf(ctx, subject.userId);
  return {
    precision,
    momentum,
    legacy: {
      precision: legacyLevelFor(precision, bestOf(grants.proposals)),
      momentum: legacyLevelFor(momentum, bestOf(grants.projects)),
    },
    grants,
  };
}

function bestOf(levels: ReadonlyMap<string, GrantLevel> | undefined): GrantLevel | undefined {
  let best: GrantLevel | undefined;
  for (const level of levels?.values() ?? []) best = highestLevel(best, level);
  return best;
}

// ============================================================================
// WRITERS
// ============================================================================

/**
 * Store one member's app access.
 *
 * Writes only `access`. A legacy `permission` left on the row is ignored from
 * then on, which is what lets this deploy before the migration runs.
 */
export async function setAppAccess(
  ctx: MutationCtx,
  memberId: string,
  app: AppName,
  access: AppAccess
): Promise<void> {
  const existing = await ctx.db
    .query("appPermissions")
    .withIndex("by_member_app", (q) => q.eq("memberId", memberId).eq("app", app))
    .first();
  if (existing) {
    if (existing.access !== access) await ctx.db.patch(existing._id, { access });
    return;
  }
  await ctx.db.insert("appPermissions", { memberId, app, access });
}

/**
 * Add someone to one item at exactly `level` (an upsert; it can lower).
 *
 * Also, per the spec:
 * - lifts their app access from `none` to `assigned`, so adding someone to
 *   the job is one step (skipped for Owner/Admin, who have no app setting);
 * - for a project, moves their legacy project-scope rows to the matching role.
 *   The resolver takes the highest of grant and legacy row, so without this an
 *   old `foreman` row would keep edit alive after they were set to Can view.
 *
 * Validating that `userId` is a member who may be added is the caller's job.
 */
export async function writeGrant(
  ctx: MutationCtx,
  args: { item: ItemRef; userId: string; level: GrantLevel; grantedBy: string }
): Promise<void> {
  const { item, userId, level, grantedBy } = args;
  const grantedAt = Date.now();

  const existing = await grantRows(ctx, item, userId);
  const [keep, ...duplicates] = existing;
  if (keep) {
    if (keep.level !== level) await ctx.db.patch(keep._id, { level, grantedBy, grantedAt });
  } else {
    await ctx.db.insert("accessGrants", { userId, level, grantedBy, grantedAt, ...item });
  }
  for (const row of duplicates) await ctx.db.delete(row._id);

  if ("projectId" in item) {
    const legacy = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) => q.eq("projectId", item.projectId).eq("userId", userId))
      .collect();
    for (const row of legacy) {
      const rowLevel = legacyAssignmentLevel(row.scopeType, row.role);
      if (rowLevel !== undefined && rowLevel !== level) {
        await ctx.db.patch(row._id, { role: legacyRoleForLevel(level) });
      }
    }
  }

  // Only ADDING someone lifts their app from No access: changing the level of
  // a grant they already hold must not quietly switch an app back on that an
  // admin turned off.
  if (!keep) await liftAppAccess(ctx, userId, appOf(item));
}

/**
 * Lift one person's app access from `none` to `assigned`, per the spec.
 *
 * Exported for the legacy Team-screen writes in projectAssignments.ts, which
 * add people without going through {@link writeGrant}.
 */
export async function liftAppAccess(ctx: MutationCtx, userId: string, app: AppName): Promise<void> {
  const members = await membershipsOf(ctx, userId);
  const [primary] = members;
  if (!primary || members.some((member) => isAdminRole(member.role))) return;

  const current = await storedAppAccess(ctx, [...new Set(members.flatMap(memberKeysOf))], app);
  const lifted = liftedAppAccess(current);
  if (lifted !== current) await setAppAccess(ctx, primary._id, app, lifted);
}

/**
 * Remove someone from one item. Returns how many rows went.
 *
 * For a project this also deletes their legacy project-scope assignments, so
 * the People panel is the whole truth: removing someone there must remove
 * them. WBS- and phase-scoped rows grant nothing and are left for the old
 * Team screens.
 */
export async function removeGrant(
  ctx: MutationCtx,
  item: ItemRef,
  userId: string
): Promise<number> {
  let removed = 0;
  for (const row of await grantRows(ctx, item, userId)) {
    await ctx.db.delete(row._id);
    removed++;
  }

  if ("projectId" in item) {
    const legacy = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) => q.eq("projectId", item.projectId).eq("userId", userId))
      .collect();
    for (const row of legacy) {
      if (row.scopeType !== "project") continue;
      await ctx.db.delete(row._id);
      removed++;
    }
  }

  return removed;
}

/**
 * Set someone's grant on one project to what their legacy project-scope rows
 * say, after an old Team screen added, changed or removed one of those rows.
 *
 * WHY: the migration copies those rows into grants, and the resolver takes the
 * highest of the two, so without this a Remove or a change to Viewer on an old
 * screen would show the person gone or view-only while the copied grant still
 * gave them edit. Those screens show only the rows, so the rows decide: with
 * none left the grant goes; otherwise it becomes their highest row, inserted if
 * missing so rows written after the migration are carried by grants too.
 * WBS- and phase-scoped rows grant nothing and are not counted.
 */
export async function matchGrantToAssignments(
  ctx: MutationCtx,
  args: { projectId: Id<"momentumProjects">; userId: string; grantedBy: string }
): Promise<void> {
  const { projectId, userId, grantedBy } = args;

  let level: GrantLevel | undefined;
  const legacy = await ctx.db
    .query("projectAssignments")
    .withIndex("by_project_user", (q) => q.eq("projectId", projectId).eq("userId", userId))
    .collect();
  for (const row of legacy) {
    const rowLevel = legacyAssignmentLevel(row.scopeType, row.role);
    if (rowLevel !== undefined) level = highestLevel(level, rowLevel);
  }

  const [keep, ...duplicates] = await grantRows(ctx, { projectId }, userId);
  for (const row of duplicates) await ctx.db.delete(row._id);
  if (level === undefined) {
    if (keep) await ctx.db.delete(keep._id);
  } else if (!keep) {
    await ctx.db.insert("accessGrants", {
      userId,
      projectId,
      level,
      grantedBy,
      grantedAt: Date.now(),
    });
  } else if (keep.level !== level) {
    await ctx.db.patch(keep._id, { level, grantedBy, grantedAt: Date.now() });
  }
}

/** Delete every grant one person holds, when they leave the organization. */
export async function removeAllGrantsOf(ctx: MutationCtx, userId: string): Promise<number> {
  const rows = await ctx.db
    .query("accessGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/** The `accessGrants` rows for one person on one item (one, unless corrupted). */
async function grantRows(ctx: ReadCtx, item: ItemRef, userId: string) {
  if ("proposalId" in item) {
    return ctx.db
      .query("accessGrants")
      .withIndex("by_proposal_user", (q) =>
        q.eq("proposalId", item.proposalId).eq("userId", userId)
      )
      .collect();
  }
  return ctx.db
    .query("accessGrants")
    .withIndex("by_project_user", (q) => q.eq("projectId", item.projectId).eq("userId", userId))
    .collect();
}
