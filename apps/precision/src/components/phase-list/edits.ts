import { ConvexError } from "convex/values";
import type { PhaseColumnId } from "./visibility";

/**
 * What an estimator may type into the WBS HOME sheet, and what one cell means.
 *
 * ⚠️ HOURS AND MONEY ARE NOT HERE, AND THAT IS THE POINT. Legacy let an
 * estimator type craftCost, welderCost, materialCost and totalCost straight
 * onto a PHASE; Precision rolls those up from the activities beneath it, so a
 * typed phase total would be a second source of truth for a number the engine
 * already owns — the failure `convex/model/costEngine.ts` documents, where
 * three copies of the math drifted until the bid sheet stopped tying to the
 * screen. Everything an estimator can state about a phase is editable; nothing
 * that is COMPUTED from it is.
 *
 * ⚠️ AN EMPTIED CELL CLEARS THE FIELD, IT DOES NOT STORE `""`. The mutation
 * takes `null` to remove an attribute and a value to set it, and the difference
 * is not cosmetic: a stored blank unit made `computePhaseTakeoff` report a
 * quantity of 0 on a phase that has no takeoff at all (fix 4749a03). The two
 * fields that cannot be cleared — the phase number and the description, which
 * are how the row is named on the bid sheet — refuse an empty cell instead of
 * storing a blank one, because there is no absent state for them to fall back
 * to.
 *
 * Pure by design: the whole raw-text-to-payload decision is testable without a
 * grid, a server or a browser.
 *
 * @module
 */

/** The columns that accept typing, in the order the report draws them. */
export const EDITABLE_PHASE_COLUMNS = [
  "phase",
  "size",
  "flc",
  "description",
  "spec",
  "insulation",
  "insulationSize",
  "sheet",
  "area",
  "status",
  "sys",
  "quantity",
  "unit",
] as const satisfies readonly PhaseColumnId[];

export type EditablePhaseColumnId = (typeof EDITABLE_PHASE_COLUMNS)[number];

const EDITABLE: ReadonlySet<string> = new Set(EDITABLE_PHASE_COLUMNS);

/**
 * Whether this cell accepts typing.
 *
 * QTY and UNIT need a takeoff to edit. A phase type with no takeoff unit in the
 * catalog reports `null` rather than zero (see `model/takeoff.ts`), and writing
 * a unit onto one would MANUFACTURE a takeoff the phase does not have — a
 * quantity of 0 where the report currently, correctly, prints a dash.
 */
export function isPhaseCellEditable(
  columnId: string,
  options: { canEdit: boolean; hasTakeoff: boolean }
): boolean {
  if (!options.canEdit) return false;
  if (columnId === "quantity" || columnId === "unit") return options.hasTakeoff;
  return EDITABLE.has(columnId);
}

/** One piping-spec member, merged over what is stored — never the whole object. */
interface PipingSpecPatch {
  size?: string | null;
  spec?: string | null;
  flc?: string | null;
  system?: string | null;
  insulation?: string | null;
  insulationSize?: number | null;
}

/**
 * The `precision.updatePhase` payload minus the phase id.
 *
 * A field that is ABSENT is left alone, a value SETS, and `null` CLEARS. Only
 * the edited key travels: the server merges a spec patch over what is stored,
 * so sending a reconstructed object would let one cell's edit overwrite the
 * five members beside it.
 */
export interface PhasePatch {
  description?: string;
  phaseNumber?: number;
  area?: string | null;
  sheet?: number | null;
  status?: string | null;
  pipingSpec?: PipingSpecPatch;
  takeoffQuantity?: number | null;
  takeoffUnit?: string | null;
}

/** What to do with what the estimator typed. */
export type PhaseEdit =
  | { outcome: "patch"; patch: PhasePatch }
  | { outcome: "refused"; message: string };

/**
 * A number input hands back `""` for keystrokes it refused ("5e").
 *
 * Empty means CLEARED and empty means UNPARSEABLE, and only the flag tells them
 * apart — without it a typo would silently clear the field the estimator was
 * trying to correct.
 */
const REJECTED_MESSAGE = "That entry could not be read as a number.";

function unparseable(raw: string): PhaseEdit {
  return { outcome: "refused", message: `"${raw}" could not be read as a number.` };
}

/** A number that may be cleared: `null` for an empty cell, `0` for a real zero. */
function clearableNumber(raw: string): { value: number | null } | PhaseEdit {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  const value = parseFloat(trimmed);
  if (isNaN(value)) return unparseable(raw);
  return { value };
}

function isRefusal(result: { value: number | null } | PhaseEdit): result is PhaseEdit {
  return "outcome" in result;
}

/**
 * Turn one committed cell into the payload it means.
 *
 * @param columnId the column the estimator typed in.
 * @param raw exactly what the cell held when it committed.
 * @param rejected the number input refused the keystrokes — see
 *   {@link REJECTED_MESSAGE}.
 */
