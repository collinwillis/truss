import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { cn } from "@truss/ui/lib/utils";
import { CloneBookDialog, type CloneSource } from "../components/rate-books/clone-book-dialog";
import { ImportSheetDialog, type ImportTarget } from "../components/rate-books/import-sheet-dialog";
import { BookOpen, Download, MoreHorizontal, Plus, Table2, Upload } from "lucide-react";
import { useConvex } from "convex/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/rate-books")({
  component: RateBooksPage,
});

type PoolKind = "wbs" | "phases" | "labor" | "equipment";

/** Their words for each pool, not the table names. */
const POOL_LABEL: Record<PoolKind, string> = {
  labor: "labor constants",
  equipment: "equipment rates",
  phases: "phases",
  wbs: "work breakdown",
};

/**
 * Rate books — the estimating catalog, versioned.
 *
 * A book is the whole catalog at a point in time: work breakdowns, phases,
 * labor constants and equipment rates. Published books are frozen, because
 * 736 estimates are priced from them; changing one is done by taking a copy,
 * editing that, and publishing it as a new book.
 *
 * Admin-only, and the server says so too — every mutation behind this screen
 * asserts `requirePrecisionAdmin` rather than trusting the route.
 */
function RateBooksPage() {
  const { workspace } = useWorkspace();
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";

  const books = useQuery(api.rateBooks.listRateBooks, isAdmin ? {} : "skip");
  const publishBook = useMutation(api.rateBooks.publishBook);
  const setDefaultBook = useMutation(api.rateBooks.setDefaultBook);
  const archiveBook = useMutation(api.rateBooks.archiveBook);
  const discardDraft = useMutation(api.rateBooks.discardDraft);
  const retryBuild = useMutation(api.rateBooks.retryDraftBuild);

  const convex = useConvex();
  const [cloneFrom, setCloneFrom] = useState<CloneSource | null>(null);
  const [publishing, setPublishing] = useState<{ id: Id<"rateBooks">; name: string } | null>(null);
  const [importing, setImporting] = useState<ImportTarget | null>(null);

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-body font-medium text-foreground">Administrator access required</p>
        <p className="max-w-[320px] text-body text-muted-foreground">
          Rate books set the constants every estimate is priced from, so only administrators can
          manage them.
        </p>
      </div>
    );
  }

  const openDraft = books?.find((b) => b.status === "draft");

  /**
   * Hand the admin a file they can open in Excel.
   *
   * Fetched on demand rather than subscribed: a 5,897-row catalog is ~700KB,
   * and nobody needs it streaming into the books list.
   */
  const download = async (bookId: Id<"rateBooks">, pool: PoolKind) => {
    try {
      const result = await convex.query(api.rateBooks.exportPoolCsv, { bookId, pool });
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${result.rowCount.toLocaleString()} rows`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export");
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── Command row ── */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-callout font-medium">Rate books</span>
        <span className="text-footnote text-foreground-subtle">
          The catalog every estimate is priced from
        </span>
        <div className="flex-1" />
        {/* One draft at a time — see createDraft. The button explains itself
            rather than failing after the click. */}
        <Button
          variant="outline"
          size="lg"
          disabled={openDraft !== undefined || !books?.length}
          title={
            openDraft
              ? `"${openDraft.name}" is already open as a draft. Publish or discard it first.`
              : "Copy the current book into a new draft"
          }
          onClick={() => {
            const current = books?.find((b) => b.isDefault) ?? books?.[0];
            if (current) setCloneFrom({ id: current._id, name: current.name });
          }}
        >
          <Plus className="h-3 w-3" /> New draft
        </Button>
      </div>

      {/* ── The books ── */}
      <div className="min-h-0 flex-1 overflow-auto">
        {books === undefined ? (
          <div className="space-y-px p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-14 rounded bg-fill-quaternary" />
            ))}
          </div>
        ) : books.length === 0 ? (
          <div className="px-4 py-16 text-center text-body text-muted-foreground">
            No rate books yet.
          </div>
        ) : (
          books.map((book, i) => (
            <div
              key={book._id}
              className={cn(
                "flex items-center gap-3 border-b px-3 py-2.5",
                i % 2 !== 0 && "bg-background-subtle"
              )}
            >
              <BookOpen className="h-4 w-4 shrink-0 text-foreground-subtle" />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-callout font-medium text-foreground">
                    {book.name}
                  </span>
                  <StatusBadge status={book.status} isDefault={book.isDefault} />
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-footnote text-muted-foreground">
                  <span className="tabular-nums">Book {book.bookNumber}</span>
                  {book.rowCounts && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {book.rowCounts.labor.toLocaleString()} labor, {book.rowCounts.equipment}{" "}
                        equipment, {book.rowCounts.phases} phases
                      </span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  {/* The number that makes "published is frozen" concrete. */}
                  <span className="tabular-nums">
                    {book.proposalCount.toLocaleString()}{" "}
                    {book.proposalCount === 1 ? "estimate" : "estimates"}
                  </span>
                </div>
              </div>

              {/* The way IN to the catalog itself. Exporting a sheet was the
                  only way to see what a draft had become; this is the screen
                  that shows it, per book rather than per published default. */}
              <Button variant="outline" size="lg" asChild>
                <Link to="/catalog" search={{ book: book._id, pool: "labor" }}>
                  <Table2 className="h-3 w-3" />
                  Browse catalog
                </Link>
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="lg" aria-label={`Actions for ${book.name}`}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {(["labor", "equipment", "phases", "wbs"] as const).map((pool) => (
                    <DropdownMenuItem
                      key={pool}
                      onClick={() => void download(book._id, pool)}
                      className="gap-2"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export {POOL_LABEL[pool]}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {book.status === "draft" && (
                    <>
                      {/* Editing happens in Excel and comes back through here. */}
                      <DropdownMenuItem
                        disabled={book.buildState !== "ready"}
                        className="gap-2"
                        onClick={() => setImporting({ bookId: book._id, bookName: book.name })}
                      >
                        <Upload className="h-3.5 w-3.5" />
                        Import a sheet…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={book.buildState !== "ready"}
                        onClick={() => setPublishing({ id: book._id, name: book.name })}
                      >
                        Publish…
                      </DropdownMenuItem>
                      {book.buildState === "failed" && (
                        <DropdownMenuItem
                          onClick={() =>
                            void retryBuild({ bookId: book._id })
                              .then(() => toast.success("Resuming"))
                              .catch((e: Error) => toast.error(e.message))
                          }
                        >
                          Resume copying
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() =>
                          void discardDraft({ bookId: book._id })
                            .then(() => toast.success("Draft discarded"))
                            .catch((e: Error) => toast.error(e.message))
                        }
                      >
                        Discard draft
                      </DropdownMenuItem>
                    </>
                  )}
                  {book.status === "published" && (
                    <>
                      <DropdownMenuItem
                        disabled={openDraft !== undefined}
                        onClick={() => setCloneFrom({ id: book._id, name: book.name })}
                      >
                        Duplicate as draft…
                      </DropdownMenuItem>
                      {!book.isDefault && (
                        <>
                          <DropdownMenuItem
                            onClick={() =>
                              void setDefaultBook({ bookId: book._id })
                                .then(() => toast.success(`New estimates now use ${book.name}`))
                                .catch((e: Error) => toast.error(e.message))
                            }
                          >
                            Use for new estimates
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() =>
                              void archiveBook({ bookId: book._id })
                                .then(() => toast.success("Archived"))
                                .catch((e: Error) => toast.error(e.message))
                            }
                          >
                            Archive
                          </DropdownMenuItem>
                        </>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>

      <CloneBookDialog source={cloneFrom} onOpenChange={(open) => !open && setCloneFrom(null)} />
      <ImportSheetDialog target={importing} onOpenChange={(open) => !open && setImporting(null)} />
      <PublishDialog
        book={publishing}
        onOpenChange={(open) => !open && setPublishing(null)}
        onConfirm={async (typedName, typedNotes, expectedContentRevision) => {
          if (!publishing) return;
          await publishBook({
            bookId: publishing.id,
            typedName,
            typedNotes,
            expectedContentRevision,
          });
        }}
      />
    </div>
  );
}

function StatusBadge({ status, isDefault }: { status: string; isDefault: boolean }) {
  if (isDefault) {
    return (
      <span className="rounded-full bg-green-500/10 px-1.5 py-px text-[10px] font-medium uppercase text-green-600 dark:text-green-400">
        In use
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[10px] font-medium uppercase",
        status === "draft"
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "bg-fill-secondary text-muted-foreground"
      )}
    >
      {status}
    </span>
  );
}

/**
 * Publishing is one-way, so the dialog says so and asks for the name back.
 *
 * The typed confirmation is not ceremony: after this there is no unpublish and
 * no edit — a mistake costs a whole new book.
 */
function PublishDialog({
  book,
  onOpenChange,
  onConfirm,
}: {
  book: { id: Id<"rateBooks">; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    typedName: string,
    typedNotes: string,
    expectedContentRevision: number
  ) => Promise<void>;
}) {
  const [confirmName, setConfirmName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // The gates are evaluated server-side against what is typed, so the dialog
  // shows the same verdict publishBook will reach rather than its own guess.
  // `contentRevision` comes back so it can be handed straight to publishBook:
  // it is the token that fails the publish if the draft moved while this was
  // open, which is the one thing a typed-name confirmation cannot catch.
  const readiness = useQuery(
    api.rateBooks.getPublishReadiness,
    book ? { bookId: book.id, typedName: confirmName, typedNotes: notes } : "skip"
  );

  useEffect(() => {
    if (!book) return;
    setConfirmName("");
    setNotes("");
    setBusy(false);
  }, [book]);

  if (!book) return null;

  const ready = readiness?.canPublish === true && !busy;

  const submit = async () => {
    if (!ready || !readiness) return;
    setBusy(true);
    try {
      await onConfirm(confirmName.trim(), notes.trim(), readiness.contentRevision);
      toast.success(`${book.name} published — new estimates will use it`);
      onOpenChange(false);
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "Could not publish");
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Publish {book.name}</DialogTitle>
          <DialogDescription>
            Publishing freezes this book permanently and makes it the one new estimates are priced
            from. It cannot be edited or unpublished afterwards — changing it later means
            duplicating it into another draft.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* A disabled button that will not say why is the failure this whole
              gate system exists to replace. Every blocker is named, in the
              server's words, so the admin reads the same verdict publishBook
              will reach. */}
          {readiness && readiness.blocking.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-footnote font-medium text-foreground">
                {readiness.blocking.length === 1
                  ? "One thing is in the way"
                  : `${readiness.blocking.length} things are in the way`}
              </p>
              <ul className="mt-1.5 space-y-1">
                {readiness.blocking.map((gate) => (
                  <li key={gate.id} className="text-footnote text-muted-foreground">
                    <span className="text-foreground">{gate.name}</span>
                    {gate.message ? ` — ${gate.message}` : ""}
                  </li>
                ))}
              </ul>
              {readiness.outstandingAcknowledgements.length > 0 && (
                <p className="mt-2 text-footnote text-muted-foreground">
                  {readiness.outstandingAcknowledgements.length} judgement{" "}
                  {readiness.outstandingAcknowledgements.length === 1 ? "call needs" : "calls need"}{" "}
                  a name against{" "}
                  {readiness.outstandingAcknowledgements.length === 1 ? "it" : "them"}
                  {readiness.retirements.beyondCap > 0 &&
                    `, and ${readiness.retirements.beyondCap.toLocaleString()} more are not listed here`}
                  .
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="publish-notes">What changed?</Label>
            <Input
              id="publish-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="2026 labor escalation, new tube-testing equipment"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-confirm">
              Type <span className="font-medium text-foreground">{book.name}</span> to confirm
            </Label>
            <Input
              id="publish-confirm"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready}>
            {busy ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
