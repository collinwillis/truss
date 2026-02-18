"use client";

/**
 * CommandPalette Component
 *
 * Global command palette (⌘K) for quick actions and navigation.
 * This is the single search surface for the entire app - sidebar trigger
 * and keyboard shortcuts both open this palette.
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
import { FileText } from "lucide-react";
import { useShortcut } from "../providers/keyboard-provider";
import type { CommandConfig } from "../types";

interface CommandPaletteProps {
  commands: CommandConfig[];
  onExecute?: (commandId: string) => void;
}

/**
 * Command palette component for global search and actions.
 *
 * WHY single surface: Having one searchable command palette (like Linear/Raycast)
 * is cleaner than scattered search inputs. Opens via ⌘K, sidebar trigger button,
 * or the "open-command-palette" custom event.
 */
export function CommandPalette({ commands, onExecute }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [recentCommands, setRecentCommands] = useState<string[]>([]);

  const openPalette = useCallback(() => setOpen(true), []);

  // Register keyboard shortcuts
  useShortcut("cmd+k", openPalette);

  // Listen for custom event from sidebar trigger button
  useEffect(() => {
    const handleOpen = () => setOpen(true);
    document.addEventListener("open-command-palette", handleOpen);
    return () => document.removeEventListener("open-command-palette", handleOpen);
  }, []);

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

  const executeCommand = useCallback(
    (command: CommandConfig) => {
      setOpen(false);

      const newRecent = [command.id, ...recentCommands.filter((id) => id !== command.id)].slice(
        0,
        10
      );
      setRecentCommands(newRecent);
      localStorage.setItem("truss-recent-commands", JSON.stringify(newRecent));

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

        {/* Command Groups (populated from shell config) */}
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

        {/* Quick Actions */}
        <CommandSeparator />
        <CommandGroup heading="Quick Actions">
          <CommandItem
            value="help"
            onSelect={() => {
              setOpen(false);
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
