"use client";

/**
 * Theme Provider
 *
 * Manages application theme (light/dark/system) with OS sync support.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  resolvedTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: ThemeMode;
  storageKey?: string;
}

/**
 * Theme Provider component that manages dark/light mode
 */
export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "truss-theme",
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    // Load from localStorage if available
    if (typeof window !== "undefined") {
      return (localStorage.getItem(storageKey) as ThemeMode) || defaultTheme;
    }
    return defaultTheme;
  });

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const root = document.documentElement;

    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const applyTheme = (matches: boolean) => {
        root.classList.toggle("dark", matches);
        setResolvedTheme(matches ? "dark" : "light");
      };

      applyTheme(mediaQuery.matches);

      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    } else {
      root.classList.toggle("dark", theme === "dark");
      setResolvedTheme(theme);
    }
  }, [theme]);

  const setThemeWithStorage = (newTheme: ThemeMode) => {
    setTheme(newTheme);
    localStorage.setItem(storageKey, newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeWithStorage, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Hook to access theme context
 */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
