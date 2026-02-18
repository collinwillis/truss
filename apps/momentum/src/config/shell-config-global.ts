/**
 * Global Shell Configuration (No Project Selected)
 *
 * Navigation configuration when user is at the project list level.
 * Shows only project list actions and no project-specific features.
 *
 * WHY: Accepts a `navigate` function so all navigation is client-side.
 * This prevents full-page reloads when switching between routes.
 */

import { FolderOpen, Building2, Plus, Activity } from "lucide-react";
import type { AppShellConfig, ShellNavigateFunction } from "@truss/features/desktop-shell/types";

/**
 * Generate shell configuration for global (no project) context.
 *
 * WHY: When no project is selected, we should only show project list actions.
 * Showing "Dashboard" or "Enter Progress" would be confusing without project context.
 */
export function getGlobalShellConfig(navigate: ShellNavigateFunction): AppShellConfig {
  return {
    app: {
      name: "Momentum",
      version: "1.0.0",
      icon: Activity,
    },

    sidebar: {
      sections: [
        {
          id: "projects",
          collapsible: false,
          items: [
            {
              id: "all-projects",
              label: "All Projects",
              href: "/projects",
              icon: Building2,
            },
          ],
        },
      ],

      pinnedItems: [],

      footer: {
        showUserMenu: true,
        showSettings: true,
        showHelp: true,
        showConnectionStatus: true,
      },

      defaultCollapsed: false,
      collapsedWidth: 48,
      expandedWidth: 240,
    },

    commands: [
      {
        id: "view-projects",
        label: "View All Projects",
        icon: FolderOpen,
        category: "Projects",
        shortcut: "⌘P",
        searchTerms: ["projects", "list", "all", "view"],
        handler: () => navigate("/projects"),
      },
      {
        id: "create-project",
        label: "New Project",
        icon: Plus,
        category: "Projects",
        shortcut: "⌘N",
        searchTerms: ["create", "new", "project", "import", "estimate"],
        handler: () => {
          navigate("/projects");
          document.dispatchEvent(new CustomEvent("open-create-project"));
        },
      },
    ],

    shortcuts: [
      {
        key: "cmd+1",
        handler: () => navigate("/projects"),
        description: "Go to Projects",
      },
      {
        key: "cmd+b",
        handler: () => document.dispatchEvent(new CustomEvent("toggle-sidebar")),
        description: "Toggle Sidebar",
      },
    ],

    theme: {
      mode: "system",
      accent: "zinc",
      density: "comfortable",
    },

    layout: {
      default: "three-column",
      allowModeSwitch: true,
      persistState: true,
    },

    features: {
      commandPalette: true,
      globalSearch: true,
      notifications: true,
      statusBar: true,
      activityBar: false,
      workspaceSwitcher: false,
      multiWindow: false,
    },
  };
}
