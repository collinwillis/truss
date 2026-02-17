"use client";

/**
 * Main settings page component with sidebar navigation
 */

import { useState } from "react";
import { SettingsSidebar } from "./components/settings-sidebar";
import { ProfileSection } from "./components/profile-section";
import { AccountSection } from "./components/account-section";
import { PreferencesSection } from "./components/preferences-section";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import type { SettingsSection } from "./types";

/**
 * Settings page with sidebar navigation and content sections
 */
export function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("profile");

  const renderSection = () => {
    switch (activeSection) {
      case "profile":
        return <ProfileSection />;
      case "account":
        return <AccountSection />;
      case "preferences":
        return <PreferencesSection />;
      case "notifications":
        return (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Notifications</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage email and in-app notifications
              </p>
            </div>
            <div className="rounded-lg border border-dashed p-12 text-center">
              <p className="text-muted-foreground">Notification settings coming soon</p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar Navigation */}
      <SettingsSidebar activeSection={activeSection} onSectionChange={setActiveSection} />

      {/* Main Content */}
      <ScrollArea className="flex-1">
        <div className="container max-w-4xl py-8 px-8">{renderSection()}</div>
      </ScrollArea>
    </div>
  );
}
