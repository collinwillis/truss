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
  /** Called when the user commits a value (blur or debounce). */
  onCommit: (value: string) => void;
  /** Called when the user presses Escape to discard the edit. */
  onDiscard?: () => void;
  /** Keyboard event handler for Tab/Enter navigation between cells. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Whether the cell is read-only (computed values). */
  readOnly?: boolean;
}

interface NumberCellProps extends EditableCellBaseProps {
  type: "number";
  value: number;
  displayFormat?: "plain" | "currency";
}

interface TextCellProps extends EditableCellBaseProps {
  type: "text";
  value: string;
}

export type EditableCellProps = NumberCellProps | TextCellProps;

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
  if (props.value === 0) return props.readOnly ? "—" : "0";
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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const isEditing = localValue !== undefined;
  const isNumber = props.type === "number";

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (readOnly) return;
      escapeRef.current = false;
      const raw = isNumber
        ? String((props as NumberCellProps).value)
        : (props as TextCellProps).value;
      setLocalValue(raw);
      requestAnimationFrame(() => e.target.select());
    },
    [
      readOnly,
      isNumber,
      isNumber ? (props as NumberCellProps).value : (props as TextCellProps).value,
    ]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalValue(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onCommitRef.current(val), DEBOUNCE_MS);
  }, []);

  const handleBlur = useCallback(() => {
    clearTimeout(debounceRef.current);
    if (escapeRef.current) {
      onDiscard?.();
    } else if (localValue !== undefined) {
      onCommitRef.current(localValue);
    }
    setLocalValue(undefined);
    escapeRef.current = false;
  }, [localValue, onDiscard]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        escapeRef.current = true;
        e.currentTarget.blur();
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        clearTimeout(debounceRef.current);
        if (localValue !== undefined) onCommitRef.current(localValue);
        setLocalValue(undefined);
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
        {formatDisplay(props)}
      </div>
    );
  }

  // Editable cell — transforms from display to input on focus
  return (
    <input
      data-cell-id={cellId}
      type={isNumber ? "number" : "text"}
      step={isNumber ? "any" : undefined}
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
        // Hide number spinners
        "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      )}
    />
  );
});
