import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@truss/ui/components/button";

/**
 * Detail item interface matching mock data structure.
 */
export interface DetailItem {
  id: string;
  wbsId: string;
  phaseId: string;
  description: string;
  quantity: number;
  unit: string;
  quantityComplete: number;
  quantityRemaining: number;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
}

export interface DetailTableProps {
  /** Array of detail items to display */
  items: DetailItem[];
}

/**
 * Create sortable column header button.
 *
 * Provides visual feedback for sorting state with arrow icon.
 */
function SortableHeader({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="h-auto p-0 hover:bg-transparent font-semibold"
    >
      {label}
      <ArrowUpDown className="ml-2 h-4 w-4" />
    </Button>
  );
}

/**
 * Detail table component for displaying work item details.
 *
 * Uses TanStack Table for sorting and data management.
 * Displays comprehensive work tracking data:
 * - Description
 * - Quantity (total, complete, remaining, unit)
 * - Man-hours (earned, total)
 * - Completion percentage
 *
 * Features:
 * - Sortable columns (click header to sort)
 * - Right-aligned numeric values for scanability
 * - Responsive design with horizontal scroll on mobile
 */
export function DetailTable({ items }: DetailTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const columns = React.useMemo<ColumnDef<DetailItem>[]>(
    () => [
      {
        accessorKey: "description",
        header: ({ column }) => (
          <SortableHeader
            label="Description"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          />
        ),
        cell: ({ row }) => <div className="font-medium">{row.getValue("description")}</div>,
      },
      {
        accessorKey: "quantity",
        header: ({ column }) => (
          <div className="text-right">
            <SortableHeader
              label="Qty"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            />
          </div>
        ),
        cell: ({ row }) => <div className="text-right font-mono">{row.getValue("quantity")}</div>,
      },
      {
        accessorKey: "unit",
        header: "Unit",
        cell: ({ row }) => (
          <div className="text-center font-medium text-muted-foreground">
            {row.getValue("unit")}
          </div>
        ),
      },
      {
        accessorKey: "quantityComplete",
        header: ({ column }) => (
          <div className="text-right">
            <SortableHeader
              label="Complete"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="text-right font-mono">{row.getValue("quantityComplete")}</div>
        ),
      },
      {
        accessorKey: "quantityRemaining",
        header: ({ column }) => (
          <div className="text-right">
            <SortableHeader
              label="Remaining"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="text-right font-mono text-muted-foreground">
            {row.getValue("quantityRemaining")}
          </div>
        ),
      },
      {
        accessorKey: "percentComplete",
        header: ({ column }) => (
          <div className="text-right">
            <SortableHeader
              label="% Complete"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            />
          </div>
        ),
        cell: ({ row }) => {
          const percent = row.getValue("percentComplete") as number;
          return (
            <div className="text-right font-semibold">
              <span
                className={
                  percent >= 80 ? "text-success" : percent >= 50 ? "text-warning" : "text-danger"
                }
              >
                {percent}%
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: "earnedMH",
        header: ({ column }) => (
          <div className="text-right">
            <SortableHeader
              label="MH Earned"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="text-right font-mono">
            {(row.getValue("earnedMH") as number).toFixed(1)}
          </div>
        ),
      },
      {
        accessorKey: "totalMH",
        header: ({ column }) => (
          <div className="text-right">
            <SortableHeader
              label="MH Total"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="text-right font-mono text-muted-foreground">
            {(row.getValue("totalMH") as number).toFixed(1)}
          </div>
        ),
      },
    ],
    []
  );

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No detail items found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
