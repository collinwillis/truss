import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnSizingState,
  type OnChangeFn,
  type RowSelectionState,
} from "@tanstack/react-table";
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGridNavigation } from "../activity-grid/use-grid-navigation";
import { cellWidth, columnSizeVars } from "../grid-geometry";
import {
  buildCatalogColumns,
  catalogColumnIds,
  isTypedCell,
  type CatalogGridContext,
} from "./catalog-columns";
import { NAME_FIELD, POOL_ROW_NOUN, type CatalogRow, type PoolKind } from "./pool-model";

/**
 * The catalog, one page at a time.
 *
 * ⚠️ PAGING IS CORRECTNESS HERE, NOT POLISH. The labor pool of the real book
 * is 5,897 rows; a screen that asked for all of them would blow past Convex's
 * per-query document ceiling long before it blew past the browser's patience.
 * The server paginates and this renders what has been asked for, so the DOM
 * grows only when somebody deliberately asks it to.
 *
 * @module
 */

/** How the paginated listing is getting on, in Convex's own vocabulary. */
export type PagingStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/** Column widths are a per-pool preference — equipment is not labor. */
function sizingKey(pool: PoolKind): string {
  return `precision.catalog.sizing.${pool}`;
}

function loadSizing(pool: PoolKind): ColumnSizingState {
  try {
    const raw = window.localStorage.getItem(sizingKey(pool));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const sizes: ColumnSizingState = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) sizes[id] = value;
    }
    return sizes;
  } catch {
    // A corrupt preference is not worth a broken screen; the defaults are fine.
    return {};
  }
}

function saveSizing(pool: PoolKind, sizing: ColumnSizingState): void {
  try {
    window.localStorage.setItem(sizingKey(pool), JSON.stringify(sizing));
  } catch {
    // Storage full or disabled — the widths simply do not persist.
  }
}

export interface CatalogGridProps {
  pool: PoolKind;
  rows: CatalogRow[];
  /** Whether this book accepts writes; false makes every cell read-only. */
  editable: boolean;
  /** Selection exists only to feed the percentage adjustment. */
  withSelection: boolean;
  parentName: (row: CatalogRow) => string;
  parentRetired: (row: CatalogRow) => boolean;
  onCommit: (row: CatalogRow, field: string, raw: string, rejected?: boolean) => void;
  onFlag: (row: CatalogRow, field: string, next: boolean) => void;
  onRetire: (row: CatalogRow, retired: boolean) => void;
  selection: RowSelectionState;
  onSelectionChange: OnChangeFn<RowSelectionState>;
  status: PagingStatus;
  onLoadMore: () => void;
  /** Rows this pool holds in total, from the summary — the denominator. */
  poolTotal: number | null;
  /** Whether a search or a status filter is narrowing the listing. */
  narrowed: boolean;
  /** Shown in place of the table when nothing came back at all. */
  emptyMessage: string;
}

