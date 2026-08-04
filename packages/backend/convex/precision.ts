/**
 * Convex functions for the Precision estimation app.
 *
 * Queries compute costs at read time from raw activity data + proposal rates.
 * Nothing is pre-aggregated — costs roll up from activity → phase → WBS →
 * proposal on every query, matching the Momentum pattern.
 *
 * AUTHORIZATION: every query requires Precision `read` and every mutation
 * requires Precision `write`, resolved by `model/precisionAccess.ts`. The guard
 * is the FIRST statement in each handler, before any `ctx.db.get`, so a refusal
 * can never double as an existence check for a proposal id.
 *
 * @see docs/precision/DECISIONS.md D-precisionauthz
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePrecisionRead, requirePrecisionWrite } from "./model/precisionAccess";

// The cost engine lives in its own dependency-free module so it can be unit
// tested in plain Node and reused by clients for optimistic updates. Never
// reimplement any of this here — that is exactly how the legacy estimator ended
// up with three divergent copies of its own math.
import { addCosts, computeActivityCosts, emptyCosts, round2, roundCosts } from "./model/costEngine";
import { byPhaseNumber, byWBSCode } from "./model/ordering";
import { canOverrideRates, rateOverrideRejection } from "./model/rateOverrides";
import { computePhaseTakeoff, type TakeoffCatalog } from "./model/takeoff";
import { nextPhaseNumber, phaseNumberConflict } from "./model/phaseNumbering";

// ============================================================================
// SHARED VALIDATORS (matching schema.ts definitions)
// ============================================================================

const dataVersion = v.union(v.literal("v1"), v.literal("v2"));

const bidType = v.union(
  v.literal("lump_sum"),
  v.literal("time_and_materials"),
  v.literal("budgetary"),
  v.literal("rates"),
  v.literal("cost_plus")
);

const proposalStatus = v.union(
  v.literal("bidding"),
  v.literal("submitted"),
  v.literal("awarded"),
  v.literal("rejected"),
  v.literal("declined"),
  v.literal("open"),
  v.literal("closed")
);

const addressFields = {
  street: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zipCode: v.optional(v.string()),
};

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

const pipingSpecFields = {
  size: v.optional(v.string()),
  spec: v.optional(v.string()),
  flc: v.optional(v.string()),
  system: v.optional(v.string()),
  insulation: v.optional(v.string()),
  insulationSize: v.optional(v.number()),
};

const activityType = v.union(
  v.literal("labor"),
  v.literal("material"),
  v.literal("equipment"),
  v.literal("subcontractor"),
  v.literal("cost_only"),
  v.literal("custom_labor")
);

const equipmentOwnership = v.union(v.literal("rental"), v.literal("owned"), v.literal("purchase"));

const laborFields = {
  craftConstant: v.number(),
  welderConstant: v.number(),
  /**
   * D3 override slots. `null` CLEARS (back to the proposal's rate); a number —
   * INCLUDING 0, a real $0.00/hr — sets. `v.optional(v.number())` could not
   * express the difference between "clear this" and "leave it alone", which is
   * why the union is required. Absence and null both inherit; the stored
   * document never holds null (see normalizeLaborOverrides).
   */
  customCraftRate: v.optional(v.union(v.number(), v.null())),
  customSubsistenceRate: v.optional(v.union(v.number(), v.null())),
};

const equipmentFields = {
  ownership: equipmentOwnership,
  time: v.number(),
};

/**
 * PATCH shapes for updateActivity — every field optional.
 *
 * A grid edits ONE cell at a time, but `ctx.db.patch` replaces a nested object
 * wholesale: a write of `{craftConstant}` alone would silently delete that
 * line's rate overrides. These let a cell send only what it changed, and the
 * handler merges over what is stored.
 */
const laborPatchFields = {
  craftConstant: v.optional(v.number()),
  welderConstant: v.optional(v.number()),
  customCraftRate: v.optional(v.union(v.number(), v.null())),
  customSubsistenceRate: v.optional(v.union(v.number(), v.null())),
};

const equipmentPatchFields = {
  ownership: v.optional(equipmentOwnership),
  time: v.optional(v.number()),
};

const subcontractorPatchFields = {
  laborCost: v.optional(v.number()),
  materialCost: v.optional(v.number()),
  equipmentCost: v.optional(v.number()),
};

const subcontractorFields = {
  laborCost: v.number(),
  materialCost: v.number(),
  equipmentCost: v.number(),
};

// ============================================================================
// DISPLAY ORDERING
// ============================================================================

// The comparators moved to `model/ordering.ts` so Momentum's scope tree can
// apply the identical rule (#17); the WHY comments live there now.

// ============================================================================
// QUERIES
// ============================================================================

/**
 * List all proposals with metadata for the estimates dashboard.
 *
 * WHY: Does not compute costs — keeps the list query fast.
 * Cost rollups happen when drilling into a specific proposal.
 */
/**
 * US state names to postal codes.
 *
 * InDemand's own proposal log writes location as "Dayton, OH", but the
 * imported records mix that with full names ("blair, Nebraska"). Normalising
 * to their convention keeps the column narrow enough to read at a glance —
 * "BEULAH, North Dakota" needs almost twice the width of "BEULAH, ND" and
 * truncates in a 116px column.
 */
const STATE_CODES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

/**
 * Placeholders the importer wrote where a value was unknown.
 *
 * Two live proposals (1810 and 1810.1) carry the literal string "None" as
 * their state with no city, which would compose into a Location column
 * reading "None" — junk presented as a place. Absent data must render blank.
 */
const ABSENT_TOKENS = new Set(["none", "n/a", "na", "null", "-", "--", "unknown", "tbd"]);

/** Postal code for a state written either way; unrecognised text is returned as-is. */
function normalizeState(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || ABSENT_TOKENS.has(value.toLowerCase())) return "";
  if (value.length === 2) return value.toUpperCase();
  return STATE_CODES[value.toLowerCase()] ?? value;
}

/** A city is a place name, not a placeholder — same rule, same reason. */
function normalizeCity(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || ABSENT_TOKENS.has(value.toLowerCase())) return "";
  return value;
}

export const listProposals = query({
  args: {},
  handler: async (ctx) => {
    await requirePrecisionRead(ctx);

    const proposals = await ctx.db.query("proposals").collect();

    return proposals.map((p) => ({
      _id: p._id,
      proposalNumber: p.proposalNumber,
      description: p.description,
      ownerName: p.ownerName,
      status: p.status ?? null,
      bidType: p.bidType ?? null,
      dateDue: p.dateDue ?? null,
      dateReceived: p.dateReceived ?? null,
      jobNumber: p.jobNumber ?? null,
      estimators: p.estimators ?? [],
      // Location is a first-class column of InDemand's own proposal log
      // ("Dayton, OH"), filled on 99.7% of its rows. Composed here rather
      // than client-side so the list has one string to sort and match on;
      // either half may be missing, so the comma only appears between two
      // present parts.
      location:
        [normalizeCity(p.projectAddress?.city), normalizeState(p.projectAddress?.state)]
          .filter(Boolean)
          .join(", ") || null,
      // Off by default in the log (46% / 38% filled), but their own sheet
      // carries both, so the column menu can reach them without a round trip.
      projectStartDate: p.projectStartDate ?? null,
      projectEndDate: p.projectEndDate ?? null,
      datasetVersion: p.datasetVersion,
      // D1 provenance, so the list can distinguish an estimate still mirroring
      // from the MCP Estimator from one that has been edited in Precision.
      precisionOwnedAt: p.precisionOwnedAt ?? null,
      isPrecisionOwned: p.precisionOwnedAt !== undefined,
    }));
  },
});

/**
 * Get a single proposal with all fields including rates.
 *
 * WHY: The overview screen needs full proposal details and rates
 * for editing. Does not load activities — cost rollups are separate queries.
 */
export const getProposal = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    // Count WBS and phases for the summary
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    return {
      ...proposal,
      wbsCount: wbsItems.length,
      phaseCount: phases.length,
      // `precisionOwnedAt` already arrives via the spread; this is the derived
      // form so callers need not re-encode "undefined means still mirroring"
      // (D1) at every render site.
      isPrecisionOwned: proposal.precisionOwnedAt !== undefined,
    };
  },
});

/**
 * Get the WBS list for a proposal with basic metadata.
 *
 * WHY: The sidebar and overview screen need WBS items without full cost rollups.
 * Cost rollups are computed by getWBSListWithCosts (Phase 2).
 */
