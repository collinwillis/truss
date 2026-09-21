import { cn } from "@truss/ui/lib/utils";
import { Button } from "@truss/ui/components/button";
import { ChevronRight, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../../lib/clipboard";
import { ACTIVITY_TYPE_META } from "../activity-grid/activity-types";
import {
  countFmt,
  currencyCentsFmt,
  currencyFmt,
  moneyCentsFmt,
  quantityFmt,
} from "../grid-figures";
import {
  deriveTotalsView,
  formatPercent,
  formatPrecisePercent,
  rawValue,
  type CostKey,
  type EstimateSummary,
  type FigureKind,
  type ScopeCosts,
  type TakeoffState,
  type TotalsDepth,
} from "./derive";
import { advanceTrack, startTrack, type ChangeTrack, type LastChange } from "./last-change";

export type { EstimateSummary, ScopeCosts, TakeoffState, TotalsDepth } from "./derive";

/**
 * The totals panel: what this sheet costs, where the money goes, how many hours
 * it is, and the bid it belongs to.
 *
 * WHY A RIGHT INSPECTOR: estimators watch the bid react as they type; that is
 * properties-of-the-current-context, which is what the design doc's "optional
 * right inspector" region is for.
 *
 * ⚠️ THIS IS THE THIRD PANEL, AND THE FIRST TWO FAILED THE SAME WAY. Both were a
 * flat list of figures at one weight. The first printed the scope total twice
 * and a wall of "$0". The second fixed that and then added unit rates, shares to
 * a decimal and two outlines of the hours, about twenty-two figures in all, and
 * the owner's verdict was "almost more confusing now". More numbers was never
 * what "useful" meant. What this one does instead:
 *
 * - SAYS IT IN A SENTENCE. "6,388 man-hours · $116.74 all-in per hour" under the total
 *   replaces a headed section of rows. A sentence carries its own units.
 * - SHOWS PROPORTION ONCE, as one bar, with whole percents beside the amounts.
 * - PUTS THE DOLLAR SIGN BACK. The grids print "$" on totals only, because
 *   twelve columns of it is a wall. A panel has one money column and it sits
 *   above a column of hours, so bare "655,293" over "4,834" left the reader to
 *   work out which was which.
 * - DRAWS NOTHING FOR NOTHING. A part worth zero is not listed.
 * - KEEPS THE REST ONE CLICK AWAY. The labor split, the indirect breakdown and
 *   the labor rate sit under "More detail", which stays open once opened. That
 *   is how the legacy app these estimators came from did it.
 *
 * ONE PANEL FOR ALL THREE SHEETS. The overview, the phase table and the activity
 * grid are one report at three depths and carry the same instrument.
 *
 * Figures flash when an edit moves them and settle silently on navigation. A
 * click on any figure copies it. What the panel PRINTS is decided in `./derive`,
 * which is pure and tested; this file only draws it.
 */

const OPEN_KEY = "precision.totalsInspector.open";
const DETAIL_KEY = "precision.totalsInspector.detail";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "open";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // Preference persistence is best-effort.
  }
}

/** Panel open state, persisted so the choice survives navigation and restarts. */
export function useTotalsInspector(): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => readFlag(OPEN_KEY, true));
  const toggle = () => {
    setOpen((prev) => {
      writeFlag(OPEN_KEY, !prev);
      return !prev;
    });
  };
  return [open, toggle];
}

/**
 * Toolbar chip: the grand total stays visible while the panel is closed.
 *
 * It carries the number ONLY while the panel is closed. Open, the panel prints
 * the same figure a few inches away, and a number that appears twice on one
 * window makes a reader check whether the two agree.
 */
