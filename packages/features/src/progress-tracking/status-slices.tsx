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

/** 2-decimal MH, matching the workbook number convention (#13). */
function fmtMH(val: number): string {
  return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/** Categorical palette — vivid enough to scan, legible on dark surfaces. */
const COLORS = {
  directs: "#3b82f6",
  indirects: "#14b8a6",
  mobDemob: "#8b5cf6",
  subcontracts: "#ec4899",
  changeOrders: "#d97706",
  selfPerform: "#3b82f6",
  awardScope: "#ec4899",
  projectTotal: "#64748b",
} as const;

const CATEGORY_META: Array<{ key: CategoryKey; label: string; color: string }> = [
  { key: "directs", label: "Directs", color: COLORS.directs },
  { key: "indirects", label: "Indirects", color: COLORS.indirects },
  { key: "mobDemob", label: "Mob/Demob", color: COLORS.mobDemob },
  { key: "subcontracts", label: "Subcontracts", color: COLORS.subcontracts },
  { key: "changeOrders", label: "Change Orders", color: COLORS.changeOrders },
];

/** Colored progress fill on a neutral track. */
function Bar({ pct, color, className }: { pct: number; color: string; className?: string }) {
  return (
    <div className={cn("rounded-full bg-fill-quaternary overflow-hidden", className)}>
      <div
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}

/** A single category column: label · %, bar, earned / total MH. */
function MiniSlice({ label, color, data }: { label: string; color: string; data: Slice }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-footnote font-medium text-muted-foreground truncate">{label}</span>
        <span className="text-footnote font-semibold tabular-nums shrink-0" style={{ color }}>
          {fmtPct(data.percentComplete)}
        </span>
      </div>
      <Bar pct={data.percentComplete} color={color} className="mt-1.5 h-1.5" />
      <div className="mt-1.5 text-[11px] font-mono tabular-nums text-foreground-subtle truncate">
        {fmtMH(data.earnedMH)} / {fmtMH(data.totalMH)}
      </div>
    </div>
  );
}

/** A full-width cumulative roll-up bar. */
function RollupBar({ label, color, data }: { label: string; color: string; data: Slice }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="text-footnote font-semibold uppercase tracking-wide truncate"
          style={{ color }}
        >
          {label}
        </span>
        <span className="text-footnote font-semibold tabular-nums shrink-0" style={{ color }}>
          {fmtPct(data.percentComplete)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <Bar pct={data.percentComplete} color={color} className="flex-1 h-2" />
        <span className="w-44 shrink-0 text-right text-[11px] font-mono tabular-nums text-foreground-subtle">
          {fmtMH(data.earnedMH)} / {fmtMH(data.totalMH)} MH
        </span>
      </div>
    </div>
  );
}

export interface ProjectStatusSlicesProps {
  /** Per-WBS rollups from the workbook query. */
  wbsSummaries: Record<string, GroupSummary>;
  className?: string;
}

/**
 * Status-slices dashboard for the top of the Workbook (#38, Option 2 — overall
 * + per-category columns + cumulative roll-up bars).
 */
export function ProjectStatusSlices({ wbsSummaries, className }: ProjectStatusSlicesProps) {
  const slices = React.useMemo(() => computeStatusSlices(wbsSummaries), [wbsSummaries]);
  const overall = slices.projectTotal;

  return (
    <div className={cn("rounded-xl border bg-card p-4", className)}>
      <div className="flex items-start gap-5">
        {/* Overall — the hero number */}
        <div className="shrink-0 border-r pr-5">
          <div
            className={cn(
              "text-title1 font-bold tabular-nums leading-none",
              overall.percentComplete > 100 ? "text-mac-orange" : "text-foreground"
            )}
          >
            {fmtPct(overall.percentComplete)}
          </div>
          <div className="mt-1.5 text-footnote text-muted-foreground">Project Complete</div>
        </div>

        {/* Category columns */}
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          {CATEGORY_META.map((c) => (
            <MiniSlice
              key={c.key}
              label={c.label}
              color={c.color}
              data={slices.categories[c.key]}
            />
          ))}
        </div>
      </div>

      {/* Cumulative roll-ups */}
      <div className="mt-4 space-y-3 border-t pt-4">
        <RollupBar
          label="Total Self-Perform Scope"
          color={COLORS.selfPerform}
          data={slices.selfPerform}
        />
        <RollupBar
          label="Self-Perform + Subcontracts = Total Award Scope"
          color={COLORS.awardScope}
          data={slices.awardScope}
        />
        <RollupBar
          label="Project Total (Award + Change Orders)"
          color={COLORS.projectTotal}
          data={slices.projectTotal}
        />
      </div>
    </div>
  );
}
