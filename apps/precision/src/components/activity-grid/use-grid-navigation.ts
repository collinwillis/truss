import { useCallback, useRef } from "react";
import type React from "react";

/**
 * Spreadsheet movement across the activity grid.
 *
 * What estimators actually do is enter one column down a phase — quantity,
 * quantity, quantity — so the keys are bound the way a spreadsheet binds them:
 *
 *   Enter / ↓   commit, move DOWN the same column
 *   Shift+Enter / ↑   commit, move UP the same column
 *   Tab / Shift+Tab   commit, move ACROSS to the next editable cell, wrapping
 *                     to the next or previous row at the ends
 *   Escape            revert (EditableCell owns this)
 *
 * ONLY EDITABLE CELLS ARE STOPS. A read-only cell renders no input at all, so
 * landing on one would strand the cursor; movement skips to the next cell that
 * accepts typing, exactly as legacy's `skipNonEditableCells` did.
 *
 * WHY THE TARGET IS COMPUTED, NOT FOUND BY DOM ORDER: the previous
 * implementation walked `input[data-cell-id]` in document order, which can
 * only move along a row and silently changed meaning whenever a column was
 * hidden. Rows and visible columns come from the table itself here, so the
 * geometry is the one on screen.
 */

export interface GridNavigationOptions {
  /** Row ids in display order. */
  rowIds: readonly string[];
  /** VISIBLE column ids, in display order. */
  columnIds: readonly string[];
  /** Whether this cell accepts typing — the same predicate the cells render. */
  isEditable: (rowId: string, columnId: string) => boolean;
}

/** Cell ids are `${rowId}-${columnId}`; Convex ids carry no dash. */
export function cellId(rowId: string, columnId: string): string {
  return `${rowId}-${columnId}`;
}

function parseCellId(raw: string): { rowId: string; columnId: string } | null {
  const dash = raw.indexOf("-");
  if (dash <= 0) return null;
  return { rowId: raw.slice(0, dash), columnId: raw.slice(dash + 1) };
}

function focusCell(rowId: string, columnId: string): boolean {
  const selector = `input[data-cell-id="${CSS.escape(cellId(rowId, columnId))}"]`;
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) return false;
  el.focus();
  // Selecting means the next keystroke REPLACES — type-over, like a
  // spreadsheet — instead of appending to the value that is already there.
  el.select();
  // Keeps the cursor visible when the grid is taller than its scroll box.
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

export function useGridNavigation(options: GridNavigationOptions) {
  /**
   * THE RETURNED HANDLER IS PERMANENTLY STABLE, and that is load-bearing:
   * it feeds the column definitions, and TanStack's flexRender treats each
   * column's `cell` function as a React COMPONENT TYPE. If this callback
   * changed when the row list changed, the columns array would be rebuilt on
   * every server push, every cell closure would be a new "type", and React
   * would REMOUNT every cell — which destroyed the focused input mid-edit
   * the moment a debounced auto-save round-tripped. Geometry goes through a
   * ref instead, refreshed each render, read at keystroke time.
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    const { rowIds, columnIds, isEditable } = optionsRef.current;
    const raw = event.currentTarget.getAttribute("data-cell-id");
    const parsed = raw ? parseCellId(raw) : null;
    if (!parsed) return;

    const row = rowIds.indexOf(parsed.rowId);
    const col = columnIds.indexOf(parsed.columnId);
    if (row < 0 || col < 0) return;

    /** Nearest editable cell in the same column, scanning by `step`. */
    const moveVertical = (step: number): void => {
      for (let r = row + step; r >= 0 && r < rowIds.length; r += step) {
        const target = rowIds[r];
        if (target && isEditable(target, parsed.columnId)) {
          focusCell(target, parsed.columnId);
          return;
        }
      }
    };

    /** Next editable cell in reading order, wrapping across rows. */
    const moveHorizontal = (step: number): void => {
      let r = row;
      let c = col + step;
      while (r >= 0 && r < rowIds.length) {
        if (c >= columnIds.length) {
          r += 1;
          c = 0;
          continue;
        }
        if (c < 0) {
          r -= 1;
          c = columnIds.length - 1;
          continue;
        }
        const targetRow = rowIds[r];
        const targetCol = columnIds[c];
        if (targetRow && targetCol && isEditable(targetRow, targetCol)) {
          focusCell(targetRow, targetCol);
          return;
        }
        c += step;
      }
    };

    switch (event.key) {
      case "Enter":
        moveVertical(event.shiftKey ? -1 : 1);
        break;
      case "ArrowDown":
        moveVertical(1);
        break;
      case "ArrowUp":
        moveVertical(-1);
        break;
      case "Tab":
        moveHorizontal(event.shiftKey ? -1 : 1);
        break;
      default:
        break;
    }
  }, []);
}
