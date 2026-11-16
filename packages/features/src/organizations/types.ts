/**
 * Organization and workspace types.
 *
 * Access follows docs/ACCESS.md: one role per person, one app-access setting
 * per Member per app, and people added to single estimates or projects. The
 * access vocabulary itself lives in `../access/types`.
 */

import type { EffectiveAppAccess } from "../access/types";

export type AppName = "precision" | "momentum";

/**
 * The pre-2026-11 per-app level, still what installed apps and the legacy
 * workspace fields speak.
 *
 * @deprecated Use {@link EffectiveAppAccess} via `WorkspaceContext.precisionAccess`
 * and `momentumAccess`.
 */
export type AppPermissionLevel = "none" | "read" | "write" | "admin";

export type OrganizationRole = "owner" | "admin" | "member" | "guest";

/**
 * Workspace context for the current user
 */
export interface WorkspaceContext {
  // null = personal workspace (no organization)
  organization_id: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  /**
   * The caller's role as the server resolves it (`api.access.getMyAccess`).
   * `null` in a personal workspace, and for a suspended account.
   */
  role: OrganizationRole | null;

  /** The caller's access to Precision; `full` for Owners and Admins. */
  precisionAccess: EffectiveAppAccess;
  /** The caller's access to Momentum; `full` for Owners and Admins. */
  momentumAccess: EffectiveAppAccess;
  /**
   * The account is suspended. The access walls say so, because the usual
   * advice (ask to be added to an estimate or project) cannot help.
   */
  suspended: boolean;

  /**
   * Legacy level derived from {@link WorkspaceContext.precisionAccess}.
   *
   * @deprecated Read `precisionAccess`. Kept until both apps have moved off it.
   */
  precision_permission: AppPermissionLevel;
  /**
   * Legacy level derived from {@link WorkspaceContext.momentumAccess}.
   *
   * @deprecated Read `momentumAccess`. Kept until both apps have moved off it.
   */
  momentum_permission: AppPermissionLevel;

  // Email domain auto-join settings (organization-level)
  allowed_domains: string[] | null;
  auto_join_enabled: boolean;
}

/**
 * Organization with enhanced settings
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  metadata?: Record<string, unknown>;
  created_at: string;

  // Email domain auto-join (like Notion, Slack)
  allowed_domains?: string[];
  auto_join_enabled?: boolean;
}
