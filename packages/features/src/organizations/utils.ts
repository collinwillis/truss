"use client";

import type { AppPermissionLevel } from "./types";

/**
 * Permission level hierarchy for comparison operations.
 *
 * WHY: Allows checking if a user meets a minimum permission threshold
 * without coupling to the backend query implementation.
 */
const PERMISSION_HIERARCHY: AppPermissionLevel[] = ["none", "read", "write", "admin"];

/**
 * Check if a permission level meets a minimum required level.
 */
export function meetsPermissionLevel(
  current: AppPermissionLevel,
  required: AppPermissionLevel
): boolean {
  return PERMISSION_HIERARCHY.indexOf(current) >= PERMISSION_HIERARCHY.indexOf(required);
}
