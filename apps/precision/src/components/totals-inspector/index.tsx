import { cn } from "@truss/ui/lib/utils";
import { Button } from "@truss/ui/components/button";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../../lib/clipboard";
import {
  countFmt,
  currencyCentsFmt,
  currencyFmt,
  hoursFmt,
  moneyCentsFmt,
  moneyFmt,
  quantityFmt,
} from "../grid-figures";
import {
  deriveTotalsView,
  formatPercent,
  rawValue,
  type EstimateSummary,
  type Figure,
  type FigureSection,
  type ScopeCosts,
  type TakeoffState,
  type TotalsDepth,
} from "./derive";
import { advanceTrack, startTrack, type ChangeTrack, type LastChange } from "./last-change";

export type { EstimateSummary, ScopeCosts, TakeoffState, TotalsDepth } from "./derive";

/**
 * The totals panel: what this sheet costs, what that is made of, whether the
 * rates are sane, and the bid it belongs to.
 *
 * WHY A RIGHT INSPECTOR: estimators watch the bid react as they type; that is
 * properties-of-the-current-context, which is what the design doc's "optional
 * right inspector" region is for.
 *
 * ⚠️ ONE PANEL FOR ALL THREE SHEETS, ONE ANATOMY. The overview, the phase table
 * and the activity grid are the same report at three depths and carry the same
 * instrument, so a figure is always in the same place:
 *
 *   header  the answer       one hero figure, its hours, its takeoff
 *   body    what it is made of  cost with shares, hours, unit rates
 *   footer  what it belongs to  the bid, this scope's share of it
 *
 * The header and footer are pinned and only the body scrolls, so the two
 * figures an estimator watches while typing, this sheet and the bid, never
 * leave the screen.
 *
 * ⚠️ ONE HERO. The panel this replaced printed the scope total twice and four
 * bold totals in all, and the eye had nowhere to land. Exactly one figure is
 * set large, and no other line restates it.
 *
 * ⚠️ QUIET WHEN THERE IS NOTHING TO SAY. A line worth nothing prints the same
 * dash an empty grid cell does, and a scope with nothing priced prints one
 * sentence. Twenty rows of "$0" is a panel shouting that it is empty.
 *
 * Figures flash when an edit moves them and settle silently on navigation.
 * What the panel PRINTS is decided in `./derive`, which is pure and tested;
 * this file only draws it.
 */

const OPEN_KEY = "precision.totalsInspector.open";

