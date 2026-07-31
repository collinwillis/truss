"use client";

/**
 * Density Provider
 *
 * Manages UI density (compact/comfortable/spacious) for the application.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DensityMode } from "../types";

interface DensityContextValue {
  density: DensityMode;
  setDensity: (density: DensityMode) => void;
}

const DensityContext = createContext<DensityContextValue | undefined>(undefined);

interface DensityProviderProps {
  children: ReactNode;
  defaultDensity?: DensityMode;
  storageKey?: string;
}

/**
 * Density Provider component that manages UI density
 */
export function DensityProvider({
  children,
  defaultDensity = "comfortable",
  storageKey = "truss-density",
}: DensityProviderProps) {
  const [density, setDensity] = useState<DensityMode>(() => {
    // Load from localStorage if available
    if (typeof window !== "undefined") {
      return (localStorage.getItem(storageKey) as DensityMode) || defaultDensity;
    }
    return defaultDensity;
  });

  useEffect(() => {
    // data-density is the single selector hook the stylesheets key on.
    document.documentElement.setAttribute("data-density", density);
  }, [density]);

  const setDensityWithStorage = (newDensity: DensityMode) => {
    setDensity(newDensity);
    localStorage.setItem(storageKey, newDensity);
  };

  return (
    <DensityContext.Provider value={{ density, setDensity: setDensityWithStorage }}>
      {children}
    </DensityContext.Provider>
  );
}

/**
 * Hook to access density context
 */
export function useDensity() {
  const context = useContext(DensityContext);
  if (!context) {
    throw new Error("useDensity must be used within a DensityProvider");
  }
  return context;
}
