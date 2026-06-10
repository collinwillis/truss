"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Plus, Split, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Popover, PopoverContent, PopoverTrigger } from "@truss/ui/components/popover";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { cn } from "@truss/ui/lib/utils";

/** Available phase option for the picker. */
export interface PhaseOption {
  id: string;
  code: string;
  description: string;
  /** Provenance — lets the workbook mark phases added after the MCP import. */
  source?: "estimate" | "change_order" | "field_added";
}

/** One target allocation: a phase plus the quantity routed to it. */
export interface PhaseAllocation {
  targetPhaseId: string;
  quantity: number;
}

export interface PhaseReassignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activityId: string;
  activityDescription: string;
  currentPhaseId: string;
  availablePhases: PhaseOption[];
  /** Splittable quantity remaining on the source (net of splits + completed). */
  availableQuantity: number;
  /** Activity unit (`EA`, `LF`, `CY`, …) — shown next to the quantity inputs. */
  unit: string;
  /**
   * Whole-activity move. Reassigns the entire activity (and its source progress)
   * to the target phase via the override path — used when 100% of the available
   * quantity is allocated to a single phase.
   */
  onReassign: (activityId: string, targetPhaseId: string) => void;
  /**
   * Allocate slices across one or more phases in a single atomic operation. The
   * remainder (available − Σ allocations) stays in the current phase.
   */
  onAllocate: (activityId: string, allocations: PhaseAllocation[]) => void;
}