export function buildPhaseEdit(
  columnId: EditablePhaseColumnId,
  raw: string,
  rejected?: boolean
): PhaseEdit {
  if (rejected) return { outcome: "refused", message: REJECTED_MESSAGE };

  // Stored trimmed, so a cell holding only spaces reads as empty rather than
  // becoming an area named " " that no filter will ever match.
  const trimmed = raw.trim();
  const cleared = trimmed === "" ? null : trimmed;

  switch (columnId) {
    case "phase": {
      if (trimmed === "") {
        return {
          outcome: "refused",
          message:
            "A phase is named by its number on the bid sheet and in every conversation about it, so the cell cannot be left empty.",
        };
      }
      const value = parseFloat(trimmed);
      if (isNaN(value)) return unparseable(raw);
      return { outcome: "patch", patch: { phaseNumber: value } };
    }

    case "description": {
      if (trimmed === "") {
        return {
          outcome: "refused",
          message: "Every phase carries a description, so the cell cannot be left empty.",
        };
      }
      return { outcome: "patch", patch: { description: trimmed } };
    }

    case "area":
      return { outcome: "patch", patch: { area: cleared } };

    case "status":
      return { outcome: "patch", patch: { status: cleared } };

    case "unit":
      return { outcome: "patch", patch: { takeoffUnit: cleared } };

    case "sheet": {
      const result = clearableNumber(raw);
      if (isRefusal(result)) return result;
      // Sheet 0 is a real sheet on a print; only an empty cell clears.
      return { outcome: "patch", patch: { sheet: result.value } };
    }

    case "quantity": {
      const result = clearableNumber(raw);
      if (isRefusal(result)) return result;
      // A takeoff of 0 is a measurement; clearing returns to the derived sum.
      return { outcome: "patch", patch: { takeoffQuantity: result.value } };
    }

    case "insulationSize": {
      const result = clearableNumber(raw);
      if (isRefusal(result)) return result;
      return { outcome: "patch", patch: { pipingSpec: { insulationSize: result.value } } };
    }

    // The five piping-spec members, each sent ALONE: the server merges a patch
    // over what is stored, and a reconstructed object would let one cell's edit
    // overwrite the members beside it.
    case "size":
      return { outcome: "patch", patch: { pipingSpec: { size: cleared } } };
    case "flc":
      return { outcome: "patch", patch: { pipingSpec: { flc: cleared } } };
    case "spec":
      return { outcome: "patch", patch: { pipingSpec: { spec: cleared } } };
    case "insulation":
      return { outcome: "patch", patch: { pipingSpec: { insulation: cleared } } };
    // The report's SYS column is the spec's `system` member — the one place the
    // client's column name and the stored name differ.
    case "sys":
      return { outcome: "patch", patch: { pipingSpec: { system: cleared } } };
  }
}

/**
 * The refusal kinds `precision.updatePhase` throws.
 *
 * ⚠️ MIRRORED, NOT IMPORTED. `@truss/backend` exports its generated api and
 * nothing else, so the constants cannot travel; they are recognised by their
 * `kind` rather than by their wording for the reason the server throws a
 * `ConvexError` in the first place — Convex redacts a plain error's message on
 * a production deployment, so a prose match works in development and fails in
 * front of an estimator.
 */
export const PHASE_NUMBER_TAKEN = "phase_number_taken";
export const PHASE_FIELD_INVALID = "phase_field_invalid";

/** A refused edit, as the screen should say it. */
export interface PhaseRefusal {
  /** Toast heading — what went wrong, in four words. */
  title: string;
  /** The server's own sentence where there is one; it is written for a person. */
  message: string;
  /** The cell to put the caret back in, when the refusal names one. */
  column?: EditablePhaseColumnId;
}

/** The server names the FIELD; the grid needs the column that holds it. */
const COLUMN_BY_FIELD: Record<string, EditablePhaseColumnId> = {
  phaseNumber: "phase",
  sheet: "sheet",
  insulationSize: "insulationSize",
};

/**
 * Read a refused write.
 *
 * The two kinds the mutation throws have specific remedies — pick another
 * number, retype that cell — and the screen can only offer them if it can tell
 * them from a lost connection. Anything else is relayed as-is.
 */
export function readPhaseRefusal(error: unknown): PhaseRefusal {
  const data: unknown = error instanceof ConvexError ? error.data : undefined;
  if (typeof data === "object" && data !== null) {
    const { kind, field, message } = data as {
      kind?: unknown;
      field?: unknown;
      message?: unknown;
    };
    const sentence = typeof message === "string" && message.trim() !== "" ? message : undefined;

    if (kind === PHASE_NUMBER_TAKEN) {
      return {
        title: "That phase number is taken",
        message: sentence ?? "Another phase in this breakdown already carries that number.",
        column: "phase",
      };
    }
    if (kind === PHASE_FIELD_INVALID) {
      return {
        title: "That value cannot be saved",
        message: sentence ?? "The value is not one this field can hold, so nothing was saved.",
        column: typeof field === "string" ? COLUMN_BY_FIELD[field] : undefined,
      };
    }
  }

  return {
    title: "Failed to save the phase",
    message: error instanceof Error ? error.message : "An unexpected error occurred.",
  };
}
