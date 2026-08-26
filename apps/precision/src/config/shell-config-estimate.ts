/**
 * Estimate-Specific Shell Configuration
 *
 * Navigation when inside a specific estimate, showing overview, the WBS/phase
 * tree, and every WBS and phase as a command-palette entry.
 *
 * WHY: Accepts a `navigate` function so all navigation is client-side.
 * This prevents full-page reloads when switching between routes.
 *
 * WHY the label formatters live here: the sidebar tree, the command palette and
 * the route breadcrumbs must spell a WBS or phase identically, or search terms
 * stop matching what the estimator sees on screen.
 */

import {
  ArrowLeftRight,
  Calculator,
  Download,
  FileText,
  Layers,
  RefreshCw,
  Settings2,
  Users,
} from "lucide-react";
import type {
  AppShellConfig,
  CommandConfig,
  SidebarItem,
  ShellNavigateFunction,
} from "@truss/features/desktop-shell/types";

/**
 * Format a WBS as `70000 · AG PIPING`.
 *
 * WHY the code leads: estimators identify a WBS by its numeric code before its
 * name, and the code is what they type to find it.
 */
export function formatWbsLabel(wbsPoolId: number, name: string): string {
  return `${wbsPoolId} · ${name}`;
}

/** Format a phase as `12 — CARBON STEEL`. */
export function formatPhaseLabel(phaseNumber: number, description: string): string {
  return `${phaseNumber} — ${description}`;
}

/** Phase item shape for sidebar tree and palette navigation. */
interface PhaseNavItem {
  id: string;
  phaseNumber: number;
  description: string;
}

/** WBS item shape with nested phases for tree and palette navigation. */
interface WBSNavItem {
  id: string;
  /** Numeric WBS code, e.g. 70000 — the estimator-facing identifier. */
  wbsPoolId: number;
  name: string;
  phases?: PhaseNavItem[];
}

/** Sibling estimate offered as a palette entry. */
interface EstimateNavItem {
  id: string;
  proposalNumber: string;
  description: string;
}

/** Options for {@link buildEstimateShellBase}. */
interface EstimateShellOptions {
  isAdmin?: boolean;
  wbsItems?: WBSNavItem[];
  /** Other estimates, capped by the caller, offered as palette entries. */
  otherEstimates?: EstimateNavItem[];
}

/**
 * Upper bound on phase entries registered in the command palette.
 *
 * WHY capped: the palette renders every command as a DOM node and rescores all
 * of them on each keystroke. The largest live estimate carries ~2,200 phases,
 * which makes typing visibly laggy. Phases of the WBS the user is currently in
 * are registered first, so the cap only trims parts of the tree the user is not
 * working in — and the sidebar tree still lists every phase.
 */
const MAX_PHASE_COMMANDS = 500;

/**
 * Reserve a palette entry id.
 *
 * WHY readable ids: the palette matches on a command's id, not its rendered
 * label, so an opaque document id would both fail to match what the estimator
 * types and score spurious hits against its random characters.
 */
