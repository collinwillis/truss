/**
 * Dialog for creating a Momentum project from an existing proposal.
 *
 * WHY borderless rows: Professional pickers (Slack channel browser, Linear project
 * picker, Figma file selector) use borderless rows with subtle hover/selected states.
 * Individual borders on every row create visual noise at scale.
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Skeleton } from "@truss/ui/components/skeleton";
import { Check, Search } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";

interface CreateProjectDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
}

/**
 * Create project dialog component.
 *
 * Lists unlinked proposals sorted by proposal number (descending) with search.
 */
export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const navigate = useNavigate();
  const proposals = useQuery(api.momentum.listProposalsForImport);
  const createProject = useMutation(api.momentum.createProject);

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredProposals = useMemo(() => {
    if (!proposals) return undefined;

    const sorted = [...proposals].sort((a, b) =>
      b.proposalNumber.localeCompare(a.proposalNumber, undefined, { numeric: true })
    );

    if (!searchQuery) return sorted;

    const q = searchQuery.toLowerCase();
    return sorted.filter(
      (p) =>
        p.description.toLowerCase().includes(q) ||
        p.proposalNumber.toLowerCase().includes(q) ||
        (p.jobNumber && p.jobNumber.toLowerCase().includes(q)) ||
        (p.ownerName && p.ownerName.toLowerCase().includes(q))
    );
  }, [proposals, searchQuery]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedProposalId(null);
      setSearchQuery("");
    }
    onOpenChange(nextOpen);
  };

  const handleCreate = async () => {
    if (!selectedProposalId) return;

    setIsCreating(true);
    try {
      const projectId = await createProject({
        proposalId: selectedProposalId as any,
      });
      toast.success("Project created", {
        description: "Navigate to the project workbook to start tracking.",
      });
      handleOpenChange(false);
      navigate({
        to: "/project/$projectId",
        params: { projectId: projectId as string },
        search: { wbs: undefined },
      });
    } catch (error) {
      toast.error("Failed to create project", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px] gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="text-base">New Project</DialogTitle>
          <DialogDescription className="text-[13px]">
            Select an estimate to create a tracking project.
          </DialogDescription>
        </DialogHeader>

        {/* Search — pinned above scrollable list */}
        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
            <Input
              placeholder="Search estimates..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        </div>

        {/* Proposal list */}
        <div className="border-t max-h-[340px] overflow-y-auto">
          {filteredProposals === undefined ? (
            <div className="px-5 py-3 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : filteredProposals.length === 0 ? (
            <div className="text-center py-10 px-5">
              <p className="text-[13px] font-medium text-muted-foreground">
                {searchQuery ? "No matching estimates" : "No estimates available"}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {searchQuery
                  ? "Try a different search term."
                  : "Create estimates in Precision first."}
              </p>
            </div>
          ) : (
            <div className="py-1">
              {filteredProposals.map((proposal) => {
                const isSelected = selectedProposalId === proposal.id;

                return (
                  <button
                    key={proposal.id}
                    type="button"
                    onClick={() => setSelectedProposalId(proposal.id)}
                    className={cn(
                      "w-full text-left px-5 py-2.5 transition-colors",
                      "hover:bg-accent/60",
                      isSelected && "bg-accent"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium truncate">
                          {proposal.description}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          <span className="font-mono tabular-nums">{proposal.proposalNumber}</span>
                          {proposal.ownerName && (
                            <>
                              <span className="mx-1.5 text-muted-foreground/30">&middot;</span>
                              {proposal.ownerName}
                            </>
                          )}
                        </div>
                      </div>
                      {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 flex justify-end gap-2 bg-muted/30">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={!selectedProposalId || isCreating}>
            {isCreating ? "Creating..." : "Create Project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
