/**
 * Project-Specific Shell Configuration
 *
 * Simplified navigation with 3 primary destinations:
 * Workbook, Reports, Settings.
 *
 * WHY: Accepts a `navigate` function so all navigation is client-side.
 * This prevents full-page reloads when switching between routes.
 */

import { Activity, BarChart3, Table2, Settings, ArrowLeftRight, Building2 } from "lucide-react";
import type { AppShellConfig, ShellNavigateFunction } from "@truss/features/desktop-shell/types";

/**
 * Generate shell configuration for a specific project context.
 *
 * WHY: Reduces cognitive load by limiting navigation to 3 core destinations.
 * The workbook serves as both dashboard and entry surface.
 */
export function getProjectShellConfig(
  projectId: string,
  navigate: ShellNavigateFunction
): AppShellConfig {
  return {
    app: {
      name: "Momentum",
      version: "1.0.0",
      icon: Activity,
    },

    sidebar: {
      sections: [
        {
          id: "main-nav",
          collapsible: false,
          items: [
            {
              id: "workbook",
              label: "Workbook",
              href: `/project/${projectId}`,
              icon: Table2,
            },
            {
              id: "reports",
              label: "Reports",
              href: `/project/${projectId}/reports`,
              icon: BarChart3,
            },
            {
              id: "settings",
              label: "Project Settings",
              href: `/project/${projectId}/settings`,
              icon: Settings,
            },
          ],
        },
        {
          id: "footer-actions",
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
        id: "workbook",
        label: "Open Workbook",
        icon: Table2,
        category: "Navigation",
        shortcut: "⌘1",
        searchTerms: ["workbook", "table", "entry", "progress", "enter", "dashboard", "overview"],
        handler: () => navigate(`/project/${projectId}`),
      },
      {
        id: "reports",
        label: "View Reports",
        icon: BarChart3,
        category: "Navigation",
        shortcut: "⌘2",
        searchTerms: ["reports", "summary", "export", "excel"],
        handler: () => navigate(`/project/${projectId}/reports`),
      },
      {
        id: "project-settings",
        label: "Project Settings",
        icon: Settings,
        category: "Settings",
        shortcut: "⌘3",
        searchTerms: ["settings", "preferences", "config", "options"],
        handler: () => navigate(`/project/${projectId}/settings`),
      },
      {
        id: "switch-project",
        label: "Switch Project",
        icon: ArrowLeftRight,
        category: "Projects",
        shortcut: "⌘⇧P",
        searchTerms: ["switch", "change", "project", "select"],
        handler: () => {
          document.dispatchEvent(new CustomEvent("open-project-switcher"));
        },
      },
      {
        id: "view-projects",
        label: "All Projects",
        icon: Building2,
        category: "Projects",
        shortcut: "⌘P",
        searchTerms: ["projects", "list", "all", "view"],
        handler: () => navigate("/projects"),
      },
    ],

    shortcuts: [
      {
        key: "cmd+1",
        handler: () => navigate(`/project/${projectId}`),
        description: "Go to Workbook",
      },
      {
        key: "cmd+2",
        handler: () => navigate(`/project/${projectId}/reports`),
        description: "Go to Reports",
      },
      {
        key: "cmd+3",
        handler: () => navigate(`/project/${projectId}/settings`),
        description: "Go to Settings",
      },
      {
        key: "cmd+h",
        handler: () => document.dispatchEvent(new CustomEvent("toggle-history-panel")),
        description: "Toggle History Panel",
      },
      {
        key: "cmd+b",
        handler: () => document.dispatchEvent(new CustomEvent("toggle-sidebar")),
        description: "Toggle Sidebar",
      },
      {
        key: "cmd+shift+p",
        handler: () => document.dispatchEvent(new CustomEvent("open-project-switcher")),
        description: "Switch Project",
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
