import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
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
import { Search, Check, X, ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

interface AddActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"momentumProjects">;
  phaseId: Id<"momentumPhases">;
  phaseDescription?: string;
}

type ActivityTab = "labor" | "material" | "equipment" | "subcontractor" | "cost_only";

/**
 * Sub-modes inside the Labor tab. We merge "labor" and "custom_labor" into
 * a single tab so the user thinks "I'm adding labor" rather than choosing
 * between two parallel tabs that differ only in data-entry mechanics.
 */
type LaborMode = "catalog" | "custom";

type LaborPoolItem = {
  poolId: number;
  description: string;
  craftConstant: number;
  weldConstant: number;
  craftUnits: string;
};

type EquipmentPoolItem = {
  poolId: number;
  description: string;
  dayRate: number;
};

const TABS: Array<{ id: ActivityTab; label: string }> = [
  { id: "labor", label: "Labor" },
  { id: "material", label: "Material" },
  { id: "equipment", label: "Equipment" },
  { id: "subcontractor", label: "Subcontractor" },
  { id: "cost_only", label: "Cost Only" },
];

/**
 * Tabbed dialog for adding an activity to a Momentum phase.
 *
 * Each type renders a focused form: catalog → quantity for labor/equipment,
 * a single price field for material/cost-only, three cost lines for
 * subcontractor, manual constants for custom labor. Auto-derived fields
 * (description, MH constants, unit) collapse into a selection card once
 * the user picks from a pool so the form never shows redundant inputs.
 */
