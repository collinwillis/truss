import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";
import { X } from "lucide-react";
import { useEffect } from "react";
import { currencyCentsFmt, currencyFmt } from "./grid-figures";
import { hoursDecimalsFor } from "./totals-inspector/derive";

/**
 * Floating contextual action bar for grid selections.
 *
 * WHY IT FLOATS RATHER THAN LIVING IN THE TOOLBAR: selection actions are
 * transient, so putting them in persistent chrome made the toolbar mutate —
 * "Delete N" appeared mid-cluster and shoved Add and the totals chip
 * sideways, moving targets out from under the cursor mid-task. Worse, a
 * destructive action sat permanently one click from the Add button.
 *
 * The desktop convention (Linear, Notion, Figma, Gmail) is this bar: it
 * rises over the content, next to the rows it acts on, while the toolbar
 * stays perfectly still. Escape clears the selection — the same key that
 * dismisses every other transient surface in the app.
 *
 * IT ALSO SAYS WHAT THE SELECTION ADDS UP TO. These estimators came from
 * Excel, where ticking cells puts their sum in the status bar, and they reach
 * for that without thinking. The totals panel shows the same sum with more
 * detail, but the panel can be closed and this bar cannot: it is on screen
 * exactly when there is a selection to total.
 *
 * The sum is DROPPED WHOLE when the column is too narrow for it, never
 * truncated: half a dollar figure is worse than none. That only happens in a
 * narrow window with the totals panel open, which is exactly when the panel's
 * own "Selected" block is showing the same number. The threshold is a container
 * query in rem, so the Windows zoom shortcut is covered.
 */
export function SelectionBar({
  count,
  noun,
  detail,
  onClear,
  children,
}: {
  count: number;
  /** Singular noun for the selected rows — "activity", "phase". */
  noun: string;
  /** What the selected rows add up to — see {@link selectionSummary}. */
  detail?: string | null;
  onClear: () => void;
  /** Actions, ordered least to most destructive. */
  children: React.ReactNode;
}) {
  const active = count > 0;

  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Leave Escape to whatever is on top — a dialog, an open menu, a
      // cell edit. Radix flips data-state to "closed" on the way out, so a
      // second Escape still reaches the selection.
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable ||
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]'
        ) !== null
      ) {
        return;
      }
      onClear();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, onClear]);

  if (!active) return null;

  return (
    <div className="pointer-events-none @container absolute inset-x-0 bottom-4 z-20 flex justify-center px-3">
      <div
        className={cn(
          "pointer-events-auto flex max-w-full items-center gap-1 rounded-lg border bg-background/95 py-1 pr-1 pl-3 shadow-lg backdrop-blur",
          "animate-in fade-in slide-in-from-bottom-2 duration-150"
        )}
      >
        <span className="min-w-0 truncate text-xs whitespace-nowrap text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{count}</span>{" "}
          {count === 1 ? noun : pluralOf(noun)} selected
        </span>
        {detail && (
          <span className="ml-2 hidden font-mono text-xs whitespace-nowrap tabular-nums text-foreground @2xl:inline">
            {detail}
          </span>
        )}
        <div className="mx-1.5 h-4 w-px bg-border" />
        {children}
        <div className="mx-1.5 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon-lg"
          onClick={onClear}
          title="Clear selection — Esc"
          aria-label="Clear selection"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * "$12,480 · 86 MH" — a selection's total, printed the way the totals panel
 * beside it prints the same sum.
 *
 * @param cents the phase sheet prints cents because prices are typed there; the
 *   rollups round. See `grid-figures`.
 * @param scopeHours the whole sheet's hours, which decide whether hours print
 *   whole or to the tenth. See `hoursDecimalsFor`.
 */
export function selectionSummary(
  totalCost: number,
  hours: number,
  cents: boolean,
  scopeHours: number
): string {
  const money = (cents ? currencyCentsFmt : currencyFmt).format(totalCost);
  if (hours === 0) return money;
  const decimals = hoursDecimalsFor(scopeHours);
  const hoursText = hours.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${money} · ${hoursText} MH`;
}

/** "phase" to "phases", "activity" to "activities". It said "2 activitys". */
function pluralOf(noun: string): string {
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}
