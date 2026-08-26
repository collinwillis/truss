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
  equipment: new Set<ActivityColumnId>([
    "description",
    "quantity",
    "unit",
    "price",
    "time",
    "ownership",
  ]),
  material: new Set<ActivityColumnId>(["description", "quantity", "unit", "price"]),
  cost_only: new Set<ActivityColumnId>(["description", "quantity", "price"]),
  // A sub's bid is quoted as three buckets, so those three cost cells are
  // inputs here and nowhere else.
  subcontractor: new Set<ActivityColumnId>([
    "description",
    "quantity",
    "unit",
    "time",
    "craftCost",
    "materialCost",
    "equipmentCost",
  ]),
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
