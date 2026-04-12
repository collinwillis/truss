/**
 * Estimate-Specific Shell Configuration
 *
 * Navigation when inside a specific estimate, showing overview and WBS items.
 *
 * WHY: Accepts a `navigate` function so all navigation is client-side.
 * This prevents full-page reloads when switching between routes.
 */

import {
  Calculator,
  FileText,
  Layers,
  ArrowLeftRight,
  RefreshCw,
  Users,
  Download,
} from "lucide-react";
import type {
  AppShellConfig,
  CommandConfig,
  SidebarItem,
  ShellNavigateFunction,
} from "@truss/features/desktop-shell/types";

/** Phase item shape for sidebar tree navigation. */
interface PhaseNavItem {
  id: string;
  phaseNumber: number;
  description: string;
}

/** WBS item shape with nested phases for tree navigation. */
interface WBSNavItem {
  id: string;
  name: string;
  phases?: PhaseNavItem[];
}

/** Generate shell configuration for a specific estimate context. */
export function getEstimateShellConfig(
  estimateId: string,
  navigate: ShellNavigateFunction,
  onCheckForUpdate?: () => void | Promise<void>,
  options?: { isAdmin?: boolean; wbsItems?: WBSNavItem[] }
): AppShellConfig {
  // Build dynamic WBS sidebar items with nested phase children
  const wbsSidebarItems: SidebarItem[] = (options?.wbsItems ?? []).map((wbs) => ({
    id: `wbs-${wbs.id}`,
    label: wbs.name,
    href: `/estimate/${estimateId}/wbs/${wbs.id}`,
    icon: Layers,
    children: (wbs.phases ?? []).map((phase) => ({
      id: `phase-${phase.id}`,
      label: `${phase.phaseNumber} — ${phase.description}`,
      href: `/estimate/${estimateId}/phase/${phase.id}`,
    })),
  }));

  const commands: CommandConfig[] = [
    {
      id: "estimate-overview",
      label: "Estimate Overview",
      icon: FileText,
      category: "Navigation",
      shortcut: "⌘1",
      searchTerms: ["overview", "info", "rates", "estimate", "detail"],
      handler: () => navigate(`/estimate/${estimateId}`),
    },
    {
      id: "switch-estimate",
      label: "Switch Estimate",
      icon: ArrowLeftRight,
      category: "Estimates",
      shortcut: "⌘⇧O",
      searchTerms: ["switch", "change", "estimate", "select"],
      handler: () => {
        document.dispatchEvent(new CustomEvent("open-estimate-switcher"));
      },
    },
    {
      id: "all-estimates",
      label: "All Estimates",
      icon: Calculator,
      category: "Estimates",
      shortcut: "⌘P",
      searchTerms: ["estimates", "list", "all", "back"],
      handler: () => navigate("/estimates"),
    },
    {
      id: "export-estimate",
      label: "Export Estimate",
      icon: Download,
      category: "Estimates",
      shortcut: "⌘⇧E",
      searchTerms: ["export", "download", "excel", "spreadsheet"],
      handler: () => {
        document.dispatchEvent(new CustomEvent("export-estimate"));
      },
    },
  ];

  if (options?.isAdmin) {
    commands.push({
      id: "manage-members",
      label: "Manage Members",
      icon: Users,
      category: "Admin",
      searchTerms: ["admin", "members", "users", "manage"],
      handler: () => navigate("/admin"),
    });
  }

  if (onCheckForUpdate) {
    commands.push({
      id: "check-for-updates",
      label: "Check for Updates",
      icon: RefreshCw,
      category: "Application",
      searchTerms: ["update", "upgrade", "version"],
      handler: onCheckForUpdate,
    });
  }

  return {
    app: {
      name: "Precision",
      version: "1.0.0",
      icon: Calculator,
    },

    sidebar: {
      sections: [
        {
          id: "estimate-nav",
          collapsible: false,
          items: [
            {
              id: "overview",
              label: "Overview",
              href: `/estimate/${estimateId}`,
              icon: FileText,
            },
          ],
        },
        // Dynamic WBS items — populated from Convex query
        ...(wbsSidebarItems.length > 0
          ? [
              {
                id: "wbs-nav",
                label: "Work Breakdown",
                collapsible: false,
                items: wbsSidebarItems,
              },
            ]
          : []),
        {
          id: "footer-actions",
          collapsible: false,
          items: [
            {
              id: "all-estimates",
              label: "All Estimates",
              href: "/estimates",
              icon: Calculator,
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

    commands,

    shortcuts: [
      {
        key: "cmd+1",
        handler: () => navigate(`/estimate/${estimateId}`),
        description: "Go to Overview",
      },
      {
        key: "cmd+b",
        handler: () => document.dispatchEvent(new CustomEvent("toggle-sidebar")),
        description: "Toggle Sidebar",
      },
      {
        key: "cmd+shift+o",
        handler: () => document.dispatchEvent(new CustomEvent("open-estimate-switcher")),
        description: "Switch Estimate",
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
