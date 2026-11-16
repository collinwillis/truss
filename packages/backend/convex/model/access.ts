/**
 * The rules for who can see and change what in Precision and Momentum.
 *
 * One role per person, plus access granted per item: an Owner or Admin has
 * full access; a Member has one app-access setting per app and may be added to
 * single estimates or projects as Can view / Can edit. Highest wins. The spec
 * of record is `docs/ACCESS.md`; every rule below cites the part it encodes.
 *
 * PURE, with no Convex imports, so every rule here is tested in plain Node and
 * the ctx-based resolver (`accessResolve.ts`) is only plumbing around it.
 *
 * @module
 */

import type { AppPermissionLevel } from "./appPermissionLevels";

/** The two apps access is set for. */
export type AppName = "precision" | "momentum";

/** A Member's stored setting for one app (`appPermissions.access`). */
export type AppAccess = "none" | "assigned" | "view_all" | "edit_all";

/**
 * What one person's app access works out to.
 *
 * `full` is never stored: it is what an Owner or Admin has, through their role.
 */
export type EffectiveAppAccess = AppAccess | "full";

/** What a person may do with one estimate or project. */
export type ItemLevel = "full" | "edit" | "view";

/** The level an `accessGrants` row carries. */
export type GrantLevel = "view" | "edit";

/**
 * The pre-2026-11 per-app level (`appPermissions.permission`), still what
 * installed apps read and write. Aliased, not redeclared, so the two cannot
 * drift.
 */
export type LegacyPermission = AppPermissionLevel;

/** An organization role, as Better Auth stores it on `member.role`. */
export type OrgRole = "owner" | "admin" | "member";

/** The legacy Momentum project roles (`projectAssignments.role`). */
export type LegacyProjectRole = "superintendent" | "supervisor" | "foreman" | "viewer";

/** The legacy assignment scopes (`projectAssignments.scopeType`). */
export type LegacyScopeType = "project" | "wbs" | "phase";

/**
 * App access values, least to most.
 *
 * Order IS the semantics: {@link highestAppAccess} compares positions, so this
 * must not be sorted or reordered.
 */
export const APP_ACCESS_ORDER: readonly AppAccess[] = ["none", "assigned", "view_all", "edit_all"];

/** Item levels, least to most. Order is the semantics, as above. */
const ITEM_LEVEL_ORDER: readonly ItemLevel[] = ["view", "edit", "full"];

/** Whether a role carries full access with no app setting at all. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Narrow a Better Auth role string to the three this model knows.
 *
 * An unrecognised value reads as `member`, the least privileged role, so a role
 * this build does not know about is never treated as an admin.
 */
export function toOrgRole(role: string | null | undefined): OrgRole {
  return role === "owner" || role === "admin" ? role : "member";
}

/** The more privileged of two roles: owner over admin over member. */
export function higherRole(a: OrgRole, b: OrgRole): OrgRole {
  const rank: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * The app access a legacy `permission` value stands for.
 *
 * Per the Migration section: Precision `read` → `view_all`, `write`/`admin` →
 * `edit_all`, `none` or no row → `none`. Every Momentum value, and no row, →
 * `assigned`, because Momentum's levels never did anything on the server; only
 * assignments did. So the no-row defaults are exactly what a new sign-up gets
 * today: Precision's access wall, and an empty Momentum project list.
 */
export function legacyToAppAccess(app: AppName, legacy: LegacyPermission | undefined): AppAccess {
  if (app === "momentum") return "assigned";
  if (legacy === "read") return "view_all";
  if (legacy === "write" || legacy === "admin") return "edit_all";
  return "none";
}

/**
 * The app access a legacy `setPermission` write means, or `null` for `admin`.
 *
 * Installed clients still send these. `admin` has no member equivalent — it
 * used to mean "administrator of this app", which is now the Admin role — so
 * the caller refuses it rather than guessing.
 */
export function appAccessFromLegacyWrite(
  app: AppName,
  permission: LegacyPermission
): AppAccess | null {
  if (permission === "admin") return null;
  if (app === "momentum") return "assigned";
  if (permission === "read") return "view_all";
  if (permission === "write") return "edit_all";
  return "none";
}

/** The higher of two app access values. */
export function highestAppAccess(a: AppAccess, b: AppAccess): AppAccess {
  return APP_ACCESS_ORDER.indexOf(b) > APP_ACCESS_ORDER.indexOf(a) ? b : a;
}

/**
 * The higher of two item levels, where `undefined` means "nothing".
 *
 * Highest wins, like OpenAI's "access is the union" and Notion's "higher level
 * wins": a second path to an item can only add to what the first allowed.
 */
export function highestLevel<T extends ItemLevel>(a: T | undefined, b: T): T;
export function highestLevel<T extends ItemLevel>(
  a: T | undefined,
  b: T | undefined
): T | undefined;
export function highestLevel<T extends ItemLevel>(
  a: T | undefined,
  b: T | undefined
): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return ITEM_LEVEL_ORDER.indexOf(b) > ITEM_LEVEL_ORDER.indexOf(a) ? b : a;
}

