"use client";

import * as React from "react";
import { cn } from "@truss/ui/lib/utils";
import type { GroupSummary } from "./types";

/**
 * Project status slices for the top of the Workbook (test-log #38).
 *
 * Replaces the single overall progress line with category roll-ups so a PM can
 * read self-perform vs. subcontract vs. change-order progress at a glance. The
 * category-to-WBS mapping and the cumulative roll-ups are exactly the defaults
 * Matt specified:
 *
 *   Mob/Demob   = WBS 10000 + 190000
 *   Indirects   = WBS 200000
 *   Directs     = WBS 20000–70000
 *   Subcontracts= WBS 80000–180000
 *   Change Orders = WBS 300000
 *
 *   Self-Perform = Mob/Demob + Indirects + Directs
 *   Award Scope  = Self-Perform + Subcontracts
 *   Project Total= Award Scope + Change Orders
 *
 * Every value is derived from the per-WBS rollups already loaded for the
 * workbook, so the dashboard needs no extra query.
 */

/** Compact MH for the dashboard glance — full precision stays in the table. */
function fmtMHk(val: number): string {
  if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
  return Math.round(val).toLocaleString();
}

/** 2-decimal percentage, matching the workbook convention (#13). */
function fmtPct(val: number): string {
  return `${val.toFixed(2)}%`;
}

interface Slice {
  earnedMH: number;
  totalMH: number;
  percentComplete: number;
}

const makeSlice = (earnedMH: number, totalMH: number): Slice => ({
  earnedMH,
  totalMH,
  percentComplete: totalMH > 0 ? (earnedMH / totalMH) * 100 : 0,
});

type CategoryKey = "directs" | "indirects" | "mobDemob" | "subcontracts" | "changeOrders";

export interface StatusSliceData {
  categories: Record<CategoryKey, Slice>;
  selfPerform: Slice;
  awardScope: Slice;
  projectTotal: Slice;
}

/** Bucket a WBS code into one of the status categories (#38 default mapping). */
function categoryForCode(code: number): CategoryKey | null {
  if (code === 10000 || code === 190000) return "mobDemob";
  if (code === 200000) return "indirects";
  if (code >= 20000 && code <= 70000) return "directs";
  if (code >= 80000 && code <= 180000) return "subcontracts";
  if (code === 300000) return "changeOrders";
  return null;
}

/**
 * Compute the status slices from the workbook's per-WBS rollups. Pure and
 * order-independent (a plain sum), so it is unaffected by Convex record-key
 * ordering.
 */
export function computeStatusSlices(wbsSummaries: Record<string, GroupSummary>): StatusSliceData {
  const acc: Record<CategoryKey, { e: number; t: number }> = {
    directs: { e: 0, t: 0 },
    indirects: { e: 0, t: 0 },
    mobDemob: { e: 0, t: 0 },
    subcontracts: { e: 0, t: 0 },
    changeOrders: { e: 0, t: 0 },
  };

  for (const s of Object.values(wbsSummaries)) {
    const code = Number(s.code);
    const cat = Number.isFinite(code)
      ? categoryForCode(code)
      : s.source === "change_order"
        ? "changeOrders"
        : null;
    if (!cat) continue;
    acc[cat].e += s.earnedMH ?? 0;
    acc[cat].t += s.totalMH ?? 0;
  }

  const categories: Record<CategoryKey, Slice> = {
    directs: makeSlice(acc.directs.e, acc.directs.t),
    indirects: makeSlice(acc.indirects.e, acc.indirects.t),
    mobDemob: makeSlice(acc.mobDemob.e, acc.mobDemob.t),
    subcontracts: makeSlice(acc.subcontracts.e, acc.subcontracts.t),
    changeOrders: makeSlice(acc.changeOrders.e, acc.changeOrders.t),
  };

  const spE = acc.mobDemob.e + acc.indirects.e + acc.directs.e;
  const spT = acc.mobDemob.t + acc.indirects.t + acc.directs.t;
  const awE = spE + acc.subcontracts.e;
  const awT = spT + acc.subcontracts.t;

  return {
    categories,
    selfPerform: makeSlice(spE, spT),
    awardScope: makeSlice(awE, awT),
    projectTotal: makeSlice(awE + acc.changeOrders.e, awT + acc.changeOrders.t),
  };
}

/**
 * Cohesive cool palette (blue → cyan → indigo → violet) for the self-perform /
 * subcontract scopes, with amber reserved for Change Orders. Used as small
 * identity dots + thin progress fills — restrained, not a saturated rainbow.
 */
const COLORS: Record<CategoryKey, string> = {
  directs: "#3b82f6",
  indirects: "#06b6d4",
  mobDemob: "#6366f1",
  subcontracts: "#8b5cf6",
  changeOrders: "#f59e0b",
};

