import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Checkbox } from "@truss/ui/components/checkbox";
import { cn } from "@truss/ui/lib/utils";
import { CheckCircle2, Circle } from "lucide-react";
import type React from "react";
import { NumberCell, TextCell } from "../activity-grid/cells";
import { cellId } from "../activity-grid/use-grid-navigation";
import { Blank, HoursCell, MoneyCell, quantityFmt, TotalCell } from "../grid-figures";
import type { EditablePhaseColumnId } from "./edits";
import { LABOR_CHANNEL, UNHIDEABLE, type PhaseColumnId } from "./visibility";

/**
 * The WBS cost report's columns — the WBS HOME sheet, column for column.
 *
 * This is InDemand's own sheet as they read it: one row per phase, their
 * fields, in their order. The order is theirs and is not negotiable by width;
 * CRAFT MH sits beside CRAFT $ because that is how an estimator checks a crew
 * rate in their head.
 *
 * ⚠️ ONE VOCABULARY ACROSS THREE TABLES. Hours are MH and money carries a
 * trailing $, exactly as the overview and the activity grid spell them — this
 * sheet said CRAFT HR and CRAFT TOTAL until the vocabulary pass reached it, and
 * an estimator walking one drill-down should never have to learn a second name
 * for the same figure.
 *
 * ⚠️ EVERY ATTRIBUTE IS TYPED IN PLACE; NOTHING COMPUTED IS. What an estimator
 * STATES about a phase — its number, description, area, status, sheet, the six
 * piping members and its takeoff — is an input here, through the same
 * EditableCell the activity grid uses. Every hours and money column is
 * read-only: they roll up from the activities beneath, and a typed phase total
 * would be a second source of truth for a number the engine owns. See
 * `edits.ts` for what one keystroke means.
 *
 * ⚠️ TWO COLUMNS COULD BE READ AS "THE TOTAL" AND THEY ARE DIFFERENT NUMBERS.
 * The spreadsheet gets away with the collision because a column's position is
 * its name; a screen that scrolls sideways cannot. Four devices separate them
 * here, and all four are load-bearing:
 *
 *   1. THE LABOR CHANNEL. CRAFT MH · CRAFT $ · WELD MH · WELD $ · LABOR $ are
 *      bracketed by a hairline at each end and a tinted header, so the labor
 *      total is visibly the LAST CELL OF A GROUP rather than a column standing
 *      on its own.
 *   2. THE FROZEN EDGE. The grand total is pinned to the right of the grid and
 *      carries the pinned edge rule, so it is never adjacent to the labor total
 *      and never scrolls away from it either.
 *   3. THE DOLLAR SIGN. The grand total is the ONLY column drawn with a
 *      currency symbol — twelve columns of "$" is a wall of punctuation nobody
 *      reads, but one is a landmark.
 *   4. WEIGHT AND NAME. "LABOR $" names its channel in medium; "TOTAL" is bare
 *      and semibold.
 *
 * ⚠️ THE GRAND TOTAL IS THE SERVER'S FIGURE AND IS NEVER RE-DERIVED FROM THE
 * COLUMNS BESIDE IT. A subcontractor line reports its craft, material and
 * equipment legs into those columns while its TOTAL is the sub price alone
 * (see costEngine::computeActivityCosts), so adding the money columns across a
 * phase that holds subs would overstate it. Read the column; do not add the row.
 *
 * ⚠️ HOURS AND DOLLARS INTERLEAVE, SO THEY MUST NOT LOOK ALIKE. Hours always
 * carry one decimal place where money never carries any, so the two populations
 * stay apart even where the heading has scrolled out of view. Every figure on
 * this sheet is drawn by `../grid-figures`, which is where that rule and the
 * currency symbol's one appearance are enforced for all three reports at once.
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
   * Cells that own their own clicks. The row opens the phase, so a checkbox, a
   * completion ring or any cell an estimator can type into has to stop the
   * event before it navigates away from the edit they just started.
   *
   * The ten hours and money columns stay non-interactive, so the right half of
   * every row still drills in — and the PHASE column carries a real link, which
   * is the keyboard route in either way.
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
  craftHours: "Craft MH",
  craftCost: "Craft $",
  welderHours: "Weld MH",
  welderCost: "Weld $",
  laborTotal: "Labor $",
  materialCost: "Material $",
  equipmentCost: "Equipment $",
  subcontractorCost: "Sub $",
  costOnlyCost: "Cost Only",
  totalCost: "Total",
};

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
  /**
   * Commit one attribute cell. An emptied cell CLEARS the field rather than
   * storing a blank; `buildPhaseEdit` owns that reading.
   */
  onCommitField: (
    row: PhaseRow,
    columnId: EditablePhaseColumnId,
    raw: string,
    rejected?: boolean
  ) => void;
  /** Spreadsheet movement, from `useGridNavigation`. */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Build the column defs ONCE, reading volatile values through a ref.
 *
 * ⚠️ THE RETURNED ARRAY MUST BE STABLE. TanStack's `flexRender` treats each
 * column's `cell` function as a React COMPONENT TYPE, so rebuilding the array
 * gives every cell a new type and React unmounts and remounts all of them —
 * which destroys the focused input the moment a debounced save round-trips.
 * Everything that moves travels through `ctx`, refreshed each render and read
 * at cell-render time. Same arrangement as `buildLogColumns` and
 * `buildCatalogColumns`, for the same reason.
 *
 * ⚠️ `canEdit` IS A BUILD ARGUMENT, NOT A CELL-TIME ONE, and that is deliberate:
 * whether a column is an INPUT at all decides the cell's padding and whether it
 * swallows the row's click, both of which live in `meta` and cannot vary by
 * row. Permission changes rarely and rebuilds the array when it does; the ref
 * carries what changes per keystroke.
 */
