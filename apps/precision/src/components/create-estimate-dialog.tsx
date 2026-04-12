import { useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { Button } from "@truss/ui/components/button";
import { DEFAULT_RATES } from "@truss/features/estimation/types";
import { useState, useCallback } from "react";

interface CreateEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog for creating a new estimate.
 *
 * WHY: Collects the minimum required fields (number, description, owner,
 * dataset version) and creates the proposal with default rates. The user
 * can edit rates on the detail page after creation.
 */
export function CreateEstimateDialog({ open, onOpenChange }: CreateEstimateDialogProps) {
  const navigate = useNavigate();
  const createProposal = useMutation(api.precision.createProposal);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [proposalNumber, setProposalNumber] = useState("");
  const [description, setDescription] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [datasetVersion, setDatasetVersion] = useState<"v1" | "v2">("v1");
  const [bidType, setBidType] = useState<string | undefined>(undefined);

  const resetForm = useCallback(() => {
    setProposalNumber("");
    setDescription("");
    setOwnerName("");
    setDatasetVersion("v1");
    setBidType(undefined);
    setIsSubmitting(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!proposalNumber.trim() || !description.trim() || !ownerName.trim()) return;

    setIsSubmitting(true);

    try {
      const proposalId = await createProposal({
        proposalNumber: proposalNumber.trim(),
        description: description.trim(),
        ownerName: ownerName.trim(),
        rates: DEFAULT_RATES,
        datasetVersion,
        bidType: bidType as never,
        status: "bidding",
      });

      onOpenChange(false);
      resetForm();

      // Navigate to the new estimate
      navigate({
        to: "/estimate/$estimateId",
        params: { estimateId: proposalId },
      });
    } catch (error) {
      console.error("Failed to create estimate:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New Estimate</DialogTitle>
            <DialogDescription>
              Create a new cost estimate. WBS categories will be initialized automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-3">
              <Label htmlFor="proposal-number">Proposal Number</Label>
              <Input
                id="proposal-number"
                value={proposalNumber}
                onChange={(e) => setProposalNumber(e.target.value)}
                placeholder="e.g., 2024-001"
                className="font-mono"
                required
                autoFocus
              />
            </div>

            <div className="grid gap-3">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Project description"
                required
              />
            </div>

            <div className="grid gap-3">
              <Label htmlFor="owner">Owner / Client</Label>
              <Input
                id="owner"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Client or company name"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-3">
                <Label>Dataset Version</Label>
                <Select
                  value={datasetVersion}
                  onValueChange={(val) => setDatasetVersion(val as "v1" | "v2")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="v1">V1</SelectItem>
                    <SelectItem value="v2">V2</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-3">
                <Label>Bid Type</Label>
                <Select value={bidType ?? ""} onValueChange={(val) => setBidType(val || undefined)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lump_sum">Lump Sum</SelectItem>
                    <SelectItem value="time_and_materials">Time & Materials</SelectItem>
                    <SelectItem value="budgetary">Budgetary</SelectItem>
                    <SelectItem value="rates">Rates</SelectItem>
                    <SelectItem value="cost_plus">Cost Plus</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Estimate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
