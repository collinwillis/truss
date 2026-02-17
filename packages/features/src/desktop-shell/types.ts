/**
 * Desktop Shell Type Definitions
 *
 * Core types for the Silicon Valley-standard desktop application shell
 * used by both Momentum and Precision applications.
 */

import type { ReactNode, ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Application configuration for the desktop shell
 */
export interface AppShellConfig {
  /** Application metadata */
  app: {
    /** Display name of the application */
    name: string;
    /** Current version */
    version: string;
    /** Optional application icon */
    icon?: LucideIcon;
  };

  /** Sidebar navigation configuration */
  sidebar: SidebarConfig;

  /** Command palette commands */
  commands: CommandConfig[];

  /** Keyboard shortcuts */
  shortcuts: ShortcutConfig[];

  /** Theme configuration */
  theme?: ThemeConfig;

  /** Layout configuration */
  layout?: LayoutConfig;

  /** Feature flags */
  features?: FeatureFlags;
}

/**
 * Sidebar configuration
 */
export interface SidebarConfig {
  /** Navigation sections */
  sections: SidebarSection[];
  /** Pinned items for quick access */
  pinnedItems?: string[];
  /** Footer configuration */
  footer?: SidebarFooterConfig;
  /** Whether sidebar starts collapsed */
  defaultCollapsed?: boolean;
  /** Width when collapsed (icon mode) */
  collapsedWidth?: number;
  /** Width when expanded */
  expandedWidth?: number;
}

/**
 * Individual sidebar section
 */
export interface SidebarSection {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Section icon */
  icon?: LucideIcon;
  /** Navigation items within section */
  items?: SidebarItem[];
  /** Whether section is collapsible */
  collapsible?: boolean;
  /** Start expanded */
  defaultOpen?: boolean;
}

/**
 * Individual sidebar navigation item
 */
export interface SidebarItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Navigation href */
  href: string;
  /** Optional icon */
  icon?: LucideIcon;
  /** Badge count or label */
  badge?: string | number;
  /** Whether item is disabled */
  disabled?: boolean;
  /** Nested sub-items */
  children?: SidebarItem[];
}

/**
 * Sidebar footer configuration
 */
export interface SidebarFooterConfig {
  /** Show user menu */
  showUserMenu?: boolean;
  /** Show settings button */
  showSettings?: boolean;
  /** Show help button */
  showHelp?: boolean;
  /** Show connection status */
  showConnectionStatus?: boolean;
  /** Custom footer content */
  customContent?: ReactNode;
}

/**
 * Command palette command configuration
 */
export interface CommandConfig {
  /** Unique command ID */
  id: string;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: LucideIcon;
  /** Command category/group */
  category?: string;
  /** Keyboard shortcut */
  shortcut?: string;
  /** Search terms for fuzzy matching */
  searchTerms?: string[];
  /** Command handler */
  handler: () => void | Promise<void>;
  /** Whether command is disabled */
  disabled?: boolean;
  /** Whether command is visible */
  visible?: boolean;
}

/**
 * Keyboard shortcut configuration
 */
export interface ShortcutConfig {
  /** Key combination (e.g., "cmd+k", "ctrl+shift+p") */
  key: string;
  /** Shortcut handler */
  handler: () => void;
  /** Optional description */
  description?: string;
  /** Whether to prevent default behavior */
  preventDefault?: boolean;
  /** Whether shortcut is disabled */
  disabled?: boolean;
}

/**
 * Theme configuration
 */
export interface ThemeConfig {
  /** Color mode */
  mode?: "system" | "light" | "dark";
  /** Accent color */
  accent?: string;
  /** UI density */
  density?: DensityMode;
  /** Custom CSS variables */
  cssVars?: Record<string, string>;
}

/**
 * Layout configuration
 */
export interface LayoutConfig {
  /** Default layout mode */
  default: LayoutMode;
  /** Allow users to switch layouts */
  allowModeSwitch?: boolean;
  /** Persist layout state */
  persistState?: boolean;
  /** Custom layouts */
  customLayouts?: Record<string, ComponentType>;
}

/**
 * Feature flags for enabling/disabling shell features
 */
export interface FeatureFlags {
  /** Enable command palette */
  commandPalette?: boolean;
  /** Enable global search */
  globalSearch?: boolean;
  /** Enable notifications */
  notifications?: boolean;
  /** Show status bar */
  statusBar?: boolean;
  /** Show activity bar */
  activityBar?: boolean;
  /** Enable workspace switching */
  workspaceSwitcher?: boolean;
  /** Enable multi-window support */
  multiWindow?: boolean;
}

/**
 * Available layout modes
 */
export type LayoutMode = "three-column" | "split" | "focus" | "custom";

/**
 * UI density modes
 */
export type DensityMode = "compact" | "comfortable" | "spacious";

/**
 * Connection status
 */
export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

/**
 * Sync status
 */
export interface SyncStatus {
  /** Sync state */
  state: "idle" | "syncing" | "error";
  /** Items pending sync */
  pendingCount?: number;
  /** Last sync timestamp */
  lastSyncedAt?: Date;
  /** Error message if any */
  error?: string;
}

/**
 * Background task
 */
export interface BackgroundTask {
  /** Task ID */
  id: string;
  /** Task name */
  name: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Task status */
  status: "pending" | "running" | "completed" | "error";
  /** Cancelable flag */
  cancelable?: boolean;
}

/**
 * Props for the main AppShell component
 */
export interface AppShellProps {
  /** Shell configuration */
  config: AppShellConfig;
  /** Child content to render in the main area */
  children: ReactNode;
  /** Command execution handler */
  onCommandExecute?: (commandId: string) => void;
  /** Logout handler */
  onLogout?: () => void | Promise<void>;
  /** Custom content to render in the top bar (e.g., project switcher) */
  topBarContent?: ReactNode;
  /** Custom className */
  className?: string;
}

/**
 * Layout component props
 */
export interface LayoutProps {
  /** Child content */
  children: ReactNode;
  /** Whether to show master list */
  showMasterList?: boolean;
  /** Master list content */
  masterListContent?: ReactNode;
  /** Custom className */
  className?: string;
}

/**
 * Shell context value
 */
export interface ShellContextValue {
  /** Shell configuration */
  config: AppShellConfig;
  /** Current layout mode */
  layout: LayoutMode;
  /** Set layout mode */
  setLayout: (layout: LayoutMode) => void;
  /** Whether sidebar is collapsed */
  sidebarCollapsed: boolean;
  /** Toggle sidebar */
  toggleSidebar: () => void;
  /** Execute command */
  executeCommand: (commandId: string) => void;
  /** Register keyboard shortcut */
  registerShortcut: (shortcut: ShortcutConfig) => void;
  /** Unregister keyboard shortcut */
  unregisterShortcut: (key: string) => void;
}