function reserveId(seed: string, taken: Set<string>): string {
  let id = seed;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${seed}-${suffix}`;
    suffix += 1;
  }
  taken.add(id);
  return id;
}

/**
 * The `activeWbsId`-independent parts of the estimate shell, built once per
 * data change and reused across navigations.
 *
 * WHY THE SPLIT (#19): the shell config used to be rebuilt on every
 * navigation because `activeWbsId` — which changes with each click into a WBS
 * or phase — was an input to the whole build. The only thing it decides is
 * which phases win the palette's command budget, yet its churn re-sorted and
 * re-created the entire sidebar tree (~2,200 nodes on the largest production
 * estimate) and every command object per click. Everything here depends only
 * on the estimate's data; {@link getEstimateShellConfig} layers the cheap
 * per-navigation selection on top.
 */
export interface EstimateShellBase {
  estimateId: string;
  navigate: ShellNavigateFunction;
  /** Sorted by WBS code; phases within each WBS sorted by phase number. */
  wbsItems: WBSNavItem[];
  phasesByWbs: Map<string, PhaseNavItem[]>;
  wbsSidebarItems: SidebarItem[];
  /** Static + WBS commands — everything registered BEFORE the phase entries. */
  preCommands: CommandConfig[];
  /** Estimate-switch, admin, update — everything registered AFTER them. */
  postCommands: CommandConfig[];
  /**
   * Ids reserved by the base commands. {@link getEstimateShellConfig} clones
   * this before reserving phase ids — reserving into the shared set would
   * accumulate `-2`, `-3` suffixes across rebuilds.
   */
  takenIds: ReadonlySet<string>;
}

/** Build the data-dependent base of the estimate shell. */
export function buildEstimateShellBase(
  estimateId: string,
  navigate: ShellNavigateFunction,
  onCheckForUpdate?: () => void | Promise<void>,
  options?: EstimateShellOptions
): EstimateShellBase {
  // Defence in depth: Convex does not guarantee that a query's ordering survives
  // serialization (Momentum lost its WBS order that way, see the `#36` note in
  // workbook-table.tsx), so order by code and phase number on the client.
  const wbsItems = [...(options?.wbsItems ?? [])].sort((a, b) => a.wbsPoolId - b.wbsPoolId);

  // Sorted once per WBS and shared by the sidebar tree and the command list.
  const phasesByWbs = new Map<string, PhaseNavItem[]>(
    wbsItems.map((wbs) => [
      wbs.id,
      [...(wbs.phases ?? [])].sort((a, b) => a.phaseNumber - b.phaseNumber),
    ])
  );
  const sortedPhases = (wbs: WBSNavItem): PhaseNavItem[] => phasesByWbs.get(wbs.id) ?? [];

  // THE RAIL IS DELIBERATELY SHALLOW (Collin's IA decision): WBS rows only,
  // with a phase-count badge — no phase children. The old 2,222-node tree
  // made the rail unnavigable; phases live in the content (the WBS table),
  // the breadcrumb switcher, [ ] keys, ⌘K, and the rail filter.
  //
  // WHY no icon: a repeated identical icon on every row is visual weight with
  // zero information — the WBS code is the identity, rendered as a quiet mono
  // column.
  const wbsSidebarItems: SidebarItem[] = wbsItems.map((wbs) => ({
    id: `wbs-${wbs.id}`,
    label: formatWbsLabel(wbs.wbsPoolId, wbs.name),
    href: `/estimate/${estimateId}/wbs/${wbs.id}`,
    badge: sortedPhases(wbs).length || undefined,
  }));

  const preCommands: CommandConfig[] = [
    {
      id: "estimate-overview",
      label: "Estimate Overview",
      icon: FileText,
      category: "Navigation",
      searchTerms: ["overview", "info", "rates", "estimate", "detail"],
      handler: () => navigate(`/estimate/${estimateId}/overview`),
    },
    {
      id: "all-estimates",
      label: "All Estimates",
      icon: Calculator,
      category: "Estimates",
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
      // Handled by the estimate layout route, which is mounted for every screen
      // inside an estimate and registers the matching ⌘⇧E shortcut.
      handler: () => {
        document.dispatchEvent(new CustomEvent("export-estimate"));
      },
    },
  ];

  const takenIds = new Set(preCommands.map((command) => command.id));

  // Every WBS is reachable by code or name from the palette. This is the search
  // surface for the tree — there is deliberately no second search box.
  for (const wbs of wbsItems) {
    const code = String(wbs.wbsPoolId);
    preCommands.push({
      id: reserveId(`wbs-${code}`, takenIds),
      label: formatWbsLabel(wbs.wbsPoolId, wbs.name),
      icon: Layers,
      category: "Work Breakdown",
      searchTerms: [code, wbs.name, "wbs"],
      handler: () => navigate(`/estimate/${estimateId}/wbs/${wbs.id}`),
    });
  }

  const postCommands: CommandConfig[] = [];

  // Switching estimates from the keyboard: the palette lists the estimates
  // themselves, which is what the top-bar switcher offers to the mouse.
  for (const estimate of options?.otherEstimates ?? []) {
    postCommands.push({
      id: reserveId(`estimate-${estimate.proposalNumber}`, takenIds),
      label: `#${estimate.proposalNumber} — ${estimate.description}`,
      icon: ArrowLeftRight,
      category: "Switch Estimate",
      searchTerms: [estimate.proposalNumber, estimate.description, "switch", "estimate"],
      handler: () => navigate(`/estimate/${estimate.id}`),
    });
  }

  if (options?.isAdmin) {
    postCommands.push({
      id: "manage-members",
      label: "Manage Members",
      icon: Users,
      category: "Admin",
      searchTerms: ["admin", "members", "users", "manage"],
      handler: () => navigate("/admin"),
    });
  }

  if (onCheckForUpdate) {
    postCommands.push({
      id: "check-for-updates",
      label: "Check for Updates",
      icon: RefreshCw,
      category: "Application",
      searchTerms: ["update", "upgrade", "version"],
      handler: onCheckForUpdate,
    });
  }

  return {
    estimateId,
    navigate,
    wbsItems,
    phasesByWbs,
    wbsSidebarItems,
    preCommands,
    postCommands,
    takenIds,
  };
}

