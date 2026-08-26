import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";
import { X } from "lucide-react";
import { useEffect } from "react";

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
 */
export function SelectionBar({
  count,
  noun,
  onClear,
  children,
}: {
  count: number;
  /** Singular noun for the selected rows — "activity", "phase". */
  noun: string;
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
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-1 rounded-lg border bg-background/95 py-1 pr-1 pl-3 shadow-lg backdrop-blur",
          "animate-in fade-in slide-in-from-bottom-2 duration-150"
        )}
      >
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{count}</span>{" "}
          {count === 1 ? noun : `${noun}s`} selected
        </span>
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