export const getWBSForProposal = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Order comes from the WBS code, not from `sortOrder` — see byWBSCode.
    return byWBSCode(wbsItems).map((w) => ({
      _id: w._id,
      name: w.name,
      wbsPoolId: w.wbsPoolId,
      sortOrder: w.sortOrder,
      isHidden: w.isHidden ?? false,
    }));
  },
});

/**
 * Get WBS items with their phases for sidebar tree navigation.
 *
 * WHY: The sidebar tree needs to show WBS → Phase hierarchy for direct
 * navigation. Returns lightweight data (no cost rollups) to keep the
 * reactive query fast.
 */
export const getWBSWithPhasesForNav = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Group phases by WBS
    const phasesByWbs = new Map<string, typeof phases>();
    for (const phase of phases) {
      const key = phase.wbsId as string;
      const list = phasesByWbs.get(key) ?? [];
      list.push(phase);
      phasesByWbs.set(key, list);
    }

    // Both levels of the tree order by their domain code — WBS code and phase
    // number — never by `sortOrder`. See byWBSCode / byPhaseNumber.
    return byWBSCode(wbsItems).map((w) => ({
      _id: w._id,
      name: w.name,
      sortOrder: w.sortOrder,
      isHidden: w.isHidden ?? false,
      phases: byPhaseNumber(phasesByWbs.get(w._id as string) ?? []).map((p) => ({
        _id: p._id,
        phaseNumber: p.phaseNumber,
        description: p.description,
      })),
    }));
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Detach an estimate from the Firestore mirror on its first Precision write.
 *
 * WHY: the Firestore→Convex sync is a one-way mirror of the legacy MCP
 * Estimator and it patches blindly. Before this stamp existed, the 6-hourly
 * cron reverted proposal metadata and all 15 rates, and creating a Momentum
 * project reverted the WBS/phase/activity tree — so estimator work vanished
 * with no error and no warning. Once Precision writes anything in an
 * estimate's tree the estimate has forked, and mirroring it further would
 * destroy that work, so the first write stamps it and the sync skips the
 * record permanently (copy-on-write).
 *
 * No-ops when already stamped, because re-stamping would move the detach date
 * and burn a write for nothing. No-ops on a missing proposal because raising
 * "not found" belongs to the calling mutation's own existence check, which has
 * the context to name what was missing.
 *
 * @see docs/precision/DECISIONS.md D1
 */
async function claimForPrecision(ctx: MutationCtx, proposalId: Id<"proposals">): Promise<void> {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal || proposal.precisionOwnedAt !== undefined) return;

  await ctx.db.patch(proposalId, { precisionOwnedAt: Date.now() });
}

/**
 * Structural equality for the small JSON-safe shapes these mutations accept.
 *
 * WHY NOT `JSON.stringify`: object key order is not guaranteed to survive a
 * round trip through Convex, so a stringify comparison would report a change
 * where none exists — and under D1 a spurious change permanently detaches an
 * estimate from the estimator mirror. Comparing keys explicitly is order-blind.
 *
 * Scope is deliberately narrow: numbers, strings, booleans, `null`, arrays, and
 * flat objects (`projectAddress`, `pipingSpec`, `estimators`, `rates`). No cycles
 * and no class instances occur in mutation arguments.
 */
function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => isSameValue(item, b[i]));
  }

  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    // An absent key and an explicitly-undefined one mean the same thing here.
    const keys = (obj: Record<string, unknown>): string[] =>
      Object.keys(obj).filter((k) => obj[k] !== undefined);
    const leftKeys = keys(left);
    const rightKeys = keys(right);
    return (
      leftKeys.length === rightKeys.length && leftKeys.every((k) => isSameValue(left[k], right[k]))
    );
  }

  return false;
}

/**
 * Reduce supplied mutation fields to only those that actually differ from what
 * is stored.
 *
 * WHY: the update mutations are called from debounced inputs, so they routinely
 * receive the value already on the record. Patching on "a field was supplied"
 * rather than "a field changed" turns every stray blur into an edit — and under
 * D1 an edit permanently detaches the estimate from the estimator mirror, losing
 * all future upstream updates for an estimate nobody meaningfully touched.
 *
 * @see docs/precision/DECISIONS.md D1
 */
function changedFields(
  existing: Record<string, unknown>,
  supplied: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (value === undefined) continue;
    if (!isSameValue(existing[key], value)) patch[key] = value;
  }
  return patch;
}

/** The labor payload as the validators accept it, overrides still nullable. */
type LaborInput = {
  craftConstant?: number;
  welderConstant?: number;
  customCraftRate?: number | null;
  customSubsistenceRate?: number | null;
};

/**
 * Drop cleared overrides so the stored document never holds `null`.
 *
 * The engine reads `override ?? proposalRate`, so null and absent already mean
 * the same thing — but storing one of each would leave two spellings of
 * "inherits" in the data, and every later comparison would have to know that.
 * `!= null` deliberately keeps 0: a real $0.00/hr override (D3).
 */
function normalizeLaborOverrides(
  labor: LaborInput & { craftConstant: number; welderConstant: number }
) {
  return {
    craftConstant: labor.craftConstant,
    welderConstant: labor.welderConstant,
    ...(labor.customCraftRate != null ? { customCraftRate: labor.customCraftRate } : {}),
    ...(labor.customSubsistenceRate != null
      ? { customSubsistenceRate: labor.customSubsistenceRate }
      : {}),
  };
}

/**
 * True when the payload SETS an override — clearing one is always allowed.
 *
 * Judged against what is STORED, not against the payload alone: every write
 * carries the whole labor object, so an untouched pre-existing override rides
 * along with edits that have nothing to do with it. Counting those as "setting"
 * would make an illegal legacy value unremovable one field at a time.
 */
function setsRateOverride(labor: LaborInput | undefined, existing?: LaborInput): boolean {
  if (labor === undefined) return false;
  const isSet = (field: "customCraftRate" | "customSubsistenceRate"): boolean =>
    labor[field] != null && labor[field] !== existing?.[field];
  return isSet("customCraftRate") || isSet("customSubsistenceRate");
}

/**
 * Refuse a rate override on a line whose position forbids it (D6).
 *
 * Re-derived from the activity's stored phase and WBS rather than trusted from
 * the caller: eligibility is a property of the line IN ITS POSITION.
 */
async function assertMayOverrideRates(
  ctx: MutationCtx,
  phaseId: Id<"phases">,
  activityType: string
): Promise<void> {
  const phase = await ctx.db.get(phaseId);
  const wbs = phase ? await ctx.db.get(phase.wbsId) : null;
  if (!phase || !wbs) throw new Error("Activity is missing its phase or WBS");

  const rejection = rateOverrideRejection({
    activityType,
    wbsPoolId: wbs.wbsPoolId,
    phasePoolId: phase.phasePoolId,
  });
  if (rejection) throw new Error(rejection);
}

/**
 * Create a new proposal with rates and initialize its WBS structure.
 *
 * WHY: Proposal creation is a compound operation — it inserts the proposal
 * and initializes the standard WBS set from the pool in a single transaction.
 */
export const createProposal = mutation({
  args: {
    proposalNumber: v.string(),
    description: v.string(),
    ownerName: v.string(),
    rates: v.object(rateFields),
    datasetVersion: dataVersion,
    status: v.optional(proposalStatus),
    bidType: v.optional(bidType),
    projectAddress: v.optional(v.object(addressFields)),
    jobSiteAddress: v.optional(v.string()),
    estimators: v.optional(v.array(v.string())),
    dateReceived: v.optional(v.number()),
    dateDue: v.optional(v.number()),
    projectStartDate: v.optional(v.number()),
    projectEndDate: v.optional(v.number()),
    jobNumber: v.optional(v.string()),
    changeOrderNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    // Insert the proposal
    const proposalId = await ctx.db.insert("proposals", {
      // Stamped at birth: an estimate created in Precision has no counterpart in
      // the MCP Estimator, so it was never mirrored and never will be. Without
      // this it would report "mirroring from MCP Estimator" in the UI until some
      // later edit happened to claim it. Deliberately writes no `firestoreId` —
      // the sync matches solely on `by_firestore_id`, so a copied id would make
      // the mirror overwrite this estimate with legacy data. See DECISIONS.md D1.
      precisionOwnedAt: Date.now(),
      proposalNumber: args.proposalNumber,
      description: args.description,
      ownerName: args.ownerName,
      rates: args.rates,
      datasetVersion: args.datasetVersion,
      status: args.status,
      bidType: args.bidType,
      projectAddress: args.projectAddress,
      jobSiteAddress: args.jobSiteAddress,
      estimators: args.estimators,
      dateReceived: args.dateReceived,
      dateDue: args.dateDue,
      projectStartDate: args.projectStartDate,
      projectEndDate: args.projectEndDate,
      jobNumber: args.jobNumber,
      changeOrderNumber: args.changeOrderNumber,
    });

    // Initialize WBS from pool — try requested version, fall back to v1 if empty
    let wbsPoolItems = await ctx.db
      .query("wbsPool")
      .withIndex("by_version_active", (q) =>
        q.eq("datasetVersion", args.datasetVersion).eq("isActive", true)
      )
      .collect();
    if (wbsPoolItems.length === 0 && args.datasetVersion !== "v1") {
      wbsPoolItems = await ctx.db
        .query("wbsPool")
        .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
        .collect();
    }

    for (const poolItem of wbsPoolItems) {
      await ctx.db.insert("wbs", {
        proposalId,
        wbsPoolId: poolItem.poolId,
        name: poolItem.name,
        sortOrder: poolItem.sortOrder,
      });
    }

    return proposalId;
  },
});

