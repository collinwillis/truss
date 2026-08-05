import { useMutation, useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
import { Checkbox } from "@truss/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Progress } from "@truss/ui/components/progress";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  adjustableFields,
  POOL_ROW_NOUN,
  refusalText,
  spokenFieldLabel,
  type AdjustablePool,
  type CatalogRow,
  type CatalogRowId,
} from "./pool-model";

/**
 * Moving a percentage across rows the admin picked.
 *
 * ⚠️ THE SELECTION IS NEVER WIDENED, ON EITHER SIDE. This dialog sends the ids
 * of the rows that were ticked, and `startBulkAdjust` refuses to re-derive
 * "everything matching the filter" from them — a row added between the
 * confirmation and the apply must not be adjusted by a decision nobody made
 * about it. So the sentence in the confirmation is literally true: those
 * columns, that percentage, those rows.
 *
 * The run is watched rather than awaited. It walks 250 rows per batch on the
 * server and reports its own cursor, so the screen shows real progress and a
 * stall is visible instead of being indistinguishable from slowness.
 *
 * @module
 */

/** Refusals worth naming individually before the list stops being useful. */
const SKIPPED_SHOWN = 6;

/**
 * A selection turned into the ids the adjustment takes.
 *
 * `listCatalogRows` serves four tables through one union of id types, and
 * TypeScript cannot narrow that union by the `pool` string — the two are
 * related by which query ran, not by the type. The pool is the proof: these
 * rows were listed by `paginatePool` from that pool's own table. The server
 * re-proves it with `normalizeId` on every id and refuses the whole run if one
 * came from anywhere else, so nothing rests on this narrowing being right.
 */
function adjustableIds(ids: readonly CatalogRowId[]): Array<Id<"laborPool"> | Id<"equipmentPool">> {
  return ids as Array<Id<"laborPool"> | Id<"equipmentPool">>;
}

