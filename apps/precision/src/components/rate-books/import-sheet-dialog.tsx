import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { cn } from "@truss/ui/lib/utils";
import { AlertTriangle, ArrowRight, Check, FileSpreadsheet, Loader2 } from "lucide-react";
import { Checkbox } from "@truss/ui/components/checkbox";
import { useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Reviewing a sheet before it touches the catalog.
 *
 * The admin has one question — "is it safe to apply this?" — so the screen
 * answers it in the first line and spends the rest of its space on evidence.
 * Two things it must never let them assume:
 *
 *  - A row missing from the file is NOT a deletion. A file covering 12 phases
 *    out of 228 is a normal way to work, and the other 216 are untouched.
 *  - A blocked row is not a failure of the upload. It is the importer refusing
 *    to guess which of two contradictory claims about an id is true.
 */

type PoolKind = "wbs" | "phases" | "labor" | "equipment";

const POOL_LABEL: Record<PoolKind, string> = {
  labor: "labor constants",
  equipment: "equipment rates",
  phases: "phases",
  wbs: "work breakdown",
};

/** Their words for each stored field. */
const FIELD_LABEL: Record<string, string> = {
  name: "name",
  description: "description",
  sortOrder: "sort order",
  isActive: "active",
  craftConstant: "craft constant",
  craftUnits: "craft units",
  weldConstant: "weld constant",
  weldUnits: "weld units",
  countsTowardTakeoff: "counts toward takeoff",
  phasePoolId: "phase",
  wbsPoolId: "work breakdown",
  takeoffUnit: "takeoff unit",
  reservedPhaseNumber: "fixed phase number",
  hourRate: "hour rate",
  dayRate: "day rate",
  weekRate: "week rate",
  monthRate: "month rate",
};

type FieldValue = string | number | boolean;

function renderValue(value: FieldValue | undefined): string {
  if (value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number")
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value;
}

export interface ImportTarget {
  bookId: Id<"rateBooks">;
  bookName: string;
}

export function ImportSheetDialog({
  target,
  onOpenChange,
}: {
  target: ImportTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const generateUploadUrl = useMutation(api.rateBooks.generateImportUploadUrl);
  const stageImport = useAction(api.rateBooks.stageImport);
  const applyImport = useMutation(api.rateBooks.applyImport);
  const discardImport = useMutation(api.rateBooks.discardImport);

  const [importId, setImportId] = useState<Id<"rateBookImports"> | null>(null);
  const [reading, setReading] = useState(false);
  // Off by default and never remembered between files. Ignoring a file's ids
  // is a decision about THAT file.
  const [trustFileNames, setTrustFileNames] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useQuery(api.rateBooks.getImportPreview, importId ? { importId } : "skip");

  const close = () => {
    setImportId(null);
    setReading(false);
    setTrustFileNames(false);
    onOpenChange(false);
  };

  const upload = async (file: File) => {
    if (!target) return;
    setReading(true);
    try {
      const url = await generateUploadUrl();
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "text/csv" },
        body: file,
      });
      if (!response.ok) throw new Error("The upload did not complete. Try again.");
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const id = await stageImport({ bookId: target.bookId, fileName: file.name, storageId });
      setImportId(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that file");
    } finally {
      setReading(false);
    }
  };

  if (!target) return null;

  const applying = preview?.state === "applying";
  const applied = preview?.state === "applied";
  const willApply = preview
    ? preview.applicable + (trustFileNames ? preview.stats.idDisagrees : 0)
    : 0;

  return (
    <Dialog open onOpenChange={(open) => !open && !applying && close()}>
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 p-0 sm:max-w-[720px]">
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle>{preview ? "Review import" : "Import a sheet"}</DialogTitle>
          <DialogDescription>
            {preview ? (
              <span className="tabular-nums">
                {preview.fileName} → {target.bookName} · {POOL_LABEL[preview.pool as PoolKind]}
              </span>
            ) : (
              <>Into {target.bookName}. Nothing is applied until you have read what changed.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <ChooseFile
            reading={reading}
            onChoose={() => fileRef.current?.click()}
            inputRef={fileRef}
            onFile={(file) => void upload(file)}
          />
        ) : (
          <PreviewBody
            preview={preview}
            trustFileNames={trustFileNames}
            onTrustFileNames={setTrustFileNames}
          />
        )}

        <DialogFooter className="shrink-0 justify-between border-t px-5 py-3 sm:justify-between">
          {preview && !applied ? (
            <Button
              variant="ghost"
              size="lg"
              disabled={applying}
              onClick={() => {
                void discardImport({ importId: preview._id })
                  .then(close)
                  .catch((e: Error) => toast.error(e.message));
              }}
            >
              Discard
            </Button>
          ) : (
            <span />
          )}
          {applied ? (
            <Button size="lg" onClick={close}>
              Done
            </Button>
          ) : preview ? (
            <Button
              size="lg"
              disabled={applying || willApply === 0}
              onClick={() => {
                void applyImport({ importId: preview._id, trustFileNames }).catch((e: Error) =>
                  toast.error(e.message)
                );
              }}
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {applying
                ? "Applying…"
                : willApply === 0
                  ? "Nothing to apply"
                  : `Apply ${willApply.toLocaleString()} ${willApply === 1 ? "change" : "changes"}`}
            </Button>
          ) : (
            <Button variant="ghost" size="lg" onClick={close}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChooseFile({
  reading,
  onChoose,
  onFile,
  inputRef,
}: {
  reading: boolean;
  onChoose: () => void;
  onFile: (file: File) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="px-5 py-6">
      <button
        type="button"
        disabled={reading}
        onClick={onChoose}
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8",
          "text-center transition-colors hover:border-primary hover:bg-fill-quaternary",
          "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          reading && "pointer-events-none opacity-60"
        )}
      >
        {reading ? (
          <Loader2 className="h-5 w-5 animate-spin text-foreground-subtle" />
        ) : (
          <FileSpreadsheet className="h-5 w-5 text-foreground-subtle" />
        )}
        <span className="text-callout font-medium text-foreground">
          {reading ? "Reading the sheet…" : "Choose a file"}
        </span>
        <span className="text-footnote text-muted-foreground">
          {reading
            ? "Matching every row against the catalog. Nothing has been written."
            : "A sheet exported from a rate book, edited in Excel"}
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change.
          event.target.value = "";
          if (file) onFile(file);
        }}
      />

      <ul className="mt-5 space-y-1.5 text-footnote text-muted-foreground">
        <li>
          Save from Excel as <span className="text-foreground">CSV UTF-8 (Comma delimited)</span>,
          not plain CSV — plain CSV destroys the ≤ and ≥ in pipe sizes.
        </li>
        <li>
          Do not type in the <span className="text-foreground">id</span> column, sort it away from
          its row, or fill it down. To add a row, leave the id blank.
        </li>
        <li>
          A blank number on an existing row means{" "}
          <span className="text-foreground">leave it alone</span>. Type 0 for zero.
        </li>
        <li>Rows missing from the file are left exactly as they are. An import never deletes.</li>
      </ul>
    </div>
  );
}

type Preview = NonNullable<typeof api.rateBooks.getImportPreview._returnType>;

function PreviewBody({
  preview,
  trustFileNames,
  onTrustFileNames,
}: {
  preview: Preview;
  trustFileNames: boolean;
  onTrustFileNames: (value: boolean) => void;
}) {
  const { stats, coverage } = preview;
  const needsDecision = stats.conflict + stats.invalid;
  const decided = trustFileNames ? stats.idDisagrees : 0;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-5 py-4">
        {/* ── The answer, before the evidence ── */}
        <p className="text-title3 font-semibold tracking-tight text-foreground">
          {preview.applicable + decided === 0
            ? needsDecision > 0
              ? "Nothing here can be applied yet."
              : "This file changes nothing."
            : `${(preview.applicable + decided).toLocaleString()} ${preview.applicable + decided === 1 ? "row" : "rows"} will change.`}
        </p>
        {needsDecision - decided > 0 && (
          <p className="mt-1 text-body text-foreground">
            {(needsDecision - decided).toLocaleString()}{" "}
            {needsDecision - decided === 1 ? "row needs" : "rows need"} a decision first and{" "}
            {needsDecision - decided === 1 ? "is" : "are"} skipped.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote tabular-nums text-muted-foreground">
          <Tally count={stats.unchanged} label="unchanged" />
          <Tally count={stats.edited} label="edited" />
          <Tally count={stats.added} label="added" />
          <Tally count={stats.conflict} label="conflicting" tone="warn" />
          <Tally count={stats.invalid} label="invalid" tone="warn" />
        </div>

        <p className="mt-3 text-footnote text-muted-foreground">
          This file covers {coverage.inFile.toLocaleString()} of {coverage.inBook.toLocaleString()}{" "}
          {POOL_LABEL[preview.pool as PoolKind]} rows in the book. The rest are untouched — an
          import never deletes.
          {stats.blankNumericKept > 0 && (
            <>
              {" "}
              {stats.blankNumericKept.toLocaleString()} blank number{" "}
              {stats.blankNumericKept === 1 ? "cell was" : "cells were"} left as they are rather
              than set to zero.
            </>
          )}
        </p>

        {stats.idDisagrees > 0 && (
          <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <p className="text-callout font-medium text-foreground">
                  The id column does not line up with the catalog on{" "}
                  <span className="tabular-nums">{stats.idDisagrees.toLocaleString()}</span>{" "}
                  {stats.idDisagrees === 1 ? "row" : "rows"}.
                </p>
                <p className="mt-1 text-footnote text-muted-foreground">
                  This is what sorting or inserting rows in a spreadsheet does — the descriptions
                  stay put and the ids slide. The names still match the catalog exactly, so they can
                  be applied by name. Applying them by id would re-point ids that finished estimates
                  are priced from.
                </p>

                <label className="mt-2.5 flex cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={trustFileNames}
                    onCheckedChange={(value) => onTrustFileNames(value === true)}
                    className="mt-0.5"
                  />
                  <span className="text-footnote text-foreground">
                    Match these rows by name and ignore the file&rsquo;s id column
                  </span>
                </label>

                <ul className="mt-2.5 space-y-1 border-t border-amber-500/20 pt-2">
                  {preview.idDisagrees.slice(0, 6).map((row) => (
                    <li
                      key={row.rowNumber}
                      className="flex items-baseline gap-2 text-footnote tabular-nums"
                    >
                      <span className="shrink-0 text-caption2 text-foreground-subtle">
                        Row {row.rowNumber}
                      </span>
                      <span className="truncate uppercase text-foreground">{row.description}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        → id {row.targetPoolId}
                      </span>
                    </li>
                  ))}
                  {stats.idDisagrees > 6 && (
                    <li className="text-caption2 tabular-nums text-foreground-subtle">
                      and {(stats.idDisagrees - 6).toLocaleString()} more
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        {preview.ambiguous.length > 0 && (
          <Section
            title="Needs a decision"
            count={preview.ambiguousCount}
            shown={preview.ambiguous.length}
            tone="warn"
          >
            {preview.ambiguous.map((row) => (
              <BlockedRow key={`a-${row.rowNumber}`} row={row} />
            ))}
          </Section>
        )}

        {preview.unreadable.length > 0 && (
          <Section
            title="Could not be read"
            count={preview.unreadableCount}
            shown={preview.unreadable.length}
            tone="warn"
          >
            {preview.unreadable.map((row) => (
              <BlockedRow key={`u-${row.rowNumber}`} row={row} />
            ))}
          </Section>
        )}

        {preview.edited.length > 0 && (
          <Section title="Changing" count={stats.edited} shown={preview.edited.length}>
            {preview.edited.map((row) => (
              <li key={row.rowNumber} className="py-2">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-caption2 tabular-nums text-foreground-subtle">
                    Row {row.rowNumber}
                  </span>
                  <span className="truncate text-footnote font-medium uppercase text-foreground">
                    {row.description}
                  </span>
                </div>
                <div className="mt-0.5 space-y-0.5">
                  {Object.keys(row.values)
                    .filter((key) => row.before?.[key] !== row.values[key])
                    .map((key) => (
                      <div
                        key={key}
                        className="flex items-center gap-1.5 text-footnote text-muted-foreground"
                      >
                        <span>{FIELD_LABEL[key] ?? key}</span>
                        <span className="tabular-nums">{renderValue(row.before?.[key])}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <span className="tabular-nums text-foreground">
                          {renderValue(row.values[key])}
                        </span>
                      </div>
                    ))}
                </div>
              </li>
            ))}
          </Section>
        )}

        {preview.added.length > 0 && (
          <Section title="Adding" count={stats.added} shown={preview.added.length}>
            {preview.added.map((row) => (
              <li key={row.rowNumber} className="flex items-baseline gap-2 py-1.5">
                <span className="shrink-0 text-caption2 tabular-nums text-foreground-subtle">
                  Row {row.rowNumber}
                </span>
                <span className="truncate text-footnote font-medium uppercase text-foreground">
                  {row.description}
                </span>
                <span className="text-footnote text-muted-foreground">
                  gets a new id when applied
                </span>
              </li>
            ))}
          </Section>
        )}

        {preview.state === "applied" && (
          <p className="mt-5 flex items-center gap-1.5 text-body text-foreground">
            <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
            Applied.{" "}
            {needsDecision - decided > 0 &&
              "The rows above still need a decision — correct them in the file and upload it again."}
          </p>
        )}
        {preview.state === "failed" && preview.error && (
          <p className="mt-5 flex items-start gap-1.5 text-body text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            {preview.error}
          </p>
        )}
      </div>
    </ScrollArea>
  );
}

function BlockedRow({ row }: { row: Preview["ambiguous"][number] }) {
  return (
    <li className="py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-caption2 tabular-nums text-foreground-subtle">
          Row {row.rowNumber}
        </span>
        <span className="truncate text-footnote font-medium uppercase text-foreground">
          {row.description || "—"}
        </span>
      </div>
      <p className="mt-0.5 text-footnote text-muted-foreground">
        {row.errors[0] ?? row.reason ?? "Refused."}
      </p>
    </li>
  );
}

function Tally({ count, label, tone }: { count: number; label: string; tone?: "warn" }) {
  if (count === 0) return null;
  return (
    <span className={cn("flex items-center gap-1", tone === "warn" && "text-foreground")}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          tone === "warn" ? "bg-amber-500" : "bg-fill-secondary"
        )}
        aria-hidden="true"
      />
      {count.toLocaleString()} {label}
    </span>
  );
}

function Section({
  title,
  count,
  shown,
  tone,
  children,
}: {
  title: string;
  count: number;
  shown: number;
  tone?: "warn";
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline gap-2 border-b pb-1">
        <span
          className={cn(
            "text-caption1 font-semibold uppercase tracking-wide",
            tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground-subtle"
          )}
        >
          {title}
        </span>
        <span className="text-caption2 tabular-nums text-foreground-subtle">
          {count.toLocaleString()}
        </span>
        {shown < count && (
          <span className="ml-auto text-caption2 tabular-nums text-foreground-subtle">
            showing first {shown}
          </span>
        )}
      </div>
      <ul className="divide-y">{children}</ul>
    </div>
  );
}
