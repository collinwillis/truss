import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { RowSelectionState } from "@tanstack/react-table";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { cn } from "@truss/ui/lib/utils";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { AlertTriangle, Percent, Plus, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AddRowDialog } from "../components/catalog/add-row-dialog";
import {
  BookBar,
  ImmutabilityNotice,
  type BookListing,
  type NoticeAction,
} from "../components/catalog/book-bar";
import { BulkAdjustDialog, BulkAdjustProgress } from "../components/catalog/bulk-adjust-dialog";
import { CatalogGrid } from "../components/catalog/catalog-grid";
import {
  CATALOG_UI_FIELDS,
  PARENT_POOL,
  POOL_LABEL,
  POOL_ORDER,
  POOL_ROW_NOUN,
  isStaleRowRefusal,
  refusalText,
  spokenFieldLabel,
  type AdjustablePool,
  type CatalogRow,
  type PoolKind,
} from "../components/catalog/pool-model";
import { ScopePicker, useScopeIndex } from "../components/catalog/scope-picker";
import { CloneBookDialog, type CloneSource } from "../components/rate-books/clone-book-dialog";

/**
 * The rate-book catalog: looking at one, and changing one.
 *
 * WHAT THIS CLOSES. Every screen that could read the catalog read the
 * PUBLISHED DEFAULT and filtered `isActive: true`, so after importing 388
 * changes into a draft the only way to see the result was to export a
 * spreadsheet — and a row the draft RETIRED could not be seen from anywhere at
 * all. This screen reads `listCatalogRows`, which takes the book as an
 * argument and includes retired rows, and it replaces `/pools/labor` and
 * `/pools/equipment` rather than sitting beside them: two ways in, one of them
 * pointed at the wrong book, is how an admin comes to trust the wrong numbers.
 *
 * ⚠️ THE BOOK IS ALWAYS CHOSEN, NEVER ASSUMED. Which book, and whether it can
 * be edited, are stated in the top bar and repeated by every disabled control,
 * because this is where somebody changes the numbers that price
 * million-dollar bids.
 *
 * @module
 */

/**
 * What you are LOOKING AT lives in the URL — the same split the proposal log
 * uses. The search TEXT deliberately does not: syncing it per keystroke would
 * push one history entry per character.
 */
export interface CatalogSearch {
  /** The rate book. Absent means the one new estimates are priced from. */
  book?: string;
  pool?: PoolKind;
  /** Phase id for labor, work-breakdown id for phases. */
  scope?: number;
  status?: "active" | "retired";
}

function isPoolKind(value: unknown): value is PoolKind {
  return value === "wbs" || value === "phases" || value === "labor" || value === "equipment";
}