/** "the craft constant and the weld constant" — a list a person would say. */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function BulkAdjustDialog({
  open,
  bookId,
  bookName,
  pool,
  rows,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  bookId: Id<"rateBooks">;
  bookName: string;
  pool: AdjustablePool;
  /** Exactly the rows that are ticked, in the order they appear on screen. */
  rows: CatalogRow[];
  onOpenChange: (open: boolean) => void;
  onStarted: (runId: Id<"catalogBulkRuns">) => void;
}) {
  const startBulkAdjust = useMutation(api.catalog.startBulkAdjust);
  const specs = adjustableFields(pool);

  const [percent, setPercent] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPercent("");
    // Every rate by default: "+3% on equipment" means the item costs 3% more
    // by the hour, day, week and month, not by the hour alone.
    setFields(adjustableFields(pool).map((spec) => spec.field));
    setRefusal(null);
    setBusy(false);
  }, [open, pool]);

  if (!open) return null;

  const parsed = Number(percent.trim());
  const valid = percent.trim() !== "" && Number.isFinite(parsed) && parsed !== 0;
  const noun = POOL_ROW_NOUN[pool];
  const chosen = specs.filter((spec) => fields.includes(spec.field));
  const ready = valid && chosen.length > 0 && rows.length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await startBulkAdjust({
        bookId,
        pool,
        fields: chosen.map((spec) => spec.field),
        percent: parsed,
        rowIds: adjustableIds(rows.map((row) => row._id)),
      });
      onOpenChange(false);
      onStarted(result.runId);
    } catch (error) {
      setBusy(false);
      setRefusal(refusalText(error));
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onOpenChange(false)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Adjust by a percentage</DialogTitle>
          <DialogDescription>
            {rows.length.toLocaleString()} selected {rows.length === 1 ? noun.one : noun.many} in{" "}
            {bookName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-end gap-3">
            <div className="w-28 space-y-1.5">
              <Label htmlFor="adjust-percent">Percentage</Label>
              <Input
                id="adjust-percent"
                value={percent}
                inputMode="decimal"
                autoComplete="off"
                placeholder="3.5"
                className="text-right tabular-nums"
                onChange={(event) => setPercent(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void submit()}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <span className="text-body font-medium text-foreground">Columns</span>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {specs.map((spec) => (
                  <label key={spec.field} className="flex cursor-pointer items-center gap-1.5">
                    <Checkbox
                      checked={fields.includes(spec.field)}
                      onCheckedChange={(value) =>
                        setFields((prev) =>
                          value === true
                            ? [...prev, spec.field]
                            : prev.filter((field) => field !== spec.field)
                        )
                      }
                    />
                    <span className="text-body text-foreground">{spec.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* The whole change in one sentence, before anything is applied. */}
          <p className="rounded-lg border bg-background-subtle px-3 py-2 text-callout leading-relaxed text-foreground">
            {ready ? (
              <>
                <span className="font-medium tabular-nums">
                  {parsed > 0 ? "+" : ""}
                  {parsed}%
                </span>{" "}
                to the{" "}
                <span className="font-medium">
                  {joinLabels(chosen.map((spec) => spokenFieldLabel(pool, spec.field)))}
                </span>{" "}
                of <span className="font-medium tabular-nums">{rows.length.toLocaleString()}</span>{" "}
                {rows.length === 1 ? noun.one : noun.many} in {bookName}.
              </>
            ) : rows.length === 0 ? (
              "Nothing is selected. Tick the rows this applies to — the adjustment never picks them for you."
            ) : chosen.length === 0 ? (
              "Choose at least one column."
            ) : (
              "Type the percentage to see exactly what will change."
            )}
          </p>

          <ul className="space-y-1 text-footnote leading-relaxed text-muted-foreground">
            <li>
              Each value is moved once and rounded once, on the final figure — constants to four
              decimals, rates to the cent. A row already at zero stays at zero and is counted as
              unchanged.
            </li>
            <li>
              The draft is locked while this runs, so nothing else can write to it — including hand
              edits in the grid behind this dialog.
            </li>
            <li>
              Stopping it part-way keeps the rows that already changed. There is no undo; the way
              back is a second run at the opposite percentage.
            </li>
          </ul>

          {refusal !== null && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-footnote leading-relaxed text-foreground">
              {refusal}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready}>
            {busy ? "Starting…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an adjustment is doing, while it does it.
 *
 * Adopted by id rather than by React state alone, so closing the window and
 * coming back reconnects to a run in flight instead of leaving it invisible —
 * and so a run that stopped can be resumed from the cursor it reached.
 */
export function BulkAdjustProgress({
  runId,
  onClose,
}: {
  runId: Id<"catalogBulkRuns">;
  onClose: () => void;
}) {
  const run = useQuery(api.catalog.getBulkAdjustRun, { runId });
  const resume = useMutation(api.catalog.resumeBulkAdjust);
  const cancel = useMutation(api.catalog.cancelBulkAdjust);

  if (!run) return null;

  // The pool comes off the RUN, not off the screen: an adjustment started on
  // labor stays watchable after the admin switches the grid to phases, and its
  // columns are still named in that pool's words.
  const pool = run.pool;
  const noun = POOL_ROW_NOUN[pool];
  const running = run.state === "running";
  const percentDone =
    run.tally.selected === 0 ? 100 : Math.round((run.done / run.tally.selected) * 100);

  return (
    <Dialog open onOpenChange={(next) => !next && !running && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {run.percent > 0 ? "+" : ""}
            {run.percent}% to the{" "}
            {joinLabels(run.fields.map((field) => spokenFieldLabel(pool, field)))}
          </DialogTitle>
          <DialogDescription>
            {run.tally.selected.toLocaleString()} {run.tally.selected === 1 ? noun.one : noun.many}{" "}
            selected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Progress value={percentDone} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote tabular-nums text-muted-foreground">
            <span>{run.done.toLocaleString()} walked</span>
            <span className="text-foreground">{run.tally.adjusted.toLocaleString()} changed</span>
            {run.tally.unchanged > 0 && (
              <span>{run.tally.unchanged.toLocaleString()} unchanged</span>
            )}
            {run.tally.missing > 0 && (
              <span>{run.tally.missing.toLocaleString()} no longer in the book</span>
            )}
          </div>

          {run.state === "done" && (
            <p className="flex items-start gap-1.5 text-body text-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
              Finished. {run.tally.adjusted.toLocaleString()}{" "}
              {run.tally.adjusted === 1 ? "row" : "rows"} changed.
            </p>
          )}
          {run.state === "cancelled" && (
            <p className="text-body text-foreground">
              Stopped after {run.tally.adjusted.toLocaleString()}{" "}
              {run.tally.adjusted === 1 ? "row" : "rows"}. Those rows keep their new values — a
              percentage is not undone by declining to apply the rest of it.
            </p>
          )}
          {run.state === "failed" && (
            <p className="flex items-start gap-1.5 text-body leading-relaxed text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              {run.error ?? "The adjustment stopped."} Resuming picks up at row{" "}
              <span className="tabular-nums">{(run.done + 1).toLocaleString()}</span>, so no row is
              adjusted twice. Leaving it stopped keeps the{" "}
              <span className="tabular-nums">{run.tally.adjusted.toLocaleString()}</span> rows that
              already changed and gives the draft back.
            </p>
          )}

          {run.skipped.length > 0 && (
            <ul className="space-y-0.5 border-t pt-2 text-footnote text-muted-foreground">
              {run.skipped.slice(0, SKIPPED_SHOWN).map((skip) => (
                <li key={skip.poolId} className="tabular-nums">
                  Row {skip.poolId} — {skip.reason}
                </li>
              ))}
              {run.skipped.length > SKIPPED_SHOWN && (
                <li>and {(run.skipped.length - SKIPPED_SHOWN).toLocaleString()} more</li>
              )}
            </ul>
          )}
        </div>

        <DialogFooter>
          {running && (
            <Button
              variant="ghost"
              onClick={() => {
                void cancel({ runId })
                  .then(() => toast.success("Stopped"))
                  .catch((error: unknown) => toast.error(refusalText(error)));
              }}
            >
              Stop
            </Button>
          )}
          {/* ⚠️ A STOPPED RUN NEEDS A WAY TO BE SETTLED, NOT JUST DISMISSED.
              A half-applied adjustment is an outstanding condition — the screen
              keeps a banner up for it — and `failed` is a state only the two
              buttons below can leave. Without "Leave it stopped" the only exit
              is a resume that succeeds, so a run whose rows have since been
              published would haunt the draft for ever. */}
          {run.state === "failed" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  void cancel({ runId })
                    .then(() => {
                      toast.success("Left stopped — the rows already changed keep their values");
                      onClose();
                    })
                    .catch((error: unknown) => toast.error(refusalText(error)));
                }}
              >
                Leave it stopped
              </Button>
              <Button
                onClick={() => {
                  void resume({ runId })
                    .then(() => toast.success("Resuming"))
                    .catch((error: unknown) => toast.error(refusalText(error)));
                }}
              >
                Resume
              </Button>
            </>
          ) : (
            !running && (
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