/** Panel open state, persisted so the choice survives navigation and restarts. */
export function useTotalsInspector(): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((prev) => {
      try {
        localStorage.setItem(OPEN_KEY, prev ? "closed" : "open");
      } catch {
        // Preference persistence is best-effort.
      }
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
  /** The scope's measured quantity. Absent at estimate depth. */
  takeoff?: TakeoffState;
  /** Completed phases in scope, for "9 of 14 complete". */
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

const SCOPE_NOUN: Record<TotalsDepth, string> = {
  estimate: "estimate",
  wbs: "breakdown",
  phase: "phase",
};

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
        formatQuantity: quantityFmt.format,
        formatCount: countFmt.format,
      }),
    [depth, scopeCosts, summary, takeoff]
  );

  // The phase sheet prints cents because prices are typed there; the rollups
  // round. The panel follows the sheet it stands beside, so its hero and the
  // figure at the foot of the grid are the same string. See `grid-figures`.
  const cents = depth === "phase";

  const change = useLastChange(view.total, scopeKey, settled);
  const { copiedId, copy } = useCopy();
  const [announcement, setAnnouncement] = useState("");

  const copyFigure = useCallback(
    (id: string, label: string, kind: Figure["kind"], value: number) => {
      const raw = rawValue(kind, value);
      void copy(id, raw).then((ok) => {
        setAnnouncement(ok ? `Copied ${label}: ${raw}` : `Could not copy ${label}`);
      });
    },
    [copy]
  );

  /**
   * One tab stop, arrows inside.
   *
   * Every line is a button (a click copies its number), and twenty buttons in
   * the tab order would put twenty stops between the grid and whatever follows
   * it. The hero is the single stop; the arrow keys walk the lines from there.
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const lines = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-totals-line]:enabled")
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
  const heroText = (cents ? currencyCentsFmt : currencyFmt).format(view.total);

  return (
    <aside
      aria-label="Totals"
      onKeyDown={onKeyDown}
      className="flex w-[17.5rem] shrink-0 flex-col border-l bg-fill-quaternary/40"
    >
      {/* ── The answer ── */}
      <header className="shrink-0 border-b px-4 pt-3 pb-3">
        <div className="flex items-baseline justify-between gap-3 text-footnote">
          <p className="min-w-0 truncate font-semibold uppercase tracking-wider text-muted-foreground">
            {eyebrow}
            {isIndirect && <span className="font-medium"> · Indirect</span>}
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
            className="mt-1 line-clamp-2 text-callout font-medium text-foreground"
            title={scopeName}
          >
            {scopeName}
          </p>
        )}

        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <button
            type="button"
            data-totals-line
            onClick={() => copyFigure("hero", "total", "money", view.total)}
            title={`${currencyCentsFmt.format(view.total)} · click to copy`}
            aria-label={`${SCOPE_NOUN[depth]} total ${heroText}. Press Enter to copy.`}
            className={cn(
              "-mx-1 shrink-0 rounded-sm px-1 font-mono text-title2 font-semibold tabular-nums",
              "hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              view.isEmpty && "text-muted-foreground"
            )}
          >
            <FlashValue value={view.total} resetKey={scopeKey} silent={!settled}>
              {copiedId === "hero" ? "Copied" : heroText}
            </FlashValue>
          </button>
          {change && (
            <span
              className="min-w-0 truncate font-mono text-xs tabular-nums text-muted-foreground"
              title={`Last change: ${currencyCentsFmt.format(change.from)} to ${currencyCentsFmt.format(change.to)}`}
            >
              {signed(change.to - change.from, cents)}
            </span>
          )}
        </div>

        <div className="mt-0.5 flex items-baseline justify-between gap-3 text-callout">
          <span className={cn(view.isEmpty && "text-muted-foreground")}>
            <FlashValue
              value={view.hours}
              resetKey={scopeKey}
              silent={!settled}
              className="font-mono tabular-nums"
            >
              {hoursFmt.format(view.hours)}
            </FlashValue>
            <span className="text-muted-foreground"> MH</span>
          </span>
          {view.takeoffText && (
            <span
              className="flex min-w-0 items-center gap-1.5 font-mono tabular-nums"
              title={
                view.takeoffIsOverridden
                  ? "Takeoff quantity, entered by hand"
                  : "Takeoff quantity, from the lines that count toward it"
              }
            >
              {view.takeoffIsOverridden && (
                <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-primary" />
              )}
              <span className="truncate">{view.takeoffText}</span>
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col short:overflow-y-auto">
        {/* ── What it is made of ── */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 short:flex-none short:overflow-visible">
          {view.isEmpty ? (
            <p className="text-xs text-muted-foreground">
              Nothing priced in this {SCOPE_NOUN[depth]} yet.
            </p>
          ) : (
            view.sections.map((section) => (
              <FigureGroup
                key={section.id}
                section={section}
                cents={cents}
                scopeKey={scopeKey}
                silent={!settled}
                copiedId={copiedId}
                onCopy={copyFigure}
              />
            ))
          )}
        </div>

        {/* ── What it belongs to ── */}
        <footer className="shrink-0 space-y-3 border-t bg-fill-quaternary/60 px-4 py-3">
          {selection && selection.count > 0 && (
            <SelectionBlock
              selection={selection}
              scopeTotal={view.total}
              noun={SCOPE_NOUN[depth]}
              cents={cents}
              copiedId={copiedId}
              onCopy={copyFigure}
            />
          )}

          <section aria-labelledby="totals-estimate-heading">
            <h3
              id="totals-estimate-heading"
              className="mb-1 text-footnote font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Estimate
            </h3>
            {view.estimate ? (
              <div>
                {view.estimate.map((figure) => (
                  <FigureLine
                    key={figure.id}
                    figure={figure}
                    // The bid is a rollup at every depth, and rollups round.
                    cents={false}
                    scopeKey="estimate"
                    silent={!settled}
                    copied={copiedId === figure.id}
                    onCopy={copyFigure}
                  />
                ))}
                {view.contents && (
                  <p className="mt-1.5 text-xs text-muted-foreground">{view.contents}</p>
                )}
              </div>
            ) : (
              <EstimateLoading />
            )}
          </section>

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
                <span className="font-mono tabular-nums">
                  {currencyFmt.format(view.hidden.cost)}
                </span>
                , included in the total.
              </span>
            </p>
          )}
        </footer>
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

/** The right end of the eyebrow: how far along this scope is. */
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
    text = `${countFmt.format(completedCount)} of ${countFmt.format(phaseCount)} complete`;
  }

  if (text === null) return null;
  return (
    // State is a dot plus ordinary text. The success token as a TEXT colour is
    // about 2.4:1 on this surface, and a dot survives forced-colors mode with
    // the sentence beside it still saying the same thing.
    <p
      className={cn(
        "flex shrink-0 items-center gap-1.5",
        done ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {done && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />}
      {text}
    </p>
  );
}

function FigureGroup({
  section,
  cents,
  scopeKey,
  silent,
  copiedId,
  onCopy,
}: {
  section: FigureSection;
  cents: boolean;
  scopeKey: string;
  silent: boolean;
  copiedId: string | null;
  onCopy: (id: string, label: string, kind: Figure["kind"], value: number) => void;
}) {
  const headingId = `totals-${section.id}-heading`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-footnote">
        <h3 id={headingId} className="font-semibold uppercase tracking-wider text-muted-foreground">
          {section.heading}
        </h3>
        {section.caption && <span className="text-muted-foreground">{section.caption}</span>}
      </div>
      <div>
        {section.figures.map((figure) => (
          <FigureLine
            key={figure.id}
            figure={figure}
            cents={cents}
            scopeKey={scopeKey}
            silent={silent}
            copied={copiedId === figure.id}
            onCopy={onCopy}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One line: a label, its figure, and its share.
 *
 * ⚠️ ONE FIGURE AXIS FOR THE WHOLE PANEL. Every figure ends at the same x, with
 * the share column to its right, whether or not the line has a share. Figures
 * that start at the panel's edge in one section and 44px in from it in the next
 * make a column of numbers read as two.
 *
 * The whole line is a button: a click puts the bare number on the clipboard,
 * because the next place an estimator needs it is a spreadsheet cell or an
 * email. The LABEL says "Copied" rather than the figure, so the number being
 * read never leaves the screen.
 */
function FigureLine({
  figure,
  cents,
  scopeKey,
  silent,
  copied,
  onCopy,
}: {
  figure: Figure;
  cents: boolean;
  scopeKey: string;
  silent: boolean;
  copied: boolean;
  onCopy: (id: string, label: string, kind: Figure["kind"], value: number) => void;
}) {
  const { value } = figure;
  const text = value === null ? null : formatFigure(figure, value, cents);
  const hintId = figure.hint ? `totals-hint-${figure.id}` : undefined;

  return (
    <button
      type="button"
      data-totals-line
      tabIndex={-1}
      disabled={value === null}
      onClick={() => value !== null && onCopy(figure.id, figure.label, figure.kind, value)}
      title={lineTitle(figure, value)}
      aria-describedby={hintId}
      className={cn(
        "-mx-1 flex h-5 w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 text-xs",
        figure.startsGroup && "mt-2",
        "enabled:hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left text-muted-foreground",
          figure.indent && "pl-3"
        )}
      >
        {copied ? "Copied" : figure.label}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono tabular-nums",
          figure.isTotal && "font-medium",
          figure.indent ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {text === null ? (
          <span className="text-foreground-subtle">—</span>
        ) : figure.flashes ? (
          <FlashValue value={value ?? 0} resetKey={scopeKey} silent={silent}>
            {text}
          </FlashValue>
        ) : (
          text
        )}
      </span>
      <span className="w-11 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
        {figure.share === null ? "" : formatPercent(figure.share)}
      </span>
      {figure.hint && (
        <span id={hintId} className="sr-only">
          {figure.hint}
        </span>
      )}
    </button>
  );
}

/**
 * What the ticked rows add up to: the spreadsheet status bar, in the panel.
 *
 * A BLOCK OF ITS OWN rather than a re-scoped panel. Swapping the hero for the
 * selection's total would make the largest number on the window change meaning
 * when a checkbox is ticked, and the panel's first job is that "this sheet's
 * total" always means this sheet's total.
 */
function SelectionBlock({
  selection,
  scopeTotal,
  noun,
  cents,
  copiedId,
  onCopy,
}: {
  selection: SelectionTotals;
  scopeTotal: number;
  noun: string;
  cents: boolean;
  copiedId: string | null;
  onCopy: (id: string, label: string, kind: Figure["kind"], value: number) => void;
}) {
  const share =
    scopeTotal > 0 && selection.totalCost !== 0 ? selection.totalCost / scopeTotal : null;
  const lines: Figure[] = [
    line("selectionTotal", "Total", "money", selection.totalCost, true),
    line("selectionHours", "Man-hours", "hours", selection.hours, false),
    {
      ...line("selectionShare", `Of this ${noun}`, "percent", share ?? 0, false),
      value: share,
    },
  ];
  return (
    <section aria-labelledby="totals-selection-heading">
      <div className="mb-1 flex items-baseline justify-between gap-3 text-footnote">
        <h3
          id="totals-selection-heading"
          className="font-semibold uppercase tracking-wider text-foreground"
        >
          Selected
        </h3>
        <span className="text-muted-foreground">
          {countFmt.format(selection.count)} of {countFmt.format(selection.of)}
        </span>
      </div>
      {lines.map((figure) => (
        <FigureLine
          key={figure.id}
          figure={figure}
          cents={cents}
          // A selection's figures change because the SELECTION changed, which is
          // not an edit moving a number. They never flash.
          scopeKey="selection"
          silent
          copied={copiedId === figure.id}
          onCopy={onCopy}
        />
      ))}
    </section>
  );
}

function line(
  id: string,
  label: string,
  kind: Figure["kind"],
  value: number,
  isTotal: boolean
): Figure {
  return {
    id,
    label,
    kind,
    value: value === 0 && kind !== "percent" ? null : value,
    share: null,
    indent: false,
    isTotal,
    flashes: false,
  };
}

/** Bars, not "…": the block keeps its height, so nothing jumps when it lands. */
function EstimateLoading() {
  return (
    <div className="space-y-2 py-1" aria-busy="true">
      <span className="sr-only">Loading estimate totals</span>
      <div className="h-3 w-full animate-pulse rounded-sm bg-fill-secondary" />
      <div className="h-3 w-3/4 animate-pulse rounded-sm bg-fill-secondary" />
      <div className="h-3 w-5/6 animate-pulse rounded-sm bg-fill-secondary" />
    </div>
  );
}

function formatFigure(figure: Figure, value: number, cents: boolean): string {
  switch (figure.kind) {
    case "money": {
      const symbol = figure.isTotal;
      const fmt = cents
        ? symbol
          ? currencyCentsFmt
          : moneyCentsFmt
        : symbol
          ? currencyFmt
          : moneyFmt;
      return trueMinus(fmt.format(value));
    }
    case "hours":
      return hoursFmt.format(value);
    case "rate":
      return currencyCentsFmt.format(value);
    case "hoursPerUnit":
      // A unit rate under ten is read to the thousandth: 0.045 MH/SF rounds to
      // a meaningless 0.05 at two decimals.
      return value < 10 ? value.toFixed(3) : moneyCentsFmt.format(value);
    case "percent":
      return formatPercent(value);
  }
}

/** The tooltip: the exact figure, then what the line means. */
function lineTitle(figure: Figure, value: number | null): string | undefined {
  if (value === null) return figure.hint;
  const exact =
    figure.kind === "money"
      ? currencyCentsFmt.format(value)
      : figure.kind === "hours"
        ? `${moneyCentsFmt.format(value)} MH`
        : null;
  return [exact, figure.hint, "Click to copy"].filter(Boolean).join(" · ");
}

function trueMinus(text: string): string {
  return text.replace("-", "−");
}

function signed(delta: number, cents: boolean): string {
  const magnitude = (cents ? moneyCentsFmt : moneyFmt).format(Math.abs(delta));
  return `${delta < 0 ? "−" : "+"}${magnitude}`;
}

/** Copy with local feedback: which line was just copied, for a moment. */
function useCopy(): {
  copiedId: string | null;
  copy: (id: string, text: string) => Promise<boolean>;
} {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (id: string, text: string) => {
    try {
      await writeClipboard(text);
    } catch {
      return false;
    }
    clearTimeout(timer.current);
    setCopiedId(id);
    timer.current = setTimeout(() => setCopiedId(null), 900);
    return true;
  }, []);

  return { copiedId, copy };
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
      };
    }
    previous.current = value;
  }, [value, resetKey, silent]);

  return (
    <span
      className={cn(
        phase === "peak" && "text-primary transition-none",
        phase === "decay" && "transition-colors duration-300 ease-out",
        className
      )}
    >
      {children}
    </span>
  );
}
