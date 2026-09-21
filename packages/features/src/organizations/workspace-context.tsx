"use client";

import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { useSession, useActiveOrganization, useListOrganizations } from "@truss/auth/client";
import { hasPermission } from "./permissions";
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
  setActiveOrganization,
}: {
  children: React.ReactNode;
  /**
   * Convex query function reference for fetching member app permissions.
   * WHY: Injected from app layer to decouple features from backend package.
   *
   * ⚠️ Effectively required for organization use: when omitted, non-owner
   * members resolve to permission "none" for BOTH apps — not "admin". Both
   * desktop apps inject it. Omit only for a surface with no organization
   * concept at all.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMemberPermissionsQuery?: any;
  /**
   * Callback to set the active organization in the auth session.
   * WHY: Injected from app layer so the workspace provider can auto-activate
   * the user's organization without importing the auth client directly.
   */
  setActiveOrganization?: (organizationId: string) => Promise<void>;
}) {
  const { data: session, isPending: sessionLoading } = useSession();
  const { data: activeOrg, refetch: refetchActiveOrg } = useActiveOrganization();
  const { data: organizationsList, refetch: refetchOrganizations } = useListOrganizations();

  /**
   * Which SESSION the organization data belongs to.
   *
   * ⚠️ BETTER AUTH DOES NOT KEEP THIS FRESH FOR US. Its organization client
   * fetches the org list once on mount and re-fetches only on
   * `/organization/create`, `/delete` or `/update`; the active org only on
   * `/sign-out` and `/organization/*` (better-auth
   * `plugins/organization/client` atomListeners). Neither listens for
   * `/sign-in`, and a 401 stores `null`.
   *
   * This provider mounts ABOVE each app's auth gate, so on a first sign-in both
   * queries had already run signed out, got `null`, and never ran again.
   * Precision's gate waited on an org list that would never arrive and sat on
   * "Loading Precision..." until a reload; Momentum's gate does not wait, so it
   * quietly resolved the personal workspace instead. Same missing refetch.
   *
   * KEYED ON THE SESSION, NOT THE USER, because a user id misses a case: sign
   * out and back in as the same person. Sign-out clears the active org, the org
   * list survives, and an "already attempted" flag keyed on the provider's
   * lifetime never re-activates — the hang again. Every sign-in is a new
   * session, so first sign-in, user switch and same-user re-login all resolve
   * the one way. Rotating a session's expiry or switching the active org keeps
   * the same session id, so neither refetches spuriously.
   *
   * DERIVED DURING RENDER rather than set in an effect: freshness is a fact
   * about two values, not an event. `orgsResolvedFor` starts undefined and
   * adopts whichever session first settles, because on a cold start that is
   * already signed in, the mount fetch ran with that session and is correct.
   */
  const sessionId = session?.session.id ?? null;
  const [orgsResolvedFor, setOrgsResolvedFor] = useState<string | null | undefined>(undefined);
  if (!sessionLoading && orgsResolvedFor === undefined) {
    setOrgsResolvedFor(sessionId);
  }
  const orgsStale =
    !sessionLoading &&
    orgsResolvedFor !== undefined &&
    sessionId !== null &&
    orgsResolvedFor !== sessionId;

  // The one side effect: fetch the org data for the new session. The state
  // write lands in `.finally`, after the I/O, never synchronously in the effect.
  // If a later session supersedes this one, a late-arriving write here leaves
  // `orgsStale` true for the newer session, which re-runs this effect — the
  // window self-corrects, and throughout it the workspace is null and loading,
  // so nothing belonging to the previous session is ever rendered.
  useEffect(() => {
    if (!orgsStale || sessionId === null) return;
    void Promise.all([refetchOrganizations(), refetchActiveOrg()]).finally(() => {
      setOrgsResolvedFor(sessionId);
    });
  }, [orgsStale, sessionId, refetchOrganizations, refetchActiveOrg]);

  // Auto-activate the user's organization if none is active
  // WHY: Better Auth requires explicitly setting the active org. Without this,
  // users land in "personal workspace" with role=null even though they belong to an org.
  // Keyed on the session for the reason above: a new sign-in must be allowed
  // to activate again, even for the same person.
  const autoActivatedFor = useRef<string | null>(null);
  // WHY tracked: `isLoading` treats "orgs exist but none active" as still
  // resolving. If activation fails and nothing records it, that state never
  // exits and the app spins forever. Recording the failure lets isLoading
  // settle, so the user falls through to the personal workspace — where each
  // app's own gate can show an actionable screen instead of a spinner.
  const [orgActivationFailedFor, setOrgActivationFailedFor] = useState<string | null>(null);
  const orgActivationFailed = sessionId !== null && orgActivationFailedFor === sessionId;
  useEffect(() => {
    if (
      setActiveOrganization &&
      !orgsStale &&
      !activeOrg &&
      !sessionLoading &&
      sessionId !== null &&
      organizationsList &&
      organizationsList.length > 0 &&
      autoActivatedFor.current !== sessionId
    ) {
      autoActivatedFor.current = sessionId;
      const firstOrg = organizationsList[0] as BetterAuthOrganization;
      setActiveOrganization(firstOrg.id).catch(() => setOrgActivationFailedFor(sessionId));
    }
  }, [activeOrg, sessionId, sessionLoading, organizationsList, setActiveOrganization, orgsStale]);

  // Find the current user's member record in the active org
  const currentMember = useMemo(() => {
    if (!activeOrg || !session?.user) return null;
    const betterAuthOrg = activeOrg as unknown as BetterAuthOrganization;
    return betterAuthOrg.members?.find((m) => m.userId === session.user.id) ?? null;
  }, [activeOrg, session]);

  // Reactive permissions query - auto-updates when permissions change
  // WHY: Query is injected from app layer to avoid coupling features to backend.
  // Owners skip it — they are hardcoded to admin below and (in production) have
  // no appPermissions row to fetch.
  const needsPermissions =
    getMemberPermissionsQuery && currentMember && currentMember.role !== "owner";
  const permissions = useQuery(
    getMemberPermissionsQuery ?? "skip",
    needsPermissions ? { memberId: currentMember!.id } : "skip"
  );

  // Build workspace from session, org, and permissions
  const workspace = useMemo<WorkspaceContext | null>(() => {
    if (!session?.user) return null;
    // The org data may still belong to whoever was signed in before. Null is
    // the true statement; the personal fallback below would be a wrong one.
    if (orgsStale) return null;

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
  }, [session, activeOrg, currentMember, permissions, orgsStale]);

  /**
   * WHY each term: consumers gate access decisions on this flag, so it must be
   * true for EVERY window in which `workspace` is not yet the settled answer.
   * Before this covered them, two flashes were possible on cold start:
   *
   * - `organizationsList === undefined` and the auto-activation window
   *   (`length > 0 && !activeOrg`): while the org is still resolving, the
   *   provider hands back the personal-workspace fallback (role null,
   *   permissions admin/admin). An org member reading that as settled sees the
   *   wrong workspace entirely.
   * - `permissionsLoading`: a non-owner member's workspace materializes with
   *   permissions "none" before the query lands, so a permission gate reading
   *   it as settled would flash a refusal at a legitimate editor.
   */
  const permissionsLoading = Boolean(needsPermissions) && permissions === undefined;
  const orgResolutionPending =
    !!session?.user &&
    (orgsStale ||
      organizationsList == null ||
      (organizationsList.length > 0 && !activeOrg && !orgActivationFailed));
  const isLoading =
    sessionLoading || orgResolutionPending || (!!activeOrg && !workspace) || permissionsLoading;

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

  return {
    hasAccess: permission !== "none",
    permission,
    canView: hasPermission(permission, "read"),
    canEdit: hasPermission(permission, "write"),
    canAdmin: hasPermission(permission, "admin"),
  };
}
