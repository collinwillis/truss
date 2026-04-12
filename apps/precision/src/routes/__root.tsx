import { createRootRoute, Outlet, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useQuery } from "convex/react";
import { useSession, signOut, tauriAuthClient } from "../lib/auth-client";
import { WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import { AppShell, AuthScreen } from "@truss/features";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import type { ShellLinkProps } from "@truss/features/desktop-shell/types";
import { api } from "@truss/backend/convex/_generated/api";
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

  // Fetch proposal metadata for the estimate switcher
  const currentProposal = useQuery(
    api.precision.getProposal,
    estimateIdFromRoute ? { proposalId: estimateIdFromRoute as never } : "skip"
  );

  // Select shell config based on context — dynamically populates WBS in sidebar
  const shellConfig = useMemo(() => {
    if (estimateIdFromRoute) {
      return getEstimateShellConfig(estimateIdFromRoute, shellNavigate, undefined, {
        isAdmin: !!isAdmin,
        wbsItems: (wbsWithPhases ?? []).map((w) => ({
          id: w._id,
          name: w.name,
          phases: w.phases.map((p) => ({
            id: p._id,
            phaseNumber: p.phaseNumber,
            description: p.description,
          })),
        })),
      });
    }
    return getGlobalShellConfig(shellNavigate, undefined, { isAdmin: !!isAdmin });
  }, [estimateIdFromRoute, shellNavigate, isAdmin, wbsWithPhases]);

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

function AuthenticatedApp() {
  const { data: session, isPending } = useSession();

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

  return (
    <ContextAwareShell>
      <Outlet />
      <TanStackRouterDevtools />
    </ContextAwareShell>
  );
}
