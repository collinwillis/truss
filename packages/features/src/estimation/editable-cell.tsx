import { cn } from "@truss/ui/lib/utils";
import React, { useCallback, useRef, useState } from "react";

/** Idle time before auto-committing an edit (ms). */
const DEBOUNCE_MS = 350;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditableCellBaseProps {
  /** Unique identifier for DOM-based keyboard navigation. */
  cellId: string;
  /** Called when the user presses Escape to discard the edit. */
  onDiscard?: () => void;
  /** Keyboard event handler for Tab/Enter navigation between cells. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

interface NumberCellProps extends EditableCellBaseProps {
  type: "number";
  /**
   * `null` renders an EMPTY cell showing {@link NumberCellProps.placeholder} —
   * the shape D3 requires for an inheriting rate override: the cell holds no
   * value, so tabbing through cannot commit one.
   */
  value: number | null;
  displayFormat?: "plain" | "currency";
  /** Shown, muted, while the cell is empty — e.g. the inherited rate. */
  placeholder?: string;
}

interface TextCellProps extends EditableCellBaseProps {
  type: "text";
  value: string;
}

/**
 * Pairs a cell's value shape with its edit mode.
 *
 * WHY: a permanently read-only cell renders a computed value and never becomes
 * an input, so it has nothing to commit — requiring `onCommit` there would
 * force callers to pass a callback that can never fire. Cells that can be
 * edited (including ones whose `readOnly` flag is decided at runtime) must
 * still supply it, so the guarantee is preserved where it matters.
 */
type WithEditMode<TValue> =
  | (TValue & {
      /** Read-only cells render computed values as plain text. */
      readOnly: true;
      onCommit?: never;
    })
  | (TValue & {
      /** Whether the cell is read-only (computed values). */
      readOnly?: boolean;
      /**
       * Called when the user commits (blur or debounce). `rejected` is true
       * when a number input refused the keystrokes ("5e"): the value arrives
       * as "" either way, and only the handler knows whether empty means
       * "cleared" or "unparseable".
       */
      onCommit: (value: string, rejected?: boolean) => void;
    });

export type EditableCellProps = WithEditMode<NumberCellProps> | WithEditMode<TextCellProps>;

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

function formatDisplay(props: EditableCellProps): string {
  if (props.type === "text") return props.value;
  // Empty, so the native placeholder shows through.
  if (props.value === null) return "";
  if (props.value === 0) {
    // A computed zero is noise in a dense grid, so read-only cells hide it.
    // A zero the estimator TYPED is a value — D3 makes $0.00/hr real — so an
    // editable cell must render it as one.
    // A cell that carries a placeholder distinguishes empty from zero by
    // design — there, zero is a value the estimator SET (D3 makes $0.00/hr
    // real), and hiding it erases the one state D3 exists for, for read-only
    // viewers most of all.
    if (props.readOnly && props.placeholder === undefined) return "—";
    return props.displayFormat === "currency" ? currencyFormatter.format(0) : "0";
  }
  if (props.displayFormat === "currency") return currencyFormatter.format(props.value);
  return numberFormatter.format(props.value);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Inline-editable cell for the estimation data grid.
 *
 * WHY: Click-to-edit with debounced auto-save. The cell shows a formatted
 * value when idle and transforms into an input on focus. Read-only cells
 * render as plain text with muted styling to visually distinguish them
 * from editable cells (which appear slightly bolder).
 */
export const EditableCell = React.memo(function EditableCell(props: EditableCellProps) {
  const { cellId, onCommit, onDiscard, onKeyDown, readOnly } = props;

  const [localValue, setLocalValue] = useState<string | undefined>(undefined);
  const escapeRef = useRef(false);
  const rejectedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Absent only for read-only cells, which never render the input the commit
  // handlers are wired to.
  const onCommitRef = useRef<((value: string, rejected?: boolean) => void) | undefined>(onCommit);
  onCommitRef.current = onCommit;

  const isEditing = localValue !== undefined;
  const isNumber = props.type === "number";
  // Pull the current value out into a stable, statically-analyzable variable
  // so React's exhaustive-deps lint can see it without flagging a "complex
  // expression in dependency array".
  const currentValue: string | number | null = isNumber
    ? (props as NumberCellProps).value
    : (props as TextCellProps).value;

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (readOnly) return;
      escapeRef.current = false;
      // An empty cell opens empty — String(null) would seed "null".
      setLocalValue(currentValue === null ? "" : String(currentValue));
      requestAnimationFrame(() => e.target.select());
    },
    [readOnly, currentValue]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    // A number input reports "" for anything it cannot parse ("5e"), so the
    // empty string alone cannot tell a CLEARED cell from a REJECTED one.
    rejectedRef.current = e.target.validity.badInput;
    setLocalValue(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => onCommitRef.current?.(val, rejectedRef.current),
      DEBOUNCE_MS
    );
  }, []);

  const handleBlur = useCallback(() => {
    clearTimeout(debounceRef.current);
    if (escapeRef.current) {
      onDiscard?.();
    } else if (localValue !== undefined) {
      onCommitRef.current?.(localValue, rejectedRef.current);
    }
    setLocalValue(undefined);
    escapeRef.current = false;
    rejectedRef.current = false;
  }, [localValue, onDiscard]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        escapeRef.current = true;
        e.currentTarget.blur();
        return;
      }
      // Vertical keys move BETWEEN cells here rather than within one: this is
      // a grid, the inputs are single-line (where ↑/↓ only jump to the ends of
      // the text), and entering one column down a phase is the estimator's
      // main motion. Each must commit first or the move would discard the
      // edit the user just typed.
      if (e.key === "Tab" || e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        clearTimeout(debounceRef.current);
        if (localValue !== undefined) onCommitRef.current?.(localValue, rejectedRef.current);
        setLocalValue(undefined);
        rejectedRef.current = false;
        onKeyDown?.(e);
      }
    },
    [localValue, onKeyDown]
  );

  // Read-only computed values
  if (readOnly) {
    return (
      <div
        className={cn(
          "flex h-full items-center px-2 text-xs tabular-nums",
          isNumber ? "justify-end font-mono text-muted-foreground" : "text-muted-foreground"
        )}
      >
        {formatDisplay(props) ||
          (props.type === "number" ? (
            <span className="text-foreground-subtle">{props.placeholder}</span>
          ) : null)}
      </div>
    );
  }

  // Editable cell — transforms from display to input on focus
  return (
    <input
      data-cell-id={cellId}
      // Numeric ONLY while it holds the raw value being edited: a number input
      // sanitizes away anything that is not a bare float, so the formatted idle
      // display ("$52.50", "1,200") would reach the DOM as an EMPTY cell.
      type={isNumber && isEditing ? "number" : "text"}
      step={isNumber && isEditing ? "any" : undefined}
      placeholder={props.type === "number" ? props.placeholder : undefined}
      value={isEditing ? localValue : formatDisplay(props)}
      readOnly={!isEditing}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className={cn(
        // Base
        "flex h-full w-full items-center border-0 bg-transparent px-2 text-xs outline-none",
        "tabular-nums transition-colors duration-100",
        // Number alignment
        isNumber && "text-right font-mono",
        // Idle state — editable cells look slightly bolder than read-only
        !isEditing && "font-medium text-foreground cursor-text",
        // Editing state — clear highlight
        isEditing && "bg-primary/10 text-foreground ring-2 ring-inset ring-primary/50",
        // appearance-none hides the number spinners AND, on WKWebView, the
        // native macOS focus halo that [appearance:textfield] re-enabled —
        // outline-none alone cannot suppress that ring.
        "appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      )}
    />
  );
});
