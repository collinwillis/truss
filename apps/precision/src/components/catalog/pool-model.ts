import { ConvexError } from "convex/values";
import { api } from "@truss/backend/convex/_generated/api";

/**
 * What the catalog screen knows about the four pools.
 *
 * ⚠️ A MIRROR OF `convex/model/catalogEdit.ts`, NOT A SECOND AUTHORITY. The
 * server decides what may be edited, what may be negative and what a
 * percentage may move; it refuses anything else by name. This table exists so
 * the screen can lay out columns and label them in the client's words before
 * a round trip — a field listed here that the server does not accept produces
 * a refusal naming the columns it does, rather than a silent no-op.
 *
 * @module
 */

/** The four pools a rate book is made of. */
export type PoolKind = "wbs" | "phases" | "labor" | "equipment";

/** One row of a pool, exactly as `listCatalogRows` hands it over. */
export type CatalogRow = (typeof api.catalog.listCatalogRows._returnType)["page"][number];

/** A catalog row's document id, whichever of the four tables it came from. */
export type CatalogRowId = CatalogRow["_id"];

/** The pools a percentage adjustment means anything to. */
export type AdjustablePool = "labor" | "equipment";

/** Coarse to fine — the order an estimator would walk the catalog in. */
export const POOL_ORDER: readonly PoolKind[] = ["wbs", "phases", "labor", "equipment"];

/** Their words for each pool, not the table names. */
export const POOL_LABEL: Record<PoolKind, string> = {
  wbs: "Work breakdown",
  phases: "Phases",
  labor: "Labor constants",
  equipment: "Equipment rates",
};

/** What one row of each pool is called, for counts and confirmations. */
export const POOL_ROW_NOUN: Record<PoolKind, { one: string; many: string }> = {
  wbs: { one: "work breakdown", many: "work breakdowns" },
  phases: { one: "phase", many: "phases" },
  labor: { one: "labor row", many: "labor rows" },
  equipment: { one: "equipment item", many: "equipment items" },
};

/** The pool a row is filed under, where it has one. */
export const PARENT_POOL: Record<PoolKind, PoolKind | null> = {
  wbs: null,
  phases: "wbs",
  labor: "phases",
  equipment: null,
};

/** The column holding a row's own name — `name` in two pools, `description` in two. */
export const NAME_FIELD: Record<PoolKind, string> = {
  wbs: "name",
  phases: "name",
  labor: "description",
  equipment: "description",
};

/** How a value is carried, which decides the control that edits it. */
export type CatalogFieldKind = "text" | "number" | "flag";

/** One editable column, as this screen renders it. */
export interface CatalogFieldUi {
  readonly field: string;
  /** The header, in the client's words rather than the schema's. */
  readonly label: string;
  /**
   * The column's name in a SENTENCE, where the header is too terse to stand
   * alone. A column head reading "Craft" is unambiguous with "Weld" beside it
   * and the grid around it; "+3% to the craft of 412 rows" is not a sentence
   * anybody would say, and this is the screen where that sentence is the last
   * thing between an admin and 412 changed constants.
   */
  readonly spoken?: string;
  readonly kind: CatalogFieldKind;
  /** Dollars, so the cell formats as currency. */
  readonly currency?: boolean;
  /** Whether a percentage adjustment may move this column. */
  readonly adjustable?: boolean;
  /** Starting width in pixels, measured against the real strings. */
  readonly size: number;
}

/**
 * The editable columns of each pool, in the order they are read.
 *
 * `sortOrder` sits last everywhere: it is the one column that says nothing
 * about the work, and putting it beside the description would push the
 * constants off a narrow window.
 */
