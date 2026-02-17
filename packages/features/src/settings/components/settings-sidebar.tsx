"use client";

/**
 * Settings sidebar navigation component
 */

import { User, Shield, Palette, Bell } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import type { SettingsSection } from "../types";

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}

const navigationItems: NavItem[] = [
  {
    id: "profile",
    label: "Profile",
    icon: User,
    description: "Personal information",
  },
  {
    id: "account",
    label: "Account",
    icon: Shield,
    description: "Password and security",
  },
  {
    id: "preferences",
    label: "Preferences",
    icon: Palette,
    description: "Theme and appearance",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    description: "Email and alerts",
  },
];

/**
 * Sidebar navigation for settings sections
 */
export function SettingsSidebar({ activeSection, onSectionChange }: SettingsSidebarProps) {
  return (
    <nav className="w-64 border-r bg-card/50 p-4 space-y-1">
      <div className="px-3 py-2">
        <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
        <p className="text-xs text-muted-foreground mt-1">Manage your account and preferences</p>
      </div>

      <div className="space-y-1 pt-4">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onSectionChange(item.id)}
              className={cn(
                "w-full flex items-start gap-3 rounded-lg px-3 py-2.5",
                "transition-all duration-150 ease-out",
                "hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                "focus-visible:ring-offset-1",
                isActive && "bg-accent text-accent-foreground"
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5 mt-0.5 flex-shrink-0 transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}
              />
              <div className="flex-1 text-left">
                <div
                  className={cn(
                    "text-sm font-medium transition-colors",
                    isActive ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {item.label}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{item.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
