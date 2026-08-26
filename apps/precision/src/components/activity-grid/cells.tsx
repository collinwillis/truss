import { EditableCell } from "@truss/features/estimation/editable-cell";
import type React from "react";

/**
 * Cells whose editability is decided per ROW.
 *
 * `EditableCellProps` is a discriminated union — a read-only cell must not
 * carry `onCommit` at all — so the choice cannot be expressed by spreading a
 * conditional object. These render the correct arm explicitly, which keeps the
 * union's guarantee (a read-only cell has no commit path) rather than casting
 * it away.
 */

export function NumberCell({
  editable,
  cellId,
  value,
  currency,
  placeholder,
  onCommit,
  onKeyDown,
}: {
  editable: boolean;
  cellId: string;
  value: number | null;
  currency?: boolean;
  placeholder?: string;
  onCommit: (raw: string, rejected?: boolean) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const shared = {
    type: "number" as const,
    cellId,
    value,
    displayFormat: currency ? ("currency" as const) : ("plain" as const),
    placeholder,
  };
  if (!editable) return <EditableCell {...shared} readOnly />;
  return <EditableCell {...shared} onCommit={onCommit} onKeyDown={onKeyDown} />;
}

export function TextCell({
  editable,
  cellId,
  value,
  onCommit,
  onKeyDown,
}: {
  editable: boolean;
  cellId: string;
  value: string;
  onCommit: (raw: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const shared = { type: "text" as const, cellId, value };
  if (!editable) return <EditableCell {...shared} readOnly />;
  return <EditableCell {...shared} onCommit={onCommit} onKeyDown={onKeyDown} />;
}
