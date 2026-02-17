"use client";

/**
 * Shell Provider
 *
 * Global context provider for the desktop application shell.
 * Manages shell configuration and state.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { AppShellConfig, ShellContextValue, LayoutMode, ShortcutConfig } from "../types";

const ShellContext = createContext<ShellContextValue | undefined>(undefined);

interface ShellProviderProps {
  config: AppShellConfig;
  children: ReactNode;
}

/**
 * Shell Provider component that wraps the entire application shell
 */
export function ShellProvider({ config, children }: ShellProviderProps) {
  const [layout, setLayout] = useState<LayoutMode>(config.layout?.default || "three-column");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    config.sidebar.defaultCollapsed || false
  );
  const [, setShortcuts] = useState<Map<string, ShortcutConfig>>(new Map());

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const executeCommand = useCallback(
    (commandId: string) => {
      const command = config.commands.find((cmd) => cmd.id === commandId);
      if (command && !command.disabled) {
        command.handler();
      }
    },
    [config.commands]
  );

  const registerShortcut = useCallback((shortcut: ShortcutConfig) => {
    setShortcuts((prev) => new Map(prev).set(shortcut.key, shortcut));
  }, []);

  const unregisterShortcut = useCallback((key: string) => {
    setShortcuts((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const value: ShellContextValue = {
    config,
    layout,
    setLayout,
    sidebarCollapsed,
    toggleSidebar,
    executeCommand,
    registerShortcut,
    unregisterShortcut,
  };

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/**
 * Hook to access shell context
 */
export function useShell() {
  const context = useContext(ShellContext);
  if (!context) {
    throw new Error("useShell must be used within a ShellProvider");
  }
  return context;
}