const CATEGORY_META: Array<{ key: CategoryKey; label: string }> = [
  { key: "directs", label: "Directs" },
  { key: "indirects", label: "Indirects" },
  { key: "mobDemob", label: "Mob/Demob" },
  { key: "subcontracts", label: "Subcontracts" },
  { key: "changeOrders", label: "Change Orders" },
];

const ROLLUPS: Array<{ key: "selfPerform" | "awardScope" | "projectTotal"; label: string }> = [
  { key: "selfPerform", label: "Self-Perform Scope" },
  { key: "awardScope", label: "Total Award Scope" },
  { key: "projectTotal", label: "Project Total" },
];

/** Thin progress fill on a hairline track. Color via hex (`color`) or class. */
function Bar({
  pct,
  color,
  fillClassName,
  className,
}: {
  pct: number;
  color?: string;
  fillClassName?: string;
  className?: string;
}) {
  const width = `${Math.min(Math.max(pct, 0), 100)}%`;
  return (
    <div className={cn("overflow-hidden rounded-full bg-foreground/[0.08]", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500 ease-out", fillClassName)}
        style={color ? { width, backgroundColor: color } : { width }}
      />
    </div>
  );
}

export interface ProjectStatusSlicesProps {
  /** Per-WBS rollups from the workbook query. */
  wbsSummaries: Record<string, GroupSummary>;
  className?: string;
}

/**
 * Status-slices dashboard for the top of the Workbook (#38). Two restrained
 * tiers: the overall hero number with the five scope categories, then the three
 * cumulative roll-ups — compact, hairline bars, cohesive color.
 */
export function ProjectStatusSlices({ wbsSummaries, className }: ProjectStatusSlicesProps) {
  const slices = React.useMemo(() => computeStatusSlices(wbsSummaries), [wbsSummaries]);
  const overall = slices.projectTotal;

  return (
    <div className={cn("rounded-xl border border-border/70 bg-card px-5 py-4", className)}>
      {/* Top tier — overall hero + per-category columns */}
      <div className="flex items-start gap-6">
        <div className="shrink-0">
          <div
            className={cn(
              "text-[30px] font-semibold leading-none tracking-tight tabular-nums",
              overall.percentComplete > 100 ? "text-mac-orange" : "text-foreground"
            )}
          >
            {fmtPct(overall.percentComplete)}
          </div>
          <div className="mt-1.5 text-footnote text-muted-foreground">Project Complete</div>
          <div className="mt-1 text-[10px] font-mono tabular-nums text-foreground-subtle">
            {fmtMHk(overall.earnedMH)} / {fmtMHk(overall.totalMH)} MH
          </div>
        </div>

        <div className="h-12 w-px shrink-0 self-center bg-border/70" />

        <div className="grid min-w-0 flex-1 grid-cols-5 gap-x-6">
          {CATEGORY_META.map((c) => {
            const d = slices.categories[c.key];
            return (
              <StatCell
                key={c.key}
                label={c.label}
                dotColor={COLORS[c.key]}
                barColor={COLORS[c.key]}
                data={d}
                showMH
              />
            );
          })}
        </div>
      </div>

      {/* Bottom tier — cumulative roll-ups (single brand accent) */}
      <div className="mt-4 grid grid-cols-3 gap-x-6 border-t border-border/70 pt-3.5">
        {ROLLUPS.map((r) => (
          <StatCell
            key={r.key}
            label={r.label}
            barFillClassName="bg-primary"
            data={slices[r.key]}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One stat: dotted label, then a thin progress bar trailed by its percentage,
 * and (for categories) an earned/total MH line. The single shared primitive
 * for both category and roll-up tiers.
 */
function StatCell({
  label,
  data,
  dotColor,
  barColor,
  barFillClassName,
  showMH,
}: {
  label: string;
  data: Slice;
  dotColor?: string;
  barColor?: string;
  barFillClassName?: string;
  showMH?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", !dotColor && "bg-primary")}
          style={dotColor ? { backgroundColor: dotColor } : undefined}
        />
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Bar
          pct={data.percentComplete}
          color={barColor}
          fillClassName={barFillClassName}
          className="h-1 flex-1"
        />
        <span className="shrink-0 text-subheadline font-semibold tabular-nums text-foreground">
          {fmtPct(data.percentComplete)}
        </span>
      </div>
      {showMH && (
        <div className="mt-1.5 text-[10px] font-mono tabular-nums text-foreground-subtle">
          {fmtMHk(data.earnedMH)} / {fmtMHk(data.totalMH)} MH
        </div>
      )}
    </div>
  );
}
