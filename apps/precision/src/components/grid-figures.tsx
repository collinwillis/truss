import { cn } from "@truss/ui/lib/utils";
import type React from "react";

/**
 * The figures Precision's three cost reports are made of.
 *
 * ⚠️ THE SAME NUMBER MUST LOOK THE SAME AT EVERY DEPTH. The estimate report, the
 * WBS report and the phase grid are one instrument three drill-downs apart, and
 * an estimator who reads 1,234.0 craft hours on one sheet must not meet 1234.0625
 * of the same hours on the next. These formatters and these cells were written
 * once per report and had already drifted — one drew its money in the mono face
 * and the other in the UI face, on two tables one click apart — which is exactly
 * the divergence a shared module makes impossible.
 *
 * ⚠️ HOURS AND MONEY MUST NOT LOOK ALIKE. They interleave on every one of these
 * reports, so hours always carry one decimal place where money never carries
 * any: every hour figure ends in a decimal and no money figure ever does, and
 * the two populations stay apart even where the heading has scrolled out of
 * view. Man-hours are read to the tenth — the PRECISION lives in the craft
 * constant one drill-down down, which is where somebody types it.
 *
 * ⚠️ A CURRENCY SYMBOL IS A LANDMARK, NOT PUNCTUATION. Twelve columns of "$" is
 * a wall nobody reads; one is a place to put your eye. Only the TOTAL column
 * carries it — the same column on all three sheets — which is what makes the
 * figure at the right edge findable while ten columns scroll past it.
 *
 * @module
 */

/** Dollars without the symbol — every money column except the total. */
export const moneyFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Dollars WITH the symbol — the TOTAL column, and the foot of the report. */
export const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Man-hours, always to one decimal — see the module note. */
export const hoursFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Quantities as somebody measured them — CY and EA are not alike.
 *
 * Mirrors the plain format `EditableCell` prints, so a takeoff reads the same
 * whether the cell that holds it is an input or a printed figure.
 */
export const quantityFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/**
 * A zero reads as an absence, not as a number worth aligning against.
 *
 * It carries no tooltip of its own: an em-dash is a few pixels wide, so anything
 * that needs explaining is explained by the CELL around it.
 */
export function Blank(): React.ReactElement {
  return <span className="text-foreground-subtle">—</span>;
}

/**
 * One money figure.
 *
 * ⚠️ EVERY FIGURE IS `font-mono tabular-nums`, WITHOUT EXCEPTION. The editable
 * cells one drill-down down draw their numbers in the mono face, and so does the
 * totals chip in the toolbar; a money column set in the UI face beside them
 * reads as a different KIND of number, which on a report whose whole job is
 * columns of figures is the difference between a grid and a spreadsheet.
 */
export function MoneyCell({
  value,
  strong,
}: {
  value: number;
  /** The figure a row or a column is summarised by. */
  strong?: boolean;
}): React.ReactElement {
  if (value === 0) return <Blank />;
  return (
    <span className={cn("font-mono tabular-nums", strong && "font-medium")}>
      {moneyFmt.format(value)}
    </span>
  );
}

/** One man-hour figure — one decimal, always. */
export function HoursCell({ value }: { value: number }): React.ReactElement {
  if (value === 0) return <Blank />;
  return (
    <span className="font-mono tabular-nums text-muted-foreground">{hoursFmt.format(value)}</span>
  );
}

/**
 * The TOTAL column's figure — the only one drawn with a currency symbol.
 *
 * @param blankOnZero a row that costs nothing says so with a dash; the foot of
 *   the report states its total whatever it is, because a report that totals
 *   zero has still been totalled.
 */
export function TotalCell({
  value,
  blankOnZero = true,
}: {
  value: number;
  blankOnZero?: boolean;
}): React.ReactElement {
  if (value === 0 && blankOnZero) return <Blank />;
  return <span className="font-mono font-semibold tabular-nums">{currencyFmt.format(value)}</span>;
}
