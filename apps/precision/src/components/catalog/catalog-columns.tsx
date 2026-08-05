import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@truss/ui/components/checkbox";
import { cn } from "@truss/ui/lib/utils";
import type React from "react";
import { NumberCell, TextCell } from "../activity-grid/cells";
import { cellId } from "../activity-grid/use-grid-navigation";
import {
  CATALOG_UI_FIELDS,
  NAME_FIELD,
  PARENT_POOL,
  POOL_LABEL,
  flagAt,
  numberAt,
  textAt,
  type CatalogRow,
  type PoolKind,
} from "./pool-model";

/**
 * The catalog grid's columns.
 *
 * ⚠️ BUILT ONCE PER POOL AND NEVER PER RENDER. TanStack's `flexRender` treats
 * a column's `cell` function as a React COMPONENT TYPE, so a columns array
 * rebuilt when the data changed would remount every cell — which destroys the
 * focused input the moment a debounced save round-trips. Everything volatile
 * (whether the book is editable, the commit handlers, the keyboard handler)
 * travels through the context REF, refreshed each render and read at
 * cell-render time. This is the same arrangement `buildLogColumns` uses, and
 * for the same reason.
 *
 * Editable cells are `NumberCell` / `TextCell` over the shared `EditableCell`,
 * so a catalog constant is typed with exactly the keystrokes an estimate
 * quantity is.
 *
 * @module
 */

