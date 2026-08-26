import { api } from "@truss/backend/convex/_generated/api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { useMemo } from "react";
import type { CatalogRow, PoolKind } from "./pool-model";

/**
 * Narrowing the catalog to one branch of the tree.
 *
 * ⚠️ THE SCOPE IS A SERVER FILTER, NOT A CLIENT ONE. `listCatalogRows` takes
 * `parentPoolId` and reads the matching index, so scoping labor to one phase
 * fetches that phase's rows rather than fetching 5,897 and hiding the rest.
 *
 * ⚠️ WHY LABOR IS SCOPED BY PHASE AND NOT BY WORK BREAKDOWN, even though a
 * two-step picker would feel familiar: a labor row carries `phasePoolId` and
 * nothing else, and the only index that exists is `by_book_phase_pool_id`. A
 * work-breakdown step would therefore either scope nothing — leaving the
 * listing on all 5,897 rows while appearing to have narrowed it — or filter a
 * page after the fact, which is worse: a page of 400 might hold three matching
 * rows and the screen would report that as "three". One grouped list of phases
 * says what can actually be asked for.
 *
 * @module
 */

/** Every work breakdown and phase in a book, in one read. */
export type BookScopes = typeof api.catalog.getBookScopes._returnType;

/** Names resolved locally, so a page of rows costs no lookups. */
export interface ScopeIndex {
  /** Work breakdowns in catalog order. */
  wbs: BookScopes["wbs"];
  /** Phases in catalog order, still carrying the breakdown they belong to. */
  phases: BookScopes["phases"];
  /** The name of the scope a row is filed under, or a dash. */
  parentName: (pool: PoolKind, row: CatalogRow) => string;
  /**
   * Whether the scope a row is filed under has itself been retired.
   *
   * An active labor row under a phase this draft withdrew is invisible
   * otherwise — the row reads as perfectly normal while the phase carrying it
   * is on its way out of the catalog. The picker already marks a retired phase;
   * the grid has to say the same thing or the two disagree.
   */
  parentRetired: (pool: PoolKind, row: CatalogRow) => boolean;
  /** One phase's name, for a confirmation that says where a row is going. */
  phaseName: (poolId: number) => string;
}

/** Catalog order: the sort the book itself declares, then the id. */
function byOrder<T extends { sortOrder: number; poolId: number }>(a: T, b: T): number {
  return a.sortOrder === b.sortOrder ? a.poolId - b.poolId : a.sortOrder - b.sortOrder;
}

/**
 * The scope tree as maps, rebuilt only when the book changes.
 *
 * This is what makes `getBookScopes` worth its own query: 18 work breakdowns
 * and 228 phases fetched once and joined here, rather than one lookup per row
 * on a page of 400.
 */
export function useScopeIndex(scopes: BookScopes | undefined): ScopeIndex {
  return useMemo(() => {
    const wbs = [...(scopes?.wbs ?? [])].sort(byOrder);
    const phases = [...(scopes?.phases ?? [])].sort(byOrder);
    const wbsById = new Map(wbs.map((row) => [row.poolId, row]));
    const phasesById = new Map(phases.map((row) => [row.poolId, row]));
    const scopeOf = (pool: PoolKind, row: CatalogRow) =>
      row.parentPoolId === null
        ? undefined
        : pool === "labor"
          ? phasesById.get(row.parentPoolId)
          : wbsById.get(row.parentPoolId);

    return {
      wbs,
      phases,
      parentName: (pool, row) => {
        if (row.parentPoolId === null) return "—";
        // A row whose scope is not in the book is a real state — the phase may
        // have been dropped by a later import — so it shows the id rather than
        // going blank and looking like a rendering fault.
        return scopeOf(pool, row)?.name ?? `#${row.parentPoolId}`;
      },
      parentRetired: (pool, row) => scopeOf(pool, row)?.isActive === false,
      phaseName: (poolId) => phasesById.get(poolId)?.name ?? `#${poolId}`,
    };
  }, [scopes]);
}

/** Radix needs a non-empty value, and "the whole pool" needs a name. */
const WHOLE_POOL = "all";

/**
 * The phases of a book, grouped under the work breakdown they belong to.
 *
 * Shared by the scope picker and the add-row dialog, because "which phase?" is
 * the same question in both and the grouping is the only thing that makes 228
 * options readable.
 */
export function PhaseOptions({ scopes }: { scopes: ScopeIndex }) {
  return (
    <>
      {scopes.wbs.map((breakdown) => {
        const phases = scopes.phases.filter((phase) => phase.wbsPoolId === breakdown.poolId);
        if (phases.length === 0) return null;
        return (
          <SelectGroup key={breakdown.poolId}>
            <SelectLabel className="uppercase">{breakdown.name}</SelectLabel>
            {phases.map((phase) => (
              <SelectItem key={phase.poolId} value={String(phase.poolId)} className="uppercase">
                {phase.name}
                {!phase.isActive && " · retired"}
              </SelectItem>
            ))}
          </SelectGroup>
        );
      })}
    </>
  );
}

export function ScopePicker({
  pool,
  scopes,
  parentPoolId,
  onChange,
}: {
  pool: PoolKind;
  scopes: ScopeIndex;
  /** The scope sent to the server; `null` lists the whole pool. */
  parentPoolId: number | null;
  onChange: (next: number | null) => void;
}) {
  // Equipment and work breakdowns sit at the top of the tree; there is
  // nothing above them to narrow by.
  if (pool === "wbs" || pool === "equipment") return null;

  const value = parentPoolId === null ? WHOLE_POOL : String(parentPoolId);
  const change = (next: string) => onChange(next === WHOLE_POOL ? null : Number(next));

  if (pool === "phases") {
    return (
      <Select value={value} onValueChange={change}>
        <SelectTrigger size="lg" className="w-[240px]">
          <SelectValue placeholder="Work breakdown" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WHOLE_POOL}>All work breakdowns</SelectItem>
          {scopes.wbs.map((row) => (
            <SelectItem key={row.poolId} value={String(row.poolId)} className="uppercase">
              {row.name}
              {!row.isActive && " · retired"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Select value={value} onValueChange={change}>
      <SelectTrigger size="lg" className="w-[280px]">
        <SelectValue placeholder="Phase" />
      </SelectTrigger>
      <SelectContent className="max-h-[420px]">
        <SelectItem value={WHOLE_POOL}>All phases</SelectItem>
        <PhaseOptions scopes={scopes} />
      </SelectContent>
    </Select>
  );
}
