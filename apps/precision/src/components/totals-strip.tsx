import { cn } from "@truss/ui/lib/utils";

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

/** The cost fields the strip reads — matches the rollup queries' shape. */
export interface StripCosts {
  craftManHours: number;
  welderManHours: number;
  totalCost: number;
}

/**
 * In-context totals, replacing the old global bottom panel (Collin's IA
 * decision: the phase screen shows phase totals, the WBS screen WBS totals,
 * and the full breakdown lives on Overview). One quiet line, always in the
 * same place, never a drawer.
 */
export function TotalsStrip({
  scope,
  itemCount,
  itemNoun,
  costs,
  className,
}: {
  /** e.g. "WBS total", "Phase total". */
  scope: string;
  itemCount: number;
  /** e.g. "phases", "activities". */
  itemNoun: string;
  costs: StripCosts;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-center gap-4 px-2 text-xs text-muted-foreground",
        className
      )}
    >
      <span>
        {scope}{" "}
        <span className="font-mono font-medium tabular-nums text-foreground">
          {cfmt.format(costs.totalCost)}
        </span>
      </span>
      <span>
        MH{" "}
        <span className="font-mono tabular-nums">
          {mhfmt.format(costs.craftManHours + costs.welderManHours)}
        </span>
      </span>
      <span>
        Craft <span className="font-mono tabular-nums">{mhfmt.format(costs.craftManHours)}</span>
      </span>
      <span>
        Weld <span className="font-mono tabular-nums">{mhfmt.format(costs.welderManHours)}</span>
      </span>
      <span className="ml-auto text-foreground-subtle">
        {itemCount} {itemNoun}
      </span>
    </div>
  );
}
