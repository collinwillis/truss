"use client";

import React, { createContext, useContext, useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useSession, useActiveOrganization, useListOrganizations } from "@truss/auth/client";
import type { WorkspaceContext, AppPermissionLevel, OrganizationRole } from "./types";

// Better Auth organization types
interface BetterAuthMember {
  id: string;
  userId: string;
  role: string;
}

interface BetterAuthOrganization {
  id: string;
  name: string;
  slug: string;
  members?: BetterAuthMember[];
  allowedDomains?: string[] | null;
  autoJoinEnabled?: boolean;
}

interface WorkspaceContextValue {
  workspace: WorkspaceContext | null;
  isLoading: boolean;
  switchToPersonal: () => void;
  switchToOrganization: (organizationId: string) => void;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
  }>;
  refresh: () => Promise<void>;
}

const WorkspaceContextContext = createContext<WorkspaceContextValue | undefined>(undefined);

/**
 * Workspace Provider
 *
 * Manages the current workspace context (personal vs organization)
 * and provides workspace switching functionality.
 *
 * WHY: Uses reactive Convex queries for permissions so they
 * auto-update when changed by an admin.
 *
 * The getMemberPermissionsQuery prop injects the Convex function reference
 * from the app layer, keeping this package decoupled from the backend.
 */
export function WorkspaceProvider({
  children,
  getMemberPermissionsQuery,
}: {
  children: React.ReactNode;
  /**
   * Convex query function reference for fetching member app permissions.
   * WHY: Injected from app layer to decouple features from backend package.
   * Optional — when not provided, permissions default to admin (personal workspace).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMemberPermissionsQuery?: any;
}) {
  const { data: session, isPending: sessionLoading } = useSession();
  const { data: activeOrg } = useActiveOrganization();
  const { data: organizationsList } = useListOrganizations();

  // Find the current user's member record in the active org
  const currentMember = useMemo(() => {
    if (!activeOrg || !session?.user) return null;
    const betterAuthOrg = activeOrg as unknown as BetterAuthOrganization;
    return betterAuthOrg.members?.find((m) => m.userId === session.user.id) ?? null;
  }, [activeOrg, session]);

  // Reactive permissions query - auto-updates when permissions change
  // WHY: Query is injected from app layer to avoid coupling features to backend.
  // When no query is provided (e.g. Precision app), skip and default to admin.
  const needsPermissions =
    getMemberPermissionsQuery && currentMember && currentMember.role !== "owner";
  const permissions = useQuery(
    getMemberPermissionsQuery ?? "skip",
    needsPermissions ? { memberId: currentMember!.id } : "skip"
  );

  // Build workspace from session, org, and permissions
  const workspace = useMemo<WorkspaceContext | null>(() => {
    if (!session?.user) return null;

    // Personal workspace (no organization)
    if (!activeOrg) {
      return {
        organization_id: null,
        organization_name: null,
        organization_slug: null,
        role: null,
        precision_permission: "admin",
        momentum_permission: "admin",
        allowed_domains: null,
        auto_join_enabled: false,
      };
    }

    const betterAuthOrg = activeOrg as unknown as BetterAuthOrganization;

    if (!currentMember) return null;

    // Owners get full access automatically
    if (currentMember.role === "owner") {
      return {
        organization_id: activeOrg.id,
        organization_name: activeOrg.name,
        organization_slug: activeOrg.slug,
        role: "owner",
        precision_permission: "admin",
        momentum_permission: "admin",
        allowed_domains: betterAuthOrg.allowedDomains ?? null,
        auto_join_enabled: betterAuthOrg.autoJoinEnabled ?? false,
      };
    }

    // Non-owners use reactive permission data
    return {
      organization_id: activeOrg.id,
      organization_name: activeOrg.name,
      organization_slug: activeOrg.slug,
      role: currentMember.role as OrganizationRole,
      precision_permission: (permissions?.precision ?? "none") as AppPermissionLevel,
      momentum_permission: (permissions?.momentum ?? "none") as AppPermissionLevel,
      allowed_domains: betterAuthOrg.allowedDomains ?? null,
      auto_join_enabled: betterAuthOrg.autoJoinEnabled ?? false,
    };
  }, [session, activeOrg, currentMember, permissions]);

  const isLoading = sessionLoading || (!!activeOrg && !workspace);

  const switchToPersonal = useCallback(() => {
    window.location.href = "/workspace/personal";
  }, []);

  const switchToOrganization = useCallback((organizationId: string) => {
    window.location.href = `/workspace/${organizationId}`;
  }, []);

  const refresh = useCallback(async () => {
    // With reactive Convex queries, data refreshes automatically
  }, []);

  const value: WorkspaceContextValue = {
    workspace,
    isLoading,
    switchToPersonal,
    switchToOrganization,
    organizations: (organizationsList || []).map((org: BetterAuthOrganization) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: "member",
    })),
    refresh,
  };

  return (
    <WorkspaceContextContext.Provider value={value}>{children}</WorkspaceContextContext.Provider>
  );
}

/**
 * Hook to access workspace context
 */
export function useWorkspace() {
  const context = useContext(WorkspaceContextContext);

  if (context === undefined) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }

  return context;
}

/**
 * Hook to check app access in current workspace
 */
export function useAppAccess(app: "precision" | "momentum") {
  const { workspace } = useWorkspace();

  if (!workspace) {
    return {
      hasAccess: false,
      permission: "none" as AppPermissionLevel,
      canView: false,
      canEdit: false,
      canAdmin: false,
    };
  }

  const permission =
    app === "precision" ? workspace.precision_permission : workspace.momentum_permission;

  const hierarchy: AppPermissionLevel[] = ["none", "read", "write", "admin"];
  const permissionLevel = hierarchy.indexOf(permission);

  return {
    hasAccess: permission !== "none",
    permission,
    canView: permissionLevel >= hierarchy.indexOf("read"),
    canEdit: permissionLevel >= hierarchy.indexOf("write"),
    canAdmin: permissionLevel >= hierarchy.indexOf("admin"),
  };
}