interface Row {
  phaseId: string | null;
  qty: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const parseQty = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Allocate an activity's quantity across one or more phases in a single entry
 * (#31). Each row routes a slice to a target phase; the live "remaining" line
 * tracks what stays in the current phase. Allocating 100% to a single phase
 * routes through `onReassign` (a clean whole-activity move); anything else
 * routes through `onAllocate` (an atomic batch of splits). ⌘↵ confirms.
 */
export function PhaseReassignDialog({
  open,
  onOpenChange,
  activityId,
  activityDescription,
  currentPhaseId,
  availablePhases,
  availableQuantity,
  unit,
  onReassign,
  onAllocate,
}: PhaseReassignDialogProps) {
  const [rows, setRows] = React.useState<Row[]>([{ phaseId: null, qty: "" }]);

  // Reset whenever the dialog reopens for a new activity.
  React.useEffect(() => {
    if (open) setRows([{ phaseId: null, qty: "" }]);
  }, [open, activityId]);

  const phaseById = React.useMemo(
    () => new Map(availablePhases.map((p) => [p.id, p])),
    [availablePhases]
  );
  const usedPhaseIds = React.useMemo(
    () => new Set(rows.map((r) => r.phaseId).filter((id): id is string => !!id)),
    [rows]
  );

  const sumAllocated = round2(rows.reduce((s, r) => s + parseQty(r.qty), 0));
  const remaining = round2(availableQuantity - sumAllocated);

  const completeRows = rows.filter((r) => r.phaseId && parseQty(r.qty) > 0);
  const hasInvalidFilled = rows.some(
    (r) => (r.phaseId || r.qty.trim()) && !(r.phaseId && parseQty(r.qty) > 0)
  );
  const canConfirm = completeRows.length > 0 && !hasInvalidFilled && remaining >= -0.001;
  const isSingleFullMove =
    completeRows.length === 1 &&
    Math.abs(parseQty(completeRows[0]!.qty) - availableQuantity) < 0.001;

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, { phaseId: null, qty: "" }]);
  const removeRow = (i: number) =>
    setRows((prev) =>
      prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ phaseId: null, qty: "" }]
    );

  const distributeEvenly = () => {
    const n = rows.length;
    if (n === 0 || availableQuantity <= 0) return;
    const each = round2(availableQuantity / n);
    setRows((prev) =>
      prev.map((r, idx) => ({
        ...r,
        qty: String(idx === n - 1 ? round2(availableQuantity - each * (n - 1)) : each),
      }))
    );
  };

  const handleConfirm = React.useCallback(() => {
    const complete = rows.filter((r) => r.phaseId && parseQty(r.qty) > 0);
    if (complete.length === 0 || round2(availableQuantity - sumAllocated) < -0.001) return;
    if (complete.length === 1 && Math.abs(parseQty(complete[0]!.qty) - availableQuantity) < 0.001) {
      onReassign(activityId, complete[0]!.phaseId!);
    } else {
      onAllocate(
        activityId,
        complete.map((r) => ({ targetPhaseId: r.phaseId!, quantity: parseQty(r.qty) }))
      );
    }
    onOpenChange(false);
  }, [rows, availableQuantity, sumAllocated, onReassign, onAllocate, activityId, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canConfirm) {
            e.preventDefault();
            handleConfirm();
          }
        }}
      >
        <DialogHeader className="px-4 pt-4 pb-0">
          <DialogTitle className="text-callout font-semibold">Move to Phase</DialogTitle>
          <DialogDescription className="text-subheadline truncate">
            {activityDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 border-t p-4">
          <div className="flex items-baseline justify-between text-subheadline">
            <span className="font-medium text-foreground">Allocate across phases</span>
            <span className="font-mono tabular-nums text-foreground-subtle">
              {availableQuantity} {unit} available
            </span>
          </div>

          <div className="space-y-2">
            {rows.map((row, i) => {
              const selected = row.phaseId ? (phaseById.get(row.phaseId) ?? null) : null;
              const options = availablePhases.filter(
                (p) => p.id !== currentPhaseId && (p.id === row.phaseId || !usedPhaseIds.has(p.id))
              );
              return (
                <div key={i} className="flex items-center gap-2">
                  <PhasePicker
                    selected={selected}
                    options={options}
                    onSelect={(id) => setRow(i, { phaseId: id })}
                  />
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder="0"
                    value={row.qty}
                    onChange={(e) => setRow(i, { qty: e.target.value })}
                    className="w-20 shrink-0 text-right font-mono tabular-nums"
                  />
                  <span className="w-7 shrink-0 font-mono text-subheadline text-muted-foreground">
                    {unit}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-fill-quaternary hover:text-foreground"
                    title="Remove"
                    aria-label="Remove allocation"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-subheadline"
              onClick={addRow}
            >
              <Plus className="size-3.5" />
              Add phase
            </Button>
            {availableQuantity > 0 && rows.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-subheadline text-muted-foreground"
                onClick={distributeEvenly}
              >
                Distribute evenly
              </Button>
            )}
          </div>

          <div
            className={cn(
              "flex items-center justify-between rounded-lg px-3 py-2 text-subheadline",
              remaining < -0.001 ? "bg-destructive/10" : "bg-fill-quaternary/60"
            )}
          >
            <span className="text-muted-foreground">
              {isSingleFullMove ? "Moves the whole activity" : "Stays in current phase"}
            </span>
            <span
              className={cn(
                "font-mono font-medium tabular-nums",
                remaining < -0.001
                  ? "text-destructive"
                  : remaining === 0
                    ? "text-success-text"
                    : "text-foreground"
              )}
            >
              {remaining} {unit}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-fill-quaternary/30 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canConfirm} onClick={handleConfirm} className="gap-1.5">
            {isSingleFullMove ? (
              "Move activity"
            ) : (
              <>
                <Split className="size-3.5" />
                Allocate to {completeRows.length || 1}{" "}
                {completeRows.length === 1 ? "phase" : "phases"}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact per-row phase picker — a popover wrapping the searchable list. */
function PhasePicker({
  selected,
  options,
  onSelect,
}: {
  selected: PhaseOption | null;
  options: PhaseOption[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2 text-left text-callout hover:bg-fill-quaternary"
        >
          {selected ? (
            <>
              <span className="inline-flex shrink-0 items-center rounded bg-fill-quaternary px-1.5 py-0.5 font-mono text-subheadline font-medium tabular-nums text-muted-foreground">
                {selected.code}
              </span>
              <span className="truncate">{selected.description}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Select phase…</span>
          )}
          <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-foreground-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search phases..." />
          <CommandList>
            <CommandEmpty>No phases found.</CommandEmpty>
            <CommandGroup>
              {options.map((phase) => (
                <CommandItem
                  key={phase.id}
                  value={`${phase.code} ${phase.description}`}
                  onSelect={() => {
                    onSelect(phase.id);
                    setOpen(false);
                  }}
                  className="gap-2"
                >
                  <span className="inline-flex shrink-0 items-center rounded bg-fill-quaternary px-1.5 py-0.5 font-mono text-subheadline font-medium tabular-nums text-muted-foreground">
                    {phase.code}
                  </span>
                  <span className="truncate text-callout">{phase.description}</span>
                  {selected?.id === phase.id && (
                    <Check className="ml-auto size-4 shrink-0 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
