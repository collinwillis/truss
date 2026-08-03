import type { Table } from "@tanstack/react-table";
import { Button } from "@truss/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@truss/ui/components/dropdown-menu";
import { Columns3 } from "lucide-react";

/**
 * Show/hide any column the phase's defaults left out.
 *
 * The defaults are deliberately quiet (see visibility.ts), so this is the way
 * back to anything they hid — and the way to hide something they showed. A
 * choice made here is remembered for the whole WBS; "Reset to defaults" hands
 * the column back to the automatic rules, so it resumes appearing when the
 * data calls for it.
 *
 * ⚠️ NOT `column.getToggleVisibilityHandler()`: that handler reads
 * `event.target.checked`, and Radix's checkbox item hands its callback a
 * BOOLEAN, not an event — wiring the two together sets visibility to
 * `undefined`. `toggleVisibility(value)` is the documented call for a
 * non-native control.
 */
export function ColumnMenu<TData>({
  table,
  labelFor,
  onReset,
  isCustomized,
  label = "Columns in this work breakdown",
}: {
  table: Table<TData>;
  /** Human label for a column id — the header cell may be an element. */
  labelFor: (columnId: string) => string;
  onReset: () => void;
  isCustomized: boolean;
  /** Menu heading — names the scope the choice will be remembered for. */
  label?: string;
}) {
  // Leaf columns, per the docs: `getIsVisible()` on a group column reports
  // "some child visible", which would make its checkbox lie.
  const columns = table.getAllLeafColumns().filter((column) => column.getCanHide());

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="lg"
          title="Show or hide columns"
          aria-label="Show or hide columns"
        >
          <Columns3 className="h-3.5 w-3.5" />
          {isCustomized && <span className="h-1 w-1 rounded-full bg-primary" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[420px] w-56 overflow-y-auto">
        <DropdownMenuLabel className="text-footnote font-normal text-muted-foreground">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(checked) => column.toggleVisibility(checked)}
            // Closing on every tick makes setting up a view a chore.
            onSelect={(event) => event.preventDefault()}
          >
            {labelFor(column.id)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!isCustomized} onClick={onReset}>
          Reset to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