/**
 * Update proposal metadata fields (not rates).
 *
 * WHY: Metadata and rates are edited in separate UI sections.
 * This mutation handles info fields; updateProposalRates handles rates.
 */
export const updateProposal = mutation({
  args: {
    proposalId: v.id("proposals"),
    proposalNumber: v.optional(v.string()),
    description: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    status: v.optional(proposalStatus),
    bidType: v.optional(bidType),
    projectAddress: v.optional(v.object(addressFields)),
    jobSiteAddress: v.optional(v.string()),
    estimators: v.optional(v.array(v.string())),
    dateReceived: v.optional(v.number()),
    dateDue: v.optional(v.number()),
    projectStartDate: v.optional(v.number()),
    projectEndDate: v.optional(v.number()),
    jobNumber: v.optional(v.string()),
    changeOrderNumber: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const { proposalId, ...fields } = args;

    const existing = await ctx.db.get(proposalId);
    if (!existing) throw new Error("Proposal not found");

    // Only fields that genuinely differ from what is stored. A debounced input
    // resending the current value is not an edit, and under D1 an edit detaches
    // the estimate from the estimator mirror permanently.
    const patch = changedFields(existing, fields);

    if (Object.keys(patch).length > 0) {
      await claimForPrecision(ctx, proposalId);
      await ctx.db.patch(proposalId, patch);
    }
  },
});

/**
 * Update proposal rate configuration.
 *
 * WHY: Rates are the full 15-field object that drives all cost calculations.
 * Separating this from metadata makes the intent clear and allows the UI
 * to debounce rate changes independently.
 */
export const updateProposalRates = mutation({
  args: {
    proposalId: v.id("proposals"),
    rates: v.object(rateFields),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const existing = await ctx.db.get(args.proposalId);
    if (!existing) throw new Error("Proposal not found");

    // Bail out when nothing actually differs, BEFORE claiming ownership.
    //
    // WHY THIS MATTERS MORE THAN IT LOOKS: `RatesGrid` fires a debounced write on
    // every keystroke, and `parseFloat(raw) || 0` means retyping the same number
    // produces an identical payload. Claiming unconditionally would mean that
    // merely visiting the rates screen and touching a field permanently detaches
    // the estimate from the estimator mirror — losing every future upstream
    // update for an estimate nobody actually edited. Detaching must require a
    // real change. See DECISIONS.md D1.
    const rateKeys = Object.keys(args.rates) as Array<keyof typeof args.rates>;
    const unchanged = rateKeys.every((key) => existing.rates[key] === args.rates[key]);
    if (unchanged) return;

    await claimForPrecision(ctx, args.proposalId);
    await ctx.db.patch(args.proposalId, { rates: args.rates });
  },
});

/**
 * Delete a proposal and all associated data.
 *
 * WHY: Cascading delete is necessary because WBS, phases, and activities
 * all hold foreign key references to the proposal. Deleting in reverse
 * order (activities → phases → WBS → proposal) ensures no orphans.
 *
 * WHY THE MOMENTUM CHECK: Convex has no referential integrity, and
 * `momentumProjects.proposalId` points here from a different app that is in
 * production use. Deleting a proposal that a live project was created from
 * would leave that project pointing at nothing, with no error raised anywhere.
 * Refusing is correct — a Momentum project is a frozen snapshot taken at
 * creation time, so the right remedy is to delete the project first if it is
 * genuinely unwanted.
 */
export const deleteProposal = mutation({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    const access = await requirePrecisionWrite(ctx);

    const existing = await ctx.db.get(args.proposalId);
    if (!existing) throw new Error("Proposal not found");

    const linkedProjects = await ctx.db
      .query("momentumProjects")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    if (linkedProjects.length > 0) {
      const names = linkedProjects.map((p) => p.name).join(", ");
      throw new Error(
        `Cannot delete estimate ${existing.proposalNumber}: ` +
          `${linkedProjects.length} Momentum project(s) were created from it (${names}). ` +
          `Delete those projects first.`
      );
    }

    // A mirrored estimate still exists in Firestore, so without a tombstone
    // the 6-hourly sync re-inserts the whole tree and the deletion silently
    // reverts within hours. Same transaction as the cascade: either both
    // happen or neither. Precision-born proposals have no firestoreId and
    // cannot come back, so they need no tombstone.
    if (existing.firestoreId !== undefined) {
      await ctx.db.insert("proposalTombstones", {
        firestoreId: existing.firestoreId,
        proposalNumber: existing.proposalNumber,
        deletedAt: Date.now(),
        deletedBy: access.userId,
      });
    }

    // Delete all activities for this proposal
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }

    // Delete all phases for this proposal
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    for (const phase of phases) {
      await ctx.db.delete(phase._id);
    }

    // Delete all WBS for this proposal
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    for (const wbs of wbsItems) {
      await ctx.db.delete(wbs._id);
    }

    // Delete the proposal itself
    await ctx.db.delete(args.proposalId);
  },
});

// ============================================================================
// COST QUERIES (Phase 2 — Server-Side Calculation Engine)
// ============================================================================

/** WBS pool IDs classified as indirect (non-productive) hours. */
const INDIRECT_WBS_POOL_IDS = new Set([
  10000, // MOBILIZE
  180000, // SPECIALTY SERVICES
  190000, // DEMOBILIZE
  200000, // SUPPORT
]);

/** Create a zero-initialized cost accumulator. */
const zeroCosts = emptyCosts;

/** Add computed activity costs into an accumulator (mutates acc). */
const accumulateCosts = addCosts;

/**
 * Round all fields in a cost accumulator for display.
 *
 * WHY ONLY HERE: accumulation runs in full precision so a WBS total cannot
 * drift from the sum of its phases. Rounding happens once, at the boundary
 * where numbers leave the server.
 */
const roundAccumulator = roundCosts;

/**
 * Get all activities for a phase with individually computed costs.
 *
 * WHY: This is the data that powers the activity data grid.
 * Typically 5-50 activities per phase — efficient and fast.
 */
export const getActivitiesWithCosts = query({
  args: { phaseId: v.id("phases") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    const proposal = await ctx.db.get(phase.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    const wbs = await ctx.db.get(phase.wbsId);
    if (!wbs) throw new Error("WBS not found");

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.phaseId))
      .collect();

    return activities.map((activity) => ({
      ...activity,
      // Rounded here because this is a display boundary — the grid renders these
      // directly. Rollup queries accumulate the unrounded values instead.
      costs: roundCosts(computeActivityCosts(activity, rates)),
      // Resolved server-side so the grid renders the same answer the mutation
      // will enforce. Two independent copies of this rule is how legacy ended up
      // with a restriction that the UI showed and the write path ignored. See D6.
      canOverrideRates: canOverrideRates({
        activityType: activity.type,
        wbsPoolId: wbs.wbsPoolId,
        phasePoolId: phase.phasePoolId,
      }),
    }));
  },
});

/**
 * Get phases for a WBS with cost rollups.
 *
 * WHY: The WBS detail screen shows a phase list with aggregated costs.
 * Loads activities for the WBS once, groups by phase, then sums.
 */
