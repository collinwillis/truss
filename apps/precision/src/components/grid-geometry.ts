import type { Column, Table } from "@tanstack/react-table";

/**
 * Table geometry shared by Precision's two data grids.
 *
 * Both the phase grid and the proposal log follow TanStack's CSS-variable
 * sizing pattern and its sticky-pinning guide, and they must agree exactly:
 * they are the same table to the person using them, one row height and one
 * set of frozen-edge rules apart. Keeping the arithmetic in one module is
 * what stops them drifting.
 */

/**
 * Column widths as CSS variables, computed once per size change.
 *
 * WHY VARIABLES AND NOT `getSize()` PER CELL: with hundreds of cells on
 * screen, calling the sizing API from every cell recomputes the same handful
 * of numbers hundreds of times per render — and during a resize drag, on
 * every pointer move. The table publishes the widths once; the cells read
 * them from the cascade.
 */
export function columnSizeVars<T>(table: Table<T>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const header of table.getFlatHeaders()) {
    vars[`--header-${header.id}-size`] = `${header.getSize()}px`;
    vars[`--col-${header.column.id}-size`] = `${header.column.getSize()}px`;
  }
  return vars;
}

/**
 * The width for one cell, given the column that absorbs slack.
 *
 * One column in each grid has no natural width — the description of the work.
 * Left at a fixed size it either truncates on a wide window or forces a
 * horizontal scrollbar on a narrow one, so it is declared `auto` with a floor
 * and takes whatever the window has spare.
 *
 * Once the estimator drags it, their width is the answer and it is honoured
 * like any other column.
 */
export function cellWidth(
  columnId: string,
  sizeVar: string,
  options: { flexColumnId: string; flexMinWidth: number; isFlexColumnSized: boolean }
): React.CSSProperties {
  return columnId === options.flexColumnId && !options.isFlexColumnSized
    ? { width: "auto", minWidth: options.flexMinWidth }
    : { width: sizeVar };
}

/**
 * Sticky offsets for pinned columns, per the pinning guide's CSS approach:
 * render the table normally and let `getStart('left')` / `getAfter('right')`
 * supply the offsets. A one-pixel inset rule marks each pinned edge so the
 * frozen columns read as a distinct pane rather than a rendering accident.
 */
export function pinnedStyle<T>(column: Column<T>, layer: "header" | "cell"): React.CSSProperties {
  const pinned = column.getIsPinned();
  if (!pinned) return {};
  const isLeftEdge = pinned === "left" && column.getIsLastColumn("left");
  const isRightEdge = pinned === "right" && column.getIsFirstColumn("right");
  return {
    position: "sticky",
    left: pinned === "left" ? column.getStart("left") : undefined,
    right: pinned === "right" ? column.getAfter("right") : undefined,
    // Header corners sit above the pinned body cells, which sit above the
    // scrolling ones.
    zIndex: layer === "header" ? 30 : 20,
    boxShadow: isLeftEdge
      ? "inset -1px 0 0 var(--border-strong)"
      : isRightEdge
        ? "inset 1px 0 0 var(--border-strong)"
        : undefined,
  };
}
