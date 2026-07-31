import { cn } from "@truss/ui/lib/utils";
import { Button } from "@truss/ui/components/button";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The totals inspector — a collapsible right panel with the live cost
 * breakdown, replacing the old global bottom drawer.
 *
 * WHY A RIGHT INSPECTOR: estimators watch the bid react as they type; that
 * is properties-of-the-current-context, which is exactly what the design
 * doc's "optional right inspector" region is for (Figma/VS Code/Linear all
 * put live context there). Two sections, deliberately: the CURRENT SCOPE'S
 * breakdown, then the WHOLE ESTIMATE — one edit visibly moves both.
 *
 * Values flash briefly when they change — the "it reacted" feedback that
 * makes live re-pricing legible instead of magical.
 */

const cfmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const mhfmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const OPEN_KEY = "precision.totalsInspector.open";

/** Panel open state, persisted so the choice survives navigation and restarts. */
export function useTotalsInspector(): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((prev) => {
      try {
        localStorage.setItem(OPEN_KEY, prev ? "closed" : "open");
      } catch {
        // Preference persistence is best-effort.
      }
      return !prev;
    });
  };
  return [open, toggle];
}

/** Toolbar chip: the grand total stays visible even with the panel closed. */
export function InspectorToggle({
  grandTotal,
  open,
  onToggle,
}: {
  grandTotal: number | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = open ? PanelRightClose : PanelRightOpen;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      title={open ? "Hide totals panel" : "Show totals panel"}
      onClick={onToggle}
    >
      {grandTotal !== undefined && (
        <span className="font-mono text-[11px] font-medium tabular-nums">
          {cfmt.format(grandTotal)}
        </span>
      )}
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
    </Button>
  );
}

/** The cost fields a scope must provide — matches the rollup queries. */
export interface ScopeCosts {
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

/** The estimate-wide fields the inspector reads from getProposalSummary. */
export interface EstimateSummary extends ScopeCosts {
  totalHours: number;
  directHours: number;
  indirectHours: number;
  activityCount: number;
}

export function TotalsInspector({
  scopeLabel,
  scopeCosts,
  summary,
  open,
}: {
  /** e.g. "70000 · AG PIPING" or "12 — CARBON STEEL". */
  scopeLabel: string;
  scopeCosts: ScopeCosts;
  /** The page's getProposalSummary subscription — it also feeds the chip. */
  summary: EstimateSummary | undefined;
  open: boolean;
}) {
  if (!open) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-l bg-fill-quaternary/40">
      {/* ── Current scope ── */}
      <div className="border-b px-4 py-3">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {scopeLabel}
        </p>
        <FlashValue
          value={scopeCosts.totalCost}
          className="mt-1 block font-mono text-lg font-semibold tabular-nums"
        >
          {cfmt.format(scopeCosts.totalCost)}
        </FlashValue>
      </div>

      <div className="space-y-4 px-4 py-3">
        <RowGroup label="Man-hours">
          <Row label="Craft" value={scopeCosts.craftManHours} format={mhfmt.format} />
          <Row label="Weld" value={scopeCosts.welderManHours} format={mhfmt.format} />
          <Row
            label="Total"
            value={scopeCosts.craftManHours + scopeCosts.welderManHours}
            format={mhfmt.format}
            strong
          />
        </RowGroup>

        <RowGroup label="Costs">
          <Row
            label="Labor"
            value={scopeCosts.craftCost + scopeCosts.welderCost}
            format={cfmt.format}
          />
          <Row label="Material" value={scopeCosts.materialCost} format={cfmt.format} />
          <Row label="Equipment" value={scopeCosts.equipmentCost} format={cfmt.format} />
          <Row label="Subcontractor" value={scopeCosts.subcontractorCost} format={cfmt.format} />
          <Row label="Cost only" value={scopeCosts.costOnlyCost} format={cfmt.format} />
          <Row label="Total" value={scopeCosts.totalCost} format={cfmt.format} strong />
        </RowGroup>
      </div>

      {/* ── Whole estimate ── */}
      <div className="border-t bg-fill-quaternary/60 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Estimate
        </p>
        {summary ? (
          <>
            <FlashValue
              value={summary.totalCost}
              className="mt-1 block font-mono text-lg font-semibold tabular-nums"
            >
              {cfmt.format(summary.totalCost)}
            </FlashValue>
            <div className="mt-2 space-y-1">
              <Row label="Man-hours" value={summary.totalHours} format={mhfmt.format} />
              <Row label="Direct" value={summary.directHours} format={mhfmt.format} />
              <Row label="Indirect" value={summary.indirectHours} format={mhfmt.format} />
              <Row label="Activities" value={summary.activityCount} format={String} />
            </div>
          </>
        ) : (
          <p className="mt-1 font-mono text-lg text-foreground-subtle">…</p>
        )}
      </div>
    </aside>
  );
}

function RowGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  format,
  strong,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between text-xs",
        strong && "border-t border-border/60 pt-1 font-medium"
      )}
    >
      <span className={cn(strong ? "text-foreground" : "text-muted-foreground")}>{label}</span>
      <FlashValue value={value} className="font-mono tabular-nums">
        {format(value)}
      </FlashValue>
    </div>
  );
}

/**
 * Briefly tints its text when the value changes — the edit's effect made
 * visible. Skips the mount so opening the panel doesn't light everything up.
 */
function FlashValue({
  value,
  className,
  children,
}: {
  value: number;
  className?: string;
  children: React.ReactNode;
}) {
  const previous = useRef<number | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (previous.current !== null && previous.current !== value) {
      previous.current = value;
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), 700);
      return () => clearTimeout(timer);
    }
    previous.current = value;
  }, [value]);

  return (
    <span className={cn("transition-colors duration-500", flashing && "text-primary", className)}>
      {children}
    </span>
  );
}
