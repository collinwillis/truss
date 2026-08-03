"use client";

/**
 * Three-Column Layout
 *
 * Master-Detail-Inspector layout with resizable panes.
 * Inspired by VS Code and other professional desktop applications.
 */

import { useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@truss/ui/components/resizable";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@truss/ui/components/sidebar";
import { cn } from "@truss/ui/lib/utils";
import { AppBar } from "../components/app-bar";
import type { BreadcrumbSegment } from "../components/app-bar";
import { AppSidebar } from "../components/app-sidebar";
import { useShell } from "../providers/shell-provider";
import { useLayoutStore } from "../hooks/use-layout-store";
import type { AppShellConfig } from "../types";

interface ThreeColumnLayoutProps {
  config: AppShellConfig;
  children: React.ReactNode;
  showMasterList?: boolean;
  masterListContent?: React.ReactNode;
  breadcrumbs?: BreadcrumbSegment[];
  actions?: React.ReactNode;
  topBarContent?: React.ReactNode;
  onLogout?: () => void | Promise<void>;
}

/**
 * Three-column layout with collapsible sidebar and optional master list
 */
export function ThreeColumnLayout({
  config,
  children,
  showMasterList = false,
  masterListContent,
  breadcrumbs,
  actions,
  topBarContent,
  onLogout,
}: ThreeColumnLayoutProps) {
  const { sidebarCollapsed } = useShell();
  const { panelSizes, setPanelSizes } = useLayoutStore();

  // Load saved panel sizes or use defaults (now only for master-detail split)
  const savedSizes = panelSizes["three-column"] || [25, 75];
  const [localSizes, setLocalSizes] = useState(savedSizes);

  // Persist panel sizes on change
  const handlePanelResize = (sizes: number[]) => {
    setLocalSizes(sizes);
    setPanelSizes("three-column", sizes);
  };

  // Calculate responsive sizes for master-detail split
  const masterSize = showMasterList ? localSizes[0] || 25 : 0;
  const detailSize = showMasterList ? localSizes[1] || 75 : 100;

  return (
    <SidebarProvider defaultOpen={!sidebarCollapsed}>
      <div className="flex h-full w-full">
        {/* Sidebar */}
        <AppSidebar config={config} onLogout={onLogout} />

        {/* Main content area */}
        {/* min-w-0 is LOAD-BEARING: without it, a flex item's min-width is
            its content's intrinsic width, so a wide data grid inside makes
            this pane REFUSE to shrink when the sidebar opens — the whole
            shell row then overflows the window and the right panel is pushed
            out of view. With it, opening the sidebar shrinks the center pane
            and the grid scrolls inside its own container, which is the
            desktop contract: panels never leave the viewport. */}
        <SidebarInset className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top App Bar with breadcrumb navigation */}
          <div className="flex items-center border-b h-11">
            {" "}
            {/* 44px - Desktop standard */}
            <div className="px-4">
              <SidebarTrigger className="-ml-1" />
            </div>
            {topBarContent && <div className="px-2">{topBarContent}</div>}
            <div className="flex-1 min-w-0">
              <AppBar breadcrumbs={breadcrumbs} actions={actions} className="border-0" />
            </div>
          </div>

          <ResizablePanelGroup
            direction="horizontal"
            onLayout={handlePanelResize}
            className="flex-1 w-full"
          >
            {/* Master List Panel (optional) */}
            {showMasterList && masterListContent && (
              <>
                <ResizablePanel
                  defaultSize={masterSize}
                  minSize={15}
                  maxSize={40}
                  className="master-panel bg-fill-quaternary"
                >
                  <ScrollArea className="h-full w-full">{masterListContent}</ScrollArea>
                </ResizablePanel>

                <ResizableHandle
                  className={cn(
                    "w-1 bg-border group relative",
                    "hover:bg-primary/30 active:bg-primary/50",
                    "transition-all duration-150 ease-out",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  )}
                >
                  {/* Visual affordance indicator */}
                  <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-r from-transparent via-primary/0 to-transparent group-hover:via-primary/20 transition-all duration-150" />
                  {/* Grab handle dots */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-1 h-1 rounded-full bg-foreground-subtle" />
                    <div className="w-1 h-1 rounded-full bg-foreground-subtle" />
                    <div className="w-1 h-1 rounded-full bg-foreground-subtle" />
                  </div>
                </ResizableHandle>
              </>
            )}

            {/* Detail/Main Content Panel — routes own their scrolling */}
            <ResizablePanel defaultSize={detailSize} minSize={30} className="detail-panel">
              <div className="h-full w-full flex flex-col">
                <div
                  className={cn(
                    "flex-1 min-h-0 flex flex-col",
                    // Document-style apps get a padded frame; work-surface apps
                    // (contentInset: false) run edge-to-edge and own their gutters.
                    config.layout?.contentInset !== false && "p-4 md:p-5"
                  )}
                >
                  {children}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
