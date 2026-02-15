/**
 * Project-Specific Shell Configuration
 *
 * Navigation configuration when a project is selected.
 * Shows project-specific actions and tools relevant to the current project.
 */

import {
  Activity,
  BarChart3,
  Plus,
  ListTree,
  TrendingUp,
  Download,
  Settings,
  Edit,
  FileEdit,
  ArrowLeftRight,
  Building2,
  LayoutGrid,
  Info,
  DollarSign,
} from "lucide-react";
import type { AppShellConfig } from "@truss/features/desktop-shell/types";

/**
 * Generate shell configuration for a specific project context
 *
 * WHY: When a project is selected, navigation should reflect project-specific
 * actions. All routes include the projectId to maintain context.
 *
 * @param projectId - The ID of the currently selected project
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
        // Main Navigation - Single flat list with visual separators
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
              id: "enter-progress",
              label: "Enter Progress",
              href: `/project/${projectId}/entry`,
              icon: Plus,
              badge: "New",
            },
            {
              id: "browse-items",
              label: "All Work Items",
              href: `/project/${projectId}/browse`,
              icon: ListTree,
            },
          ],
        },
        // Reports Section - Separated by visual divider
        {
          id: "reports",
          label: "Reports",
          collapsible: false,
          items: [
            {
              id: "progress-summary",
              label: "Progress Summary",
              href: `/project/${projectId}/reports/summary`,
              icon: TrendingUp,
            },
            {
              id: "earned-value",
              label: "Earned Value",
              href: `/project/${projectId}/reports/earned-value`,
              icon: DollarSign,
            },
            {
              id: "export-excel",
              label: "Export Excel",
              href: `/project/${projectId}/reports/export`,
              icon: Download,
            },
          ],
        },
        // Settings Section - Separated by visual divider
        {
          id: "settings",
          label: "Settings",
          collapsible: false,
          items: [
            {
              id: "edit-estimate",
              label: "Edit Estimate",
              href: `/project/${projectId}/settings/estimate`,
              icon: Edit,
            },
            {
              id: "project-settings",
              label: "Project Settings",
              href: `/project/${projectId}/settings`,
              icon: Settings,
            },
          ],
        },
        // Footer Actions - Separated by visual divider
        {
          id: "footer-actions",
          label: "Projects",
          collapsible: false,
          items: [
            {
              id: "all-projects",
              label: "View All Projects",
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
      // Project Navigation Commands
      {
        id: "view-dashboard",
        label: "View Dashboard",
        icon: BarChart3,
        category: "Navigation",
        shortcut: "⌘D",
        searchTerms: ["dashboard", "overview", "summary", "wbs"],
        handler: () => {
          window.location.href = `/project/${projectId}`;
        },
      },
      {
        id: "enter-progress",
        label: "Enter Progress",
        icon: Plus,
        category: "Progress",
        shortcut: "⌘N",
        searchTerms: ["enter", "progress", "quantity", "daily", "entry"],
        handler: () => {
          window.location.href = `/project/${projectId}/entry`;
        },
      },
      {
        id: "browse-items",
        label: "Browse Work Items",
        icon: ListTree,
        category: "Progress",
        shortcut: "⌘B",
        searchTerms: ["browse", "view", "items", "wbs", "phases"],
        handler: () => {
          window.location.href = `/project/${projectId}/browse`;
        },
      },

      // Report Commands
      {
        id: "progress-summary",
        label: "Progress Summary",
        icon: BarChart3,
        category: "Reports",
        shortcut: "⌘R",
        searchTerms: ["summary", "report", "progress"],
        handler: () => {
          window.location.href = `/project/${projectId}/reports/summary`;
        },
      },
      {
        id: "export-excel",
        label: "Export to Excel",
        icon: Download,
        category: "Reports",
        shortcut: "⌘E",
        searchTerms: ["export", "download", "excel", "xlsx"],
        handler: () => {
          document.dispatchEvent(new CustomEvent("export-excel"));
        },
      },

      // Project Actions
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
        label: "View All Projects",
        icon: Building2,
        category: "Projects",
        shortcut: "⌘P",
        searchTerms: ["projects", "list", "all", "view"],
        handler: () => {
          window.location.href = "/projects";
        },
      },

      // Settings
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
    ],

    shortcuts: [
      // Navigation
      {
        key: "cmd+1",
        handler: () => (window.location.href = "/projects"),
        description: "Go to Projects",
      },
      {
        key: "cmd+2",
        handler: () => (window.location.href = `/project/${projectId}`),
        description: "Go to Dashboard",
      },
      {
        key: "cmd+3",
        handler: () => (window.location.href = `/project/${projectId}/entry`),
        description: "Go to Enter Progress",
      },
      {
        key: "cmd+4",
        handler: () => (window.location.href = `/project/${projectId}/reports/summary`),
        description: "Go to Reports",
      },

      // View toggles
      {
        key: "cmd+b",
        handler: () => document.dispatchEvent(new CustomEvent("toggle-sidebar")),
        description: "Toggle Sidebar",
      },

      // Quick actions
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
      workspaceSwitcher: true,
      multiWindow: false,
    },
  };
}
