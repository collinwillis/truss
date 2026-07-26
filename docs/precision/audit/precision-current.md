# Precision — Current State Audit

**Date:** 2026-07-26 **Scope:** `apps/precision/`, `packages/backend/convex/precision.ts`,
`packages/backend/convex/schema.ts`, `packages/features/src/estimation/` **Method:** Full read of
every source file listed above. Every claim below was verified against source; no doc/README/comment
was trusted on its own. Where legacy behavior is cited, it was verified against
`/Users/collinwillis/Dev/Personal/mcp_estimator/src/utils/calculations.ts` and `src/utils/utils.ts`.

---

## Executive summary

Precision is a **thin, mostly-real skeleton** — about **5,000 lines of frontend across 7 screens**,
backed by **1,749 lines of Convex** (compare: Momentum's backend is 4,695 lines). The server-side
calculation engine is genuinely implemented and is the strongest part of the codebase. The UI is a
working demo, not a tool: you can create an estimate, add phases and activities, and see costs roll
up — but you cannot edit most of the data you just entered.

Three findings dominate:

1. **A real formula bug.** `computeWelderLoadedRate` omits `rigProfitRate` from the weld-base
   markup. The legacy estimator includes it. The code comment claims the opposite ("This matches the
   legacy MCP Estimator exactly") and is wrong. Every welder cost in Precision is understated.
2. **The estimate detail screen writes to records a cron overwrites.** A 6-hourly Firestore→Convex
   sync (`crons.ts` → `sync/syncEngine.syncProposals`) does `ctx.db.patch(existing._id, proposal)`
   on every legacy proposal — full field replacement including `rates`, `description`, `status`,
   `dateDue`. Anything a user types into Precision's Details or Rates tab on a synced proposal is
   silently reverted within 6 hours.
3. **Precision is 3 months stale and forked from Momentum.** Frontend last touched `2026-04-12`
   (`890c6d1 Update`); Momentum `2026-07-13`. Precision's `add-activity-dialog` (621 lines),
   `add-phase-dialog` (221), `admin/index.tsx` (336) and `admin/member.$memberId.tsx` (189) are all
   earlier, cruder forks of Momentum files that have since evolved independently (Momentum's
   add-activity is now 1,001 lines with a materially better interaction model).

The estimate detail screen (`routes/estimate/$estimateId.index.tsx`) is, as Collin says, bad — and
specifically bad for structural reasons documented in the UX section, not just cosmetic ones.

---

## WHAT WORKS TODAY

Verified working end-to-end (UI wired → mutation exists → query recomputes).

### 1. Estimates list — `routes/estimates.tsx` (345 lines)

Route: `/estimates` (also `/` redirects here via `routes/index.tsx`).

**Can do:**

- See all proposals in the deployment via `precision.listProposals` (no cost data — deliberate,
  keeps the list fast).
- Five inline stats: Proposals, In Progress (`bidding` + `open`), Submitted, Awarded, Hit Rate
  (`awarded / (awarded + rejected)`).
- A stacked status-distribution bar; clicking a segment or a legend chip toggles a status filter;
  "Clear filter" resets.
- Free-text search across `description`, `proposalNumber`, `ownerName`, `jobNumber`.
- Rows sorted descending by `parseFloat(proposalNumber)` with a `localeCompare` fallback.
- Due-date coloring: red when overdue and status is `bidding`/`open`; amber when due within 7 days.
- Click a row → navigate to `/estimate/:id`.
- "New Estimate" button → `CreateEstimateDialog`.

**Cannot do:** sort by any other column; multi-select; delete a proposal (`deleteProposal` mutation
exists, no UI); archive; see any dollar value or man-hour count; see the estimator or job number as
a column; paginate or virtualize (renders all rows).

### 2. Create estimate — `components/create-estimate-dialog.tsx` (186 lines)

Collects **five** fields only: `proposalNumber`, `description`, `ownerName`, `datasetVersion`
(v1/v2), `bidType` (optional). Sets `status: "bidding"` and `rates: DEFAULT_RATES`. On success
navigates to the new estimate.

Calls `precision.createProposal`, which additionally **auto-creates one `wbs` row for every active
`wbsPool` entry** for that dataset version (18 rows for v1), with a v2→v1 fallback if the requested
version's pool is empty.

### 3. Estimate detail — `routes/estimate/$estimateId.index.tsx` (607 lines)

Three tabs (`Details`, `Rates`, `WBS`), a header, and a bottom panel. **This is real and it works**,
in the narrow sense that the writes land.

- **Details tab:** `proposalNumber`, `jobNumber`, `changeOrderNumber`, `description`, `ownerName`,
  `estimators` (comma-joined string → array), `jobSiteAddress`, `status` select, `bidType` select,
  `dateReceived`, `dateDue`. Text fields commit on blur through a 400 ms debounce; selects commit
  immediately.
- **Rates tab:** all 15 rate fields, grouped 2×2 into Labor Rates / Overhead & Burden / Profit
  Margins / Tax Rates, driven by `RATE_FIELD_CONFIG` in `@truss/features/estimation/types`. Commits
  the full rates object on blur, 400 ms debounced.
- **WBS tab:** a table of every WBS with `phaseCount`, `activityCount`, `craftManHours`,
  `welderManHours`, `totalCost`, linking to the WBS detail route. Data from
  `precision.getWBSListWithCosts`.
- **Header:** Duplicate button → `DuplicateEstimateDialog`; Export button → generates and downloads
  an `.xlsx`.
- **Bottom panel:** `BottomPanel` fed by `precision.getProposalSummary`, showing total cost, total
  MH, direct/indirect hours, craft/weld split, and an expandable 3-column breakdown (Man-Hours /
  Labor / Other Costs). Expansion state persists in `localStorage` key `precision:bp`.

### 4. WBS detail — `routes/estimate/$estimateId.wbs.$wbsId.tsx` (351 lines)

Route: `/estimate/:estimateId/wbs/:wbsId`. Table of phases from `precision.getPhaseListWithCosts`.

**Can do:** see phase #, description, piping `size`, piping `spec`, item count, craft MH, weld MH,
total cost; completed phases get an emerald row tint and a check icon; multi-select via checkboxes;
**Delete** selected (loops `deletePhase` one at a time); **Duplicate** (only the first selected
phase, via `duplicatePhase` which deep-copies all its activities); **Add Phase** → `AddPhaseDialog`;
click a row → phase detail.

### 5. Add phase — `components/add-phase-dialog.tsx` (221 lines)

Searchable list of `phasePool` entries filtered to the parent WBS's `wbsPoolId` (with v2→v1 fallback
in the query). Selecting one sets `poolName` and pre-fills `description`. Phase number
auto-increments from `max(existing) + 1`. Submits `precision.addPhase`.

### 6. Phase detail / activity grid — `routes/estimate/$estimateId.phase.$phaseId.tsx` (541 lines)

Route: `/estimate/:estimateId/phase/:phaseId`. TanStack Table over
`precision.getActivitiesWithCosts`.

**11 columns:** select checkbox, type (icon + 3-letter abbr), description (editable), qty
(editable), unit (read-only), Craft MH, Weld MH, Craft $, Mat $, Equip $, Sub $, Total.

**Can do:** edit `description` and `quantity` inline via the shared `EditableCell`;
Tab/Shift-Tab/Enter moves focus to the next/prev editable cell (DOM-order traversal over
`input[data-cell-id]`); Escape discards; edits auto-commit after 350 ms idle or on blur; select rows
and batch-delete via `batchDeleteActivities`; add activities via `AddActivityDialog`; a client-side
phase totals rollup feeds `BottomPanel`.

### 7. Add activity — `components/add-activity-dialog.tsx` (621 lines)

Six tabs across two `TabsList` rows: Labor, Material, Equipment / Subcontractor, Cost Only, Custom
Labor.

- **Labor:** searchable `laborPool` list filtered by the phase's `phasePoolId`; selecting an item
  populates description, craft constant, weld constant, and unit from `craftUnits`. Constants remain
  hand-editable.
- **Material / Cost Only:** single `unitPrice` field.
- **Equipment:** searchable `equipmentPool` (global, not phase-filtered); selecting populates
  description and `unitPrice` from `dayRate`; plus ownership select (rental/owned/purchase), time,
  rate.
- **Subcontractor:** three cost fields (labor, material, equipment).
- **Custom Labor:** manual craft/weld constants.
- Shared footer fields: description (force-uppercased on submit), quantity, unit (defaults `"EA"`).

### 8. Pool browsers — `routes/pools/labor.tsx` (191), `routes/pools/equipment.tsx` (131)

- **Labor Constants** (`/pools/labor`): cascading WBS select → phase-type select → table of
  `poolId`, description, craft constant + units, weld constant + units. Text search once a phase is
  picked.
- **Equipment Catalog** (`/pools/equipment`): item count, search, table of `poolId`, description,
  hour/day/week/month rates.
- `/pools` redirects to `/pools/labor`.

Both are **read-only browsers**. Neither can add, edit, deactivate, or create custom pool entries.

### 9. Excel export — `lib/export-excel.ts` (294 lines)

Single-sheet ExcelJS workbook. Title + subtitle rows, frozen header at row 4, 13 columns.
Hierarchical WBS (blue fill, bold 12pt) → Phase (yellow fill, bold 10pt) → Activity (plain 10pt)
rows, thin gray borders, `"$"#,##0.00` on cost columns and `#,##0.0` on MH columns for activity and
total rows, and a green GRAND TOTAL row. Downloaded as `Estimate_{proposalNumber}.xlsx`. Data comes
from `precision.getExportData`, so all costs are server-computed.

### 10. Duplicate estimate — `components/duplicate-estimate-dialog.tsx` (148 lines)

Suggests a revision number (`1956` → `1956.1`; `1956.01` → `1956.02`; non-numeric → `{n}-copy`).
Calls `duplicateProposal`, which deep-copies proposal → WBS → phases → activities with correct ID
remapping at every level, forces `status: "bidding"` and `isCompleted: false`, and navigates to the
copy.

### 11. Shell, navigation, auth

- `AppShell` from `@truss/features/desktop-shell` with a three-column layout, command palette,
  status bar, and a context-switching sidebar config.
- **Global config** (`config/shell-config-global.ts`): All Estimates, a collapsible Pools section
  (Labor Constants, Equipment), and an Admin → Members section when `workspace.role` is
  `owner`/`admin`.
- **Estimate config** (`config/shell-config-estimate.ts`): Overview, then a **Work Breakdown tree**
  — every WBS as a top-level item with its phases as children, sourced live from
  `precision.getWBSWithPhasesForNav`. Footer item back to All Estimates.
- **Top bar:** `EstimateSwitcher` — dropdown of the 10 most recent other proposals plus "View All
  Estimates."
- **Auth:** Better Auth via Tauri deep link (`truss://`), `ConvexBetterAuthProvider`, shared
  `AuthScreen`. Falls back to a login screen when there's no session.
- **Admin:** `/admin` member list (search, All/Active/Suspended filter tabs, role icons, per-app
  permission badges, suspend/unsuspend) and `/admin/member/:memberId` (org role select, Precision
  permission select, Momentum permission select).

---

## WHAT IS PARTIAL

### The estimate detail screen is a form over a subset of the model

`updateProposal` accepts `projectAddress`, `projectStartDate`, `projectEndDate`, and `contactId`.
**None of the four has a UI field.** `projectAddress` is populated by the Firestore sync (`city`,
`state`) and displayed nowhere.

`estimators` is a `string[]` in the schema but the UI is a single comma-separated `<Input>` — it
round-trips through `.split(",").map(trim).filter(Boolean)`, so a comma in an estimator's name
silently splits them into two people.

### Phase metadata is write-once

`addPhase` accepts `area`, `sheet`, and the full `pipingSpec` object (`size`, `spec`, `flc`,
`system`, `insulation`, `insulationSize`). **`AddPhaseDialog` never sends any of them.**
`updatePhase` exists as a mutation and is **not called anywhere** — so once a phase exists you
cannot change its description, its phase number, its area, its sheet, its piping spec, or its
`isCompleted` flag. The WBS table renders `pipingSpec.size` and `pipingSpec.spec` columns that can
only ever be blank for a Precision-created phase (they populate only for Firestore-synced phases).

### The activity grid edits 2 of ~12 meaningful fields

`updateActivity` accepts `description`, `quantity`, `unit`, `labor`, `equipment`, `subcontractor`,
`unitPrice`. The grid exposes editors for **`description` and `quantity` only**.

- `commit()` includes `unitPrice` in its `numeric` set, but **no `unitPrice` column is rendered** —
  dead code path. You cannot change a material's price after creating it.
- `unit` renders as a read-only `<span>`.
- Craft constant and weld constant are not columns, so a labor line's productivity cannot be tuned
  in the grid — you must delete and re-add.
- Equipment `time` and `ownership` cannot be edited.
- Subcontractor labor/material/equipment cost breakdown cannot be edited.
- `activity.type` cannot be changed at all (`updateActivity` doesn't accept it).
- No Cost Only `$` column exists in the grid even though `costs.costOnlyCost` is computed and shown
  in the bottom panel.

The legacy app's `proposalColumnPreferences` schema table (schema.ts:976) enumerates the 20 columns
the old grid had with per-user visibility toggles:
`rowId, description, quantity, unit, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, materialCost, equipmentCost, subContractorCost, costOnlyCost, totalCost, price, time, equipmentOwnership, craftBaseRate, subsistenceRate`.
Precision renders 11 and has no visibility control. **That table is orphaned — no Convex function
reads or writes it.**

### Activity-level rate overrides are computed but unreachable

`computeCraftLoadedRate` honors `activity.labor.customCraftRate` and `customSubsistenceRate`. The
schema stores them. The Firestore sync populates them. **Nothing in the Precision UI can set them**
— `AddActivityDialog` never writes them, and there is no grid column. The legacy app had
`src/components/edit_base_rate_dialog.tsx` for exactly this. The "Custom Labor" tab's helper text
says _"Custom labor uses activity-level rate overrides instead of proposal rates"_ — **this is
false**; the Custom Labor tab writes only `craftConstant`/`welderConstant`, identical to the Labor
tab minus the catalog.

### Command palette / shortcuts are half-wired

Three custom events are dispatched with **zero listeners anywhere in the repo** (verified by
repo-wide grep):

| Event                    | Dispatched from                    | Shortcut              | Listener |
| ------------------------ | ---------------------------------- | --------------------- | -------- |
| `toggle-sidebar`         | both shell configs                 | `⌘B`                  | **none** |
| `open-estimate-switcher` | `shell-config-estimate.ts:78, 200` | `⌘⇧O` + palette entry | **none** |
| `export-estimate`        | `shell-config-estimate.ts:98`      | `⌘⇧E` + palette entry | **none** |

`open-create-estimate` _does_ have a listener (`estimates.tsx:53`) but the global "New Estimate"
command dispatches it **synchronously right after** `navigate("/estimates")` — if the user is not
already on `/estimates`, the route hasn't mounted, the listener isn't attached, and `⌘N` does
nothing.

The palette also advertises `⌘P` for "All Estimates" but no `cmd+p` handler is registered in the
`shortcuts` array — that label is decorative.

### Bottom panel double-computes

`BottomPanel` is shared and correct. But the WBS detail and phase detail screens **re-sum the costs
client-side** (`useMemo` reducers at `$estimateId.wbs.$wbsId.tsx:59-85` and
`$estimateId.phase.$phaseId.tsx:339-365`) instead of asking the server. Only the overview uses the
server's `getProposalSummary`. Consequently `directHours`/`indirectHours` appear **only** on the
overview — the WBS and phase panels omit them because those rollups don't carry the classification.

### Cost formulas — implemented vs. missing

Implemented server-side in `computeActivityCosts` (`precision.ts:209-311`), matching legacy
structure:

| Formula                                                                                                                                                             | Status                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Craft man-hours = `qty × craftConstant`                                                                                                                             | ✅                        |
| Welder man-hours = `qty × welderConstant`                                                                                                                           | ✅                        |
| Craft loaded rate = `base + base×(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence`, honoring per-activity `customCraftRate`/`customSubsistenceRate` | ✅ matches legacy         |
| Welder loaded rate                                                                                                                                                  | ⚠️ **WRONG — see below**  |
| Craft cost calculated for all types **except** subcontractor                                                                                                        | ✅ matches legacy         |
| Welder cost calculated for **all** types incl. subcontractor                                                                                                        | ✅ matches legacy         |
| Material = `qty × price × (1 + (materialProfit + salesTax)/100)`                                                                                                    | ✅                        |
| Equipment (owned) = `qty × time × price`                                                                                                                            | ✅                        |
| Equipment (rental/purchase) = `qty × time × price × (1 + (equipProfit + useTax)/100)`                                                                               | ✅                        |
| Subcontractor = `qty × (L×(1+p) + M×(1+p+tax) + E×(1+p))`                                                                                                           | ✅                        |
| Cost only = `qty × price`                                                                                                                                           | ✅                        |
| Total: subcontractor → `subcontractorCost` only; all others → sum of all six components                                                                             | ✅ matches legacy         |
| Direct vs indirect hour classification                                                                                                                              | ⚠️ hardcoded WBS pool IDs |

**The welder loaded rate bug.** `precision.ts:179-195`:

```ts
// Same 5 markup rates as craft — NO rigProfitRate in this multiplier
const rateMultiplier =
  (rates.burdenRate +
    rates.overheadRate +
    rates.laborProfitRate +
    rates.fuelRate +
    rates.consumablesRate) /
  100;
return (
  rates.weldBaseRate +
  rates.weldBaseRate * rateMultiplier +
  rates.subsistenceRate +
  rates.rigRate +
  (rates.rigRate * rates.rigProfitRate) / 100
);
```

Legacy `mcp_estimator/src/utils/calculations.ts:58-72`:

```ts
const ratesSum = sumRates(
  burdenRate,
  overheadRate,
  laborProfitRate,
  fuelRate,
  consumablesRate,
  rigProfitRate // <-- present in the legacy multiplier
);
return (
  weldBaseRate +
  weldBaseRate * ratesSum +
  subsistenceRate +
  rigRate +
  rigRate * pctToDecimal(rigProfitRate)
);
```

Precision is missing the `weldBaseRate × rigProfitRate / 100` term. The JSDoc above the function
asserts "This matches the legacy MCP Estimator exactly" — **it does not.** Every welder cost, and
therefore every phase/WBS/proposal total containing welding, is understated. At a $60 weld base and
a 10% rig profit rate that is $6/hr on every welder hour in the estimate.

**Hardcoded indirect classification.**
`INDIRECT_WBS_POOL_IDS = {10000 MOBILIZE, 180000 SPECIALTY SERVICES, 190000 DEMOBILIZE, 200000 SUPPORT}`
(`precision.ts:634-639`) is a literal `Set` in source. There is no admin surface, no per-proposal
override, and no v2 dataset variant. `_LABOR_TYPES` on line 642 is declared, underscore-prefixed,
and never used — dead.

### Precision shows empty estimates for most real data

`crons.ts` syncs **proposals only** from Firestore every 6 hours. WBS/phases/activities are pulled
on demand **only** when a Momentum project is created from a proposal
(`momentum.createProjectFromProposal` → `sync.syncEngine.syncProposalTree`). So for every legacy
proposal that has not been imported into Momentum, opening it in Precision shows
`"No WBS categories initialized."`, a zero bottom panel, and an empty Excel export. Precision is
only "full" for proposals created natively in Precision or already pulled by Momentum.

### Admin is a stale fork with dead handlers

`routes/admin/index.tsx` declares
`const setPermission = useMutation(api.appPermissions.setPermission)` and
`const updateRole = useMutation(api.adminUsers.updateMemberRole)` — **neither is ever called** on
that page (permission badges are display-only). The `confirmAction` type union includes `"remove"`
and `handleConfirmAction` has a `case "remove"`, but **no UI element ever sets that type**, so
`removeMember` is unreachable. Momentum's equivalent page has since gained avatars, invites, a role
`Select`, toasts, and `MemberStatusFilter` from `@truss/features/admin/types`; Precision's has none
of it.

---

## WHAT IS ABSENT

### Screens and capabilities with no implementation at all

| Missing                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add / remove WBS on a proposal**                 | `addWBS` and `deleteWBS` mutations exist and are **called from nowhere**. Legacy had `src/features/proposal home/select_wbs_dialog.tsx`. Every new Precision proposal gets all 18 v1 WBS categories dumped on it with no way to prune.                                                                                                                                                                                                                                        |
| **Delete a proposal**                              | `deleteProposal` mutation exists, no UI.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Edit a phase**                                   | `updatePhase` mutation exists, no UI. Description, number, area, sheet, piping spec, completed flag are all frozen after creation.                                                                                                                                                                                                                                                                                                                                            |
| **Mark a phase complete**                          | The WBS table renders `isCompleted` styling; nothing can toggle it.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Reorder activities**                             | `reorderActivities` mutation exists, no drag handles, no UI.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Copy activities between phases**                 | `copyActivitiesToPhase` mutation exists, no UI. Legacy had `src/components/copy_from_phase_dialog.tsx`.                                                                                                                                                                                                                                                                                                                                                                       |
| **Copy activities across proposals**               | No mutation, no UI. Legacy had `src/components/copy_activities_from_proposal_dialog.tsx`.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Edit activity base rate overrides**              | Computed but unsettable. Legacy had `src/components/edit_base_rate_dialog.tsx`.                                                                                                                                                                                                                                                                                                                                                                                               |
| **Contacts**                                       | `contacts` table exists in schema with `by_email`/`by_name` indexes; `updateProposal` accepts `contactId`. **Zero Convex functions read or write `contacts`.** No UI.                                                                                                                                                                                                                                                                                                         |
| **Pool management**                                | Pools are read-only browsers. No create/edit/deactivate; `isCustom` and `isActive` flags are never written by any mutation. No v2 dataset authoring.                                                                                                                                                                                                                                                                                                                          |
| **Column visibility / grid preferences**           | `proposalColumnPreferences` table is orphaned — no function touches it.                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Default WBS display preferences**                | `userWbsPreferences` table is orphaned.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **`users` table**                                  | Defined in schema with `firestoreId`, `externalId`, `role`, `permission`, `isDeleted`, `isDisabled`. **No Convex function reads or writes it.** Auth runs entirely through Better Auth + `appPermissions`.                                                                                                                                                                                                                                                                    |
| **Permission enforcement**                         | Grep for `hasPermission`, `getAppAccess`, `precisionPermission`, `canWrite` across `apps/precision/src` (excluding `admin/`) returns **zero hits**. A member with `read` permission can create, edit, and delete everything. Momentum at least has `apps/momentum/src/lib/permissions.ts`.                                                                                                                                                                                    |
| **Server-side authorization**                      | `precision.ts` contains no `ctx.auth`, no `getAuthUserId`, no identity check in any of its 30 functions. Any authenticated client can mutate any proposal. (Momentum's backend is equally unguarded — this is a platform gap, not a Precision-only one.)                                                                                                                                                                                                                      |
| **Multi-tenancy**                                  | `proposals` has no `organizationId`. `listProposals` does an unfiltered `.collect()` and returns every proposal in the deployment to every user.                                                                                                                                                                                                                                                                                                                              |
| **Auto-update**                                    | `@tauri-apps/plugin-updater` and `plugin-process` are in `package.json` dependencies but **absent from `src-tauri/Cargo.toml`** and from `capabilities/default.json`. Momentum's Cargo.toml has both. `getEstimateShellConfig`/`getGlobalShellConfig` accept an `onCheckForUpdate` callback; `__root.tsx` passes `undefined` at both call sites, so the "Check for Updates" command never appears. Momentum has `components/update-checker.tsx`; Precision has no equivalent. |
| **Toasts / error surfacing**                       | `sonner` is a dependency and is never imported in `apps/precision/src`. Every failure path is `console.error(...)`. If `addActivity` throws, the dialog stays open with a re-enabled button and the user sees nothing.                                                                                                                                                                                                                                                        |
| **Lint / typecheck**                               | No `eslint.config.mjs` in `apps/precision`, no `lint` script. `check-types` is literally `echo 'App type checking handled by IDE and Vite...'`. Real type errors ship. (Momentum is identical — platform-wide gap.)                                                                                                                                                                                                                                                           |
| **Tests**                                          | No test files anywhere in `apps/precision` or `packages/features/src/estimation`. The cost engine — the one thing that must be exactly right — has zero test coverage, which is why the `rigProfitRate` bug went unnoticed.                                                                                                                                                                                                                                                   |
| **README**                                         | `apps/precision/README.md` is still the unmodified `create-tauri-app` boilerplate.                                                                                                                                                                                                                                                                                                                                                                                            |
| **Multiple export formats**                        | One Excel layout. Legacy had a dedicated export menu. No PDF, no client-facing summary, no cost-code breakdown.                                                                                                                                                                                                                                                                                                                                                               |
| **Change orders**                                  | `changeOrderNumber` is a string field on the proposal. Momentum has a whole change-order WBS architecture (`momentum.ts`). Precision has nothing.                                                                                                                                                                                                                                                                                                                             |
| **Audit trail / history / comments / attachments** | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## BACKEND SURFACE — every Convex function in `precision.ts`

30 exported functions. `UI?` = called from `apps/precision/src` (verified by grep).

### Queries (16)

| Function                 | Args                            | Computes / returns                                                                                                                                                                                                                                  | UI?                                             |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `listProposals`          | —                               | `.collect()` on all proposals; projects `_id`, `proposalNumber`, `description`, `ownerName`, `status`, `bidType`, `dateDue`, `dateReceived`, `jobNumber`, `estimators`, `datasetVersion`. **No costs, no org filter.**                              | ✅ `estimates.tsx`, `estimate-switcher.tsx`     |
| `getProposal`            | `proposalId`                    | Full proposal doc + `wbsCount` + `phaseCount`. Throws `"Proposal not found"`.                                                                                                                                                                       | ✅ 5 call sites                                 |
| `getWBSForProposal`      | `proposalId`                    | `_id`, `name`, `wbsPoolId`, `sortOrder` per WBS.                                                                                                                                                                                                    | ❌ **dead**                                     |
| `getWBSWithPhasesForNav` | `proposalId`                    | WBS list with nested `phases[{_id, phaseNumber, description}]`, phases sorted by `sortOrder`. Lightweight, no costs.                                                                                                                                | ✅ `__root.tsx`                                 |
| `getActivitiesWithCosts` | `phaseId`                       | Every activity in the phase (index `by_phase_sort`) spread with a `costs` object from `computeActivityCosts`.                                                                                                                                       | ✅ phase detail                                 |
| `getPhaseListWithCosts`  | `wbsId`                         | Phases (`by_wbs_sort`) + all WBS activities in one `by_wbs` query, grouped and accumulated per phase. Returns phase metadata + `activityCount` + rounded `costs`.                                                                                   | ✅ WBS detail, `add-phase-dialog`               |
| `getWBSListWithCosts`    | `proposalId`                    | WBS (`by_proposal_sort`) + all proposal activities in one `by_proposal` query + phase counts. Per-WBS accumulation.                                                                                                                                 | ✅ overview WBS tab                             |
| `getProposalSummary`     | `proposalId`                    | Single pass over all activities: full cost accumulator plus `directCraftHours`, `directWelderHours`, `directHours`, `indirectHours`, `totalHours`, `wbsCount`, `phaseCount`, `activityCount`. Classification via hardcoded `INDIRECT_WBS_POOL_IDS`. | ✅ overview bottom panel                        |
| `getWBS`                 | `wbsId`                         | Single WBS doc. Throws if missing.                                                                                                                                                                                                                  | ✅ `add-phase-dialog` only                      |
| `getPhase`               | `phaseId`                       | Single phase doc. Throws if missing.                                                                                                                                                                                                                | ✅ `add-activity-dialog` only                   |
| `getWBSPool`             | `datasetVersion`                | Active `wbsPool` rows; auto-falls back to v1 when the requested version is empty.                                                                                                                                                                   | ✅ `pools/labor.tsx`                            |
| `getPhasePool`           | `datasetVersion`, `wbsPoolId`   | Active `phasePool` rows for the WBS; v1 fallback.                                                                                                                                                                                                   | ✅ `add-phase-dialog`, `pools/labor.tsx`        |
| `getLaborPool`           | `datasetVersion`, `phasePoolId` | Active `laborPool` rows for the phase type; v1 fallback. **No WBS-level union fallback** (Momentum's `getLaborPoolForProject` has one) — a phase whose pool type has no labor entries shows an empty catalog with no recovery.                      | ✅ `add-activity-dialog`, `pools/labor.tsx`     |
| `getEquipmentPool`       | `datasetVersion`                | All active equipment; v1 fallback.                                                                                                                                                                                                                  | ✅ `add-activity-dialog`, `pools/equipment.tsx` |
| `getExportData`          | `proposalId`                    | Full hierarchical WBS → phases → activities with per-activity, per-phase, per-WBS, and grand-total computed costs, plus proposal header and rates.                                                                                                  | ✅ overview export                              |

### Mutations (14)

| Function                | Args                                                                                                                                                  | Does                                                                                                   | UI?                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `createProposal`        | `proposalNumber`, `description`, `ownerName`, `rates{15}`, `datasetVersion`, + 11 optional metadata fields                                            | Inserts proposal, then inserts one `wbs` row per active `wbsPool` entry (v2→v1 fallback). Returns id.  | ✅ create dialog                             |
| `updateProposal`        | `proposalId` + 13 optional fields incl. `contactId`                                                                                                   | Builds a patch from defined fields only.                                                               | ✅ overview (only 11 of 13 reachable)        |
| `updateProposalRates`   | `proposalId`, `rates{15}`                                                                                                                             | Patches the whole rates object.                                                                        | ✅ Rates tab                                 |
| `deleteProposal`        | `proposalId`                                                                                                                                          | Cascade: activities → phases → WBS → proposal.                                                         | ❌ **dead**                                  |
| `addWBS`                | `proposalId`, `wbsPoolId`, `name`                                                                                                                     | Duplicate-guards on `by_proposal_pool`, appends at `max(sortOrder)+1`.                                 | ❌ **dead**                                  |
| `deleteWBS`             | `wbsId`                                                                                                                                               | Cascade: activities → phases → WBS.                                                                    | ❌ **dead**                                  |
| `addPhase`              | `wbsId`, `phasePoolId`, `poolName`, `phaseNumber`, `description`, + optional `area`, `sheet`, `pipingSpec`                                            | Inserts with `isCompleted: false`, `sortOrder = max+1`.                                                | ✅ (3 optional args never sent)              |
| `updatePhase`           | `phaseId` + 6 optional fields                                                                                                                         | Sparse patch.                                                                                          | ❌ **dead**                                  |
| `deletePhase`           | `phaseId`                                                                                                                                             | Deletes the phase's activities, then the phase.                                                        | ✅ WBS detail                                |
| `duplicatePhase`        | `sourcePhaseId`, `newPhaseNumber`, `newDescription?`                                                                                                  | Copies phase metadata + all activities; resets `isCompleted`.                                          | ✅ WBS detail                                |
| `copyActivitiesToPhase` | `sourcePhaseId`, `targetPhaseId`                                                                                                                      | Appends source activities to target with offset sort orders. Returns new ids.                          | ❌ **dead**                                  |
| `addActivity`           | `phaseId`, `type`, `description`, `quantity`, `unit`, + optional `laborPoolId`, `equipmentPoolId`, `labor`, `equipment`, `subcontractor`, `unitPrice` | Denormalizes `proposalId`/`wbsId` from the phase; `sortOrder = max+1`.                                 | ✅ add-activity dialog                       |
| `updateActivity`        | `activityId` + 7 optional fields                                                                                                                      | Sparse patch. **Cannot change `type`.**                                                                | ✅ (only `description`/`quantity` reachable) |
| `batchDeleteActivities` | `activityIds[]`                                                                                                                                       | Sequential guarded deletes.                                                                            | ✅ phase detail                              |
| `reorderActivities`     | `phaseId`, `orderedActivityIds[]`                                                                                                                     | Rewrites `sortOrder = i+1`.                                                                            | ❌ **dead**                                  |
| `duplicateProposal`     | `sourceProposalId`, `newProposalNumber`, `newDescription?`                                                                                            | Full tree deep copy with WBS and phase id remapping; forces `status: "bidding"`, `isCompleted: false`. | ✅ duplicate dialog                          |

**Dead backend surface: 7 of 30 functions (23%)** — `getWBSForProposal`, `deleteProposal`, `addWBS`,
`deleteWBS`, `updatePhase`, `copyActivitiesToPhase`, `reorderActivities`.

**No function in `precision.ts` performs any authentication or authorization check.**

---

## Schema reference (Precision tables)

### `proposals` (schema.ts:353-399)

`firestoreId?`, `proposalNumber` (string, supports `"1956.01"`), `description`, `ownerName`,
`contactId?`, `status?` (bidding|submitted|awarded|rejected|declined|open|closed), `bidType?`
(lump_sum|time_and_materials|budgetary|rates|cost_plus),
`projectAddress?{street,city,state,zipCode}`, `jobSiteAddress?`, `estimators?: string[]`,
`dateReceived?`, `dateDue?`, `projectStartDate?`, `projectEndDate?` (all Unix ms), `jobNumber?`,
`changeOrderNumber?`, `rates{15 fields}`, `datasetVersion` (v1|v2), `customQuantity?`,
`customUnit?`. Indexes: `by_firestore_id`, `by_number`, `by_owner`, `by_status`, `by_date_due`. **No
`organizationId`.**

### `rates` object — the 15 fields that drive everything

`craftBaseRate`, `weldBaseRate`, `subsistenceRate`, `rigRate` ($/hr) · `burdenRate`, `overheadRate`,
`consumablesRate`, `fuelRate` (%) · `laborProfitRate`, `materialProfitRate`, `equipmentProfitRate`,
`subcontractorProfitRate`, `rigProfitRate` (%) · `salesTaxRate`, `useTaxRate` (%). `DEFAULT_RATES`
(features/estimation/types.ts:34) is **all zeros** — a brand-new Precision estimate computes $0 for
everything until someone fills in the Rates tab, with no prompt, no warning, and no template.

### `wbs` (413-425)

`firestoreId?`, `proposalId`, `wbsPoolId` (number), `name` (denormalized), `sortOrder`,
`customQuantity?`, `customUnit?`.

### `phases` (443-470)

`firestoreId?`, `proposalId`, `wbsId`, `phasePoolId`, `poolName`, `phaseNumber`, `description`,
`area?`, `sheet?` (number), `pipingSpec?{size,spec,flc,system,insulation,insulationSize}`, `status?`
(free-text legacy), `isCompleted`, `sortOrder`, `customQuantity?`, `customUnit?`.

### `activities` (495-523)

`firestoreId?`, `proposalId`, `wbsId`, `phaseId`, `type`
(labor|material|equipment|subcontractor|cost_only|custom_labor), `description`, `quantity`, `unit`,
`sortOrder`, `laborPoolId?`, `equipmentPoolId?`,
`labor?{craftConstant, welderConstant, customCraftRate?, customSubsistenceRate?}`,
`equipment?{ownership: rental|owned|purchase, time}`,
`subcontractor?{laborCost, materialCost, equipmentCost}`, `unitPrice?`. **No computed cost fields
are stored** — the architecture bet holds. All costs are derived on read.

### Pool tables

`wbsPool` (18 v1 rows), `phasePool` (per-WBS types), `laborPool` (`craftConstant`, `craftUnits`,
`weldConstant`, `weldUnits` per phase type), `equipmentPool` (`hourRate`, `dayRate`, `weekRate`,
`monthRate`). All carry `datasetVersion`, `poolId`, `sortOrder`, `isCustom`, `isActive`.

---

## UX problems in the current implementation

Ordered by severity. These are redesign inputs.

### 1. The estimate detail screen buries the estimate

The screen is titled by proposal number and description, then presents three tabs — Details, Rates,
WBS — and **defaults to Details**. The user's job is estimating; the first thing they see is a
data-entry form for job numbers and due dates. The actual estimate (the WBS with money in it) is the
**third tab**, behind two clicks, and is the only tab with any numbers on it. The bottom panel shows
a total that has no visible relationship to anything on screen when the Details tab is active.

This is structurally the same mistake as the legacy `proposal_info_accordion.tsx` /
`proposal_rates_accordion.tsx` — critical numbers hidden behind a disclosure widget — just with tabs
instead of accordions.

### 2. Saves are silent, debounced, and lossy

`patchField` uses **one shared `debounceRef` for all fields** (`$estimateId.index.tsx:90-102`).
Every call does `clearTimeout(debounceRef.current)`. Blur "Job #", then blur "CO #" within 400 ms,
and the Job # write is **cancelled and never sent**. There is no dirty indicator, no saving spinner,
no saved confirmation, and no error toast. The user has no way to know.

`RatesGrid` holds `local` state initialized from props **once**, with no `useEffect` resync, and
renders `defaultValue` (uncontrolled) inputs. If the server value changes underneath — which it
does, every 6 hours, via the cron — the grid keeps showing and writing stale values.

### 3. Those saves get reverted by a cron

For any proposal with a `firestoreId` (i.e. every proposal that came from the legacy estimator —
which is all of the production data), `sync/syncMutations.ts:279` does
`ctx.db.patch(existing._id, proposal)` every 6 hours with a full `mapProposal` payload covering
`description`, `ownerName`, `status`, `bidType`, `projectAddress`, `jobSiteAddress`, `estimators`,
all four dates, `jobNumber`, `changeOrderNumber`, **all 15 rates**, and `datasetVersion` (forced to
`"v1"`). Every Details and Rates edit made in Precision on a legacy proposal is destroyed within 6
hours, silently.

### 4. The "Add" dropdown lies

Phase detail's Add menu lists all six activity types with distinct icons and colors. **Every single
item runs the identical handler: `onClick={() => setAddOpen(true)}`**
(`$estimateId.phase.$phaseId.tsx:411`). Pick "Material" and you get the dialog open on the **Labor**
tab. The dropdown is pure decoration; the real type choice happens again inside the dialog, on a
two-row 3×2 tab strip that is itself an unusual and cramped control.

### 5. The add-activity dialog is a form, not a workflow

- No autofocus, no keyboard-first path — you must mouse to the catalog, mouse to the item, mouse to
  quantity.
- No "add another" — the dialog closes on every submit. Entering 30 labor lines means 30
  open/search/click/type/submit cycles.
- The catalog list stays fully expanded after selection, so the selected item scrolls away and the
  form gets taller instead of tighter.
- Craft/weld constants remain as raw editable inputs after a catalog pick, presenting derived values
  as primary inputs.
- Description is force-`.toUpperCase()`d on submit with no visual indication beyond a CSS
  `uppercase` class.
- Equipment "Rate" is auto-filled from `dayRate` while the "Time" field says "Hours" — a unit
  mismatch baked into the defaults.
- Failure is `console.error` only.

Momentum's `add-activity-dialog.tsx` already solved most of this: catalog selections collapse into a
chip, labor/custom-labor merge into one tab with a mode toggle, refs drive focus management, there's
an advanced-fields disclosure, and errors surface via `toast`. **Precision does not use it.**

### 6. Nothing is editable after it exists

Add a phase with a typo in the description → your only recourse is delete and re-add (losing every
activity under it). Add a material at the wrong price → delete and re-add. Add a labor line with the
wrong constant → delete and re-add. Add a subcontractor with a wrong material cost → delete and
re-add. This is the single biggest day-to-day friction in the current build and it comes from
`updatePhase` being unwired and the grid exposing only 2 editable columns.

### 7. 18 WBS categories, most of them empty

`createProposal` seeds every active pool WBS. The sidebar tree then renders all 18 as expandable
nodes. A typical estimate uses 3-5. There is no way to hide, remove, or reorder them —
`addWBS`/`deleteWBS` are unwired. The overview WBS table shows 18 rows where 13 read `—  —  —`.

### 8. Destructive actions have no confirmation

`batchDeleteActivities` fires immediately from the toolbar button. `handleDeleteSelected` on the WBS
page loops `deletePhase` — which cascade-deletes every activity underneath — with **no
`AlertDialog`, no undo, no count-of-affected-items warning**. `AlertDialog` is already a dependency
and is used in the admin page, so this is an omission, not a constraint.

### 9. Bulk selection is inconsistent and partially broken

WBS detail lets you multi-select phases, but **Duplicate only acts on `[...selected][0]`** — select
three phases, hit Duplicate, get one copy, no feedback about the other two. Delete loops
sequentially with `await` inside a `for`, so deleting 20 phases is 20 round-trips with no progress
indication and no atomicity.

Selection state also differs between screens: phase detail uses TanStack Table's `rowSelection`
record; WBS detail hand-rolls a `Set<string>`. Two mental models, two code paths.

### 10. Everything is unvirtualized

`estimates.tsx` renders every proposal row. `$estimateId.phase.$phaseId.tsx` renders every activity
row. `pools/equipment.tsx` renders the entire equipment catalog. `@tanstack/react-virtual` is
already a devDependency of `@truss/features` and is used nowhere in Precision. A phase with several
hundred activities will visibly stutter on every keystroke, because each `EditableCell` commit
invalidates `getActivitiesWithCosts` and re-renders the whole table.

### 11. Loading is all-or-nothing

Every screen gates on `if (!proposal || !activities) return <Skeleton/>`. The overview additionally
subscribes to `getExportData` — a **full tree query with every activity and every computed cost** —
on mount, purely so the Export button can be enabled. On a large estimate this pulls the entire
dataset over the wire on page load for a button that may never be clicked.

### 12. Dead keyboard affordances train distrust

`⌘B`, `⌘⇧O`, `⌘⇧E` are advertised in the command palette with shortcut badges and do nothing. `⌘N`
works only if you're already on `/estimates`. `⌘P` is a label with no handler. A user who tries
these once learns the shortcut layer isn't real.

---

## Duplication between Precision and Momentum

| Concern                            | Momentum                                                                                                                                                                                                        | Precision                                                                                                            | Verdict                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add activity dialog                | `momentum/src/components/add-activity-dialog.tsx` — 1,001 lines, catalog→chip collapse, merged labor/custom-labor tab with mode toggle, `Command` combobox, refs for focus, advanced disclosure, `toast` errors | `precision/src/components/add-activity-dialog.tsx` — 621 lines, 6 flat tabs, raw `ScrollArea` lists, `console.error` | **Full fork.** Same six types, same pool tables, same `laborPoolId`/`equipmentPoolId`/`labor`/`equipment`/`subcontractor`/`unitPrice` payload shape. Should be one component in `@truss/features/estimation`. |
| Add phase dialog                   | 368 lines                                                                                                                                                                                                       | 221 lines                                                                                                            | **Fork.** Same phasePool browse-and-select pattern.                                                                                                                                                           |
| Edit activity / edit phase dialogs | `edit-activity-dialog.tsx` (193), `edit-phase-dialog.tsx` (121)                                                                                                                                                 | **none**                                                                                                             | Precision needs exactly these and doesn't have them.                                                                                                                                                          |
| Admin members list                 | 336+ lines, avatars, invites, role select, toasts                                                                                                                                                               | 336 lines, stale fork, two dead mutation handles                                                                     | **Fork.** Both call the same `adminUsers` / `appPermissions` Convex functions.                                                                                                                                |
| Admin member detail                | evolved                                                                                                                                                                                                         | stale fork                                                                                                           | **Fork.**                                                                                                                                                                                                     |
| Excel export                       | `momentum/src/lib/export-excel.ts`                                                                                                                                                                              | `precision/src/lib/export-excel.ts`                                                                                  | Separate ExcelJS implementations with separate style constants.                                                                                                                                               |
| Shell config                       | `shell-config-global.ts`, `shell-config-project.ts`                                                                                                                                                             | `shell-config-global.ts`, `shell-config-estimate.ts`                                                                 | Parallel structure, same dead `toggle-sidebar` dispatch in both.                                                                                                                                              |
| Update checker                     | `components/update-checker.tsx` + Cargo plugins                                                                                                                                                                 | **none**                                                                                                             | Precision cannot self-update.                                                                                                                                                                                 |
| Client permission helpers          | `lib/permissions.ts`                                                                                                                                                                                            | **none**                                                                                                             | Precision has no permission gating at all.                                                                                                                                                                    |

**Genuinely shared today:** `@truss/ui` primitives, `@truss/features/desktop-shell` (AppShell,
command palette, sidebar, status bar, three-column layout), `@truss/features/organizations`
(WorkspaceProvider), `@truss/features/auth` (AuthScreen), `@truss/auth` (Tauri Better Auth client),
and the four pool tables + `proposals`/`wbs`/`phases`/`activities` tables in Convex.

**`packages/features/src/estimation/` contains only 4 files** — `types.ts`, `index.ts`,
`editable-cell.tsx` (178 lines), `bottom-panel.tsx` (263 lines). Note that
`packages/features/src/index.ts` does **not** re-export `./estimation`; consumers must use the
subpath. That package is the natural home for the shared dialogs and grid and is currently almost
empty.

---

## Build / platform notes

- **Tauri:** `productName: "Precision"`, identifier `com.forerelic.truss.precision`, version
  `0.1.0`, 1280×800 default / 1000×600 min, deep-link scheme `truss`. Rust plugins: opener, store,
  devtools, deep-link, http, os. **No updater, no process, no dialog, no fs** despite the JS
  packages being installed.
- **`beforeDevCommand`** starts the Next.js auth server at `localhost:3000` alongside Vite at `1420`
  via `concurrently` — Precision cannot run without the web app running.
- `src-tauri/src/lib.rs` still exports the scaffold `greet` command and force-opens devtools in
  debug.
- `capabilities/default.json` HTTP allowlist: `localhost:3000`, `localhost:3001`, `*.truss.dev`,
  `*.convex.cloud`, `*.convex.site`.
- `main.tsx` blocks browser back-navigation by re-pushing history on `popstate` — a deliberate
  WebKit Backspace workaround.
- `csp: null` — content security policy disabled.

---

## Recommended priority order

1. **Fix `computeWelderLoadedRate`** — add `rigProfitRate` to the markup sum, correct the false
   JSDoc, and add unit tests for all six activity types against known legacy outputs. Nothing else
   matters if the numbers are wrong.
2. **Resolve the sync/edit conflict** — either make Precision the write authority and stop the
   proposals cron from patching user-owned fields, or make legacy-origin proposals explicitly
   read-only in Precision until cutover.
3. **Redesign the estimate detail screen** around the WBS/money, not the metadata form. Per-field
   save state. Kill the shared debounce ref.
4. **Wire the editing gap** — `updatePhase`, an edit-activity path, and more editable grid columns
   (`unitPrice`, constants, equipment time/ownership, subcontractor breakdown).
5. **Promote Momentum's `add-activity-dialog` and `add-phase-dialog` into
   `@truss/features/estimation`** and delete Precision's forks. This is Collin's stated goal and the
   code is already 80% aligned.
6. **Wire or delete** the 7 dead mutations and the 3 dead custom events.
7. **Add confirmations, toasts, and permission gating.**
