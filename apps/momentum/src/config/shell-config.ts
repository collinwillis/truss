/**
 * Momentum Shell Configuration
 *
 * Desktop application shell configuration for construction project progress tracking.
 * Focused on WBS (Work Breakdown Structure) management and daily quantity entry.
 */

import {
  Activity,
  FolderOpen,
  BarChart3,
  Settings,
  Plus,
  Save,
  Download,
  TrendingUp,
  ListTree,
  FileText,
  Building2,
  ArrowLeftRight,
  Edit,
  Upload,
} from "lucide-react";
import type { AppShellConfig } from "@truss/features/desktop-shell/types";

export const momentumShellConfig: AppShellConfig = {
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
        defaultOpen: true,
        items: [
          {
            id: "all-projects",
            label: "All Projects",
            href: "/projects",
            icon: Building2,
          },
          {
            id: "active-projects",
            label: "Active Projects",
            href: "/projects/active",
            badge: "3",
          },
        ],
      },
      {
        id: "progress",
        label: "Progress Tracking",
        icon: Activity,
        defaultOpen: true,
        items: [
          {
            id: "dashboard",
            label: "Dashboard",
            href: "/",
            icon: BarChart3,
          },
          {
            id: "enter-progress",
            label: "Enter Progress",
            href: "/entry",
            icon: Plus,
            badge: "New",
          },
          {
            id: "browse-items",
            label: "Browse All Items",
            href: "/browse",
            icon: ListTree,
          },
        ],
      },
      {
        id: "reports",
        label: "Reports",
        icon: FileText,
        items: [
          {
            id: "progress-summary",
            label: "Progress Summary",
            href: "/reports/summary",
            icon: BarChart3,
          },
          {
            id: "earned-value",
            label: "Earned Value Analysis",
            href: "/reports/earned-value",
            icon: TrendingUp,
          },
          {
            id: "export-excel",
            label: "Export to Excel",
            href: "/reports/export",
            icon: Download,
          },
        ],
      },
    ],

    pinnedItems: ["all-projects", "dashboard", "enter-progress"],

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

    // Progress Entry Commands
    {
      id: "enter-progress",
      label: "Enter Progress",
      icon: Plus,
      category: "Progress",
      shortcut: "⌘N",
      searchTerms: ["enter", "progress", "quantity", "daily", "entry"],
      handler: () => {
        window.location.href = "/entry";
      },
    },
    {
      id: "view-dashboard",
      label: "View Dashboard",
      icon: BarChart3,
      category: "Progress",
      shortcut: "⌘D",
      searchTerms: ["dashboard", "overview", "summary", "wbs"],
      handler: () => {
        window.location.href = "/";
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
        window.location.href = "/browse";
      },
    },

    // Entry Commands
    {
      id: "save-entry",
      label: "Save Current Entry",
      icon: Save,
      category: "Progress",
      shortcut: "⌘S",
      searchTerms: ["save", "store", "entry"],
      handler: () => {
        document.dispatchEvent(new CustomEvent("save-entry"));
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
        window.location.href = "/reports/summary";
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

    // Settings
    {
      id: "settings",
      label: "Settings",
      icon: Settings,
      category: "System",
      shortcut: "⌘,",
      searchTerms: ["settings", "preferences", "config", "options"],
      handler: () => {
        window.location.href = "/settings";
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
    { key: "cmd+2", handler: () => (window.location.href = "/"), description: "Go to Dashboard" },
    {
      key: "cmd+3",
      handler: () => (window.location.href = "/entry"),
      description: "Go to Enter Progress",
    },
    {
      key: "cmd+4",
      handler: () => (window.location.href = "/reports/summary"),
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
    {
      key: "cmd+delete",
      handler: () => document.dispatchEvent(new CustomEvent("delete-entry")),
      description: "Delete Entry",
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