export function CatalogGrid({
  pool,
  rows,
  editable,
  withSelection,
  parentName,
  parentRetired,
  onCommit,
  onFlag,
  onRetire,
  selection,
  onSelectionChange,
  status,
  onLoadMore,
  poolTotal,
  narrowed,
  emptyMessage,
}: CatalogGridProps) {
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  useEffect(() => {
    setColumnSizing(loadSizing(pool));
  }, [pool]);
  const handleSizingChange = useCallback<OnChangeFn<ColumnSizingState>>(
    (updater) => {
      setColumnSizing((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        saveSizing(pool, next);
        return next;
      });
    },
    [pool]
  );

  const columnIds = useMemo(() => catalogColumnIds(pool, withSelection), [pool, withSelection]);
  const rowIds = useMemo(() => rows.map((row) => row._id), [rows]);
  const isEditableCell = useCallback(
    (_rowId: string, columnId: string) => editable && isTypedCell(pool, columnId),
    [editable, pool]
  );
  const nav = useGridNavigation({ rowIds, columnIds, isEditable: isEditableCell });

  /**
   * Everything volatile the cells read, refreshed each render.
   *
   * The columns array below is built once per pool; without this ref the
   * handlers would be new identities on every render, the array would be
   * rebuilt, and TanStack would remount every cell mid-edit.
   */
  const ctx = useRef<CatalogGridContext>({
    editable,
    parentName,
    parentRetired,
    onCommit,
    onFlag,
    onRetire,
    onKeyDown: nav,
  });
  ctx.current = {
    editable,
    parentName,
    parentRetired,
    onCommit,
    onFlag,
    onRetire,
    onKeyDown: nav,
  };

  const columns = useMemo(
    () => buildCatalogColumns(pool, withSelection, ctx),
    [pool, withSelection]
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row._id,
    columnResizeMode: "onChange",
    enableRowSelection: withSelection,
    onRowSelectionChange: onSelectionChange,
    onColumnSizingChange: handleSizingChange,
    state: { columnSizing, rowSelection: selection },
  });

  const nameColumn = NAME_FIELD[pool];
  const nameIsSized = columnSizing[nameColumn] !== undefined;
  const widthFor = (columnId: string, sizeVar: string): React.CSSProperties =>
    cellWidth(columnId, sizeVar, {
      flexColumnId: nameColumn,
      flexMinWidth: 220,
      isFlexColumnSized: nameIsSized,
    });
  const sizeVars = columnSizeVars(table);
  const bodyRows = table.getRowModel().rows;

  if (status === "LoadingFirstPage") {
    return (
      <div className="min-h-0 flex-1 space-y-px overflow-hidden p-3" aria-busy="true">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-[26px] rounded bg-fill-quaternary" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="w-full table-fixed border-collapse text-xs"
          style={{ ...sizeVars, minWidth: table.getTotalSize() }}
        >
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="group relative h-7 overflow-hidden border-b bg-grid-header px-0 text-left text-footnote font-semibold uppercase tracking-wide text-muted-foreground"
                    style={widthFor(header.column.id, `var(--header-${header.id}-size)`)}
                  >
                    <div className="flex h-full w-full items-center px-2 whitespace-nowrap">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                    {header.column.getCanResize() && (
                      <div
                        onDoubleClick={() => header.column.resetSize()}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={cn(
                          "absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize touch-none select-none",
                          "bg-border-strong opacity-0 transition-opacity group-hover:opacity-100",
                          header.column.getIsResizing() && "bg-primary opacity-100"
                        )}
                      />
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {bodyRows.map((row, index) => (
              <tr
                key={row.id}
                className={cn(
                  // Catalog data is rendered upper case throughout, by the
                  // client's explicit instruction. `text-transform` inherits
                  // into the cell inputs, so what is DISPLAYED changes and
                  // what is STORED does not.
                  "group h-[26px] uppercase",
                  row.getIsSelected()
                    ? "bg-primary/10"
                    : index % 2 === 0
                      ? "bg-background"
                      : "bg-background-subtle"
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="overflow-hidden bg-inherit p-0"
                    style={widthFor(cell.column.id, `var(--col-${cell.column.id}-size)`)}
                  >
                    <div
                      className={cn(
                        "flex h-[26px] items-center",
                        cell.column.id === "select" && "justify-center",
                        // A retired row is dimmed but never hidden: seeing what
                        // a draft withdrew is the reason this listing includes
                        // it. Opacity rather than a text colour, because
                        // `EditableCell` sets `text-foreground` on its own
                        // input — a colour here would dim the row's labels and
                        // leave its numbers at full strength, which is the
                        // wrong half.
                        //
                        // ⚠️ APPLIED PER CELL, NOT TO THE ROW, AND THE STATE
                        // AND SELECT COLUMNS ARE EXEMPT. CSS opacity on the
                        // <tr> composites the whole row, and a descendant
                        // cannot climb back out of it — so the RETIRED pill,
                        // which is the only unambiguous evidence of the
                        // retirement, was being faded by the very rule it
                        // explains. The data recedes; the fact and the
                        // checkbox stay at full strength.
                        !row.original.isActive &&
                          cell.column.id !== "state" &&
                          cell.column.id !== "select" &&
                          "opacity-60"
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {bodyRows.length === 0 && (
          <div className="px-4 py-16 text-center">
            <p className="text-body text-muted-foreground">{emptyMessage}</p>
          </div>
        )}
      </div>

      <PagingBar
        pool={pool}
        loaded={rows.length}
        poolTotal={poolTotal}
        narrowed={narrowed}
        status={status}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

/**
 * How much of the pool is on screen, and how to see more.
 *
 * The denominator is the pool's own total from `getCatalogSummary`, not the
 * number of rows fetched, so "150 of 5,897" is true on the first page. While a
 * filter is narrowing, the total means nothing — the server scans a window per
 * page and returns the matches in it — so the bar counts matches instead and
 * says plainly that there may be more further down.
 */
function PagingBar({
  pool,
  loaded,
  poolTotal,
  narrowed,
  status,
  onLoadMore,
}: {
  pool: PoolKind;
  loaded: number;
  poolTotal: number | null;
  narrowed: boolean;
  status: PagingStatus;
  onLoadMore: () => void;
}) {
  const noun = POOL_ROW_NOUN[pool];
  const exhausted = status === "Exhausted";
  const busy = status === "LoadingMore";

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-t px-3">
      <span className="text-footnote tabular-nums text-muted-foreground">
        {narrowed
          ? `${loaded.toLocaleString()} ${loaded === 1 ? "match" : "matches"}${
              exhausted ? " in this pool" : " so far"
            }`
          : poolTotal === null
            ? `${loaded.toLocaleString()} ${loaded === 1 ? noun.one : noun.many}`
            : `${loaded.toLocaleString()} of ${poolTotal.toLocaleString()} ${
                poolTotal === 1 ? noun.one : noun.many
              }`}
      </span>
      <div className="flex-1" />
      {!exhausted && (
        <Button variant="outline" size="lg" disabled={busy} onClick={onLoadMore}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {busy ? "Loading…" : narrowed ? "Keep looking" : "Load more"}
        </Button>
      )}
    </div>
  );
}