export function buildPhaseColumns(
  canEdit: boolean,
  ctx: { current: PhaseListContext }
): ColumnDef<PhaseRow>[] {
  /** Meta for a cell that becomes an input — see {@link PhaseColumnMeta}. */
  const editableMeta = (align?: PhaseColumnMeta["align"]): PhaseColumnMeta =>
    canEdit ? { align, interactive: true, selfPadded: true } : { align };

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

  /**
   * A free-text attribute — an input where the estimator may type, a label
   * where they may not.
   *
   * Emptying one CLEARS the field rather than storing `""`; `buildPhaseEdit`
   * owns that reading, and it is the whole reason these cells go through a
   * commit handler instead of writing what they hold.
   */
  const text = (
    id: EditablePhaseColumnId,
    header: string,
    read: (row: PhaseRow) => string | null,
    size: number
  ): ColumnDef<PhaseRow> => ({
    id,
    accessorFn: (row) => read(row) ?? undefined,
    header,
    size,
    meta: editableMeta(),
    cell: canEdit
      ? ({ row }) => (
          <TextCell
            editable
            cellId={cellId(row.original._id, id)}
            value={read(row.original) ?? ""}
            onCommit={(raw) => ctx.current.onCommitField(row.original, id, raw)}
            onKeyDown={ctx.current.onKeyDown}
          />
        )
      : ({ row }) => <LabelCell value={read(row.original)} />,
  });

  /**
   * A numeric attribute — a figure somebody TYPES, not one that is computed.
   *
   * ⚠️ EMPTY, NOT A DASH, where there is nothing: these are identifiers off a
   * drawing, and a dash claims "there is nothing to state here", which is what
   * QTY says on a phase type that is not measured. `NumberCell` renders `null`
   * as an empty cell for the same reason.
   */
  const attribute = (
    id: EditablePhaseColumnId,
    header: string,
    read: (row: PhaseRow) => number | null,
    format: (value: number) => string,
    size: number
  ): ColumnDef<PhaseRow> => ({
    id,
    accessorFn: (row) => read(row) ?? undefined,
    header,
    size,
    meta: editableMeta("right"),
    cell: canEdit
      ? ({ row }) => (
          <NumberCell
            editable
            cellId={cellId(row.original._id, id)}
            value={read(row.original)}
            onCommit={(raw, rejected) => ctx.current.onCommitField(row.original, id, raw, rejected)}
            onKeyDown={ctx.current.onKeyDown}
          />
        )
      : ({ row }) => {
          const value = read(row.original);
          if (value === null) return null;
          return (
            <span className="font-mono tabular-nums text-muted-foreground">{format(value)}</span>
          );
        },
  });

  return [
    // Selection exists only to feed Duplicate and Delete, so the whole column
    // goes with them below "write".
    ...(canEdit
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
      meta: editableMeta(),
      // THE NUMBER IS TYPED WHERE IT IS READ. Legacy gave PHASE # a column of
      // its own; splitting it back out would put the row's identity on screen
      // twice, so the input sits in a fixed gutter and the catalog name beside
      // it keeps the link.
      cell: canEdit
        ? ({ row }) => (
            <span className="flex h-full w-full min-w-0 items-center">
              {/* A gutter wide enough for the five-digit numbers this business
                  actually uses — phase numbers derive from the WBS code. */}
              <span className="w-16 shrink-0">
                <NumberCell
                  editable
                  cellId={cellId(row.original._id, "phase")}
                  value={row.original.phaseNumber}
                  onCommit={(raw, rejected) =>
                    ctx.current.onCommitField(row.original, "phase", raw, rejected)
                  }
                  onKeyDown={ctx.current.onKeyDown}
                />
              </span>
              <Link
                to="/estimate/$estimateId/phase/$phaseId"
                params={{ estimateId: ctx.current.estimateId, phaseId: row.original._id }}
                onClick={(event) => event.stopPropagation()}
                className="flex min-w-0 flex-1 items-center rounded-sm pr-2 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate text-muted-foreground" title={row.original.poolName}>
                  {row.original.poolName}
                </span>
              </Link>
            </span>
          )
        : ({ row }) => (
            // A real link inside the row, not only the row's click handler: it
            // is the sole keyboard route into a phase, and it is what a
            // right-click "open" expects to find.
            <Link
              to="/estimate/$estimateId/phase/$phaseId"
              params={{ estimateId: ctx.current.estimateId, phaseId: row.original._id }}
              // The row navigates to the same place; letting both fire would
              // push two identical history entries for one click.
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
      meta: editableMeta(),
      cell: canEdit
        ? ({ row }) => (
            <TextCell
              editable
              cellId={cellId(row.original._id, "description")}
              value={row.original.description}
              onCommit={(raw) => ctx.current.onCommitField(row.original, "description", raw)}
              onKeyDown={ctx.current.onKeyDown}
            />
          )
        : ({ row }) => (
            <span className="truncate font-medium" title={row.original.description}>
              {row.original.description}
            </span>
          ),
    },
    text("spec", "Spec", (row) => row.pipingSpec?.spec ?? null, 72),
    text("insulation", "Insul", (row) => row.pipingSpec?.insulation ?? null, 72),
    attribute(
      "insulationSize",
      "Insl. Size",
      (row) => row.pipingSpec?.insulationSize ?? null,
      (value) => quantityFmt.format(value),
      82
    ),
    // A sheet number is a label off a drawing, not a measurement, so it is
    // printed as typed — "1200", never "1,200".
    attribute("sheet", "Sht", (row) => row.sheet, String, 56),
    text("area", "Area", (row) => row.area, 84),
    text("status", "Status", (row) => row.status, 88),
    text("sys", "Sys", (row) => row.pipingSpec?.system ?? null, 72),
    {
      id: "quantity",
      accessorFn: (row) => row.takeoff?.quantity,
      header: "Qty",
      size: 82,
      // An EditableCell in BOTH modes — its read-only arm brings the same
      // padding its input does — so the cell is self-padded whatever the
      // permission, and only the click-swallowing follows canEdit.
      meta: { align: "right", interactive: canEdit, selfPadded: true } satisfies PhaseColumnMeta,
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
              editable={canEdit}
              cellId={cellId(row.original._id, "quantity")}
              value={takeoff.quantity}
              onCommit={(raw, rejected) =>
                ctx.current.onCommitField(row.original, "quantity", raw, rejected)
              }
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
      meta: editableMeta(),
      cell: ({ row }) => {
        const takeoff = row.original.takeoff;
        // ⚠️ NO INPUT WITHOUT A TAKEOFF. Typing a unit onto a phase type that
        // has none would MANUFACTURE one — `computePhaseTakeoff` reads a stored
        // unit as proof the phase is measured, and the row would start
        // reporting a quantity of 0 where it correctly prints a dash.
        if (!canEdit || !takeoff) {
          // Blank rather than a dash: the QTY beside it has already said
          // whether this phase is measured at all, and saying so twice is
          // noise.
          return (
            <span
              className={cn(
                "flex h-full w-full items-center truncate text-muted-foreground",
                canEdit && "px-2"
              )}
            >
              {takeoff?.unit ?? ""}
            </span>
          );
        }
        return (
          <TextCell
            editable
            cellId={cellId(row.original._id, "unit")}
            value={takeoff.unit}
            onCommit={(raw) => ctx.current.onCommitField(row.original, "unit", raw)}
            onKeyDown={ctx.current.onKeyDown}
          />
        );
      },
    },
    hours("craftHours", "Craft MH", (row) => row.costs.craftManHours, 78),
    money("craftCost", "Craft $", (row) => row.costs.craftCost, 92),
    hours("welderHours", "Weld MH", (row) => row.costs.welderManHours, 76),
    money("welderCost", "Weld $", (row) => row.costs.welderCost, 96),
    {
      id: "laborTotal",
      accessorFn: (row) => row.costs.craftCost + row.costs.welderCost,
      header: "Labor $",
      size: 96,
      meta: { align: "right" } satisfies PhaseColumnMeta,
      cell: ({ row }) => (
        <span title="Craft plus welder — the labor half of this phase, not its grand total">
          <MoneyCell value={row.original.costs.craftCost + row.original.costs.welderCost} strong />
        </span>
      ),
    },
    money("materialCost", "Material $", (row) => row.costs.materialCost, 88),
    money("equipmentCost", "Equipment $", (row) => row.costs.equipmentCost, 92),
    money("subcontractorCost", "Sub $", (row) => row.costs.subcontractorCost, 98),
    money("costOnlyCost", "Cost Only", (row) => row.costs.costOnlyCost, 88),
    {
      id: "totalCost",
      accessorFn: (row) => row.costs.totalCost,
      header: "Total",
      size: 104,
      enableHiding: false,
      meta: { align: "right" } satisfies PhaseColumnMeta,
      cell: ({ row }) => (
        <span title="Everything this phase costs — the figure that rolls up into the bid">
          <TotalCell value={row.original.costs.totalCost} />
        </span>
      ),
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
      // A breakdown that totals zero has still been totalled, so the foot states
      // its figure where a ROW carrying nothing would print a dash.
      return <TotalCell value={totals.totalCost} blankOnZero={false} />;
    default:
      return null;
  }
}
