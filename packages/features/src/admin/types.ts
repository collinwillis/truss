/**
 * Display models for the admin Members pages.
 *
 * WHY: The presentational views take these plain shapes, so they render from
 * fake data without Convex; the page containers map the `adminUsers` and
 * `access` query rows onto them.
 */

import type { EffectiveAppAccess, ItemAccessLevel } from "../access/types";

/** An organization role as the Members pages show it. */
export type MemberRole = "owner" | "admin" | "member";

/** One row of the Members table. */
export interface AdminMemberView {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  image?: string;
  orgRole: MemberRole;
  isBanned: boolean;
  createdAt: string;
  /** `full` for Owners and Admins, shown locked. */
  precisionAccess: EffectiveAppAccess;
  /** `full` for Owners and Admins, shown locked. */
  momentumAccess: EffectiveAppAccess;
}

/** Detailed member view for the admin member detail page. */
export interface AdminMemberDetail extends AdminMemberView {
  banReason?: string;
}

/** One estimate or project a member was added to, on the member detail page. */
export interface MemberGrantView {
  /** The estimate's or project's id. */
  id: string;
  /** Estimate or project number, shown before the name when there is one. */
  number?: string;
  name: string;
  level: ItemAccessLevel;
}

/** A row action on the Members table that asks for confirmation first. */
export type MemberConfirmAction = "ban" | "unban" | "remove";

/** Status filter options for the members table. */
export type MemberStatusFilter = "all" | "active" | "suspended";
