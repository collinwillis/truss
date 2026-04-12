/**
 * Firestore → Convex field mapping for all 4 collections.
 *
 * WHY: Firestore and Convex use different schemas. These pure functions
 * transform Firestore document shapes into Convex table shapes with the
 * corrected field mappings (fixing the gaps from the original migration).
 *
 * @module
 */

// ============================================================================
// Helpers
// ============================================================================

/** Safely convert any value to a number. Handles null, undefined, empty string. */
function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** Safely convert to string. */
function str(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

/** Parse a date field (could be ISO string, timestamp, or MM/DD/YYYY). */
function parseDate(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

// ============================================================================
// Proposal Mapping
// ============================================================================

const STATUS_MAP: Record<string, string> = {
  None: "bidding",
  Bidding: "bidding",
  Submitted: "submitted",
  Awarded: "awarded",
  Rejected: "rejected",
  Declined: "declined",
  Open: "open",
  Closed: "closed",
};

const BID_TYPE_MAP: Record<string, string> = {
  None: "lump_sum",
  "Lump Sum": "lump_sum",
  "Time and Materials": "time_and_materials",
  Budgetary: "budgetary",
  Rates: "rates",
  "Cost Plus": "cost_plus",
};

export function mapProposal(fs: Record<string, unknown>) {
  const estimators = str(fs.proposalEstimators);
  return {
    firestoreId: str(fs._fsId),
    proposalNumber: str(fs.proposalNumber),
    description: str(fs.proposalDescription ?? fs.description ?? ""),
    ownerName: str(fs.proposalOwner ?? ""),
    status: STATUS_MAP[str(fs.proposalStatus)] ?? "bidding",
    bidType: BID_TYPE_MAP[str(fs.bidType)] ?? undefined,
    projectAddress: {
      city: str(fs.projectCity),
      state: str(fs.projectState),
    },
    jobSiteAddress: str(fs.jobSiteAddress) || undefined,
    estimators: estimators
      ? estimators
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined,
    dateReceived: parseDate(fs.proposalDateReceived),
    dateDue: parseDate(fs.proposalDateDue),
    projectStartDate: parseDate(fs.projectStartDate),
    projectEndDate: parseDate(fs.projectEndDate),
    jobNumber: str(fs.job) || undefined,
    changeOrderNumber: str(fs.coNumber) || undefined,
    rates: {
      craftBaseRate: num(fs.craftBaseRate),
      weldBaseRate: num(fs.weldBaseRate),
      subsistenceRate: num(fs.subsistenceRate),
      burdenRate: num(fs.burdenRate),
      overheadRate: num(fs.overheadRate),
      consumablesRate: num(fs.consumablesRate),
      fuelRate: num(fs.fuelRate),
      rigRate: num(fs.rigRate),
      useTaxRate: num(fs.useTaxRate),
      salesTaxRate: num(fs.salesTaxRate),
      laborProfitRate: num(fs.laborProfitRate),
      materialProfitRate: num(fs.materialProfitRate),
      equipmentProfitRate: num(fs.equipmentProfitRate),
      subcontractorProfitRate: num(fs.subContractorProfitRate),
      rigProfitRate: num(fs.rigProfitRate),
    },
    datasetVersion: "v1" as const, // All existing data is v1
    customQuantity: fs.customQuantity != null ? num(fs.customQuantity) : undefined,
    customUnit: fs.customUnit != null ? str(fs.customUnit) : undefined,
  };
}

// ============================================================================
// WBS Mapping
// ============================================================================

export function mapWBS(fs: Record<string, unknown>) {
  return {
    firestoreId: str(fs._fsId),
    fsProposalId: str(fs.proposalId),
    wbsPoolId: num(fs.wbsDatabaseId),
    name: str(fs.name),
    sortOrder: num(fs.wbsDatabaseId),
    customQuantity: fs.customQuantity != null ? num(fs.customQuantity) : undefined,
    customUnit: fs.customUnit != null ? str(fs.customUnit) : undefined,
  };
}

// ============================================================================
// Phase Mapping
// ============================================================================

export function mapPhase(fs: Record<string, unknown>) {
  const pipingSpec =
    fs.size || fs.spec || fs.flc || fs.system || fs.insulation
      ? {
          size: fs.size != null ? str(fs.size) : undefined,
          spec: fs.spec != null ? str(fs.spec) : undefined,
          flc: fs.flc != null ? str(fs.flc) : undefined,
          system: (fs.system ?? fs.sys != null) ? str(fs.system ?? fs.sys) : undefined,
          insulation: fs.insulation != null ? str(fs.insulation) : undefined,
          insulationSize: fs.insulationSize != null ? num(fs.insulationSize) : undefined,
        }
      : undefined;

  return {
    firestoreId: str(fs._fsId),
    fsProposalId: str(fs.proposalId),
    fsWbsId: str(fs.wbsId),
    phasePoolId: num(fs.phaseDatabaseId),
    poolName: str(fs.phaseDatabaseName ?? ""),
    phaseNumber: num(fs.phaseNumber),
    description: str(fs.description ?? ""),
    area: fs.area != null ? str(fs.area) : undefined,
    sheet: fs.sheet != null ? num(fs.sheet) : undefined,
    pipingSpec,
    status: fs.status != null ? str(fs.status) : undefined,
    isCompleted: fs.completed === true,
    sortOrder: num(fs.phaseNumber ?? 0),
    customQuantity: fs.customQuantity != null ? num(fs.customQuantity) : undefined,
    customUnit: fs.customUnit != null ? str(fs.customUnit) : undefined,
  };
}

// ============================================================================
// Activity Mapping
// ============================================================================

const ACTIVITY_TYPE_MAP: Record<
  string,
  "labor" | "material" | "equipment" | "subcontractor" | "cost_only" | "custom_labor"
> = {
  laborItem: "labor",
  materialItem: "material",
  equipmentItem: "equipment",
  subContractorItem: "subcontractor",
  costOnlyItem: "cost_only",
  customLaborItem: "custom_labor",
};

const OWNERSHIP_MAP: Record<string, "rental" | "owned" | "purchase"> = {
  Rental: "rental",
  rental: "rental",
  Owned: "owned",
  owned: "owned",
  Purchase: "purchase",
  purchase: "purchase",
};

export function mapActivity(
  fs: Record<string, unknown>,
  proposalRates?: { craftBaseRate: number; subsistenceRate: number }
) {
  const type = ACTIVITY_TYPE_MAP[str(fs.activityType)] ?? "labor";
  const constant = fs.constant as Record<string, unknown> | null | undefined;
  const equipment = fs.equipment as Record<string, unknown> | null | undefined;

  // Labor fields — all types except subcontractor
  let labor:
    | {
        craftConstant: number;
        welderConstant: number;
        customCraftRate?: number;
        customSubsistenceRate?: number;
      }
    | undefined;
  if (type !== "subcontractor") {
    labor = {
      craftConstant: num(fs.craftConstant ?? constant?.craftConstant ?? 0),
      welderConstant: num(fs.welderConstant ?? constant?.weldConstant ?? 0),
    };
    // Custom rate overrides — store if non-null (even if matching proposal, for safety)
    if (fs.craftBaseRate != null && num(fs.craftBaseRate) !== 0) {
      labor.customCraftRate = num(fs.craftBaseRate);
    }
    if (fs.subsistenceRate != null && num(fs.subsistenceRate) !== 0) {
      labor.customSubsistenceRate = num(fs.subsistenceRate);
    }
  }

  // Equipment fields
  let equipmentData: { ownership: "rental" | "owned" | "purchase"; time: number } | undefined;
  if (type === "equipment") {
    equipmentData = {
      ownership: OWNERSHIP_MAP[str(fs.equipmentOwnership)] ?? "rental",
      time: num(fs.time),
    };
  }

  // Subcontractor fields — uses stored cost inputs from Firestore
  let subcontractor: { laborCost: number; materialCost: number; equipmentCost: number } | undefined;
  if (type === "subcontractor") {
    subcontractor = {
      laborCost: num(fs.craftCost),
      materialCost: num(fs.materialCost),
      equipmentCost: num(fs.equipmentCost),
    };
  }

  // Unit price — material, equipment, cost_only
  let unitPrice: number | undefined;
  if (type === "material" || type === "equipment" || type === "cost_only") {
    unitPrice = num(fs.price);
  }

  return {
    firestoreId: str(fs._fsId),
    fsProposalId: str(fs.proposalId),
    fsWbsId: str(fs.wbsId),
    fsPhaseId: str(fs.phaseId),
    type,
    description: str(fs.description ?? ""),
    quantity: num(fs.quantity),
    unit: str(fs.unit ?? constant?.craftUnits ?? "EA"),
    sortOrder: num(fs.sortOrder ?? constant?.sortOrder ?? fs.dateAdded ?? 0),
    laborPoolId: constant?.id != null ? num(constant.id) : undefined,
    equipmentPoolId: equipment?.id != null ? num(equipment.id) : undefined,
    labor,
    equipment: equipmentData,
    subcontractor,
    unitPrice,
  };
}
