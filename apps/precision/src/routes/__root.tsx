import { createRootRoute, Outlet, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useQuery } from "convex/react";
import { useSession, signOut, tauriAuthClient } from "../lib/auth-client";
import { WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import { AppShell, AuthScreen } from "@truss/features";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import type { ShellLinkProps } from "@truss/features/desktop-shell/types";
import { api } from "@truss/backend/convex/_generated/api";
import { ShieldAlert } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { canEditPrecision, canViewPrecision } from "../lib/permissions";
import { getGlobalShellConfig } from "../config/shell-config-global";
import { getEstimateShellConfig } from "../config/shell-config-estimate";
import { EstimateSwitcher } from "../components/estimate-switcher";
import { forwardRef, useCallback, useMemo } from "react";

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
const RouterLink = forwardRef<HTMLAnchorElement, ShellLinkProps>(
  ({ to, children, className, ...rest }, ref) => {
    return (
      <Link to={to} className={className} ref={ref} {...rest}>
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
  const currentPath = routerState.location.pathname;

  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const canEdit = canEditPrecision(workspace);

  const shellNavigate = useCallback(
    (to: string) => {
      tanstackNavigate({ to });
    },
    [tanstackNavigate]
  );

  // Extract estimateId from current route
  const estimateIdFromRoute = useMemo(() => {
    const match = currentPath.match(/^\/estimate\/([^/]+)/);
    return match ? match[1] : null;
  }, [currentPath]);

  // Fetch WBS items with phases for the sidebar tree navigation
  const wbsWithPhases = useQuery(
    api.precision.getWBSWithPhasesForNav,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute as never } : "skip"
  );

  // WBS codes come from a second query because getWBSWithPhasesForNav omits
  // `wbsPoolId`, and every WBS is labelled by code (`70000 · AG PIPING`).
  const wbsCodes = useQuery(
    api.precision.getWBSForProposal,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute as never } : "skip"
  );

  // Fetch proposal metadata for the estimate switcher
  const currentProposal = useQuery(
    api.precision.getProposal,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute as never } : "skip"
  );

  // Sibling estimates power the ⌘K "Switch Estimate" entries. Same query the
  // top-bar switcher already subscribes to, so Convex serves both from one
  // subscription.
  const allProposals = useQuery(api.precision.listProposals, estimateIdFromRoute ? {} : "skip");

  // Merged tree: codes joined onto the phase tree by WBS id. Held back until
  // both queries land so no label ever renders without its code.
  const wbsNavItems = useMemo(() => {
    if (!wbsWithPhases || !wbsCodes) return [];
    const codeById = new Map(wbsCodes.map((w) => [w._id as string, w.wbsPoolId]));
    return wbsWithPhases.flatMap((w) => {
      const wbsPoolId = codeById.get(w._id as string);
      // Both queries read the same table; a miss can only mean a mid-flight edit.
      if (wbsPoolId === undefined) return [];
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
    const wbsMatch = currentPath.match(/^\/estimate\/[^/]+\/wbs\/([^/]+)/);
    if (wbsMatch) return wbsMatch[1];
    const phaseMatch = currentPath.match(/^\/estimate\/[^/]+\/phase\/([^/]+)/);
    if (!phaseMatch) return undefined;
    const phaseId = phaseMatch[1];
    return wbsNavItems.find((wbs) => wbs.phases.some((phase) => phase.id === phaseId))?.id;
  }, [currentPath, wbsNavItems]);

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

  // Select shell config based on context — dynamically populates WBS in sidebar
  const shellConfig = useMemo(() => {
    if (estimateIdFromRoute) {
      return getEstimateShellConfig(estimateIdFromRoute, shellNavigate, undefined, {
        isAdmin: !!isAdmin,
        wbsItems: wbsNavItems,
        activeWbsId,
        otherEstimates,
      });
    }
    return getGlobalShellConfig(shellNavigate, undefined, { isAdmin: !!isAdmin, canEdit });
  }, [
    estimateIdFromRoute,
    shellNavigate,
    isAdmin,
    canEdit,
    wbsNavItems,
    activeWbsId,
    otherEstimates,
  ]);

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
        estimateIdFromRoute && currentProposal ? (
          <EstimateSwitcher
            currentEstimateId={estimateIdFromRoute}
            currentDescription={currentProposal.description}
            currentNumber={currentProposal.proposalNumber}
          />
        ) : undefined
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
    <div className="flex flex-col items-center justify-center min-h-screen bg-background text-center">
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

function AuthenticatedApp() {
  const { data: session, isPending } = useSession();
  const { workspace, isLoading: workspaceLoading } = useWorkspace();

  if (isPending) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Precision...</p>
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <AuthScreen
        appName="Precision"
        appDescription="Project estimating and cost management for construction professionals"
        onSuccess={() => {}}
      />
    );
  }

  // Hold the spinner until the workspace is the settled answer — the provider
  // keeps isLoading true through org auto-activation and the permissions
  // fetch, so neither the wall nor the shell renders from a transient state.
  if (workspaceLoading || !workspace) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
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