export const getPhaseListWithCosts = query({
  args: { wbsId: v.id("wbs") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    const proposal = await ctx.db.get(wbs.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    // Load all activities for this WBS in a single query
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    // Group activities by phase
    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const activity of activities) {
      const key = activity.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(activity);
      activitiesByPhase.set(key, list);
    }

    const takeoffCatalog = await loadTakeoffCatalog(
      ctx,
      proposal.datasetVersion,
      phases.map((phase) => phase.phasePoolId)
    );

    // Rows are ordered by phase number, not by `sortOrder` — see byPhaseNumber.
    return byPhaseNumber(phases).map((phase) => {
      const phaseActivities = activitiesByPhase.get(phase._id as string) ?? [];
      const acc = zeroCosts();

      for (const activity of phaseActivities) {
        accumulateCosts(acc, computeActivityCosts(activity, rates));
      }

      return {
        _id: phase._id,
        phasePoolId: phase.phasePoolId,
        poolName: phase.poolName,
        phaseNumber: phase.phaseNumber,
        description: phase.description,
        area: phase.area ?? null,
        sheet: phase.sheet ?? null,
        pipingSpec: phase.pipingSpec ?? null,
        isCompleted: phase.isCompleted,
        sortOrder: phase.sortOrder,
        activityCount: phaseActivities.length,
        takeoff: computePhaseTakeoff(phase, phaseActivities, takeoffCatalog),
        costs: roundAccumulator(acc),
      };
    });
  },
});

/**
 * Prefetch the catalog knowledge `computePhaseTakeoff` needs for a set of
 * phase pools: each pool's takeoff unit and the flagged labor items beneath
 * it. Bounded by catalog size (a phase type carries at most ~220 items), not
 * by estimate size.
 */
async function loadTakeoffCatalog(
  ctx: QueryCtx,
  datasetVersion: "v1" | "v2",
  phasePoolIds: readonly number[]
): Promise<TakeoffCatalog> {
  const unitByPhasePool = new Map<number, string>();
  const flaggedLaborPoolIds = new Set<number>();

  for (const poolId of new Set(phasePoolIds)) {
    const pool = await ctx.db
      .query("phasePool")
      .withIndex("by_version_pool_id", (q) =>
        q.eq("datasetVersion", datasetVersion).eq("poolId", poolId)
      )
      .unique();
    if (pool?.takeoffUnit !== undefined) unitByPhasePool.set(poolId, pool.takeoffUnit);

    const items = await ctx.db
      .query("laborPool")
      .withIndex("by_version_phase", (q) =>
        q.eq("datasetVersion", datasetVersion).eq("phasePoolId", poolId)
      )
      .collect();
    for (const item of items) {
      if (item.countsTowardTakeoff) flaggedLaborPoolIds.add(item.poolId);
    }
  }

  return { unitByPhasePool, flaggedLaborPoolIds };
}

/**
 * Get WBS list for a proposal with cost rollups per WBS.
 *
 * WHY: The estimate overview shows each WBS category with aggregated costs.
 * Loads ALL activities for the proposal once, groups by WBS, sums costs.
 * For a 10K-activity proposal, this runs server-side in <100ms.
 */
export const getWBSListWithCosts = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Load ALL activities for this proposal (single indexed query)
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Load phases to count per WBS
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Index activities by WBS
    const activitiesByWBS = new Map<string, Doc<"activities">[]>();
    for (const activity of activities) {
      const key = activity.wbsId as string;
      const list = activitiesByWBS.get(key) ?? [];
      list.push(activity);
      activitiesByWBS.set(key, list);
    }

    // Count phases per WBS
    const phaseCountByWBS = new Map<string, number>();
    for (const phase of phases) {
      const key = phase.wbsId as string;
      phaseCountByWBS.set(key, (phaseCountByWBS.get(key) ?? 0) + 1);
    }

    // Order comes from the WBS code, not from `sortOrder` — see byWBSCode.
    return byWBSCode(wbsItems).map((wbs) => {
      const wbsActivities = activitiesByWBS.get(wbs._id as string) ?? [];
      const acc = zeroCosts();

      for (const activity of wbsActivities) {
        accumulateCosts(acc, computeActivityCosts(activity, rates));
      }

      return {
        _id: wbs._id,
        name: wbs.name,
        wbsPoolId: wbs.wbsPoolId,
        sortOrder: wbs.sortOrder,
        isHidden: wbs.isHidden ?? false,
        phaseCount: phaseCountByWBS.get(wbs._id as string) ?? 0,
        activityCount: wbsActivities.length,
        costs: roundAccumulator(acc),
      };
    });
  },
});

/**
 * Show or hide a WBS in this proposal's navigation.
 *
 * NAVIGATIONAL ONLY: a hidden WBS keeps its phases and activities, and any
 * work it contains stays in every total and in the export — decluttering a
 * menu must never move a bid. The UI is responsible for saying so when a
 * hidden WBS carries cost.
 *
 * DELIBERATELY does not `claimForPrecision` — the one D1 exception: hiding
 * is Precision-side navigation state the legacy estimator has no notion of,
 * and the sync cannot clobber it (mapWBS never emits `isHidden`, so the
 * sync's patch leaves the flag alone — pinned by wbsVisibility.test.ts).
 * Claiming here would permanently detach a mirrored estimate over a menu
 * preference.
 */
export const setWBSHidden = mutation({
  args: { wbsId: v.id("wbs"), hidden: v.boolean() },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    // Stored sparsely — absent means visible, like every pre-existing row.
    await ctx.db.patch(args.wbsId, { isHidden: args.hidden ? true : undefined });
  },
});

/**
 * Full proposal cost summary with direct/indirect hour classification.
 *
 * WHY: The totals panel needs a complete cost picture. This loads ALL
 * activities and computes everything in a single pass. The heavy lifting
 * runs server-side where Convex is optimized for large `.collect()` calls.
 */
export const getProposalSummary = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    // Load all WBS to classify direct/indirect
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Build a set of indirect WBS IDs
    const indirectWBSIds = new Set<string>();
    for (const wbs of wbsItems) {
      if (INDIRECT_WBS_POOL_IDS.has(wbs.wbsPoolId)) {
        indirectWBSIds.add(wbs._id as string);
      }
    }

    // Load all activities
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Load phases count
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Single-pass accumulation
    const total = zeroCosts();
    let directCraftHours = 0;
    let directWelderHours = 0;
    let indirectHours = 0;

    for (const activity of activities) {
      const costs = computeActivityCosts(activity, rates);
      accumulateCosts(total, costs);

      // Classify hours
      const isIndirect = indirectWBSIds.has(activity.wbsId as string);
      const activityHours = costs.craftManHours + costs.welderManHours;

      if (isIndirect) {
        indirectHours += activityHours;
      } else {
        directCraftHours += costs.craftManHours;
        directWelderHours += costs.welderManHours;
      }
    }

    const directHours = directCraftHours + directWelderHours;
    const totalHours = directHours + indirectHours;

    return {
      ...roundAccumulator(total),
      directCraftHours: round2(directCraftHours),
      directWelderHours: round2(directWelderHours),
      directHours: round2(directHours),
      indirectHours: round2(indirectHours),
      totalHours: round2(totalHours),
      wbsCount: wbsItems.length,
      phaseCount: phases.length,
      activityCount: activities.length,
    };
  },
});

/** Get a single WBS document. */
export const getWBS = query({
  args: { wbsId: v.id("wbs") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");
    return wbs;
  },
});

/** Get a single phase document. */
export const getPhase = query({
  args: { phaseId: v.id("phases") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");
    return phase;
  },
});

// ============================================================================
// POOL QUERIES (Reference Data Catalogs)
// ============================================================================

/**
 * Get active WBS pool entries for a dataset version.
 *
 * WHY fallback: v2 pool data is incomplete (WBS/phase/labor only exist in v1).
 * If the requested version returns 0 results, we fall back to v1 automatically.
 */
