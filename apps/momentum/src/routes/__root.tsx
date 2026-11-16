import { createRootRoute, Outlet, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useSession, signOut, tauriAuthClient } from "../lib/auth-client";
import { WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import {
  AppShell,
  AuthScreen,
  ProjectProvider,
  ProjectSwitcher,
  useProject,
} from "@truss/features";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { canOpenMomentum, isWorkspaceAdmin } from "../lib/permissions";
import { MomentumAccessWall } from "../components/momentum-access-wall";
import type { ShellLinkProps } from "@truss/features/desktop-shell/types";
import { getGlobalShellConfig } from "../config/shell-config-global";
import { getProjectShellConfig } from "../config/shell-config-project";
import { forwardRef, useCallback, useEffect, useMemo } from "react";
import type { Project } from "@truss/features/progress-tracking";
import { UpdateProvider, useUpdate } from "@truss/features/desktop-shell/providers";
import { UpdateChecker } from "@truss/features/desktop-shell/components";

/**
 * Root route component providing authentication and app shell layout.
 *
 * Wraps all child routes with:
 * - Authentication context (Better Auth + Tauri deep links)
 * - Workspace provider for organization context
 * - Project provider for project-specific navigation
 * - Context-aware app shell with dynamic navigation
 * - TanStack Router dev tools (development only)
 *
 * WHY: Navigation adapts based on whether a project is selected.
 * When at /projects, shows project list actions only.
 * When at /project/:id/*, shows project-specific navigation.
 */
export const Route = createRootRoute({
  component: RootComponent,
});

/**
 * Router-aware link adapter for the shell package.
 *
 * WHY: The shell package is router-agnostic, so we bridge TanStack Router's
 * `Link` component to the shell's `ShellLinkProps` interface. This ensures
 * all sidebar and navigation clicks perform client-side transitions instead
 * of full-page reloads.
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
      setActiveOrganization={async (orgId) => {
        await tauriAuthClient.organization.setActive({ organizationId: orgId });
      }}
    >
      <ProjectProvider>
        <AuthenticatedApp />
      </ProjectProvider>
    </WorkspaceProvider>
  );
}

/**
 * Context-aware shell wrapper.
 *
 * WHY: Determines which shell config to use based on current project context.
 * Uses Convex reactive query so the project list auto-updates.
 */
function ContextAwareShell({ children }: { children: React.ReactNode }) {
  const { currentProject, setCurrentProject } = useProject();
  const { workspace } = useWorkspace();
  const { checkForUpdate } = useUpdate();
  const tanstackNavigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  // Owners and Admins: project lifecycle, settings, reports and Members all
  // follow this one predicate, which the shared admin pages' guard matches.
  const isAdmin = isWorkspaceAdmin(workspace);

  /** Client-side navigate function passed to shell configs and AppShell */
  const shellNavigate = useCallback(
    (to: string) => {
      tanstackNavigate({ to });
    },
    [tanstackNavigate]
  );

  // Fetch all projects for the switcher
  const projectsData = useQuery(api.momentum.listProjects);
  const recordView = useMutation(api.momentum.recordProjectView);

  // Map Convex results to the Project shape expected by ProjectSwitcher
  const projects: Project[] = useMemo(() => {
    if (!projectsData) return [];
    return projectsData;
  }, [projectsData]);

  // Extract projectId from current route
  const projectIdFromRoute = useMemo(() => {
    const match = currentPath.match(/^\/project\/([^/]+)/);
    return match ? match[1] : null;
  }, [currentPath]);

  // Update current project when route changes
  useEffect(() => {
    if (projectIdFromRoute) {
      const project = projects.find((p) => p.id === projectIdFromRoute);
      if (project && project.id !== currentProject?.id) {
        setCurrentProject(project);
      }
    } else if (currentProject !== null) {
      setCurrentProject(null);
    }
  }, [projectIdFromRoute, projects, currentProject, setCurrentProject]);

  // Record a "recent view" whenever the user enters a project
  useEffect(() => {
    if (projectIdFromRoute) {
      recordView({ projectId: projectIdFromRoute as never });
    }
  }, [projectIdFromRoute, recordView]);

  // Determine which config to use — pass navigate so handlers use client-side routing
  const shellConfig = useMemo(() => {
    if (currentProject) {
      return getProjectShellConfig(currentProject.id, shellNavigate, checkForUpdate, { isAdmin });
    }
    return getGlobalShellConfig(shellNavigate, checkForUpdate, { isAdmin });
  }, [currentProject, shellNavigate, checkForUpdate, isAdmin]);

  // Project switcher handlers
  const handleProjectSelect = (projectId: string) => {
    tanstackNavigate({
      to: "/project/$projectId",
      params: { projectId },
      search: { wbs: undefined },
    });
  };

  const handleViewAll = () => {
    tanstackNavigate({ to: "/projects" });
  };

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
        currentProject ? (
          <ProjectSwitcher
            currentProject={currentProject}
            projects={projects}
            onProjectSelect={handleProjectSelect}
            onViewAll={handleViewAll}
          />
        ) : undefined
      }
    >
      {children}
    </AppShell>
  );
}

/** Full-window spinner for the moments before the shell can render. */
function LoadingScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
        <p className="text-muted-foreground">Loading Momentum...</p>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const { data: session, isPending } = useSession();
  const { workspace, isLoading: workspaceLoading } = useWorkspace();

  if (isPending) {
    return <LoadingScreen />;
  }

  if (!session?.user) {
    return (
      <AuthScreen
        appName="Momentum"
        onSuccess={() => {
          // Session hook will automatically update and re-render
        }}
      />
    );
  }

  // Hold the spinner until the workspace is the settled answer: the provider
  // keeps it loading through org activation and the access read, so the wall
  // never flashes at someone who has access.
  if (workspaceLoading || !workspace) {
    return <LoadingScreen />;
  }

  if (!canOpenMomentum(workspace)) {
    return (
      <MomentumAccessWall
        activeMember={workspace.role === "member"}
        suspended={workspace.suspended}
        onSignOut={() => {
          void signOut();
        }}
      />
    );
  }

  return (
    <UpdateProvider>
      <UpdateChecker />
      <ContextAwareShell>
        <Outlet />
        <TanStackRouterDevtools />
      </ContextAwareShell>
    </UpdateProvider>
  );
}
