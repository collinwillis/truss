"use client";

/**
 * AppSidebar Component
 *
 * Collapsible navigation sidebar following Slack/Linear patterns:
 * - ⌘K trigger replaces dead search (single search surface)
 * - Label-less sections for flat nav (no "Navigation" tautology)
 * - Tree navigation with two-level WBS → Phase hierarchy
 * - Contextual active states: parent dims, child highlights
 */

import { ChevronRight, Command, Search } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
} from "@truss/ui/components/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@truss/ui/components/collapsible";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { cn } from "@truss/ui/lib/utils";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { UserMenu } from "./user-menu";
import { useShell } from "../providers/shell-provider";
import type { AppShellConfig, SidebarItem, SidebarSection } from "../types";
import { useState, useCallback } from "react";

interface AppSidebarProps {
  config: AppShellConfig;
  onLogout?: () => void | Promise<void>;
}

/**
 * Main sidebar component with navigation and workspace switching.
 *
 * WHY ⌘K trigger instead of search input: A single command palette is the
 * industry standard (Linear, Raycast, VS Code). The previous sidebar search
 * input was non-functional and created confusion with 4 search surfaces.
 */
export function AppSidebar({ config, onLogout }: AppSidebarProps) {
  const { sidebarCollapsed } = useShell();

  const openCommandPalette = useCallback(() => {
    document.dispatchEvent(new CustomEvent("open-command-palette"));
  }, []);

  return (
    <Sidebar className="border-r transition-all duration-200 ease-out">
      <SidebarHeader className="border-b px-3 py-3 overflow-hidden group-data-[state=collapsed]:px-2">
        {/* Workspace Switcher */}
        {config.features?.workspaceSwitcher !== false && (
          <WorkspaceSwitcher appName={config.app.name} appIcon={config.app.icon} />
        )}

        {/* Command Palette Trigger (Linear-style) */}
        {config.features?.commandPalette !== false && (
          <>
            {/* Expanded: Full search-style trigger */}
            <button
              type="button"
              onClick={openCommandPalette}
              className={cn(
                "flex items-center gap-2 w-full mt-2 px-3 h-9 rounded-lg",
                "text-sm text-muted-foreground",
                "bg-sidebar-accent/50 border border-sidebar-border",
                "hover:bg-sidebar-accent hover:text-sidebar-foreground",
                "transition-all duration-150 cursor-pointer",
                "group-data-[state=collapsed]:hidden"
              )}
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 text-left truncate">Search...</span>
              <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border bg-fill-quaternary px-1.5 font-mono text-footnote font-medium text-foreground-subtle">
                <Command className="h-2.5 w-2.5" />K
              </kbd>
            </button>

            {/* Collapsed: Icon-only trigger */}
            <div className="hidden group-data-[state=collapsed]:flex justify-center mt-2">
              <button
                type="button"
                onClick={openCommandPalette}
                className={cn(
                  "flex items-center justify-center h-8 w-8 rounded-lg",
                  "text-muted-foreground hover:text-sidebar-foreground",
                  "hover:bg-sidebar-accent transition-colors duration-150"
                )}
              >
                <Search className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </SidebarHeader>

      <SidebarContent>
        <ScrollArea className="flex-1">
          {config.sidebar.sections.map((section, index) => (
            <div key={section.id}>
              {/* Visual separator between sections (not before first) */}
              {index > 0 && <SidebarSeparator className="mx-3 my-2" />}
              <NavSection section={section} collapsed={sidebarCollapsed} index={index} />
            </div>
          ))}
        </ScrollArea>
      </SidebarContent>

      <SidebarFooter>
        {config.sidebar.footer?.showUserMenu !== false && <UserMenu onLogout={onLogout} />}
        {config.sidebar.footer?.customContent}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Navigation section component.
 *
 * WHY optional labels: Sections like "Navigation" are tautological in a sidebar.
 * Omitting the label for primary nav items follows Slack/Linear conventions where
 * top-level items need no grouping label.
 */
function NavSection({
  section,
  index = 0,
}: {
  section: SidebarSection;
  collapsed: boolean;
  index?: number;
}) {
  const { linkComponent: LinkComponent, currentPath } = useShell();
  const [isOpen, setIsOpen] = useState(section.defaultOpen !== false);

  if (!section.items || section.items.length === 0) {
    return (
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={section.label}>
              {section.icon && <section.icon />}
              <span>{section.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    );
  }

  const animationDelay = `${index * 50}ms`;

  return (
    <SidebarGroup style={{ animationDelay }} className="animate-in fade-in-0 slide-in-from-left-2">
      {/* Only render section label if one is provided */}
      {section.label && (
        <SidebarGroupLabel className="text-footnote font-semibold uppercase tracking-wider text-sidebar-foreground/40 px-3 mb-0.5">
          {section.label}
        </SidebarGroupLabel>
      )}
      <SidebarMenu>
        {section.collapsible !== false ? (
          <Collapsible open={isOpen} onOpenChange={setIsOpen} className="group/collapsible">
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  tooltip={section.label}
                  className="group/trigger hover:bg-sidebar-accent transition-all duration-150"
                >
                  {section.icon && (
                    <section.icon className="transition-transform group-hover/trigger:scale-110" />
                  )}
                  <span className="font-medium">{section.label}</span>
                  <ChevronRight
                    className={cn(
                      "ml-auto h-4 w-4 transition-all duration-200 ease-out",
                      isOpen && "rotate-90",
                      "group-hover/trigger:text-sidebar-foreground"
                    )}
                  />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
                <SidebarMenuSub>
                  {section.items.map((item) => {
                    const isActive = currentPath === item.href;

                    return (
                      <SidebarMenuSubItem key={item.id} className="group/item">
                        <SidebarMenuSubButton asChild isActive={isActive}>
                          <LinkComponent
                            to={item.href}
                            className={cn(
                              "transition-all duration-150",
                              item.disabled
                                ? "pointer-events-none opacity-50"
                                : isActive
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                  : "hover:bg-sidebar-accent active:bg-sidebar-accent/80"
                            )}
                            data-active={isActive}
                          >
                            {item.icon && (
                              <item.icon className="h-4 w-4 transition-transform group-hover/item:scale-110" />
                            )}
                            <span className="transition-colors">{item.label}</span>
                          </LinkComponent>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    );
                  })}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        ) : (
          // Non-collapsible flat items (with optional nested children for tree nav)
          section.items.map((item) =>
            item.children && item.children.length > 0 ? (
              <TreeNavItem key={item.id} item={item} />
            ) : (
              <FlatNavItem key={item.id} item={item} />
            )
          )
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * Flat navigation item without children.
 *
 * WHY SidebarMenuButton with data-active: The shadcn sidebar already handles
 * the active highlight via `data-[active=true]:bg-sidebar-accent`. We pass
 * isActive to SidebarMenuButton so the tooltip knows to show in collapsed mode.
 */
function FlatNavItem({ item }: { item: SidebarItem }) {
  const { linkComponent: LinkComponent, currentPath } = useShell();
  const isActive = currentPath === item.href;

  return (
    <SidebarMenuItem className="group/item">
      <SidebarMenuButton asChild tooltip={item.label} isActive={isActive}>
        <LinkComponent
          to={item.href}
          className={cn(
            "transition-all duration-150",
            item.disabled
              ? "pointer-events-none opacity-50"
              : isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "hover:bg-sidebar-accent active:bg-sidebar-accent/80"
          )}
          data-active={isActive}
        >
          {item.icon && <item.icon className="transition-transform group-hover/item:scale-110" />}
          <span className="transition-colors">{item.label}</span>
        </LinkComponent>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Tree navigation item with collapsible children.
 *
 * WHY split chevron from link: Clicking the row label navigates to the WBS
 * overview. Clicking the chevron button expands/collapses phases. These are
 * two distinct actions on the same row — Linear and Notion use the same pattern.
 *
 * WHY parent ambient highlight when child is active: Gives the user spatial
 * context — they can see the parent category they're inside without it
 * competing with the fully-highlighted active child.
 *
 * WHY SidebarMenuBadge for phase count: It uses the sidebar's own positioning
 * system (absolute right-1) and hides automatically in icon-mode collapse,
 * which is exactly the behavior we want for a count badge.
 */
function TreeNavItem({ item }: { item: SidebarItem }) {
  const { linkComponent: LinkComponent, currentPath } = useShell();
  const isActive = currentPath === item.href;

  // Auto-expand when a child phase is active so the user sees their context
  const hasActiveChild = item.children?.some((child) => currentPath === child.href) ?? false;
  const childCount = item.children?.length ?? 0;
  const [isOpen, setIsOpen] = useState(hasActiveChild);

  const expanded = isOpen || hasActiveChild;

  return (
    <Collapsible open={expanded} onOpenChange={setIsOpen} className="group/tree">
      <SidebarMenuItem>
        {/*
         * The parent row: link on the left, chevron toggle on the right.
         * We use relative positioning from SidebarMenuItem (already `relative`)
         * so the absolute chevron button lands correctly.
         */}
        <SidebarMenuButton
          asChild
          tooltip={item.label}
          isActive={isActive}
          className={cn(
            // Reserve right space for the chevron button
            "pr-8",
            // Parent ambient highlight when a child is the active route —
            // softer than the child's full active treatment
            !isActive && hasActiveChild && "bg-sidebar-accent/40 text-sidebar-foreground"
          )}
        >
          <LinkComponent
            to={item.href}
            className={cn(
              "transition-all duration-150",
              isActive
                ? "text-sidebar-accent-foreground font-semibold"
                : "text-sidebar-foreground/80 font-medium"
            )}
            data-active={isActive}
          >
            {item.icon && (
              <item.icon className="h-4 w-4 shrink-0 transition-transform group-hover/menu-item:scale-110" />
            )}
            <span className="truncate">{item.label}</span>
          </LinkComponent>
        </SidebarMenuButton>

        {/*
         * Phase count badge — visible when sidebar is expanded and tree is collapsed.
         * Gives the user a quick count of how many phases are inside without expanding.
         * Hides automatically when expanded (we show the full list instead).
         * SidebarMenuBadge hides itself in icon-collapse mode via its own CSS.
         */}
        {childCount > 0 && !expanded && (
          <SidebarMenuBadge className="text-footnote text-sidebar-foreground/50 tabular-nums">
            {childCount}
          </SidebarMenuBadge>
        )}

        {/*
         * Chevron toggle button — positioned absolute within the SidebarMenuItem's
         * `relative` container. Separated from the link so click-to-expand doesn't
         * also navigate to the parent WBS page.
         *
         * WHY opacity-0 + group-hover visible: The chevron shouldn't compete for
         * visual attention when the list is quiet. It appears on hover (or when open)
         * following Linear's hover-reveal pattern for secondary controls.
         */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={expanded ? "Collapse phases" : "Expand phases"}
            className={cn(
              "absolute right-1.5 top-1/2 -translate-y-1/2",
              "flex h-5 w-5 items-center justify-center rounded",
              "text-sidebar-foreground/40",
              "hover:bg-sidebar-accent hover:text-sidebar-foreground",
              "transition-all duration-150",
              // Show on hover of the parent menu item, always show when open
              "opacity-0 group-hover/menu-item:opacity-100",
              expanded && "opacity-100"
            )}
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform duration-200 ease-out",
                expanded && "rotate-90"
              )}
            />
          </button>
        </CollapsibleTrigger>

        {/*
         * Animated content panel for child phase items.
         * The SidebarMenuSub already provides the left border "connector line"
         * via border-l on its container — no custom connector needed.
         */}
        <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
          <SidebarMenuSub className="border-sidebar-border/60">
            {item.children?.map((child) => {
              const isChildActive = currentPath === child.href;

              // Split "42 — Pipe Spool" into number and description parts
              // for differentiated typography — the number is muted, the
              // description carries the visual weight.
              const labelParts = parsePhaseLabel(child.label);

              return (
                <SidebarMenuSubItem key={child.id} className="group/child">
                  <SidebarMenuSubButton
                    asChild
                    size="sm"
                    isActive={isChildActive}
                    className={cn(
                      "transition-all duration-150 h-7",
                      isChildActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/70"
                    )}
                  >
                    <LinkComponent to={child.href} data-active={isChildActive}>
                      {labelParts ? (
                        // Structured label: "42" (muted) + " — Pipe Spool" (normal)
                        <span className="flex items-baseline gap-1 min-w-0 truncate">
                          <span
                            className={cn(
                              "text-footnote font-mono tabular-nums shrink-0",
                              isChildActive
                                ? "text-sidebar-accent-foreground/70"
                                : "text-sidebar-foreground/40"
                            )}
                          >
                            {labelParts.number}
                          </span>
                          <span className="truncate text-xs leading-tight">
                            {labelParts.description}
                          </span>
                        </span>
                      ) : (
                        <span className="truncate text-xs">{child.label}</span>
                      )}
                    </LinkComponent>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/**
 * Parses a phase label of the form "42 — Pipe Spool" into its numeric
 * identifier and human-readable description parts.
 *
 * WHY: Phase labels use an em-dash separator convention. Splitting them lets
 * us style the phase number (monospace, muted) and description (normal) with
 * different typography — dramatically improving scannability in a dense list.
 *
 * Returns null if the label doesn't match the expected pattern, falling back
 * to rendering the full label as a single string.
 */
function parsePhaseLabel(label: string): { number: string; description: string } | null {
  // Match "42 — Description" or "42 - Description" (em-dash or regular dash)
  const match = label.match(/^(\d+)\s*[—–-]\s*(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { number: match[1], description: match[2] };
}
