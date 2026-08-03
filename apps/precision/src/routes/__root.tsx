import { createRootRoute, Outlet, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useQuery } from "convex/react";
import { useSession, signOut, tauriAuthClient } from "../lib/auth-client";
import { WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import { AppShell, AuthScreen } from "@truss/features";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import type { ShellLinkProps } from "@truss/features/desktop-shell/types";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { ShieldAlert } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { canEditPrecision, canViewPrecision } from "../lib/permissions";
import { getGlobalShellConfig } from "../config/shell-config-global";
import { dueTier } from "../components/estimates-grid/columns";
import { buildEstimateShellBase, getEstimateShellConfig } from "../config/shell-config-estimate";
import { EstimateSwitcher } from "../components/estimate-switcher";
import { forwardRef, useCallback, useEffect, useMemo, useState } from "react";

/**
 * Root route providing authentication and app shell layout.
 *
 * WHY: Navigation adapts based on whether an estimate is selected.
 * When at /estimates, shows global navigation.
 * When at /estimate/:id/*, shows estimate-specific navigation with WBS items.
 */
export const Route = createRootRoute({
  component: RootComponent,
});

/**
 * Upper bound on sibling estimates offered as command-palette entries.
 *
 * WHY capped: the palette renders and rescores every entry on each keystroke,
 * and the estimate list grows without limit. Newest proposal numbers first, so
 * the cap trims the archive rather than current work.
 */
const MAX_ESTIMATE_COMMANDS = 30;

/**
 * Router-aware link adapter for the shell package.
 *
 * WHY: The shell package is router-agnostic, so we bridge TanStack Router's
 * Link component to the shell's ShellLinkProps interface.
 */
/**
 * Split "/estimates?due=overdue" into the parts TanStack Router expects.
 *
 * The shell's navigation contract is a single string, but TanStack takes the
 * path and the search object separately — handed the whole thing as `to`, it
 * treats "?due=overdue" as part of the pathname and matches nothing, so the
 * sidebar's saved views changed the URL and filtered nothing.
 */
function splitPath(to: string): { pathname: string; search: Record<string, string> } {
  const at = to.indexOf("?");
  if (at === -1) return { pathname: to, search: {} };
  const search: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(to.slice(at + 1))) search[key] = value;
  return { pathname: to.slice(0, at), search };
}

const RouterLink = forwardRef<HTMLAnchorElement, ShellLinkProps>(
  ({ to, children, className, ...rest }, ref) => {
    const { pathname, search } = splitPath(to);
    return (
      <Link to={pathname} search={search} className={className} ref={ref} {...rest}>
        {children}
      </Link>
    );
  }
);
RouterLink.displayName = "RouterLink";

function RootComponent() {
  return (
    <WorkspaceProvider
      getMemberPermissionsQuery={api.appPermissions.getMemberPermissions}
      setActiveOrganization={async (orgId) => {
        await tauriAuthClient.organization.setActive({ organizationId: orgId });
      }}
    >
      <AuthenticatedApp />
    </WorkspaceProvider>
  );
}

