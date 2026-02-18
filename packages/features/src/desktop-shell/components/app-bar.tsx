"use client";

/**
 * AppBar Component
 *
 * Minimal top bar with breadcrumb navigation and view-specific actions.
 * Search/command palette access moved to sidebar trigger (⌘K).
 * Overflow menu removed (contained only redundant/broken items).
 */

import { ChevronRight } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@truss/ui/components/breadcrumb";
import { TooltipProvider } from "@truss/ui/components/tooltip";
import { cn } from "@truss/ui/lib/utils";
import { ThemeSwitcher } from "./theme-switcher";

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
}

/**
 * Top application bar with breadcrumb navigation and actions.
 *
 * WHY minimal: The previous bar had a ⌘K button (redundant with sidebar trigger),
 * a ··· menu (two items, both broken/redundant), and a separator. Removing these
 * follows the "every element earns its place" principle from Slack/Linear.
 */
export function AppBar({ breadcrumbs = [], actions, className }: AppBarProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "app-bar",
          "h-11 border-b bg-background/95 backdrop-blur-sm",
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

        {/* Right: View-specific actions + theme */}
        <div className="flex items-center gap-2">
          {actions}
          <ThemeSwitcher variant="ghost" size="sm" />
        </div>
      </div>
    </TooltipProvider>
  );
}
