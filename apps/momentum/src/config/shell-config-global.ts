/**
 * Global Shell Configuration (No Project Selected)
 *
 * Navigation configuration when user is at the project list level.
 * Shows only project list actions and no project-specific features.
 */

import { FolderOpen, Building2, Plus, Upload, Activity } from "lucide-react";
import type { AppShellConfig } from "@truss/features/desktop-shell/types";

/**
 * Shell configuration for global (no project) context
 *
 * WHY: When no project is selected, we should only show project list actions.
 * Showing "Dashboard" or "Enter Progress" would be confusing without project context.
 */
export const globalShellConfig: AppShellConfig = {
  app: {
    name: "Momentum",
    version: "1.0.0",
    icon: Activity,
  },

  sidebar: {
    sections: [
      {
        id: "projects",
        label: "Projects",
        icon: FolderOpen,
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
    // Project Commands
    {
      id: "view-projects",
      label: "View All Projects",
      icon: FolderOpen,
      category: "Projects",
      shortcut: "⌘P",
      searchTerms: ["projects", "list", "all", "view"],
      handler: () => {
        window.location.href = "/projects";
      },
    },
    {
      id: "create-project",
      label: "Create New Project",
      icon: Plus,
      category: "Projects",
      shortcut: "⌘N",
      searchTerms: ["create", "new", "project"],
      handler: () => {
        window.location.href = "/projects/new";
      },
    },
    {
      id: "import-mcp",
      label: "Import from MCP",
      icon: Upload,
      category: "Projects",
      searchTerms: ["import", "mcp", "load"],
      handler: () => {
        window.location.href = "/projects/import";
      },
    },
  ],

  shortcuts: [
    {
      key: "cmd+1",
      handler: () => (window.location.href = "/projects"),
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
