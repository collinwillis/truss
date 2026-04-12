import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { cn } from "@truss/ui/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@truss/ui/components/tabs";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Button } from "@truss/ui/components/button";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import {
  Search,
  Check,
  Wrench,
  Package,
  Truck,
  Building2,
  DollarSign,
  UserPen,
} from "lucide-react";
import { useState, useMemo, useCallback } from "react";

interface AddActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phaseId: string;
  estimateId: string;
}

type ActivityTab =
  | "labor"
  | "material"
  | "equipment"
  | "subcontractor"
  | "cost_only"
  | "custom_labor";

/**
 * Tabbed dialog for adding activities of any type.
 *
 * WHY: Each activity type requires different fields and different pool lookups.
 * Labor activities browse the laborPool filtered by the phase's pool ID.
 * Equipment activities browse the equipmentPool.
 * Other types use freeform inputs.
 */
export function AddActivityDialog({
  open,
  onOpenChange,
  phaseId,
  estimateId,
}: AddActivityDialogProps) {
  const addActivity = useMutation(api.precision.addActivity);

  // Resolve the phase → get its phasePoolId and the proposal's datasetVersion
  const phase = useQuery(api.precision.getPhase, open ? { phaseId: phaseId as never } : "skip");
  const proposal = useQuery(
    api.precision.getProposal,
    open ? { proposalId: estimateId as never } : "skip"
  );

  const datasetVersion = proposal?.datasetVersion ?? "v1";
  const phasePoolId = phase?.phasePoolId;

  // Labor pool — filtered by this phase's pool type
  const laborPool = useQuery(
    api.precision.getLaborPool,
    open && phasePoolId ? { datasetVersion: datasetVersion as "v1" | "v2", phasePoolId } : "skip"
  );

  // Equipment pool — global (not filtered by phase)
  const equipmentPool = useQuery(
    api.precision.getEquipmentPool,
    open ? { datasetVersion: datasetVersion as "v1" | "v2" } : "skip"
  );

  const [activeTab, setActiveTab] = useState<ActivityTab>("labor");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Labor pool selection
  const [laborSearch, setLaborSearch] = useState("");
  const [selectedLaborId, setSelectedLaborId] = useState<number | null>(null);

  // Equipment pool selection
  const [equipSearch, setEquipSearch] = useState("");
  const [selectedEquipId, setSelectedEquipId] = useState<number | null>(null);

  // Shared fields
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");

  // Material / cost-only
  const [unitPrice, setUnitPrice] = useState("");

  // Equipment
  const [equipOwnership, setEquipOwnership] = useState<"rental" | "owned" | "purchase">("rental");
  const [equipTime, setEquipTime] = useState("");

  // Subcontractor
  const [subLabor, setSubLabor] = useState("");
  const [subMaterial, setSubMaterial] = useState("");
  const [subEquipment, setSubEquipment] = useState("");

  // Labor constants (manual for custom_labor, from pool for labor)
  const [craftConstant, setCraftConstant] = useState("");
  const [welderConstant, setWelderConstant] = useState("");

  // Filtered pools
  const filteredLabor = useMemo(() => {
    if (!laborPool) return [];
    if (!laborSearch.trim()) return laborPool;
    const q = laborSearch.toLowerCase();
    return laborPool.filter((l) => l.description.toLowerCase().includes(q));
  }, [laborPool, laborSearch]);

  const filteredEquip = useMemo(() => {
    if (!equipmentPool) return [];
    if (!equipSearch.trim()) return equipmentPool;
    const q = equipSearch.toLowerCase();
    return equipmentPool.filter((e) => e.description.toLowerCase().includes(q));
  }, [equipmentPool, equipSearch]);

  const resetForm = useCallback(() => {
    setDescription("");
    setQuantity("");
    setUnit("");
    setUnitPrice("");
    setEquipOwnership("rental");
    setEquipTime("");
    setSubLabor("");
    setSubMaterial("");
    setSubEquipment("");
    setCraftConstant("");
    setWelderConstant("");
    setLaborSearch("");
    setSelectedLaborId(null);
    setEquipSearch("");
    setSelectedEquipId(null);
    setIsSubmitting(false);
  }, []);

  /** Select a labor item from the pool — auto-populate fields. */
  const handleSelectLabor = (item: {
    poolId: number;
    description: string;
    craftConstant: number;
    weldConstant: number;
    craftUnits: string;
  }) => {
    setSelectedLaborId(item.poolId);
    setDescription(item.description);
    setCraftConstant(String(item.craftConstant));
    setWelderConstant(String(item.weldConstant));
    setUnit(item.craftUnits);
  };

  /** Select an equipment item from the pool — auto-populate fields. */
  const handleSelectEquip = (item: { poolId: number; description: string; dayRate: number }) => {
    setSelectedEquipId(item.poolId);
    setDescription(item.description);
    setUnitPrice(String(item.dayRate));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() || !quantity.trim()) return;

    setIsSubmitting(true);
    try {
      const qty = parseFloat(quantity) || 0;
      const base = {
        phaseId: phaseId as never,
        description: description.trim().toUpperCase(),
        quantity: qty,
        unit: unit.trim() || "EA",
      };

      switch (activeTab) {
        case "labor":
          await addActivity({
            ...base,
            type: "labor",
            laborPoolId: selectedLaborId ?? undefined,
            labor: {
              craftConstant: parseFloat(craftConstant) || 0,
              welderConstant: parseFloat(welderConstant) || 0,
            },
          });
          break;
        case "material":
          await addActivity({ ...base, type: "material", unitPrice: parseFloat(unitPrice) || 0 });
          break;
        case "equipment":
          await addActivity({
            ...base,
            type: "equipment",
            equipmentPoolId: selectedEquipId ?? undefined,
            unitPrice: parseFloat(unitPrice) || 0,
            equipment: { ownership: equipOwnership, time: parseFloat(equipTime) || 0 },
          });
          break;
        case "subcontractor":
          await addActivity({
            ...base,
            type: "subcontractor",
            subcontractor: {
              laborCost: parseFloat(subLabor) || 0,
              materialCost: parseFloat(subMaterial) || 0,
              equipmentCost: parseFloat(subEquipment) || 0,
            },
          });
          break;
        case "cost_only":
          await addActivity({ ...base, type: "cost_only", unitPrice: parseFloat(unitPrice) || 0 });
          break;
        case "custom_labor":
          await addActivity({
            ...base,
            type: "custom_labor",
            labor: {
              craftConstant: parseFloat(craftConstant) || 0,
              welderConstant: parseFloat(welderConstant) || 0,
            },
          });
          break;
      }

      onOpenChange(false);
      resetForm();
    } catch (error) {
      console.error("Failed to add activity:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col">
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <DialogHeader>
            <DialogTitle>Add Activity</DialogTitle>
            <DialogDescription>
              Select the activity type, pick from the catalog, and set quantity.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as ActivityTab)}
            className="mt-3 flex-1 flex flex-col min-h-0"
          >
            <TabsList className="grid grid-cols-3 shrink-0">
              <TabsTrigger value="labor" className="text-xs gap-1">
                <Wrench className="h-3 w-3" /> Labor
              </TabsTrigger>
              <TabsTrigger value="material" className="text-xs gap-1">
                <Package className="h-3 w-3" /> Material
              </TabsTrigger>
              <TabsTrigger value="equipment" className="text-xs gap-1">
                <Truck className="h-3 w-3" /> Equipment
              </TabsTrigger>
            </TabsList>
            <TabsList className="grid grid-cols-3 mt-1 shrink-0">
              <TabsTrigger value="subcontractor" className="text-xs gap-1">
                <Building2 className="h-3 w-3" /> Subcontractor
              </TabsTrigger>
              <TabsTrigger value="cost_only" className="text-xs gap-1">
                <DollarSign className="h-3 w-3" /> Cost Only
              </TabsTrigger>
              <TabsTrigger value="custom_labor" className="text-xs gap-1">
                <UserPen className="h-3 w-3" /> Custom Labor
              </TabsTrigger>
            </TabsList>

            <div className="mt-3 flex-1 min-h-0 overflow-auto space-y-3">
              {/* ── LABOR TAB: Pool browser ── */}
              <TabsContent value="labor" className="mt-0 space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs">Select from labor catalog</Label>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-subtle" />
                    <Input
                      placeholder="Search labor items..."
                      value={laborSearch}
                      onChange={(e) => setLaborSearch(e.target.value)}
                      className="h-8 pl-7 text-sm"
                    />
                  </div>
                  <ScrollArea className="h-[160px] rounded-md border">
                    <div className="p-1">
                      {!laborPool ? (
                        <p className="text-xs text-muted-foreground p-2">
                          Loading labor catalog...
                        </p>
                      ) : filteredLabor.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-2">No matching items.</p>
                      ) : (
                        filteredLabor.map((item) => (
                          <button
                            key={item.poolId}
                            type="button"
                            onClick={() => handleSelectLabor(item)}
                            className={cn(
                              "w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs transition-colors",
                              selectedLaborId === item.poolId
                                ? "bg-primary/10 text-primary"
                                : "hover:bg-fill-quaternary"
                            )}
                          >
                            {selectedLaborId === item.poolId ? (
                              <Check className="h-3 w-3 shrink-0" />
                            ) : (
                              <div className="h-3 w-3 shrink-0" />
                            )}
                            <span className="flex-1 truncate">{item.description}</span>
                            <span className="text-[10px] text-muted-foreground tabular-nums font-mono">
                              {item.craftConstant}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {item.craftUnits}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Craft Constant</Label>
                    <Input
                      type="number"
                      step="any"
                      value={craftConstant}
                      onChange={(e) => setCraftConstant(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="MH/unit"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Weld Constant</Label>
                    <Input
                      type="number"
                      step="any"
                      value={welderConstant}
                      onChange={(e) => setWelderConstant(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="MH/unit"
                    />
                  </div>
                </div>
              </TabsContent>

              {/* ── MATERIAL TAB ── */}
              <TabsContent value="material" className="mt-0 space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Unit Price</Label>
                  <Input
                    type="number"
                    step="any"
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(e.target.value)}
                    className="h-8 text-sm font-mono"
                    placeholder="$ per unit"
                  />
                </div>
              </TabsContent>

              {/* ── EQUIPMENT TAB: Pool browser ── */}
              <TabsContent value="equipment" className="mt-0 space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs">Select from equipment catalog</Label>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-subtle" />
                    <Input
                      placeholder="Search equipment..."
                      value={equipSearch}
                      onChange={(e) => setEquipSearch(e.target.value)}
                      className="h-8 pl-7 text-sm"
                    />
                  </div>
                  <ScrollArea className="h-[120px] rounded-md border">
                    <div className="p-1">
                      {!equipmentPool ? (
                        <p className="text-xs text-muted-foreground p-2">
                          Loading equipment catalog...
                        </p>
                      ) : filteredEquip.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-2">No matching equipment.</p>
                      ) : (
                        filteredEquip.map((item) => (
                          <button
                            key={item.poolId}
                            type="button"
                            onClick={() => handleSelectEquip(item)}
                            className={cn(
                              "w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs transition-colors",
                              selectedEquipId === item.poolId
                                ? "bg-primary/10 text-primary"
                                : "hover:bg-fill-quaternary"
                            )}
                          >
                            {selectedEquipId === item.poolId ? (
                              <Check className="h-3 w-3 shrink-0" />
                            ) : (
                              <div className="h-3 w-3 shrink-0" />
                            )}
                            <span className="flex-1 truncate">{item.description}</span>
                            <span className="text-[10px] text-muted-foreground tabular-nums font-mono">
                              ${item.dayRate}/day
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Ownership</Label>
                    <Select
                      value={equipOwnership}
                      onValueChange={(v) => setEquipOwnership(v as "rental" | "owned" | "purchase")}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rental">Rental</SelectItem>
                        <SelectItem value="owned">Owned</SelectItem>
                        <SelectItem value="purchase">Purchase</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Time</Label>
                    <Input
                      type="number"
                      step="any"
                      value={equipTime}
                      onChange={(e) => setEquipTime(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="Hours"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Rate</Label>
                    <Input
                      type="number"
                      step="any"
                      value={unitPrice}
                      onChange={(e) => setUnitPrice(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="$/unit"
                    />
                  </div>
                </div>
              </TabsContent>

              {/* ── SUBCONTRACTOR TAB ── */}
              <TabsContent value="subcontractor" className="mt-0 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Labor Cost</Label>
                    <Input
                      type="number"
                      step="any"
                      value={subLabor}
                      onChange={(e) => setSubLabor(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="$"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Material Cost</Label>
                    <Input
                      type="number"
                      step="any"
                      value={subMaterial}
                      onChange={(e) => setSubMaterial(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="$"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Equipment Cost</Label>
                    <Input
                      type="number"
                      step="any"
                      value={subEquipment}
                      onChange={(e) => setSubEquipment(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="$"
                    />
                  </div>
                </div>
              </TabsContent>

              {/* ── COST ONLY TAB ── */}
              <TabsContent value="cost_only" className="mt-0 space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Unit Price (no markup)</Label>
                  <Input
                    type="number"
                    step="any"
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(e.target.value)}
                    className="h-8 text-sm font-mono"
                    placeholder="$ per unit"
                  />
                </div>
              </TabsContent>

              {/* ── CUSTOM LABOR TAB ── */}
              <TabsContent value="custom_labor" className="mt-0 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Craft Constant</Label>
                    <Input
                      type="number"
                      step="any"
                      value={craftConstant}
                      onChange={(e) => setCraftConstant(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="MH/unit"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Weld Constant</Label>
                    <Input
                      type="number"
                      step="any"
                      value={welderConstant}
                      onChange={(e) => setWelderConstant(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="MH/unit"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Custom labor uses activity-level rate overrides instead of proposal rates.
                </p>
              </TabsContent>

              {/* ── Shared fields (always visible below tabs) ── */}
              <div className="border-t pt-3 space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Activity description"
                    className="h-8 text-sm uppercase"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Quantity</Label>
                    <Input
                      type="number"
                      step="any"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="h-8 text-sm font-mono"
                      placeholder="0"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit</Label>
                    <Input
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                      className="h-8 text-sm"
                      placeholder="EA, LF, CY..."
                    />
                  </div>
                </div>
              </div>
            </div>
          </Tabs>

          <DialogFooter className="mt-4 shrink-0">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={isSubmitting || !description.trim() || !quantity.trim()}
            >
              {isSubmitting ? "Adding..." : "Add Activity"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