export function InspectorToggle({
  grandTotal,
  open,
  onToggle,
}: {
  grandTotal: number | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = open ? PanelRightClose : PanelRightOpen;
  return (
    <Button
      variant="ghost"
      size="lg"
      className="px-2"
      title={open ? "Hide totals panel" : "Show totals panel"}
      aria-expanded={open}
      onClick={onToggle}
    >
      {!open && grandTotal !== undefined && (
        <span className="font-mono text-xs font-medium tabular-nums">
          {currencyFmt.format(grandTotal)}
        </span>
      )}
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
    </Button>
  );
}

/** What the rows ticked in the grid add up to. */
export interface SelectionTotals {
  count: number;
  /** How many rows the sheet holds, for "3 of 42". */
  of: number;
  totalCost: number;
  hours: number;
}

/** @see TotalsInspector */
export interface TotalsInspectorProps {
  open: boolean;
  depth: TotalsDepth;
  /**
   * Identity of the scope: a document id, or the estimate's.
   *
   * When it changes every figure belongs to something else, so they settle
   * without flashing. The flash means "your edit moved this", never "you moved".
   */
  scopeKey: string;
  /** "70004" or "70000". Absent at estimate depth. */
  scopeCode?: string;
  /**
   * The scope's name. Absent at estimate depth: the title bar already names the
   * bid, and naming it again here would be its third appearance on one window.
   */
  scopeName?: string;
  /** The scope sits in Mobilize, Demobilize, Support or Specialty Services. */
  isIndirect?: boolean;
  scopeCosts: ScopeCosts;
  /** The page's `getProposalSummary` subscription. */
  summary: EstimateSummary | undefined;
  /**
   * False while the figures are a stand-in for data still loading.
   *
   * `useStableQuery` keeps the PREVIOUS sibling's rows on screen for the round
   * trip after a navigation, so the numbers change once more when the real ones
   * land. Without this the panel flashed every figure on every cold navigation,
   * which taught estimators that the flash means nothing.
   */
  settled?: boolean;
  /**
   * False while `summary` is a cached snapshot still waiting on its subscription.
   *
   * The bid's figure comes from a DIFFERENT query than the scope's, with its own
   * stand-in. On the phase sheet the summary is skipped while the panel is
   * closed, so reopening after twenty edits showed the old bid and then flashed
   * it as if an edit had just landed. Defaults to {@link settled}, which is
   * right at estimate depth, where the scope IS the summary.
   */
  summarySettled?: boolean;
  /** The scope's measured quantity. Absent at estimate depth. */
  takeoff?: TakeoffState;
  /** Completed phases in scope, for "9 of 14 phases done". */
  completedCount?: number;
  /** Phases in scope. */
  phaseCount?: number;
  /** Activities in scope, at phase depth. */
  activityCount?: number;
  /** This phase is marked complete. */
  isCompleted?: boolean;
  /** Totals of the rows ticked in the grid, or `null` with nothing ticked. */
  selection?: SelectionTotals | null;
}

/**
 * Keyboard focus for the hero and the lines.
 *
 * The kit's ring token is a 25% halo, which measures about 1.4:1 on this
 * surface: present, and not visible. These are borderless buttons, so there is
 * no border for the kit's solid focus colour to land on either. `inset-ring` is
 * Tailwind v4's separate inset shadow layer: a solid 1px primary line INSIDE
 * the row (3:1 in light, 5:1 in dark), the soft halo kept outside it, and no
 * real border, so a row does not shift. The fill matches hover.
 */
const FOCUS_RING =
  "focus-visible:bg-fill-tertiary focus-visible:inset-ring focus-visible:inset-ring-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

const SCOPE_NOUN: Record<TotalsDepth, string> = {
  estimate: "estimate",
  wbs: "breakdown",
  phase: "phase",
};

/**
 * The glyph ahead of each part of the cost: the SAME glyph the activity grid
 * puts ahead of a line of that kind, so a wrench means labor on both screens.
 * They replaced a column of grey squares in five shades, which asked the reader
 * to tell "55% black" from "38% black" to find Material.
 */
const COST_ICON: Record<CostKey, LucideIcon> = {
  labor: ACTIVITY_TYPE_META.labor.icon,
  material: ACTIVITY_TYPE_META.material.icon,
  equipment: ACTIVITY_TYPE_META.equipment.icon,
  subcontractor: ACTIVITY_TYPE_META.subcontractor.icon,
  costOnly: ACTIVITY_TYPE_META.cost_only.icon,
};

/**
 * The bar's shade for each part. Fixed per PART, not per position, so Material
 * is the same grey on every sheet whether or not Labor is there beside it.
 * Monochrome: colour in this app is reserved for state.
 */
const BAR_SHADE: Record<CostKey, string> = {
  labor: "bg-foreground/80",
  material: "bg-foreground/55",
  equipment: "bg-foreground/38",
  subcontractor: "bg-foreground/26",
  costOnly: "bg-foreground/16",
};

/** A copy request: which line, what to call it, what it is, and its value. */
type CopyLine = (id: string, label: string, kind: FigureKind, value: number) => void;

function TotalsInspectorImpl({
  open,
  depth,
  scopeKey,
  scopeCode,
  scopeName,
  isIndirect = false,
  scopeCosts,
  summary,
  settled = true,
  summarySettled = settled,
  takeoff,
  completedCount,
  phaseCount,
  activityCount,
  isCompleted = false,
  selection = null,
}: TotalsInspectorProps) {
  const view = useMemo(
    () =>
      deriveTotalsView({
        depth,
        costs: scopeCosts,
        summary,
        takeoff,
        formatCount: countFmt.format,
      }),
    [depth, scopeCosts, summary, takeoff]
  );

  // The phase sheet prints cents because prices are typed there; the rollups
  // round. The panel follows the sheet it stands beside, so its total and the
  // figure at the foot of the grid are the same string. See `grid-figures`.
  const cents = depth === "phase";
  const money = cents ? currencyCentsFmt : currencyFmt;
  const hoursText = useMemo(() => {
    const fmt = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: view.hoursDecimals,
      maximumFractionDigits: view.hoursDecimals,
    });
    return (value: number) => fmt.format(value);
  }, [view.hoursDecimals]);

  const change = useLastChange(view.total, scopeKey, settled);
  const { copiedId, announcement, copy } = useCopy();
  const copyLine = useCallback<CopyLine>(
    (id, label, kind, value) => void copy(id, label, rawValue(kind, value)),
    [copy]
  );

  const [detailOpen, setDetailOpen] = useState(() => readFlag(DETAIL_KEY, false));
  const detailId = useId();
  /**
   * The part of the cost under the pointer, or under keyboard focus.
   *
   * TWO STATES, because one got stuck. Focus set it and nothing cleared it, so
   * arrowing on into the hours left a cost row lit beside the focused one, and
   * on Windows a clicked row relit itself every time the window came back to
   * the front. The pointer wins while it is over the list; focus clears on blur.
   */
  const [hovered, setHovered] = useState<CostKey | null>(null);
  const [focused, setFocused] = useState<CostKey | null>(null);
  const held = hovered ?? focused;
  // A part the bar does not draw (a deduct, or one held over from the last
  // sheet) lights nothing, rather than dimming every segment to grey.
  const barLit = view.bar.some((segment) => segment.id === held) ? held : null;

  /**
   * Two tab stops, arrows inside.
   *
   * Every figure is a button (a click copies it), and a dozen buttons in the
   * tab order would put a dozen stops between the grid and whatever follows it.
   * The total is the stop for the figures; the arrow keys walk the lines from
   * there. "More detail" is the second stop: it is the one control here that
   * REVEALS content rather than copying a figure already on screen, and nothing
   * about a side panel tells a keyboard user the arrows exist.
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const lines = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-totals-line]")
    );
    if (lines.length === 0) return;
    const at = lines.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lines.length - 1
          : event.key === "ArrowDown"
            ? Math.min(lines.length - 1, at + 1)
            : Math.max(0, at - 1);
    event.preventDefault();
    lines[next]?.focus();
  }, []);

  if (!open) return null;

  const eyebrow =
    depth === "estimate"
      ? "Grand total"
      : `${depth === "wbs" ? "WBS" : "Phase"}${scopeCode ? ` ${scopeCode}` : ""}`;
  const totalText = money.format(view.total);
  const noun = SCOPE_NOUN[depth];

  return (
    <aside
      aria-label="Totals"
      onKeyDown={onKeyDown}
      className="flex w-[17.5rem] shrink-0 flex-col border-l bg-fill-quaternary/40"
    >
      <div className="flex min-h-0 flex-1 flex-col short:overflow-y-auto">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-4 short:flex-none short:overflow-visible">
          {/* ── What it costs ── */}
          <div className="flex items-baseline justify-between gap-3 text-callout text-muted-foreground">
            <p className="min-w-0 truncate">
              {eyebrow}
              {isIndirect && " · Indirect"}
            </p>
            <ScopeStatus
              depth={depth}
              completedCount={depth === "estimate" ? summary?.completedPhaseCount : completedCount}
              phaseCount={depth === "estimate" ? summary?.phaseCount : phaseCount}
              activityCount={activityCount}
              isCompleted={isCompleted}
            />
          </div>

          {scopeName && (
            <p
              className="mt-0.5 line-clamp-2 text-body font-medium text-foreground"
              title={scopeName}
            >
              {scopeName}
            </p>
          )}

          <div className="mt-1.5 flex items-baseline justify-between gap-3">
            <button
              type="button"
              data-totals-line
              onClick={() => copyLine("total", "total", "money", view.total)}
              title={`${currencyCentsFmt.format(view.total)} · click to copy`}
              aria-label={`${noun} total ${totalText}. Press Enter to copy.`}
              className={cn(
                "-mx-1 shrink-0 rounded-sm px-1 font-mono text-title1 font-semibold tabular-nums",
                "hover:bg-fill-tertiary",
                FOCUS_RING,
                view.isEmpty && "text-muted-foreground"
              )}
            >
              <FlashValue value={view.total} resetKey={scopeKey} silent={!settled}>
                {copiedId === "total" ? "Copied" : totalText}
              </FlashValue>
            </button>
            {change && (
              <span
                className="min-w-0 truncate font-mono text-xs tabular-nums text-muted-foreground"
                title={`Last change: ${currencyCentsFmt.format(change.from)} to ${currencyCentsFmt.format(change.to)}`}
              >
                {signedMoney(change.to - change.from, cents)}
              </span>
            )}
          </div>

          {view.isEmpty ? (
            <p className="mt-3 text-callout text-muted-foreground">
              Nothing priced in this {noun} yet.
            </p>
          ) : (
            <>
              {/* A sentence, not a section: it carries its own units. */}
              {view.hours !== 0 && (
                <p className="mt-0.5 text-callout text-muted-foreground">
                  <Clause last={view.costPerHour === null}>
                    <FlashValue
                      value={view.hours}
                      resetKey={scopeKey}
                      silent={!settled}
                      className="text-foreground tabular-nums"
                    >
                      {hoursText(view.hours)}
                    </FlashValue>{" "}
                    man-hours
                  </Clause>
                  {view.costPerHour !== null && (
                    <Clause last>
                      <span
                        className="text-foreground tabular-nums"
                        title="Total cost divided by man-hours"
                      >
                        {currencyCentsFmt.format(view.costPerHour)}
                      </span>{" "}
                      all-in per hour
                    </Clause>
                  )}
                </p>
              )}

              {view.takeoff && (
                <p
                  className="mt-0.5 text-callout text-muted-foreground"
                  title={
                    view.takeoff.isOverridden
                      ? "The quantity was entered by hand"
                      : "The quantity adds up from the lines that count toward it"
                  }
                >
                  {view.takeoff.isOverridden && (
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-block h-1 w-1 rounded-full bg-primary align-middle"
                    />
                  )}
                  <Clause
                    last={view.takeoff.hoursPerUnit === null && view.takeoff.costPerUnit === null}
                  >
                    <span className="text-foreground tabular-nums">
                      {quantityFmt.format(view.takeoff.quantity)}
                    </span>
                    {view.takeoff.unit && ` ${view.takeoff.unit}`}
                  </Clause>
                  {view.takeoff.hoursPerUnit !== null && (
                    <Clause last={view.takeoff.costPerUnit === null}>
                      <span className="text-foreground tabular-nums">
                        {perUnitHours(view.takeoff.hoursPerUnit)}
                      </span>{" "}
                      MH per {view.takeoff.unit || "unit"}
                    </Clause>
                  )}
                  {view.takeoff.costPerUnit !== null && (
                    <Clause last>
                      <span className="text-foreground tabular-nums">
                        {currencyCentsFmt.format(view.takeoff.costPerUnit)}
                      </span>{" "}
                      per {view.takeoff.unit || "unit"}
                    </Clause>
                  )}
                </p>
              )}
              {view.takeoffNote && (
                <p className="mt-1 text-xs text-muted-foreground">{view.takeoffNote}</p>
              )}

              {/* ── Where the money goes ── */}
              {view.bar.length > 0 && (
                <div
                  aria-hidden="true"
                  className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full"
                  onMouseLeave={() => setHovered(null)}
                >
                  {view.bar.map((segment) => (
                    <span
                      key={segment.id}
                      onMouseEnter={() => setHovered(segment.id)}
                      style={{ flexGrow: segment.fraction, flexBasis: 0 }}
                      className={cn(
                        "min-w-[3px] transition-colors duration-150",
                        barLit === null
                          ? BAR_SHADE[segment.id]
                          : barLit === segment.id
                            ? "bg-primary"
                            : "bg-foreground/12"
                      )}
                    />
                  ))}
                </div>
              )}

              {view.cost.length > 0 && (
                <div
                  role="group"
                  aria-label="Where the money goes"
                  className="mt-2.5"
                  onMouseLeave={() => setHovered(null)}
                >
                  {view.cost.map((line) => (
                    <Line
                      key={line.id}
                      id={line.id}
                      icon={COST_ICON[line.id]}
                      label={line.label}
                      kind="money"
                      value={line.value}
                      text={trueMinus(money.format(line.value))}
                      trailing={line.percentText}
                      flashKey={scopeKey}
                      silent={!settled}
                      lit={held === line.id}
                      onHover={() => setHovered(line.id)}
                      onFocusChange={(on) => setFocused(on ? line.id : null)}
                      copied={copiedId === line.id}
                      onCopy={copyLine}
                    />
                  ))}
                </div>
              )}

              {/* ── How many hours ── */}
              {view.hoursLines.length > 0 && (
                <div role="group" aria-labelledby={`${detailId}-hours`} className="mt-4">
                  <h3
                    id={`${detailId}-hours`}
                    className="mb-0.5 text-callout text-muted-foreground"
                  >
                    Man-hours
                  </h3>
                  {view.hoursLines.map((line) => (
                    <Line
                      key={line.id}
                      id={`${line.id}Hours`}
                      label={line.label}
                      kind="hours"
                      value={line.value}
                      text={hoursText(line.value)}
                      // The slot the percents sit in, kept empty, so hours end
                      // on the same axis as the dollars above them.
                      trailing=""
                      flashKey={scopeKey}
                      silent={!settled}
                      copied={copiedId === `${line.id}Hours`}
                      onCopy={copyLine}
                    />
                  ))}
                  {view.indirect && (
                    // SET APART. Craft and weld above ARE the man-hours; this is
                    // a slice of them, not a third part to add to them.
                    <div className="mt-1.5">
                      <Line
                        id="indirectHours"
                        label="Of which indirect"
                        kind="hours"
                        value={view.indirect.hours}
                        text={hoursText(view.indirect.hours)}
                        trailing=""
                        flashKey={scopeKey}
                        silent={!settled}
                        copied={copiedId === "indirectHours"}
                        onCopy={copyLine}
                      />
                      {view.indirect.ratio !== null && (
                        <p className="pl-6 text-xs text-muted-foreground">
                          <span className="text-foreground tabular-nums">
                            {formatPrecisePercent(view.indirect.ratio)}
                          </span>{" "}
                          of the{" "}
                          <span className="tabular-nums">
                            {hoursText(view.indirect.directHours)}
                          </span>{" "}
                          direct hours
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── The rest, on request ── */}
              {(view.detail.length > 0 || view.contents) && (
                <div className="mt-4 border-t border-border/60 pt-2">
                  <button
                    type="button"
                    data-totals-line
                    aria-expanded={detailOpen}
                    aria-controls={detailId}
                    onClick={() =>
                      setDetailOpen((prev) => {
                        writeFlag(DETAIL_KEY, !prev);
                        return !prev;
                      })
                    }
                    className={cn(
                      "-mx-1 flex h-6 w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 text-callout text-muted-foreground",
                      "hover:bg-fill-tertiary hover:text-foreground",
                      FOCUS_RING
                    )}
                  >
                    <span className="flex w-4 shrink-0 justify-center">
                      <ChevronRight
                        aria-hidden="true"
                        className={cn(
                          "h-3.5 w-3.5 transition-transform duration-150",
                          detailOpen && "rotate-90"
                        )}
                      />
                    </span>
                    More detail
                  </button>
                  {detailOpen && (
                    <div id={detailId} className="mt-0.5">
                      {view.detail.map((line) => (
                        <Line
                          key={line.id}
                          id={line.id}
                          label={line.label}
                          kind={line.kind}
                          value={line.value}
                          text={
                            line.kind === "hours"
                              ? hoursText(line.value)
                              : line.kind === "rate"
                                ? currencyCentsFmt.format(line.value)
                                : trueMinus(money.format(line.value))
                          }
                          trailing=""
                          flashKey={scopeKey}
                          silent={!settled}
                          copied={copiedId === line.id}
                          onCopy={copyLine}
                        />
                      ))}
                      {view.contents && (
                        <p className="mt-1.5 pl-6 text-xs text-muted-foreground">{view.contents}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── What it belongs to ── */}
        {(view.estimate !== null || view.hidden || selection) && (
          <footer className="shrink-0 space-y-3 border-t bg-fill-quaternary/60 px-4 py-3">
            {selection && selection.count > 0 && (
              <Summary
                id="selection"
                label={`Selected · ${countFmt.format(selection.count)} of ${countFmt.format(selection.of)}`}
                value={selection.totalCost}
                text={trueMinus(money.format(selection.totalCost))}
                // A selection changes because the SELECTION changed, which is
                // not an edit moving a number. It never flashes.
                flashKey="selection"
                silent
                copied={copiedId === "selection"}
                onCopy={copyLine}
              >
                {selection.hours !== 0 && `${hoursText(selection.hours)} man-hours`}
                {selection.hours !== 0 && view.total > 0 && " · "}
                {view.total > 0 &&
                  `${formatPercent(selection.totalCost / view.total)} of this ${noun}`}
              </Summary>
            )}

            {view.estimate === undefined && <EstimateLoading />}
            {view.estimate && (
              <Summary
                id="estimate"
                label="Estimate"
                value={view.estimate.total}
                // The bid is a rollup at every depth, and rollups round.
                text={currencyFmt.format(view.estimate.total)}
                flashKey="estimate"
                silent={!summarySettled}
                copied={copiedId === "estimate"}
                onCopy={copyLine}
              >
                {view.estimate.share !== null &&
                  `this ${noun} is ${formatPrecisePercent(view.estimate.share)} of it`}
              </Summary>
            )}

            {view.hidden && (
              // A dot and plain text, never coloured text: the warning token on
              // this surface is well under AA as a text colour.
              <p className="flex gap-2 text-xs text-foreground">
                <span
                  aria-hidden="true"
                  className="mt-[0.3125rem] h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                />
                <span>
                  {view.hidden.count === 1
                    ? "1 hidden breakdown carries "
                    : `${countFmt.format(view.hidden.count)} hidden breakdowns carry `}
                  <span className="tabular-nums">{currencyFmt.format(view.hidden.cost)}</span>,
                  included in the total.
                </span>
              </p>
            )}
          </footer>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </aside>
  );
}

/**
 * Memoized because its parents re-render constantly: every committed cell,
 * every checkbox tick, and every mousemove of a column resize. The panel's
 * props are primitives and memoized objects, so none of those reach it.
 */
export const TotalsInspector = memo(TotalsInspectorImpl);

/** The right end of the first line: how far along this scope is. */
function ScopeStatus({
  depth,
  completedCount,
  phaseCount,
  activityCount,
  isCompleted,
}: {
  depth: TotalsDepth;
  completedCount: number | undefined;
  phaseCount: number | undefined;
  activityCount: number | undefined;
  isCompleted: boolean;
}) {
  let text: string | null = null;
  let done = false;

  if (depth === "phase") {
    done = isCompleted;
    if (isCompleted) text = "Complete";
    else if (activityCount !== undefined) {
      text = activityCount === 1 ? "1 activity" : `${countFmt.format(activityCount)} activities`;
    }
  } else if (completedCount !== undefined && phaseCount !== undefined && phaseCount > 0) {
    done = completedCount === phaseCount;
    text = `${countFmt.format(completedCount)} of ${countFmt.format(phaseCount)} phases done`;
  }

  if (text === null) return null;
  return (
    // State is a dot plus ordinary text. The success token as a TEXT colour is
    // about 2.4:1 on this surface, and a dot survives forced-colors mode with
    // the words beside it still saying the same thing.
    <p className={cn("flex shrink-0 items-center gap-1.5", done && "text-foreground")}>
      {done && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />}
      {text}
    </p>
  );
}

/**
 * One line: a glyph, a label, its figure, and what trails it.
 *
 * ⚠️ ONE FIGURE AXIS. Every figure ends at the same x, with the slot for a
 * percent to its right whether or not the line has one, so dollars and the
 * hours below them read as one column.
 *
 * The whole line is a button: a click puts the bare number on the clipboard,
 * because the next place an estimator needs it is a spreadsheet cell or an
 * email. The LABEL says "Copied" rather than the figure, so the number being
 * read never leaves the screen.
 */
function Line({
  id,
  icon: Icon,
  label,
  kind,
  value,
  text,
  trailing,
  flashKey,
  silent,
  lit = false,
  onHover,
  onFocusChange,
  copied,
  onCopy,
}: {
  id: string;
  icon?: LucideIcon;
  label: string;
  kind: FigureKind;
  value: number;
  text: string;
  /** A share, or `""` to hold the slot open, or `null` for a share that has no answer. */
  trailing: string | null;
  flashKey: string;
  silent: boolean;
  lit?: boolean;
  onHover?: () => void;
  onFocusChange?: (focused: boolean) => void;
  copied: boolean;
  onCopy: CopyLine;
}) {
  return (
    <button
      type="button"
      data-totals-line
      tabIndex={-1}
      aria-label={[label, text, trailing].filter(Boolean).join(", ")}
      title={`${exactText(kind, value)} · click to copy`}
      onClick={() => onCopy(id, label, kind, value)}
      onMouseEnter={onHover}
      // KEYBOARD focus only. A clicked button is focused again when the window
      // re-activates on Windows, and that must not light the bar with no
      // pointer anywhere near it.
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) onFocusChange?.(true);
      }}
      onBlur={() => onFocusChange?.(false)}
      className={cn(
        "-mx-1 flex h-6 w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 text-callout",
        "hover:bg-fill-tertiary",
        lit && "bg-fill-tertiary",
        FOCUS_RING
      )}
    >
      <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
        {Icon && <Icon aria-hidden="true" className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
        {copied ? "Copied" : label}
      </span>
      <FlashValue
        value={value}
        resetKey={flashKey}
        silent={silent}
        className="shrink-0 font-mono tabular-nums text-foreground"
      >
        {text}
      </FlashValue>
      <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {trailing}
      </span>
    </button>
  );
}

/** A label, a figure, and a quiet sentence under it: the bid, or the selection. */
function Summary({
  id,
  label,
  value,
  text,
  flashKey,
  silent,
  copied,
  onCopy,
  children,
}: {
  id: string;
  label: string;
  value: number;
  text: string;
  flashKey: string;
  silent: boolean;
  copied: boolean;
  onCopy: CopyLine;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        data-totals-line
        tabIndex={-1}
        aria-label={`${label}, ${text}`}
        title={`${currencyCentsFmt.format(value)} · click to copy`}
        onClick={() => onCopy(id, label, "money", value)}
        className={cn(
          "-mx-1 flex h-6 w-[calc(100%+0.5rem)] items-center justify-between gap-3 rounded-sm px-1 text-callout",
          "hover:bg-fill-tertiary",
          FOCUS_RING
        )}
      >
        <span className="min-w-0 truncate text-muted-foreground">{copied ? "Copied" : label}</span>
        <FlashValue
          value={value}
          resetKey={flashKey}
          silent={silent}
          className="shrink-0 font-mono font-medium tabular-nums text-foreground"
        >
          {text}
        </FlashValue>
      </button>
      {children && <p className="text-right text-xs text-muted-foreground">{children}</p>}
    </div>
  );
}

/**
 * One clause of a headline sentence, which never breaks inside itself.
 *
 * "$4,777.42" at the end of one line and "per TON" at the start of the next is
 * a figure separated from its unit. A sentence too long for the panel breaks
 * BETWEEN clauses, with the separator left at the end of the line above.
 */
function Clause({ last = false, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <>
      <span className="whitespace-nowrap">
        {children}
        {!last && " ·"}
      </span>
      {!last && " "}
    </>
  );
}

/** A bar, not "…": the block keeps its height, so nothing jumps when it lands. */
function EstimateLoading() {
  return (
    <div className="flex h-6 items-center justify-between gap-3" aria-busy="true">
      <span className="sr-only">Loading the estimate total</span>
      <span className="text-callout text-muted-foreground">Estimate</span>
      <span className="h-3 w-24 animate-pulse rounded-sm bg-fill-secondary" />
    </div>
  );
}

/** Man-hours per unit: read to the thousandth under ten, where 0.045 rounds to nothing. */
function perUnitHours(value: number): string {
  return value < 10 ? value.toFixed(value < 1 ? 3 : 2) : moneyCentsFmt.format(value);
}

/** The exact figure, for the tooltip. */
function exactText(kind: FigureKind, value: number): string {
  if (kind === "hours") return `${moneyCentsFmt.format(value)} man-hours`;
  return currencyCentsFmt.format(value);
}

function trueMinus(text: string): string {
  return text.replace("-", "−");
}

function signedMoney(delta: number, cents: boolean): string {
  const magnitude = (cents ? currencyCentsFmt : currencyFmt).format(Math.abs(delta));
  return `${delta < 0 ? "−" : "+"}${magnitude}`;
}

/**
 * Copy with local feedback: which line was just copied, and what to announce.
 *
 * Both clear themselves after a moment. The label has to return to the line's
 * name, and a live region only speaks when its text CHANGES: left holding
 * "Copied Labor", copying Labor a second time said nothing, and the stale
 * sentence stayed in the panel for a screen reader to stumble on later.
 */
function useCopy(): {
  copiedId: string | null;
  announcement: string;
  copy: (id: string, label: string, text: string) => Promise<void>;
} {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (id: string, label: string, text: string) => {
    let ok = true;
    try {
      await writeClipboard(text);
    } catch {
      ok = false;
    }
    clearTimeout(timer.current);
    setCopiedId(ok ? id : null);
    setAnnouncement(ok ? `Copied ${label}: ${text}` : `Could not copy ${label}`);
    timer.current = setTimeout(() => {
      setCopiedId(null);
      setAnnouncement("");
    }, 900);
  }, []);

  return { copiedId, announcement, copy };
}

/**
 * How far the last edit moved a figure, held across renders.
 *
 * It stays until the next edit or the next navigation, so it can be read after
 * looking up from the grid. Every rule about WHEN a change counts lives in
 * `./last-change`, which is pure and tested; this only gives it a clock.
 */
function useLastChange(value: number, scopeKey: string, settled: boolean): LastChange | null {
  const [change, setChange] = useState<LastChange | null>(null);
  const track = useRef<ChangeTrack | null>(null);

  useEffect(() => {
    const input = { scopeKey, settled, value };
    if (track.current === null) {
      track.current = startTrack(input);
      return;
    }
    const next = advanceTrack(track.current, input, performance.now());
    track.current = next.track;
    if (next.change !== undefined) setChange(next.change);
  }, [value, scopeKey, settled]);

  return change;
}

/**
 * Tints its text when the value changes — the edit's effect made visible.
 *
 * MOTION IS ASYMMETRIC: the tint lands instantly (the change just happened)
 * and decays fast — a slow symmetric fade reads as lag, not feedback.
 *
 * Two guards keep the flash honest. `resetKey` is the scope's identity: when it
 * changes, the numbers belong to something else and settle silently. `silent`
 * covers the round trip after a navigation, when the figures on screen are the
 * previous sibling's and are about to be replaced. The flash means "your edit
 * moved this number", never "you moved".
 */
function FlashValue({
  value,
  resetKey,
  silent = false,
  className,
  children,
}: {
  value: number;
  /** Identity of the thing being summarized; a change settles silently. */
  resetKey?: string;
  /** The value is a stand-in for data still loading. Adopt it without ceremony. */
  silent?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const previous = useRef<number | null>(null);
  const lastReset = useRef(resetKey);
  const wasSilent = useRef(silent);
  const [phase, setPhase] = useState<"idle" | "peak" | "decay">("idle");

  useEffect(() => {
    // The first settled value after a silent stretch is the real data ARRIVING,
    // not an edit, so it is adopted silently too.
    const quiet = silent || wasSilent.current || lastReset.current !== resetKey;
    wasSilent.current = silent;
    lastReset.current = resetKey;
    if (quiet) {
      previous.current = value;
      return;
    }
    if (previous.current !== null && previous.current !== value) {
      previous.current = value;
      setPhase("peak");
      const decay = setTimeout(() => setPhase("decay"), 120);
      const settle = setTimeout(() => setPhase("idle"), 480);
      return () => {
        clearTimeout(decay);
        clearTimeout(settle);
        // Cancelling the timers cancels the only thing that brings the tint
        // back down. A quiet adoption landing inside those 480ms (a navigation,
        // data arriving) would otherwise strand the figure at "peak" on a scope
        // nobody edited. A new flash in the same commit overrides this in the
        // same batch, so a run of edits still ends tinted.
        setPhase("idle");
      };
    }
    previous.current = value;
  }, [value, resetKey, silent]);

  return (
    <span
      // The phase classes come LAST. `cn` is tailwind-merge, where the later of
      // two text colours wins, and the caller's may be the dash's subtle grey.
      className={cn(
        className,
        phase === "peak" && "text-primary transition-none",
        phase === "decay" && "transition-colors duration-300 ease-out"
      )}
    >
      {children}
    </span>
  );
}
