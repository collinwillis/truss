"use client";

/**
 * CommandPalette Component
 *
 * Global command palette (⌘K) for quick actions and navigation.
 * Inspired by VS Code, Raycast, and Linear.
 */

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@truss/ui/components/command";
import { Settings, FileText } from "lucide-react";
import { useShortcut } from "../providers/keyboard-provider";
import type { CommandConfig } from "../types";

interface CommandPaletteProps {
  commands: CommandConfig[];
  onExecute?: (commandId: string) => void;
}

/**
 * Command palette component for global search and actions
 */
export function CommandPalette({ commands, onExecute }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [recentCommands, setRecentCommands] = useState<string[]>([]);

  // Memoize the handler to prevent re-registration
  const openPalette = useCallback(() => setOpen(true), []);

  // Register global shortcut for opening command palette
  useShortcut("cmd+k", openPalette);
  useShortcut("cmd+p", openPalette); // Alternative shortcut

  // Load recent commands from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("truss-recent-commands");
    if (stored) {
      try {
        setRecentCommands(JSON.parse(stored));
      } catch {
        // Invalid JSON, ignore
      }
    }
  }, []);

  // Group commands by category
  const commandGroups = useMemo(() => {
    const groups = new Map<string, CommandConfig[]>();

    commands.forEach((cmd) => {
      if (cmd.disabled) return;

      const category = cmd.category || "Actions";
      if (!groups.has(category)) {
        groups.set(category, []);
      }
      groups.get(category)!.push(cmd);
    });

    return Array.from(groups.entries()).sort((a, b) => {
      // Put "Actions" first, then alphabetical
      if (a[0] === "Actions") return -1;
      if (b[0] === "Actions") return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [commands]);

  // Get recent command objects
  const recentCommandObjects = useMemo(() => {
    return recentCommands
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is CommandConfig => c !== undefined && !c.disabled)
      .slice(0, 5);
  }, [recentCommands, commands]);

  // Execute command handler
  const executeCommand = useCallback(
    (command: CommandConfig) => {
      // Close palette
      setOpen(false);

      // Add to recent commands
      const newRecent = [command.id, ...recentCommands.filter((id) => id !== command.id)].slice(
        0,
        10
      );
      setRecentCommands(newRecent);
      localStorage.setItem("truss-recent-commands", JSON.stringify(newRecent));

      // Execute handler
      try {
        command.handler();
        onExecute?.(command.id);
      } catch (error) {
        console.error(`Error executing command ${command.id}:`, error);
      }
    },
    [recentCommands, onExecute]
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Type a command or search..."
        value={search}
        onValueChange={setSearch}
      />

      <CommandList>
        <CommandEmpty>No results found for &quot;{search}&quot;</CommandEmpty>

        {/* Recent Commands */}
        {recentCommandObjects.length > 0 && search.length === 0 && (
          <>
            <CommandGroup heading="Recent">
              {recentCommandObjects.map((cmd) => (
                <CommandItem
                  key={`recent-${cmd.id}`}
                  value={cmd.id}
                  onSelect={() => executeCommand(cmd)}
                  keywords={cmd.searchTerms}
                >
                  {cmd.icon && <cmd.icon className="mr-2 h-4 w-4" />}
                  <span>{cmd.label}</span>
                  {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Command Groups */}
        {commandGroups.map(([category, categoryCommands]) => (
          <CommandGroup key={category} heading={category}>
            {categoryCommands.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={cmd.id}
                onSelect={() => executeCommand(cmd)}
                keywords={cmd.searchTerms}
                disabled={cmd.disabled}
              >
                {cmd.icon && <cmd.icon className="mr-2 h-4 w-4" />}
                <span>{cmd.label}</span>
                {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        {/* Quick Actions (Always Available) */}
        <CommandSeparator />
        <CommandGroup heading="Quick Actions">
          <CommandItem
            value="settings"
            onSelect={() => {
              setOpen(false);
              // Navigate to settings
              window.location.href = "/settings";
            }}
          >
            <Settings className="mr-2 h-4 w-4" />
            <span>Settings</span>
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="help"
            onSelect={() => {
              setOpen(false);
              // Open help
              window.open("https://docs.truss.dev", "_blank");
            }}
          >
            <FileText className="mr-2 h-4 w-4" />
            <span>Documentation</span>
            <CommandShortcut>⌘?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
