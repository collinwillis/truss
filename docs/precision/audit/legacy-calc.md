# Legacy MCP Estimator — Calculation Engine, Data Model, Totals, Persistence

Audit of `/Users/collinwillis/Dev/Personal/mcp_estimator`. Everything below was read from source,
not from docs/comments. Where a comment or doc contradicts the code, the code is reported.

---

## 0. TL;DR for the rewriter

- There is **exactly one live cost engine**: `src/api/totals.ts` (7 pure functions) driven by one
  orchestrator, `processRawActivity()` in `src/utils/utils.ts`. Everything else that looks like a
  cost engine is dead.
- **All calculation is client-side, on every read, on every keystroke-commit.** Firestore stores
  _inputs only_ for labor/material/equipment/cost-only rows. Derived costs are recomputed in the
  browser and never persisted (with two exceptions — subcontractor `craftCost`/`materialCost`/
  `equipmentCost`, which are user-typed inputs stored on the doc).
- **There are two independent implementations of the same math** — the in-app engine
  (`api/totals.ts`) and the Excel "Data Dump" exporter (`api/data_dump.ts`, function
  `activityToDataDumpItem`). They agree for labor/material/equipment/cost-only and **disagree for
  subcontractor rows and for activity-level custom subsistence**. The number the estimator sees on
  screen is not always the number in the exported bid sheet.
- The rollup is **not** stored anywhere. Phase/WBS/Proposal totals are re-derived in memory in
  `src/utils/store.ts`.
- The proposal rate fields are written to Firestore **as strings** (from MUI `TextField`) and
  coerced back to numbers on read in exactly one place (`convertRatesToNumbers` in
  `src/api/proposal.ts`). Any read path that bypasses `getSingleProposal()` gets strings, and the
  formulas silently do string concatenation. Today all _live_ read paths go through it; two dead
  paths do not.

---

## 1. Purpose of the area and how a user actually flows through it

### What it is for

MCP Estimator produces a construction bid. The estimator builds a hierarchy:

```
Proposal  (holds the 15 rate fields — the entire cost basis)
  └─ WBS          (18 fixed divisions: MOBILIZE, AG PIPING, CONCRETE, …)
      └─ Phase    (a line item / drawing / system, e.g. "6\" CS LINE, AREA 400")
          └─ Activity  (one of 6 types; the atom that carries quantity × constant)
```

Cost is computed bottom-up from Activity, and the rate fields at the Proposal top drive every
Activity's math. Change one rate on the Proposal and every dollar in the estimate moves.

### Actual user flow (routes in `src/App.tsx`, `MemoryRouter`)

1. `/` — **Proposal Select**. `useProposals()` live-subscribes to the whole `proposals` collection,
   sorted by `proposalNumber` descending. "New Proposal" dialog asks for only _number_ +
   _description_; `insertProposal()` writes a `FirestoreProposal` with **every rate defaulted to 0**
   and then fans out `insertAllBaseWbs()` (18 WBS docs).
2. `/proposal/:proposalId` — **Proposal Home**. On mount it calls
   `estimatorStore.loadFullProposalData(proposalId)` which does the one and only bulk load:
   `getSingleProposal` + `fetchProposalPreferencesFromFirestore` + parallel `wbs` / `phase` /
   `activities` queries for the proposal, then computes _every_ activity cost and _every_ phase and
   WBS rollup in memory. Three tabs: **Details**, **Rates**, **WBS Data Grid**.
   - **Rates** tab is where the 15 rate fields live. It is a read-only display until you press
     _Edit_; then all fields become editable at once; _Save_ does a **full-document `setDoc` (no
     merge)** and then re-runs `loadFullProposalData`. A modal `Alert` confirms.
   - **WBS Data Grid** shows the 18 (or fewer — see WBS visibility) WBS rows with rolled-up hours
     and costs. All columns are `editable: false`. Its toolbar hosts **Data Dump → WBS Cost Report**
     (the Excel export) and **Select WBS**.
3. `/proposal/:id/wbs/:wbsId` — **WBS Home**. Phase grid. Nearly every descriptive column is
   editable inline; the 9 cost/hour columns are locked. "Add Phase", "Duplicate Phases", "Delete
   Phases", per-row `completed` checkbox.
4. `/proposal/:id/wbs/:wbsId/phase/:phaseId` — **Phase Home**. Activity grid. This is where the
   money is made: add labor activities from the constants library, add equipment from the equipment
   library, add material / cost-only / custom-labor / subcontractor rows, type quantities, override
   craft constants, override per-activity base rate + subsistence.
5. A persistent **Bottom Panel** (`src/components/bottom_pannel.tsx`) is rendered on the Proposal
   screen and computes a _third_, independent set of totals (direct vs indirect hours) from whatever
   slice of the store matches the current route.

### The critical implicit rule

Almost nothing is stored. Reopening a proposal re-derives every number from (a) the raw activity
inputs and (b) the current proposal rates. **Historic estimates are not immutable** — editing a rate
silently rewrites the cost of every activity ever entered on that proposal, including phases already
marked `completed`.

---

## 2. Module map — live vs dead