export const getWBSPool = query({
  args: { datasetVersion: dataVersion },
  handler: async (ctx, args) => {
    // Reference catalogs are guarded too: a WBS/phase/labor/equipment pool is
    // not an estimate, but it is a description of the company's own cost
    // structure and is no more public than the bids built from it.
    await requirePrecisionRead(ctx);

    const results = await ctx.db
      .query("wbsPool")
      .withIndex("by_version_active", (q) =>
        q.eq("datasetVersion", args.datasetVersion).eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("wbsPool")
      .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
      .collect();
  },
});

/**
 * Get phase pool entries for a specific WBS category.
 *
 * WHY fallback: Phase pool only has v1 data currently. Falls back to v1
 * when the requested version returns empty.
 */
export const getPhasePool = query({
  args: {
    datasetVersion: dataVersion,
    wbsPoolId: v.number(),
  },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const results = await ctx.db
      .query("phasePool")
      .withIndex("by_version_wbs_active", (q) =>
        q
          .eq("datasetVersion", args.datasetVersion)
          .eq("wbsPoolId", args.wbsPoolId)
          .eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("phasePool")
      .withIndex("by_version_wbs_active", (q) =>
        q.eq("datasetVersion", "v1").eq("wbsPoolId", args.wbsPoolId).eq("isActive", true)
      )
      .collect();
  },
});

/**
 * Get labor pool entries for a specific phase type.
 *
 * WHY fallback: Labor pool only has v1 data currently. Falls back to v1
 * when the requested version returns empty.
 */
export const getLaborPool = query({
  args: {
    datasetVersion: dataVersion,
    phasePoolId: v.number(),
  },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const results = await ctx.db
      .query("laborPool")
      .withIndex("by_version_phase_active", (q) =>
        q
          .eq("datasetVersion", args.datasetVersion)
          .eq("phasePoolId", args.phasePoolId)
          .eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("laborPool")
      .withIndex("by_version_phase_active", (q) =>
        q.eq("datasetVersion", "v1").eq("phasePoolId", args.phasePoolId).eq("isActive", true)
      )
      .collect();
  },
});

/**
 * Get all active equipment pool entries.
 *
 * WHY fallback: Equipment pool has both v1 and v2 data, but falls back
 * to v1 for consistency if the requested version is empty.
 */
export const getEquipmentPool = query({
  args: { datasetVersion: dataVersion },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const results = await ctx.db
      .query("equipmentPool")
      .withIndex("by_version_active", (q) =>
        q.eq("datasetVersion", args.datasetVersion).eq("isActive", true)
      )
      .collect();
    if (results.length > 0 || args.datasetVersion === "v1") return results;
    return ctx.db
      .query("equipmentPool")
      .withIndex("by_version_active", (q) => q.eq("datasetVersion", "v1").eq("isActive", true))
      .collect();
  },
});

// ============================================================================
// WBS MUTATIONS
// ============================================================================

/** Add a single WBS category to a proposal from the pool. */
export const addWBS = mutation({
  args: {
    proposalId: v.id("proposals"),
    wbsPoolId: v.number(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    // Check for duplicate WBS pool ID on this proposal
    const existing = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_pool", (q) =>
        q.eq("proposalId", args.proposalId).eq("wbsPoolId", args.wbsPoolId)
      )
      .first();
    if (existing) throw new Error("WBS category already exists on this proposal");

    // Determine sort order (append after last)
    const allWbs = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.proposalId))
      .collect();
    const maxSort = allWbs.length > 0 ? Math.max(...allWbs.map((w) => w.sortOrder)) : 0;

    await claimForPrecision(ctx, args.proposalId);

    return ctx.db.insert("wbs", {
      proposalId: args.proposalId,
      wbsPoolId: args.wbsPoolId,
      name: args.name,
      sortOrder: maxSort + 1,
    });
  },
});

/**
 * Delete a WBS and all its phases and activities.
 *
 * WHY: Cascade delete ensures no orphaned phases or activities.
 */
export const deleteWBS = mutation({
  args: { wbsId: v.id("wbs") },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    await claimForPrecision(ctx, wbs.proposalId);

    // Delete activities under this WBS
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();
    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }

    // Delete phases under this WBS
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_wbs", (q) => q.eq("wbsId", args.wbsId))
      .collect();
    for (const phase of phases) {
      await ctx.db.delete(phase._id);
    }

    await ctx.db.delete(args.wbsId);
  },
});

// ============================================================================
// PHASE MUTATIONS
// ============================================================================

/** Add a new phase to a WBS. */
export const addPhase = mutation({
  args: {
    wbsId: v.id("wbs"),
    phasePoolId: v.number(),
    poolName: v.string(),
    /**
     * D-phasenumber: omitted = the server derives it (sequential from the
     * WBS code; reserved catalog phases take their id verbatim). Provided =
     * the estimator typed one by hand — honoured, but a duplicate within the
     * WBS is refused rather than silently created (legacy's behaviour).
     */
    phaseNumber: v.optional(v.number()),
    description: v.string(),
    area: v.optional(v.string()),
    sheet: v.optional(v.number()),
    pipingSpec: v.optional(v.object(pipingSpecFields)),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");

    const proposal = await ctx.db.get(wbs.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const existingPhases = await ctx.db
      .query("phases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    let phaseNumber: number;
    if (args.phaseNumber !== undefined) {
      if (phaseNumberConflict(args.phaseNumber, existingPhases)) {
        throw new Error(
          `Phase ${args.phaseNumber} already exists in this WBS. Pick another number or leave it automatic.`
        );
      }
      phaseNumber = args.phaseNumber;
    } else {
      phaseNumber = await deriveNextPhaseNumber(ctx, {
        datasetVersion: proposal.datasetVersion,
        wbsCode: wbs.wbsPoolId,
        phasePoolId: args.phasePoolId,
        existing: existingPhases,
      });
    }

    const maxSort =
      existingPhases.length > 0 ? Math.max(...existingPhases.map((p) => p.sortOrder)) : 0;

    await claimForPrecision(ctx, wbs.proposalId);

    return ctx.db.insert("phases", {
      proposalId: wbs.proposalId,
      wbsId: args.wbsId,
      phasePoolId: args.phasePoolId,
      poolName: args.poolName,
      phaseNumber,
      description: args.description,
      area: args.area,
      sheet: args.sheet,
      pipingSpec: args.pipingSpec,
      isCompleted: false,
      sortOrder: maxSort + 1,
    });
  },
});

/**
 * Resolve the reserved-number set for a dataset version and derive the next
 * phase number — the server-side half of D-phasenumber. Reserved flags are
 * catalog data (`phasePool.reservedPhaseNumber`, seeded from legacy's list).
 */
async function deriveNextPhaseNumber(
  ctx: QueryCtx,
  options: {
    datasetVersion: "v1" | "v2";
    wbsCode: number;
    phasePoolId: number;
    existing: readonly { phaseNumber: number }[];
    /** Force sequential numbering even for a reserved pool (phase copies). */
    neverReserved?: boolean;
  }
): Promise<number> {
  const reservedPools = await ctx.db
    .query("phasePool")
    .withIndex("by_version", (q) => q.eq("datasetVersion", options.datasetVersion))
    .collect();
  const reservedNumbers = new Set(
    reservedPools.filter((pool) => pool.reservedPhaseNumber).map((pool) => pool.poolId)
  );

  return nextPhaseNumber({
    wbsCode: options.wbsCode,
    phasePoolId: options.phasePoolId,
    isReserved: options.neverReserved ? false : reservedNumbers.has(options.phasePoolId),
    existing: options.existing,
    reservedNumbers,
  });
}

/**
 * Preview the number `addPhase` would assign — powers the Add Phase dialog's
 * live "Auto (70006)" hint without duplicating the rule client-side.
 */
export const getNextPhaseNumber = query({
  args: { wbsId: v.id("wbs"), phasePoolId: v.number() },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const wbs = await ctx.db.get(args.wbsId);
    if (!wbs) throw new Error("WBS not found");
    const proposal = await ctx.db.get(wbs.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const existing = await ctx.db
      .query("phases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", args.wbsId))
      .collect();

    return deriveNextPhaseNumber(ctx, {
      datasetVersion: proposal.datasetVersion,
      wbsCode: wbs.wbsPoolId,
      phasePoolId: args.phasePoolId,
      existing,
    });
  },
});

/** Update phase metadata. */
export const updatePhase = mutation({
  args: {
    phaseId: v.id("phases"),
    description: v.optional(v.string()),
    phaseNumber: v.optional(v.number()),
    area: v.optional(v.string()),
    sheet: v.optional(v.number()),
    pipingSpec: v.optional(v.object(pipingSpecFields)),
    isCompleted: v.optional(v.boolean()),
    status: v.optional(v.string()),
    /**
     * D-takeoff override. `null` CLEARS the override (back to the derived
     * sum); a number — including 0 — sets it. `v.optional(v.number())` could
     * not express that difference, per the D3 contract.
     */
    takeoffQuantity: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const { phaseId, takeoffQuantity, ...fields } = args;
    const existing = await ctx.db.get(phaseId);
    if (!existing) throw new Error("Phase not found");

    // Changed fields only — see updateProposal for why "supplied" is not enough.
    const patch: Record<string, unknown> = changedFields(existing, fields);

    // The stored override slot is legacy's `customQuantity`, already synced
    // and populated on ~10% of production phases — see model/takeoff.ts.
    if (takeoffQuantity === null) {
      if (existing.customQuantity !== undefined) patch.customQuantity = undefined;
    } else if (takeoffQuantity !== undefined && takeoffQuantity !== existing.customQuantity) {
      patch.customQuantity = takeoffQuantity;
    }

    if (Object.keys(patch).length > 0) {
      await claimForPrecision(ctx, existing.proposalId);
      await ctx.db.patch(phaseId, patch);
    }
  },
});

/**
 * Delete a phase and all its activities.
 *
 * WHY: Activities hold a phaseId foreign key; deleting the phase
 * without cleaning up activities would create orphans.
 */
export const deletePhase = mutation({
  args: { phaseId: v.id("phases") },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    await claimForPrecision(ctx, phase.proposalId);

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_phase", (q) => q.eq("phaseId", args.phaseId))
      .collect();
    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }

    await ctx.db.delete(args.phaseId);
  },
});

