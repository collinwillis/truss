/**
 * Dialog for creating a Momentum project from an existing proposal.
 *
 * WHY: Separates project creation into its own component so the projects page
 * stays focused on listing/filtering. Uses Convex reactive queries so the
 * proposal list updates automatically if proposals are added in Precision.
 */

import { useState } from "react";
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
import { Skeleton } from "@truss/ui/components/skeleton";
import { Building2, Check } from "lucide-react";
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
 * Lists unlinked proposals and creates a momentum project on selection.
 */
export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const navigate = useNavigate();
  const proposals = useQuery(api.momentum.listProposalsForImport);
  const createProject = useMutation(api.momentum.createProject);

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

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
      onOpenChange(false);
      setSelectedProposalId(null);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Import Project from Estimate</DialogTitle>
          <DialogDescription>
            Select a proposal to create a progress tracking project. Only proposals not already
            linked to a Momentum project are shown.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[360px] overflow-y-auto space-y-2 py-2">
          {proposals === undefined ? (
            // Loading state
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-4 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))
          ) : proposals.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="font-medium">No proposals available</p>
              <p className="text-sm mt-1">
                All proposals are already linked to Momentum projects, or no proposals exist yet.
              </p>
            </div>
          ) : (
            proposals.map((proposal) => (
              <button
                key={proposal.id}
                type="button"
                onClick={() => setSelectedProposalId(proposal.id)}
                className={cn(
                  "w-full text-left rounded-lg border p-4 transition-colors",
                  "hover:border-primary/50 hover:bg-accent/50",
                  selectedProposalId === proposal.id && "border-primary bg-accent"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium truncate">{proposal.description}</span>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {proposal.proposalNumber}
                      {proposal.jobNumber && ` • ${proposal.jobNumber}`}
                      {proposal.ownerName && ` • ${proposal.ownerName}`}
                    </div>
                  </div>
                  {selectedProposalId === proposal.id && (
                    <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!selectedProposalId || isCreating}>
            {isCreating ? "Creating..." : "Create Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
