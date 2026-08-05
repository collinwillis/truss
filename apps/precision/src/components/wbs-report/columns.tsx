import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { cn } from "@truss/ui/lib/utils";

/**
 * The WBS cost report's columns — the PROPOSAL HOME sheet, column for column.
 *
 * This is InDemand's "WBS Cost Report.xlsx" as they read it today: one row per
 * work breakdown, the twelve fields they marked in green, in their order. The
 * order is theirs and is not negotiable by width — CRAFT HR sits beside CRAFT
 * TOTAL because that is how an estimator checks a crew rate in their head.
 *
 * ⚠️ HOURS AND DOLLARS INTERLEAVE, SO THEY MUST NOT LOOK ALIKE. Four of the
 * twelve columns are quantities of time sitting shoulder to shoulder with
 * money. Three devices separate them, and all three are load-bearing: the hour
 * columns sit in a tinted channel drawn from the header down (see
 * {@link WbsReportColumnMeta}), they always carry one decimal place where money
 * never carries any, and their headers name the unit. Colour is deliberately
 * NOT one of them — craft hours are the second-most-read figure on the row and
 * must not be dimmed below the money beside them.
 *
 * A currency symbol appears only where a figure stands alone — the metric strip
 * and the totals row — because twelve columns of "$" is a wall of punctuation
 * nobody reads.
 *
 * ⚠️ EVERY COLUMN DECLARES ITS OWN TOTAL, via `meta.total`. The totals row used
 * to be a second switch over column ids in the route, which meant renaming a
 * column silently blanked its total — and this table's one unbreakable promise
 * is that its foot ties to the grand total.
 *
 * @module
 */

/** One row of the report: a work breakdown and what it costs. */
export interface WbsReportRow {
  _id: Id<"wbs">;
  /** The numeric WBS code, e.g. 70000 — the estimator-facing identity. */
  wbsPoolId: number;
  name: string;
  /** Hidden from the estimate's navigation, but never from its money. */
  isHidden: boolean;
  phaseCount: number;
  activityCount: number;
  /**
   * QTY and UNIT are estimator-entered and NOT derived: one breakdown spans
   * phases measured in CY, LF and EA, so there is nothing to sum. Null means
   * the estimator never chose a figure to characterise the breakdown by.
   */
  /** Rolled up from the phases beneath — see `rollUpWbsTakeoff`. */
  takeoff: {
    quantity: number;
    unit: string;
    isOverridden: boolean;
    mixedUnits: boolean;
  } | null;
  costs: WbsReportTotals;
}

