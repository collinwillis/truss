import { api } from "@truss/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
import { Checkbox } from "@truss/ui/components/checkbox";
import { Command, CommandInput } from "@truss/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Skeleton } from "@truss/ui/components/skeleton";
import { cn } from "@truss/ui/lib/utils";
import { ChevronLeft } from "lucide-react";
import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { PhaseCommandList, usePhaseOptions, type PhaseOption } from "./phase-picker";

const cfmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Pull activities from another phase into this one.
 *
 * WHY THIS IS THE PRIMARY DIRECTION: the need arises while you are sitting in
 * the phase you are building — "I did this before in 40001" — so the natural
 * gesture points at a whole phase from the destination, not at lines from the
 * source. That means NO SELECTION IS REQUIRED to start, which is the friction
 * the copy-only flow had.
 *
 * The review step exists because these lines carry money: you see exactly
 * what is coming and what it adds before it lands. Everything arrives
 * CHECKED — the common case is the whole phase, so refinement is optional and
 * `Enter, Enter` imports all of it (the Import button takes focus as soon as
 * the lines land, which is also what keeps a key-repeat from importing before
 * anything has been reviewed).
 */
export function ImportActivitiesDialog({
  open,
  onOpenChange,
  proposalId,
  currentPhaseId,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposalId: Id<"proposals">;
  currentPhaseId: string;
  /** Resolves false when the import was refused, so the review survives. */
  onImport: (source: PhaseOption, activityIds: string[]) => Promise<boolean>;
}) {
  const [source, setSource] = useState<PhaseOption | null>(null);
  /** Exclusions, not inclusions — so the default is "everything". */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLButtonElement>(null);

  // Cleared on the way IN, not out: Radix keeps this content mounted through
  // the exit animation, so resetting on close visibly rewinds the review step
  // to the phase list while it fades — Escape then reads as "went back" when
  // it actually discarded the work. A layout effect lands before paint.
  useLayoutEffect(() => {
    if (open) {
      setSource(null);
      setExcluded(new Set());
      setImporting(false);
    }
  }, [open]);

  // Deliberately NOT useStableQuery: its keep-previous-data layer returns the
  // last rows THIS instance rendered, which after a back-and-repick is the
  // PREVIOUS phase's lines — priced, counted and pre-checked under the new
  // phase's name. These rows carry money; a skeleton is the honest frame, and
  // nothing warms an arbitrary phase, so the stale layer buys nothing here.
  const activities = useQuery(
    api.precision.getActivitiesWithCosts,
    source ? { phaseId: source.phaseId as Id<"phases"> } : "skip"
  );
  const { groups, loaded } = usePhaseOptions(proposalId, currentPhaseId, open);

  const loading = source !== null && activities === undefined;
  const chosen = (activities ?? []).filter((a) => !excluded.has(a._id as string));
  const addedCost = chosen.reduce((sum, a) => sum + a.costs.totalCost, 0);

  // Picking a phase unmounts the search input that had focus, and Radix parks
  // focus on the dialog frame — where Enter does nothing. Waiting for the
  // lines matters: the button is disabled until they arrive, and focusing a
  // disabled button is a no-op.
  const linesReady = activities !== undefined && activities.length > 0;
  useEffect(() => {
    if (source && linesReady) importRef.current?.focus();
  }, [source, linesReady]);

  const handleImport = async () => {
    if (!source || chosen.length === 0 || importing) return;
    setImporting(true);
    try {
      // A refused import keeps the dialog open: the phase choice and every
      // uncheck are the estimator's work, and a red toast over a closed
      // dialog would make them redo all of it to retry.
      const done = await onImport(
        source,
        chosen.map((a) => a._id as string)
      );
      if (done) onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // An in-flight import cannot be aborted, and `importing` is the only
        // thing stopping a second one — dismissing would clear it. Escape,
        // the close button and click-outside all arrive here.
        if (!next && importing) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>Import activities from another phase</DialogTitle>
          <DialogDescription>
            Choose a phase, then confirm which of its activities to copy in.
          </DialogDescription>
        </DialogHeader>

        {source === null ? (
          <Command>
            <CommandInput placeholder="Import from phase… (number, description, or WBS)" />
            <PhaseCommandList
              groups={groups}
              loaded={loaded}
              emptyMessage="No other phases to import from."
              onPick={setSource}
            />
          </Command>
        ) : (
          <>
            {/* Source header — doubles as the way back to the list. */}
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <Button
                variant="ghost"
                size="icon-lg"
                disabled={importing}
                onClick={() => {
                  setSource(null);
                  setExcluded(new Set());
                }}
                aria-label="Choose a different phase"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{source.label}</p>
                <p className="text-footnote text-muted-foreground">Importing into this phase</p>
              </div>
            </div>

            {/* Lines, all checked. Scrolls; the footer stays put. */}
            <div className="max-h-[320px] min-h-[120px] overflow-y-auto">
              {loading ? (
                <div className="space-y-1.5 p-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              ) : (activities ?? []).length === 0 ? (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  That phase has no activities to import.
                </p>
              ) : (
                (activities ?? []).map((activity) => {
                  const id = activity._id as string;
                  const on = !excluded.has(id);
                  return (
                    <label
                      key={id}
                      className={cn(
                        "flex h-8 cursor-pointer items-center gap-2.5 px-3 text-xs transition-colors hover:bg-fill-quaternary",
                        !on && "opacity-45"
                      )}
                    >
                      <Checkbox
                        checked={on}
                        onCheckedChange={() =>
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                        className="h-3.5 w-3.5"
                      />
                      <span className="min-w-0 flex-1 truncate">{activity.description}</span>
                      <span className="text-footnote shrink-0 font-mono tabular-nums text-muted-foreground">
                        {activity.quantity} {activity.unit}
                      </span>
                      <span className="text-footnote w-16 shrink-0 text-right font-mono tabular-nums">
                        {cfmt.format(activity.costs.totalCost)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            {/* The cost this import adds is stated before it lands. */}
            <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5">
              <span className="text-xs text-muted-foreground">
                {loading ? (
                  // "Nothing selected" here would assert an emptiness nobody
                  // chose, and would read like a genuinely empty phase.
                  "Loading activities…"
                ) : chosen.length === 0 ? (
                  "Nothing selected"
                ) : (
                  <>
                    <span className="font-medium tabular-nums text-foreground">
                      {chosen.length}
                    </span>{" "}
                    of {(activities ?? []).length} · adds{" "}
                    <span className="font-mono tabular-nums text-foreground">
                      {cfmt.format(addedCost)}
                    </span>
                  </>
                )}
              </span>
              <Button
                ref={importRef}
                size="lg"
                disabled={chosen.length === 0 || importing}
                onClick={handleImport}
              >
                {importing ? "Importing…" : `Import ${chosen.length}`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