/**
 * Duplicate a phase and all its activities.
 *
 * WHY: Estimators frequently need to create similar phases with the same
 * activity structure. Deep-copying avoids re-entering all line items.
 */
export const duplicatePhase = mutation({
  args: {
    sourcePhaseId: v.id("phases"),
    /**
     * D-phasenumber: omitted = the server assigns the next sequential number
     * (never the source's — legacy copied it verbatim and collided, and a
     * reserved number belongs to exactly one phase). Provided = validated
     * against duplicates like addPhase.
     */
    newPhaseNumber: v.optional(v.number()),
    newDescription: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const sourcePhase = await ctx.db.get(args.sourcePhaseId);
    if (!sourcePhase) throw new Error("Source phase not found");

    const proposal = await ctx.db.get(sourcePhase.proposalId);
    if (!proposal) throw new Error("Proposal not found");
    const wbs = await ctx.db.get(sourcePhase.wbsId);
    if (!wbs) throw new Error("WBS not found");

    // Determine sort order for the new phase
    const existingPhases = await ctx.db
      .query("phases")
      .withIndex("by_wbs_sort", (q) => q.eq("wbsId", sourcePhase.wbsId))
      .collect();
    const maxSort =
      existingPhases.length > 0 ? Math.max(...existingPhases.map((p) => p.sortOrder)) : 0;

    let newPhaseNumber: number;
    if (args.newPhaseNumber !== undefined) {
      if (phaseNumberConflict(args.newPhaseNumber, existingPhases)) {
        throw new Error(
          `Phase ${args.newPhaseNumber} already exists in this WBS. Pick another number or leave it automatic.`
        );
      }
      newPhaseNumber = args.newPhaseNumber;
    } else {
      // A copy is an ordinary phase even when the source is reserved: the
      // reserved number identifies THE Hydrotesting phase, not its copies.
      newPhaseNumber = await deriveNextPhaseNumber(ctx, {
        datasetVersion: proposal.datasetVersion,
        wbsCode: wbs.wbsPoolId,
        phasePoolId: sourcePhase.phasePoolId,
        existing: existingPhases,
        neverReserved: true,
      });
    }

    await claimForPrecision(ctx, sourcePhase.proposalId);

    // Create the new phase
    const newPhaseId = await ctx.db.insert("phases", {
      proposalId: sourcePhase.proposalId,
      wbsId: sourcePhase.wbsId,
      phasePoolId: sourcePhase.phasePoolId,
      poolName: sourcePhase.poolName,
      phaseNumber: newPhaseNumber,
      description: args.newDescription ?? sourcePhase.description,
      area: sourcePhase.area,
      sheet: sourcePhase.sheet,
      pipingSpec: sourcePhase.pipingSpec,
      isCompleted: false,
      sortOrder: maxSort + 1,
      customQuantity: sourcePhase.customQuantity,
      customUnit: sourcePhase.customUnit,
    });

    // Copy all activities from source phase
    const sourceActivities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.sourcePhaseId))
      .collect();

    for (const activity of sourceActivities) {
      await ctx.db.insert("activities", {
        proposalId: sourcePhase.proposalId,
        wbsId: sourcePhase.wbsId,
        phaseId: newPhaseId,
        type: activity.type,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        sortOrder: activity.sortOrder,
        laborPoolId: activity.laborPoolId,
        equipmentPoolId: activity.equipmentPoolId,
        labor: activity.labor,
        equipment: activity.equipment,
        subcontractor: activity.subcontractor,
        unitPrice: activity.unitPrice,
      });
    }

    return { phaseId: newPhaseId, phaseNumber: newPhaseNumber };
  },
});

/**
 * Copy activities from one phase to another.
 *
 * WHY: Enables reusing activity sets across phases without
 * duplicating the entire phase structure.
 */
export const copyActivitiesToPhase = mutation({
  args: {
    sourcePhaseId: v.id("phases"),
    targetPhaseId: v.id("phases"),
    /**
     * Copy only these lines (all must belong to the source phase); absent
     * copies the whole phase — the original contract, kept for parity.
     */
    activityIds: v.optional(v.array(v.id("activities"))),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const sourcePhase = await ctx.db.get(args.sourcePhaseId);
    if (!sourcePhase) throw new Error("Source phase not found");

    const targetPhase = await ctx.db.get(args.targetPhaseId);
    if (!targetPhase) throw new Error("Target phase not found");
    if (args.targetPhaseId === args.sourcePhaseId)
      throw new Error("Target phase must differ from the source phase");

    // Get existing activities in target to determine sortOrder offset
    const targetActivities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.targetPhaseId))
      .collect();
    const maxSort =
      targetActivities.length > 0 ? Math.max(...targetActivities.map((a) => a.sortOrder)) : 0;

    const sourceActivities = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.sourcePhaseId))
      .collect();

    // Subset selection is validated against the SOURCE phase — an id from
    // any other phase is refused, not silently skipped, so a stale client
    // selection cannot quietly copy less than the user asked for.
    let toCopy = sourceActivities;
    if (args.activityIds) {
      const wanted = new Set<string>(args.activityIds.map((id) => id as string));
      toCopy = sourceActivities.filter((activity) => wanted.has(activity._id as string));
      if (toCopy.length !== wanted.size)
        throw new Error("Some selected activities are not in the source phase");
    }

    // Refused BEFORE the claim: stamping precisionOwnedAt on a write that
    // inserts nothing would detach a mirrored estimate for no reason (D1).
    if (toCopy.length === 0) throw new Error("Nothing to copy");

    // The target estimate is the one being written, and it need not be the
    // source's — this mutation permits copying across proposals, but only
    // between proposals on the SAME catalog version: laborPoolId and
    // equipmentPoolId are numbers scoped by datasetVersion, so re-keying them
    // into another version's catalog would silently change what the copied
    // lines cost and what their derived takeoff flag resolves to.
    if (sourcePhase.proposalId !== targetPhase.proposalId) {
      const sourceProposal = await ctx.db.get(sourcePhase.proposalId);
      const targetProposal = await ctx.db.get(targetPhase.proposalId);
      if (sourceProposal?.datasetVersion !== targetProposal?.datasetVersion)
        throw new Error("Source and target proposals use different dataset versions");
    }

    await claimForPrecision(ctx, targetPhase.proposalId);

    // D6 eligibility is a property of a line IN ITS POSITION, and this is the
    // one write path that changes a line's position — so it is the one path
    // that can smuggle an override past both guards. A SUPPORT line's rate
    // override riding into AG PIPING would be invisible there (the grid hides
    // the columns) and unclearable, while silently pricing the line.
    const targetWbs = await ctx.db.get(targetPhase.wbsId);
    if (!targetWbs) throw new Error("Target WBS not found");

    const insertedIds: Id<"activities">[] = [];
    for (const [i, activity] of toCopy.entries()) {
      // Dropped rather than refused: the estimator asked to copy the LINE, and
      // failing the whole copy over a rate they cannot see is the worse answer.
      const mayOverride = canOverrideRates({
        activityType: activity.type,
        wbsPoolId: targetWbs.wbsPoolId,
        phasePoolId: targetPhase.phasePoolId,
      });
      const id = await ctx.db.insert("activities", {
        proposalId: targetPhase.proposalId,
        wbsId: targetPhase.wbsId,
        phaseId: args.targetPhaseId,
        type: activity.type,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        sortOrder: maxSort + i + 1,
        laborPoolId: activity.laborPoolId,
        countsTowardTakeoff: activity.countsTowardTakeoff,
        equipmentPoolId: activity.equipmentPoolId,
        labor: activity.labor
          ? normalizeLaborOverrides(
              mayOverride
                ? activity.labor
                : { ...activity.labor, customCraftRate: null, customSubsistenceRate: null }
            )
          : undefined,
        equipment: activity.equipment,
        subcontractor: activity.subcontractor,
        unitPrice: activity.unitPrice,
      });
      insertedIds.push(id);
    }

    return insertedIds;
  },
});