| File                                                                                                | Status                                         | Role                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/totals.ts`                                                                                 | **LIVE**                                       | The 7 cost primitives. Single source of truth.                                                                                                                                                                                                                                                                    |
| `src/utils/utils.ts` → `processRawActivity()`                                                       | **LIVE**                                       | Orchestrator: raw Firestore doc + Proposal → fully-costed `Activity`.                                                                                                                                                                                                                                             |
| `src/utils/utils.ts` → `calculateTotals()`, `calculateWbsTotals()`, `getQuantityAndUnit()`          | **LIVE**                                       | Rollup + quantity/unit inference.                                                                                                                                                                                                                                                                                 |
| `src/utils/store.ts` (`estimatorStore`, zustand)                                                    | **LIVE**                                       | Loads, holds, mutates and re-rolls the whole proposal tree. 798 lines.                                                                                                                                                                                                                                            |
| `src/newAPI/api.ts`                                                                                 | **LIVE**                                       | All Firestore reads/writes used by the store.                                                                                                                                                                                                                                                                     |
| `src/newAPI/debounced.ts`                                                                           | **LIVE**                                       | One 300 ms debounce, only for proposal preferences.                                                                                                                                                                                                                                                               |
| `src/api/data_dump.ts`                                                                              | **LIVE**                                       | Excel export. Contains a **second, divergent** cost engine.                                                                                                                                                                                                                                                       |
| `src/api/helpers.ts`                                                                                | **LIVE**                                       | Column-visibility persistence + `currencyRound()`.                                                                                                                                                                                                                                                                |
| `src/api/proposal.ts`                                                                               | **LIVE (partly)**                              | `insertProposal`, `getSingleProposal`, `updateSingleProposal`, `deleteProposalAndAssociatedData`.                                                                                                                                                                                                                 |
| `src/api/wbs.ts`                                                                                    | **LIVE (partly)**                              | `insertAllBaseWbs`, `getSingleWbs`, `updateWbs`.                                                                                                                                                                                                                                                                  |
| `src/data/datasets.ts`, `dataset_types.ts`, `proposal_datasets.ts`                                  | **LIVE**                                       | v1/v2 dataset resolution.                                                                                                                                                                                                                                                                                         |
| `src/utils/calculations.ts`                                                                         | **DEAD**                                       | Byte-for-byte-ish duplicate of `api/totals.ts` with a **different welder formula**. Zero importers.                                                                                                                                                                                                               |
| `src/stores/*.ts` (5 zustand stores)                                                                | **DEAD**                                       | `useActivityStore`, `usePhaseStore`, `useWbsStore`, `useProposalStore`, `usePreferencesStore` — never imported outside their own files.                                                                                                                                                                           |
| `src/api/activity.ts` → `calculateActivityData()`                                                   | **HALF-DEAD**                                  | Third copy of the orchestrator. Only still reachable through `data_dump.ts`.                                                                                                                                                                                                                                      |
| `src/api/activity.ts` → everything else                                                             | **DEAD**                                       | `insertActivityBatch`, `addCustomLabor/addCostOnly/addMaterial/addSubcontractor`, `deleteActivityBatch`, `resetConstantsBatch`, `changeActivityOrder`, `updateActivity`, `updateActivitiesBatch`, `getQuantityAndUnit` (a 4th, divergent copy). `getSingleActivity` is still used by `edit_base_rate_dialog.tsx`. |
| `src/api/phase.ts`                                                                                  | **MOSTLY DEAD**                                | `getPhasesForWbs`, `duplicatePhases`, `copyActivitiesFromPhase`, `updatePhase`, `insertPhase`, `deletePhaseBatch`, a duplicate `updateSingleProposal`. `getSinglePhase` used only by dead code.                                                                                                                   |
| `src/hooks/activity_hook.ts`, `phase_hook.ts`, `wbs_hook.ts`, `rates_hook.ts`                       | **DEAD**                                       | `useActivities`, `usePhases`, `useWbs`, `useLoadedRates` — no consumers. These are the old `onSnapshot`-per-collection architecture.                                                                                                                                                                              |
| `src/hooks/current_proposal_listener_hook.ts`                                                       | **DEAD** (only the two dead accordions use it) |
| `src/features/proposal home/components/proposal_info_accordion.tsx`, `proposal_rates_accordion.tsx` | **DEAD**                                       | The accordion UI Collin hates was replaced by the tabbed `proposal_details.tsx` / `proposal_rates.tsx`; the files are still in the tree and still compile.                                                                                                                                                        |
| `src/features/phase home/components/columns.tsx` → `getActivityColumns`                             | **DEAD**                                       | Superseded by `columns2.tsx`. Only the exported cell-whitelist arrays from `columns.tsx` are still used.                                                                                                                                                                                                          |
| `src/newAPI/api.ts` → `duplicateProposal`, `fetchCollectionCountsClient`                            | **DEAD**                                       | The UI calls the Cloud Function `duplicateProposal` instead (`functions/src/index.ts`).                                                                                                                                                                                                                           |
| `functions/src/index.ts`                                                                            | **LIVE**                                       | The _only_ server-side code in the app: one callable, `duplicateProposal`. No calculation on the server.                                                                                                                                                                                                          |

---

## 3. Exact data model

Firestore project `mcp-estimator`. Five collections plus one ad-hoc path.

### 3.1 `proposals/{autoId}` — model `FirestoreProposal` (`src/models/firestore models/proposal_firestore.ts`)

Identity / metadata (all `string | null` unless noted):

| Field                                                                                          | Type                      | Notes                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `proposalNumber`                                                                               | `number \| null`          | Also used as revision base: Cloud Fn duplicates create `N.1`, `N.2`…                         |
| `datasetVersions`                                                                              | `DatasetVersions \| null` | `{labor, phases, wbs, equipment}` each `'v1' \| 'v2'`                                        |
| `job`                                                                                          | string                    |                                                                                              |
| `coNumber`                                                                                     | `number \| null`          | Change-order number                                                                          |
| `proposalDescription`                                                                          | string                    |                                                                                              |
| `proposalOwner`                                                                                | string                    |                                                                                              |
| `projectCity`, `projectState`                                                                  | string                    | `projectState` from `UnitedStatesStates` enum (51 values incl. `None`)                       |
| `jobSiteAddress`                                                                               | string                    |                                                                                              |
| `proposalEstimators`                                                                           | string                    | free text, plural                                                                            |
| `proposalDateReceived`, `proposalDateDue`, `projectStartDate`, `projectEndDate`                | string                    | ISO-ish, sliced to 10 chars in the UI                                                        |
| `bidType`                                                                                      | string                    | `BidType`: None / Lump Sum / Time and Materials / Budgetary / Rates / Cost Plus              |
| `proposalStatus`                                                                               | string                    | `ProposalStatus`: None / Bidding / Submitted / Awarded / Rejected / Declined / Open / Closed |
| `contactName`, `contactAddress`, `contactCity`, `contactState`, `contactPhone`, `contactEmail` | string                    | phone stored as 10 raw digits                                                                |
| `contactZip`                                                                                   | `number \| null`          |                                                                                              |
| `customQuantity`                                                                               | `number \| null`          | **never read anywhere**                                                                      |
| `customUnit`                                                                                   | `string \| null`          | **never read anywhere**                                                                      |

**The 15 rate fields** (all `number`, default `0` in the constructor):

| #   | Field                     | UI label             | Unit | Feeds                                          |
| --- | ------------------------- | -------------------- | ---- | ---------------------------------------------- |
| 1   | `craftBaseRate`           | Craft Base Rate      | $/hr | craft loaded rate                              |
| 2   | `weldBaseRate`            | Weld Base Rate       | $/hr | welder loaded rate                             |
| 3   | `rigRate`                 | Rig Rate             | $/hr | welder loaded rate                             |
| 4   | `subsistenceRate`         | Subsistence Rate     | $/hr | craft **and** welder loaded rate               |
| 5   | `burdenRate`              | Burden Rate          | %    | craft + welder loaded rate                     |
| 6   | `overheadRate`            | Overhead Rate        | %    | craft + welder loaded rate                     |
| 7   | `consumablesRate`         | Consumables Rate     | %    | craft + welder loaded rate                     |
| 8   | `fuelRate`                | Fuel Rate            | %    | craft + welder loaded rate                     |
| 9   | `salesTaxRate`            | Sales Tax Rate       | %    | material cost, subcontractor cost              |
| 10  | `useTaxRate`              | Equipment Tax Rate   | %    | equipment cost (rental/purchase only)          |
| 11  | `laborProfitRate`         | Labor Profit         | %    | craft + welder loaded rate                     |
| 12  | `materialProfitRate`      | Material Profit      | %    | material cost                                  |
| 13  | `equipmentProfitRate`     | Equipment Profit     | %    | equipment cost (rental/purchase only)          |
| 14  | `subContractorProfitRate` | Subcontractor Profit | %    | subcontractor cost                             |
| 15  | `rigProfitRate`           | Rig Profit           | %    | welder loaded rate (on the rig component only) |

The client-side `Proposal` class (`src/models/proposal.ts`) adds _read-model_ fields that are
**never persisted and never populated by the live code**: `quantity`, `customQuantity`, `unit`,
`customUnit`, `craftManHours`, `craftCost`, `welderManHours`, `welderCost`, `materialCost`,
`equipmentCost`, `subContractorCost`, `costOnlyCost`, `totalCost`. There is **no proposal-level
rollup object** anywhere in the live code; proposal totals only exist transiently inside the Bottom
Panel and inside the Data Dump summary row.

### 3.2 `wbs/{autoId}` — model `FirestoreWbs`

| Field            | Type                                       |
| ---------------- | ------------------------------------------ |
| `proposalId`     | `string \| null`                           |
| `wbsDatabaseId`  | `number \| null` — one of the 18 fixed IDs |
| `name`           | `string \| null` — e.g. `'AG PIPING'`      |
| `customQuantity` | `number \| null`                           |
| `customUnit`     | `string \| null`                           |

The client `Wbs` class additionally carries the derived `quantity`, `unit`, `craftManHours`,
`craftCost`, `welderManHours`, `welderCost`, `materialCost`, `equipmentCost`, `subContractorCost`,
`costOnlyCost`, `totalCost`, `completed`. **None of those are persisted.**

The 18 WBS IDs (`src/data/v1/wbs_v1.json` and `src/utils/enums.ts` `WbsEnum`):

```
10000  MOBILIZE                   100000 INSULATION
20000  SITE PREPARATION           110000 PAINTING
30000  CONCRETE                   120000 DISMANTLING
40000  TOWERS/VESSELS/EQUIPMENT   130000 BG PIPING
50000  PUMPS & DRIVERS            140000 REFRACTORY
60000  STRUCTURAL                 150000 BUILDINGS
70000  AG PIPING                  180000 SPECIALTY SERVICES
80000  ELECTRICAL                 190000 DEMOBILIZE
90000  INSTRUMENTS                200000 SUPPORT
```

Note `enums.ts` misspells `REFRATORY` as the static key (value is `'REFRACTORY'`), and
`SITE PREPARATION` in `enums.ts` vs. the keyword map in `utils.ts` that keys on `20000`.

### 3.3 `phase/{autoId}` — model `FirestorePhase` (collection name is singular `phase`)

| Field                                                                                             | Type                         | Notes                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `proposalId`, `wbsId`                                                                             | `string \| null`             |                                                                          |
| `phaseDatabaseId`                                                                                 | `number \| null`             | selects which labor constants are offered                                |
| `phaseDatabaseName`                                                                               | `string \| null`             | catalog name of that phase                                               |
| `phaseNumber`                                                                                     | `number \| null`             | sort key; auto-generated from `wbsDatabaseId` in Add Phase               |
| `description`                                                                                     | `string \| null`             | the "LINE / DESCRIP" column                                              |
| `size`, `flc`, `system`, `sys`, `spec`, `insulation`, `insulationSize`, `sheet`, `area`, `status` | `string \| null`             | free-text descriptors, all inline-editable, all force-uppercased on save |
| `customQuantity`                                                                                  | `number \| null`             | user override of the inferred quantity                                   |
| `quantity`                                                                                        | `number \| null`             | legacy; the live grid writes `customQuantity` instead                    |
| `customUnit`                                                                                      | `string \| null`             | user override of the inferred unit                                       |
| `unit`                                                                                            | `string \| null`             | **legacy override slot** — see §9.4 for the live/dead divergence         |
| `completed`                                                                                       | `boolean` (defaults `false`) |                                                                          |

Client `Phase` also carries `wbsDatabaseId` and all the derived cost/hour fields; only `completed`
and the descriptors are persisted.

### 3.4 `activities/{autoId}` — model `FirestoreActivity` (collection name is plural)

**This is the input record.** 21 fields:

| Field                            | Type                   | Meaning                                                                        |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `proposalId`, `wbsId`, `phaseId` | `string \| null`       | denormalised parent keys (every query filters on these)                        |
| `activityType`                   | `ActivityType \| null` | one of 6 (§5); defaults to `laborItem` on read                                 |
| `description`                    | `string \| null`       | uppercased on every write                                                      |
| `quantity`                       | `number \| null`       | the driver of nearly every formula                                             |
| `unit`                           | `string \| null`       | for labor: the constant's `craftUnits`; for equipment: `EquipmentUnit`         |
| `constant`                       | `Constant \| null`     | **embedded snapshot** of the labor-library row                                 |
| `equipment`                      | `Equipment \| null`    | **embedded snapshot** of the equipment-library row                             |
| `craftConstant`                  | `number \| null`       | man-hours per unit, craft                                                      |
| `welderConstant`                 | `number \| null`       | man-hours per unit, welder                                                     |
| `price`                          | `number \| null`       | material unit price / equipment period rate / cost-only unit cost              |
| `time`                           | `number \| null`       | equipment duration (# of periods); subcontractor hours-per-unit (display only) |
| `craftBaseRate`                  | `number \| null`       | **per-activity override**; `null` ⇒ use proposal rate                          |
| `subsistenceRate`                | `number \| null`       | **per-activity override**; `null` ⇒ use proposal rate                          |
| `craftCost`                      | `number \| null`       | **input only for subcontractor rows**; ignored (recomputed) for all others     |
| `materialCost`                   | `number \| null`       | ditto                                                                          |
| `equipmentCost`                  | `number \| null`       | ditto                                                                          |
| `equipmentOwnership`             | `string \| null`       | `Rental` / `Owned` / `Purchase`                                                |
| `dateAdded`                      | `number \| null`       | `Date.now()` ms; fallback sort key                                             |
| `sortOrder`                      | `number \| null`       | fractional ordering (midpoint insertion)                                       |

Embedded `Constant` (`src/models/constant.ts`):
`id:number, phaseDatabaseId:number, description:string, sortOrder:number, craftConstant:number, craftUnits:string, weldConstant:number, weldUnits:string`.

Embedded `Equipment` (`src/models/equipment.ts`):
`id:number, description:string, hourRate:number, dayRate:number, weekRate:number, monthRate:number`.

The runtime `Activity` class (`src/models/activity.ts`, 30-arg positional constructor) adds the
computed fields: `craftManHours`, `welderManHours`, `craftCost`, `welderCost`, `materialCost`,
`equipmentCost`, `subContractorCost`, `costOnlyCost`, `totalCost`, `weldBaseRate`,
`customCraftRate`, `customSubsistenceRate`, `rowId`.

`rowId` is a display-only spreadsheet label (`A`, `B`, …, `Z`, `AA`, …) computed by
`numberToLetters(index+1)` after sorting. It is never persisted; typing into the `Item` column is
how you re-order rows.

### 3.5 `proposal-preferences/{proposalId}` — model `FirestoreProposalPreferences`

Single field: `wbsToDisplay: string[] | null` — an array of **WBS display names** (not IDs).
Controls which WBS rows appear anywhere. Default on creation is `[]` ⇒ a brand-new proposal shows
**zero** WBS.

### 3.6 `visibilityModels/{userId}_{phaseId}` (ad-hoc doc path)

Per-user, per-phase MUI column-visibility map. Written by `saveColumnVisibilityModel`, read by
`loadColumnVisibilityModel` (`src/api/helpers.ts`). If absent, a default map is synthesised from
which activity types are present in the phase.

### 3.7 `users/{uid}` — `UserProfile`

`{ uid, name, email, permission: 'read'|'readWrite', role: 'user'|'admin', disabled, deleted }`.
`hasWritePermissions` gates every editable cell and every quick-add button.

---

## 4. THE FORMULAS — complete algebraic form

Source of truth: `src/api/totals.ts`. Notation: proposal fields are the 15 rates; activity fields
are lower-case. All `%` rates are stored as whole numbers (e.g. `35` means 35 %) and divided by 100
at the point of use.

### 4.0 Shared sub-expression

```
S  =  (burdenRate + overheadRate + laborProfitRate + fuelRate + consumablesRate) / 100
```

`S` is the _only_ percentage bundle applied to labor. There is no separate "escalation", "per-diem"
or "travel" concept in the code — subsistence ($/hr) is the closest thing to per-diem, and travel is
modelled only as catalog phases (`TRAVEL IN`, `TRAVEL OUT`) under MOBILIZE/DEMOBILIZE with their own
craft constants.

### 4.1 Craft loaded rate — `getCraftLoadedRate({proposal, customCraftBaseRate, customSubsistenceRate})`

```
craftBase   =  customCraftBaseRate || proposal.craftBaseRate        // note: || not ??
subsistence =  customSubsistenceRate || proposal.subsistenceRate    // note: || not ??

craftLoadedRate  =  craftBase  +  craftBase · S  +  subsistence          [$ / craft man-hour]
```

Expanded:

```
craftLoadedRate = craftBase · (1 + (burden + overhead + laborProfit + fuel + consumables)/100)
                + subsistence
```

⚠ Because of `||` (not `??`), **an explicit per-activity rate of `0` is discarded** and the proposal
rate is used instead. You cannot zero out labor on a single activity.

### 4.2 Welder loaded rate — `getWelderLoadedRate({proposal})`

```
welderLoadedRate = weldBaseRate
                 + weldBaseRate · S
                 + subsistenceRate                       // ALWAYS the proposal rate
                 + rigRate
                 + rigRate · rigProfitRate/100           [$ / welder man-hour]
```

Expanded:

```
welderLoadedRate = weldBaseRate · (1 + (burden+overhead+laborProfit+fuel+consumables)/100)
                 + proposal.subsistenceRate
                 + rigRate · (1 + rigProfitRate/100)
```

⚠ Takes **no** custom-rate arguments. A per-activity `subsistenceRate` override affects craft hours
but _never_ welder hours, even on the same row. The Data Dump exporter does the opposite (§11.2) —
this is a genuine numeric divergence.

⚠ The dead `src/utils/calculations.ts` version of this function includes `rigProfitRate` inside the
`S` bundle (`sumRates(burden, overhead, laborProfit, fuel, consumables, rigProfitRate)`), i.e. it
applies rig profit to the _weld base wage_ as well as the rig. That is a different, almost certainly
wrong, formula. It is dead, but it is the trap for anyone who greps for "getWelderLoadedRate" and
finds the wrong file first.

### 4.3 Man-hours (`processRawActivity`, `src/utils/utils.ts:88`)

```
craftConstant   =  activity.craftConstant   ?? activity.constant.craftConstant ?? 0
welderConstant  =  activity.welderConstant  ?? activity.constant.weldConstant  ?? 0

craftManHours   =  quantity · craftConstant
welderManHours  =  quantity · welderConstant
```

The stored `craftConstant` **shadows** the embedded `constant` snapshot. This is why "Reset
Constants" exists (§9.7) and why changing a phase's catalog phase does not re-cost the rows.

### 4.4 Craft cost

```
if activityType ≠ subContractorItem:
    craftCost = craftManHours · craftLoadedRate(customCraftBaseRate = effectiveCraftBaseRate,
                                                customSubsistenceRate = effectiveSubsistenceRate)
else:
    craftCost = activity.craftCost          // user-entered, stored on the doc
```

where `effectiveCraftBaseRate = activity.craftBaseRate ?? proposal.craftBaseRate` and
`effectiveSubsistenceRate = activity.subsistenceRate ?? proposal.subsistenceRate`.

### 4.5 Welder cost — computed for **every** activity type

```
welderCost = welderManHours · welderLoadedRate
```

Non-labor rows have `welderConstant = 0`, so this is 0 in practice — but note it is computed even
for subcontractor rows, and `calculateTotals` (§6.1) adds `welderCost` for subcontractor rows while
excluding their `craftCost`.

### 4.6 Material cost — `getMaterialCost` (only for `materialItem`)

```
materialCost = quantity · price · (1 + (materialProfitRate + salesTaxRate)/100)
```

### 4.7 Equipment cost — `getEquipmentCost` (only for `equipmentItem`)

```
if equipmentOwnership == 'Owned':
    equipmentCost = quantity · time · price                       // no profit, no tax
else:                                                             // 'Rental' or 'Purchase'
    equipmentCost = quantity · time · price · (1 + (equipmentProfitRate + useTaxRate)/100)
```

`price` is looked up from the embedded `Equipment` snapshot by unit: `Hours→hourRate`,
`Days→dayRate`, `Weeks→weekRate`, `Months→monthRate`, anything else → `0`. For `Purchase` ownership
the unit is forced to `EA` (and `price` becomes 0 unless typed in), for `Owned`/`Rental` it is
forced to `Months` when switching away from `Purchase` (`updateEquipmentOwnershipInFirestore`,
`src/newAPI/api.ts:346`).

### 4.8 Subcontractor cost — `getSubcontractorCost` (only for `subContractorItem`)

Inputs `craftCost`, `materialCost`, `equipmentCost` are **user-typed per-unit** figures stored on
the activity doc.

```
p  = subContractorProfitRate / 100
st = salesTaxRate / 100

subContractorCost = quantity · [ craftCost    · (1 + p)
                               + materialCost · (1 + p + st)
                               + equipmentCost· (1 + p) ]
```

`useTaxRate` is destructured in this function and **never used** (dead variable at
`src/api/totals.ts:106`).

### 4.9 Cost-only cost — `getCostOnlyCost` (only for `costOnlyItem`)

```
costOnlyCost = quantity · price          // no profit, no tax, no burden
```

### 4.10 Activity total — `getTotalCost`

```
if activityType ≠ subContractorItem:
    totalCost = craftCost + welderCost + materialCost + equipmentCost
              + subContractorCost + costOnlyCost
else:
    totalCost = subContractorCost        // craft/material/equipment inputs are NOT added
```

(The `else` branch is applied in `processRawActivity`, not inside `getTotalCost`.)

### 4.11 Full expansion by activity type

Let `q` = quantity, `cc` = craftConstant, `wc` = welderConstant, `CB` = effective craft base rate,
`SUB` = effective subsistence, `WB` = weldBaseRate, `R` = rigRate, `rp` = rigProfitRate/100.

**laborItem / customLaborItem**

```
total = q·cc·[CB·(1+S) + SUB]  +  q·wc·[WB·(1+S) + subsistenceRate + R·(1+rp)]
```

**materialItem**

```
total = q·price·(1 + (materialProfit + salesTax)/100)     + craftCost + welderCost
```

(craft/welder terms are non-zero only if someone typed constants onto a material row — possible in
principle, blocked by the editable-cell whitelist in practice.)

**equipmentItem, Rental/Purchase**

```
total = q·time·price·(1 + (equipmentProfit + useTax)/100)
```

**equipmentItem, Owned**

```
total = q·time·price
```

**costOnlyItem**

```
total = q·price
```

**subContractorItem**

```
total = q·[ craftCost·(1+p) + materialCost·(1+p+st) + equipmentCost·(1+p) ]
```

---

## 5. The 6 activity types and their distinct math

`ActivityType` (`src/models/activity.ts:138`):

| Type                | Origin                                                                                         | Fields the user edits                                                          | Cost path                                               | Editable cells (`columns.tsx`)                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `laborItem`         | Add Activity dialog, picked from the labor constants library for the phase's `phaseDatabaseId` | quantity, unit, craftConstant, welderConstant, description                     | craft + welder loaded rates                             | `rowId, description, quantity, unit, craftConstant, welderConstant`                |
| `customLaborItem`   | Quick-add "Custom Labor"                                                                       | same as labor, but no `constant` snapshot; craft/welder constants start at 0   | identical to `laborItem`                                | same as `laborItem`                                                                |
| `materialItem`      | Quick-add "Material"                                                                           | quantity, price, unit, description                                             | `getMaterialCost`                                       | `rowId, description, quantity, price, unit`                                        |
| `equipmentItem`     | Add Equipment dialog, picked from the equipment library                                        | quantity, price, time (duration), unit (Hours/Days/Weeks/Months/EA), ownership | `getEquipmentCost`, branch on ownership                 | `rowId, description, quantity, price, time, unit, equipmentOwnership`              |
| `costOnlyItem`      | Quick-add "Cost Only"                                                                          | quantity, price, description                                                   | `getCostOnlyCost`                                       | `rowId, quantity, description, price`                                              |
| `subContractorItem` | Quick-add "Subcontractor" (unit defaults to `'HOURS'`)                                         | quantity, time, unit, craftCost, materialCost, equipmentCost                   | `getSubcontractorCost`; craftCost is **not** recomputed | `rowId, quantity, description, time, unit, equipmentCost, materialCost, craftCost` |

Only `laborItem` and `customLaborItem` differ in _provenance_, not in math. The real branches are:
labor-ish / material / equipment(×2 ownership branches) / cost-only / subcontractor — **7 distinct
cost paths** behind 6 type names.

Auto column visibility (`activity_data_grid.tsx`, `AUTO_VISIBILITY_FIELDS`) turns on `price`,
`time`, `equipmentOwnership`, `equipmentCost`, `materialCost`, `costOnlyCost`, `subContractorCost`
based on which types exist in the phase, layered over a per-WBS baseline
(`ACTIVITY_BASELINE_VISIBILITY`, e.g. WBS 20000 SITE PREPARATION hides all welder columns).

---

## 6. Rollup: Activity → Phase → WBS → Proposal

All of this happens in `estimatorStore.loadFullProposalData` (`src/utils/store.ts:105`).

### 6.1 Activity → Phase — `calculateTotals(activities)` (`src/utils/utils.ts:280`)

```
costOnlyCost      = Σ a.costOnlyCost                                  (all types)
subContractorCost = Σ a.subContractorCost                             (all types)
materialCost      = Σ a.materialCost      where a.type ≠ subContractorItem
equipmentCost     = Σ a.equipmentCost     where a.type ≠ subContractorItem
craftCost         = Σ a.craftCost         where a.type ≠ subContractorItem
welderCost        = Σ a.welderCost                                    (all types) ← asymmetry
craftManHours     = Σ a.craftManHours                                 (all types)
welderManHours    = Σ a.welderManHours                                (all types)
totalCost         = Σ a.totalCost                                     (all types)
```

The subcontractor exclusions exist so the sub's per-unit craft/material/equipment inputs are not
double-counted into the phase's own craft/material/equipment buckets. `welderCost` was left out of
that guard — harmless today (sub rows have `welderConstant = 0`) but structurally wrong.

Then in the store:

```
phase.quantity = phase.customQuantity ?? getQuantityAndUnit(phaseActivities, wbsDatabaseId).quantity
phase.unit     = phase.unit          ?? getQuantityAndUnit(phaseActivities, wbsDatabaseId).unit
phase.craftManHours  = (phase.craftManHours  truthy && numeric) ? phase.craftManHours  : totals.craftManHours
phase.welderManHours = (phase.welderManHours truthy && numeric) ? phase.welderManHours : totals.welderManHours
```

⚠ Note `phase.unit ?? …` here (not `customUnit`) — divergent from `api/phase.ts` and from the Data
Dump, both of which prefer `customUnit`. See §9.4.

⚠ Note the man-hour guard: a _stored_ `craftManHours` on the phase doc silently wins over the
computed sum. `recalculatePhase` (the incremental path used after every edit) has **no such guard**
— so a phase with a stale stored value shows one number after a reload and a different number after
an edit.

### 6.2 Phase → WBS — `calculateWbsTotals(phases)` (`src/utils/utils.ts:331`)

Straight sums of
`costOnlyCost, subContractorCost, materialCost, equipmentCost, craftCost, welderCost, craftManHours, welderManHours, totalCost, quantity`;
`unit` is carried as `''`.

Then in the store the quantity/unit is **overwritten** and re-derived from the WBS's _activities_,
not from its phases:

```
wbs.quantity  = wbs.customQuantity ?? getQuantityAndUnit(activitiesOfThisWbs, wbsDatabaseId).quantity
wbs.unit      = wbs.customUnit     ?? getQuantityAndUnit(activitiesOfThisWbs, wbsDatabaseId).unit
wbs.completed = relatedPhases.length > 0 && relatedPhases.every(p => p.completed)
```

⚠ Because the WBS quantity is re-derived from raw activities, **per-phase `customQuantity` overrides
are ignored at the WBS level**. The dead `useWbs` hook had explicit logic for this (sum the custom
quantities of overridden phases + infer from the remaining activities); the live store dropped it.
This is a silent behavioural regression.

⚠ `calculateWbsTotals`'s `quantity` accumulation is therefore dead code.

### 6.3 WBS → Proposal

**There is no proposal-level rollup in the store.** Proposal totals exist in exactly two places:

1. **Bottom Panel** (`src/components/bottom_pannel.tsx`) — recomputed from whichever slice matches
   the route, over only _visible_ WBS:

   ```
   INDIRECT_WBS_IDS = {10000 MOBILIZE, 190000 DEMOBILIZE, 200000 SUPPORT, 180000 SPECIALTY SERVICES}

   for each record in dataset:
       totalCost += r.totalCost;  craftCost += r.craftCost;  welderCost += r.welderCost
       subcontractorCost += r.subContractorCost;  equipmentCost += r.equipmentCost
       materialCost += r.materialCost;  costOnlyCost += r.costOnlyCost
       if r.activityType == subContractorItem:  subcontractorHours += r.quantity · r.time
       hours = r.craftManHours + r.welderManHours
       if wbsDbId ∈ INDIRECT_WBS_IDS:  bucket into mobe/demobe/support/specialty
       else: directCraftHours += r.craftManHours ; directWelderHours += r.welderManHours

   totalHours = directHours + indirectHours
   ```

   Displayed: Total Cost, Total Hrs, Direct, Indirect, Sub Hrs; expandable panel shows Craft /
   Welder / Support / Mobe+Demobe / Specialty / Subcontractor hours, and Craft / Weld&Rig /
   Subcontractor labor costs, and Equipment / Material / Cost Only. A "Hidden WBS data" warning chip
   appears when a WBS excluded by `wbsToDisplay` has non-zero `totalCost` or hours.

   ⚠ `subcontractorHours = quantity × time` appears **nowhere else** — it is a Bottom-Panel-only
   metric and it is not in the export.

2. **Data Dump summary row** (`createSummaryRow`, `src/api/data_dump.ts:897`) — sums the
   already-rounded WBS-level values.

The `Proposal` model's `totalCost`/`craftManHours`/etc. fields are never written.

### 6.4 Incremental recompute — `recalculatePhase(phaseId)` (`src/utils/store.ts:196`)

Called after: add activities, add equipment, delete activities, reset constants, edit any activity
cell, change equipment unit, change ownership, edit base rates, copy activities from phase.
Recomputes **only that phase's** totals + quantity/unit. Does **not** touch WBS totals. WBS numbers
on the Proposal screen therefore only refresh on `loadFullProposalData` (proposal screen mount, or
the drawer's manual refresh button).

---

## 7. Quantity & unit inference (`getQuantityAndUnit`, `src/utils/utils.ts:198`)

This is a hard-coded keyword heuristic, not a data-model concept.

```
keywordMap:
  20000 SITE PREPARATION      → ['EXCAVATE', 'BACKFILL / COMPACT']
  40000 TOWERS/VESSELS/EQUIP  → ['CLEAN UP']
  50000 PUMPS & DRIVERS       → ['CLEAN UP']
  60000 STRUCTURAL            → ['CLEAN UP']
  70000 AG PIPING             → ['HE']
  130000 BG PIPING            → ['HE']
  (commented-out variants add 'OFF', 'HYDRO', 'PNEU' to 70000/130000)
```

Algorithm:

- **If `wbsDatabaseId === 30000` (CONCRETE)** — special case:
  - `unit` is set on _every_ iteration: `'EA'` if
    `activity.constant.phaseDatabaseId ∈ {30011, 30012, 30013, 30015}`, else `'CY'`. **Last activity
    wins.**
  - `quantity += activity.quantity` only when `description` matches `/clean\s*up/i`.
- **Otherwise** — for each activity whose UPPER-CASED description `.includes()` any keyword:
  `quantity += activity.quantity` and `unit = activity.unit` (**last match wins**).
- **All other WBS (10000, 80000, 90000, 100000, 110000, 120000, 140000, 150000, 180000,
  190000, 200000)** get `quantity = 0, unit = ''`.

The live function also `console.log(quantity, unit)` on every call.

There are **four divergent copies** of this heuristic:

1. `src/utils/utils.ts::getQuantityAndUnit` — LIVE (has the CONCRETE clean-up sum).
2. `src/utils/utils.ts::getDDQuantityAndUnit` — LIVE, used only by the export; operates on
   `DataDumpActivity` and **has no CONCRETE branch at all** ⇒ concrete phases export with a blank
   unit and quantity 0 unless overridden.
3. `src/api/activity.ts::getQuantityAndUnit` — dead; runs the keyword loop first (so CONCRETE
   quantity is always 0) then a second loop that only sets the unit.
4. `src/api/wbs.ts::getQuantityAndUnitForWbs` — dead; a fixed unit map
   `{20000:'CY', 30000:'CY', 40000:'TON', 50000:'EA', 60000:'TON', 70000:'LF', 130000:'LF'}` and
   sums phase quantities whose unit matches.

The dead `useWbs` hook used a fifth variant of that unit map (missing `30000`).

---

## 8. v1 vs v2 datasets

`src/data/dataset_types.ts`:

```
DataVersion = 'v1' | 'v2'
DataType    = 'labor' | 'phases' | 'wbs' | 'equipment'
DATA_VERSION_ORDER  = ['v1','v2']
DEFAULT_DATA_VERSION = 'v1'      // fallback for proposals with no datasetVersions
CURRENT_DATA_VERSION = 'v2'      // stamped on new proposals
```

`src/data/datasets.ts` holds the registry:

| Type        | v1                     | v2                     | Records       |
| ----------- | ---------------------- | ---------------------- | ------------- |
| `labor`     | `v1/labor_v1.json`     | `v2/labor_v2.json`     | 5 897 → 5 968 |
| `phases`    | `v1/phases_v1.json`    | **absent**             | 228           |
| `wbs`       | `v1/wbs_v1.json`       | **absent**             | 18            |
| `equipment` | `v1/equipment_v1.json` | `v2/equipment_v2.json` | 129 → 133     |

`resolveDatasetVersion(type, preferred)` walks _backwards_ through `DATA_VERSION_ORDER` from the
preferred version until it finds a dataset that exists — so a v2 proposal transparently gets v1
phases and v1 WBS. `getProposalDatasetVersions(proposal)` validates each stored version string and
falls back to `'v1'` per-type.

**Why v2 exists / what actually changed** (measured by diffing the JSON):

- **Labor**: 5 763 rows are common (keyed on `phaseDatabaseId` + `description`). 134 rows exist only
  in v1, 205 only in v2 — i.e. v2 is mostly _renames and additions_, and one `phaseDatabaseId`
  disappeared (171 distinct in v1 → 170 in v2).
- Of the 5 763 common rows, **exactly one constant changed**: `phaseDatabaseId 30012, "REBAR"` —
  `craftConstant 0.55 → 8` (units stay `EA`). That is a 14.5× labor increase on rebar, applied only
  to proposals stamped v2. Nothing in the UI surfaces this.
- **Equipment**: 51 descriptions only in v1, 55 only in v2 — largely renames
  (`AIR TOOLS - AIR COMPRESSOR 0-185 CFM` → `AIR TOOLS - COMPRESSOR 0-185 CFM`). 5 rate changes on
  descriptions common to both (`MONITORS - H2S PERSONAL`, `MONITORS - 4 GAS PERSONAL`,
  `MISC - **TUBE TESTING / REPAIR TOOLS`, `MONITORS - 4 GAS AREA`, `MONITORS - 6 GAS PERSONAL`).

Shape is identical between versions — no schema change, only content:

- labor row:
  `{id, phaseDatabaseId, description, sortOrder, craftConstant, craftUnits, weldConstant, weldUnits}`
- equipment row: `{id, description, hourRate, dayRate, weekRate, monthRate}`
- phase row: `{wbsDatabaseId, phaseDatabaseId, description}`
- wbs row: `{id, name}`

**Crucially, dataset version only affects the _picker_.** Once an activity is created, the
`constant`/`equipment` snapshot and the `craftConstant`/`price` scalars are frozen on the activity
doc. Bumping a proposal's dataset version does not re-cost existing activities.

The ~1.2 MB labor JSON files are `import`ed statically into the bundle — both v1 and v2, always.

---

## 9. Persistence — every write in the live path

All writes go through `src/newAPI/api.ts` from `estimatorStore`.

### 9.1 Reads

| Function                                | Query                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getSingleProposal({proposalId})`       | `getDoc(proposals/{id})`, then `convertRatesToNumbers` over 24 fields                                 |
| `fetchAllWbsFromFirestore`              | `where('proposalId','==',id)` on `wbs`                                                                |
| `fetchAllPhasesFromFirestore`           | `where('proposalId','==',id)` on `phase`                                                              |
| `fetchAllActivitiesFromFirestore`       | `where('proposalId','==',id)` on `activities`, each mapped through `processRawActivity`               |
| `fetchProposalData`                     | the three above in `Promise.all`                                                                      |
| `fetchProposalPreferencesFromFirestore` | `getDoc(proposal-preferences/{proposalId})`; returns `{id, wbsToDisplay: []}` if absent               |
| `useProposals()`                        | `onSnapshot(collection('proposals'))` — **the entire proposals collection, live**, on the home screen |

There is **no pagination and no server-side aggregation anywhere.** A proposal with 10 000
activities pulls 10 000 docs and runs 10 000 `processRawActivity` calls on the UI thread before the
first pixel of the WBS grid renders.

### 9.2 Proposal writes

- `insertProposal(description, number)` → `addDoc(proposals)` with **all 15 rates = 0**, then
  `insertAllBaseWbs(docRef.id, datasetVersions)`. ⚠ `insertAllBaseWbs` does
  `wbsData.forEach(async wbs => { await insertBaseWbs(...) })` — the `await` in `insertProposal`
  resolves before any WBS doc is written. Race. ⚠ No `proposal-preferences` doc is created here; it
  is lazily created by `useProposalPreferences` (mounted by `wbs_data_grid.tsx`) with
  `wbsToDisplay: []`.
- `updateSingleProposal({proposalId, proposal})` → `setDoc(proposals/{id}, {...proposal})` **without
  `{merge: true}`**. `editData` is the full proposal object read back from `getSingleProposal`, so
  it also writes an `id` field into the document body, and every rate the user touched is written as
  the **raw string from the `TextField`**.

### 9.3 WBS writes

- `insertBaseWbs` → `addDoc(wbs)`.
- `updateWbs(id, field, value)` → `updateDoc`. Uppercases non-numeric strings. **Not reachable from
  the UI** — every column in `wbs_data_grid.tsx` is `editable: false`.

### 9.4 Phase writes

- `insertPhaseToFirestore(newPhase)` → `setDoc(doc(collection('phase')))`, returns the ref.
- `updatePhaseFieldInFirestore(phaseId, field, value)` (**LIVE**):
  ```
  if isNumber(value) and field ∉ {area, quantity, description}:  value = parseFloat(value)
  elif field == 'quantity':  field = 'customQuantity'; value = parseFloat(value) or null
  else: value unchanged
  updateDoc(phase/{id}, {[field]: value})
  ```
  ⚠ The **dead** `api/phase.ts::updatePhase` additionally routes `unit` → `customUnit` and nulls the
  legacy `unit`. The live path does **not** — editing the Units column writes the legacy `unit`
  field directly. Meanwhile `loadFullProposalData` reads `phase.unit ?? inferred`,
  `api/phase.ts::getPhasesForWbs` reads `phase.customUnit ?? phase.unit ?? inferred`, and
  `data_dump.ts` reads `phase.customUnit ?? phase.unit ?? inferred`. Three readers, two writers, two
  fields. The comments in the code claim a migration happens "on the user's next edit" — **it does
  not**, because the migrating writer is dead.
- `deletePhasesInFirestore(phaseIds)` → batch-deletes the phases, then
  `where('phaseId','in',phaseIds)` to delete their activities. ⚠ Firestore `in` is capped at **10
  values** (firebase ^9.10). Selecting 11+ phases and deleting throws, after the phase deletes have
  already been queued into the same batch — the batch never commits, so nothing is deleted, but the
  local store optimistically removes them anyway (the store's `set` runs after `await`, so actually
  it doesn't — the throw propagates unhandled out of the async store action).
- `duplicatePhasesAndActivitiesInFirestore(phaseIds)` → per phase: `getDoc`, new phase ref,
  `batch.set({...oldData, createdAt: new Date()})`, then query its activities and
  `batch.set({...activityData, phaseId: newPhaseRef.id})`. Returns
  `{newPhaseIds, newActivityMappings}`. ⚠ Single 500-op batch — a phase with >~250 activities
  (phase + activities) will exceed it. ⚠ Adds a `createdAt` field that exists in no model.

### 9.5 Activity writes

- `insertActivityBatchToFirestore(activities, proposal)` → one `writeBatch`, each doc gets
  `dateAdded: Date.now()` **overwriting** whatever the caller set, then returns the
  locally-processed `Activity[]` (optimistic — the returned objects are built before the commit
  resolves, though the commit _is_ awaited before return).
- `updateActivityFieldInFirestore(activityId, field, value)`:
  ```
  if field ∈ numberFields:
      if isNaN(parseFloat(value)) or value.trim()===''  → return {success:false, ...}
      value = parseFloat(value)
  updateDoc(activities/{id}, {[field]: value})
  ```
  `numberFields` (`src/utils/utils.ts:388`) =
  `quantity, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate, equipmentCost, materialCost, costOnlyCost, price, time, subContractorCost`.
  ⚠ `value.trim()` throws if `value` is not a string. ⚠ Everything **not** in `numberFields` gets
  `.toUpperCase()` applied by the store before the call — including `unit`. Typing a unit on an
  equipment row yields `MONTHS`, which no longer matches `EquipmentUnit.months === 'Months'`, so
  `updateEquipmentUnitInFirestore` falls through every branch and sets `price = 0`, and the MUI
  `Select` renders out-of-range.
- `updateEquipmentUnitInFirestore({activity, unit})` → writes `{unit, price}` where price comes from
  the embedded `equipment` snapshot; on error returns the _old_ unit/price (silent failure).
- `updateEquipmentOwnershipInFirestore({activity, ownership})` → writes `equipmentOwnership`, then
  forces the unit: `Purchase → (Owned|Rental)` sets unit `'Months'`; `(Owned|Rental) → Purchase`
  sets unit `'EA'`. Silent failure on error.
- `updateSortOrderBatchInFirestore(activities)` → batch `{sortOrder}` updates.
- `resetConstantsBatchInFirestore(ids)` → batch sets
  `craftConstant: null, welderConstant: null, unit: null` so the embedded `constant` snapshot takes
  over again.
- `deleteActivityBatchInFirestore(ids)` → batch delete.
- `updateActivityRatesInFirestore(ids, newBaseRate, newSubsistenceRate)` → batch sets
  `{craftBaseRate, subsistenceRate}`.
- `updateActivitiesBatchInFirestore(updates, proposal)`: chunks updates at 500 and commits each
  chunk, then commits a **stray empty batch**, then re-reads with
  `where('__name__','in', updatedActivityIds)`. ⚠ The read-back `in` clause is capped at 10 —
  changing a phase's catalog phase on a phase with
  > 10 activities throws after the writes have already landed.
- `copyActivitiesFromPhaseToPhaseInFirestore(fromPhaseId, toPhaseId)`:
  ```
  for each activity of fromPhase:
      batch.set(newRef, {...activityData, phaseId: toPhaseId, createdAt: new Date()})
  ```
  ⚠ **`wbsId` is not remapped.** Copying an activity from a phase in one WBS to a phase in another
  WBS leaves the activity pointing at the _source_ WBS. It then rolls up into the wrong WBS in
  `loadFullProposalData` (which groups by `activity.wbsId`) and into the wrong WBS in the Data Dump.
  This is the single most damaging correctness bug found. ⚠ It also does not re-map `constant` to
  the destination phase's `phaseDatabaseId`. The dead `api/phase.ts::copyActivitiesFromPhase` _did_
  do this remap (looking up a constant with the same `description` under the target
  `phaseDatabaseId` and rewriting `craftConstant`, `welderConstant` and `unit`, silently dropping
  activities with no match). The live path lost that behaviour.

### 9.6 Preferences

- `updateProposalPreferencesInFirestore(preferences)` → `setDoc(..., {merge:true})`, debounced 300
  ms via `src/newAPI/debounced.ts`.

### 9.7 Column visibility

- `loadColumnVisibilityModel(userId, phaseId, activities)` /
  `saveColumnVisibilityModel(userId, phaseId, model)` on `visibilityModels/{userId}_{phaseId}`.
  Default map when absent:
  `rowId, description, quantity, unit, craftConstant, welderConstant, craftManHours, welderManHours, welderCost, craftCost, totalCost = true`;
  everything else false; then turned on conditionally per present activity type.

### 9.8 Deletion of a proposal

`deleteProposalAndAssociatedData(proposalId)` (`src/api/proposal.ts:128`) deletes from `activities`,
**`phases`**, and `wbs` by `proposalId`, then `deleteDoc` the proposal.

⚠ **The phases collection is named `phase`, not `phases`.** Every phase document of every deleted
proposal is orphaned in Firestore forever. Also the proposal doc is deleted _before_ the batch
commits, and `proposal-preferences` / `visibilityModels` are never cleaned up.

### 9.9 Server side

`functions/src/index.ts` — one callable, `duplicateProposal` (540 s timeout, 8 GB). It:

- computes the next revision number as `base + 0.1, 0.2, …` by querying
  `proposalNumber >= base && < base + 1`,
- strips a trailing `- Rev N` from the description and appends the new one,
- duplicates the proposal doc, the preferences doc, all WBS (building an id map), all phases
  (remapping `wbsId`), and all activities (remapping `phaseId`, `wbsId`, `proposalId`),
- chunks batch commits at 500 ops.

**No cost calculation exists on the server.** Everything else is client-side.

---

## 10. Ordering, row identity and sorting

- `sortOrder` is a float. New labor activities inherit `constant.sortOrder` (10, 20, 30, …).
  Equipment gets a computed order from `calculateEquipmentSortOrder` (alphabetical insertion:
  midpoint between neighbours, `+100` at the ends, `max(nonEquipment)+1000` if it is the first
  equipment item). Quick-add rows get `sortOrder: null` → the read fallback chain
  `sortOrder ?? constant.sortOrder ?? dateAdded ?? 0` puts them at a huge `Date.now()` value, i.e.
  at the bottom.
- `sortActivitiesWithEquipmentLogic(activities)` (`src/utils/utils.ts:408`): if **any** activity has
  `sortOrder > 0`, sort purely by `sortOrder` (ties broken alphabetically among equipment);
  otherwise partition into non-equipment (by `sortOrder || dateAdded`) followed by equipment
  (alphabetical).
- `rowId` is then assigned `A, B, C…` by position.
- Drag-reorder → `changeActivitySortOrder(activityId, newIndex, phaseId)`:
  ```
  prev = newIndex>0 ? list[newIndex-1].sortOrder : 0
  next = newIndex<len-1 ? list[newIndex+1].sortOrder : prev+2
  moved.sortOrder = prev !== next ? (prev+next)/2 : prev+0.01
  ```
  It **mutates the activity object in place** inside a zustand `set`, then fires
  `updateSortOrderBatchInFirestore(updatedActivities)` **without awaiting it** — a fire-and-forget
  write of the _entire phase's_ sort orders on every drag.
- `changeActivityOrder(activityId, newRowId)` (`src/utils/store.ts:553`) is marked
  `// TODO: COME BACK TO THIS AND FIX` and is genuinely broken: it computes indices against the
  _filtered_ array but then mutates and splices the _unfiltered_ `activities` array using those
  indices, and can index out of bounds. It appears unreachable from the current UI (the grid uses
  `handleRowOrderChangeByRowId` → `changeActivitySortOrder`), but it is still exported on the store.
- `calculateNewSortOrder` in `utils.ts` is a third, unused ordering helper.

---

## 11. The Data Dump export — a second, divergent cost engine

`src/api/data_dump.ts`, entry `fetchDD(proposalId, preferences)`, reachable from **WBS Data Grid
toolbar → Data Dump → WBS Cost Report**. Writes an `.xlsx` via `xlsx-js-style` and the Tauri `save`
dialog, default filename `./{proposalNumber}-WBS-Cost-Report`.

### 11.1 Structure

37 columns. Rows: 7 proposal-info rows, a top-markup label row, a top-markup value row, the header
row, a bottom-markup row, then WBS row → its Phase rows → each phase's Activity rows, then a
grand-total summary row. Merges A?:AK? for the proposal-info block.

Header columns:
`WBS, PHASE, SIZE, FLC, LINE / DESCRIP, SPEC, INSUL, INSL. SIZE, SHT, AREA, STATUS, SYS, SPCL RATE, SPCL SUB, OWNERSHIP, QTY, UNIT, CRAFT, WELD, SUB, TOTAL, BASE, BURDEN, OVERHEAD, LABOR PROFIT, FUEL, CNSMBLE, SUBSIST, LABOR, RIGS, MATERIAL, EQUIP, SUBS, COST ONLY, PROFIT TOTAL (R/M/E/S), SALES TAX, TOTAL`

Markup cells written from the proposal: `rigRate` and `useTaxRate` in the top row;
`weldBaseRate, craftBaseRate, burdenRate, overheadRate, laborProfitRate, fuelRate, consumablesRate, subsistenceRate, rigProfitRate, materialProfitRate, equipmentProfitRate, subContractorProfitRate, salesTaxRate`
in the bottom row.

### 11.2 The export's per-activity math (`activityToDataDumpItem`)

Component-decomposed rather than loaded-rate-based:

```
craftBase   = (customCraftRate ?? craftBaseRate)·craftManHours  +  weldBaseRate·welderManHours
burden      = burdenRate/100      · craftBase
overhead    = overheadRate/100    · craftBase
laborProfit = laborProfitRate/100 · craftBase
fuel        = fuelRate/100        · craftBase
consumables = consumablesRate/100 · craftBase
subsistence = (craftManHours + welderManHours) · (customSubsistenceRate ?? subsistenceRate)
rig         = rigRate · welderManHours
laborCost   = craftBase + burden + overhead + laborProfit + fuel + consumables + subsistence

materialCost  = (type==material)  ? quantity·price          : 0     // RAW, no profit/tax
equipmentCost = (type==equipment) ? quantity·time·price     : 0     // RAW, no profit/tax
subCost       = (type==sub)       ? round(quantity·(craftCost + equipmentCost + materialCost)) : 0

profitTotal = materialProfitRate/100·materialCost
            + rigProfitRate/100·rig
            + equipmentProfitRate/100·equipmentCost
            + subContractorProfitRate/100·subCost
salesTax    = materialCost·salesTaxRate/100 + equipmentCost·useTaxRate/100

total = isOwnedEquipment ? equipmentCost
      : round(laborCost + rig + materialCost + equipmentCost + subCost
              + costOnlyCost + profitTotal + salesTax)
```

Every field is passed through `currencyRound(n) = parseFloat((Math.round(n·100)/100).toFixed(2))`.

### 11.3 Reconciliation vs. the in-app engine

| Type                       | Agrees?                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| labor / customLabor        | ✅ algebraically identical **unless** a per-activity `subsistenceRate` override exists |
| material                   | ✅ `q·p·(1 + (matProfit+salesTax)/100)`                                                |
| equipment, rental/purchase | ✅ `q·t·p·(1 + (equipProfit+useTax)/100)`                                              |
| equipment, owned           | ✅ `q·t·p`                                                                             |
| cost only                  | ✅ `q·p`                                                                               |
| **subcontractor**          | ❌ **understated**                                                                     |

**Subcontractor divergence (proven):**

```
app    = q·[craft·(1+p) + material·(1+p+st) + equipment·(1+p)]
export = q·(craft + material + equipment)·(1+p)
delta  = q · material · salesTaxRate/100      ← missing from the export
```

The exported bid sheet under-states every subcontractor line by the sales tax on the sub's material
component.

**Subsistence divergence (proven):**

```
app    subsistence = craftMH·(custom ?? proposal) + welderMH·proposal
export subsistence = (craftMH + welderMH)·(custom ?? proposal)
```

Identical when no override exists; different on any activity where the estimator used the "Edit
Rates" dialog on a row that has welder hours.

**Rounding divergence:** the export rounds _every activity field_ to 2 dp and then sums the rounded
values up through phase → WBS → summary. The app sums unrounded values. On a 5 000-line estimate the
accumulated difference is real (up to ~$25 at ±$0.005/line) and always shows up as "the Excel
doesn't tie to the screen".

### 11.4 Other export defects

- `getSubProfit()` (`data_dump.ts:540`) is defined and **never called**. It also contains
  `materialProfit = baseActivity.craftCost · (subProfit + salesTax)` — using `craftCost` where
  `materialCost` was clearly intended.
- `fetchDDWbs` reads `curr.quantity` / `curr.unit` straight off the raw `wbs` document. Those fields
  are **never persisted** (`FirestoreWbs` has only `customQuantity` / `customUnit`), so **every WBS
  row in the export has a blank QTY and UNIT**.
- `fetchDDWbs`'s sort comparator is `const first = a.data(); const second = a.data();` — compares
  `a` to `a`, so the sort is a no-op. (A later `wbs.sort((a,b) => a.wbs! - b.wbs!)` in `fetchDD`
  saves it.)
- `fetchDDPhases` calls `getSingleWbs(phase.wbsId)` **once per phase** — a live N+1 read against
  Firestore during export.
- `getDDQuantityAndUnit` has no CONCRETE (30000) branch, so concrete phases export blank.
- The module-level style/row arrays (`topMarkups`, `bottomMarkups`, `proposalInfo1..7`) are
  `let`-declared singletons that `fetchDD` **mutates in place**. Exporting a second proposal in the
  same session starts from the previous proposal's values (harmless only because every mutated cell
  is unconditionally overwritten).
- `dollarFormatCells` is declared and never used.
- The Tauri `save()` / `writeBinaryFile` imports are from `@tauri-apps/api` v1 — the export only
  works in the desktop shell, not the browser build.

---

## 12. UX problems observed (with evidence)

1. **Editing a proposal rate silently re-prices the entire estimate, including "completed" phases.**
   There is no versioning, no snapshot, no confirmation beyond a success `Alert`. Evidence:
   `processRawActivity` recomputes from `proposal` on every read; `proposal_home.tsx:65`
   `handleSaveClick` → `updateSingleProposal` → `loadFullProposalData`.

2. **Rates are written to Firestore as strings.** `handleChange` in `proposal_home.tsx` stores
   `e.target.value` verbatim; `updateSingleProposal` does `setDoc` without merge. The system only
   works because `getSingleProposal` runs `convertRatesToNumbers` over 24 fields on read
   (`src/api/proposal.ts:40`). Any future read path that forgets this gets `"45.5" + 45.5*0.9` →
   string concatenation. Two existing paths already skip it (`current_proposal_listener_hook.ts`,
   `activity_hook.ts`) — both currently dead.

3. **A brand-new proposal is unusable and looks broken.** All 15 rates default to `0`
   (`FirestoreProposal` constructor) and `wbsToDisplay` defaults to `[]`
   (`proposal_preferences.ts::insertProposalPreferences` builds a full name array and then throws it
   away, passing `wbsToDisplay: []`). The user sees an empty WBS grid and $0 totals with no
   explanation. Nothing prompts them to set rates or pick WBS.

4. **The proposal edit form is all-or-nothing modal editing.** `isEditMode` is a single boolean
   shared by the Details tab and the Rates tab; pressing _Edit_ flips ~30 fields into text inputs
   simultaneously; _Save_ writes the whole document; _Cancel_ discards everything. No per-field
   editing, no dirty indicator, no validation, no keyboard save. Non-numeric input in a rate field
   is accepted and stored.

5. **Blocking save + full reload after every proposal save.** `await updateSingleProposal` then
   `await loadFullProposalData` — a full re-fetch and full re-computation of every activity in the
   proposal, behind a modal success dialog.

6. **Everything is recomputed on the client, on the main thread.** `fetchAllActivitiesFromFirestore`
   maps `processRawActivity` over every activity in the proposal; `loadFullProposalData` then does
   two more full passes (phases, WBS) plus a `getQuantityAndUnit` call _per phase, twice_ (once for
   quantity, once for unit — the function is invoked twice with identical arguments at
   `store.ts:141` and `store.ts:145`, and again twice in `recalculatePhase` at `store.ts:231`/`235`
   after already being called at `store.ts:220`).

7. **`console.log` in the hot path.** `getQuantityAndUnit` logs on every invocation;
   `store.updateActivity` logs every edit; `recalculatePhase` logs `'QUANTITY'`;
   `activity_data_grid` logs `'HERE'` and dumps arrays on phase-database change.

8. **Live N+1 during export.** `fetchDDPhases` issues one `getSingleWbs` per phase. The dead
   `useWbs`/`getPhasesForWbs` path was worse — `getActivitiesForPhase` calls `getSingleProposal`
   _per phase_, so rendering a WBS with 40 phases meant 40 proposal reads.

9. **The whole `proposals` collection is live-subscribed on the home screen**
   (`hooks/proposals_hook.ts`), with no pagination, no filter, no limit.

10. **Silent failures.** `updateEquipmentUnitInFirestore` and `updateEquipmentOwnershipInFirestore`
    `catch` and return the _previous_ values — the UI simply doesn't change and no error is
    surfaced. `updateActivityFieldInFirestore` returns `{success:false}` on a non-numeric edit and
    `store.updateActivity` just skips the state update — the cell silently reverts.

11. **Uppercase coercion is applied blindly to every non-numeric string.** `store.updateActivity` /
    `store.updatePhase` / `updateWbs` all do `!numberFields.includes(field) → value.toUpperCase()`.
    This corrupts `unit` values that must match `EquipmentUnit` ('Months' → 'MONTHS'), breaking the
    price lookup and the `Select`.

12. **Two competing sources of truth for phase quantity/unit** (`quantity`/`customQuantity`,
    `unit`/`customUnit`) with three different reader precedences and only one (dead) writer that
    migrates. Comments in `api/phase.ts` and `data_dump.ts` describe a migration that cannot happen.

13. **Changing a phase's catalog phase does not re-cost its activities.** `onChangePhaseDatabase`
    (`activity_data_grid.tsx:626`) updates only the embedded `constant` object, not
    `craftConstant`/`welderConstant`/`unit` — and `processRawActivity` reads the scalars first
    (`craftConstant ?? constant.craftConstant`). The estimator sees the constant "change" in the
    data and the hours not move. The only workaround is the separate "Reset Constants" toolbar
    action, which is not discoverable and destroys custom overrides.

14. **`recalculatePhase` doesn't recalculate the WBS.** WBS-level numbers on the Proposal screen go
    stale after any edit until the user navigates back to the proposal (which triggers a full
    reload) or hits the drawer's refresh.

15. **Phase-level `customQuantity` overrides are ignored in the WBS rollup** (§6.2).

16. **The quantity/unit heuristic is invisible magic.** Whether a phase gets a quantity at all
    depends on whether an activity's description happens to contain `'HE'` or `'CLEAN UP'`. `'HE'`
    as a substring matches any description containing those two letters (`SHEET`, `THREAD`, …). 11
    of 18 WBS divisions can never produce a quantity.

17. **Fire-and-forget writes on drag-reorder.** `changeActivitySortOrder` mutates state in place and
    calls `updateSortOrderBatchInFirestore` without `await` and without error handling, rewriting
    the sort order of every activity in the phase.

18. **Hidden-data warning as a band-aid.** The Bottom Panel has an explicit "Hidden WBS data"
    warning chip because WBS visibility is a preference that silently removes cost from the
    displayed totals — an admission that the visibility model is confusing.

19. **`bottom_pannel.tsx`** — the filename typo is shipped, and it re-implements totals a third time
    with its own direct/indirect classification that exists nowhere else.

---

## 13. Dead or broken code found

### Dead (zero live importers)

- `src/utils/calculations.ts` — entire file. Duplicate engine with a **different** welder formula.
- `src/stores/activity_store.ts`, `phase_store.ts`, `wbs_store.ts`, `proposal_store.ts`,
  `preference_store.ts` — all five zustand stores.
- `src/hooks/activity_hook.ts` (`useActivities`), `phase_hook.ts` (`usePhases`), `wbs_hook.ts`
  (`useWbs`), `rates_hook.ts` (`useLoadedRates`).
- `src/hooks/current_proposal_listener_hook.ts` — only the two dead accordions consume it.
- `src/features/proposal home/components/proposal_info_accordion.tsx` and
  `proposal_rates_accordion.tsx` — the old accordion UI, never rendered.
- `src/features/phase home/components/columns.tsx::getActivityColumns` — superseded by
  `columns2.tsx`.
- `src/api/activity.ts`: `insertActivityBatch`, `updateActivity`, `updateActivitiesBatch`,
  `addCustomLabor`, `addCostOnly`, `addMaterial`, `addSubcontractor`, `deleteActivityBatch`,
  `resetConstantsBatch`, `changeActivityOrder`, `updateEquipmentUnit`, `updateEquipmentOwnership`,
  `updateActivityRates`, `getActivitiesForWbs`, `getQuantityAndUnit`, plus ~60 lines of
  commented-out `insertActivitiesFromFile`.
- `src/api/phase.ts`: `insertPhase`, `getSinglePhase`, `updateSingleProposal` (duplicate),
  `updatePhase`, `deletePhaseBatch`, `duplicatePhases`, `copyActivitiesFromPhase`,
  `getPhasesForWbs`, `guid()`, `interface Costs`.
- `src/api/wbs.ts::getQuantityAndUnitForWbs`.
- `src/api/proposal.ts::updateProposalField`, plus ~50 lines of commented-out
  `duplicateProposalAndAssociatedData`.
- `src/newAPI/api.ts::duplicateProposal` (the UI uses the Cloud Function),
  `fetchCollectionCountsClient`.
- `src/utils/utils.ts::calculateNewSortOrder`; the 70-line commented-out `processRawActivity` at the
  top of the file.
- `src/models/firestore models/activity_firestore.ts`: `baseCustomLabor`, `baseCostOnly`,
  `baseMaterial`, `baseSubcontractor` template objects.
- `src/models/proposal.ts`: the 13 rollup fields on `Proposal`; `customQuantity`/`customUnit` on
  `FirestoreProposal`.
- `src/models/wbs.ts`: commented-out `WbsEnum`.
- `data_dump.ts`: `getSubProfit()`, `dollarFormatCells`, `interface UseActivitiesOptions`.
- `api/totals.ts::getSubcontractorCost`: `useTaxRate` destructured, never used.

### Broken / incorrect

| #   | Location                                                        | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `newAPI/api.ts:222` `copyActivitiesFromPhaseToPhaseInFirestore` | Does not remap `wbsId` → copied activities roll up under the source WBS. Also does not remap `constant` to the target `phaseDatabaseId`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B2  | `api/proposal.ts:135`                                           | `deleteAssociatedData('phases', …)` — collection is `phase`. Every phase doc of a deleted proposal is orphaned.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B3  | `api/totals.ts:26-27`                                           | `customCraftBaseRate \|\| craftBaseRate` — an explicit override of `0` is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B4  | `api/totals.ts:44` `getWelderLoadedRate`                        | Uses proposal `subsistenceRate` unconditionally; per-activity subsistence overrides never reach welder hours. Diverges from the export.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B5  | `data_dump.ts:576`                                              | Subcontractor total omits sales tax on the sub's material component. Export ≠ screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B6  | `data_dump.ts:506-507`                                          | WBS `quantity`/`unit` read from fields that are never persisted → always blank.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B7  | `data_dump.ts:434-437`                                          | Sort comparator compares `a.data()` to `a.data()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B8  | `newAPI/api.ts:160` / `:589`                                    | `where(..., 'in', […])` with unbounded arrays; Firestore caps `in` at 10. Breaks deleting >10 phases and re-costing a phase with >10 activities.                                                                                                                                                                                                                                                                                                                                                                                                            |
| B9  | `newAPI/api.ts:176`                                             | `duplicatePhasesAndActivitiesInFirestore` uses one 500-op batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| B10 | `newAPI/api.ts:274`                                             | `value.trim()` on a possibly-non-string value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B11 | `utils/store.ts:553` `changeActivityOrder`                      | Marked `TODO: COME BACK TO THIS AND FIX`; mixes indices from the filtered array with mutations on the unfiltered array; can index out of bounds.                                                                                                                                                                                                                                                                                                                                                                                                            |
| B12 | `utils/store.ts:131-138` vs `:226-237`                          | `loadFullProposalData` lets a stored `craftManHours`/`welderManHours` on the phase doc win over the computed sum; `recalculatePhase` does not. Same phase shows different hours before and after an edit.                                                                                                                                                                                                                                                                                                                                                   |
| B13 | `utils/store.ts:141` / `:170`                                   | `wbsLookup[wbsId].wbsDatabaseId!` — throws if a phase references a deleted/missing WBS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B14 | `utils/store.ts:447-490`                                        | `updateActivity` spreads the computed `Activity` back into `processRawActivity` as if it were a `FirestoreActivity`. `craftBaseRate`/`subsistenceRate` are then non-null, so `customCraftRate`/`customSubsistenceRate` become populated with proposal defaults. Costs are unaffected, but the "does this row have a special rate" signal (used by the Edit Rates dialog gating and the export's SPCL RATE column) drifts until the next reload. Same pattern in `resetConstants`, `updateActivityRates`, `updateEquipmentUnit`, `updateEquipmentOwnership`. |
| B15 | `store.updateActivity` / `updatePhase` / `updateWbs`            | Blind `.toUpperCase()` on non-numeric fields corrupts `unit` (`'Months'` → `'MONTHS'`) and would corrupt `equipmentOwnership` if it ever routed through there.                                                                                                                                                                                                                                                                                                                                                                                              |
| B16 | `api/proposal.ts:23` `insertProposal`                           | `insertAllBaseWbs` uses `forEach(async …)` — the awaited call resolves before the 18 WBS writes complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B17 | `api/proposal_preferences.ts:9-14`                              | Builds `tempArray` of all WBS names, then writes `wbsToDisplay: []`. Obvious intent-vs-code mismatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B18 | `proposal_home.tsx:34`                                          | `state.preferences[proposalId] \|\| []` — falls back to an **array** where a `ProposalPreferences` object is expected; `SelectWbsDialog` then calls `setChecked(undefined)` and `checked.includes` throws.                                                                                                                                                                                                                                                                                                                                                  |
| B19 | `api/phase.ts` comments + `data_dump.ts` comments               | Both claim `updatePhase` migrates legacy `unit` into `customUnit` "on the user's next edit". The live writer (`updatePhaseFieldInFirestore`) does no such thing.                                                                                                                                                                                                                                                                                                                                                                                            |
| B20 | `utils/calculations.ts:58-65` (dead)                            | `getWelderLoadedRate` folds `rigProfitRate` into the wage multiplier — a materially different formula from the live one.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B21 | `proposal_home.tsx:47`                                          | `const craftLoadedRate = getCraftLoadedRate(...)` computed and discarded inside a `useEffect`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B22 | `newAPI/api.ts:568,583`                                         | `updateActivitiesBatchInFirestore` creates an outer `batch`, never adds anything to it, and commits it.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B23 | `App.tsx:28-36`                                                 | MUI X Pro license key is **forged at runtime** (`orderNumber = ''`, `expiryTimestamp = Date.now()`, md5+btoa).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B24 | `setup/config/firebase.ts`                                      | Firebase web config, including `apiKey`, is hard-coded in source (not a secret per se, but there is no environment separation — one project for everything).                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 14. PARITY CHECKLIST — every discrete capability Precision must have from this area

### Data model

- [ ] Proposal → WBS → Phase → Activity hierarchy with denormalised parent keys on every level.
- [ ] 18 fixed WBS divisions with stable numeric IDs (10000…200000) and canonical names.
- [ ] Per-proposal WBS visibility list (`wbsToDisplay`), and a way to warn when hidden WBS carry
      cost.
- [ ] Phase descriptors: `phaseNumber`, `description`, `size`, `flc`, `system`, `sys`, `spec`,
      `insulation`, `insulationSize`, `sheet`, `area`, `status`, `completed`.
- [ ] Phase catalog linkage: `phaseDatabaseId` + `phaseDatabaseName` (drives which labor constants
      are offered).
- [ ] Phase quantity/unit with an explicit user override (`customQuantity`/`customUnit`) distinct
      from the inferred value — **one** override field per concept, not two.
- [ ] WBS quantity/unit with an explicit user override.
- [ ] Activity inputs: `quantity`, `unit`, `craftConstant`, `welderConstant`, `price`, `time`,
      `description`, `activityType`, `equipmentOwnership`, `sortOrder`, `dateAdded`.
- [ ] Per-activity `craftBaseRate` and `subsistenceRate` overrides, with `null` meaning "inherit
      from proposal" and `0` meaning **zero** (fix the `||` bug).
- [ ] Embedded (or referenced-and-versioned) snapshot of the labor constant and the equipment item
      used, so historical estimates don't move when the library changes.
- [ ] Subcontractor per-unit `craftCost` / `materialCost` / `equipmentCost` as first-class inputs.
- [ ] Proposal metadata: number, job, CO number, description, owner, estimators, job-site address,
      city, state, dates (received/due/start/end), bid type (6 values), status (8 values), and a
      full contact block (name/address/city/state/zip/phone/email).
- [ ] `datasetVersions` per proposal, per data type, with backwards-compatible resolution.

### The 15 rate fields

- [ ] `craftBaseRate` ($/hr), `weldBaseRate` ($/hr), `rigRate` ($/hr), `subsistenceRate` ($/hr).
- [ ] `burdenRate`, `overheadRate`, `consumablesRate`, `fuelRate` (%).
- [ ] `salesTaxRate`, `useTaxRate` (%).
- [ ] `laborProfitRate`, `materialProfitRate`, `equipmentProfitRate`, `subContractorProfitRate`,
      `rigProfitRate` (%).
- [ ] Numeric storage and numeric validation at the boundary (never strings).
- [ ] Sensible non-zero defaults (or a required setup step) so a new proposal isn't $0.

### Calculation (must move server-side, into `packages/backend/convex/precision.ts`)

- [ ] `craftLoadedRate = craftBase·(1 + (burden+overhead+laborProfit+fuel+consumables)/100) + subsistence`
- [ ] `welderLoadedRate = weldBase·(1 + (burden+overhead+laborProfit+fuel+consumables)/100) + subsistence + rigRate·(1 + rigProfit/100)`
- [ ] `craftManHours = quantity · craftConstant`, `welderManHours = quantity · welderConstant`
- [ ] `craftCost = craftManHours · craftLoadedRate` (all types except subcontractor)
- [ ] `welderCost = welderManHours · welderLoadedRate`
- [ ] `materialCost = quantity · price · (1 + (materialProfit + salesTax)/100)`
- [ ] `equipmentCost = quantity · time · price` when Owned; `× (1 + (equipmentProfit + useTax)/100)`
      when Rental or Purchase
- [ ] `subContractorCost = quantity · [craft·(1+p) + material·(1+p+salesTax) + equipment·(1+p)]`
- [ ] `costOnlyCost = quantity · price`
- [ ] `totalCost = craft + welder + material + equipment + subcontractor + costOnly`, except
      subcontractor rows where `totalCost = subContractorCost`
- [ ] Decide and document **one** rule for whether a per-activity subsistence override applies to
      welder hours (today the app says no, the export says yes).
- [ ] Decide and document **one** rounding policy (today: unrounded on screen, per-line 2-dp in the
      export).
- [ ] Component decomposition available for reporting: base, burden, overhead, labor profit, fuel,
      consumables, subsistence, labor total, rigs, material, equipment, subs, cost only, profit
      total, sales tax, grand total — for every activity, phase, WBS and the proposal.

### Activity types (6, 7 cost paths)

- [ ] `laborItem` — created from the labor constants library, filtered by the phase's catalog phase.
- [ ] `customLaborItem` — same math, no library link, constants start at 0.
- [ ] `materialItem` — quantity × price with material profit + sales tax.
- [ ] `equipmentItem` — from the equipment library; unit ∈ {Hours, Days, Weeks, Months, EA} maps to
      hourRate/dayRate/weekRate/monthRate; ownership ∈ {Rental, Owned, Purchase} with the
      Owned→no-markup rule and the Purchase↔EA / Owned|Rental↔Months unit coupling.
- [ ] `costOnlyItem` — raw pass-through cost.
- [ ] `subContractorItem` — quantity × marked-up per-unit craft/material/equipment; default unit
      `HOURS`; `time` captured for sub man-hour reporting.

### Rollups

- [ ] Activity → Phase: sum of costOnly, subcontractor, material, equipment, craft, welder, craftMH,
      welderMH, total — with the subcontractor double-count exclusion applied **consistently**
      (including welder).
- [ ] Phase → WBS: sums, plus `completed = all phases completed`.
- [ ] WBS → Proposal: a real proposal-level rollup (today it doesn't exist).
- [ ] Direct vs indirect hour classification: indirect = WBS {10000 MOBILIZE, 190000 DEMOBILIZE,
      200000 SUPPORT, 180000 SPECIALTY SERVICES}; buckets for mobe, demobe, support, specialty.
- [ ] Subcontractor hours = `quantity × time`.
- [ ] WBS rollup must honour phase-level `customQuantity` overrides.
- [ ] Rollups recompute at every level after every edit (today only the phase does).

### Quantity / unit derivation

- [ ] Replace the keyword heuristic with something explicit and inspectable, but preserve the
      _outcomes_ estimators depend on: - SITE PREPARATION (20000): sum quantities of EXCAVATE /
      BACKFILL / COMPACT activities. - TOWERS/VESSELS/EQUIPMENT (40000), PUMPS & DRIVERS (50000),
      STRUCTURAL (60000): sum quantities of CLEAN UP activities. - AG PIPING (70000), BG PIPING
      (130000): sum quantities of activities containing "HE". - CONCRETE (30000): sum CLEAN UP
      quantities; unit `EA` for phase-catalog IDs {30011, 30012, 30013, 30015}, else `CY`. - All
      other WBS: no inferred quantity.
- [ ] A per-WBS default unit map is also present in the legacy code
      (`{20000:CY, 30000:CY, 40000:TON, 50000:EA, 60000:TON, 70000:LF, 130000:LF}`) — confirm with
      the estimators which behaviour is correct before porting.
- [ ] Explicit user override always wins, at both phase and WBS level.

### Libraries / datasets

- [ ] Labor constants library: ~5 900 rows keyed `(phaseDatabaseId, description)` carrying
      `sortOrder`, `craftConstant`, `craftUnits`, `weldConstant`, `weldUnits`.
- [ ] Equipment library: ~130 rows with hour/day/week/month rates.
- [ ] Phase catalog: 228 rows mapping `wbsDatabaseId → phaseDatabaseId → description`.
- [ ] WBS catalog: 18 rows.
- [ ] Versioned datasets with per-type fallback (v1 exists for all four types; v2 exists only for
      labor and equipment).
- [ ] Preserve the v1→v2 content deltas (notably `30012 REBAR craftConstant 0.55 → 8`) and make
      version differences visible to the user instead of silent.
- [ ] Datasets must be server-side/queryable, not 1.2 MB JSON blobs bundled into the client.

### Editing operations that must exist

- [ ] Add labor activities: multi-select from the phase's constants list, search, batch insert.
- [ ] Add equipment: multi-select from the equipment list, search, batch insert with alphabetical
      sort-order insertion.
- [ ] Quick-add a Material / Cost Only / Custom Labor / Subcontractor row.
- [ ] Inline-edit the type-specific editable cell sets: - labor/customLabor:
      `rowId, description, quantity, unit, craftConstant, welderConstant` - material:
      `rowId, description, quantity, price, unit` - equipment:
      `rowId, description, quantity, price, time, unit, equipmentOwnership` - cost only:
      `rowId, quantity, description, price` - subcontractor:
      `rowId, quantity, description, time, unit, equipmentCost, materialCost, craftCost`
- [ ] Bulk "Edit Rates" on selected activities (set `craftBaseRate` + `subsistenceRate`), with the
      legacy gating rule (only enabled for `customLaborItem`, or WBS 200000 SUPPORT, or phase
      catalog IDs 180002/180003/180004, and only when all selected rows already share the same
      values).
- [ ] "Reset Constants" — null out `craftConstant`/`welderConstant`/`unit` so the library values
      take over again.
- [ ] Delete selected activities.
- [ ] Re-order activities: drag-and-drop **and** type-a-row-letter (`rowId`) targeting; fractional
      midpoint sort orders.
- [ ] Change a phase's catalog phase and **actually re-apply** the new constants to matching
      activities (the legacy code updates only the embedded snapshot and leaves hours wrong).
- [ ] Add / duplicate / delete phases (duplicating a phase must duplicate its activities).
- [ ] Copy all activities from another phase — **with correct `wbsId` remapping** and with the
      constant remap the dead code intended (match on description under the target
      `phaseDatabaseId`).
- [ ] Mark a phase `completed`; derive WBS `completed` from its phases.
- [ ] Duplicate a whole proposal, including preferences, WBS, phases and activities, with revision
      numbering (`N` → `N.1`, `N.2`, …) and a `- Rev N` description suffix that does not stack.
- [ ] Delete a proposal and **all** associated data (activities, phases, WBS, preferences, per-user
      column-visibility docs).
- [ ] Create a proposal: auto-suggest the next proposal number (max + 1, or 1300 when empty), seed
      all 18 WBS, seed preferences.
- [ ] Per-user, per-phase column-visibility persistence, plus auto-visibility driven by which
      activity types are present and per-WBS baselines (e.g. SITE PREPARATION hides welder columns).
- [ ] Read-only vs read-write permission gating on every mutation and every editable cell.

### Reporting / export

- [ ] The 37-column "WBS Cost Report" data dump: proposal header block, markup header rows, WBS →
      Phase → Activity indented rows, grand-total summary row, with the full component decomposition
      (BASE, BURDEN, OVERHEAD, LABOR PROFIT, FUEL, CNSMBLE, SUBSIST, LABOR, RIGS, MATERIAL, EQUIP,
      SUBS, COST ONLY, PROFIT TOTAL, SALES TAX, TOTAL).
- [ ] SPCL RATE / SPCL SUB columns flagging activities with per-activity rate overrides.
- [ ] Currency and number formatting, `-` for zero/blank, styled headers.
- [ ] **The export must be generated from the same engine as the screen.** Never a second
      implementation.

### Live status bar

- [ ] A persistent totals bar scoped to the current level (proposal / WBS / phase): Total Cost,
      Total Hours, Direct Hours, Indirect Hours, Sub Hours.
- [ ] Expandable breakdown: hours by Craft / Welder / Support / Mobe+Demobe / Specialty /
      Subcontractor; labor costs by Craft / Weld&Rig / Subcontractor; other costs by Equipment /
      Material / Cost Only.
- [ ] Warning when data exists in WBS excluded from the current view.
