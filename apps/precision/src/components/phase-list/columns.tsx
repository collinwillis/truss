import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Checkbox } from "@truss/ui/components/checkbox";
import { cn } from "@truss/ui/lib/utils";
import { CheckCircle2, Circle } from "lucide-react";
import type React from "react";
import { NumberCell } from "../activity-grid/cells";
import { cellId } from "../activity-grid/use-grid-navigation";
import { LABOR_CHANNEL, UNHIDEABLE, type PhaseColumnId } from "./visibility";

/**
 * The WBS cost report's columns — the WBS HOME sheet, column for column.
 *
 * This is InDemand's own sheet as they read it: one row per phase, their
 * fields, in their order. The order is theirs and is not negotiable by width;
 * CRAFT HR sits beside CRAFT TOTAL because that is how an estimator checks a
 * crew rate in their head.
 *
 * ⚠️ TWO COLUMNS ARE CALLED "TOTAL" AND THEY ARE DIFFERENT NUMBERS. The
 * spreadsheet gets away with the collision because a column's position is its
 * name; a screen that scrolls sideways cannot. Four devices separate them here,
 * and all four are load-bearing:
 *
 *   1. THE LABOR CHANNEL. CRAFT HR · CRAFT TOTAL · WELD HR · WELDER TOTAL ·
 *      LABOR TOTAL are bracketed by a hairline at each end and a tinted header,
 *      so the labor total is visibly the LAST CELL OF A GROUP rather than a
 *      column standing on its own.
 *   2. THE FROZEN EDGE. The grand total is pinned to the right of the grid and
 *      carries the pinned edge rule, so it is never adjacent to the labor total
 *      and never scrolls away from it either.
 *   3. THE DOLLAR SIGN. The grand total is the ONLY column drawn with a
 *      currency symbol — twelve columns of "$" is a wall of punctuation nobody
 *      reads, but one is a landmark.
 *   4. WEIGHT AND NAME. "LABOR TOTAL" in medium, "TOTAL" in semibold.
 *
 * ⚠️ THE GRAND TOTAL IS THE SERVER'S FIGURE AND IS NEVER RE-DERIVED FROM THE
 * COLUMNS BESIDE IT. A subcontractor line reports its craft, material and
 * equipment legs into those columns while its TOTAL is the sub price alone
 * (see costEngine::computeActivityCosts), so adding the money columns across a
 * phase that holds subs would overstate it. Read the column; do not add the row.
 *
 * ⚠️ HOURS AND DOLLARS INTERLEAVE, SO THEY MUST NOT LOOK ALIKE. Hours always
 * carry one decimal place where money never carries any, so the two populations
 * stay apart even where the heading has scrolled out of view.
 *
 * @module
 */

/** One row of the report: a phase, and what it costs. */
export interface PhaseRow {
  _id: Id<"phases">;
  phasePoolId: number;
  /** The catalog name of the phase type, e.g. CARBON STEEL. */
  poolName: string;
  phaseNumber: number;
  description: string;
  area: string | null;
  sheet: number | null;
  pipingSpec: {
    size?: string;
    spec?: string;
    flc?: string;
    system?: string;
    insulation?: string;
    insulationSize?: number;
  } | null;
  status: string | null;
  isCompleted: boolean;
  sortOrder: number;
  activityCount: number;
  /**
   * `null` means this phase TYPE has no takeoff — a dash, never a zero. See
   * model/takeoff.ts: the quantity derives from lines flagged in the labor
   * catalog, and `isOverridden` marks one the estimator typed instead.
   */
  takeoff: { quantity: number; unit: string; isOverridden: boolean } | null;
  costs: {
    craftManHours: number;
    welderManHours: number;
    craftCost: number;
    welderCost: number;
    materialCost: number;
    equipmentCost: number;
    subcontractorCost: number;
    costOnlyCost: number;
    totalCost: number;
  };
}

