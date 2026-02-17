"use client";

/**
 * WorkspaceSwitcher Component
 *
 * Dropdown for switching between personal and organization workspaces.
 * Integrates with the existing workspace context from @truss/features/organizations.
 */

import { Building2, ChevronsUpDown, Plus, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@truss/ui/components/sidebar";
import { useWorkspace } from "../../organizations/workspace-context";

interface WorkspaceSwitcherProps {
  appName: string;
  appIcon?: LucideIcon;
}

/**
 * Workspace switcher component for the sidebar header
 */
export function WorkspaceSwitcher({ appName, appIcon: AppIcon }: WorkspaceSwitcherProps) {
  const { workspace, organizations, switchToPersonal, switchToOrganization, isLoading } =
    useWorkspace();

  if (isLoading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" disabled>
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted animate-pulse" />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="w-20 h-3 bg-muted rounded animate-pulse" />
              <span className="w-16 h-2 bg-muted rounded animate-pulse mt-1" />
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const isPersonal = !workspace?.organization_id;
  const currentOrg = workspace?.organization_name || "Personal";
  const currentRole = workspace?.role || "owner";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                {isPersonal ? (
                  <User className="size-4" />
                ) : AppIcon ? (
                  <AppIcon className="size-4" />
                ) : (
                  <Building2 className="size-4" />
                )}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{currentOrg}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {isPersonal ? appName : currentRole}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            align="start"
            side="bottom"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Workspaces
            </DropdownMenuLabel>

            {/* Personal Workspace */}
            <DropdownMenuItem
              onClick={switchToPersonal}
              className="gap-2 p-2"
              disabled={isPersonal}
            >
              <div className="flex size-6 items-center justify-center rounded-md border">
                <User className="size-3.5 shrink-0" />
              </div>
              <span>Personal</span>
              {isPersonal && <span className="ml-auto text-xs">Current</span>}
              <DropdownMenuShortcut>⌘1</DropdownMenuShortcut>
            </DropdownMenuItem>

            {/* Organization Workspaces */}
            {organizations.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {organizations.map((org, index) => (
                  <DropdownMenuItem
                    key={org.id}
                    onClick={() => switchToOrganization(org.id)}
                    className="gap-2 p-2"
                    disabled={workspace?.organization_id === org.id}
                  >
                    <div className="flex size-6 items-center justify-center rounded-md border">
                      <Building2 className="size-3.5 shrink-0" />
                    </div>
                    <div className="flex-1">
                      <div>{org.name}</div>
                      <div className="text-xs text-muted-foreground">{org.role}</div>
                    </div>
                    {workspace?.organization_id === org.id && (
                      <span className="ml-auto text-xs">Current</span>
                    )}
                    <DropdownMenuShortcut>⌘{index + 2}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
              </>
            )}

            <DropdownMenuSeparator />

            {/* Create/Join Organization */}
            <DropdownMenuItem className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <Plus className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">Create or join organization</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
