/**
 * Desktop Shell Module
 *
 * Silicon Valley-standard desktop application shell for Tauri applications.
 * Provides a consistent, professional desktop experience inspired by VS Code, Linear, Slack, and Raycast.
 *
 * @module @truss/features/desktop-shell
 *
 * @example
 * ```tsx
 * import { AppShell } from "@truss/features/desktop-shell";
 * import { shellConfig } from "./config/shell-config";
 *
 * function App() {
 *   return (
 *     <AppShell config={shellConfig}>
 *       <YourAppContent />
 *     </AppShell>
 *   );
 * }
 * ```
 */

// Main component
export { AppShell } from "./app-shell";

// Types
export type {
  AppShellConfig,
  AppShellProps,
  CommandConfig,
  ShortcutConfig,
  SidebarConfig,
  SidebarSection,
  SidebarItem,
  SidebarFooterConfig,
  ThemeConfig,
  LayoutConfig,
  FeatureFlags,
  LayoutMode,
  DensityMode,
  ConnectionStatus,
  SyncStatus,
  BackgroundTask,
  ShellContextValue,
  LayoutProps,
} from "./types";

// Components (for advanced usage)
export * from "./components";

// Layouts (for custom layouts)
export * from "./layouts";

// Providers (for advanced usage)
export * from "./providers";

// Hooks (for advanced usage)
export * from "./hooks";