/** Per-column drawing hints, read by the grid when it lays out a cell. */
export interface PhaseColumnMeta {
  align?: "right" | "center";
  /**
   * Cells that own their own clicks. The row opens the phase, so a checkbox or
   * an editable quantity has to stop the event before it navigates away from
   * the edit the estimator just started.
   */
  interactive?: boolean;
  /**
   * The cell brings its own padding — `EditableCell` renders a full-bleed input
   * with `px-2` of its own, and a second inset from the container would push
   * the figure out of line with the money columns beside it.
   */
  selfPadded?: boolean;
}

/** Menu labels — the header cells are elements, so they cannot be reused. */
export const PHASE_COLUMN_LABELS: Record<string, string> = {
  completed: "Completed",
  phase: "Phase",
  size: "Size",
  flc: "FLC",
  description: "Line / Descrip",
  spec: "Spec",
  insulation: "Insul",
  insulationSize: "Insl. Size",
  sheet: "Sht",
  area: "Area",
  status: "Status",
  sys: "Sys",
  quantity: "Qty",
  unit: "Unit",
  craftHours: "Craft HR",
  craftCost: "Craft Total",
  welderHours: "Weld HR",
  welderCost: "Welder Total",
  laborTotal: "Labor Total",
  materialCost: "Material",
  equipmentCost: "Equipment",
  subcontractorCost: "Subcontract",
  costOnlyCost: "Cost Only",
  totalCost: "Total",
};

/** Dollars without the symbol — everywhere but the grand total. */
const moneyFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Dollars WITH the symbol — the grand total's landmark, and the totals row. */
const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Always one decimal, even on a whole number.
 *
 * The trailing ".0" is the point: every hour figure ends in a decimal and no
 * money figure ever does.
 */
const hoursFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Takeoff quantities are whatever the estimator measured — CY and EA differ. */
const quantityFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * A zero reads as an absence, not as a number worth aligning against.
 *
 * It carries no tooltip of its own: an em-dash is a few pixels wide, so
 * anything that needs explaining is explained by the CELL around it.
 */
function Blank(): React.ReactElement {
  return <span className="text-foreground-subtle">—</span>;
}

/**
 * ⚠️ EVERY FIGURE IS `font-mono tabular-nums`, WITHOUT EXCEPTION.
 *
 * The quantity cell is an `EditableCell`, which draws its number in the mono
 * face; so does the activity grid one drill-down down, and so does the totals
 * chip in the toolbar. A money column set in the UI face beside them reads as
 * a different KIND of number, and on a report whose whole job is columns of
 * figures that is the difference between a grid and a spreadsheet.
 */
function MoneyCell({ value, strong }: { value: number; strong?: boolean }): React.ReactElement {
  if (value === 0) return <Blank />;
  return (
    <span className={cn("font-mono tabular-nums", strong && "font-medium")}>
      {moneyFmt.format(value)}
    </span>
  );
}

function HoursCell({ value }: { value: number }): React.ReactElement {
  if (value === 0) return <Blank />;
  return (
    <span className="font-mono tabular-nums text-muted-foreground">{hoursFmt.format(value)}</span>
  );
}

/**
 * A short free-text field: blank rather than a dash, so a sparse column is quiet.
 *
 * Named for what it holds rather than for its type — `TextCell` is already an
 * EDITABLE input in activity-grid/cells.tsx, and two things with one name is
 * how the wrong one gets imported.
 */
function LabelCell({ value }: { value: string | null }): React.ReactElement {
  return (
    <span className="truncate text-muted-foreground" title={value ?? undefined}>
      {value ?? ""}
    </span>
  );
}

