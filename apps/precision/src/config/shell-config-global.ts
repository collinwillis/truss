/**
 * Global Shell Configuration (No Estimate Selected)
 *
 * Navigation when the user is at the estimates list, pools, or admin level.
 *
 * WHY: Accepts a `navigate` function so all navigation is client-side.
 * This prevents full-page reloads when switching between routes.
 */

import {
  Calculator,
  Wrench,
  Truck,
  Plus,
  RefreshCw,
  Users,
  Clock,
  History,
  CircleCheck,
  BookOpen,
} from "lucide-react";
import type {
  AppShellConfig,
  CommandConfig,
  SidebarSection,
  ShellNavigateFunction,
} from "@truss/features/desktop-shell/types";

/**
 * Live counts for the rail.
 *
 * Every badge is OMITTED while its count is undefined rather than rendered as
 * a zero or a dash: a sidebar that reflows when data lands is worse than one
 * that never carried counts at all.
 */
export interface GlobalSidebarCounts {
  total?: number;
  overdue?: number;
  dormant?: number;
  awarded?: number;
}

export function getGlobalShellConfig(
  navigate: ShellNavigateFunction,
  onCheckForUpdate?: () => void | Promise<void>,
  options?: { isAdmin?: boolean; canEdit?: boolean; counts?: GlobalSidebarCounts }
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
    // Palette entries are hidden, not disabled, below "write" — same predicate
    // the estimates route uses for its New Estimate button, so the palette
    // never offers a command whose destination control does not exist.
    ...(options?.canEdit
      ? [
          {
            id: "new-estimate",
            label: "New Estimate",
            icon: Plus,
            category: "Estimates",
            searchTerms: ["create", "new", "estimate", "proposal"],
            handler: () => {
              navigate("/estimates");
              // Deferred one macrotask: the estimates route registers the listener in
              // an effect, so dispatching synchronously after `navigate` fired before
              // anything was listening and the dialog never opened.
              setTimeout(() => {
                document.dispatchEvent(new CustomEvent("open-create-estimate"));
              }, 0);
            },
          } satisfies CommandConfig,
        ]
      : []),
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

  const counts = options?.counts;

  commands.push(
    {
      id: "view-overdue",
      label: "Overdue Estimates",
      icon: Clock,
      category: "Views",
      searchTerms: ["overdue", "late", "due", "past due"],
      handler: () => navigate("/estimates?due=overdue"),
    },
    {
      id: "view-dormant",
      label: "Dormant Estimates",
      icon: History,
      category: "Views",
      searchTerms: ["dormant", "stale", "old", "closed out", "abandoned"],
      handler: () => navigate("/estimates?due=dormant"),
    },
    {
      id: "view-awarded",
      label: "Awarded Estimates",
      icon: CircleCheck,
      category: "Views",
      searchTerms: ["awarded", "won", "jobs"],
      handler: () => navigate("/estimates?status=awarded"),
    }
  );

  if (options?.isAdmin) {
    commands.push({
      id: "rate-books",
      label: "Rate Books",
      icon: BookOpen,
      category: "Admin",
      searchTerms: ["rate", "book", "catalog", "constants", "pool", "labor", "equipment"],
      handler: () => navigate("/rate-books"),
    });
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
              badge: counts?.total,
            },
          ],
        },
        // The three lenses worth a permanent home. NOT the seven statuses —
        // those already live in the log's own rail, one click away and
        // combinable; repeating them here would say the same thing twice.
        // Overdue and Dormant are the two numbers nobody can derive by
        // looking, and Awarded is the one people ask for by name.
        // Always present, so the rail does not reflow when data lands — only
        // the badges arrive late, which is the one thing that cannot be known
        // up front.
        {
          id: "views",
          label: "Views",
          collapsible: false,
          items: [
            {
              id: "view-overdue",
              label: "Overdue",
              href: "/estimates?due=overdue",
              icon: Clock,
              badge: counts?.overdue,
            },
            {
              id: "view-dormant",
              label: "Dormant",
              href: "/estimates?due=dormant",
              icon: History,
              badge: counts?.dormant,
            },
            {
              id: "view-awarded",
              label: "Awarded",
              href: "/estimates?status=awarded",
              icon: CircleCheck,
              badge: counts?.awarded,
            },
          ],
        },
        {
          id: "pools",
          label: "Pools",
          // Flattened: a two-item section behind a disclosure triangle is a
          // click tax for nothing, and the far longer Work Breakdown rail in
          // the estimate context is not collapsible either.
          collapsible: false,
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
                    id: "rate-books",
                    label: "Rate Books",
                    href: "/rate-books",
                    icon: BookOpen,
                  },
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

    // WHY no ⌘B: SidebarProvider registers its own ⌘B handler, and declaring it
    // here dispatched a `toggle-sidebar` event nobody listened for while
    // KeyboardProvider's capture-phase listener stopped propagation — which
    // swallowed the working handler. Dropping it restores ⌘B.
    shortcuts: [
      {
        key: "cmd+1",
        handler: () => navigate("/estimates"),
        description: "Go to Estimates",
      },
      // The estimate context leaves 2 and 3 free.
      {
        key: "cmd+2",
        handler: () => navigate("/pools/labor"),
        description: "Go to Labor Constants",
      },
      {
        key: "cmd+3",
        handler: () => navigate("/pools/equipment"),
        description: "Go to Equipment",
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
      // The window's title bar is Overlay app-wide (tauri.conf.json), so every
      // shell surface must dress for the floating traffic lights.
      titleBar: "overlay",
      // The proposal log is a work surface like the estimate grids — its table
      // meets the window edge. The document-style routes under this config
      // (pools, admin) therefore carry their own padding.
      contentInset: false,
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
