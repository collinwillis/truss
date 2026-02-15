"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend";
import type { AppName, AppPermissionLevel, MemberWithPermissions } from "./types";

/**
 * Hook to get reactive app permissions for a member.
 *
 * WHY: Returns a Convex reactive query that auto-updates when
 * permissions change, replacing the old Supabase polling approach.
 */
export function useMemberAppPermissions(memberId: string | undefined) {
  return useQuery(api.appPermissions.getMemberPermissions, memberId ? { memberId } : "skip");
}

/**
 * Hook to set an app permission for a member.
 *
 * WHY: Returns a Convex mutation function for updating permissions.
 */
export function useSetMemberAppPermission() {
  return useMutation(api.appPermissions.setPermission);
}

/**
 * Get app permissions for a member (imperative, non-reactive).
 *
 * WHY: Kept for backward compatibility in contexts where hooks
 * can't be used. Prefer useMemberAppPermissions in components.
 */
export async function getMemberAppPermissions(
  memberId: string
): Promise<{ precision: AppPermissionLevel; momentum: AppPermissionLevel }> {
  // In hook-based contexts, use useMemberAppPermissions instead.
  // This fallback returns defaults since we can't call Convex imperatively
  // from shared packages without a ConvexClient instance.
  console.warn(
    "getMemberAppPermissions: Use useMemberAppPermissions hook instead for reactive updates"
  );
  return { precision: "none", momentum: "none" };
}

/**
 * Set app permission for a member.
 *
 * WHY: Kept for backward compatibility. Prefer useSetMemberAppPermission hook.
 */
export async function setMemberAppPermission(
  memberId: string,
  app: AppName,
  permission: AppPermissionLevel
): Promise<{ success: boolean; error?: string }> {
  console.warn("setMemberAppPermission: Use useSetMemberAppPermission hook instead");
  return { success: false, error: "Use useSetMemberAppPermission hook" };
}

/**
 * Check if user has permission for an app.
 *
 * WHY: Kept for backward compatibility. Use useQuery with
 * api.appPermissions.checkPermission instead.
 */
export async function checkUserAppPermission(
  _userId: string,
  _organizationId: string,
  _app: AppName,
  _requiredPermission: AppPermissionLevel
): Promise<boolean> {
  console.warn(
    "checkUserAppPermission: Use Convex query api.appPermissions.checkPermission instead"
  );
  return false;
}
