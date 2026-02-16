/**
 * Project-Specific Shell Configuration
 *
 * Simplified navigation with 4 primary destinations:
 * Dashboard, Workbook, Reports, Settings.
 */

import {
  Activity,
  BarChart3,
  Table2,
  Settings,
  ArrowLeftRight,
  Building2,
  LayoutGrid,
} from "lucide-react";
import type { AppShellConfig } from "@truss/features/desktop-shell/types";

/**
 * Generate shell configuration for a specific project context.
 *
 * WHY: Reduces cognitive load by limiting navigation to 4 core destinations.
 * All routes include the projectId to maintain context.
 */
export function getProjectShellConfig(projectId: string): AppShellConfig {
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
          label: "Navigation",
          collapsible: false,
          items: [
            {
              id: "dashboard",
              label: "Dashboard",
              href: `/project/${projectId}`,
              icon: LayoutGrid,
            },
            {
              id: "workbook",
              label: "Workbook",
              href: `/project/${projectId}/workbook`,
              icon: Table2,
              badge: "Entry",
            },
            {
              id: "reports",
              label: "Reports",
              href: `/project/${projectId}/reports`,
              icon: BarChart3,
            },
            {
              id: "settings",
              label: "Settings",
              href: `/project/${projectId}/settings`,
              icon: Settings,
            },
          ],
        },
        {
          id: "footer-actions",
          label: "Projects",
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
        id: "view-dashboard",
        label: "View Dashboard",
        icon: LayoutGrid,
        category: "Navigation",
        shortcut: "⌘D",
        searchTerms: ["dashboard", "overview", "summary", "wbs"],
        handler: () => {
          window.location.href = `/project/${projectId}`;
        },
      },
      {
        id: "workbook",
        label: "Open Workbook",
        icon: Table2,
        category: "Navigation",
        shortcut: "⌘W",
        searchTerms: ["workbook", "table", "entry", "progress", "enter"],
        handler: () => {
          window.location.href = `/project/${projectId}/workbook`;
        },
      },
      {
        id: "reports",
        label: "View Reports",
        icon: BarChart3,
        category: "Navigation",
        shortcut: "⌘R",
        searchTerms: ["reports", "summary", "export", "excel"],
        handler: () => {
          window.location.href = `/project/${projectId}/reports`;
        },
      },
      {
        id: "project-settings",
        label: "Project Settings",
        icon: Settings,
        category: "Settings",
        shortcut: "⌘,",
        searchTerms: ["settings", "preferences", "config", "options"],
        handler: () => {
          window.location.href = `/project/${projectId}/settings`;
        },
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
        handler: () => {
          window.location.href = "/projects";
        },
      },
    ],

    shortcuts: [
      {
        key: "cmd+1",
        handler: () => (window.location.href = `/project/${projectId}`),
        description: "Go to Dashboard",
      },
      {
        key: "cmd+2",
        handler: () => (window.location.href = `/project/${projectId}/workbook`),
        description: "Go to Workbook",
      },
      {
        key: "cmd+3",
        handler: () => (window.location.href = `/project/${projectId}/reports`),
        description: "Go to Reports",
      },
      {
        key: "cmd+4",
        handler: () => (window.location.href = `/project/${projectId}/settings`),
        description: "Go to Settings",
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
