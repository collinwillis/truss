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
import { useState, useCallback, useMemo } from "react";

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

  // A section is a "list section" when its items declare children or badges —
  // it then gets the inline filter and consistent row rendering. (Precision's
  // WBS rail is deliberately shallow: badge counts, no child trees — D7's
  // drill-down keeps phases in the content, not the nav.)
  const isTreeSection =
    section.items?.some((item) => item.children !== undefined || item.badge !== undefined) ?? false;

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
        ) : isTreeSection ? (
          <TreeSection items={section.items} />
        ) : (
          section.items.map((item) => <FlatNavItem key={item.id} item={item} />)
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * A tree section: every row is a TreeNavItem (aligned left chevron gutter,
 * even for items with zero children), with an inline filter for large trees.
 *
 * WHY a filter here and not just ⌘K: at production scale a single estimate
 * carries thousands of phases. The palette answers "jump to X"; the filter
 * answers "show me the shape of everything matching X" — both are needed,
 * and Figma's layers panel is the precedent for the second.
 */
function TreeSection({ items }: { items: SidebarItem[] }) {
  const [query, setQuery] = useState("");

  const normalized = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalized) return items;
    return items.flatMap((item) => {
      const parentMatches = item.label.toLowerCase().includes(normalized);
      const matchingChildren =
        item.children?.filter((child) => child.label.toLowerCase().includes(normalized)) ?? [];
      // A matching parent keeps its whole subtree; otherwise keep only the
      // parents of matching children, trimmed to those children.
      if (parentMatches) return [item];
      if (matchingChildren.length > 0) return [{ ...item, children: matchingChildren }];
      return [];
    });
  }, [items, normalized]);

  // The filter is only worth its row height once the tree is big enough to
  // need it; small trees stay chrome-free.
  const totalRows = items.reduce((sum, item) => sum + 1 + (item.children?.length ?? 0), 0);
  const showFilter = totalRows > 12;

  return (
    <>
      {showFilter && (
        <div className="relative mx-2 mb-1 group-data-[collapsible=icon]:hidden">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-sidebar-foreground/40" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter…"
            className={cn(
              "h-6 w-full rounded-md bg-sidebar-accent/50 pl-7 pr-2",
              "text-[11px] text-sidebar-foreground placeholder:text-sidebar-foreground/40",
              "outline-none transition-colors focus:bg-sidebar-accent"
            )}
          />
        </div>
      )}
      {filtered.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-sidebar-foreground/45">No matches</p>
      ) : (
        filtered.map((item) =>
          item.children !== undefined ? (
            <TreeNavItem key={item.id} item={item} forceOpen={normalized.length > 0} />
          ) : (
            <FlatNavItem key={item.id} item={item} />
          )
        )
      )}
    </>
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
  // WBS-style labels ("70000 · AG PIPING") get the quiet mono-code column;
  // ordinary labels render as before.
  const flatParts = parseWbsLabel(item.label);

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
          item.badge !== undefined && "pr-8",
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
          {flatParts ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span
                className={cn(
                  "shrink-0 font-mono text-[10px] tabular-nums",
                  isActive ? "text-sidebar-accent-foreground/65" : "text-sidebar-foreground/45"
                )}
              >
                {flatParts.code}
              </span>
              <span
                className={cn(
                  "truncate text-[11px] tracking-wide",
                  isActive ? "font-semibold" : "font-medium"
                )}
              >
                {flatParts.name}
              </span>
            </span>
          ) : (
            <span
              className={cn("truncate text-[12px]", isActive ? "font-semibold" : "font-medium")}
            >
              {item.label}
            </span>
          )}
        </LinkComponent>
      </SidebarMenuButton>
      {item.badge !== undefined && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2",
            "text-[10px] font-mono tabular-nums text-sidebar-foreground/35",
            "group-data-[collapsible=icon]:hidden"
          )}
        >
          {item.badge}
        </span>
      )}
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
function TreeNavItem({ item, forceOpen = false }: { item: SidebarItem; forceOpen?: boolean }) {
  const { linkComponent: LinkComponent, currentPath } = useShell();
  const isActive = currentPath === item.href;

  // Auto-expand when a child phase is active so the user sees their context
  const hasActiveChild = item.children?.some((child) => currentPath === child.href) ?? false;
  const childCount = item.children?.length ?? 0;
  const [isOpen, setIsOpen] = useState(hasActiveChild);

  const expanded = forceOpen || isOpen || hasActiveChild;
  const highlighted = isActive || hasActiveChild;
  const labelParts = parseWbsLabel(item.label);

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

        {/*
         * Chevron toggle in a LEFT gutter — the VSCode/Notion/Figma tree
         * convention. It was previously a 12px target pressed against the
         * sidebar's right edge, which failed the only test that matters:
         * Collin couldn't hit it. 24px square, generous hover, and rows
         * without children keep the empty gutter so every label aligns.
         */}
        {childCount > 0 && (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={expanded ? "Collapse" : "Expand"}
              className={cn(
                "absolute left-1 top-1/2 -translate-y-1/2 z-10",
                "flex h-6 w-6 items-center justify-center rounded-md",
                "text-sidebar-foreground/55",
                "hover:bg-sidebar-accent hover:text-sidebar-foreground",
                "transition-all duration-150",
                expanded && "text-sidebar-foreground/80",
                "group-data-[collapsible=icon]:hidden"
              )}
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200 ease-out",
                  expanded && "rotate-90"
                )}
              />
            </button>
          </CollapsibleTrigger>
        )}

        <SidebarMenuButton
          asChild
          tooltip={item.label}
          isActive={isActive}
          className={cn(
            // Label clears the chevron gutter; right padding for the count.
            "h-7 pl-8 pr-8",
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
            {labelParts ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] tabular-nums",
                    isActive ? "text-sidebar-accent-foreground/65" : "text-sidebar-foreground/45"
                  )}
                >
                  {labelParts.code}
                </span>
                <span
                  className={cn(
                    "truncate text-[11px] tracking-wide",
                    isActive ? "font-semibold" : "font-medium"
                  )}
                >
                  {labelParts.name}
                </span>
              </span>
            ) : (
              <span
                className={cn(
                  "truncate text-[11px] tracking-wider",
                  isActive ? "font-semibold" : "font-medium"
                )}
              >
                {item.label}
              </span>
            )}
          </LinkComponent>
        </SidebarMenuButton>

        {/*
         * Child count at the freed-up right edge — a plain muted tabular
         * number. Fades when the tree is open (the children convey it).
         */}
        {childCount > 0 && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2",
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
          {/* Guide line sits under the chevron gutter; children align with
              the parent label. */}
          <SidebarMenuSub className="ml-4 mr-2 gap-0.5 border-sidebar-border px-1.5 py-1">
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

/**
 * Parses a WBS label of the form "70000 · AG PIPING" into code and name, for
 * the same quiet-mono-code typography the phase rows use. The code is the
 * estimator-facing identity, so it leads — but visually it is the quieter of
 * the two parts.
 */
function parseWbsLabel(label: string): { code: string; name: string } | null {
  const match = label.match(/^(\d+)\s*·\s*(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { code: match[1], name: match[2] };
}
