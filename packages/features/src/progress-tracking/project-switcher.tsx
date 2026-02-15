"use client";

/**
 * Project Switcher Component
 *
 * Top bar dropdown for switching between construction projects.
 * Inspired by Slack's workspace switcher and Linear's team switcher.
 *
 * Features:
 * - Current project display with dropdown indicator
 * - Recent projects list (quick access)
 * - Search functionality for finding projects
 * - Create/Import actions
 * - Keyboard navigation (Cmd+P to open)
 */

import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronDown, Plus, Search, Upload, ArrowLeftRight } from "lucide-react";
import { Button } from "@truss/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@truss/ui/components/command";
import { cn } from "@truss/ui/lib/utils";
import type { Project } from "./types";

export interface ProjectSwitcherProps {
  /** Currently selected project (null if no project selected) */
  currentProject: Project | null;
  /** Available projects */
  projects: Project[];
  /** Handler for project selection */
  onProjectSelect: (projectId: string) => void;
  /** Handler for "View All Projects" action */
  onViewAll: () => void;
  /** Handler for "Create New Project" action */
  onCreateNew?: () => void;
  /** Handler for "Import from MCP" action */
  onImportMCP?: () => void;
  /** Custom className */
  className?: string;
}

/**
 * Project switcher component for top bar navigation
 *
 * WHY: Provides a consistent, accessible way to switch between projects without
 * cluttering the sidebar. Follows professional desktop app patterns (Slack, Linear, Figma).
 */
export function ProjectSwitcher({
  currentProject,
  projects,
  onProjectSelect,
  onViewAll,
  onCreateNew,
  onImportMCP,
  className,
}: ProjectSwitcherProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  // Listen for custom event to open project switcher (from keyboard shortcut)
  React.useEffect(() => {
    const handleOpen = () => setOpen(true);
    document.addEventListener("open-project-switcher", handleOpen);
    return () => document.removeEventListener("open-project-switcher", handleOpen);
  }, []);

  // Filter projects based on search query
  const filteredProjects = React.useMemo(() => {
    if (!searchQuery) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.owner.toLowerCase().includes(query) ||
        project.jobNumber.toLowerCase().includes(query) ||
        project.location.toLowerCase().includes(query)
    );
  }, [projects, searchQuery]);

  // Get recent projects (active projects, max 5)
  const recentProjects = React.useMemo(() => {
    return projects.filter((p) => p.status === "active").slice(0, 5);
  }, [projects]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-label="Select project"
          className={cn(
            "h-9 px-3 gap-2 font-medium hover:bg-accent/50",
            !currentProject && "text-muted-foreground",
            className
          )}
        >
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="truncate max-w-[200px]">
            {currentProject ? currentProject.name : "Select Project"}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start" side="bottom" sideOffset={4}>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search projects..."
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            <CommandEmpty>No projects found</CommandEmpty>

            {/* Current Project */}
            {currentProject && !searchQuery && (
              <>
                <CommandGroup heading="Current Project">
                  <CommandItem
                    value={currentProject.id}
                    onSelect={() => {
                      setOpen(false);
                    }}
                    className="cursor-default"
                  >
                    <Building2 className="mr-2 h-4 w-4" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{currentProject.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {currentProject.owner} • {currentProject.location}
                      </div>
                    </div>
                    <Check className="ml-2 h-4 w-4 shrink-0" />
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {/* Recent Projects */}
            {!searchQuery && recentProjects.length > 0 && (
              <>
                <CommandGroup heading="Recent Projects">
                  {recentProjects
                    .filter((p) => p.id !== currentProject?.id)
                    .map((project) => (
                      <CommandItem
                        key={project.id}
                        value={project.id}
                        onSelect={() => {
                          onProjectSelect(project.id);
                          setOpen(false);
                        }}
                      >
                        <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{project.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {project.owner} • {project.location}
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {/* Search Results */}
            {searchQuery && filteredProjects.length > 0 && (
              <CommandGroup heading="Projects">
                {filteredProjects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.id}
                    onSelect={() => {
                      onProjectSelect(project.id);
                      setOpen(false);
                    }}
                  >
                    <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{project.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {project.owner} • {project.location}
                      </div>
                    </div>
                    {project.id === currentProject?.id && (
                      <Check className="ml-2 h-4 w-4 shrink-0" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Actions */}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onViewAll();
                  setOpen(false);
                }}
              >
                <ArrowLeftRight className="mr-2 h-4 w-4 text-muted-foreground" />
                <span>View All Projects</span>
              </CommandItem>
              {onCreateNew && (
                <CommandItem
                  onSelect={() => {
                    onCreateNew();
                    setOpen(false);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>Create New Project</span>
                </CommandItem>
              )}
              {onImportMCP && (
                <CommandItem
                  onSelect={() => {
                    onImportMCP();
                    setOpen(false);
                  }}
                >
                  <Upload className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>Import from MCP</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