/** The cost fields a row carries, and the shape the TOTALS row prints. */
export interface WbsReportTotals {
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
 * What a column holds, which decides how its cells are drawn.
 *
 * `hours` is the one that earns its keep: it is what puts the two man-hour
 * columns in their own tinted channel so they cannot be skim-read as money.
 */
export type WbsReportColumnKind = "identity" | "quantity" | "hours" | "money";

/** Per-column drawing hints, read by the grid when it lays out a cell. */
export interface WbsReportColumnMeta {
  align?: "right";
  kind: WbsReportColumnKind;
  /**
   * What this column prints in the TOTALS row; absent prints nothing.
   *
   * QTY and UNIT deliberately have none: a breakdown measured in CY and one
   * measured in EA have no common total, and a number there would be a lie
   * with a currency's confidence.
   */
  total?: (totals: WbsReportTotals) => React.ReactNode;
}

/** Every column of the report, in the client's order. */
export const WBS_REPORT_COLUMN_IDS = [
  "wbs",
  "quantity",
  "unit",
  "craftHours",
  "craftCost",
  "welderHours",
  "welderCost",
  "materialCost",
  "equipmentCost",
  "subcontractorCost",
  "costOnlyCost",
  "totalCost",
] as const;

export type WbsReportColumnId = (typeof WBS_REPORT_COLUMN_IDS)[number];

/**
 * The two columns nothing in Precision can fill yet.
 *
 * MEASURED: not one of 4,000 live breakdown records carries a quantity or a
 * unit, because `setWBSHidden` is the only mutation that touches the table. The
 * columns are the client's and they stay defined — they appear on their own the
 * moment any row carries a figure, by the same rule the proposal log already
 * uses for its Amount column.
 */
export const ESTIMATOR_ENTERED_COLUMN_IDS = ["quantity", "unit"] as const;

const moneyFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

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
 * money figure ever does, so the two populations stay apart at a glance even
 * where a column heading has scrolled out of view.
 */
const hoursFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Quantities are whatever the estimator typed — CY and EA are not alike. */
const quantityFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Share of the estimate, for the TOTAL column's tooltip. */
const shareFmt = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** Dollars without the symbol — for the body of the grid. */
export function formatMoney(value: number): string {
  return moneyFmt.format(value);
}

/** Dollars with the symbol — for a figure that stands on its own. */
export function formatCurrency(value: number): string {
  return currencyFmt.format(value);
}

/** Man-hours, always to one decimal. */
export function formatHours(value: number): string {
  return hoursFmt.format(value);
}

/**
 * Whether a breakdown has anything to report.
 *
 * MEASURED over 120 live estimates: every one of them carries exactly 18
 * breakdowns, and the median puts work in FIVE of them (mean 5.8, worst case
 * 14, and 7 of the 120 use none at all). So the untouched majority is thirteen
 * rows of em-dashes — most of the table and none of the information.
 *
 * "Untouched" is deliberately wider than "costs nothing": a breakdown with
 * phases but no priced activity is work in progress, and one carrying a takeoff
 * has quantities under it. Folding either away would read as the screen having
 * lost it.
 */
export function carriesWork(row: WbsReportRow): boolean {
  return (
    row.phaseCount > 0 ||
    row.activityCount > 0 ||
    row.takeoff !== null ||
    row.costs.totalCost !== 0 ||
    row.costs.craftManHours !== 0 ||
    row.costs.welderManHours !== 0
  );
}

/** Volatile values the cells read at the moment they render. */
export interface WbsReportContext {
  /** Route param for the drill-down link in every row. */
  estimateId: string;
  /**
   * The largest breakdown total in the estimate — the data bar's denominator.
   *
   * ⚠️ NOT THE GRAND TOTAL. Against the grand total the biggest breakdown fills
   * a third of a 100px cell and everything else is a two-pixel sliver, which is
   * an artefact rather than a reading. Scaled to the largest ROW, the bar does
   * the one job it is there for: showing at a glance which breakdowns hold the
   * money. The precise share of the estimate is on the cell's tooltip, and the
   * figure itself is right there.
   */
  maxRowTotal: number;
  /** Denominator for the share quoted in the TOTAL column's tooltip. */
  grandTotal: number;
}

/** A zero reads as an absence, not as a number worth aligning against. */
function Blank(): React.ReactElement {
  return <span className="text-foreground-subtle">—</span>;
}

function MoneyCell({ value, strong }: { value: number; strong?: boolean }): React.ReactElement {
  if (value === 0) return <Blank />;
  return (
    <span className={cn("tabular-nums", strong ? "font-medium" : undefined)}>
      {moneyFmt.format(value)}
    </span>
  );
}

function HoursCell({ value }: { value: number }): React.ReactElement {
  if (value === 0) return <Blank />;
  return <span className="tabular-nums">{hoursFmt.format(value)}</span>;
}

/** A money total for the foot of the report. */
function MoneyTotal({ value }: { value: number }): React.ReactElement {
  if (value === 0) return <Blank />;
  return <span className="tabular-nums">{moneyFmt.format(value)}</span>;
}

/** An hours total for the foot of the report. */
function HoursTotal({ value }: { value: number }): React.ReactElement {
  return <span className="tabular-nums">{hoursFmt.format(value)}</span>;
}

/**
 * Build the column defs ONCE, reading volatile values through a ref.
 *
 * ⚠️ THE RETURNED ARRAY MUST BE STABLE. TanStack's `flexRender` treats each
 * column's `cell` function as a React COMPONENT TYPE, so rebuilding the array
 * gives every cell a new type and React unmounts and remounts all of them. The
 * grand total moves with every keystroke anywhere in the estimate, so passing
 * it as an argument would throw the whole grid away on each Convex push — the
 * same defect, and the same fix, as `buildLogColumns`.
 */
export function buildWbsReportColumns(ctx: {
  current: WbsReportContext;
}): ColumnDef<WbsReportRow>[] {
  return [
    {
      id: "wbs",
      accessorFn: (row) => row.wbsPoolId,
      header: "WBS",
      // Declared AT its minimum, not above it: `size` is what the table's
      // `minWidth` floor is computed from, and this column absorbs the window's
      // slack anyway (see grid-geometry::cellWidth). Declaring 256 spent 56px
      // of the floor on a column that was going to take the slack regardless,
      // and pushed the report into a horizontal scrollbar it does not need.
      size: 200,
      minSize: 200,
      meta: {
        kind: "identity",
        // Named exactly as the metric strip names it, so the same words label
        // the same number in both places and the tie is stated, not inferred.
        total: () => (
          <span className="text-footnote font-semibold uppercase tracking-wide">Grand total</span>
        ),
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          {/*
            A real link inside the row, not only the row's click handler: it is
            the sole keyboard route into a breakdown, and it is what a
            right-click "open" expects to find.
          */}
          <Link
            to="/estimate/$estimateId/wbs/$wbsId"
            params={{ estimateId: ctx.current.estimateId, wbsId: row.original._id }}
            // The row navigates to the same place; letting both fire would
            // push two identical history entries for one click.
            onClick={(event) => event.stopPropagation()}
            className="flex min-w-0 items-center gap-1.5 rounded-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="shrink-0 font-mono tabular-nums text-foreground-subtle">
              {row.original.wbsPoolId}
            </span>
            {/* Caps by CSS, never by transforming the stored string. */}
            <span className="truncate font-medium uppercase" title={row.original.name}>
              {row.original.name}
            </span>
          </Link>
          {row.original.isHidden && (
            <span
              className="shrink-0 rounded bg-fill-secondary px-1 text-caption2 uppercase tracking-wide text-muted-foreground"
              title="Hidden from this estimate's navigation in Setup. Hiding is a menu preference and never a change to the bid — this row counts towards the totals and appears in the export."
            >
              Hidden
            </span>
          )}
        </span>
      ),
    },
    {
      id: "quantity",
      accessorFn: (row) => (row.takeoff?.mixedUnits ? undefined : row.takeoff?.quantity),
      header: "Qty",
      size: 72,
      meta: { align: "right", kind: "quantity" } satisfies WbsReportColumnMeta,
      cell: ({ row }) => {
        const takeoff = row.original.takeoff;
        if (takeoff === null) return <Blank />;
        // Refused, not zero: the phases beneath measure different things, and a
        // sum of cubic yards and each would be read as a takeoff by somebody
        // pricing work. See `rollUpWbsTakeoff`.
        if (takeoff.mixedUnits) {
          return (
            <span
              className="text-muted-foreground"
              title="The phases in this breakdown are measured in different units, so there is no total to show."
            >
              mixed
            </span>
          );
        }
        return (
          <span className="tabular-nums">
            {quantityFmt.format(takeoff.quantity)}
            {/* Partly somebody's judgement rather than wholly derived. */}
            {takeoff.isOverridden && <span className="ml-0.5 text-foreground-subtle">*</span>}
          </span>
        );
      },
    },
    {
      id: "unit",
      accessorFn: (row) => (row.takeoff?.mixedUnits ? undefined : row.takeoff?.unit),
      header: "Unit",
      size: 52,
      meta: { kind: "quantity" } satisfies WbsReportColumnMeta,
      cell: ({ row }) => (
        // Blank rather than a dash: the QTY beside it has already said whether
        // there is a takeoff, and saying so twice is noise.
        <span className="min-w-0 truncate uppercase text-muted-foreground">
          {row.original.takeoff?.mixedUnits ? "" : (row.original.takeoff?.unit ?? "")}
        </span>
      ),
    },
    {
      id: "craftHours",
      accessorFn: (row) => row.costs.craftManHours,
      header: "Craft MH",
      size: 82,
      meta: {
        align: "right",
        kind: "hours",
        total: (totals) => <HoursTotal value={totals.craftManHours} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <HoursCell value={row.original.costs.craftManHours} />,
    },
    {
      id: "craftCost",
      accessorFn: (row) => row.costs.craftCost,
      header: "Craft $",
      size: 94,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => <MoneyTotal value={totals.craftCost} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <MoneyCell value={row.original.costs.craftCost} />,
    },
    {
      id: "welderHours",
      accessorFn: (row) => row.costs.welderManHours,
      header: "Weld MH",
      size: 80,
      meta: {
        align: "right",
        kind: "hours",
        total: (totals) => <HoursTotal value={totals.welderManHours} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <HoursCell value={row.original.costs.welderManHours} />,
    },
    {
      id: "welderCost",
      accessorFn: (row) => row.costs.welderCost,
      header: "Weld $",
      size: 96,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => <MoneyTotal value={totals.welderCost} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <MoneyCell value={row.original.costs.welderCost} />,
    },
    {
      id: "materialCost",
      accessorFn: (row) => row.costs.materialCost,
      header: "Material $",
      size: 92,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => <MoneyTotal value={totals.materialCost} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <MoneyCell value={row.original.costs.materialCost} />,
    },
    {
      id: "equipmentCost",
      accessorFn: (row) => row.costs.equipmentCost,
      header: "Equipment $",
      size: 96,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => <MoneyTotal value={totals.equipmentCost} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <MoneyCell value={row.original.costs.equipmentCost} />,
    },
    {
      id: "subcontractorCost",
      accessorFn: (row) => row.costs.subcontractorCost,
      header: "Sub $",
      size: 100,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => <MoneyTotal value={totals.subcontractorCost} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <MoneyCell value={row.original.costs.subcontractorCost} />,
    },
    {
      id: "costOnlyCost",
      accessorFn: (row) => row.costs.costOnlyCost,
      header: "Cost Only",
      size: 92,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => <MoneyTotal value={totals.costOnlyCost} />,
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => <MoneyCell value={row.original.costs.costOnlyCost} />,
    },
    {
      id: "totalCost",
      accessorFn: (row) => row.costs.totalCost,
      header: "Total",
      size: 104,
      meta: {
        align: "right",
        kind: "money",
        total: (totals) => (
          <span className="font-semibold tabular-nums">{currencyFmt.format(totals.totalCost)}</span>
        ),
      } satisfies WbsReportColumnMeta,
      cell: ({ row }) => {
        const value = row.original.costs.totalCost;
        const { maxRowTotal, grandTotal } = ctx.current;
        // Excel's own device, and it costs no width: the proportion sits
        // BEHIND the figure rather than in a column beside it, so it can be
        // read or ignored without displacing a number.
        const share = maxRowTotal > 0 ? Math.min(1, Math.max(0, value / maxRowTotal)) : 0;
        return (
          <span
            className="relative flex w-full items-center justify-end"
            title={
              grandTotal > 0 && value !== 0
                ? `${shareFmt.format(value / grandTotal)} of the estimate`
                : undefined
            }
          >
            {share > 0 && (
              <span
                aria-hidden="true"
                className="absolute inset-y-[3px] right-0 rounded-[2px] bg-primary/10"
                style={{ width: `${Math.max(2, share * 100)}%` }}
              />
            )}
            <span className="relative">
              <MoneyCell value={value} strong />
            </span>
          </span>
        );
      },
    },
  ];
}