/** Context-aware shell wrapper that switches config based on current route. */
function ContextAwareShell({ children }: { children: React.ReactNode }) {
  const { workspace } = useWorkspace();
  const tanstackNavigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  // What the SHELL sees, query string included: the sidebar marks an item
  // active by exact href match, so without the search every saved view
  // ("/estimates?due=overdue") would sit unlit while "All Estimates" stayed
  // lit on top of it. Route PARSING below uses `pathname` — a query string
  // must never leak into a captured route param.
  const currentPath = pathname + (routerState.location.searchStr || "");

  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const canEdit = canEditPrecision(workspace);

  const shellNavigate = useCallback(
    (to: string) => {
      const { pathname, search } = splitPath(to);
      void tanstackNavigate({ to: pathname, search });
    },
    [tanstackNavigate]
  );

  // Extract estimateId from current route. The one cast from route-param
  // string to typed id lives here; everything downstream stays checked.
  const estimateIdFromRoute = useMemo(() => {
    const match = pathname.match(/^\/estimate\/([^/]+)/);
    return match ? (match[1] as Id<"proposals">) : null;
  }, [pathname]);

  // Fetch WBS items with phases for the sidebar tree navigation
  const wbsWithPhases = useQuery(
    api.precision.getWBSWithPhasesForNav,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute } : "skip"
  );

  // WBS codes come from a second query because getWBSWithPhasesForNav omits
  // `wbsPoolId`, and every WBS is labelled by code (`70000 · AG PIPING`).
  const wbsCodes = useQuery(
    api.precision.getWBSForProposal,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute } : "skip"
  );

  // Fetch proposal metadata for the estimate switcher
  const currentProposal = useQuery(
    api.precision.getProposal,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute } : "skip"
  );

  // Sibling estimates power the ⌘K "Switch Estimate" entries inside an
  // estimate, and the global rail's live counts outside one. Unconditional
  // now that both contexts need it — the estimates route and the top-bar
  // switcher subscribe to the same query, so Convex serves all of them from
  // one subscription rather than three.
  const allProposals = useQuery(api.precision.listProposals, {});

  // Merged tree: codes joined onto the phase tree by WBS id. Held back until
  // both queries land so no label ever renders without its code.
  const wbsNavItems = useMemo(() => {
    if (!wbsWithPhases || !wbsCodes) return [];
    const codeById = new Map(wbsCodes.map((w) => [w._id as string, w.wbsPoolId]));
    return wbsWithPhases.flatMap((w) => {
      const wbsPoolId = codeById.get(w._id as string);
      // Both queries read the same table; a miss can only mean a mid-flight edit.
      if (wbsPoolId === undefined) return [];
      // Hidden WBS leave the rail and the palette — Setup's toggles decide
      // what this estimate uses. Their data is untouched; Overview and the
      // totals still account for any work they carry.
      if (w.isHidden) return [];
      return [
        {
          id: w._id as string,
          wbsPoolId,
          name: w.name,
          phases: w.phases.map((p) => ({
            id: p._id as string,
            phaseNumber: p.phaseNumber,
            description: p.description,
          })),
        },
      ];
    });
  }, [wbsWithPhases, wbsCodes]);

  // WBS currently on screen, so its phases are registered in the palette first.
  const activeWbsId = useMemo(() => {
    const wbsMatch = pathname.match(/^\/estimate\/[^/]+\/wbs\/([^/]+)/);
    if (wbsMatch) return wbsMatch[1];
    const phaseMatch = pathname.match(/^\/estimate\/[^/]+\/phase\/([^/]+)/);
    if (!phaseMatch) return undefined;
    const phaseId = phaseMatch[1];
    return wbsNavItems.find((wbs) => wbs.phases.some((phase) => phase.id === phaseId))?.id;
  }, [pathname, wbsNavItems]);

  const otherEstimates = useMemo(() => {
    if (!allProposals || !estimateIdFromRoute) return [];
    return allProposals
      .filter((p) => p._id !== estimateIdFromRoute)
      .sort((a, b) => {
        const numA = parseFloat(a.proposalNumber);
        const numB = parseFloat(b.proposalNumber);
        if (!isNaN(numA) && !isNaN(numB)) return numB - numA;
        return b.proposalNumber.localeCompare(a.proposalNumber);
      })
      .slice(0, MAX_ESTIMATE_COMMANDS)
      .map((p) => ({
        id: p._id as string,
        proposalNumber: p.proposalNumber,
        description: p.description,
      }));
  }, [allProposals, estimateIdFromRoute]);

  // The estimate shell in two layers (#19): the heavy, data-dependent base
  // rebuilds only when the estimate's data changes; the per-navigation layer
  // (which phases win the palette budget) is a cheap selection on top. Before
  // the split, `activeWbsId` — different on every click — forced the whole
  // sidebar tree and command list to rebuild per navigation.
  const estimateShellBase = useMemo(
    () =>
      estimateIdFromRoute
        ? buildEstimateShellBase(estimateIdFromRoute, shellNavigate, undefined, {
            isAdmin: !!isAdmin,
            wbsItems: wbsNavItems,
            otherEstimates,
          })
        : null,
    [estimateIdFromRoute, shellNavigate, isAdmin, wbsNavItems, otherEstimates]
  );

  /**
   * The rail's three saved views, counted the same way the log counts them —
   * one shared predicate, so the badge and the screen can never disagree.
   * Undefined until the data lands, which keeps the rail from reflowing.
   */
  /**
   * Ticks at the UTC day boundary and nowhere else.
   *
   * Overdue and Dormant are day-grained, so a timer is only needed when the
   * day actually rolls over — an interval would rebuild the whole shell
   * config on a schedule to produce the identical numbers.
   */
  const [dayTick, setDayTick] = useState(0);
  useEffect(() => {
    const now = new Date();
    const nextMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const id = setTimeout(() => setDayTick((t) => t + 1), nextMidnightUtc - now.getTime() + 1000);
    return () => clearTimeout(id);
  }, [dayTick]);

  const sidebarCounts = useMemo(() => {
    if (!allProposals) return undefined;
    const now = Date.now();
    let overdue = 0;
    let dormant = 0;
    let awarded = 0;
    for (const p of allProposals) {
      const tier = dueTier(
        { dateDue: p.dateDue ?? null, status: p.status ?? null } as Parameters<typeof dueTier>[0],
        now
      );
      if (tier === "overdue") overdue += 1;
      if (tier === "dormant") dormant += 1;
      if (p.status === "awarded") awarded += 1;
    }
    return { total: allProposals.length, overdue, dormant, awarded };
    // dayTick is the point: recount when the calendar day rolls over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProposals, dayTick]);

  const shellConfig = useMemo(() => {
    if (estimateShellBase) {
      return getEstimateShellConfig(estimateShellBase, activeWbsId);
    }
    return getGlobalShellConfig(shellNavigate, undefined, {
      isAdmin: !!isAdmin,
      canEdit,
      counts: sidebarCounts,
    });
  }, [estimateShellBase, activeWbsId, shellNavigate, isAdmin, canEdit, sidebarCounts]);

  const handleLogout = async () => {
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          console.log("Successfully logged out");
        },
        onError: (error) => {
          console.error("Failed to logout:", error);
        },
      },
    });
  };

  return (
    <AppShell
      config={shellConfig}
      linkComponent={RouterLink}
      navigate={shellNavigate}
      currentPath={currentPath}
      onCommandExecute={() => {}}
      onLogout={handleLogout}
      topBarContent={
        estimateIdFromRoute ? (
          currentProposal ? (
            <EstimateSwitcher
              currentEstimateId={estimateIdFromRoute}
              currentDescription={currentProposal.description}
              currentNumber={currentProposal.proposalNumber}
            />
          ) : undefined // estimate still loading — no flash of the wrong label
        ) : (
          // The native title is hidden (overlay title bar), so global
          // surfaces name themselves the way a document window would.
          <span
            data-tauri-drag-region=""
            className="px-2 text-[13px] font-medium text-muted-foreground"
          >
            {currentPath.startsWith("/pools")
              ? "Rate pools"
              : currentPath.startsWith("/admin")
                ? "Admin"
                : "All estimates"}
          </span>
        )
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * Shown instead of the shell when the workspace lacks Precision access.
 *
 * WHY it must replace the shell, not overlay it: the shell itself subscribes
 * to Precision queries (`getProposal`, `listProposals`, the WBS nav tree),
 * and the server refuses all of them below "read" — rendering the shell for
 * a no-access user produces a page of query errors, not an empty app. The
 * server is the authority; this wall is affordance, matching Momentum's
 * admin walls and the shared `AdminAccessRequired`.
 */
function PrecisionAccessWall() {
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-background text-center">
      <WindowDragStrip />
      <div className="rounded-full bg-fill-quaternary p-3 mb-4">
        <ShieldAlert className="h-6 w-6 text-label-quaternary" />
      </div>
      <p className="text-body font-medium text-foreground">Precision access required</p>
      <p className="text-body text-muted-foreground mt-1 max-w-[280px]">
        Your account doesn&apos;t have access to Precision. Ask an organization admin to grant it.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() => {
          void signOut();
        }}
      >
        Sign Out
      </Button>
    </div>
  );
}