export const CATALOG_UI_FIELDS: Record<PoolKind, readonly CatalogFieldUi[]> = {
  wbs: [
    { field: "name", label: "Name", kind: "text", size: 320 },
    { field: "sortOrder", label: "Sort", spoken: "sort order", kind: "number", size: 70 },
  ],
  phases: [
    { field: "name", label: "Name", kind: "text", size: 320 },
    { field: "takeoffUnit", label: "Takeoff unit", kind: "text", size: 96 },
    {
      field: "reservedPhaseNumber",
      label: "Fixed no.",
      spoken: "fixed phase number",
      kind: "flag",
      size: 84,
    },
    { field: "sortOrder", label: "Sort", spoken: "sort order", kind: "number", size: 70 },
  ],
  labor: [
    { field: "description", label: "Description", kind: "text", size: 300 },
    {
      field: "craftConstant",
      label: "Craft",
      spoken: "craft constant",
      kind: "number",
      adjustable: true,
      size: 84,
    },
    { field: "craftUnits", label: "Units", spoken: "craft units", kind: "text", size: 68 },
    {
      field: "weldConstant",
      label: "Weld",
      spoken: "weld constant",
      kind: "number",
      adjustable: true,
      size: 84,
    },
    { field: "weldUnits", label: "Units", spoken: "weld units", kind: "text", size: 68 },
    {
      field: "countsTowardTakeoff",
      label: "Takeoff",
      spoken: "counts toward takeoff",
      kind: "flag",
      size: 76,
    },
    { field: "sortOrder", label: "Sort", spoken: "sort order", kind: "number", size: 70 },
  ],
  equipment: [
    { field: "description", label: "Description", kind: "text", size: 300 },
    {
      field: "hourRate",
      label: "Hour",
      spoken: "hourly rate",
      kind: "number",
      currency: true,
      adjustable: true,
      size: 88,
    },
    {
      field: "dayRate",
      label: "Day",
      spoken: "daily rate",
      kind: "number",
      currency: true,
      adjustable: true,
      size: 88,
    },
    {
      field: "weekRate",
      label: "Week",
      spoken: "weekly rate",
      kind: "number",
      currency: true,
      adjustable: true,
      size: 92,
    },
    {
      field: "monthRate",
      label: "Month",
      spoken: "monthly rate",
      kind: "number",
      currency: true,
      adjustable: true,
      size: 92,
    },
    { field: "sortOrder", label: "Sort", spoken: "sort order", kind: "number", size: 70 },
  ],
};

/** The columns of a pool a percentage may move, in header order. */
export function adjustableFields(pool: AdjustablePool): readonly CatalogFieldUi[] {
  return CATALOG_UI_FIELDS[pool].filter((spec) => spec.adjustable === true);
}

/**
 * One field's name as it appears in a SENTENCE.
 *
 * Every message that names a column out loud goes through here: the
 * confirmation before a bulk adjustment, the title of a run in flight, and the
 * banner that explains a refused edit. The grid renders `label` — written to
 * fit an 84px column head with its neighbours for context — and this renders
 * the same column to somebody reading a sentence, where "+3% to the craft of
 * 412 rows" is not English.
 */
export function spokenFieldLabel(pool: PoolKind, field: string): string {
  const spec = CATALOG_UI_FIELDS[pool].find((candidate) => candidate.field === field);
  if (!spec) return field;
  return spec.spoken ?? spec.label.toLowerCase();
}

/**
 * A stored number, or `null` where the row carries something else.
 *
 * `null` renders as an EMPTY cell rather than a zero, which is the honest
 * answer: a rate that is missing and a rate that is zero price work
 * differently, and only one of them is a value somebody typed.
 */
export function numberAt(row: CatalogRow, field: string): number | null {
  const value = row.values[field];
  return typeof value === "number" ? value : null;
}

/** A stored string, or empty where the row carries something else. */
export function textAt(row: CatalogRow, field: string): string {
  const value = row.values[field];
  return typeof value === "string" ? value : "";
}

/** A stored flag; anything that is not a boolean reads as false. */
export function flagAt(row: CatalogRow, field: string): boolean {
  return row.values[field] === true;
}

/**
 * A server refusal as a person should read it.
 *
 * Convex wraps a thrown `Error` with its own request framing — the request
 * id, "Server Error", "Uncaught Error", and in development a stack trace —
 * and every message in `catalog.ts` is a whole sentence written for the
 * admin. Handing that framing to a toast buries the sentence in the middle of
 * a paragraph nobody reads.
 */
export function refusalText(error: unknown): string {
  // A ConvexError carries its sentence in `data`, and its `.message` is the
  // serialised payload — reading that would put JSON in front of the admin.
  const data: unknown = error instanceof ConvexError ? error.data : undefined;
  if (typeof data === "object" && data !== null) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  if (!(error instanceof Error)) return "The change was not applied.";
  const withoutFrame = error.message.replace(/^.*?Uncaught Error:\s*/s, "");
  const firstLine = withoutFrame.split("\n")[0] ?? withoutFrame;
  const trimmed = firstLine.replace(/\s+at\s+handler\b.*$/, "").trim();
  return trimmed === "" ? "The change was not applied." : trimmed;
}

/**
 * Whether a refusal is the optimistic-concurrency one.
 *
 * A stale edit is not an error in the sense the other refusals are — nothing is
 * wrong with the value, somebody else simply changed the row first — so the
 * screen says so in its own words rather than relaying a sentence about
 * revisions.
 *
 * Recognised by a `kind` on the error's data, never by its wording: Convex
 * redacts a plain Error's message on production deployments, so a prose match
 * works in development and fails in front of a customer.
 */
export function isStaleRowRefusal(error: unknown): boolean {
  // Structured, not prose. Convex redacts a plain Error's message on production
  // deployments, so matching on wording works in development and fails in front
  // of a customer — and it breaks whenever somebody edits the sentence.
  const data: unknown = error instanceof ConvexError ? error.data : undefined;
  return (
    typeof data === "object" && data !== null && (data as { kind?: unknown }).kind === "stale_row"
  );
}
