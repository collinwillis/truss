import { Link } from "@tanstack/react-router";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { cn } from "@truss/ui/lib/utils";
import { Check, ChevronDown, Lock, PencilLine } from "lucide-react";

/**
 * Which book you are looking at, and whether it can be changed.
 *
 * Both questions are answered on the same line and neither is left to be
 * inferred: a screen that edits the constants 736 estimates are priced from
 * must not rely on the reader remembering what they clicked to get here.
 *
 * @module
 */

/** A book as the admin list serves it. */
export type BookListing = NonNullable<typeof api.rateBooks.listRateBooks._returnType>[number];

/** A book's catalog totals and whether it accepts writes. */
export type CatalogSummary = typeof api.catalog.getCatalogSummary._returnType;

/** Their words for the long-running operation currently holding a draft. */
const LOCK_LABEL: Record<string, string> = {
  clone: "the catalog is still being copied in",
  import: "a sheet is being imported",
  revert: "an import is being put back",
  publish: "the book is being published",
  discard: "the draft is being discarded",
  bulkEdit: "a percentage adjustment is running",
};

/** A book's status, and whether new estimates are priced from it. */
export function BookStatusBadge({ status, isDefault }: { status: string; isDefault: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(
          "rounded-full px-1.5 py-px text-caption2 font-medium uppercase",
          status === "draft"
            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : "bg-fill-secondary text-muted-foreground"
        )}
      >
        {status}
      </span>
      {isDefault && (
        <span className="rounded-full bg-green-500/10 px-1.5 py-px text-caption2 font-medium uppercase text-green-600 dark:text-green-400">
          In use
        </span>
      )}
    </span>
  );
}

/** One action offered alongside a read-only explanation. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export function BookBar({
  books,
  summary,
  onChooseBook,
}: {
  /** Every book, for an administrator; `null` for everyone else. */
  books: BookListing[] | null;
  summary: CatalogSummary | undefined;
  onChooseBook: (bookId: Id<"rateBooks">) => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <span className="shrink-0 text-callout font-medium">Catalog</span>

      {summary === undefined ? (
        <span className="h-4 w-40 rounded bg-fill-quaternary" aria-hidden="true" />
      ) : (
        <>
          {books === null ? (
            // No picker below administrator: `listRateBooks` keeps drafts away
            // from estimators, so there is exactly one book they may look at.
            <span className="truncate text-callout font-medium text-foreground">
              {summary.name}
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="lg" className="gap-1.5">
                  <span className="max-w-[240px] truncate">{summary.name}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel className="text-caption1 uppercase tracking-wide text-foreground-subtle">
                  Rate books
                </DropdownMenuLabel>
                {books.map((book) => (
                  <DropdownMenuItem
                    key={book._id}
                    className="gap-2"
                    onClick={() => onChooseBook(book._id)}
                  >
                    <Check
                      className={cn("h-3.5 w-3.5", book._id !== summary._id && "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{book.name}</span>
                    <BookStatusBadge status={book.status} isDefault={book.isDefault} />
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/rate-books">Manage rate books…</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <BookStatusBadge status={summary.status} isDefault={summary.isDefault} />
          <EditabilityChip summary={summary} />
          <span className="shrink-0 text-footnote tabular-nums text-foreground-subtle">
            Book {summary.bookNumber}
          </span>
        </>
      )}

      <div className="flex-1" />

      {books !== null && (
        <Button variant="ghost" size="lg" asChild>
          <Link to="/rate-books">Rate books</Link>
        </Button>
      )}
    </div>
  );
}

/**
 * Editable or not, said out loud rather than implied by a disabled input.
 *
 * `summary.editable` is the server's own answer — a draft, finished building,
 * with nothing long-running holding it — so the chip and the mutations cannot
 * come to disagree about the same book.
 */
function EditabilityChip({ summary }: { summary: CatalogSummary }) {
  if (summary.editable) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-caption2 font-medium uppercase text-primary">
        <PencilLine className="h-2.5 w-2.5" aria-hidden="true" />
        Editable
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-fill-secondary px-1.5 py-px text-caption2 font-medium uppercase text-muted-foreground">
      <Lock className="h-2.5 w-2.5" aria-hidden="true" />
      Read-only
    </span>
  );
}

/**
 * Why a book cannot be edited, and what to do instead.
 *
 * Rendered for ADMINISTRATORS only — see the call site. Every sentence here is
 * addressed to somebody who can duplicate the book and publish the copy, which
 * an estimator cannot; the Read-only chip is what tells them.
 *
 * ⚠️ THE REASONING IS `model/rateBookAccess.ts`'s, NOT AN INVENTION HERE. It
 * is tempting to think a published book is already safe because an activity
 * copies its constants at creation — and that is true of the MONEY and false
 * of everything else. `loadTakeoffCatalog` reads phase takeoff units and
 * `countsTowardTakeoff` LIVE, on every phase list and inside every export, and
 * `deriveNextPhaseNumber` reads `reservedPhaseNumber` live. One edit to a
 * published row therefore changes what finished estimates display and print,
 * with no write to any estimate and no trace anywhere. There is no safe
 * in-place edit, which is why the way forward is a duplicate rather than an
 * override somebody could be talked into.
 */
export function ImmutabilityNotice({
  summary,
  proposalCount,
  action,
}: {
  summary: CatalogSummary;
  /** Estimates priced from this book, where the caller can see the number. */
  proposalCount: number | null;
  /** Offered only where the caller can actually carry it out. */
  action: NoticeAction | null;
}) {
  if (summary.editable) return null;

  const frozen = summary.status !== "draft";
  const priced =
    proposalCount === null
      ? "finished estimates"
      : `${proposalCount.toLocaleString()} finished ${proposalCount === 1 ? "estimate" : "estimates"}`;

  return (
    <div className="flex shrink-0 items-start gap-2.5 border-b bg-background-subtle px-3 py-2">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-callout font-medium text-foreground">
          {frozen
            ? `This book is ${summary.status}. It is frozen on purpose, not locked by accident.`
            : summary.lockedBy !== null
              ? `This draft is busy — ${LOCK_LABEL[summary.lockedBy] ?? summary.lockedBy}.`
              : "This draft is still being copied from its parent book."}
        </p>
        <p className="mt-0.5 max-w-[92ch] text-footnote leading-relaxed text-muted-foreground">
          {frozen ? (
            <>
              Estimates copy their money when they are written, but takeoff units, “counts toward
              takeoff” and reserved phase numbers are read from this catalog{" "}
              <span className="text-foreground">live</span> — every time a phase list is drawn or an
              estimate is printed. Changing one row here would change what {priced} display, with no
              write to any estimate and no trace anywhere. To change these numbers, duplicate this
              book as a draft, edit the draft, and publish it.
            </>
          ) : (
            <>
              Editing opens again as soon as that finishes. Nothing here is stale — the rows below
              are the draft exactly as it stands.
            </>
          )}
        </p>
      </div>
      {action !== null && (
        <Button variant="outline" size="lg" className="shrink-0" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
