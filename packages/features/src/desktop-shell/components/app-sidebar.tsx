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
                "flex items-center gap-2 w-full mt-2 px-3 h-6 rounded-lg",
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
                  "flex items-center justify-center h-6 w-6 rounded-lg",
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
              {/* Visual separator between sections (not before first) —
                  kept subtle so sections read as quietly grouped, not fenced off. */}
              {index > 0 && <SidebarSeparator className="mx-3 my-1 bg-sidebar-border/50" />}
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
        <SidebarGroupLabel className="h-5 mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-sidebar-foreground/60">
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
 * WHY left-edge accent mirrors TreeNavItem: Consistent active-state language
 * across the whole sidebar — a quiet 2px rail for the current row, softer fill
 * than the default shadcn active state so the accent does the scanning work.
 */
function FlatNavItem({ item }: { item: SidebarItem }) {
  const { linkComponent: LinkComponent, currentPath } = useShell();
  const isActive = currentPath === item.href;

  return (
    <SidebarMenuItem className="group/item">
      {isActive && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0 top-1/2 -translate-y-1/2",
            "h-4 w-[2px] rounded-r-full bg-primary",
            "group-data-[collapsible=icon]:hidden"
          )}
        />
      )}
      <SidebarMenuButton
        asChild
        tooltip={item.label}
        isActive={isActive}
        className={cn(
          "h-7",
          isActive && "bg-sidebar-accent/70",
          !isActive && "hover:bg-sidebar-accent"
        )}
      >
        <LinkComponent
          to={item.href}
          className={cn(
            "transition-colors duration-150",
            item.disabled
              ? "pointer-events-none opacity-50"
              : isActive
                ? "text-sidebar-accent-foreground"
                : "text-sidebar-foreground"
          )}
          data-active={isActive}
        >
          {item.icon && (
            <item.icon
              className={cn(
                "shrink-0",
                isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/70"
              )}
            />
          )}
          <span className={cn("truncate text-[12px]", isActive ? "font-semibold" : "font-medium")}>
            {item.label}
          </span>
        </LinkComponent>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Tree navigation item with collapsible children.
 *
 * WHY split chevron from link: Clicking the row navigates to the parent page.
 * Clicking the chevron expands/collapses children. Linear and Notion use this
 * same two-hit-target pattern for category rows.
 *
 * WHY no parent icon: When every item in a section shares the same icon
 * (e.g. Layers for every WBS), the icon adds visual weight without
 * distinguishing items — the indentation and section label already carry
 * the hierarchy. Linear, Vercel, and Figma drop repeated icons for the
 * same reason.
 *
 * WHY left-edge accent for active state: A 2px colored bar sitting just
 * inside the sidebar padding is a quieter, more "product"-feeling active
 * indicator than a full-width background block. The full background remains
 * on the active child, creating a clear two-level hierarchy.
 */