/**
 * Resolve one person's level on one item, or `null` for no access.
 *
 * `none` ignores grants on purpose: switching someone's app off has to switch
 * it off, not leave every estimate they were ever added to reachable. The
 * grants come back when the app is lifted again. Banned and non-members never
 * reach this — the resolver refuses them first.
 */
export function itemLevelFor(
  appAccess: EffectiveAppAccess,
  grant: GrantLevel | undefined
): ItemLevel | null {
  if (appAccess === "full") return "full";
  if (appAccess === "none") return null;
  const fromApp: GrantLevel | undefined =
    appAccess === "edit_all" ? "edit" : appAccess === "view_all" ? "view" : undefined;
  return highestLevel(fromApp, grant) ?? null;
}

/** Whether a resolved level allows `required`. `full` allows everything. */
export function meetsItemLevel(level: ItemLevel | null, required: GrantLevel): boolean {
  if (level === null) return false;
  return ITEM_LEVEL_ORDER.indexOf(level) >= ITEM_LEVEL_ORDER.indexOf(required);
}

/**
 * The legacy level an installed client should be told, for one app.
 *
 * Per the Compatibility section: Owner/Admin → `admin`, `edit_all` → `write`,
 * `view_all` → `read`, `assigned` → `write` if they can edit any item in that
 * app, `read` if they can view any, else `none`. `bestGrant` is the highest
 * level among their grants in that app. Old clients gate whole screens on this
 * value, so `assigned` reports what the person can actually do somewhere.
 */
export function legacyLevelFor(
  appAccess: EffectiveAppAccess,
  bestGrant: GrantLevel | undefined
): LegacyPermission {
  switch (appAccess) {
    case "full":
      return "admin";
    case "edit_all":
      return "write";
    case "view_all":
      return "read";
    case "assigned":
      return bestGrant === "edit" ? "write" : bestGrant === "view" ? "read" : "none";
    case "none":
      return "none";
  }
}

/** Whether someone may open the app at all (anything but `none`). */
export function mayOpenApp(appAccess: EffectiveAppAccess): boolean {
  return appAccess !== "none";
}

/**
 * Whether someone may start a new estimate.
 *
 * `assigned` may, because starting one is how an estimator gets work into the
 * system; they get edit on what they start. `view_all` may not: it is the
 * read-only setting, and a new estimate is a change.
 */
export function mayStartEstimate(appAccess: EffectiveAppAccess): boolean {
  return appAccess === "full" || appAccess === "edit_all" || appAccess === "assigned";
}

/**
 * The grant a legacy `projectAssignments` row stands for, if any.
 *
 * Only project-scope rows count: `viewer` → view, any other role → edit (only
 * `viewer` ever did anything). WBS- and phase-scoped rows grant nothing,
 * because the model has no WBS or phase scoping.
 */
export function legacyAssignmentLevel(
  scopeType: LegacyScopeType,
  role: LegacyProjectRole
): GrantLevel | undefined {
  if (scopeType !== "project") return undefined;
  return role === "viewer" ? "view" : "edit";
}

/**
 * The legacy project role that matches a grant level.
 *
 * Used to keep legacy project-scope rows in step when a grant changes, so the
 * resolver's highest-wins union cannot keep an old `foreman` row's edit alive
 * after someone was set to Can view.
 */
export function legacyRoleForLevel(level: GrantLevel): LegacyProjectRole {
  return level === "view" ? "viewer" : "superintendent";
}

/**
 * The app access to store after someone is added to an item.
 *
 * Adding someone to an estimate or project lifts that app from `none` to
 * `assigned`, so "add them to the job" is one step. Anything above `none` is
 * already enough to reach the grant and stays as it is.
 */
export function liftedAppAccess(current: AppAccess): AppAccess {
  return current === "none" ? "assigned" : current;
}
