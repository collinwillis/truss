import { CatchBoundary } from "@tanstack/react-router";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import {
  computePhaseTakeoff,
  type TakeoffActivity,
  type TakeoffCatalog,
  type TakeoffPhase,
} from "@truss/backend/convex/model/takeoff";
import { useEffect } from "react";
import { useStableQueryWithStatus } from "../../lib/use-stable-query";
import type { TakeoffState } from "./derive";

/**
 * A phase's takeoff, computed on the phase screen from rows it already holds.
 *
 * WHY THE CLIENT COMPUTES IT. The phase screen has every activity of its phase;
 * the only thing it lacks is what the rate book says about the phase TYPE. A
 * server query returning the finished takeoff would read those same activities,
 * so it would re-run on every committed cell edit as a second subscription on
 * the hottest screen in the app. `getPhaseTakeoffCatalog` reads catalog rows
 * only, an estimator's edits never touch them, and the arithmetic is the SAME
 * exported pure function the server uses for the phase list. One rule, run in
 * two places, which is not the same thing as a rule written twice.
 *
 * @module
 */

/** What the rate book says about one phase type's takeoff. */
export interface PhaseTakeoffCatalog {
  /** Which book and phase type this belongs to. Never trust it for another. */
  key: string;
  takeoffUnit: string | null;
  flaggedLaborPoolIds: readonly number[];
}

/** The cache identity of one phase type in one book. */
export function takeoffCatalogKey(bookId: string, phasePoolId: number): string {
  return `${bookId}:${phasePoolId}`;
}

/**
 * Fetch one phase type's takeoff catalog, and hand it up.
 *
 * ⚠️ INSIDE ITS OWN ERROR BOUNDARY, AND THAT IS THE POINT OF THE COMPONENT. A
 * Convex query that throws surfaces through `useQuery` during render, which
 * takes down everything up to the nearest boundary, and there was none below
 * the route. A takeoff is a nicety on a panel; it must never be able to blank
 * the grid an estimator is pricing a bid in. If this fails (a backend that
 * predates the query, a book that has been deleted), the panel prints its
 * per-unit lines as dashes and nothing else changes.
 *
 * Renders nothing. It exists to hold a hook where a failure is survivable.
 */
export function PhaseTakeoffCatalogSource({
  bookId,
  phasePoolId,
  onCatalog,
}: {
  bookId: Id<"rateBooks">;
  phasePoolId: number;
  onCatalog: (catalog: PhaseTakeoffCatalog) => void;
}) {
  const key = takeoffCatalogKey(bookId, phasePoolId);
  return (
    <CatchBoundary getResetKey={() => key} errorComponent={Nothing}>
      <CatalogQuery bookId={bookId} phasePoolId={phasePoolId} onCatalog={onCatalog} />
    </CatchBoundary>
  );
}

function Nothing() {
  return null;
}

function CatalogQuery({
  bookId,
  phasePoolId,
  onCatalog,
}: {
  bookId: Id<"rateBooks">;
  phasePoolId: number;
  onCatalog: (catalog: PhaseTakeoffCatalog) => void;
}) {
  const { data, isExact } = useStableQueryWithStatus(api.precision.getPhaseTakeoffCatalog, {
    bookId,
    phasePoolId,
  });

  useEffect(() => {
    // `isExact` refuses the previous phase type's catalog, which the stable
    // query keeps on screen for the round trip after a navigation. A unit from
    // one phase type under another's quantity is a wrong number, not a late one.
    if (!data || !isExact) return;
    onCatalog({
      key: takeoffCatalogKey(bookId, phasePoolId),
      takeoffUnit: data.takeoffUnit,
      flaggedLaborPoolIds: data.flaggedLaborPoolIds,
    });
  }, [data, isExact, bookId, phasePoolId, onCatalog]);

  return null;
}

/**
 * The panel's takeoff for one phase.
 *
 * `pending` until the catalog for THIS phase type has arrived, and whenever the
 * rows are not this phase's own, so a unit rate is never computed across two
 * phases' data.
 */
export function phaseTakeoffState(
  phase: TakeoffPhase,
  activities: readonly TakeoffActivity[],
  catalog: PhaseTakeoffCatalog | null,
  expectedKey: string,
  rowsAreThisPhase: boolean
): TakeoffState {
  if (!rowsAreThisPhase || catalog === null || catalog.key !== expectedKey) {
    return { kind: "pending" };
  }
  const model: TakeoffCatalog = {
    unitByPhasePool:
      catalog.takeoffUnit === null
        ? new Map()
        : new Map([[phase.phasePoolId, catalog.takeoffUnit]]),
    flaggedLaborPoolIds: new Set(catalog.flaggedLaborPoolIds),
  };
  const takeoff = computePhaseTakeoff(phase, activities, model);
  if (takeoff === null) return { kind: "none" };
  return {
    kind: "measured",
    quantity: takeoff.quantity,
    unit: takeoff.unit,
    isOverridden: takeoff.isOverridden,
  };
}