function TreeNavItem({ item }: { item: SidebarItem }) {
  const { linkComponent: LinkComponent, currentPath } = useShell();
  const isActive = currentPath === item.href;

  // Auto-expand when a child phase is active so the user sees their context
  const hasActiveChild = item.children?.some((child) => currentPath === child.href) ?? false;
  const childCount = item.children?.length ?? 0;
  const [isOpen, setIsOpen] = useState(hasActiveChild);

  const expanded = isOpen || hasActiveChild;
  const highlighted = isActive || hasActiveChild;

  return (
    <Collapsible open={expanded} onOpenChange={setIsOpen} className="group/tree">
      <SidebarMenuItem>
        {/*
         * Active-row accent bar — a quiet 2px colored rail tucked against
         * the sidebar edge. Shown at full intensity for the active row and
         * a dimmed variant when a descendant is active (ambient context).
         */}
        {highlighted && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute left-0 top-1/2 -translate-y-1/2",
              "w-[2px] rounded-r-full",
              isActive ? "h-4 bg-primary" : "h-3 bg-primary/40",
              "group-data-[collapsible=icon]:hidden"
            )}
          />
        )}

        <SidebarMenuButton
          asChild
          tooltip={item.label}
          isActive={isActive}
          className={cn(
            // Denser row, pad right for the chevron/count stack
            "h-7 pr-9",
            // Softer active fill than the default — the accent bar carries the signal
            isActive && "bg-sidebar-accent/70",
            !isActive && hasActiveChild && "bg-sidebar-accent/30",
            !isActive && !hasActiveChild && "hover:bg-sidebar-accent"
          )}
        >
          <LinkComponent
            to={item.href}
            className={cn(
              "transition-colors duration-150",
              // Full-opacity text so the UI never reads as "disabled" — hierarchy
              // comes from font-weight and size, not from dimming the whole row.
              isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground"
            )}
            data-active={isActive}
          >
            <span
              className={cn(
                "truncate text-[11px] tracking-wider",
                isActive ? "font-semibold" : "font-medium"
              )}
            >
              {item.label}
            </span>
          </LinkComponent>
        </SidebarMenuButton>

        {/*
         * Child count — a plain muted tabular number instead of a pill.
         * Sits to the left of the chevron so both can coexist on the row.
         * Fades when the tree is open (the children themselves convey the count).
         */}
        {childCount > 0 && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute right-7 top-1/2 -translate-y-1/2",
              "text-[10px] font-mono tabular-nums text-sidebar-foreground/35",
              "transition-opacity duration-150",
              expanded ? "opacity-0" : "opacity-100",
              "group-data-[collapsible=icon]:hidden"
            )}
          >
            {childCount}
          </span>
        )}

        {/*
         * Chevron toggle — always visible at a quiet opacity so the row's
         * expand affordance is discoverable without hovering (matches Linear,
         * Vercel, GitHub tree nav). Rotates smoothly on state change.
         */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            className={cn(
              "absolute right-1 top-1/2 -translate-y-1/2 z-10",
              "flex h-5 w-5 items-center justify-center rounded-md",
              "text-sidebar-foreground/55",
              "hover:bg-sidebar-accent hover:text-sidebar-foreground",
              "transition-all duration-150",
              expanded && "text-sidebar-foreground/80",
              "group-data-[collapsible=icon]:hidden"
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
         * Animated panel for child items. SidebarMenuSub supplies the
         * left guide line via its own border-l — we just dim it so it
         * reads as a subtle connector rather than a hard divider.
         */}
        <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
          {/*
           * Tightened left offset (mx-2 px-1.5) so phase descriptions get
           * more horizontal room before truncating. Connector line is kept
           * at full sidebar-border intensity so the tree relationship is
           * legible rather than vestigial.
           */}
          <SidebarMenuSub className="mx-2 gap-0.5 border-sidebar-border px-1.5 py-1">
            {item.children?.map((child) => {
              const isChildActive = currentPath === child.href;

              // Split "42 — Pipe Spool" into number and description parts
              // so the number can render as quiet monospace and the
              // description as the visually dominant text.
              const labelParts = parsePhaseLabel(child.label);

              return (
                <SidebarMenuSubItem key={child.id} className="group/child">
                  <SidebarMenuSubButton
                    asChild
                    size="sm"
                    isActive={isChildActive}
                    className={cn(
                      "h-6 rounded-md transition-colors duration-150 px-2",
                      isChildActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    )}
                  >
                    <LinkComponent to={child.href} data-active={isChildActive}>
                      {labelParts ? (
                        <span className="flex items-baseline gap-2 min-w-0 flex-1">
                          <span
                            className={cn(
                              "text-[10px] font-mono tabular-nums shrink-0",
                              isChildActive
                                ? "text-sidebar-accent-foreground/65"
                                : "text-sidebar-foreground/45"
                            )}
                          >
                            {labelParts.number}
                          </span>
                          <span
                            className={cn(
                              "truncate text-[11px] tracking-wide",
                              isChildActive ? "font-semibold" : "font-normal"
                            )}
                          >
                            {labelParts.description}
                          </span>
                        </span>
                      ) : (
                        <span className="truncate text-[11px] tracking-wide">{child.label}</span>
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