// ============================================================================
// ACTIVITY MUTATIONS (Phase 4 — brought forward since validators are ready)
// ============================================================================

/** Add an activity to a phase. */
export const addActivity = mutation({
  args: {
    phaseId: v.id("phases"),
    type: activityType,
    description: v.string(),
    quantity: v.number(),
    unit: v.string(),
    laborPoolId: v.optional(v.number()),
    equipmentPoolId: v.optional(v.number()),
    labor: v.optional(v.object(laborFields)),
    equipment: v.optional(v.object(equipmentFields)),
    subcontractor: v.optional(v.object(subcontractorFields)),
    unitPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    // D6 is enforced on CREATE as well as update: guarding only the update
    // path would leave the same illegal override a door away — the
    // one-concept-two-places trap this codebase is prone to.
    if (setsRateOverride(args.labor)) {
      await assertMayOverrideRates(ctx, args.phaseId, args.type);
    }

    // Determine sort order
    const existing = await ctx.db
      .query("activities")
      .withIndex("by_phase_sort", (q) => q.eq("phaseId", args.phaseId))
      .collect();
    const maxSort = existing.length > 0 ? Math.max(...existing.map((a) => a.sortOrder)) : 0;

    await claimForPrecision(ctx, phase.proposalId);

    return ctx.db.insert("activities", {
      proposalId: phase.proposalId,
      wbsId: phase.wbsId,
      phaseId: args.phaseId,
      type: args.type,
      description: args.description,
      quantity: args.quantity,
      unit: args.unit,
      sortOrder: maxSort + 1,
      laborPoolId: args.laborPoolId,
      equipmentPoolId: args.equipmentPoolId,
      labor: args.labor ? normalizeLaborOverrides(args.labor) : undefined,
      equipment: args.equipment,
      subcontractor: args.subcontractor,
      unitPrice: args.unitPrice,
    });
  },
});

/** Update an activity's fields. */
export const updateActivity = mutation({
  args: {
    activityId: v.id("activities"),
    description: v.optional(v.string()),
    quantity: v.optional(v.number()),
    unit: v.optional(v.string()),
    labor: v.optional(v.object(laborPatchFields)),
    equipment: v.optional(v.object(equipmentPatchFields)),
    subcontractor: v.optional(v.object(subcontractorPatchFields)),
    unitPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const { activityId, ...fields } = args;
    const existing = await ctx.db.get(activityId);
    if (!existing) throw new Error("Activity not found");

    // Enforce the rate-override eligibility rule on the server.
    //
    // WHY HERE AND NOT ONLY IN THE UI: legacy implemented this rule twice, both
    // times in React (`activity_data_grid.tsx:552`, `edit_base_rate_dialog.tsx:46`),
    // and never on the write path — so the restriction was advisory and any
    // client could set an override on an ineligible line. Eligibility depends on
    // the activity's phase and WBS, not just its own type, so it is re-derived
    // from the stored position rather than trusted from the caller. See D6.
    // Only SETTING a value needs eligibility — clearing one is always allowed,
    // including on a line that should never have carried it.
    if (setsRateOverride(fields.labor, existing.labor)) {
      await assertMayOverrideRates(ctx, existing.phaseId, existing.type);
    }

    // NESTED PATCHES MERGE OVER WHAT IS STORED. A grid edits one cell, but
    // ctx.db.patch replaces a nested object wholesale — a write of
    // {craftConstant} alone would take the line's rate overrides with it.
    // Supplied keys win, omitted keys survive, and an explicit null still
    // clears (D3).
    const merged: Record<string, unknown> = { ...fields };
    if (fields.labor !== undefined) {
      const labor = { ...existing.labor, ...fields.labor };
      if (labor.craftConstant === undefined || labor.welderConstant === undefined)
        throw new Error("Labor constants are required on a line that has none");
      merged.labor = normalizeLaborOverrides({
        craftConstant: labor.craftConstant,
        welderConstant: labor.welderConstant,
        customCraftRate: labor.customCraftRate,
        customSubsistenceRate: labor.customSubsistenceRate,
      });
    }
    if (fields.equipment !== undefined) {
      const equipment = { ...existing.equipment, ...fields.equipment };
      if (equipment.ownership === undefined || equipment.time === undefined)
        throw new Error("Equipment ownership and duration are required");
      merged.equipment = { ownership: equipment.ownership, time: equipment.time };
    }
    if (fields.subcontractor !== undefined) {
      const sub = { ...existing.subcontractor, ...fields.subcontractor };
      merged.subcontractor = {
        laborCost: sub.laborCost ?? 0,
        materialCost: sub.materialCost ?? 0,
        equipmentCost: sub.equipmentCost ?? 0,
      };
    }

    // Changed fields only — see updateProposal for why "supplied" is not enough.
    const patch = changedFields(existing, merged);

    if (Object.keys(patch).length > 0) {
      await claimForPrecision(ctx, existing.proposalId);
      await ctx.db.patch(activityId, patch);
    }
  },
});

/** Batch delete multiple activities. */
export const batchDeleteActivities = mutation({
  args: { activityIds: v.array(v.id("activities")) },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    // Resolved up front so the claim happens before the first delete. Nothing
    // in the arg list confines the ids to one estimate, so claim every estimate
    // the batch actually touches rather than assuming a single owner.
    const activities: Doc<"activities">[] = [];
    for (const activityId of args.activityIds) {
      const activity = await ctx.db.get(activityId);
      if (activity) activities.push(activity);
    }

    for (const proposalId of new Set(activities.map((a) => a.proposalId))) {
      await claimForPrecision(ctx, proposalId);
    }

    for (const activity of activities) {
      await ctx.db.delete(activity._id);
    }
  },
});

/**
 * Reorder activities within a phase.
 *
 * WHY the permutation check: the caller's list is untrusted. Without it, ids
 * from a different phase — or a different proposal — would have their
 * sortOrder silently rewritten, while the D1 claim landed on THIS phase's
 * proposal and left the mutated one unclaimed for the mirror to overwrite. A
 * partial list would likewise leave duplicate or gapped sortOrders behind.
 * The list must therefore name exactly this phase's activities, once each.
 */
export const reorderActivities = mutation({
  args: {
    phaseId: v.id("phases"),
    orderedActivityIds: v.array(v.id("activities")),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const phase = await ctx.db.get(args.phaseId);
    if (!phase) throw new Error("Phase not found");

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_phase", (q) => q.eq("phaseId", args.phaseId))
      .collect();

    const phaseActivityIds = new Set<string>(activities.map((a) => a._id));
    const providedIds = new Set<string>(args.orderedActivityIds);
    if (
      providedIds.size !== args.orderedActivityIds.length ||
      providedIds.size !== phaseActivityIds.size ||
      args.orderedActivityIds.some((id) => !phaseActivityIds.has(id))
    ) {
      throw new Error("Reorder list must name each activity in the phase exactly once.");
    }

    // Validate before claiming: a refused call must not detach the estimate.
    await claimForPrecision(ctx, phase.proposalId);

    for (const [i, activityId] of args.orderedActivityIds.entries()) {
      await ctx.db.patch(activityId, { sortOrder: i + 1 });
    }
  },
});

// ============================================================================
// DUPLICATE PROPOSAL
// ============================================================================

/**
 * Deep-copy a proposal with all WBS, phases, and activities.
 *
 * WHY: Estimators frequently create new proposals based on existing ones.
 * This mutation copies the entire tree in a single transaction with
 * proper ID remapping at every level.
 */
