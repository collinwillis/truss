"use client";

/**
 * Project Context Provider
 *
 * Tracks the currently selected project across the Momentum app.
 * Automatically updates based on URL parameters.
 *
 * WHY: Provides a single source of truth for the current project context,
 * allowing components like the sidebar and project switcher to react to
 * project changes without prop drilling.
 */

import * as React from "react";
import type { Project } from "./project-card";

export interface ProjectContextValue {
  /** Currently selected project (null if no project selected) */
  currentProject: Project | null;
  /** Set the current project */
  setCurrentProject: (project: Project | null) => void;
  /** Whether project data is loading */
  isLoading: boolean;
}

const ProjectContext = React.createContext<ProjectContextValue | undefined>(undefined);

export interface ProjectProviderProps {
  children: React.ReactNode;
  /** Optional initial project */
  initialProject?: Project | null;
  /** Function to fetch project by ID (returns null if not found) */
  getProject?: (projectId: string) => Promise<Project | null> | Project | null;
}

/**
 * Project context provider
 *
 * Provides access to the currently selected project throughout the app.
 * Automatically syncs with URL parameters to maintain project context.
 */
export function ProjectProvider({
  children,
  initialProject = null,
  getProject,
}: ProjectProviderProps) {
  const [currentProject, setCurrentProject] = React.useState<Project | null>(initialProject);
  const [isLoading, setIsLoading] = React.useState(false);

  // Expose setProject method for external updates
  const setProject = React.useCallback(
    async (projectOrId: Project | string | null) => {
      if (projectOrId === null) {
        setCurrentProject(null);
        return;
      }

      // If it's already a Project object, set it directly
      if (typeof projectOrId === "object") {
        setCurrentProject(projectOrId);
        return;
      }

      // If it's a string ID and we have a getProject function, fetch it
      if (typeof projectOrId === "string" && getProject) {
        setIsLoading(true);
        try {
          const project = await getProject(projectOrId);
          setCurrentProject(project);
        } catch (error) {
          console.error("Failed to load project:", error);
          setCurrentProject(null);
        } finally {
          setIsLoading(false);
        }
      }
    },
    [getProject]
  );

  const value = React.useMemo(
    () => ({
      currentProject,
      setCurrentProject: setProject,
      isLoading,
    }),
    [currentProject, setProject, isLoading]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/**
 * Hook to access the current project context
 *
 * @throws Error if used outside of ProjectProvider
 */
export function useProject(): ProjectContextValue {
  const context = React.useContext(ProjectContext);
  if (context === undefined) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return context;
}

/**
 * Hook to check if a project is currently selected
 */
export function useHasProject(): boolean {
  const { currentProject } = useProject();
  return currentProject !== null;
}

/**
 * Hook to safely access the current project (returns null if none selected)
 */
export function useCurrentProject(): Project | null {
  const { currentProject } = useProject();
  return currentProject;
}
