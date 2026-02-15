import { createRootRoute, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { useSession, signOut } from "../lib/auth-client";
import { WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import {
  AppShell,
  AuthScreen,
  ProjectProvider,
  ProjectSwitcher,
  useProject,
} from "@truss/features";
import { globalShellConfig } from "../config/shell-config-global";
import { getProjectShellConfig } from "../config/shell-config-project";
import { getProjectById, mockProjects } from "../data/mock-progress-data";
import { useEffect, useMemo } from "react";
import type { Project } from "@truss/features/progress-tracking";

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
 * WHY: Navigation now adapts based on whether a project is selected.
 * When at /projects, shows project list actions only.
 * When at /project/:id/*, shows project-specific navigation.
 */
export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <WorkspaceProvider>
      <ProjectProvider
        getProject={(projectId) => {
          // Fetch project from mock data (in production, this would be an API call)
          return getProjectById(projectId);
        }}
      >
        <AuthenticatedApp />
      </ProjectProvider>
    </WorkspaceProvider>
  );
}

/**
 * Context-aware shell wrapper
 *
 * WHY: Determines which shell config to use based on current project context.
 * Automatically switches navigation when project changes.
 */
function ContextAwareShell({ children }: { children: React.ReactNode }) {
  const { currentProject, setCurrentProject } = useProject();
  const navigate = useNavigate();
  const routerState = useRouterState();

  // Extract projectId from current route
  const projectIdFromRoute = useMemo(() => {
    const match = routerState.location.pathname.match(/^\/project\/([^/]+)/);
    return match ? match[1] : null;
  }, [routerState.location.pathname]);

  // Update current project when route changes
  useEffect(() => {
    if (projectIdFromRoute) {
      const project = getProjectById(projectIdFromRoute);
      if (project && project.id !== currentProject?.id) {
        setCurrentProject(project);
      }
    } else if (currentProject !== null) {
      // Clear project when navigating away from project routes
      setCurrentProject(null);
    }
  }, [projectIdFromRoute, currentProject, setCurrentProject]);

  // Determine which config to use
  const shellConfig = useMemo(() => {
    if (currentProject) {
      return getProjectShellConfig(currentProject.id);
    }
    return globalShellConfig;
  }, [currentProject]);

  // Project switcher handlers
  const handleProjectSelect = (projectId: string) => {
    navigate({ to: "/project/$projectId", params: { projectId } });
  };

  const handleViewAll = () => {
    navigate({ to: "/projects" });
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
      onCommandExecute={(commandId) => {}}
      onLogout={handleLogout}
      topBarContent={
        <ProjectSwitcher
          currentProject={currentProject}
          projects={mockProjects}
          onProjectSelect={handleProjectSelect}
          onViewAll={handleViewAll}
        />
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
          <p className="text-muted-foreground">Loading Momentum...</p>
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <AuthScreen
        appName="Momentum"
        appDescription="Project tracking and progress management for construction teams"
        onSuccess={() => {
          // Session hook will automatically update and re-render
        }}
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
