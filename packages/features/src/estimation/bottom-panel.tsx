import { cn } from "@truss/ui/lib/utils";
import { Button } from "@truss/ui/components/button";
import { Separator } from "@truss/ui/components/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@truss/ui/components/collapsible";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useState, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cost breakdown for the bottom panel. */
export interface BottomPanelCosts {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

/** Extended summary with hour classification. */
export interface BottomPanelSummary extends BottomPanelCosts {
  directHours?: number;
  indirectHours?: number;
  totalHours?: number;
}

interface BottomPanelProps {
  costs: BottomPanelSummary;
  scope: string;
  itemCount?: number;
  actions?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtC(n: number): string {
  if (n === 0) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtH(n: number): string {
  if (n === 0) return "0.0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(n);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const KEY = "precision:bp";

/** Handle English irregular plurals. */
function pluralize(word: string, count: number): string {
  const lower = word.toLowerCase();
  if (count === 1) return lower;
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower)) {
    return lower.slice(0, -1) + "ies";
  }
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("sh") || lower.endsWith("ch")) {
    return lower + "es";
  }
  return lower + "s";
}

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Persistent bottom status bar with scope-aware cost and hour totals.
 *
 * WHY: Estimators need running totals visible at all times. The compact
 * bar shows key metrics; the collapsible breakdown shows full detail.
 * Uses shadcn Collapsible for smooth height animation.
 */
export function BottomPanel({ costs, scope, itemCount, actions }: BottomPanelProps) {
  const [expanded, setExpanded] = useState(loadExpanded);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(expanded));
    } catch {
      /* noop */
    }
  }, [expanded]);

  const totalMH = costs.totalHours ?? costs.craftManHours + costs.welderManHours;
  const hasDirect = costs.directHours !== undefined;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="border-t bg-card select-none">
        {/* ── Compact status bar (always visible) ── */}
        <div className="flex h-9 items-center px-3">
          <Metric label="Total" value={fmtC(costs.totalCost)} bold />
          <Sep />
          <Metric label="MH" value={fmtH(totalMH)} />
          {hasDirect && (
            <>
              <Sep />
              <Metric label="Direct" value={fmtH(costs.directHours!)} />
              <Sep />
              <Metric label="Indirect" value={fmtH(costs.indirectHours ?? 0)} />
            </>
          )}
          <Sep />
          <Metric label="Craft" value={fmtH(costs.craftManHours)} />
          <Sep />
          <Metric label="Weld" value={fmtH(costs.welderManHours)} />

          <div className="flex-1" />

          {itemCount !== undefined && (
            <span className="mr-2 text-[10px] tabular-nums text-muted-foreground">
              {itemCount} {pluralize(scope, itemCount)}
            </span>
          )}

          {actions}

          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5" />
              )}
            </Button>
          </CollapsibleTrigger>
        </div>

        {/* ── Expandable breakdown (animated by shadcn Collapsible) ── */}
        <CollapsibleContent>
          <Separator />
          <div className="grid grid-cols-3 gap-8 px-4 py-3">
            <Group title="Man-Hours">
              <Row label="Craft" value={fmtH(costs.craftManHours)} />
              <Row label="Welder" value={fmtH(costs.welderManHours)} />
              {hasDirect && (
                <>
                  <RowSep />
                  <Row label="Direct" value={fmtH(costs.directHours!)} />
                  <Row label="Indirect" value={fmtH(costs.indirectHours ?? 0)} />
                </>
              )}
              <RowSep />
              <Row label="Total" value={fmtH(totalMH)} bold />
            </Group>

            <Group title="Labor">
              <Row label="Craft" value={fmtC(costs.craftCost)} />
              <Row label="Welder" value={fmtC(costs.welderCost)} />
              <RowSep />
              <Row label="Total Labor" value={fmtC(costs.craftCost + costs.welderCost)} bold />
            </Group>

            <Group title="Other Costs">
              <Row label="Material" value={fmtC(costs.materialCost)} />
              <Row label="Equipment" value={fmtC(costs.equipmentCost)} />
              <Row label="Subcontractor" value={fmtC(costs.subcontractorCost)} />
              <Row label="Cost Only" value={fmtC(costs.costOnlyCost)} />
              <RowSep />
              <Row label="Grand Total" value={fmtC(costs.totalCost)} bold />
            </Group>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Metric({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">
        {label}
      </span>
      <span
        className={cn(
          "text-xs font-mono tabular-nums whitespace-nowrap",
          bold ? "font-bold text-foreground" : "text-foreground/80"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Sep() {
  return <div className="h-4 w-px bg-border shrink-0" />;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={cn("text-xs", bold ? "font-medium text-foreground" : "text-muted-foreground")}
      >
        {label}
      </span>
      <span
        className={cn(
          "text-xs font-mono tabular-nums",
          bold ? "font-bold text-foreground" : "text-foreground/80"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function RowSep() {
  return <Separator className="my-1" />;
}