/**
 * The window uses macOS Overlay title-bar style, so screens rendered OUTSIDE
 * the shell (loading, auth) have no native bar to grab — this invisible strip
 * at title-bar height keeps the window movable from them.
 */
function WindowDragStrip() {
  return <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-50 h-11" />;
}

function AuthenticatedApp() {
  const { data: session, isPending } = useSession();
  const { workspace, isLoading: workspaceLoading } = useWorkspace();

  if (isPending) {
    return (
      <div className="relative flex items-center justify-center min-h-screen bg-background">
        <WindowDragStrip />
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Precision...</p>
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="relative min-h-screen">
        <WindowDragStrip />
        <AuthScreen
          appName="Precision"
          appDescription="Project estimating and cost management for construction professionals"
          onSuccess={() => {}}
        />
      </div>
    );
  }

  // Hold the spinner until the workspace is the settled answer — the provider
  // keeps isLoading true through org auto-activation and the permissions
  // fetch, so neither the wall nor the shell renders from a transient state.
  if (workspaceLoading || !workspace) {
    return (
      <div className="relative flex items-center justify-center min-h-screen bg-background">
        <WindowDragStrip />
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Precision...</p>
        </div>
      </div>
    );
  }

  if (!canViewPrecision(workspace)) {
    return <PrecisionAccessWall />;
  }

  return (
    <ContextAwareShell>
      <Outlet />
      <TanStackRouterDevtools />
    </ContextAwareShell>
  );
}
