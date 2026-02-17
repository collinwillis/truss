"use client";

/**
 * Keyboard Provider
 *
 * Manages global keyboard shortcuts and hotkeys for the application.
 */

import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useState,
  useRef,
  type ReactNode,
} from "react";
import type { ShortcutConfig } from "../types";

interface KeyboardContextValue {
  shortcuts: Map<string, ShortcutConfig>;
  registerShortcut: (shortcut: ShortcutConfig) => void;
  unregisterShortcut: (key: string) => void;
  isShortcutActive: (key: string) => boolean;
}

const KeyboardContext = createContext<KeyboardContextValue | undefined>(undefined);

interface KeyboardProviderProps {
  children: ReactNode;
  initialShortcuts?: ShortcutConfig[];
}

/**
 * Normalize key combination for consistent matching
 */
function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = [];

  if (e.metaKey || e.ctrlKey) parts.push("cmd");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  // Handle special keys
  const key = e.key.toLowerCase();
  if (key === " ") {
    parts.push("space");
  } else if (key === "escape") {
    parts.push("esc");
  } else if (key === "arrowup") {
    parts.push("up");
  } else if (key === "arrowdown") {
    parts.push("down");
  } else if (key === "arrowleft") {
    parts.push("left");
  } else if (key === "arrowright") {
    parts.push("right");
  } else {
    parts.push(key);
  }

  return parts.join("+");
}

/**
 * Keyboard Provider component that manages global shortcuts
 */
export function KeyboardProvider({ children, initialShortcuts = [] }: KeyboardProviderProps) {
  const [shortcuts, setShortcuts] = useState<Map<string, ShortcutConfig>>(() => {
    const map = new Map<string, ShortcutConfig>();
    initialShortcuts.forEach((shortcut) => {
      map.set(shortcut.key.toLowerCase(), shortcut);
    });
    return map;
  });

  const [activeShortcuts, setActiveShortcuts] = useState<Set<string>>(new Set());

  const registerShortcut = useCallback((shortcut: ShortcutConfig) => {
    setShortcuts((prev) => {
      const next = new Map(prev);
      next.set(shortcut.key.toLowerCase(), shortcut);
      return next;
    });
  }, []);

  const unregisterShortcut = useCallback((key: string) => {
    setShortcuts((prev) => {
      const next = new Map(prev);
      next.delete(key.toLowerCase());
      return next;
    });
  }, []);

  const isShortcutActive = useCallback(
    (key: string) => {
      return activeShortcuts.has(key.toLowerCase());
    },
    [activeShortcuts]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.contentEditable === "true"
      ) {
        // Allow some global shortcuts even in inputs (like cmd+k)
        const key = normalizeKey(e);
        if (key !== "cmd+k" && key !== "cmd+p") {
          return;
        }
      }

      const key = normalizeKey(e);
      const shortcut = shortcuts.get(key);

      if (shortcut && !shortcut.disabled) {
        if (shortcut.preventDefault !== false) {
          e.preventDefault();
          e.stopPropagation();
        }

        // Mark as active
        setActiveShortcuts((prev) => new Set(prev).add(key));

        // Execute handler
        try {
          shortcut.handler();
        } catch (error) {
          console.error(`Error executing shortcut ${key}:`, error);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = normalizeKey(e);
      setActiveShortcuts((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [shortcuts]);

  return (
    <KeyboardContext.Provider
      value={{ shortcuts, registerShortcut, unregisterShortcut, isShortcutActive }}
    >
      {children}
    </KeyboardContext.Provider>
  );
}

/**
 * Hook to access keyboard context
 */
export function useKeyboard() {
  const context = useContext(KeyboardContext);
  if (!context) {
    throw new Error("useKeyboard must be used within a KeyboardProvider");
  }
  return context;
}

/**
 * Hook to register a keyboard shortcut
 */
export function useShortcut(
  key: string,
  handler: () => void,
  options?: { preventDefault?: boolean; disabled?: boolean }
) {
  const { registerShortcut, unregisterShortcut } = useKeyboard();

  // Use a ref to store the latest handler to avoid dependency issues
  const handlerRef = useRef(handler);

  // Update the ref when handler changes
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    // Create a stable handler that calls the latest function from the ref
    const stableHandler = () => {
      handlerRef.current();
    };

    const shortcut: ShortcutConfig = {
      key,
      handler: stableHandler,
      preventDefault: options?.preventDefault,
      disabled: options?.disabled,
    };

    if (!options?.disabled) {
      registerShortcut(shortcut);
    }

    return () => {
      unregisterShortcut(key);
    };
  }, [
    key,
    options?.preventDefault,
    options?.disabled,
    registerShortcut,
    unregisterShortcut,
    // Note: handler is intentionally not in dependencies
  ]);
}