/** A search param that may arrive as a number or as the string in the URL. */
function asPoolId(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

export const Route = createFileRoute("/catalog")({
  validateSearch: (search: Record<string, unknown>): CatalogSearch => ({
    book: typeof search.book === "string" ? search.book : undefined,
    pool: isPoolKind(search.pool) ? search.pool : undefined,
    scope: asPoolId(search.scope),
    status: search.status === "active" || search.status === "retired" ? search.status : undefined,
  }),
  component: CatalogPage,
});

/**
 * Rows fetched before anything is on screen.
 *
 * Deliberately not the whole pool. 5,897 labor rows is 36% of Convex's
 * per-query document ceiling in one go and several thousand table rows in the
 * DOM; the listing is paginated on the server, so the screen asks for a
 * screenful and grows only when somebody says to.
 */
const FIRST_PAGE = 150;

/** Rows added per "Load more". */
const NEXT_PAGE = 250;

/** Idle time before a search term becomes a new subscription (ms). */
const SEARCH_DEBOUNCE_MS = 200;

function CatalogPage() {
  const { workspace } = useWorkspace();
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const search = Route.useSearch();
  const navigate = useNavigate();

  /**
   * Changing what you are looking at REPLACES rather than pushes.
   *
   * The proposal log settled this: the back button should leave the screen,
   * not walk back through every pool tab and status chip somebody tried on the
   * way to the row they wanted.
   */
  const setSearchParams = useCallback(
    (next: Partial<CatalogSearch>) => {
      void navigate({ to: "/catalog", search: { ...search, ...next }, replace: true });
    },
    [navigate, search]
  );

  // ── Which book ──
  //
  // Administrators choose from every book; everyone else gets the published
  // default, because `listRateBooks` keeps drafts away from estimators and
  // this screen does not go around it.
  const books = useQuery(api.rateBooks.listRateBooks, isAdmin ? {} : "skip");
  const defaultBook = useQuery(api.rateBooks.getDefaultBook, isAdmin ? "skip" : {});
  const bookList: BookListing[] | null = isAdmin ? (books ?? null) : null;

  const chosenBook = useMemo(() => {
    if (!books) return null;
    // Matched against the list rather than cast: a book id that is not in the
    // list is not a book this user may open, and falling back to the default
    // is the honest answer to a stale link.
    return (
      books.find((book) => book._id === search.book) ??
      books.find((book) => book.isDefault) ??
      books[0] ??
      null
    );
  }, [books, search.book]);
  const bookId: Id<"rateBooks"> | undefined = chosenBook?._id ?? defaultBook?._id;

  const summary = useQuery(api.catalog.getCatalogSummary, bookId ? { bookId } : "skip");
  const scopeTree = useQuery(api.catalog.getBookScopes, bookId ? { bookId } : "skip");
  const scopes = useScopeIndex(scopeTree);

  // ── What you are looking at ──
  const pool: PoolKind = search.pool ?? "labor";
  // Equipment and work breakdowns have no parent, and `listCatalogRows`
  // refuses a scope for a pool that has none — so a stale `scope` from another
  // pool is dropped rather than sent.
  const parentPoolId = PARENT_POOL[pool] === null ? null : (search.scope ?? null);
  const statusFilter: "all" | "active" | "retired" = search.status ?? "all";

  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const listArgs = useMemo(
    () =>
      bookId
        ? {
            bookId,
            pool,
            ...(parentPoolId === null ? {} : { parentPoolId }),
            ...(query === "" ? {} : { search: query }),
            status: statusFilter,
          }
        : ("skip" as const),
    [bookId, pool, parentPoolId, query, statusFilter]
  );
  const listing = usePaginatedQuery(api.catalog.listCatalogRows, listArgs, {
    initialNumItems: FIRST_PAGE,
  });
  const rows = listing.results;

  // ── Selection ──
  //
  // Cleared whenever the listing changes. A selection that survived a change
  // of pool or of search term would let a percentage be applied to rows the
  // admin approved in a different context and can no longer see.
  const [selection, setSelection] = useState<RowSelectionState>({});
  useEffect(() => {
    setSelection({});
  }, [listArgs]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selection[row._id] === true),
    [rows, selection]
  );

  // ── Writes ──
  const updateCatalogRow = useMutation(api.catalog.updateCatalogRow);
  const setCatalogRowRetired = useMutation(api.catalog.setCatalogRowRetired);
  const editable = summary?.editable === true;

  /**
   * A row the server refused because the screen was looking at an old copy.
   *
   * Held rather than toasted: the admin needs to know WHICH row and WHAT they
   * typed, and that the value now on screen is somebody else's, not theirs.
   * Convex pushes the new value into the grid the moment it lands, so the row
   * underneath this banner is already correct.
   *
   * `what` is a NOUN PHRASE — "change to the craft constant", "retirement of
   * this row" — because the banner reads "Your {what} was refused", and a verb
   * there produced sentences no one would say out loud.
   */
  const [conflict, setConflict] = useState<{ poolId: number; what: string } | null>(null);

  const reportRefusal = useCallback((error: unknown, row: CatalogRow, what: string) => {
    if (isStaleRowRefusal(error)) {
      setConflict({ poolId: row.poolId, what });
      return;
    }
    toast.error(refusalText(error));
  }, []);

  /**
   * Values already sent for a cell and not yet acknowledged.
   *
   * ⚠️ WITHOUT THIS, A CONFLICT REPORTS THE ADMIN TO THEMSELVES. `EditableCell`
   * commits on its 350ms debounce AND again on blur, so tabbing out of a cell
   * shortly after the last keystroke sends the same value twice. The second
   * send carries the revision the first has just superseded, and the server
   * refuses it as a stale edit — which is true, and useless, because the two
   * edits are the same person's and the same value. Dropping a repeat that is
   * already in flight loses nothing: the first write carries it.
   */
  const inFlight = useRef(new Map<string, string | number | boolean>());

  const commitCell = useCallback(
    (row: CatalogRow, field: string, raw: string, rejected?: boolean) => {
      if (!bookId || !editable) return;
      const spec = CATALOG_UI_FIELDS[pool].find((candidate) => candidate.field === field);
      if (!spec) return;

      let value: string | number = raw.trim();
      if (spec.kind === "number") {
        // A number input hands back "" for keystrokes it refused ("5e"), and
        // for a cleared cell. Neither is a constant: writing 0 would price
        // real work at nothing, and writing nothing at all would look like a
        // save that happened.
        if (rejected === true || value === "") {
          toast.error(
            `The ${spokenFieldLabel(pool, field)} could not be read as a number, so nothing was saved.`
          );
          return;
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          toast.error(`"${raw}" could not be read as a number, so nothing was saved.`);
          return;
        }
        if (parsed === (row.values[field] ?? null)) return;
        value = parsed;
      } else if (value === row.values[field]) {
        // Tabbing through a cell is not an edit; a no-op write would still
        // bump the revision and invalidate everybody else's view.
        return;
      }

      const pending = `${row._id}:${field}`;
      if (inFlight.current.get(pending) === value) return;
      inFlight.current.set(pending, value);

      void updateCatalogRow({
        bookId,
        pool,
        rowId: row._id,
        field,
        value,
        expectedRevision: row.rowRevision,
      })
        .catch((error: unknown) =>
          reportRefusal(error, row, `change to the ${spokenFieldLabel(pool, field)}`)
        )
        .finally(() => {
          if (inFlight.current.get(pending) === value) inFlight.current.delete(pending);
        });
    },
    [bookId, editable, pool, updateCatalogRow, reportRefusal]
  );

  const commitFlag = useCallback(
    (row: CatalogRow, field: string, next: boolean) => {
      if (!bookId || !editable) return;
      void updateCatalogRow({
        bookId,
        pool,
        rowId: row._id,
        field,
        value: next,
        expectedRevision: row.rowRevision,
      }).catch((error: unknown) =>
        reportRefusal(error, row, `change to “${spokenFieldLabel(pool, field)}”`)
      );
    },
    [bookId, editable, pool, updateCatalogRow, reportRefusal]
  );

  const retireRow = useCallback(
    (row: CatalogRow, retired: boolean) => {
      if (!bookId || !editable) return;
      void setCatalogRowRetired({
        bookId,
        pool,
        rowId: row._id,
        retired,
        expectedRevision: row.rowRevision,
      })
        .then(() =>
          toast.success(
            retired
              ? `Row ${row.poolId} retired — it stays on record, marked as withdrawn in this book`
              : `Row ${row.poolId} restored`
          )
        )
        .catch((error: unknown) =>
          reportRefusal(error, row, retired ? "retirement of this row" : "restoration of this row")
        );
    },
    [bookId, editable, pool, setCatalogRowRetired, reportRefusal]
  );

  // ── Percentage adjustments ──
  const runs = useQuery(api.catalog.listBulkAdjustRuns, isAdmin && bookId ? { bookId } : "skip");
  const [runId, setRunId] = useState<Id<"catalogBulkRuns"> | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  // A run in flight is adopted on sight, so reopening the window reconnects to
  // it instead of leaving a locked draft with nothing to explain it.
  const liveRun = runs?.find((run) => run.state === "running") ?? null;
  useEffect(() => {
    if (liveRun && runId === null) setRunId(liveRun._id);
  }, [liveRun, runId]);

  /**
   * The MOST RECENT run, and only if it stopped part-way.
   *
   * `listBulkAdjustRuns` is newest-first and keeps 25, so searching it for any
   * failure at all would pin an amber banner to the screen for a stop that was
   * settled weeks and several runs ago. A half-applied adjustment is worth
   * nagging about until somebody resumes it or leaves it stopped on purpose —
   * both of which move it out of `failed` — and nothing older than that is.
   */
  const stoppedRun = runs?.[0]?.state === "failed" ? runs[0] : null;

  // ── Duplicating a frozen book ──
  const [cloneFrom, setCloneFrom] = useState<CloneSource | null>(null);
  const openDraft = books?.find((book) => book.status === "draft") ?? null;
  const [adding, setAdding] = useState(false);

  const noticeAction: NoticeAction | null = useMemo(() => {
    if (!isAdmin || !summary || summary.status === "draft") return null;
    // One draft at a time — so when there already is one, the useful offer is
    // to go and look at it rather than to fail on the click.
    if (openDraft) {
      return {
        label: `Open “${openDraft.name}”`,
        onClick: () => setSearchParams({ book: openDraft._id, scope: undefined }),
      };
    }
    return {
      label: "Duplicate as a draft…",
      onClick: () => setCloneFrom({ id: summary._id, name: summary.name }),
    };
  }, [isAdmin, summary, openDraft, setSearchParams]);

  const poolTotal = summary && parentPoolId === null ? summary.counts[pool].total : null;
  const narrowed = query !== "" || statusFilter !== "all";
  /**
   * The pool a percentage means anything to, narrowed by comparison rather
   * than by a cast — `startBulkAdjust` accepts only these two.
   */
  const adjustablePool: AdjustablePool | null =
    pool === "labor" || pool === "equipment" ? pool : null;

  return (
    <div className="flex h-full flex-col">
      <BookBar
        books={bookList}
        summary={summary}
        onChooseBook={(next) => setSearchParams({ book: next, scope: undefined })}
      />

      {/* Immediately under the book bar, because it is a fact about the BOOK —
          between the pool tabs and the scope row it split two bands of
          navigation with an explanation belonging to neither.

          ⚠️ ADMINISTRATORS ONLY, AND NOT AS A PERMISSION CHECK. Everything it
          says is addressed to the one person who could act on it: duplicate the
          book, edit the draft, publish. An estimator can do none of that and
          never sees a draft at all, so for them a published book being
          read-only is simply the normal state of the catalog — the Read-only
          chip in the bar above says so, and a standing banner offering a remedy
          they cannot carry out is noise on every visit. */}
      {isAdmin && summary && (
        <ImmutabilityNotice
          summary={summary}
          proposalCount={chosenBook?.proposalCount ?? null}
          action={noticeAction}
        />
      )}

      {/* ── The four pools, with what each of them holds ── */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-3">
        {POOL_ORDER.map((candidate) => {
          const counts = summary?.counts[candidate];
          const active = candidate === pool;
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={active}
              onClick={() => setSearchParams({ pool: candidate, scope: undefined })}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-lg px-2 text-callout transition-colors",
                "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-fill-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-fill-quaternary"
              )}
            >
              {POOL_LABEL[candidate]}
              {counts && (
                <span className="text-footnote tabular-nums text-foreground-subtle">
                  {counts.total.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        {summary && summary.counts[pool].retired > 0 && (
          <span className="text-footnote tabular-nums text-muted-foreground">
            {summary.counts[pool].retired.toLocaleString()} retired in this pool
          </span>
        )}
      </div>

      {conflict !== null && (
        <div className="flex shrink-0 items-start gap-2.5 border-b border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-footnote leading-relaxed text-foreground">
            <span className="font-medium">
              Row {conflict.poolId} changed while you were editing it.
            </span>{" "}
            Your {conflict.what} was refused rather than applied on top of somebody else&rsquo;s
            change, so the row you are looking at now is theirs and is current. Read it, then make
            the change again if it is still the one you want.
          </p>
          <Button
            variant="ghost"
            size="lg"
            aria-label="Dismiss"
            onClick={() => setConflict(null)}
            className="shrink-0"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {stoppedRun !== null && runId === null && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-amber-500/30 bg-amber-500/5 px-3 py-1.5">
          <AlertTriangle
            className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-footnote text-foreground">
            A percentage adjustment stopped after{" "}
            <span className="tabular-nums">{stoppedRun.tally.adjusted.toLocaleString()}</span> of{" "}
            <span className="tabular-nums">{stoppedRun.tally.selected.toLocaleString()}</span> rows.
          </p>
          <Button variant="outline" size="lg" onClick={() => setRunId(stoppedRun._id)}>
            <RotateCcw className="h-3 w-3" />
            Review
          </Button>
        </div>
      )}

      {/* ── Scope, search and the things you can do ── */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <ScopePicker
          pool={pool}
          scopes={scopes}
          parentPoolId={parentPoolId}
          onChange={(next) => setSearchParams({ scope: next ?? undefined })}
        />

        <div className="relative w-[240px]">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search this pool, or type an id"
            aria-label={`Search ${POOL_LABEL[pool].toLowerCase()}`}
            className="h-7 rounded-full pl-7 text-callout"
          />
        </div>

        <div className="flex items-center gap-px rounded-lg bg-fill-quaternary p-0.5">
          {(["all", "active", "retired"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={statusFilter === value}
              aria-label={value === "all" ? "Show active and retired rows" : `Show ${value} rows`}
              onClick={() => setSearchParams({ status: value === "all" ? undefined : value })}
              className={cn(
                "h-5 rounded-md px-2 text-footnote capitalize transition-colors",
                "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                statusFilter === value
                  ? "bg-background font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {value}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {selectedRows.length > 0 && (
          <span className="text-footnote tabular-nums text-muted-foreground">
            {selectedRows.length.toLocaleString()} selected
          </span>
        )}

        {editable && adjustablePool !== null && (
          <Button
            variant="outline"
            size="lg"
            disabled={selectedRows.length === 0}
            title={
              selectedRows.length === 0
                ? "Tick the rows a percentage applies to — it never picks them for you"
                : `Move a percentage across ${selectedRows.length.toLocaleString()} selected rows`
            }
            onClick={() => setAdjusting(true)}
          >
            <Percent className="h-3 w-3" />
            Adjust
          </Button>
        )}

        {editable && (
          <Button variant="outline" size="lg" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3" />
            Add {POOL_ROW_NOUN[pool].one}
          </Button>
        )}
      </div>

      <CatalogGrid
        pool={pool}
        rows={rows}
        editable={editable}
        withSelection={editable && adjustablePool !== null}
        parentName={(row) => scopes.parentName(pool, row)}
        parentRetired={(row) => scopes.parentRetired(pool, row)}
        onCommit={commitCell}
        onFlag={commitFlag}
        onRetire={retireRow}
        selection={selection}
        onSelectionChange={setSelection}
        status={listing.status}
        onLoadMore={() => listing.loadMore(NEXT_PAGE)}
        poolTotal={poolTotal}
        narrowed={narrowed}
        emptyMessage={
          narrowed
            ? listing.status === "Exhausted"
              ? `Nothing in ${POOL_LABEL[pool].toLowerCase()} matches that.`
              : "No match in the rows read so far. Keep looking to read further down the pool."
            : `This pool is empty in ${summary?.name ?? "this book"}.`
        }
      />

      {bookId && summary && (
        <AddRowDialog
          open={adding}
          bookId={bookId}
          bookName={summary.name}
          pool={pool}
          scopes={scopes}
          defaultParentPoolId={parentPoolId}
          onOpenChange={setAdding}
          onAdded={(poolId) => {
            // A new row sorts to the END of its group, which is past whatever
            // has been paged in — so the screen goes and finds it by id, which
            // the server's filter matches exactly.
            setSearchInput(String(poolId));
            setSearchParams({ status: undefined });
          }}
        />
      )}

      {bookId && summary && adjustablePool !== null && (
        <BulkAdjustDialog
          open={adjusting}
          bookId={bookId}
          bookName={summary.name}
          pool={adjustablePool}
          rows={selectedRows}
          onOpenChange={setAdjusting}
          onStarted={(started) => {
            setSelection({});
            setRunId(started);
          }}
        />
      )}

      {runId !== null && <BulkAdjustProgress runId={runId} onClose={() => setRunId(null)} />}

      <CloneBookDialog
        source={cloneFrom}
        onOpenChange={(open) => !open && setCloneFrom(null)}
        onCreated={(created) => setSearchParams({ book: created, scope: undefined })}
      />
    </div>
  );
}