export const duplicateProposal = mutation({
  args: {
    sourceProposalId: v.id("proposals"),
    newProposalNumber: v.string(),
    newDescription: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requirePrecisionWrite(ctx);

    const source = await ctx.db.get(args.sourceProposalId);
    if (!source) throw new Error("Source proposal not found");

    // Create the new proposal.
    //
    // WHY IT IS STAMPED AT BIRTH (D1): a duplicate is a native Precision
    // estimate with no Firestore counterpart, so it is Precision-owned from its
    // first byte. Deliberately no `firestoreId` — copying the source's would
    // make the mirror match this record and overwrite it with the source's
    // legacy data. The source is only read here, so it is not claimed.
    const newProposalId = await ctx.db.insert("proposals", {
      precisionOwnedAt: Date.now(),
      proposalNumber: args.newProposalNumber,
      description: args.newDescription ?? source.description,
      ownerName: source.ownerName,
      contactId: source.contactId,
      status: "bidding",
      bidType: source.bidType,
      projectAddress: source.projectAddress,
      jobSiteAddress: source.jobSiteAddress,
      estimators: source.estimators,
      dateReceived: source.dateReceived,
      dateDue: source.dateDue,
      projectStartDate: source.projectStartDate,
      projectEndDate: source.projectEndDate,
      jobNumber: source.jobNumber,
      changeOrderNumber: source.changeOrderNumber,
      rates: source.rates,
      datasetVersion: source.datasetVersion,
      customQuantity: source.customQuantity,
      customUnit: source.customUnit,
    });

    // Copy WBS items — build ID mapping
    const sourceWBS = await ctx.db
      .query("wbs")
      .withIndex("by_proposal_sort", (q) => q.eq("proposalId", args.sourceProposalId))
      .collect();

    const wbsIdMap = new Map<string, Id<"wbs">>();
    for (const wbs of sourceWBS) {
      const newWbsId = await ctx.db.insert("wbs", {
        proposalId: newProposalId,
        wbsPoolId: wbs.wbsPoolId,
        name: wbs.name,
        sortOrder: wbs.sortOrder,
        customQuantity: wbs.customQuantity,
        customUnit: wbs.customUnit,
        isHidden: wbs.isHidden,
      });
      wbsIdMap.set(wbs._id as string, newWbsId);
    }

    // Copy phases — build ID mapping
    const sourcePhases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.sourceProposalId))
      .collect();

    const phaseIdMap = new Map<string, Id<"phases">>();
    for (const phase of sourcePhases) {
      const newWbsId = wbsIdMap.get(phase.wbsId as string);
      if (!newWbsId) continue;

      const newPhaseId = await ctx.db.insert("phases", {
        proposalId: newProposalId,
        wbsId: newWbsId,
        phasePoolId: phase.phasePoolId,
        poolName: phase.poolName,
        phaseNumber: phase.phaseNumber,
        description: phase.description,
        area: phase.area,
        sheet: phase.sheet,
        pipingSpec: phase.pipingSpec,
        status: phase.status,
        isCompleted: false,
        sortOrder: phase.sortOrder,
        customQuantity: phase.customQuantity,
        customUnit: phase.customUnit,
      });
      phaseIdMap.set(phase._id as string, newPhaseId);
    }

    // Copy all activities with remapped IDs
    const sourceActivities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.sourceProposalId))
      .collect();

    for (const activity of sourceActivities) {
      const newWbsId = wbsIdMap.get(activity.wbsId as string);
      const newPhaseId = phaseIdMap.get(activity.phaseId as string);
      if (!newWbsId || !newPhaseId) continue;

      await ctx.db.insert("activities", {
        proposalId: newProposalId,
        wbsId: newWbsId,
        phaseId: newPhaseId,
        type: activity.type,
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        sortOrder: activity.sortOrder,
        laborPoolId: activity.laborPoolId,
        equipmentPoolId: activity.equipmentPoolId,
        labor: activity.labor,
        equipment: activity.equipment,
        subcontractor: activity.subcontractor,
        unitPrice: activity.unitPrice,
        // ⚠️ NOT OPTIONAL TO COPY. This is the estimator's explicit call on
        // whether the line counts toward the phase's takeoff, and for a custom
        // line it is the ONLY mechanism there is (see
        // model/takeoff.ts::activityCountsTowardTakeoff — the activity's own
        // flag wins, and without it a line with no laborPoolId counts for
        // nothing). Dropping it silently gave the revision different takeoff
        // quantities from the estimate it was copied from, in both directions:
        // a flagged custom line stopped counting, and a catalog line the
        // estimator had deliberately unflagged started again. Those quantities
        // are what Momentum tracks progress against.
        countsTowardTakeoff: activity.countsTowardTakeoff,
      });
    }

    return newProposalId;
  },
});

// ============================================================================
// EXPORT QUERY
// ============================================================================

/**
 * Get complete export data for a proposal with all computed costs.
 *
 * WHY: The Excel export needs every activity with its costs, organized
 * by WBS and phase. This single query provides the entire payload
 * with server-side computation to keep the export accurate.
 */
export const getExportData = query({
  args: { proposalId: v.id("proposals") },
  handler: async (ctx, args) => {
    await requirePrecisionRead(ctx);

    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("Proposal not found");

    const rates = proposal.rates;

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_proposal", (q) => q.eq("proposalId", args.proposalId))
      .collect();

    // Build lookup maps
    const phasesByWBS = new Map<string, Doc<"phases">[]>();
    for (const phase of phases) {
      const key = phase.wbsId as string;
      const list = phasesByWBS.get(key) ?? [];
      list.push(phase);
      phasesByWBS.set(key, list);
    }

    // Same takeoff computation as the phase list, so the exported sheet can
    // never disagree with the screen — the exact defect legacy shipped
    // (its export used a second heuristic copy with no CONCRETE branch).
    const takeoffCatalog = await loadTakeoffCatalog(
      ctx,
      proposal.datasetVersion,
      phases.map((phase) => phase.phasePoolId)
    );

    const activitiesByPhase = new Map<string, Doc<"activities">[]>();
    for (const activity of activities) {
      const key = activity.phaseId as string;
      const list = activitiesByPhase.get(key) ?? [];
      list.push(activity);
      activitiesByPhase.set(key, list);
    }

    // Build hierarchical export structure with computed costs.
    // The exported sheet must match what the app shows and what the bid sheet
    // says, so WBS order comes from the WBS code and phase order from the phase
    // number — never from `sortOrder`. See byWBSCode / byPhaseNumber. Activities
    // keep using `sortOrder` because they have no domain number of their own;
    // their order is genuinely the estimator's chosen row order.
    // Accumulated here, from each WBS's UNROUNDED total, rather than by summing
    // the rounded per-WBS figures afterwards. Summing rounded values lets up to
    // half a cent of error per WBS into the grand total, which on an 18-WBS
    // estimate is enough to make the bid sheet disagree with the overview screen
    // by a few cents. Round once, at the boundary. See DECISIONS.md D2.
    const grandTotal = zeroCosts();

    const exportWBS = byWBSCode(wbsItems).map((wbs) => {
      const wbsPhases = byPhaseNumber(phasesByWBS.get(wbs._id as string) ?? []);

      const wbsAcc = zeroCosts();

      const exportPhases = wbsPhases.map((phase) => {
        const phaseActivities = (activitiesByPhase.get(phase._id as string) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder
        );

        const phaseAcc = zeroCosts();

        const exportActivities = phaseActivities.map((activity) => {
          const costs = computeActivityCosts(activity, rates);
          accumulateCosts(phaseAcc, costs);
          return {
            _id: activity._id,
            type: activity.type,
            description: activity.description,
            quantity: activity.quantity,
            unit: activity.unit,
            costs: roundCosts(costs),
          };
        });

        accumulateCosts(wbsAcc, phaseAcc);

        return {
          _id: phase._id,
          phaseNumber: phase.phaseNumber,
          description: phase.description,
          poolName: phase.poolName,
          takeoff: computePhaseTakeoff(phase, phaseActivities, takeoffCatalog),
          activities: exportActivities,
          costs: roundAccumulator(phaseAcc),
        };
      });

      accumulateCosts(grandTotal, wbsAcc);

      return {
        _id: wbs._id,
        name: wbs.name,
        wbsPoolId: wbs.wbsPoolId,
        phases: exportPhases,
        costs: roundAccumulator(wbsAcc),
      };
    });

    return {
      proposal: {
        proposalNumber: proposal.proposalNumber,
        description: proposal.description,
        ownerName: proposal.ownerName,
        status: proposal.status,
        bidType: proposal.bidType,
        rates: proposal.rates,
      },
      wbs: exportWBS,
      totals: roundAccumulator(grandTotal),
      activityCount: activities.length,
      phaseCount: phases.length,
      wbsCount: wbsItems.length,
    };
  },
});
