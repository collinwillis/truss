"use client";

/**
 * AppBar Component
 *
 * Top application bar (≈48px) with breadcrumb navigation, global search trigger,
 * and view actions. Inspired by VS Code and other professional desktop applications.
 */

import { ChevronRight, Search, Command, MoreHorizontal } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@truss/ui/components/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@truss/ui/components/tooltip";
import { Separator } from "@truss/ui/components/separator";
import { cn } from "@truss/ui/lib/utils";
import { useShortcut } from "../providers/keyboard-provider";
import { ThemeSwitcher } from "./theme-switcher";
import { useCallback } from "react";

export interface BreadcrumbSegment {
  /** Segment label */
  label: string;
  /** Navigation href */
  href?: string;
  /** Whether this is the current page */
  isCurrent?: boolean;
}

interface AppBarProps {
  /** Breadcrumb segments for navigation */
  breadcrumbs?: BreadcrumbSegment[];
  /** Action buttons to display on the right */
  actions?: React.ReactNode;
  /** Custom className */
  className?: string;
  /** Callback when command palette should open */
  onOpenCommandPalette?: () => void;
}

/**
 * Top application bar with breadcrumb navigation and actions
 *
 * Provides a consistent header across all views with:
 * - Breadcrumb navigation for context
 * - Quick search/command palette access
 * - View-specific actions
 */
export function AppBar({
  breadcrumbs = [],
  actions,
  className,
  onOpenCommandPalette,
}: AppBarProps) {
  const handleCommandPaletteClick = useCallback(() => {
    if (onOpenCommandPalette) {
      onOpenCommandPalette();
    } else {
      // Fallback: dispatch keyboard event to trigger command palette
      const event = new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
      });
      document.dispatchEvent(event);
    }
  }, [onOpenCommandPalette]);

  // Register Cmd+Shift+P as alternative to open command palette
  useShortcut("cmd+shift+p", handleCommandPaletteClick);

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "app-bar",
          "h-11 border-b bg-background/95 backdrop-blur-sm" /* 44px - Desktop standard */,
          "flex items-center justify-between",
          "px-4 gap-3",
          "transition-colors duration-150",
          className
        )}
        role="banner"
      >
        {/* Left: Breadcrumb Navigation */}
        <div className="flex-1 min-w-0">
          {breadcrumbs.length > 0 ? (
            <Breadcrumb>
              <BreadcrumbList className="gap-1.5">
                {breadcrumbs.map((segment, index) => {
                  const isLast = index === breadcrumbs.length - 1;

                  return (
                    <div key={index} className="flex items-center gap-1.5">
                      <BreadcrumbItem>
                        {segment.isCurrent || isLast ? (
                          <BreadcrumbPage className="font-medium text-foreground">
                            {segment.label}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink
                            href={segment.href}
                            className="text-muted-foreground hover:text-foreground transition-colors duration-150"
                          >
                            {segment.label}
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {!isLast && (
                        <BreadcrumbSeparator>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                        </BreadcrumbSeparator>
                      )}
                    </div>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          ) : null}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* Custom Actions */}
          {actions}

          {/* Theme Switcher */}
          <ThemeSwitcher variant="ghost" size="sm" />

          <Separator orientation="vertical" className="h-5" />

          {/* Command Palette Trigger */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 gap-2 px-3",
                  "text-muted-foreground hover:text-foreground",
                  "transition-all duration-150",
                  "hover:bg-accent"
                )}
                onClick={handleCommandPaletteClick}
              >
                <Search className="h-4 w-4" />
                <span className="text-xs">Search</span>
                <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                  <Command className="h-3 w-3" />K
                </kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Open Command Palette (⌘K)</p>
            </TooltipContent>
          </Tooltip>

          {/* More Actions Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-accent transition-colors"
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem>
                <Command className="mr-2 h-4 w-4" />
                Command Palette
                <span className="ml-auto text-xs text-muted-foreground">⌘K</span>
              </DropdownMenuItem>
              <DropdownMenuItem>
                View Settings
                <span className="ml-auto text-xs text-muted-foreground">⌘,</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </TooltipProvider>
  );
}
