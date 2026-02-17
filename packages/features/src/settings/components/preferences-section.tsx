"use client";

/**
 * Preferences section for theme and appearance settings
 */

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@truss/ui/components/card";
import { Label } from "@truss/ui/components/label";
import { Switch } from "@truss/ui/components/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { Separator } from "@truss/ui/components/separator";
import { Moon, Sun, Monitor, Keyboard } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { toast } from "@truss/ui/components/sonner";

type ThemeMode = "light" | "dark" | "system";

/**
 * Preferences section for theme and appearance customization
 */
export function PreferencesSection() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [compactMode, setCompactMode] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(true);

  useEffect(() => {
    const savedTheme = (localStorage.getItem("theme") as ThemeMode) || "system";
    setTheme(savedTheme);
    applyTheme(savedTheme);
  }, []);

  const applyTheme = (mode: ThemeMode) => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (mode === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
    } else {
      root.classList.add(mode);
    }
  };

  const handleThemeChange = (newTheme: ThemeMode) => {
    setTheme(newTheme);
    localStorage.setItem("theme", newTheme);
    applyTheme(newTheme);
    toast.success(`Theme changed to ${newTheme}`);
  };

  const themeOptions = [
    {
      value: "light" as ThemeMode,
      label: "Light",
      icon: Sun,
      description: "Use light theme",
    },
    {
      value: "dark" as ThemeMode,
      label: "Dark",
      icon: Moon,
      description: "Use dark theme",
    },
    {
      value: "system" as ThemeMode,
      label: "System",
      icon: Monitor,
      description: "Follow system preference",
    },
  ];

  const keyboardShortcuts = [
    { key: "⌘,", description: "Open Settings" },
    { key: "⌘K", description: "Open Command Palette" },
    { key: "⌘N", description: "New Item" },
    { key: "⌘S", description: "Save" },
    { key: "⌘Z", description: "Undo" },
    { key: "⇧⌘Z", description: "Redo" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Preferences</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize your experience and appearance
        </p>
      </div>

      {/* Theme Selection Card */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how the application looks and feels</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <Label>Theme</Label>
            <div className="grid grid-cols-3 gap-3">
              {themeOptions.map((option) => {
                const Icon = option.icon;
                const isSelected = theme === option.value;

                return (
                  <button
                    key={option.value}
                    onClick={() => handleThemeChange(option.value)}
                    className={cn(
                      "relative flex flex-col items-center gap-3 rounded-lg border-2 p-4",
                      "transition-all duration-200 ease-out",
                      "hover:bg-accent/50 hover:border-primary/50",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      "focus-visible:ring-offset-2",
                      isSelected ? "border-primary bg-accent" : "border-border bg-card"
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-6 w-6 transition-colors",
                        isSelected ? "text-primary" : "text-muted-foreground"
                      )}
                    />
                    <div className="text-center">
                      <div
                        className={cn(
                          "text-sm font-medium transition-colors",
                          isSelected ? "text-foreground" : "text-muted-foreground"
                        )}
                      >
                        {option.label}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{option.description}</div>
                    </div>
                    {isSelected && (
                      <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Display Preferences */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="compact-mode">Compact Mode</Label>
                <p className="text-sm text-muted-foreground">Reduce spacing for a denser layout</p>
              </div>
              <Switch id="compact-mode" checked={compactMode} onCheckedChange={setCompactMode} />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="show-shortcuts">Show Keyboard Shortcuts</Label>
                <p className="text-sm text-muted-foreground">Display shortcut hints in menus</p>
              </div>
              <Switch
                id="show-shortcuts"
                checked={showShortcuts}
                onCheckedChange={setShowShortcuts}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Keyboard Shortcuts Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Keyboard Shortcuts</CardTitle>
          </div>
          <CardDescription>Common keyboard shortcuts for quick navigation</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {keyboardShortcuts.map((shortcut, index) => (
              <div
                key={index}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <span className="text-sm text-muted-foreground">{shortcut.description}</span>
                <kbd className="px-2.5 py-1.5 text-xs font-mono bg-muted rounded border border-border shadow-sm">
                  {shortcut.key}
                </kbd>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Regional Settings Card */}
      <Card>
        <CardHeader>
          <CardTitle>Regional Settings</CardTitle>
          <CardDescription>Configure language and timezone preferences</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="language">Language</Label>
            <Select defaultValue="en">
              <SelectTrigger id="language" className="max-w-md">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Spanish</SelectItem>
                <SelectItem value="fr">French</SelectItem>
                <SelectItem value="de">German</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Select defaultValue="auto">
              <SelectTrigger id="timezone" className="max-w-md">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect</SelectItem>
                <SelectItem value="utc">UTC</SelectItem>
                <SelectItem value="est">Eastern Time</SelectItem>
                <SelectItem value="cst">Central Time</SelectItem>
                <SelectItem value="mst">Mountain Time</SelectItem>
                <SelectItem value="pst">Pacific Time</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
