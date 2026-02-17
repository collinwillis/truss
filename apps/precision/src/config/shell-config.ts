/**
 * Precision Shell Configuration
 *
 * Desktop application shell configuration for the Precision estimating app.
 */

import {
  Calculator,
  FolderOpen,
  BarChart3,
  FileText,
  Settings,
  Search,
  Plus,
  Save,
  Download,
  Upload,
  Users,
  DollarSign,
  TrendingUp,
  Package,
  Briefcase,
  FileSpreadsheet,
  Clock,
  Archive,
  Hash,
} from "lucide-react";
import type { AppShellConfig } from "@truss/features/desktop-shell/types";

export const precisionShellConfig: AppShellConfig = {
  app: {
    name: "Precision",
    version: "1.0.0",
    icon: Calculator,
  },

  sidebar: {
    sections: [
      {
        id: "estimates",
        label: "Estimates",
        icon: Calculator,
        defaultOpen: true,
        items: [
          {
            id: "active-estimates",
            label: "Active Estimates",
            href: "/estimates/active",
            icon: FileText,
            badge: "12",
          },
          {
            id: "drafts",
            label: "Drafts",
            href: "/estimates/drafts",
            icon: FileSpreadsheet,
            badge: "3",
          },
          {
            id: "templates",
            label: "Templates",
            href: "/estimates/templates",
            icon: Package,
          },
          {
            id: "archived",
            label: "Archived",
            href: "/estimates/archived",
            icon: Archive,
          },
        ],
      },
      {
        id: "projects",
        label: "Projects",
        icon: FolderOpen,
        items: [
          {
            id: "all-projects",
            label: "All Projects",
            href: "/projects",
            icon: Briefcase,
          },
          {
            id: "recent-projects",
            label: "Recent",
            href: "/projects/recent",
            icon: Clock,
          },
          {
            id: "project-categories",
            label: "Categories",
            href: "/projects/categories",
            icon: Hash,
          },
        ],
      },
      {
        id: "cost-database",
        label: "Cost Database",
        icon: DollarSign,
        items: [
          {
            id: "materials",
            label: "Materials",
            href: "/costs/materials",
          },
          {
            id: "labor",
            label: "Labor Rates",
            href: "/costs/labor",
          },
          {
            id: "equipment",
            label: "Equipment",
            href: "/costs/equipment",
          },
          {
            id: "vendors",
            label: "Vendors",
            href: "/costs/vendors",
            icon: Users,
          },
        ],
      },
      {
        id: "reports",
        label: "Reports",
        icon: BarChart3,
        items: [
          {
            id: "cost-analysis",
            label: "Cost Analysis",
            href: "/reports/cost",
            icon: TrendingUp,
          },
          {
            id: "variance",
            label: "Variance Reports",
            href: "/reports/variance",
          },
          {
            id: "profitability",
            label: "Profitability",
            href: "/reports/profitability",
            icon: DollarSign,
          },
          {
            id: "custom-reports",
            label: "Custom Reports",
            href: "/reports/custom",
          },
        ],
      },
    ],

    pinnedItems: ["active-estimates", "recent-projects"],

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
    // Estimate Commands
    {
      id: "new-estimate",
      label: "New Estimate",
      icon: Plus,
      category: "Estimates",
      shortcut: "⌘N",
      searchTerms: ["create", "new", "estimate", "quote"],
      handler: () => {
        window.location.href = "/estimates/new";
      },
    },
    {
      id: "open-estimate",
      label: "Open Estimate",
      icon: FileText,
      category: "Estimates",
      shortcut: "⌘O",
      searchTerms: ["open", "load", "estimate"],
      handler: () => {
        window.location.href = "/estimates";
      },
    },
    {
      id: "save-estimate",
      label: "Save Current Estimate",
      icon: Save,
      category: "Estimates",
      shortcut: "⌘S",
      searchTerms: ["save", "store", "estimate"],
      handler: () => {
        // Trigger save action
        document.dispatchEvent(new CustomEvent("save-estimate"));
      },
    },
    {
      id: "export-estimate",
      label: "Export Estimate",
      icon: Download,
      category: "Estimates",
      shortcut: "⌘E",
      searchTerms: ["export", "download", "pdf", "excel"],
      handler: () => {
        document.dispatchEvent(new CustomEvent("export-estimate"));
      },
    },

    // Project Commands
    {
      id: "search-projects",
      label: "Search Projects",
      icon: Search,
      category: "Projects",
      shortcut: "⌘F",
      searchTerms: ["find", "search", "projects", "locate"],
      handler: () => {
        window.location.href = "/projects?search=true";
      },
    },
    {
      id: "import-project",
      label: "Import Project Data",
      icon: Upload,
      category: "Projects",
      searchTerms: ["import", "upload", "project"],
      handler: () => {
        document.dispatchEvent(new CustomEvent("import-project"));
      },
    },

    // Cost Database Commands
    {
      id: "update-costs",
      label: "Update Cost Database",
      icon: DollarSign,
      category: "Cost Database",
      searchTerms: ["update", "costs", "prices", "database"],
      handler: () => {
        window.location.href = "/costs/update";
      },
    },

    // Report Commands
    {
      id: "generate-report",
      label: "Generate Report",
      icon: BarChart3,
      category: "Reports",
      shortcut: "⌘R",
      searchTerms: ["generate", "create", "report"],
      handler: () => {
        window.location.href = "/reports/new";
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
      handler: () => (window.location.href = "/estimates"),
      description: "Go to Estimates",
    },
    {
      key: "cmd+2",
      handler: () => (window.location.href = "/projects"),
      description: "Go to Projects",
    },
    {
      key: "cmd+3",
      handler: () => (window.location.href = "/costs"),
      description: "Go to Cost Database",
    },
    {
      key: "cmd+4",
      handler: () => (window.location.href = "/reports"),
      description: "Go to Reports",
    },

    // View toggles
    {
      key: "cmd+b",
      handler: () => document.dispatchEvent(new CustomEvent("toggle-sidebar")),
      description: "Toggle Sidebar",
    },
    {
      key: "cmd+\\",
      handler: () => document.dispatchEvent(new CustomEvent("toggle-master-list")),
      description: "Toggle Master List",
    },

    // Actions
    {
      key: "cmd+shift+n",
      handler: () => (window.location.href = "/projects/new"),
      description: "New Project",
    },
    {
      key: "cmd+shift+s",
      handler: () => document.dispatchEvent(new CustomEvent("save-as-template")),
      description: "Save as Template",
    },
    {
      key: "cmd+d",
      handler: () => document.dispatchEvent(new CustomEvent("duplicate-item")),
      description: "Duplicate Item",
    },
    {
      key: "cmd+delete",
      handler: () => document.dispatchEvent(new CustomEvent("delete-item")),
      description: "Delete Item",
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
