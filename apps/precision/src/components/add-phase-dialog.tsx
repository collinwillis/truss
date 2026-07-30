import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
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
import { Button } from "@truss/ui/components/button";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { Search, Check } from "lucide-react";
import { toast } from "sonner";
import { useState, useMemo, useCallback, useEffect } from "react";

interface AddPhaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Typed id so queries and the mutation need no casts; callers cast route params once. */
  wbsId: Id<"wbs">;
  datasetVersion: "v1" | "v2";
  wbsPoolId?: number;
}

/**
 * Dialog for adding a phase from the pool to a WBS.
 *
 * WHY: Queries the phasePool for the parent WBS's pool ID, displaying
 * a searchable list. Auto-populates description from the pool name
 * and auto-increments the phase number.
 */
export function AddPhaseDialog({ open, onOpenChange, wbsId, datasetVersion }: AddPhaseDialogProps) {
  // Get the WBS document to resolve its pool ID
  const wbs = useQuery(api.precision.getWBS, open ? { wbsId } : "skip");

  // Get available phase types for this WBS category
  const phasePool = useQuery(
    api.precision.getPhasePool,
    open && wbs ? { datasetVersion, wbsPoolId: wbs.wbsPoolId } : "skip"
  );

  const addPhase = useMutation(api.precision.addPhase);

  const [search, setSearch] = useState("");
  const [selectedPoolId, setSelectedPoolId] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * D-phasenumber: the server owns the numbering rule (sequential from the
   * WBS code; reserved catalog phases keep their id). The dialog previews the
   * server's answer and only sends a number if the estimator typed one.
   */
  const [manualNumber, setManualNumber] = useState("");
  const previewNumber = useQuery(
    api.precision.getNextPhaseNumber,
    open && selectedPoolId !== null ? { wbsId, phasePoolId: selectedPoolId } : "skip"
  );

  // A new selection invalidates a hand-typed number: the reserved rule can
  // change the answer entirely (Hydrotesting is always 79996).
  useEffect(() => {
    setManualNumber("");
  }, [selectedPoolId]);

  // Filter pool items by search
  const filteredPool = useMemo(() => {
    if (!phasePool) return [];
    if (!search.trim()) return phasePool;
    const q = search.toLowerCase();
    return phasePool.filter((p) => p.name.toLowerCase().includes(q));
  }, [phasePool, search]);

  const resetForm = useCallback(() => {
    setSearch("");
    setSelectedPoolId(null);
    setSelectedName("");
    setDescription("");
    setManualNumber("");
    setIsSubmitting(false);
  }, []);

  const handleSelect = (poolId: number, name: string) => {
    setSelectedPoolId(poolId);
    setSelectedName(name);
    if (!description || description === selectedName) {
      setDescription(name);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedPoolId === null || !description.trim()) return;

    const typed = manualNumber.trim();
    const explicitNumber = typed === "" ? undefined : parseInt(typed, 10);
    if (explicitNumber !== undefined && isNaN(explicitNumber)) {
      toast.error("Invalid phase number", {
        description: `"${manualNumber}" could not be read as a number.`,
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await addPhase({
        wbsId,
        phasePoolId: selectedPoolId,
        poolName: selectedName,
        // Omitted = the server derives it; sent only when hand-typed.
        ...(explicitNumber !== undefined ? { phaseNumber: explicitNumber } : {}),
        description: description.trim(),
      });
      toast.success("Phase added");
      onOpenChange(false);
      resetForm();
    } catch (error) {
      toast.error("Failed to add phase", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetForm();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Phase</DialogTitle>
            <DialogDescription>
              Select a phase type from the catalog, then customize the description.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Phase type selector */}
            <div className="grid gap-2">
              <Label>Phase Type</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-subtle" />
                <Input
                  placeholder="Search phase types..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-sm"
                />
              </div>
              <ScrollArea className="h-[180px] rounded-md border">
                <div className="p-1">
                  {!phasePool ? (
                    <p className="text-xs text-muted-foreground p-2">Loading catalog...</p>
                  ) : filteredPool.length === 0 ? (
                    <p className="text-xs text-muted-foreground p-2">No matching phase types.</p>
                  ) : (
                    filteredPool.map((item) => (
                      <button
                        key={item.poolId}
                        type="button"
                        onClick={() => handleSelect(item.poolId, item.name)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors ${
                          selectedPoolId === item.poolId
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-fill-quaternary"
                        }`}
                      >
                        {selectedPoolId === item.poolId ? (
                          <Check className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <div className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate">{item.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground font-mono tabular-nums">
                          {item.poolId}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Phase number + description */}
            <div className="grid grid-cols-[100px_1fr] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="phase-number">Phase #</Label>
                <Input
                  id="phase-number"
                  type="number"
                  value={manualNumber}
                  onChange={(e) => setManualNumber(e.target.value)}
                  placeholder={previewNumber !== undefined ? String(previewNumber) : "Auto"}
                  className="h-8 text-sm font-mono placeholder:text-muted-foreground/70"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Phase description"
                  className="h-8 text-sm"
                  required
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={isSubmitting || selectedPoolId === null || !description.trim()}
            >
              {isSubmitting ? "Adding..." : "Add Phase"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
