/**
 * Layout Store Hook
 *
 * Zustand store for persisting layout state across sessions.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LayoutMode } from "../types";

interface LayoutState {
  // Current layout mode
  currentLayout: LayoutMode;

  // Panel sizes for different layouts
  panelSizes: Record<string, number[]>;

  // Sidebar state
  sidebarCollapsed: boolean;
  sidebarWidth: number;

  // Master list state
  masterListVisible: boolean;
  masterListWidth: number;

  // Actions
  setLayout: (layout: LayoutMode) => void;
  setPanelSizes: (layout: string, sizes: number[]) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setMasterListVisible: (visible: boolean) => void;
  setMasterListWidth: (width: number) => void;
  toggleSidebar: () => void;
  toggleMasterList: () => void;

  // Reset to defaults
  reset: () => void;

  // Hydration flag
  hasHydrated: boolean;
  hydrate: () => void;
}

const DEFAULT_STATE = {
  currentLayout: "three-column" as LayoutMode,
  panelSizes: {
    "three-column": [15, 25, 60],
    split: [50, 50],
    focus: [100],
  },
  sidebarCollapsed: false,
  sidebarWidth: 240,
  masterListVisible: false,
  masterListWidth: 300,
  hasHydrated: false,
};

/**
 * Layout persistence store
 */
export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,

      // Actions
      setLayout: (layout) => set({ currentLayout: layout }),

      setPanelSizes: (layout, sizes) =>
        set((state) => ({
          panelSizes: { ...state.panelSizes, [layout]: sizes },
        })),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      setSidebarWidth: (width) => set({ sidebarWidth: width }),

      setMasterListVisible: (visible) => set({ masterListVisible: visible }),

      setMasterListWidth: (width) => set({ masterListWidth: width }),

      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      toggleMasterList: () => set((state) => ({ masterListVisible: !state.masterListVisible })),

      reset: () => set(DEFAULT_STATE),

      hydrate: () => {
        // Mark as hydrated to trigger re-renders after loading from storage
        set({ hasHydrated: true });
      },
    }),
    {
      name: "truss-desktop-layout",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist these fields
        currentLayout: state.currentLayout,
        panelSizes: state.panelSizes,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        masterListVisible: state.masterListVisible,
        masterListWidth: state.masterListWidth,
      }),
      onRehydrateStorage: () => (state) => {
        // Called after hydration completes
        if (state) {
          state.hasHydrated = true;
        }
      },
    }
  )
);

/**
 * Hook to use layout store with hydration check
 */
export function useLayout() {
  const store = useLayoutStore();

  // Ensure store is hydrated before using
  if (!store.hasHydrated && typeof window !== "undefined") {
    store.hydrate();
  }

  return store;
}
