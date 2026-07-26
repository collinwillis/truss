/**
 * Activity kinds a phase can hold. Mirrors the `activityType` validator that
 * `momentum.addActivity` and `precision.addActivity` share.
 */
export type ActivityType =
  | "labor"
  | "custom_labor"
  | "material"
  | "equipment"
  | "subcontractor"
  | "cost_only";

/** How an equipment line is paid for. */
export type EquipmentOwnership = "rental" | "owned" | "purchase";

/** A labor catalog row offered in the Labor tab's picker. */
export interface LaborPoolItem {
  poolId: number;
  description: string;
  craftConstant: number;
  weldConstant: number;
  craftUnits: string;
}

/** An equipment catalog row offered in the Equipment tab's picker. */
export interface EquipmentPoolItem {
  poolId: number;
  description: string;
  dayRate: number;
}

/**
 * Everything the dialog collects, ready to hand to the host app's mutation.
 *
 * WHY there is no `phaseId`: Momentum and Precision store phases in different
 * tables, so the phase id is the one argument their otherwise identical
 * `addActivity` mutations do not agree on. The host closes over its own phase
 * id and merges it in, which keeps Convex `Id` types out of shared code.
 */
export interface ActivityPayload {
  type: ActivityType;
  description: string;
  quantity: number;
  unit: string;
  laborPoolId?: number;
  equipmentPoolId?: number;
  labor?: { craftConstant: number; welderConstant: number };
  equipment?: { ownership: EquipmentOwnership; time: number };
  subcontractor?: { laborCost: number; materialCost: number; equipmentCost: number };
  unitPrice?: number;
}
