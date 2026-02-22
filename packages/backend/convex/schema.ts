/**
 * Convex Schema for MCP Estimator
 *
 * This schema defines the complete database structure for the estimator application.
 * It includes:
 * - Pool Tables: Reference data catalogs (wbsPool, phasePool, laborPool, equipmentPool)
 * - Instance Tables: User-created data (proposals, wbs, phases, activities)
 * - User Tables: Authentication and preferences
 *
 * Key Concepts:
 * - Pool tables store the "catalogs" of available options users can pick from
 * - Instance tables store the actual data users create by selecting from pools
 * - Pool IDs are numeric (from JSON data), Instance IDs are Convex v.id() references
 *
 * @module
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ============================================================================
// ENUMS (Discriminated Unions)
// ============================================================================

/**
 * Dataset version for pool data
 * Supports multiple versions of reference data (v1, v2, etc.)
 */
const dataVersion = v.union(v.literal("v1"), v.literal("v2"));

/**
 * Proposal bid types
 */
const bidType = v.union(
  v.literal("lump_sum"),
  v.literal("time_and_materials"),
  v.literal("budgetary"),
  v.literal("rates"),
  v.literal("cost_plus")
);

/**
 * Proposal status values
 */
const proposalStatus = v.union(
  v.literal("bidding"),
  v.literal("submitted"),
  v.literal("awarded"),
  v.literal("rejected"),
  v.literal("declined"),
  v.literal("open"),
  v.literal("closed")
);

/**
 * Activity types - discriminates different kinds of line items
 * Maps from old: laborItem, materialItem, equipmentItem, subContractorItem, costOnlyItem, customLaborItem
 */
const activityType = v.union(
  v.literal("labor"),
  v.literal("material"),
  v.literal("equipment"),
  v.literal("subcontractor"),
  v.literal("cost_only"),
  v.literal("custom_labor")
);

/**
 * Equipment ownership types
 * Maps from old: 'Rental', 'Owned', 'Purchase'
 */
const equipmentOwnership = v.union(v.literal("rental"), v.literal("owned"), v.literal("purchase"));

/**
 * User roles
 */
const userRole = v.union(v.literal("admin"), v.literal("user"), v.literal("viewer"));

/**
 * User permissions
 */
const userPermission = v.union(v.literal("read"), v.literal("readWrite"));

// ============================================================================
// REUSABLE VALIDATORS
// ============================================================================

/**
 * Address fields - reused for project and contact addresses
 */
const addressFields = {
  street: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zipCode: v.optional(v.string()),
};

/**
 * Rate configuration - all rate fields grouped together
 * These are the base rates used for cost calculations
 */
const rateFields = {
  craftBaseRate: v.number(),
  weldBaseRate: v.number(),
  subsistenceRate: v.number(),
  burdenRate: v.number(),
  overheadRate: v.number(),
  consumablesRate: v.number(),
  fuelRate: v.number(),
  rigRate: v.number(),
  useTaxRate: v.number(),
  salesTaxRate: v.number(),
  laborProfitRate: v.number(),
  materialProfitRate: v.number(),
  equipmentProfitRate: v.number(),
  subcontractorProfitRate: v.number(),
  rigProfitRate: v.number(),
};

/**
 * Piping specification fields - optional nested object for phases
 * Only relevant for piping-related WBS types (AG PIPING, BG PIPING, etc.)
 */
const pipingSpecFields = {
  size: v.optional(v.string()),
  spec: v.optional(v.string()),
  flc: v.optional(v.string()),
  system: v.optional(v.string()),
  insulation: v.optional(v.string()),
  insulationSize: v.optional(v.number()),
};

/**
 * Labor-specific fields for activity line items
 */
const laborFields = {
  craftConstant: v.number(),
  welderConstant: v.number(),
  customCraftRate: v.optional(v.number()),
  customSubsistenceRate: v.optional(v.number()),
};

/**
 * Equipment-specific fields for activity line items
 */