/** Volatile values the cells read at the moment they render. */
export interface PhaseListContext {
  /** Route param for the drill-down link in every row. */
  estimateId: string;
  canEdit: boolean;
  /** Mark the phase done, or put it back — `phases.isCompleted`. */
  onToggleCompleted: (row: PhaseRow, next: boolean) => void;
  /** Commit a takeoff override; an empty cell clears back to the derived sum. */
  onCommitTakeoff: (row: PhaseRow, raw: string, rejected?: boolean) => void;
  /** Spreadsheet movement, from `useGridNavigation`. */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Build the column defs ONCE, reading volatile values through a ref.
 *
 * ⚠️ THE RETURNED ARRAY MUST BE STABLE. TanStack's `flexRender` treats each
 * column's `cell` function as a React COMPONENT TYPE, so rebuilding the array
 * gives every cell a new type and React unmounts and remounts all of them —
 * which destroys the focused quantity input the moment a debounced save
 * round-trips. Everything that moves travels through `ctx`, refreshed each
 * render and read at cell-render time. Same arrangement as `buildLogColumns`
 * and `buildCatalogColumns`, for the same reason.
 */
export function buildPhaseColumns(
  withSelection: boolean,
  ctx: { current: PhaseListContext }
): ColumnDef<PhaseRow>[] {
  /** A read-only money column. */
  const money = (
    id: PhaseColumnId,
    header: string,
    read: (row: PhaseRow) => number,
    size: number
  ): ColumnDef<PhaseRow> => ({
    id,
    accessorFn: read,
    header,
    size,
    enableHiding: !UNHIDEABLE.has(id),
    meta: { align: "right" } satisfies PhaseColumnMeta,
    cell: ({ row }) => <MoneyCell value={read(row.original)} />,
  });

  /** A read-only man-hour column. */
  const hours = (
    id: PhaseColumnId,
    header: string,
    read: (row: PhaseRow) => number,
    size: number
  ): ColumnDef<PhaseRow> => ({
    id,
    accessorFn: read,
    header,
    size,
    meta: { align: "right" } satisfies PhaseColumnMeta,
    cell: ({ row }) => <HoursCell value={read(row.original)} />,
  });

  /** A read-only free-text column. */
  const text = (
    id: PhaseColumnId,
    header: string,
    read: (row: PhaseRow) => string | null,
    size: number
  ): ColumnDef<PhaseRow> => ({
    id,
    accessorFn: (row) => read(row) ?? undefined,
    header,
    size,
    cell: ({ row }) => <LabelCell value={read(row.original)} />,
  });

  return [
    // Selection exists only to feed Duplicate and Delete, so the whole column
    // goes with them below "write".
    ...(withSelection
      ? [
          {
            id: "select",
            size: 34,
            minSize: 34,
            enableHiding: false,
            enableResizing: false,
            meta: { align: "center", interactive: true } satisfies PhaseColumnMeta,
            header: ({ table }) => (
              <Checkbox
                aria-label="Select every phase"
                checked={
                  table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")
                }
                onCheckedChange={(value) => table.toggleAllRowsSelected(value === true)}
                // The activity grid's size, deliberately: the two grids are one
                // drill-down apart and the same control has to be the same size
                // on both, or the trip down reads as a different application.
                className="h-4 w-4"
              />
            ),
            cell: ({ row }) => (
              <Checkbox
                aria-label={`Select phase ${row.original.phaseNumber}`}
                checked={row.getIsSelected()}
                onCheckedChange={(value) => row.toggleSelected(value === true)}
                className="h-4 w-4"
              />
            ),
          } satisfies ColumnDef<PhaseRow>,
        ]
      : []),
    {
      id: "completed",
      accessorFn: (row) => row.isCompleted,
      size: 34,
      minSize: 34,
      enableResizing: false,
      meta: { align: "center", interactive: true } satisfies PhaseColumnMeta,
      // A ring, not a tick, in the header: "COMPLETED" cannot be read at this
      // width and the glyph is the same one every row below it draws.
      header: () => (
        <span title="Completed" aria-label="Completed">
          <CheckCircle2 className="h-3 w-3" />
        </span>
      ),
      cell: ({ row }) => {
        const done = row.original.isCompleted;
        const Icon = done ? CheckCircle2 : Circle;
        const glyph = (
          <Icon
            className={cn("h-3.5 w-3.5", done ? "text-success-text" : "text-foreground-subtle")}
          />
        );
        // A circle rather than a checkbox, deliberately: the square checkbox
        // one column to the left means "acted on by the toolbar", and two
        // identical controls side by side would be two ways to say two things.
        if (!ctx.current.canEdit)
          return <span title={done ? "Completed" : "Not completed"}>{glyph}</span>;
        return (
          <button
            type="button"
            title={done ? "Completed — click to reopen" : "Mark this phase completed"}
            aria-label={done ? "Mark phase not completed" : "Mark phase completed"}
            aria-pressed={done}
            onClick={() => ctx.current.onToggleCompleted(row.original, !done)}
            className="flex items-center rounded-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {glyph}
          </button>
        );
      },
    },
    {
      id: "phase",
      accessorFn: (row) => row.phaseNumber,
      header: "Phase",
      size: 168,
      minSize: 120,
      enableHiding: false,
      cell: ({ row }) => (
        // A real link inside the row, not only the row's click handler: it is
        // the sole keyboard route into a phase, and it is what a right-click
        // "open" expects to find.
        <Link
          to="/estimate/$estimateId/phase/$phaseId"
          params={{ estimateId: ctx.current.estimateId, phaseId: row.original._id }}
          // The row navigates to the same place; letting both fire would push
          // two identical history entries for one click.
          onClick={(event) => event.stopPropagation()}
          className="flex min-w-0 items-center gap-1.5 rounded-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="shrink-0 font-mono tabular-nums text-foreground-subtle">
            {row.original.phaseNumber}
          </span>
          <span className="truncate text-muted-foreground" title={row.original.poolName}>
            {row.original.poolName}
          </span>
        </Link>
      ),
    },
    text("size", "Size", (row) => row.pipingSpec?.size ?? null, 68),
    text("flc", "FLC", (row) => row.pipingSpec?.flc ?? null, 60),
    {
      id: "description",
      accessorKey: "description",
      header: "Line / Descrip",
      // A real width, used only once the estimator drags it. Until then the
      // column is `auto` and absorbs the leftover row — see the route.
      size: 260,
      minSize: 160,
      enableHiding: false,
      cell: ({ row }) => (
        <span className="truncate font-medium" title={row.original.description}>
          {row.original.description}
        </span>
      ),
    },
    text("spec", "Spec", (row) => row.pipingSpec?.spec ?? null, 72),
    text("insulation", "Insul", (row) => row.pipingSpec?.insulation ?? null, 72),
    {
      id: "insulationSize",
      accessorFn: (row) => row.pipingSpec?.insulationSize,
      header: "Insl. Size",
      size: 82,
      meta: { align: "right" } satisfies PhaseColumnMeta,
      // ⚠️ EMPTY, NOT A DASH — the rule for all six piping columns. A dash says
      // "there is nothing to state here", which is what QTY says on a phase type
      // that is not measured. These six are identifiers somebody types, and on a
      // fresh piping breakdown nobody has yet: a column of dashes down the two
      // least-filled fields would be the loudest thing on the emptiest report.
      cell: ({ row }) => {
        const value = row.original.pipingSpec?.insulationSize;
        if (value === undefined) return null;
        return (
          <span className="font-mono tabular-nums text-muted-foreground">
            {quantityFmt.format(value)}
          </span>
        );
      },
    },
    {
      id: "sheet",
      accessorFn: (row) => row.sheet ?? undefined,
      header: "Sht",
      size: 56,
      meta: { align: "right" } satisfies PhaseColumnMeta,
      cell: ({ row }) =>
        row.original.sheet === null ? null : (
          <span className="font-mono tabular-nums text-muted-foreground">{row.original.sheet}</span>
        ),
    },
    text("area", "Area", (row) => row.area, 84),
    text("status", "Status", (row) => row.status, 88),
    text("sys", "Sys", (row) => row.pipingSpec?.system ?? null, 72),
    {
      id: "quantity",
      accessorFn: (row) => row.takeoff?.quantity,
      header: "Qty",
      size: 82,
      meta: { align: "right", interactive: true, selfPadded: true } satisfies PhaseColumnMeta,
      cell: ({ row }) => {
        const takeoff = row.original.takeoff;
        // ⚠️ NO TAKEOFF IS NOT ZERO. This phase type is not measured in
        // anything — there is no quantity to derive and none to type — so the
        // cell says so rather than reporting a total of nothing.
        if (!takeoff) {
          return (
            // The tooltip is on the CELL, not on the em-dash — same reason as
            // the override dot below.
            <span
              className="flex h-full w-full items-center justify-end px-2"
              title="This phase type has no takeoff quantity"
            >
              <Blank />
            </span>
          );
        }
        return (
          // THE TOOLTIP IS ON THE CELL, NOT ON THE DOT. The dot is 4px square;
          // asking somebody to hover it to learn what it means is asking them
          // not to. `title` resolves to the nearest ancestor that has one, so
          // anywhere in the cell — the figure included — explains itself.
          <span
            className="relative flex h-full w-full items-center"
            title={
              takeoff.isOverridden
                ? "Typed by the estimator — clear the cell to return to the computed sum"
                : undefined
            }
          >
            {takeoff.isOverridden && (
              // The same 4px primary dot the column menu uses for "customised",
              // so "somebody chose this, it is not the default" reads
              // identically across the app. Out of the flow, so it cannot
              // squeeze the figure it annotates — and inset from the cell edge,
              // because flush against the column boundary it would look like it
              // belonged to the column on the left.
              <span className="absolute left-1.5 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-primary" />
            )}
            <NumberCell
              editable={ctx.current.canEdit}
              cellId={cellId(row.original._id, "quantity")}
              value={takeoff.quantity}
              onCommit={(raw, rejected) => ctx.current.onCommitTakeoff(row.original, raw, rejected)}
              onKeyDown={ctx.current.onKeyDown}
            />
          </span>
        );
      },
    },
    {
      id: "unit",
      accessorFn: (row) => row.takeoff?.unit,
      header: "Unit",
      size: 52,
      cell: ({ row }) => (
        // Blank rather than a dash: the QTY beside it has already said whether
        // this phase is measured at all, and saying so twice is noise.
        <span className="truncate text-muted-foreground">{row.original.takeoff?.unit ?? ""}</span>
      ),
    },
    hours("craftHours", "Craft HR", (row) => row.costs.craftManHours, 78),
    money("craftCost", "Craft Total", (row) => row.costs.craftCost, 92),
    hours("welderHours", "Weld HR", (row) => row.costs.welderManHours, 76),
    money("welderCost", "Welder Total", (row) => row.costs.welderCost, 96),
    {
      id: "laborTotal",
      accessorFn: (row) => row.costs.craftCost + row.costs.welderCost,
      header: "Labor Total",
      size: 96,
      meta: { align: "right" } satisfies PhaseColumnMeta,
      cell: ({ row }) => (
        <span title="Craft plus welder — the labor half of this phase, not its grand total">
          <MoneyCell value={row.original.costs.craftCost + row.original.costs.welderCost} strong />
        </span>
      ),
    },
    money("materialCost", "Material", (row) => row.costs.materialCost, 88),
    money("equipmentCost", "Equipment", (row) => row.costs.equipmentCost, 92),
    money("subcontractorCost", "Subcontract", (row) => row.costs.subcontractorCost, 98),
    money("costOnlyCost", "Cost Only", (row) => row.costs.costOnlyCost, 88),
    {
      id: "totalCost",
      accessorFn: (row) => row.costs.totalCost,
      header: "Total",
      size: 104,
      enableHiding: false,
      meta: { align: "right" } satisfies PhaseColumnMeta,
      cell: ({ row }) => {
        const value = row.original.costs.totalCost;
        return (
          <span
            className="font-mono font-semibold tabular-nums"
            title="Everything this phase costs — the figure that rolls up into the bid"
          >
            {value === 0 ? <Blank /> : currencyFmt.format(value)}
          </span>
        );
      },
    },
  ];
}

/**
 * The hairlines that bracket the labor channel.
 *
 * Computed against the VISIBLE columns rather than the declared ones, so
 * hiding WELD HR moves the bracket instead of leaving it floating around a
 * column that is no longer there. Labor columns are never pinned, so this can
 * own `boxShadow` without colliding with the pinned edge rules.
 */
export function laborChannelEdges(visibleColumnIds: readonly string[]): {
  first?: string;
  last?: string;
} {
  const inChannel = visibleColumnIds.filter((id) => LABOR_CHANNEL.has(id as PhaseColumnId));
  return { first: inChannel[0], last: inChannel[inChannel.length - 1] };
}

/**
 * ⚠️ THIS GOES ON THE CELL'S CONTENT LAYER, NOT ON THE `<td>`.
 *
 * An inset box-shadow paints above the element's own background but BELOW a
 * child's, and every cell here has a child that carries the row's hover and
 * selection tints. On the `<td>` the bracket therefore VANISHED the moment the
 * pointer entered the row or the row was selected — which is exactly when
 * somebody is reading across it to tell the labor total from the grand total.
 */
export function laborChannelStyle(
  columnId: string,
  edges: { first?: string; last?: string }
): React.CSSProperties {
  const rules: string[] = [];
  if (columnId === edges.first) rules.push("inset 1px 0 0 var(--border-strong)");
  if (columnId === edges.last) rules.push("inset -1px 0 0 var(--border-strong)");
  return rules.length > 0 ? { boxShadow: rules.join(", ") } : {};
}

/** The breakdown's own totals — one object, shared by the totals row and the inspector. */
export interface PhaseListTotals {
  phaseCount: number;
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

/**
 * What one column contributes to the totals row.
 *
 * Reads the SAME object the inspector's scope panel reads, so the figure at
 * the foot of the grid and the figure in the panel beside it cannot disagree —
 * which is the whole job of a totals row.
 *
 * QTY and UNIT are deliberately absent: one breakdown spans phases measured in
 * CY, LF and EA, and a column of quantities in three units has no sum. A number
 * there would be arithmetic nobody asked for.
 */
export function phaseTotalsCell(columnId: string, totals: PhaseListTotals): React.ReactNode {
  switch (columnId) {
    case "phase":
      return (
        <span className="text-footnote font-semibold uppercase tracking-wide text-muted-foreground">
          {totals.phaseCount} {totals.phaseCount === 1 ? "phase" : "phases"}
        </span>
      );
    case "craftHours":
      return <HoursCell value={totals.craftManHours} />;
    case "craftCost":
      return <MoneyCell value={totals.craftCost} strong />;
    case "welderHours":
      return <HoursCell value={totals.welderManHours} />;
    case "welderCost":
      return <MoneyCell value={totals.welderCost} strong />;
    case "laborTotal":
      return <MoneyCell value={totals.craftCost + totals.welderCost} strong />;
    case "materialCost":
      return <MoneyCell value={totals.materialCost} strong />;
    case "equipmentCost":
      return <MoneyCell value={totals.equipmentCost} strong />;
    case "subcontractorCost":
      return <MoneyCell value={totals.subcontractorCost} strong />;
    case "costOnlyCost":
      return <MoneyCell value={totals.costOnlyCost} strong />;
    case "totalCost":
      return (
        <span className="font-mono font-semibold tabular-nums">
          {currencyFmt.format(totals.totalCost)}
        </span>
      );
    default:
      return null;
  }
}
