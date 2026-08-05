import { useMutation } from "convex/react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CATALOG_UI_FIELDS,
  PARENT_POOL,
  POOL_LABEL,
  POOL_ROW_NOUN,
  refusalText,
  type PoolKind,
} from "./pool-model";
import { PhaseOptions, type ScopeIndex } from "./scope-picker";

/**
 * Adding one row to a draft.
 *
 * ⚠️ NOTHING IS DEFAULTED TO ZERO. A blank constant is sent as ABSENT, and the
 * server refuses it with "type 0 if the value really is zero" — because a
 * number quietly defaulted to zero prices real work at nothing, and a form
 * that pre-fills zeros makes that the path of least resistance. `sortOrder` is
 * the one field a blank is an answer to: left out, the server places the row
 * at the end of its group, which is the rule the importer already follows.
 *
 * Validation is the server's. This dialog collects, sends, and shows the
 * refusal in full — `checkNewRow` returns every problem at once, so the admin
 * fixes them in one pass instead of one round trip each.
 *
 * @module
 */

/** Values as the form holds them, before the server reads them. */
type Draft = { text: Record<string, string>; flags: Record<string, boolean> };

function emptyDraft(pool: PoolKind): Draft {
  const text: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  for (const spec of CATALOG_UI_FIELDS[pool]) {
    if (spec.kind === "flag") flags[spec.field] = false;
    else text[spec.field] = "";
  }
  return { text, flags };
}

export function AddRowDialog({
  open,
  bookId,
  bookName,
  pool,
  scopes,
  defaultParentPoolId,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  bookId: Id<"rateBooks">;
  bookName: string;
  pool: PoolKind;
  scopes: ScopeIndex;
  /** The scope currently on screen, so the common case needs no choice. */
  defaultParentPoolId: number | null;
  onOpenChange: (open: boolean) => void;
  /** The new row's catalog id, so the caller can go and look at it. */
  onAdded: (poolId: number) => void;
}) {
  const addCatalogRow = useMutation(api.catalog.addCatalogRow);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(pool));
  const [parent, setParent] = useState<number | null>(defaultParentPoolId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft(pool));
    setParent(defaultParentPoolId);
    setRefusal(null);
    setBusy(false);
  }, [open, pool, defaultParentPoolId]);

  const parentPool = PARENT_POOL[pool];
  // A row filed under nothing would be unreachable from every screen and
  // would still be cloned forward for ever, so the parent is asked for here
  // rather than refused by the server after the click.
  const ready = !busy && (parentPool === null || parent !== null);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setRefusal(null);

    const values: Record<string, string | number | boolean> = {};
    for (const spec of CATALOG_UI_FIELDS[pool]) {
      if (spec.kind === "flag") {
        values[spec.field] = draft.flags[spec.field] === true;
        continue;
      }
      const raw = (draft.text[spec.field] ?? "").trim();
      if (spec.kind === "number") {
        // Absent rather than zero — see the module note.
        if (raw === "") continue;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          setBusy(false);
          setRefusal(`"${raw}" could not be read as a number.`);
          return;
        }
        values[spec.field] = parsed;
        continue;
      }
      values[spec.field] = raw;
    }

    try {
      const result = await addCatalogRow({
        bookId,
        pool,
        parentPoolId: parent ?? undefined,
        values,
      });
      toast.success(`Added row ${result.poolId}`);
      onOpenChange(false);
      onAdded(result.poolId);
    } catch (error) {
      setBusy(false);
      setRefusal(refusalText(error));
    }
  };

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onOpenChange(false)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New {POOL_ROW_NOUN[pool].one}</DialogTitle>
          <DialogDescription>
            Added to {bookName}. The catalog id is minted by the server, exactly as an imported row
            gets one — it is never chosen here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {parentPool !== null && (
            <div className="space-y-1.5">
              <Label htmlFor="add-parent">{POOL_LABEL[parentPool]}</Label>
              <Select
                value={parent === null ? "" : String(parent)}
                onValueChange={(value) => setParent(Number(value))}
              >
                <SelectTrigger id="add-parent" size="lg" className="w-full">
                  <SelectValue
                    placeholder={`Choose a ${parentPool === "wbs" ? "work breakdown" : "phase"}`}
                  />
                </SelectTrigger>
                <SelectContent className="max-h-[360px]">
                  {pool === "labor" ? (
                    <PhaseOptions scopes={scopes} />
                  ) : (
                    scopes.wbs.map((row) => (
                      <SelectItem key={row.poolId} value={String(row.poolId)} className="uppercase">
                        {row.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {CATALOG_UI_FIELDS[pool].map((spec) => {
              const wide = spec.kind === "text" && spec.size >= 240;
              if (spec.kind === "flag") {
                return (
                  <label
                    key={spec.field}
                    className="flex cursor-pointer items-center gap-2 self-end pb-1"
                  >
                    <Checkbox
                      checked={draft.flags[spec.field] === true}
                      onCheckedChange={(value) =>
                        setDraft((prev) => ({
                          ...prev,
                          flags: { ...prev.flags, [spec.field]: value === true },
                        }))
                      }
                    />
                    <span className="text-body text-foreground">{spec.label}</span>
                  </label>
                );
              }
              return (
                <div key={spec.field} className={wide ? "col-span-2 space-y-1.5" : "space-y-1.5"}>
                  <Label htmlFor={`add-${spec.field}`}>{spec.label}</Label>
                  <Input
                    id={`add-${spec.field}`}
                    value={draft.text[spec.field] ?? ""}
                    inputMode={spec.kind === "number" ? "decimal" : "text"}
                    autoComplete="off"
                    placeholder={spec.field === "sortOrder" ? "end of the group" : undefined}
                    className={spec.kind === "number" ? "text-right tabular-nums" : "uppercase"}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        text: { ...prev.text, [spec.field]: event.target.value },
                      }))
                    }
                    onKeyDown={(event) => event.key === "Enter" && void submit()}
                  />
                </div>
              );
            })}
          </div>

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
            {busy ? "Adding…" : "Add row"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
