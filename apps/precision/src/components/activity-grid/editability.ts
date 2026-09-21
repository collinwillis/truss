import type { ActivityType } from "@truss/features/activities";
import type { ActivityColumnId } from "./visibility";

/**
 * Which cells an estimator may type into, BY ACTIVITY TYPE.
 *
 * The rule that makes a mixed grid work: a column is not editable or not —
 * the same column is editable on some rows and read-only on others. "Craft
 * Total" is computed on a labor line (typing there would be meaningless) but
 * is the estimator's own input on a subcontractor line, where it is one bucket
 * of the sub's quoted breakdown. Legacy expressed this as per-type allowlists
 * (`columns.tsx::editableLaborItemCells` and friends); those lists are
 * transcribed here, with the column ids this grid uses.
 *
 * DELIBERATE DIFFERENCES FROM LEGACY, both corrections rather than ports:
 *  - `costOnlyCost` carried `editable: true` in legacy but appeared in NO
 *    allowlist, and the read path hardcoded 0 — it was dead. A cost-only line
 *    is priced through `price`, which IS in its list, so the column stays
 *    read-only here rather than pretending.
 *  - `custom_labor` had no list of its own; it is labor for this purpose, and
 *    is the one type always allowed a rate override (D6).
 */
const EDITABLE_BY_TYPE: Record<ActivityType, ReadonlySet<ActivityColumnId>> = {
  labor: new Set<ActivityColumnId>([
    "description",
    "quantity",
    "unit",
    "craftConstant",
    "welderConstant",
  ]),
  custom_labor: new Set<ActivityColumnId>([
    "description",
    "quantity",
    "unit",
    "craftConstant",
    "welderConstant",
  ]),
  // `ownership` is NOT here, though legacy listed it: the grid renders that
  // column as a read-only span and nothing writes the field, so declaring it
  // editable only made Tab stop on a cell that could not take focus. A fourth
  // correction of the same kind as the three above.
  equipment: new Set<ActivityColumnId>(["description", "quantity", "unit", "price", "time"]),
  material: new Set<ActivityColumnId>(["description", "quantity", "unit", "price"]),
  cost_only: new Set<ActivityColumnId>(["description", "quantity", "price"]),
  // A sub quotes ONE number, so it is entered where every other non-labor line
  // enters one — the Unit Price cell — with `subTax` beside it for the quote
  // that arrives without tax in it. The three cost cells that used to be inputs
  // here are computed columns again, and `costEngine` zeroes them for a
  // subcontractor line, so they render as "not applicable" rather than $0.00.
  //
  // A THIRD CORRECTION TO LEGACY, same kind as the two above: `time` was in
  // this list, but `subcontractorFields` is {laborCost, materialCost,
  // equipmentCost} — there is nowhere on a sub line to keep a duration. The
  // grid's Duration cell writes `equipment.time`, and `updateActivity` refuses
  // any equipment patch without an ownership ("Equipment ownership and duration
  // are required"), which a sub line never has. So the cell could only ever
  // throw. Removed rather than ported.
  subcontractor: new Set<ActivityColumnId>(["description", "quantity", "unit", "price", "subTax"]),
};

/**
 * Whether this cell accepts typing.
 *
 * The rate columns are governed by D6 rather than by type, and the server
 * resolves that per row — so it is passed in rather than re-derived here,
 * exactly so the grid cannot disagree with the mutation.
 */
export function isCellEditable(
  column: ActivityColumnId,
  type: ActivityType,
  options: { canEdit: boolean; canOverrideRates: boolean }
): boolean {
  if (!options.canEdit) return false;
  if (column === "craftRate" || column === "subsistenceRate") return options.canOverrideRates;
  return EDITABLE_BY_TYPE[type]?.has(column) ?? false;
}
