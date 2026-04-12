/**
 * Type definitions for the Precision estimation feature module.
 *
 * Defines the shapes returned by Convex queries and used throughout
 * the estimation UI components.
 *
 * @module
 */

// ============================================================================
// Rate Types
// ============================================================================

/** All 15 rate fields that drive cost calculations. */
export interface ProposalRates {
  craftBaseRate: number;
  weldBaseRate: number;
  subsistenceRate: number;
  burdenRate: number;
  overheadRate: number;
  consumablesRate: number;
  fuelRate: number;
  rigRate: number;
  useTaxRate: number;
  salesTaxRate: number;
  laborProfitRate: number;
  materialProfitRate: number;
  equipmentProfitRate: number;
  subcontractorProfitRate: number;
  rigProfitRate: number;
}

/** Default rates for new proposals. */
export const DEFAULT_RATES: ProposalRates = {
  craftBaseRate: 0,
  weldBaseRate: 0,
  subsistenceRate: 0,
  burdenRate: 0,
  overheadRate: 0,
  consumablesRate: 0,
  fuelRate: 0,
  rigRate: 0,
  useTaxRate: 0,
  salesTaxRate: 0,
  laborProfitRate: 0,
  materialProfitRate: 0,
  equipmentProfitRate: 0,
  subcontractorProfitRate: 0,
  rigProfitRate: 0,
};

// ============================================================================
// Proposal Types
// ============================================================================

/** Bid type options. */
export type BidType = "lump_sum" | "time_and_materials" | "budgetary" | "rates" | "cost_plus";

/** Proposal status options. */
export type ProposalStatus =
  | "bidding"
  | "submitted"
  | "awarded"
  | "rejected"
  | "declined"
  | "open"
  | "closed";

/** Dataset version for pool data. */
export type DatasetVersion = "v1" | "v2";

/** Proposal as returned by the listProposals query. */
export interface ProposalListItem {
  _id: string;
  proposalNumber: string;
  description: string;
  ownerName: string;
  status: ProposalStatus | null;
  bidType: BidType | null;
  dateDue: number | null;
  dateReceived: number | null;
  jobNumber: string | null;
  estimators: string[];
  datasetVersion: DatasetVersion;
}

/** Address fields shared across proposal and contact. */
export interface Address {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

// ============================================================================
// Activity Types
// ============================================================================

/** Activity type discriminator. */
export type ActivityType =
  | "labor"
  | "material"
  | "equipment"
  | "subcontractor"
  | "cost_only"
  | "custom_labor";

/** Equipment ownership options. */
export type EquipmentOwnership = "rental" | "owned" | "purchase";

/** Computed costs for a single activity. */
export interface ActivityCosts {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

// ============================================================================
// Rollup Types
// ============================================================================

/** Aggregated costs at the phase level. */
export interface PhaseRollup {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
  activityCount: number;
}

/** Aggregated costs at the WBS level. */
export interface WBSRollup extends PhaseRollup {
  phaseCount: number;
}

/** Proposal-level summary with direct/indirect hour classification. */
export interface ProposalSummary extends WBSRollup {
  directCraftHours: number;
  directWelderHours: number;
  directHours: number;
  indirectHours: number;
  totalHours: number;
  wbsCount: number;
}

// ============================================================================
// Rate Editor Types
// ============================================================================

/** Rate field metadata for rendering the rate editor form. */
export interface RateFieldConfig {
  key: keyof ProposalRates;
  label: string;
  group: "labor" | "overhead" | "profit" | "tax";
  unit: "$/hr" | "%" | "$/hr";
  placeholder?: string;
}

/** Grouped rate field configuration for the rate editor UI. */
export const RATE_FIELD_CONFIG: RateFieldConfig[] = [
  // Labor rates ($/hr)
  { key: "craftBaseRate", label: "Craft Base Rate", group: "labor", unit: "$/hr" },
  { key: "weldBaseRate", label: "Weld Base Rate", group: "labor", unit: "$/hr" },
  { key: "subsistenceRate", label: "Subsistence", group: "labor", unit: "$/hr" },
  { key: "rigRate", label: "Rig Rate", group: "labor", unit: "$/hr" },

  // Overhead rates (%)
  { key: "burdenRate", label: "Burden", group: "overhead", unit: "%" },
  { key: "overheadRate", label: "Overhead", group: "overhead", unit: "%" },
  { key: "consumablesRate", label: "Consumables", group: "overhead", unit: "%" },
  { key: "fuelRate", label: "Fuel", group: "overhead", unit: "%" },

  // Profit rates (%)
  { key: "laborProfitRate", label: "Labor Profit", group: "profit", unit: "%" },
  { key: "materialProfitRate", label: "Material Profit", group: "profit", unit: "%" },
  { key: "equipmentProfitRate", label: "Equipment Profit", group: "profit", unit: "%" },
  { key: "subcontractorProfitRate", label: "Subcontractor Profit", group: "profit", unit: "%" },
  { key: "rigProfitRate", label: "Rig Profit", group: "profit", unit: "%" },

  // Tax rates (%)
  { key: "salesTaxRate", label: "Sales Tax", group: "tax", unit: "%" },
  { key: "useTaxRate", label: "Use Tax", group: "tax", unit: "%" },
];