export function AddActivityDialog({
  open,
  onOpenChange,
  projectId,
  phaseId,
  phaseDescription,
}: AddActivityDialogProps) {
  const addActivity = useMutation(api.momentum.addActivity);

  const laborPool = useQuery(
    api.momentum.getLaborPoolForProject,
    open ? { projectId, phaseId } : "skip"
  );
  const equipmentPool = useQuery(
    api.momentum.getEquipmentPoolForProject,
    open ? { projectId } : "skip"
  );

  const [activeTab, setActiveTab] = useState<ActivityTab>("labor");
  const [laborMode, setLaborMode] = useState<LaborMode>("catalog");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Pool selections (when null, the list is shown; when set, the chip is shown)
  const [selectedLabor, setSelectedLabor] = useState<LaborPoolItem | null>(null);
  const [selectedEquip, setSelectedEquip] = useState<EquipmentPoolItem | null>(null);

  const [laborSearch, setLaborSearch] = useState("");
  const [equipSearch, setEquipSearch] = useState("");

  // Per-type form state
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [description, setDescription] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [equipOwnership, setEquipOwnership] = useState<"rental" | "owned" | "purchase">("rental");
  const [equipTime, setEquipTime] = useState("");
  const [subLabor, setSubLabor] = useState("");
  const [subMaterial, setSubMaterial] = useState("");
  const [subEquipment, setSubEquipment] = useState("");
  const [craftConstant, setCraftConstant] = useState("");
  const [welderConstant, setWelderConstant] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const quantityInputRef = useRef<HTMLInputElement>(null);
  const laborSearchRef = useRef<HTMLInputElement>(null);
  const equipSearchRef = useRef<HTMLInputElement>(null);

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
    setQuantity("");
    setUnit("");
    setDescription("");
    setUnitPrice("");
    setEquipOwnership("rental");
    setEquipTime("");
    setSubLabor("");
    setSubMaterial("");
    setSubEquipment("");
    setCraftConstant("");
    setWelderConstant("");
    setLaborSearch("");
    setEquipSearch("");
    setSelectedLabor(null);
    setSelectedEquip(null);
    setShowAdvanced(false);
    setIsSubmitting(false);
    setActiveTab("labor");
    setLaborMode("catalog");
  }, []);

  // Auto-focus the right field as the dialog state changes.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      if (activeTab === "labor" && laborMode === "catalog" && !selectedLabor) {
        laborSearchRef.current?.focus();
      } else if (activeTab === "equipment" && !selectedEquip) {
        equipSearchRef.current?.focus();
      } else {
        quantityInputRef.current?.focus();
      }
    }, 50);
    return () => window.clearTimeout(id);
  }, [open, activeTab, laborMode, selectedLabor, selectedEquip]);

  const handleSelectLabor = (item: LaborPoolItem) => {
    setSelectedLabor(item);
    setCraftConstant(String(item.craftConstant));
    setWelderConstant(String(item.weldConstant));
    setUnit(item.craftUnits);
  };

  const handleClearLabor = () => {
    setSelectedLabor(null);
    setCraftConstant("");
    setWelderConstant("");
    setUnit("");
  };

  const handleSelectEquip = (item: EquipmentPoolItem) => {
    setSelectedEquip(item);
    setUnitPrice(String(item.dayRate));
  };

  const handleClearEquip = () => {
    setSelectedEquip(null);
    setUnitPrice("");
  };

  const isValid = useMemo(() => {
    const qty = parseFloat(quantity);
    if (!quantity.trim() || isNaN(qty) || qty <= 0) return false;
    switch (activeTab) {
      case "labor":
        if (laborMode === "catalog") return !!selectedLabor;
        return description.trim().length > 0 && craftConstant.trim().length > 0;
      case "equipment":
        return !!selectedEquip || description.trim().length > 0;
      case "material":
      case "cost_only":
        return description.trim().length > 0 && unitPrice.trim().length > 0;
      case "subcontractor":
        return description.trim().length > 0;
    }
  }, [
    activeTab,
    laborMode,
    quantity,
    description,
    unitPrice,
    selectedLabor,
    selectedEquip,
    craftConstant,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setIsSubmitting(true);
    try {
      const qty = parseFloat(quantity) || 0;
      const resolvedDescription =
        activeTab === "labor" && selectedLabor
          ? selectedLabor.description
          : activeTab === "equipment" && selectedEquip
            ? selectedEquip.description
            : description.trim();
      const base = {
        phaseId,
        description: resolvedDescription.toUpperCase(),
        quantity: qty,
        unit: unit.trim() || "EA",
      };

      switch (activeTab) {
        case "labor":
          // Sub-mode determines the activity type: catalog rows reference
          // the labor pool and inherit the project's craft rates, while
          // custom rows discard those rates in favor of per-activity
          // overrides downstream.
          await addActivity({
            ...base,
            type: laborMode === "custom" ? "custom_labor" : "labor",
            laborPoolId: laborMode === "catalog" ? selectedLabor?.poolId : undefined,
            labor: {
              craftConstant: parseFloat(craftConstant) || 0,
              welderConstant: parseFloat(welderConstant) || 0,
            },
          });
          break;
        case "material":
          await addActivity({
            ...base,
            type: "material",
            unitPrice: parseFloat(unitPrice) || 0,
          });
          break;
        case "equipment":
          await addActivity({
            ...base,
            type: "equipment",
            equipmentPoolId: selectedEquip?.poolId,
            unitPrice: parseFloat(unitPrice) || 0,
            equipment: {
              ownership: equipOwnership,
              time: parseFloat(equipTime) || 0,
            },
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
          await addActivity({
            ...base,
            type: "cost_only",
            unitPrice: parseFloat(unitPrice) || 0,
          });
          break;
      }

      toast.success("Activity added");
      onOpenChange(false);
      resetForm();
    } catch (error) {
      toast.error("Failed to add activity", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setIsSubmitting(false);
    }
  };

  const handleSwitchTab = (next: ActivityTab) => {
    if (next === activeTab) return;
    setActiveTab(next);
    if (next !== "labor") setSelectedLabor(null);
    if (next !== "equipment") setSelectedEquip(null);
    if (next === "labor") setLaborMode("catalog");
  };

  /**
   * Switch between the Labor tab's two sub-modes. Clears mode-specific
   * state so the form doesn't leak constants/description across modes —
   * picking from the catalog and then switching to Custom should feel
   * like a fresh entry, not a half-filled one.
   */
  const handleLaborModeSwitch = (next: LaborMode) => {
    if (next === laborMode) return;
    setLaborMode(next);
    setSelectedLabor(null);
    setLaborSearch("");
    setDescription("");
    setCraftConstant("");
    setWelderConstant("");
    setUnit("");
    setShowAdvanced(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px] h-[600px] flex flex-col gap-0 p-0">
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <DialogHeader className="px-5 pt-5 pb-3 space-y-1">
            <DialogTitle className="text-base font-semibold">Add Activity</DialogTitle>
            {phaseDescription && (
              <DialogDescription className="text-xs text-muted-foreground">
                Adding to <span className="text-foreground font-medium">{phaseDescription}</span>
              </DialogDescription>
            )}
          </DialogHeader>

          {/* ── Type selector — single row of pills ── */}
          <div className="px-5 pb-3">
            <div className="flex items-center gap-1 p-0.5 rounded-md bg-muted/40 border">
              {TABS.map((t) => {
                const selected = t.id === activeTab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => handleSwitchTab(t.id)}
                    className={cn(
                      "flex-1 flex items-center justify-center h-7 rounded text-xs font-medium transition-colors px-1",
                      selected
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-5 pb-4 space-y-3">
            {/* ── LABOR — catalog and custom sub-modes ── */}
            {activeTab === "labor" && (
              <>
                <SubModeToggle
                  value={laborMode}
                  options={[
                    { value: "catalog", label: "From catalog" },
                    { value: "custom", label: "Custom entry" },
                  ]}
                  onChange={(v) => handleLaborModeSwitch(v as LaborMode)}
                />

                {laborMode === "catalog" ? (
                  <>
                    {selectedLabor ? (
                      <SelectedItemCard
                        title={selectedLabor.description}
                        detail={`${selectedLabor.craftConstant} MH/${selectedLabor.craftUnits} (craft) · ${selectedLabor.weldConstant} MH/${selectedLabor.craftUnits} (weld)`}
                        onClear={handleClearLabor}
                      />
                    ) : (
                      <PoolBrowser
                        searchRef={laborSearchRef}
                        placeholder="Search labor catalog…"
                        search={laborSearch}
                        onSearchChange={setLaborSearch}
                        isLoading={!laborPool}
                        items={filteredLabor.map((item) => ({
                          key: item.poolId,
                          title: item.description,
                          meta: `${item.craftConstant} ${item.craftUnits}`,
                          onSelect: () => handleSelectLabor(item),
                        }))}
                      />
                    )}

                    <PrimaryFields
                      quantity={quantity}
                      unit={unit}
                      onQuantityChange={setQuantity}
                      onUnitChange={setUnit}
                      quantityRef={quantityInputRef}
                      unitDisabled={!!selectedLabor}
                    />

                    {selectedLabor && (
                      <Disclosure
                        open={showAdvanced}
                        onToggle={() => setShowAdvanced((v) => !v)}
                        label="Override constants"
                      >
                        <div className="grid grid-cols-2 gap-3 pt-2">
                          <ConstantField
                            label="Craft constant"
                            value={craftConstant}
                            onChange={setCraftConstant}
                          />
                          <ConstantField
                            label="Weld constant"
                            value={welderConstant}
                            onChange={setWelderConstant}
                          />
                        </div>
                      </Disclosure>
                    )}
                  </>
                ) : (
                  <>
                    <DescriptionField value={description} onChange={setDescription} />
                    <PrimaryFields
                      quantity={quantity}
                      unit={unit}
                      onQuantityChange={setQuantity}
                      onUnitChange={setUnit}
                      quantityRef={quantityInputRef}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <ConstantField
                        label="Craft constant"
                        value={craftConstant}
                        onChange={setCraftConstant}
                      />
                      <ConstantField
                        label="Weld constant"
                        value={welderConstant}
                        onChange={setWelderConstant}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Custom entries use activity-level rate overrides instead of the project's
                      default craft/subsistence rates. Use this when the work doesn't match anything
                      in the catalog.
                    </p>
                  </>
                )}
              </>
            )}

            {/* ── MATERIAL ── */}
            {activeTab === "material" && (
              <>
                <DescriptionField value={description} onChange={setDescription} />
                <PrimaryFields
                  quantity={quantity}
                  unit={unit}
                  onQuantityChange={setQuantity}
                  onUnitChange={setUnit}
                  quantityRef={quantityInputRef}
                />
                <PriceField label="Unit price" value={unitPrice} onChange={setUnitPrice} />
              </>
            )}

            {/* ── EQUIPMENT ── */}
            {activeTab === "equipment" && (
              <>
                {selectedEquip ? (
                  <SelectedItemCard
                    title={selectedEquip.description}
                    detail={`$${selectedEquip.dayRate.toLocaleString()} / day`}
                    onClear={handleClearEquip}
                  />
                ) : (
                  <PoolBrowser
                    searchRef={equipSearchRef}
                    placeholder="Search equipment catalog…"
                    search={equipSearch}
                    onSearchChange={setEquipSearch}
                    isLoading={!equipmentPool}
                    items={filteredEquip.map((item) => ({
                      key: item.poolId,
                      title: item.description,
                      meta: `$${item.dayRate}/day`,
                      onSelect: () => handleSelectEquip(item),
                    }))}
                  />
                )}

                <PrimaryFields
                  quantity={quantity}
                  unit={unit}
                  onQuantityChange={setQuantity}
                  onUnitChange={setUnit}
                  quantityRef={quantityInputRef}
                />

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Ownership</Label>
                    <Select
                      value={equipOwnership}
                      onValueChange={(v) => setEquipOwnership(v as "rental" | "owned" | "purchase")}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rental">Rental</SelectItem>
                        <SelectItem value="owned">Owned</SelectItem>
                        <SelectItem value="purchase">Purchase</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Time (hours)</Label>
                    <NumberInput value={equipTime} onChange={setEquipTime} placeholder="0" />
                  </div>
                </div>

                {!selectedEquip && (
                  <PriceField label="Day rate" value={unitPrice} onChange={setUnitPrice} />
                )}
              </>
            )}

            {/* ── SUBCONTRACTOR ── */}
            {activeTab === "subcontractor" && (
              <>
                <DescriptionField value={description} onChange={setDescription} />
                <PrimaryFields
                  quantity={quantity}
                  unit={unit}
                  onQuantityChange={setQuantity}
                  onUnitChange={setUnit}
                  quantityRef={quantityInputRef}
                />
                <div className="grid grid-cols-3 gap-3">
                  <PriceField label="Labor" value={subLabor} onChange={setSubLabor} compact />
                  <PriceField
                    label="Material"
                    value={subMaterial}
                    onChange={setSubMaterial}
                    compact
                  />
                  <PriceField
                    label="Equipment"
                    value={subEquipment}
                    onChange={setSubEquipment}
                    compact
                  />
                </div>
              </>
            )}

            {/* ── COST ONLY ── */}
            {activeTab === "cost_only" && (
              <>
                <DescriptionField value={description} onChange={setDescription} />
                <PrimaryFields
                  quantity={quantity}
                  unit={unit}
                  onQuantityChange={setQuantity}
                  onUnitChange={setUnit}
                  quantityRef={quantityInputRef}
                />
                <PriceField
                  label="Unit price (no markup)"
                  value={unitPrice}
                  onChange={setUnitPrice}
                />
              </>
            )}
          </div>

          <DialogFooter className="px-5 py-3 border-t bg-muted/30 sm:gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={!isValid || isSubmitting}
              className="min-w-[110px]"
            >
              {isSubmitting ? "Adding…" : "Add activity"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────────

interface PoolBrowserProps {
  searchRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  search: string;
  onSearchChange: (value: string) => void;
  isLoading: boolean;
  items: Array<{ key: number; title: string; meta: string; onSelect: () => void }>;
}

function PoolBrowser({
  searchRef,
  placeholder,
  search,
  onSearchChange,
  isLoading,
  items,
}: PoolBrowserProps) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          ref={searchRef}
          placeholder={placeholder}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 pl-8 text-sm"
        />
      </div>
      <ScrollArea className="h-[200px] rounded-md border bg-muted/20">
        <div className="p-1">
          {isLoading ? (
            <p className="text-xs text-muted-foreground p-3">Loading catalog…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">No matches.</p>
          ) : (
            items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={item.onSelect}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left text-xs transition-colors hover:bg-fill-quaternary group"
              >
                <span className="flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums font-mono">
                  {item.meta}
                </span>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function SelectedItemCard({
  title,
  detail,
  onClear,
}: {
  title: string;
  detail: string;
  onClear: () => void;
}) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-md border bg-primary/[0.04] border-primary/30">
      <Check className="h-4 w-4 text-primary mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-sm font-medium leading-tight truncate">{title}</p>
        <p className="text-[11px] text-muted-foreground font-mono tabular-nums">{detail}</p>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 inline-flex items-center gap-0.5"
      >
        Change <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function PrimaryFields({
  quantity,
  unit,
  onQuantityChange,
  onUnitChange,
  quantityRef,
  unitDisabled,
}: {
  quantity: string;
  unit: string;
  onQuantityChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  quantityRef: React.RefObject<HTMLInputElement | null>;
  unitDisabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_120px] gap-3">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Quantity</Label>
        <NumberInput
          ref={quantityRef}
          value={quantity}
          onChange={onQuantityChange}
          placeholder="0"
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Unit</Label>
        <Input
          value={unit}
          onChange={(e) => onUnitChange(e.target.value.toUpperCase())}
          placeholder="EA"
          disabled={unitDisabled}
          className={cn("h-9 text-sm font-mono", unitDisabled && "opacity-70")}
        />
      </div>
    </div>
  );
}

function DescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Description</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe this activity"
        className="h-9 text-sm"
        required
      />
    </div>
  );
}

function PriceField({
  label,
  value,
  onChange,
  compact,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
          $
        </span>
        <NumberInput
          value={value}
          onChange={onChange}
          placeholder="0.00"
          className={cn("pl-6", compact && "h-9")}
        />
      </div>
    </div>
  );
}

function ConstantField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        <NumberInput value={value} onChange={onChange} placeholder="0.00" />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground font-mono pointer-events-none">
          MH/unit
        </span>
      </div>
    </div>
  );
}

/**
 * Segmented control used inside a tab to switch between sibling sub-modes
 * (e.g. Labor's catalog vs. custom entry). Visually quieter than the
 * outer tab strip so it reads as a second-level affordance, not a peer.
 */
function SubModeToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 p-0.5 rounded-md bg-muted/40 border self-start">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 px-2.5 rounded text-[11px] font-medium transition-colors",
              selected
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && children}
    </div>
  );
}

interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoComplete?: string;
}

/**
 * Text input restricted to decimal characters. WHY text-not-number:
 * native number inputs add browser spinners on desktop, mishandle leading
 * dots, and reject the user's locale-specific decimal separator. A plain
 * text input with `inputMode="decimal"` gets the numeric keyboard on
 * touch and behaves predictably everywhere else.
 */
const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, placeholder, className, autoComplete },
  ref
) {
  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      pattern="[0-9.]*"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
      placeholder={placeholder}
      autoComplete={autoComplete}
      className={cn("h-9 text-sm font-mono tabular-nums", className)}
    />
  );
});
