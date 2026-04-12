/**
 * Global Shell Configuration (No Estimate Selected)
 *
 * Navigation when the user is at the estimates list, pools, or admin level.
 *
 * WHY: Accepts a `navigate` function so all navigation is client-side.
 * This prevents full-page reloads when switching between routes.
 */

import { Calculator, Wrench, Truck, Plus, RefreshCw, Users } from "lucide-react";
import type {
  AppShellConfig,
  CommandConfig,
  SidebarSection,
  ShellNavigateFunction,
} from "@truss/features/desktop-shell/types";

/** Generate shell configuration for the global (no estimate) context. */
export function getGlobalShellConfig(
  navigate: ShellNavigateFunction,
  onCheckForUpdate?: () => void | Promise<void>,
  options?: { isAdmin?: boolean }
): AppShellConfig {
  const commands: CommandConfig[] = [
    {
      id: "view-estimates",
      label: "View All Estimates",
      icon: Calculator,
      category: "Estimates",
      shortcut: "⌘1",
      searchTerms: ["estimates", "list", "all", "proposals"],
      handler: () => navigate("/estimates"),
    },
    {
      id: "new-estimate",
      label: "New Estimate",
      icon: Plus,
      category: "Estimates",
      shortcut: "⌘N",
      searchTerms: ["create", "new", "estimate", "proposal"],
      handler: () => {
        navigate("/estimates");
        document.dispatchEvent(new CustomEvent("open-create-estimate"));
      },
    },
    {
      id: "labor-pool",
      label: "Labor Constants",
      icon: Wrench,
      category: "Pools",
      searchTerms: ["labor", "constants", "craft", "welder", "pool"],
      handler: () => navigate("/pools/labor"),
    },
    {
      id: "equipment-pool",
      label: "Equipment Catalog",
      icon: Truck,
      category: "Pools",
      searchTerms: ["equipment", "rental", "rates", "pool"],
      handler: () => navigate("/pools/equipment"),
    },
  ];

  if (options?.isAdmin) {
    commands.push({
      id: "manage-members",
      label: "Manage Members",
      icon: Users,
      category: "Admin",
      searchTerms: ["admin", "members", "users", "manage", "team"],
      handler: () => navigate("/admin"),
    });
  }

  if (onCheckForUpdate) {
    commands.push({
      id: "check-for-updates",
      label: "Check for Updates",
      icon: RefreshCw,
      category: "Application",
      searchTerms: ["update", "upgrade", "version", "check", "latest"],
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
          id: "estimates",
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
        {
          id: "pools",
          label: "Pools",
          collapsible: true,
          items: [
            {
              id: "labor-pool",
              label: "Labor Constants",
              href: "/pools/labor",
              icon: Wrench,
            },
            {
              id: "equipment-pool",
              label: "Equipment",
              href: "/pools/equipment",
              icon: Truck,
            },
          ],
        },
        ...(options?.isAdmin
          ? [
              {
                id: "admin",
                label: "Admin",
                collapsible: false,
                items: [
                  {
                    id: "members",
                    label: "Members",
                    href: "/admin",
                    icon: Users,
                  },
                ],
              } satisfies SidebarSection,
            ]
          : []),
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
        handler: () => navigate("/estimates"),
        description: "Go to Estimates",
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
