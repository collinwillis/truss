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
import { api } from "@truss/backend/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useSession, useActiveOrganization, useListOrganizations } from "@truss/auth/client";
import type { EffectiveAppAccess } from "../access/types";
import { legacyPermissionFor } from "./permissions";
import type { AppName, WorkspaceContext } from "./types";

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
 * The workspace's access fields for one pair of app access values, the legacy
 * levels derived alongside so screens not yet moved keep working.
 */
function accessFields(
  precision: EffectiveAppAccess,
  momentum: EffectiveAppAccess
): Pick<
  WorkspaceContext,
  "precisionAccess" | "momentumAccess" | "precision_permission" | "momentum_permission"
> {
  return {
    precisionAccess: precision,
    momentumAccess: momentum,
    precision_permission: legacyPermissionFor(precision),
    momentum_permission: legacyPermissionFor(momentum),
  };
}

/** What a signed-in caller the server does not recognise has: nothing. */
const NO_ACCESS: {
  role: null;
  precision: EffectiveAppAccess;
  momentum: EffectiveAppAccess;
  suspended: boolean;
} = { role: null, precision: "none", momentum: "none", suspended: false };

/**
 * Workspace Provider
 *
 * Manages the current workspace context (personal vs organization)
 * and provides workspace switching functionality.
 *
 * WHY: Reads the caller's role and app access from `api.access.getMyAccess`,
 * a reactive query, so a change an admin makes reaches the open app at once.
 * That query resolves exactly as the server's own checks do (docs/ACCESS.md),
 * so the workspace never offers what the server will refuse.
 */
export function WorkspaceProvider({
  children,
  setActiveOrganization,
}: {
  children: React.ReactNode;
  /**
   * Ignored. Access now comes from `api.access.getMyAccess`, which needs no
   * member id and so no injected query.
   *
   * @deprecated Remove from the app roots.
   */
  getMemberPermissionsQuery?: unknown;
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

  // The caller's role and app access, as the server resolves them.
  //
  // WHY gated on Convex's own auth state rather than the Better Auth session:
  // the session can land before Convex has attached its token, and asked in
  // that window the query truthfully answers "signed out" (null). Skipping
  // until Convex is authenticated keeps that transient null from settling the
  // workspace as no access. Skipping also clears the result on sign-out, so a
  // next sign-in never sees the previous person's access.
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthenticated } = useConvexAuth();
  const myAccess = useQuery(api.access.getMyAccess, convexAuthenticated ? {} : "skip");

  // Build workspace from session, org, and access
  const workspace = useMemo<WorkspaceContext | null>(() => {
    if (!session?.user) return null;
    // The org data may still belong to whoever was signed in before. Null is
    // the true statement; the personal fallback below would be a wrong one.
    if (orgsStale) return null;

    // Personal workspace (no organization). No access to either app: the
    // server resolves someone with no organization to nothing, and every gate
    // in both apps already requires an organization.
    if (!activeOrg) {
      return {
        organization_id: null,
        organization_name: null,
        organization_slug: null,
        role: null,
        ...accessFields("none", "none"),
        suspended: false,
        allowed_domains: null,
        auto_join_enabled: false,
      };
    }

    const betterAuthOrg = activeOrg as unknown as BetterAuthOrganization;

    if (!currentMember) return null;

    // Still loading: null rather than a provisional "no access", so nothing
    // can render a refusal at someone who has access.
    if (myAccess === undefined && (convexAuthLoading || convexAuthenticated)) return null;

    // Convex settled as signed out, or the server knows no membership: no
    // access, which is what every call would answer.
    const access = myAccess ?? NO_ACCESS;

    return {
      organization_id: activeOrg.id,
      organization_name: activeOrg.name,
      organization_slug: activeOrg.slug,
      role: access.role,
      ...accessFields(access.precision, access.momentum),
      // Absent from a server older than this field: not suspended, as before.
      suspended: access.suspended ?? false,
      allowed_domains: betterAuthOrg.allowedDomains ?? null,
      auto_join_enabled: betterAuthOrg.autoJoinEnabled ?? false,
    };
  }, [
    session,
    activeOrg,
    currentMember,
    myAccess,
    convexAuthLoading,
    convexAuthenticated,
    orgsStale,
  ]);

  /**
   * WHY each term: consumers gate access decisions on this flag, so it must be
   * true for EVERY window in which `workspace` is not yet the settled answer.
   * Before this covered them, two flashes were possible on cold start:
   *
   * - `organizationsList === undefined` and the auto-activation window
   *   (`length > 0 && !activeOrg`): while the org is still resolving, the
   *   provider hands back the personal-workspace fallback (role null, no
   *   access). An org member reading that as settled sees the wrong workspace
   *   entirely.
   * - Access still loading: the org workspace stays null until
   *   `getMyAccess` lands, which `!!activeOrg && !workspace` covers, so a
   *   gate never flashes a refusal at a legitimate editor.
   */
  const orgResolutionPending =
    !!session?.user &&
    (orgsStale ||
      organizationsList == null ||
      (organizationsList.length > 0 && !activeOrg && !orgActivationFailed));
  const isLoading = sessionLoading || orgResolutionPending || (!!activeOrg && !workspace);

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

/** What {@link useAppAccess} reports about one app. */
export interface AppAccessInfo {
  /** The caller's access; `none` while the workspace is unresolved. */
  access: EffectiveAppAccess;
  /** Whether they may open the app at all. */
  hasAccess: boolean;
}

/**
 * The caller's access to one app in the current workspace.
 *
 * @param app - Which app
 * @returns Their access, and whether it lets them in
 */
export function useAppAccess(app: AppName): AppAccessInfo {
  const { workspace } = useWorkspace();
  const access: EffectiveAppAccess = !workspace
    ? "none"
    : app === "precision"
      ? workspace.precisionAccess
      : workspace.momentumAccess;
  return { access, hasAccess: access !== "none" };
}
