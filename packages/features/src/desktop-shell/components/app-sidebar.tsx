"use client";

/**
 * AppSidebar Component
 *
 * Collapsible navigation sidebar following Slack/Linear patterns:
 * - ⌘K trigger replaces dead search (single search surface)
 * - Label-less sections for flat nav (no "Navigation" tautology)
 * - Clean visual hierarchy with minimal chrome
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
import { Badge } from "@truss/ui/components/badge";
import { cn } from "@truss/ui/lib/utils";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { UserMenu } from "./user-menu";
import { useShell } from "../providers/shell-provider";
import type { AppShellConfig, SidebarSection } from "../types";
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
                "flex items-center gap-2 w-full mt-2 px-3 h-9 rounded-md",
                "text-sm text-muted-foreground",
                "bg-sidebar-accent/50 border border-sidebar-border",
                "hover:bg-sidebar-accent hover:text-sidebar-foreground",
                "transition-all duration-150 cursor-pointer",
                "group-data-[state=collapsed]:hidden"
              )}
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 text-left truncate">Search...</span>
              <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground/70">
                <Command className="h-2.5 w-2.5" />K
              </kbd>
            </button>

            {/* Collapsed: Icon-only trigger */}
            <div className="hidden group-data-[state=collapsed]:flex justify-center mt-2">
              <button
                type="button"
                onClick={openCommandPalette}
                className={cn(
                  "flex items-center justify-center h-8 w-8 rounded-md",
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
        <SidebarGroupLabel className="text-xs font-semibold text-sidebar-foreground/70 px-3 mb-1">
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
              <CollapsibleContent>
                <SidebarMenuSub>
                  {section.items.map((item) => {
                    const isActive = currentPath === item.href;

                    return (
                      <SidebarMenuSubItem key={item.id} className="group/item">
                        <SidebarMenuSubButton asChild>
                          <LinkComponent
                            to={item.href}
                            className={cn(
                              "transition-all duration-150",
                              item.disabled
                                ? "pointer-events-none opacity-50"
                                : isActive
                                  ? "bg-primary/10 text-primary font-semibold"
                                  : "hover:bg-sidebar-accent active:bg-sidebar-accent/80"
                            )}
                            data-active={isActive}
                          >
                            {item.icon && (
                              <item.icon className="h-4 w-4 transition-transform group-hover/item:scale-110" />
                            )}
                            <span className="transition-colors">{item.label}</span>
                            {item.badge && (
                              <Badge
                                variant="secondary"
                                className="ml-auto transition-all group-hover/item:bg-primary/10"
                              >
                                {item.badge}
                              </Badge>
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
        ) : (
          // Non-collapsible flat items
          section.items.map((item) => {
            const isActive = currentPath === item.href;

            return (
              <SidebarMenuItem key={item.id} className="group/item">
                <SidebarMenuButton asChild tooltip={item.label}>
                  <LinkComponent
                    to={item.href}
                    className={cn(
                      "transition-all duration-150",
                      item.disabled
                        ? "pointer-events-none opacity-50"
                        : isActive
                          ? "bg-primary/10 text-primary font-semibold"
                          : "hover:bg-sidebar-accent active:bg-sidebar-accent/80"
                    )}
                    data-active={isActive}
                  >
                    {item.icon && (
                      <item.icon className="transition-transform group-hover/item:scale-110" />
                    )}
                    <span className="transition-colors">{item.label}</span>
                    {item.badge && (
                      <Badge
                        variant="secondary"
                        className="ml-auto transition-all group-hover/item:bg-primary/10"
                      >
                        {item.badge}
                      </Badge>
                    )}
                  </LinkComponent>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
