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
 * ⚠️ ONE PANEL FOR ALL THREE SHEETS. The overview, the phase table and the
 * activity grid are the same report at three depths, and they carry the same
 * instrument: the estimate used to answer with a horizontal strip of four
 * figures while its two drill-downs answered with this panel, which was the
 * same information in two shapes inside one app. At the top depth the scope IS
 * the estimate ({@link TotalsInspectorProps.scopeIsEstimate}), so the second
 * section would restate the first — it gives way to the hour split and the
 * estimate's size instead.
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
      size="lg"
      className="px-2"
      title={open ? "Hide totals panel" : "Show totals panel"}
      onClick={onToggle}
    >
      {grandTotal !== undefined && (
        <span className="font-mono text-xs font-medium tabular-nums">
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
  wbsCount: number;
  phaseCount: number;
  activityCount: number;
}

/** @see TotalsInspector */
export interface TotalsInspectorProps {
  /** e.g. "70000 · AG PIPING", "12 — CARBON STEEL", or "Grand total". */
  scopeLabel: string;
  scopeCosts: ScopeCosts;
  /** The page's getProposalSummary subscription — it also feeds the chip. */
  summary: EstimateSummary | undefined;
  open: boolean;
  /**
   * The scope IS the whole estimate — the overview, where there is no wider
   * context to compare against because this is it.
   *
   * Two things change, and nothing else: the direct/indirect hour split appears
   * (it is a property of the ESTIMATE, since "indirect" is a fact about which
   * breakdown the hours sit in, and means nothing inside one phase), and the
   * Estimate section gives way to the estimate's size rather than printing the
   * same grand total a second time four inches lower.
   */
  scopeIsEstimate?: boolean;
}

export function TotalsInspector({
  scopeLabel,
  scopeCosts,
  summary,
  open,
  scopeIsEstimate = false,
}: TotalsInspectorProps) {
  if (!open) return null;

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-l bg-fill-quaternary/40">
      {/* ── Current scope ── */}
      <div className="border-b px-4 py-3">
        <p className="truncate text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
          {scopeLabel}
        </p>
        <FlashValue
          value={scopeCosts.totalCost}
          resetKey={scopeLabel}
          className="mt-1 block font-mono text-lg font-semibold tabular-nums"
        >
          {cfmt.format(scopeCosts.totalCost)}
        </FlashValue>
      </div>

      <div className="space-y-4 px-4 py-3">
        <RowGroup label="Man-hours">
          <Row
            label="Craft"
            value={scopeCosts.craftManHours}
            format={mhfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Weld"
            value={scopeCosts.welderManHours}
            format={mhfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Total"
            value={scopeCosts.craftManHours + scopeCosts.welderManHours}
            format={mhfmt.format}
            resetKey={scopeLabel}
            strong
          />
          {/* A SECOND PARTITION OF THE SAME TOTAL, which is why it follows the
              total rather than sitting beside craft and weld: those two split
              the hours by TRADE, these split them by whether the breakdown
              carrying them is direct or indirect work. Interleaving the two
              would read as four parts of one whole. */}
          {scopeIsEstimate && summary && (
            <>
              <Row label="Direct" value={summary.directHours} format={mhfmt.format} />
              <Row label="Indirect" value={summary.indirectHours} format={mhfmt.format} />
            </>
          )}
        </RowGroup>

        <RowGroup label="Costs">
          <Row
            label="Labor"
            value={scopeCosts.craftCost + scopeCosts.welderCost}
            format={cfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Material"
            value={scopeCosts.materialCost}
            format={cfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Equipment"
            value={scopeCosts.equipmentCost}
            format={cfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Subcontractor"
            value={scopeCosts.subcontractorCost}
            format={cfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Cost only"
            value={scopeCosts.costOnlyCost}
            format={cfmt.format}
            resetKey={scopeLabel}
          />
          <Row
            label="Total"
            value={scopeCosts.totalCost}
            format={cfmt.format}
            resetKey={scopeLabel}
            strong
          />
        </RowGroup>
      </div>

      {/* ── What the estimate is made of ──
          Only where the scope IS the estimate. The four figures the overview's
          old metric strip carried all survive the move — the grand total in the
          header, man-hours and total labor in the groups above, and the
          activity count here. */}
      {scopeIsEstimate && (
        <div className="border-t bg-fill-quaternary/60 px-4 py-3">
          <p className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
            Contents
          </p>
          {summary ? (
            <div className="mt-2 space-y-1">
              <Row label="Breakdowns" value={summary.wbsCount} format={String} />
              <Row label="Phases" value={summary.phaseCount} format={String} />
              <Row label="Activities" value={summary.activityCount} format={String} />
            </div>
          ) : (
            <p className="mt-1 font-mono text-lg text-foreground-subtle">…</p>
          )}
        </div>
      )}

      {/* ── Whole estimate ──
          The scope's numbers, then the bid's: one edit visibly moves both. */}
      {!scopeIsEstimate && (
        <div className="border-t bg-fill-quaternary/60 px-4 py-3">
          <p className="text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
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
      )}
    </aside>
  );
}

function RowGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-footnote font-semibold uppercase tracking-wider text-muted-foreground">
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
  resetKey,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  strong?: boolean;
  resetKey?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between text-xs",
        strong && "border-t border-border/60 pt-1 font-medium"
      )}
    >
      <span className={cn(strong ? "text-foreground" : "text-muted-foreground")}>{label}</span>
      <FlashValue value={value} resetKey={resetKey} className="font-mono tabular-nums">
        {format(value)}
      </FlashValue>
    </div>
  );
}

/**
 * Tints its text when the value changes — the edit's effect made visible.
 *
 * MOTION IS ASYMMETRIC: the tint lands instantly (the change just happened)
 * and decays fast — a slow symmetric fade reads as lag, not feedback.
 *
 * `resetKey` is the semantic guard: when the CONTEXT changes (navigating to
 * another phase swaps every scope value), the new numbers settle silently.
 * The flash means "your edit moved this number", never "you moved".
 */
function FlashValue({
  value,
  resetKey,
  className,
  children,
}: {
  value: number;
  /** Identity of the thing being summarized; a change settles silently. */
  resetKey?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const previous = useRef<number | null>(null);
  const lastReset = useRef(resetKey);
  const [phase, setPhase] = useState<"idle" | "peak" | "decay">("idle");

  useEffect(() => {
    if (lastReset.current !== resetKey) {
      // Context switch — adopt the new value without ceremony.
      lastReset.current = resetKey;
      previous.current = value;
      return;
    }
    if (previous.current !== null && previous.current !== value) {
      previous.current = value;
      setPhase("peak");
      const decay = setTimeout(() => setPhase("decay"), 120);
      const settle = setTimeout(() => setPhase("idle"), 480);
      return () => {
        clearTimeout(decay);
        clearTimeout(settle);
      };
    }
    previous.current = value;
  }, [value, resetKey]);

  return (
    <span
      className={cn(
        phase === "peak" && "text-primary transition-none",
        phase === "decay" && "transition-colors duration-300 ease-out",
        className
      )}
    >
      {children}
    </span>
  );
}
