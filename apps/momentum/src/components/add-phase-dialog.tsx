import { useMutation, useQuery } from "convex/react";
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@truss/ui/components/command";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

interface AddPhaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wbsId: Id<"momentumWbs">;
  /** Display code of the parent WBS (e.g. "300000", "20000"). */
  wbsCode: string;
  /** Whether the parent WBS is the Change Orders WBS — custom-only, adjusts copy. */
  isChangeOrder: boolean;
  /** Pre-filled phase code (e.g. "300000-002"); blank for non-CO WBS. */
  suggestedPhaseCode: string;
  /** Pre-filled description (e.g. "Change Order 2"). */
  suggestedDescription: string;
}

type Mode = "catalog" | "custom";

/**
 * Dialog for adding a phase under any WBS, in two modes.
 *
 * "From catalog" picks a real phase type from the WBS's phasePool — the new
 * phase is anchored to that type, so Add Activity later offers the type's
 * curated labor. "Custom" creates a free-form phase (code + description); its
 * Add Activity list is scoped to the whole WBS instead. The Change Orders WBS
 * has no pool, so it's custom-only with a `300000-NNN` default.
 */
export function AddPhaseDialog({
  open,
  onOpenChange,
  wbsId,
  wbsCode,
  isChangeOrder,
  suggestedPhaseCode,
  suggestedDescription,
}: AddPhaseDialogProps) {
  const addPhase = useMutation(api.momentum.addPhase);
  const catalog = useQuery(api.momentum.getPhasePoolForWbs, isChangeOrder ? "skip" : { wbsId });

  const [mode, setMode] = useState<Mode>(isChangeOrder ? "custom" : "catalog");
  const [selectedPool, setSelectedPool] = useState<{ poolId: number; name: string } | null>(null);
  const [phaseCode, setPhaseCode] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Reset state each time the dialog opens.
  const [lastSeenOpen, setLastSeenOpen] = useState(false);
  if (open && !lastSeenOpen) {
    setMode(isChangeOrder ? "custom" : "catalog");
    setSelectedPool(null);
    setPhaseCode(suggestedPhaseCode);
    setDescription(suggestedDescription);
    setLastSeenOpen(true);
  } else if (!open && lastSeenOpen) {
    setLastSeenOpen(false);
  }

  // In-band example for the custom-code hint (WBS 20000 → "20020").
  const numericWbs = Number(wbsCode);
  const codeExample = isChangeOrder
    ? `${wbsCode}-001`
    : Number.isFinite(numericWbs)
      ? String(numericWbs + 20)
      : "20020";

  /** Picking a catalog type seeds an editable code + description. */
  const handlePickType = (poolId: number, name: string) => {
    setSelectedPool({ poolId, name });
    setPhaseCode(String(poolId));
    setDescription(name);
  };

  const usingCatalog = !isChangeOrder && mode === "catalog";
  const canSubmit =
    !!phaseCode.trim() && !!description.trim() && (!usingCatalog || selectedPool !== null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = phaseCode.trim();
    const desc = description.trim();
    if (!code || !desc || (usingCatalog && !selectedPool)) return;

    setIsSubmitting(true);
    try {
      await addPhase({
        wbsId,
        phaseCode: code,
        description: desc,
        ...(usingCatalog && selectedPool
          ? { phasePoolId: selectedPool.poolId, poolName: selectedPool.name }
          : {}),
      });
      toast.success("Phase added");
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to add phase", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          onKeyDown={(e) => {
            // ⌘↵ / Ctrl↵ submits from anywhere, incl. the catalog where ↵ picks a type.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{isChangeOrder ? "Add Change Order Phase" : "Add Phase"}</DialogTitle>
            <DialogDescription>
              {isChangeOrder
                ? "Each change order typically gets its own phase so progress and cost roll up cleanly. Give it a phase code and a description."
                : `Add a phase under WBS ${wbsCode}. Pick a type from the catalog, or create a custom one, then use Add Activity to assign work.`}
            </DialogDescription>
          </DialogHeader>

          {/* Mode toggle — change orders are custom-only. */}
          {!isChangeOrder && (
            <div className="mt-4 inline-flex items-center rounded-lg bg-fill-tertiary p-[3px] text-subheadline">
              {(
                [
                  { value: "catalog", label: "From catalog" },
                  { value: "custom", label: "Custom" },
                ] as const
              ).map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  className={cn(
                    "px-3 py-1 rounded-md font-medium transition-all",
                    mode === m.value
                      ? "bg-background shadow-xs text-foreground"
                      : "text-foreground-subtle hover:text-foreground"
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {/* Catalog mode — searchable list of the WBS's phase types. */}
          {usingCatalog && (
            <div className="mt-3 space-y-3">
              <Command className="rounded-mac-card border" loop>
                <CommandInput placeholder="Search phase types…" className="text-sm" />
                <CommandList className="max-h-[208px]">
                  <CommandEmpty className="py-6 text-center text-callout text-muted-foreground">
                    {catalog === undefined ? "Loading…" : "No phase types for this WBS."}
                  </CommandEmpty>
                  <CommandGroup>
                    {(catalog ?? []).map((t) => (
                      <CommandItem
                        key={t.poolId}
                        value={`${t.poolId} ${t.name}`}
                        onSelect={() => handlePickType(t.poolId, t.name)}
                        className="gap-2"
                      >
                        <Check
                          className={cn(
                            "h-3.5 w-3.5 shrink-0",
                            selectedPool?.poolId === t.poolId ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span className="tabular-nums text-muted-foreground">{t.poolId}</span>
                        <span className="truncate">{t.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>

              {/* Editable code + description once a type is chosen. */}
              {selectedPool && (
                <div className="grid grid-cols-[120px_1fr] gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="catalog-phase-code">
                      Phase Code
                    </Label>
                    <Input
                      id="catalog-phase-code"
                      value={phaseCode}
                      onChange={(e) => setPhaseCode(e.target.value)}
                      className="h-9 text-sm tabular-nums"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="catalog-phase-description">
                      Description
                    </Label>
                    <Input
                      id="catalog-phase-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="h-9 text-sm"
                      required
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Custom mode (and all change orders). */}
          {!usingCatalog && (
            <div className="mt-4 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="phase-code">
                  Phase Code
                </Label>
                <Input
                  id="phase-code"
                  autoFocus
                  value={phaseCode}
                  onChange={(e) => setPhaseCode(e.target.value)}
                  className="h-9 text-sm"
                  placeholder={`e.g. ${codeExample}`}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="phase-description">
                  Description
                </Label>
                <Input
                  id="phase-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="h-9 text-sm"
                  placeholder={isChangeOrder ? "e.g. Additional fittings" : "e.g. Field rework"}
                  required
                />
              </div>
              {!isChangeOrder && (
                <p className="text-footnote text-muted-foreground">
                  Add Activity will offer labor from across WBS {wbsCode}.
                </p>
              )}
            </div>
          )}

          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting || !canSubmit}>
              {isSubmitting ? "Adding…" : "Add Phase"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
