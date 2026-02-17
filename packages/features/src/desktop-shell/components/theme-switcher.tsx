"use client";

/**
 * ThemeSwitcher Component
 *
 * Professional theme toggle for light/dark mode switching.
 * Follows VS Code and system preferences pattern with smooth transitions.
 */

import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@truss/ui/components/button";
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
import { useTheme } from "../providers/theme-provider";
import { cn } from "@truss/ui/lib/utils";

type ThemeMode = "light" | "dark" | "system";

interface ThemeSwitcherProps {
  /** Variant style */
  variant?: "default" | "ghost" | "outline";
  /** Size */
  size?: "default" | "sm" | "lg" | "icon";
  /** Show label */
  showLabel?: boolean;
  /** Custom className */
  className?: string;
}

/**
 * Theme switcher dropdown with system, light, and dark mode options
 *
 * Automatically syncs with system preferences when "system" is selected.
 * Persists user preference to localStorage.
 */
export function ThemeSwitcher({
  variant = "ghost",
  size = "sm",
  showLabel = false,
  className,
}: ThemeSwitcherProps) {
  const { theme, setTheme } = useTheme();

  const handleThemeChange = (newTheme: ThemeMode) => {
    setTheme(newTheme);
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant={variant}
                size={size}
                className={cn(
                  "transition-all duration-150",
                  "hover:bg-accent active:bg-accent/80",
                  "focus-visible:ring-1 focus-visible:ring-ring",
                  className
                )}
              >
                <ThemeIcon className={cn("h-4 w-4 transition-transform", showLabel && "mr-2")} />
                {showLabel && <span className="capitalize">{theme}</span>}
                <span className="sr-only">Toggle theme</span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <p>Change theme (current: {theme})</p>
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={() => handleThemeChange("light")}
            className={cn(
              "cursor-pointer transition-colors",
              theme === "light" && "bg-accent text-accent-foreground"
            )}
          >
            <Sun className="mr-2 h-4 w-4" />
            <span>Light</span>
            {theme === "light" && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleThemeChange("dark")}
            className={cn(
              "cursor-pointer transition-colors",
              theme === "dark" && "bg-accent text-accent-foreground"
            )}
          >
            <Moon className="mr-2 h-4 w-4" />
            <span>Dark</span>
            {theme === "dark" && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleThemeChange("system")}
            className={cn(
              "cursor-pointer transition-colors",
              theme === "system" && "bg-accent text-accent-foreground"
            )}
          >
            <Monitor className="mr-2 h-4 w-4" />
            <span>System</span>
            {theme === "system" && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}