/** What the cells need to know, at the moment they render. */
export interface CatalogGridContext {
  /** Whether this book accepts writes at all — a draft, built, unlocked. */
  editable: boolean;
  /** The parent scope's name for one row, already resolved from `getBookScopes`. */
  parentName: (row: CatalogRow) => string;
  /** Whether that parent scope has itself been retired by this book. */
  parentRetired: (row: CatalogRow) => boolean;
  /** A typed cell, committed against the revision the row was rendered with. */
  onCommit: (row: CatalogRow, field: string, raw: string, rejected?: boolean) => void;
  /** A flag toggled; separate from `onCommit` because it carries no keystrokes. */
  onFlag: (row: CatalogRow, field: string, next: boolean) => void;
  /** Retire the row, or put it back. */
  onRetire: (row: CatalogRow, retired: boolean) => void;
  /** Spreadsheet movement, from `useGridNavigation`. */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** Columns that are not fields of the pool, so navigation can skip them. */
const SELECT_COLUMN = "select";
const ID_COLUMN = "poolId";
const PARENT_COLUMN = "parent";
const STATE_COLUMN = "state";

/** The column ids of one pool, in display order. */
export function catalogColumnIds(pool: PoolKind, withSelection: boolean): string[] {
  return [
    ...(withSelection ? [SELECT_COLUMN] : []),
    ID_COLUMN,
    ...(PARENT_POOL[pool] === null ? [] : [PARENT_COLUMN]),
    ...CATALOG_UI_FIELDS[pool].map((spec) => spec.field),
    STATE_COLUMN,
  ];
}

/**
 * Whether a cell accepts typing.
 *
 * Flags are excluded even though they are editable: they are checkboxes, not
 * inputs, so Tab landing on one would strand the cursor on an element
 * `focusCell` cannot find. The same predicate feeds `useGridNavigation`, so
 * what the keyboard can reach and what the grid renders cannot disagree.
 */
export function isTypedCell(pool: PoolKind, columnId: string): boolean {
  return CATALOG_UI_FIELDS[pool].some((spec) => spec.field === columnId && spec.kind !== "flag");
}

export function buildCatalogColumns(
  pool: PoolKind,
  withSelection: boolean,
  ctx: { current: CatalogGridContext }
): ColumnDef<CatalogRow>[] {
  const parentPool = PARENT_POOL[pool];

  const columns: ColumnDef<CatalogRow>[] = [];

  if (withSelection) {
    columns.push({
      id: SELECT_COLUMN,
      size: 32,
      enableResizing: false,
      header: ({ table }) => (
        <Checkbox
          aria-label="Select every loaded row"
          checked={
            table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")
          }
          onCheckedChange={(value) => table.toggleAllRowsSelected(value === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select ${row.original.description}`}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
        />
      ),
    });
  }

  columns.push({
    id: ID_COLUMN,
    accessorFn: (row) => row.poolId,
    header: "ID",
    size: 62,
    cell: ({ row }) => (
      <span className="block truncate px-2 font-mono text-footnote tabular-nums text-foreground-subtle">
        {row.original.poolId}
      </span>
    ),
  });

  if (parentPool !== null) {
    columns.push({
      id: PARENT_COLUMN,
      header: POOL_LABEL[parentPool],
      size: 176,
      cell: ({ row }) => {
        const name = ctx.current.parentName(row.original);
        const retired = ctx.current.parentRetired(row.original);
        return (
          <span
            // Struck through rather than given its own badge: the column is
            // 176px and the phase names already truncate, so the marking has
            // to cost no horizontal space at all. It is a plain span, not an
            // input, so the rule actually draws.
            className={cn(
              "block truncate px-2 text-footnote",
              retired ? "text-foreground-subtle line-through" : "text-muted-foreground"
            )}
            title={retired ? `${name} — retired in this book` : name}
          >
            {name}
          </span>
        );
      },
    });
  }

  for (const spec of CATALOG_UI_FIELDS[pool]) {
    if (spec.kind === "flag") {
      columns.push({
        id: spec.field,
        header: () => <span className="block text-center">{spec.label}</span>,
        size: spec.size,
        cell: ({ row }) => {
          const { editable, onFlag } = ctx.current;
          const checked = flagAt(row.original, spec.field);
          if (!editable) {
            return (
              <span
                className={cn(
                  "flex h-full items-center justify-center text-footnote",
                  checked ? "text-foreground" : "text-foreground-subtle"
                )}
              >
                {checked ? "Yes" : "—"}
              </span>
            );
          }
          return (
            <span className="flex h-full items-center justify-center">
              <Checkbox
                aria-label={`${spec.label} on ${row.original.description}`}
                checked={checked}
                onCheckedChange={(value) => onFlag(row.original, spec.field, value === true)}
              />
            </span>
          );
        },
      });
      continue;
    }

    if (spec.kind === "number") {
      columns.push({
        id: spec.field,
        header: () => <span className="block text-right">{spec.label}</span>,
        size: spec.size,
        cell: ({ row }) => (
          <NumberCell
            editable={ctx.current.editable}
            cellId={cellId(row.original._id, spec.field)}
            value={numberAt(row.original, spec.field)}
            currency={spec.currency}
            // ⚠️ The placeholder is what makes a stored ZERO render as "0".
            //
            // EditableCell hides a read-only zero as "—" on purpose: in the
            // estimate grid a zero cost is a computed by-product and dense
            // columns of zeroes are noise. In the CATALOG it is the opposite —
            // craftConstant: 0 is a deliberate statement that the item carries
            // no craft hours, on the one screen whose job is to show what the
            // catalog says. Worse, the same cell renders "0" once the book is a
            // draft, so the identical value would display differently depending
            // on whether you may edit it, and a published book read next to its
            // draft would look changed when nothing had changed.
            //
            // The component documents this exact escape hatch rather than
            // needing a change: a cell carrying a placeholder distinguishes
            // empty from zero by design. EditableCell ships to Momentum, which
            // is in production, so this is the correct side to fix.
            placeholder="—"
            onCommit={(raw, rejected) =>
              ctx.current.onCommit(row.original, spec.field, raw, rejected)
            }
            onKeyDown={ctx.current.onKeyDown}
          />
        ),
      });
      continue;
    }

    const isNameColumn = spec.field === NAME_FIELD[pool];
    columns.push({
      id: spec.field,
      header: spec.label,
      size: spec.size,
      minSize: isNameColumn ? 180 : 48,
      cell: ({ row }) => (
        <TextCell
          editable={ctx.current.editable}
          cellId={cellId(row.original._id, spec.field)}
          value={textAt(row.original, spec.field)}
          onCommit={(raw) => ctx.current.onCommit(row.original, spec.field, raw)}
          onKeyDown={ctx.current.onKeyDown}
        />
      ),
    });
  }

  columns.push({
    id: STATE_COLUMN,
    header: "State",
    size: 104,
    enableResizing: false,
    cell: ({ row }) => {
      const { editable, onRetire } = ctx.current;
      const retired = !row.original.isActive;
      // The retirement is the fact; the button is only offered where it can
      // actually be carried out.
      return (
        <span className="flex h-full items-center justify-between gap-1 px-2">
          {retired ? (
            <span className="rounded-full bg-fill-secondary px-1.5 py-px text-caption2 font-medium uppercase text-muted-foreground">
              Retired
            </span>
          ) : (
            <span className="text-footnote text-foreground-subtle">—</span>
          )}
          {editable && (
            <button
              type="button"
              onClick={() => onRetire(row.original, !retired)}
              title={
                retired
                  ? "Put this row back into the catalog"
                  : "Retire this row — it stays on record, marked as withdrawn in this book"
              }
              className={cn(
                "rounded px-1 text-caption2 font-medium uppercase text-foreground-subtle opacity-0",
                "transition-opacity hover:text-foreground group-hover:opacity-100",
                "focus-visible:border-primary focus-visible:opacity-100 focus-visible:outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              {retired ? "Restore" : "Retire"}
            </button>
          )}
        </span>
      );
    },
  });

  return columns;
}