/**
 * Assemble the shell config for the current navigation state.
 *
 * Cheap by design — runs on every navigation, so it only selects which phases
 * get palette entries (active WBS first, so the command budget never hides
 * what is on screen) and reuses everything else from the base by identity.
 */
export function getEstimateShellConfig(
  base: EstimateShellBase,
  activeWbsId?: string
): AppShellConfig {
  const { estimateId, navigate, wbsItems, phasesByWbs, wbsSidebarItems } = base;
  const sortedPhases = (wbs: WBSNavItem): PhaseNavItem[] => phasesByWbs.get(wbs.id) ?? [];

  // Phases of the active WBS first, so the cap never hides what is on screen.
  const wbsByPhasePriority = activeWbsId
    ? [
        ...wbsItems.filter((wbs) => wbs.id === activeWbsId),
        ...wbsItems.filter((wbs) => wbs.id !== activeWbsId),
      ]
    : wbsItems;

  const takenIds = new Set(base.takenIds);
  const phaseCommands: CommandConfig[] = [];
  let phaseBudget = MAX_PHASE_COMMANDS;
  for (const wbs of wbsByPhasePriority) {
    if (phaseBudget <= 0) break;
    const code = String(wbs.wbsPoolId);
    for (const phase of sortedPhases(wbs).slice(0, phaseBudget)) {
      phaseCommands.push({
        id: reserveId(`phase-${code}-${phase.phaseNumber}`, takenIds),
        label: formatPhaseLabel(phase.phaseNumber, phase.description),
        category: `Phases · ${formatWbsLabel(wbs.wbsPoolId, wbs.name)}`,
        searchTerms: [String(phase.phaseNumber), phase.description, code, wbs.name, "phase"],
        handler: () => navigate(`/estimate/${estimateId}/phase/${phase.id}`),
      });
      phaseBudget -= 1;
    }
  }

  // Same registration order as before the split: static + WBS, then phases,
  // then estimate-switch/admin/update.
  const commands = [...base.preCommands, ...phaseCommands, ...base.postCommands];

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
              href: `/estimate/${estimateId}/overview`,
              icon: FileText,
            },
            {
              id: "setup",
              label: "Setup",
              href: `/estimate/${estimateId}/setup`,
              icon: Settings2,
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

    // WHY empty: KeyboardProvider snapshots `config.shortcuts` when the shell
    // mounts, so a config that becomes active later never registers anything —
    // shortcuts declared here would be advertised but dead. Estimate-scoped
    // shortcuts (⌘⇧E) are registered from the estimate layout route instead,
    // where they bind and unbind with the route. ⌘B is deliberately absent as
    // well: SidebarProvider already owns it, and declaring it here swallowed the
    // event in KeyboardProvider's capture-phase listener.
    shortcuts: [],

    theme: {
      mode: "system",
      accent: "zinc",
      density: "comfortable",
    },

    layout: {
      default: "three-column",
      allowModeSwitch: true,
      persistState: true,
      // The estimate surface is a work surface — the grid meets the window's
      // left edge and the inspector meets its right; routes own their gutters.
      contentInset: false,
      // Matches tauri.conf.json titleBarStyle: Overlay — the shell's top bar
      // is the title bar, with the traffic lights floating at its left.
      titleBar: "overlay",
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
