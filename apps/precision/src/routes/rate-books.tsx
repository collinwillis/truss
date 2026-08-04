import { createFileRoute } from "@tanstack/react-router";
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
import { BookOpen, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/rate-books")({
  component: RateBooksPage,
});

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
  const createDraft = useMutation(api.rateBooks.createDraft);
  const publishBook = useMutation(api.rateBooks.publishBook);
  const setDefaultBook = useMutation(api.rateBooks.setDefaultBook);
  const archiveBook = useMutation(api.rateBooks.archiveBook);
  const discardDraft = useMutation(api.rateBooks.discardDraft);
  const retryBuild = useMutation(api.rateBooks.retryDraftBuild);

  const [cloneFrom, setCloneFrom] = useState<{ id: Id<"rateBooks">; name: string } | null>(null);
  const [publishing, setPublishing] = useState<{ id: Id<"rateBooks">; name: string } | null>(null);

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

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="lg" aria-label={`Actions for ${book.name}`}>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {book.status === "draft" && (
                    <>
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

      <CloneDialog
        source={cloneFrom}
        onOpenChange={(open) => !open && setCloneFrom(null)}
        onConfirm={async (name) => {
          if (!cloneFrom) return;
          await createDraft({ parentBookId: cloneFrom.id, name });
        }}
      />
      <PublishDialog
        book={publishing}
        onOpenChange={(open) => !open && setPublishing(null)}
        onConfirm={async (confirmName, notes) => {
          if (!publishing) return;
          await publishBook({ bookId: publishing.id, confirmName, notes });
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

function CloneDialog({
  source,
  onOpenChange,
  onConfirm,
}: {
  source: { id: Id<"rateBooks">; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!source) return;
    // A year is how often this happens, so the year is the obvious name.
    setName(`${new Date().getFullYear()} Rate Book`);
    setBusy(false);
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, [source]);

  if (!source) return null;

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onConfirm(name.trim());
      toast.success("Draft created — copying the catalog now");
      onOpenChange(false);
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "Could not create the draft");
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>New draft rate book</DialogTitle>
          <DialogDescription>
            Copies every constant from {source.name} into a draft you can edit. Nothing changes for
            estimates already priced from {source.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="book-name">Name</Label>
          <Input
            id="book-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  onConfirm: (confirmName: string, notes: string) => Promise<void>;
}) {
  const [confirmName, setConfirmName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!book) return;
    setConfirmName("");
    setNotes("");
    setBusy(false);
  }, [book]);

  if (!book) return null;

  const ready = confirmName.trim() === book.name && notes.trim().length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await onConfirm(confirmName.trim(), notes.trim());
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