const equipmentFields = {
  ownership: equipmentOwnership,
  time: v.number(),
};

/**
 * Subcontractor-specific fields for activity line items
 */
const subcontractorFields = {
  laborCost: v.number(),
  materialCost: v.number(),
  equipmentCost: v.number(),
};

// ============================================================================
// SCHEMA DEFINITION
// ============================================================================

export default defineSchema({
  // ==========================================================================
  // POOL TABLES - Reference Data Catalogs
  // ==========================================================================
  // These tables store the "pools" of options users can pick from when
  // creating proposals, WBS, phases, and activities.
  //
  // Data Source: Migrated from local JSON files (wbs_v1.json, phases_v1.json,
  // labor_v1.json, equipment_v1.json, etc.)
  //
  // Key Fields:
  // - poolId: The numeric ID from the original JSON (used for lookups)
  // - datasetVersion: Which version of the data (v1, v2)
  // - isCustom: Whether this is a user-added item
  // - isActive: Soft delete flag
  // ==========================================================================

  /**
   * WBS Pool - Available Work Breakdown Structure categories
   *
   * Source: wbs_v1.json, wbs_v2.json
   * Structure: { id: 70000, name: "AG PIPING" }
   *
   * These are the top-level categories like MOBILIZE, STRUCTURAL, AG PIPING, etc.
   */
  wbsPool: defineTable({
    datasetVersion: dataVersion,
    poolId: v.number(), // Original `id` from JSON (e.g., 10000, 70000)
    name: v.string(), // e.g., "MOBILIZE", "AG PIPING"
    sortOrder: v.number(), // Display order
    isCustom: v.boolean(), // true if user-created
    isActive: v.boolean(), // false for soft-deleted
  })
    .index("by_version", ["datasetVersion"])
    .index("by_version_pool_id", ["datasetVersion", "poolId"])
    .index("by_version_active", ["datasetVersion", "isActive"]),

  /**
   * Phase Pool - Available phase types for each WBS category
   *
   * Source: phases_v1.json, phases_v2.json
   * Structure: { wbsDatabaseId: 70000, phaseDatabaseId: 70001, description: "CARBON STEEL - A106/A53 (SCH 10/40)" }
   *
   * These are the sub-categories under each WBS.
   * Example: Under "AG PIPING" (70000), you have phases like "CARBON STEEL" (70001), "STAINLESS STEEL" (70007)
   */
  phasePool: defineTable({
    datasetVersion: dataVersion,
    poolId: v.number(), // Original `phaseDatabaseId` from JSON (e.g., 70001)
    wbsPoolId: v.number(), // Parent WBS reference (`wbsDatabaseId` from JSON)
    name: v.string(), // `description` from JSON (e.g., "CARBON STEEL - A106/A53 (SCH 10/40)")
    sortOrder: v.number(), // Display order within parent WBS
    isCustom: v.boolean(),
    isActive: v.boolean(),
  })
    .index("by_version", ["datasetVersion"])
    .index("by_version_wbs", ["datasetVersion", "wbsPoolId"])
    .index("by_version_pool_id", ["datasetVersion", "poolId"])
    .index("by_version_wbs_active", ["datasetVersion", "wbsPoolId", "isActive"]),

  /**
   * Labor Pool - Available labor line items for each phase type
   *
   * Source: labor_v1.json (was constants.json), labor_v2.json
   * Structure: {
   *   id: 2738,
   *   phaseDatabaseId: 70001,
   *   description: "FSW - ≤.75",
   *   sortOrder: 10,
   *   craftConstant: 0.6,
   *   craftUnits: "LF",
   *   weldConstant: 0.6,
   *   weldUnits: "LF"
   * }
   *
   * These are the specific labor tasks available for each phase type.
   * Contains the constants used for calculating man-hours.
   */
  laborPool: defineTable({
    datasetVersion: dataVersion,
    poolId: v.number(), // Original `id` from JSON (e.g., 2738)
    phasePoolId: v.number(), // Parent Phase reference (`phaseDatabaseId` from JSON)
    description: v.string(), // e.g., "FSW - ≤.75", "CUT - ≤2"
    sortOrder: v.number(), // Display order within parent phase
    craftConstant: v.number(), // Man-hours per unit for craft work
    craftUnits: v.string(), // Unit of measure for craft (e.g., "LF", "EA")
    weldConstant: v.number(), // Man-hours per unit for welding
    weldUnits: v.string(), // Unit of measure for welding
    isCustom: v.boolean(),
    isActive: v.boolean(),
  })
    .index("by_version", ["datasetVersion"])
    .index("by_version_phase", ["datasetVersion", "phasePoolId"])
    .index("by_version_pool_id", ["datasetVersion", "poolId"])
    .index("by_version_phase_active", ["datasetVersion", "phasePoolId", "isActive"]),

  /**
   * Equipment Pool - Available equipment for rental/use
   *
   * Source: equipment_v1.json, equipment_v2.json
   * Structure: {
   *   id: 1,
   *   description: "AIR TOOLS - AIR COMPRESSOR 0-185 CFM",
   *   hourRate: 8,
   *   dayRate: 64,
   *   weekRate: 256,
   *   monthRate: 768
   * }
   *
   * Equipment is not hierarchical - can be added to any phase.
   */
  equipmentPool: defineTable({
    datasetVersion: dataVersion,
    poolId: v.number(), // Original `id` from JSON
    description: v.string(), // Equipment name/description
    hourRate: v.number(), // Rental rate per hour
    dayRate: v.number(), // Rental rate per day
    weekRate: v.number(), // Rental rate per week
    monthRate: v.number(), // Rental rate per month
    sortOrder: v.number(), // Display order
    isCustom: v.boolean(),
    isActive: v.boolean(),
  })
    .index("by_version", ["datasetVersion"])
    .index("by_version_pool_id", ["datasetVersion", "poolId"])
    .index("by_version_active", ["datasetVersion", "isActive"]),

  // ==========================================================================
  // USER TABLES
  // ==========================================================================

  /**
   * Users - Application users
   *
   * Source: Firestore `users` collection
   */
  users: defineTable({
    firestoreId: v.optional(v.string()), // Original Firestore document ID
    externalId: v.string(), // Firebase/Clerk UID
    email: v.string(),
    name: v.string(),
    role: userRole,
    permission: userPermission,
    isDeleted: v.boolean(),
    isDisabled: v.boolean(),
  })
    .index("by_firestore_id", ["firestoreId"])
    .index("by_external_id", ["externalId"])
    .index("by_email", ["email"]),

  /**
   * Contacts - Normalized contact information
   *
   * Source: Extracted from Firestore `proposals.contact*` fields
   * Contacts can be reused across multiple proposals
   */
  contacts: defineTable({
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.object(addressFields)),
    organizationName: v.optional(v.string()),
  })
    .index("by_email", ["email"])
    .index("by_name", ["name"]),

  // ==========================================================================
  // INSTANCE TABLES - User-Created Data
  // ==========================================================================
  // These tables store the actual data users create by selecting from pools.
  //
  // Key Concepts:
  // - Foreign keys use v.id() for type safety
  // - *PoolId fields are numeric references to pool tables
  // - Computed fields (costs, man-hours) are NOT stored - calculated on read
  // ==========================================================================

  /**
   * Proposals - Main entity for estimation projects
   *
   * Source: Firestore `proposals` collection
   *
   * Key Changes from Firestore:
   * - proposalEstimators: string -> estimators: string[] (array)
   * - All contact fields -> contactId reference
   * - All rate fields -> rates object
   * - All computed cost/hours fields -> REMOVED (computed on read)
   * - datasetVersions object -> datasetVersion single value
   */
  proposals: defineTable({
    firestoreId: v.optional(v.string()), // Original Firestore document ID

    // Identification
    proposalNumber: v.string(), // String to support revisions like "1956.01"
    description: v.string(),

    // Ownership & Contact
    ownerName: v.string(), // Client/company name
    contactId: v.optional(v.id("contacts")), // Normalized contact reference

    // Status
    status: v.optional(proposalStatus),
    bidType: v.optional(bidType),

    // Location
    projectAddress: v.optional(v.object(addressFields)),
    jobSiteAddress: v.optional(v.string()),

    // Team - NOW AN ARRAY (was comma-separated string)
    estimators: v.optional(v.array(v.string())),

    // Dates (Unix timestamps in milliseconds)
    dateReceived: v.optional(v.number()),
    dateDue: v.optional(v.number()),
    projectStartDate: v.optional(v.number()),
    projectEndDate: v.optional(v.number()),

    // Job tracking
    jobNumber: v.optional(v.string()),
    changeOrderNumber: v.optional(v.string()),

    // Rate configuration (grouped object)
    rates: v.object(rateFields),

    // Dataset version - determines which pool data to use
    datasetVersion: dataVersion,

    // User overrides
    customQuantity: v.optional(v.number()),
    customUnit: v.optional(v.string()),
  })
    .index("by_firestore_id", ["firestoreId"])
    .index("by_number", ["proposalNumber"])
    .index("by_owner", ["ownerName"])
    .index("by_status", ["status"])
    .index("by_date_due", ["dateDue"]),

  /**
   * WBS - Work Breakdown Structure instances
   *
   * Source: Firestore `wbs` collection
   *
   * Users select a WBS type from wbsPool to create an instance.
   * Example: User picks "AG PIPING" (poolId 70000) -> creates WBS instance
   *
   * Key Changes:
   * - wbsDatabaseId -> wbsPoolId (renamed for clarity)
   * - All computed fields -> REMOVED
   */
  wbs: defineTable({
    firestoreId: v.optional(v.string()), // Original Firestore document ID
    proposalId: v.id("proposals"),
    wbsPoolId: v.number(), // References wbsPool.poolId
    name: v.string(), // Denormalized from wbsPool for display
    sortOrder: v.number(),
    customQuantity: v.optional(v.number()),
    customUnit: v.optional(v.string()),
  })
    .index("by_firestore_id", ["firestoreId"])
    .index("by_proposal", ["proposalId"])
    .index("by_proposal_pool", ["proposalId", "wbsPoolId"])
    .index("by_proposal_sort", ["proposalId", "sortOrder"]),

  /**
   * Phases - Phase instances within a WBS
   *
   * Source: Firestore `phase` collection
   *
   * Users select a phase type from phasePool to create an instance.
   * Example: Under "AG PIPING", user picks "CARBON STEEL" (poolId 70001)
   *
   * Key Changes:
   * - phaseDatabaseId -> phasePoolId (renamed)
   * - phaseDatabaseName -> poolName (renamed)
   * - size, spec, flc, system, insulation, insulationSize -> pipingSpec object
   * - sys field -> REMOVED (duplicate of system)
   * - completed -> isCompleted (renamed)
   * - All computed fields -> REMOVED
   */
  phases: defineTable({
    firestoreId: v.optional(v.string()), // Original Firestore document ID
    proposalId: v.id("proposals"),
    wbsId: v.id("wbs"),
    phasePoolId: v.number(), // References phasePool.poolId
    poolName: v.string(), // Denormalized from phasePool for display
    phaseNumber: v.number(), // User-assigned sequence number
    description: v.string(), // User-entered description

    // Location
    area: v.optional(v.string()),
    sheet: v.optional(v.number()),

    // Piping-specific fields (optional - only for piping phases)
    pipingSpec: v.optional(v.object(pipingSpecFields)),

    status: v.optional(v.string()),
    isCompleted: v.boolean(),
    sortOrder: v.number(),
    customQuantity: v.optional(v.number()),
    customUnit: v.optional(v.string()),
  })
    .index("by_firestore_id", ["firestoreId"])
    .index("by_proposal", ["proposalId"])
    .index("by_wbs", ["wbsId"])
    .index("by_proposal_wbs", ["proposalId", "wbsId"])
    .index("by_wbs_sort", ["wbsId", "sortOrder"]),

  /**
   * Activities - Line items within a phase
   *
   * Source: Firestore `activities` collection
   *
   * Activities represent the actual work items: labor, materials, equipment, etc.
   * For labor activities, users select from laborPool.
   * For equipment activities, users select from equipmentPool.
   *
   * Key Changes:
   * - activityType -> type (renamed, new enum values)
   * - constant.id -> laborPoolId (extracted from embedded object)
   * - constant object -> REMOVED (no more embedding)
   * - equipment.id -> equipmentPoolId (extracted from embedded object)
   * - equipment object -> REMOVED (no more embedding)
   * - Labor fields -> labor object (optional)
   * - Equipment fields -> equipment object (optional)
   * - price -> unitPrice (renamed)
   * - All computed cost/hours fields -> REMOVED
   * - dateAdded -> _creationTime (use Convex system field)
   * - rowId -> REMOVED (UI concern)
   * - craftBaseRate, subsistenceRate, weldBaseRate -> REMOVED (use proposal rates)
   */
  activities: defineTable({
    firestoreId: v.optional(v.string()), // Original Firestore document ID
    proposalId: v.id("proposals"),
    wbsId: v.id("wbs"),
    phaseId: v.id("phases"),

    type: activityType,
    description: v.string(),
    quantity: v.number(),
    unit: v.string(),
    sortOrder: v.number(),

    // Pool references (for labor and equipment activities)
    laborPoolId: v.optional(v.number()), // References laborPool.poolId
    equipmentPoolId: v.optional(v.number()), // References equipmentPool.poolId

    // Type-specific fields (only one should be populated based on type)
    labor: v.optional(v.object(laborFields)), // For type: labor, custom_labor
    equipment: v.optional(v.object(equipmentFields)), // For type: equipment
    subcontractor: v.optional(v.object(subcontractorFields)), // For type: subcontractor
    unitPrice: v.optional(v.number()), // For type: material, cost_only
  })
    .index("by_firestore_id", ["firestoreId"])
    .index("by_phase", ["phaseId"])
    .index("by_wbs", ["wbsId"])
    .index("by_proposal", ["proposalId"])
    .index("by_phase_sort", ["phaseId", "sortOrder"])
    .index("by_phase_type", ["phaseId", "type"]),

  // ==========================================================================
  // APP PERMISSIONS
  // ==========================================================================

  /**
   * App Permissions - Per-member app access in an organization
   *
   * WHY: Controls which desktop apps each org member can access.
   * Owners get full access automatically; this table stores
   * explicit grants for non-owners.
   */
  appPermissions: defineTable({
    memberId: v.string(),
    app: v.union(v.literal("precision"), v.literal("momentum")),
    permission: v.union(
      v.literal("none"),
      v.literal("read"),
      v.literal("write"),
      v.literal("admin")
    ),
  })
    .index("by_member", ["memberId"])
    .index("by_member_app", ["memberId", "app"]),

  // ==========================================================================
  // USER PREFERENCES
  // ==========================================================================

  // ==========================================================================
  // MOMENTUM TABLES - Progress Tracking
  // ==========================================================================
  // These tables support the Momentum desktop app for tracking
  // construction project progress against estimates from Precision.
  // ==========================================================================

  /**
   * Momentum Projects - Links proposals to tracked construction projects.
   *
   * WHY separate from proposals: Clean separation between estimation (Precision)
   * and tracking (Momentum) concerns. Denormalized fields avoid N+1 queries
   * since Convex has no JOINs.
   */
  momentumProjects: defineTable({
    proposalId: v.id("proposals"),

    // Denormalized from proposal for fast list display
    name: v.string(),
    proposalNumber: v.string(),
    jobNumber: v.optional(v.string()),
    ownerName: v.string(),
    location: v.optional(v.string()),
    description: v.optional(v.string()),

    status: v.union(
      v.literal("active"),
      v.literal("on-hold"),
      v.literal("completed"),
      v.literal("archived")
    ),

    // Optional scheduling fields (Unix ms)
    actualStartDate: v.optional(v.number()),
    projectedEndDate: v.optional(v.number()),

    // Last date a progress entry was saved ("YYYY-MM-DD")
    lastEntryDate: v.optional(v.string()),
  })
    .index("by_proposal", ["proposalId"])
    .index("by_status", ["status"]),

  /**
   * Progress Entries - Daily completed quantities per activity.
   *
   * One row per activity per date (upsert pattern prevents duplicates).
   * WHY denormalized wbsId/phaseId: Convex has no JOINs — storing parent
   * references enables efficient rollup queries by WBS or phase.
   */
  progressEntries: defineTable({
    projectId: v.id("momentumProjects"),
    activityId: v.id("activities"),

    // Denormalized parent references for efficient rollup queries
    wbsId: v.id("wbs"),
    phaseId: v.id("phases"),

    entryDate: v.string(), // "YYYY-MM-DD"
    quantityCompleted: v.number(),
    enteredBy: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
    .index("by_project_date", ["projectId", "entryDate"])
    .index("by_activity", ["activityId"])
    .index("by_project_activity", ["projectId", "activityId"])
    .index("by_project_activity_date", ["projectId", "activityId", "entryDate"])
    .index("by_project_wbs", ["projectId", "wbsId"])
    .index("by_project_phase", ["projectId", "phaseId"]),

  /**
   * Activity Phase Overrides - Momentum-only phase reassignments.
   *
   * WHY: Field teams need to reorganize activities under different phases
   * without modifying the original estimate (owned by Precision).
   * One row per project+activity; deleting the row reverts to original.
   */
  activityPhaseOverrides: defineTable({
    projectId: v.id("momentumProjects"),
    activityId: v.id("activities"),
    overridePhaseId: v.id("phases"),
    originalPhaseId: v.id("phases"),
    originalWbsId: v.id("wbs"),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_activity", ["projectId", "activityId"]),

  // ==========================================================================
  // USER PREFERENCES
  // ==========================================================================

  /**
   * User WBS Preferences - Which WBS categories to show by default
   *
   * Source: Firestore `user-preferences` collection
   */
  userWbsPreferences: defineTable({
    userId: v.id("users"),
    wbsPoolNamesToDisplay: v.array(v.string()),
  }).index("by_user", ["userId"]),

  /**
   * Proposal Column Preferences - Column visibility per user per proposal
   *
   * Source: Firestore `visibilityModels` collection
   * Old key format: "{userId}_{proposalId}" -> Now proper foreign keys
   */
  proposalColumnPreferences: defineTable({
    userId: v.id("users"),
    proposalId: v.id("proposals"),
    columns: v.object({
      // Activity data grid columns
      rowId: v.optional(v.boolean()),
      description: v.optional(v.boolean()),
      quantity: v.optional(v.boolean()),
      unit: v.optional(v.boolean()),
      craftConstant: v.optional(v.boolean()),
      welderConstant: v.optional(v.boolean()),
      craftManHours: v.optional(v.boolean()),
      welderManHours: v.optional(v.boolean()),
      craftCost: v.optional(v.boolean()),
      welderCost: v.optional(v.boolean()),
      materialCost: v.optional(v.boolean()),
      equipmentCost: v.optional(v.boolean()),
      subContractorCost: v.optional(v.boolean()),
      costOnlyCost: v.optional(v.boolean()),
      totalCost: v.optional(v.boolean()),
      price: v.optional(v.boolean()),
      time: v.optional(v.boolean()),
      equipmentOwnership: v.optional(v.boolean()),
      craftBaseRate: v.optional(v.boolean()),
      subsistenceRate: v.optional(v.boolean()),
    }),
  })
    .index("by_user", ["userId"])
    .index("by_proposal", ["proposalId"])
    .index("by_user_proposal", ["userId", "proposalId"]),
});
