# Legacy MCP Estimator — Proposal Home Screen, Proposal Info Entry, Rates

**Audit scope:** `/Users/collinwillis/Dev/Personal/mcp_estimator/src/features/proposal home/**`,
plus everything it reaches into. **Method:** read of actual source. Every claim below is traceable
to a file + line. Doc/comment claims were not trusted.

---

## 0. File inventory for this area

| File                                                                 | Status                          | Role                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/proposal home/proposal_home.tsx`                       | **LIVE**                        | Screen shell: 3 tabs, shared edit-mode state, save orchestration                                                                                                                  |
| `src/features/proposal home/components/proposal_details.tsx`         | **LIVE**                        | Tab 0 — proposal + contact info form                                                                                                                                              |
| `src/features/proposal home/components/proposal_rates.tsx`           | **LIVE**                        | Tab 1 — the 15 rate fields                                                                                                                                                        |
| `src/features/proposal home/components/wbs_data_grid.tsx`            | **LIVE**                        | Tab 2 — WBS roll-up grid + toolbar                                                                                                                                                |
| `src/features/proposal home/components/select_wbs_dialog.tsx`        | **LIVE**                        | "WBS Select" checkbox dialog (controls which WBS are visible everywhere)                                                                                                          |
| `src/features/proposal home/components/export_menu.tsx`              | **LIVE**                        | "Data Dump" menu → WBS Cost Report `.xlsx`                                                                                                                                        |
| `src/features/proposal home/components/proposal_info_accordion.tsx`  | **DEAD**                        | Never imported anywhere (`grep ProposalInfoAccordion` → only self-references). Old accordion UI                                                                                   |
| `src/features/proposal home/components/proposal_rates_accordion.tsx` | **DEAD**                        | Never imported anywhere. Old accordion rates UI                                                                                                                                   |
| `src/components/edit_base_rate_dialog.tsx`                           | **LIVE but not on this screen** | Imported only by `features/phase home/components/activity_data_grid.tsx:43` — per-activity rate override                                                                          |
| `src/api/proposal_preferences.ts`                                    | **HALF DEAD**                   | `insertProposalPreferences` used by `hooks/proposal_preferences_hook.ts`; `updateProposalPreferences` is dead (its only call site is commented out at `select_wbs_dialog.tsx:67`) |
| `src/components/bottom_pannel.tsx`                                   | **LIVE**                        | Persistent totals bar rendered by this screen                                                                                                                                     |
| `src/api/data_dump.ts` (1476 lines)                                  | **LIVE**                        | The entire Excel export engine                                                                                                                                                    |
| `src/api/totals.ts`                                                  | **LIVE**                        | All cost formulas that rates feed                                                                                                                                                 |

Supporting: `src/utils/store.ts` (Zustand), `src/utils/utils.ts`, `src/newAPI/api.ts`,
`src/models/proposal.ts`, `src/models/firestore models/proposal_firestore.ts`, `src/models/wbs.ts`,
`src/models/proposal_preferences.ts`, `src/utils/enums.ts`.

**Stack:** React 18 + TypeScript, MUI v5 + `@mui/x-data-grid-pro`, Zustand, Firebase/Firestore
(direct client SDK, no server), Tauri (used only for the file-save dialog in the export),
`xlsx-js-style`.

---

## 1. Purpose of the area & how a user actually flows through it

### 1.1 Route

`App.tsx:63-72` — `/proposal/:proposalId` →
`<AuthRoute><EstimatorDrawer><ProposalHomeScreen/></EstimatorDrawer></AuthRoute>`. Router is a
`MemoryRouter` (`App.tsx:2`), so there is **no URL bar, no deep-linking, no browser back**.
Navigation is entirely in-app.

Hierarchy: `Proposal → WBS → Phase → Activity`, matching routes: `/proposal/:proposalId` →
`/proposal/:proposalId/wbs/:wbsId` → `/proposal/:proposalId/wbs/:wbsId/phase/:phaseId`.

### 1.2 How the user gets here

1. `/` renders `ProposalOverviewDashboard` (`features/home/proposal_select.tsx`) — a stats header
   (Proposals / In Progress / Submitted / Awarded / Hit Rate), a clickable stacked status bar that
   filters, and a 5-column table (#, Description, Owner, Status, Due) capped at **50 rows**
   (`proposal_select.tsx:74`). Clicking a row → `navigate('/proposal/'+id)`.
2. Or the left drawer proposal list (`components/drawer.tsx:362`), filtered by a free-text search
   across ~22 proposal fields (`drawer.tsx:134-162`).
3. New proposals are created from the drawer hamburger → **Add** → `AddProposalDialog`, which asks
   for **only two fields**: Proposal Number (auto-suggested as `max(existing)+1`, or `1300` if none)
   and Proposal Description (`add_proposal_dialog.tsx:26-45`). `insertProposal` then writes a
   `FirestoreProposal` where **every one of the 15 rates defaults to `0`**
   (`proposal_firestore.ts:192-206`) and seeds all base WBS rows (`api/wbs.ts:insertAllBaseWbs`).

### 1.3 What happens on mount

`proposal_home.tsx:41-50`:

- `loadFullProposalData(proposalId)` — a **full-proposal bulk load**: `getSingleProposal` +
  `fetchProposalPreferencesFromFirestore` + `fetchProposalData` (all WBS + all phases + **all
  activities** for the proposal, three parallel collection queries), then recomputes every activity
  cost client-side (`processRawActivity`), rolls activities → phases (`calculateTotals`), rolls
  phases → WBS (`calculateWbsTotals`), and derives per-WBS quantity/unit. (`store.ts:105-194`)
- `useCurrentProposal({proposalId})` does a **second, redundant** `getSingleProposal` read
  (`hooks/current_proposal_hook.ts`).
- `setEditData(currentProposal)` seeds the form.
- `getCraftLoadedRate({proposal})` is called and assigned to an unused local
  (`proposal_home.tsx:47`) — **dead**.
- `sessionStorage.getItem('activeTab')` restores the last tab **globally, across proposals**
  (`proposal_home.tsx:52-57`).

### 1.4 The actual user flow through the screen

1. Land on whatever tab was last used (sticky in sessionStorage, not per-proposal).
2. **Details** tab: read-only "field label / uppercase value" list. To change anything, click
   **Edit** (top-right) → the entire form swaps to inputs → type → **Save** → success dialog → full
   proposal reload.
3. **Rates** tab: same read/Edit/Save pattern, 15 numeric fields in 4 groups. _Edit mode is shared
   with the Details tab_ (single `isEditMode` in the parent), so clicking Edit on Rates also puts
   Details in edit mode, and Save writes both tabs' data at once.
4. **WBS Data Grid** tab: read-only roll-up of the WBS rows _the user has chosen to display_.
   Toolbar: Columns, Density, **Data Dump** (export), **WBS Select**.
5. First-run trap: `insertProposalPreferences` writes `wbsToDisplay: []`
   (`api/proposal_preferences.ts:13-18`), so a **brand-new proposal shows an empty WBS grid and an
   empty WBS dropdown in the drawer** until the user opens WBS Select and checks boxes.
6. Actual estimating happens elsewhere — drill into a WBS via the drawer's **WBS dropdown**
   (`components/wbs_drop_down.tsx`), not by clicking a grid row (grid rows are not clickable — see
   §7.5).
7. The **bottom panel** (always mounted) shows live totals for the visible WBS set.

---

## 2. Screen anatomy (proposal_home.tsx)

```
┌──────────────────────────────────────────────────────────┐
│ AppBar (drawer): breadcrumb  "1301 - JOB DESC" › WBS › Phase│  ← drawer.tsx
├──────────────────────────────────────────────────────────┤
│ Tabs (fullWidth): [ Details ] [ Rates ] [ WBS Data Grid ] │  ← proposal_home.tsx:134-160
├──────────────────────────────────────────────────────────┤
│ Scrollable tab content (max-width 1100px on tabs 0 & 1)   │
├──────────────────────────────────────────────────────────┤
│ BottomPanel: Total Cost | Total Hrs | Direct | Indirect |  │  ← bottom_pannel.tsx
│              Sub Hrs                        [Details ▾]   │
└──────────────────────────────────────────────────────────┘
      + SelectWbsDialog (modal)   + success Dialog(Alert)
```

State owned by `ProposalHomeScreen`:

| State                   | Type                | Notes                                     |
| ----------------------- | ------------------- | ----------------------------------------- |
| `isSelectWbsDialogOpen` | boolean             |                                           |
| `isEditMode`            | boolean             | **shared by Details and Rates tabs**      |
| `editData`              | `Partial<Proposal>` | the whole draft record, both tabs         |
| `successDialogOpen`     | boolean             |                                           |
| `activeTab`             | number 0..2         | mirrored to `sessionStorage['activeTab']` |

Handlers:

- `handleEditClick()` → `isEditMode = true`
- `handleCancelClick()` → `isEditMode = false`, `editData = currentProposal || {}` (reverts to the
  **mount-time** snapshot, not the last-saved values)
- `handleChange(e)` → `editData[e.target.name] = e.target.value` — **always a string**, no coercion
- `handleValueChange(field, value)` → same, used only by the phone `PatternFormat`
- `handleSelectChange(event)` → same, for `<Select>`s
- `handleSaveClick()` →
  `await updateSingleProposal({proposalId, proposal: editData as FirestoreProposal})` →
  `isEditMode=false` → success dialog → `await loadFullProposalData(proposalId)`. Errors are only
  `console.error`'d (`proposal_home.tsx:72-74`) — **no user-visible failure state**.

`updateSingleProposal` (`api/proposal.ts:96-108`) uses `setDoc(proposalRef, {...proposal})` — a
**full document overwrite, not a merge**.

---

## 3. Tab 0 — "Details" (proposal_details.tsx): complete field enumeration

Header row: label "PROPOSAL DETAILS" + `Edit` button, or `Cancel` / `Save` when editing
(`proposal_details.tsx:120-141`).

Layout: MUI `Grid` `xs=12 sm=6 md=4` — 3 columns at desktop. Two sections divided by a hairline:
**Project Information** then **Contact Information**.

### 3.1 Project Information section

| #   | Label            | `Proposal` field       | Model type | Input widget in edit mode                                    | Read-mode rendering                                                                   | Persisted type after edit |
| --- | ---------------- | ---------------------- | ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Proposal #       | `proposalNumber`       | `number?`  | `TextField` type=text                                        | `fmtVal` → `String(v).toUpperCase()`                                                  | **string (bug)**          |
| 2   | Description      | `proposalDescription`  | `string?`  | `TextField`                                                  | uppercased                                                                            | string                    |
| 3   | Job              | `job`                  | `string?`  | `TextField`                                                  | uppercased                                                                            | string                    |
| 4   | CO #             | `coNumber`             | `number?`  | `TextField` type=text                                        | uppercased                                                                            | **string (bug)**          |
| 5   | Owner            | `proposalOwner`        | `string?`  | `TextField`                                                  | uppercased                                                                            | string                    |
| 6   | Job-Site Address | `jobSiteAddress`       | `string?`  | `TextField`                                                  | uppercased                                                                            | string                    |
| 7   | City             | `projectCity`          | `string?`  | `TextField`                                                  | uppercased                                                                            | string                    |
| 8   | State            | `projectState`         | `string?`  | `Select` over `UnitedStatesStates` (51 entries incl. `None`) | uppercased                                                                            | string                    |
| 9   | Estimator(s)     | `proposalEstimators`   | `string?`  | `TextField` (free text, comma-jammed)                        | uppercased                                                                            | string                    |
| 10  | Date Received    | `proposalDateReceived` | `string?`  | `TextField type='date'`, value `.slice(0,10)`                | `fmtDate` → `MM/dd/yyyy` via date-fns `parseISO`; falls back to raw string if invalid | `yyyy-MM-dd` string       |
| 11  | Due Date         | `proposalDateDue`      | `string?`  | `TextField type='date'`                                      | same                                                                                  | string                    |
| 12  | Project Start    | `projectStartDate`     | `string?`  | `TextField type='date'`                                      | same                                                                                  | string                    |
| 13  | Project End      | `projectEndDate`       | `string?`  | `TextField type='date'`                                      | same                                                                                  | string                    |
| 14  | Bid Type         | `bidType`              | `string?`  | `Select` over `BidType`                                      | uppercased                                                                            | string                    |
| 15  | Status           | `proposalStatus`       | `string?`  | `Select` over `ProposalStatus`                               | uppercased                                                                            | string                    |

### 3.2 Contact Information section

| #   | Label        | field            | Model type | Edit widget                                                                                                                                                                                                   | Read rendering                                |
| --- | ------------ | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 16  | Contact Name | `contactName`    | `string?`  | `TextField`                                                                                                                                                                                                   | uppercased                                    |
| 17  | Phone        | `contactPhone`   | `string?`  | `PatternFormat format='(###) ###-####' mask='_'`, `isAllowed: value.length<=10`, stores **digits only** via `sanitizePhoneDigits` (strips non-digits, drops a leading `1` on 11-digit input, truncates to 10) | `formatPhone` → `(555) 123-4567`, else raw    |
| 18  | Email        | `contactEmail`   | `string?`  | `TextField` (plain text, **no `type='email'`, no validation**)                                                                                                                                                | **uppercased** — emails are displayed in caps |
| 19  | Address      | `contactAddress` | `string?`  | `TextField`                                                                                                                                                                                                   | uppercased                                    |
| 20  | City         | `contactCity`    | `string?`  | `TextField`                                                                                                                                                                                                   | uppercased                                    |
| 21  | Zip          | `contactZip`     | `number?`  | `TextField` (text)                                                                                                                                                                                            | uppercased; **saved as string**               |
| 22  | State        | `contactState`   | `string?`  | `Select` over `UnitedStatesStates`                                                                                                                                                                            | uppercased                                    |

**22 fields total.** Every one is optional; **there is no validation of any kind** — no required
fields, no email/zip/phone format checks (beyond the phone mask), no date ordering check (Project
End can precede Project Start), no duplicate-proposal-number check.

### 3.3 Enums (`models/proposal.ts:113-185`)

- `BidType`: `None`, `Lump Sum`, `Time and Materials`, `Budgetary`, `Rates`, `Cost Plus`
- `ProposalStatus`: `None`, `Bidding`, `Submitted`, `Awarded`, `Rejected`, `Declined`, `Open`,
  `Closed` (note: `proposal_select.tsx` `STATUS_CONFIG` has colors for only 6 of these — `None` and
  **`Closed` have no chip styling** and fall through to the gray default)
- `UnitedStatesStates`: `None` + all 50 states, stored as **full display names** ("California", not
  "CA")

### 3.4 Fields that exist on the model but are NOT editable anywhere on this screen

`id`, `datasetVersions` (`{labor|phases|wbs|equipment: 'v1'|'v2'}`, set at creation from
`CURRENT_DATA_VERSION='v2'`), `customQuantity`, `customUnit`, and the derived aggregates that
`Proposal` inexplicably also declares (`quantity`, `unit`, `craftManHours`, `craftCost`,
`welderManHours`, `welderCost`, `materialCost`, `equipmentCost`, `subContractorCost`,
`costOnlyCost`, `totalCost` — `models/proposal.ts:50-74`).

---

## 4. Tab 1 — "Rates" (proposal_rates.tsx): all 15 rate fields

Header "RATES CONFIGURATION" + the same Edit / Cancel / Save trio. Four visually grouped sections,
`Grid xs=6 sm=4 md=3` (4 per row at desktop).

Read mode formatting: `` `${prefix}${parseFloat(v ?? '0').toFixed(2)}${suffix}` `` — so `0` renders
as `$0.00` / `0.00%`, and `undefined`/`null` renders as an em-dash. Edit mode: bare `TextField` with
an `InputAdornment` for `$` or `%`. **No numeric input mask, no min/max, no step, no
`type='number'`** — you can type `abc` and it will be saved.

### 4.1 Section "Base Labor Rates" ($ amounts)

| #   | UI label         | field             | Firestore type | Default | Meaning                                         | Consumed by                                                                                         |
| --- | ---------------- | ----------------- | -------------- | ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Craft Base Rate  | `craftBaseRate`   | number         | `0`     | $/craft man-hour, unburdened                    | `getCraftLoadedRate`; default for every activity's `craftBaseRate`; default in `EditBaseRateDialog` |
| 2   | Weld Base Rate   | `weldBaseRate`    | number         | `0`     | $/welder man-hour, unburdened                   | `getWelderLoadedRate`; DD `baseCost`                                                                |
| 3   | Rig Rate         | `rigRate`         | number         | `0`     | $/welder man-hour paid for the welder's rig     | `getWelderLoadedRate`; DD `rigCost`                                                                 |
| 4   | Subsistence Rate | `subsistenceRate` | number         | `0`     | $/man-hour per-diem, added flat (NOT marked up) | `getCraftLoadedRate`, `getWelderLoadedRate`; DD `subsistence`; `EditBaseRateDialog`                 |

### 4.2 Section "Overhead & Burden" (% applied to base labor)

| #   | UI label         | field             | Default | Consumed by                                    |
| --- | ---------------- | ----------------- | ------- | ---------------------------------------------- |
| 5   | Burden Rate      | `burdenRate`      | `0`     | craft + welder loaded rate; DD `burden` column |
| 6   | Overhead Rate    | `overheadRate`    | `0`     | craft + welder loaded rate; DD `overhead`      |
| 7   | Consumables Rate | `consumablesRate` | `0`     | craft + welder loaded rate; DD `consumables`   |
| 8   | Fuel Rate        | `fuelRate`        | `0`     | craft + welder loaded rate; DD `fuel`          |

### 4.3 Section "Tax Rates" (%)

| #   | UI label               | field          | Default | Consumed by                                                                                                                                                                             |
| --- | ---------------------- | -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Sales Tax Rate         | `salesTaxRate` | `0`     | `getMaterialCost`; `getSubcontractorCost` (material leg); DD `salesTax` (material leg)                                                                                                  |
| 10  | **Equipment Tax Rate** | `useTaxRate`   | `0`     | `getEquipmentCost` (non-owned only); DD `salesTax` (equipment leg). **Labeled "Use Tax" in the dead accordion and "USE TAX" in the Excel export — three different names for one field** |

### 4.4 Section "Profit Margins" (%)

| #   | UI label             | field                     | Default | Consumed by                                                       |
| --- | -------------------- | ------------------------- | ------- | ----------------------------------------------------------------- |
| 11  | Labor Profit         | `laborProfitRate`         | `0`     | craft + welder loaded rate; DD `laborProfit`                      |
| 12  | Material Profit      | `materialProfitRate`      | `0`     | `getMaterialCost`; DD `profitTotal`                               |
| 13  | Equipment Profit     | `equipmentProfitRate`     | `0`     | `getEquipmentCost` (non-owned); DD `profitTotal`                  |
| 14  | Subcontractor Profit | `subContractorProfitRate` | `0`     | `getSubcontractorCost`; DD `profitTotal`                          |
| 15  | Rig Profit           | `rigProfitRate`           | `0`     | `getWelderLoadedRate` (marks up `rigRate` only); DD `profitTotal` |

**= 15 rate fields.** All four `$` fields and eleven `%` fields default to `0`, meaning **a freshly
created proposal computes every cost as $0.00** until a human manually types 15 numbers. There is no
template, no company default, no copy-rates-from-another-proposal, no last-used memory.

---

## 5. Exact cost formulas the rates drive (`api/totals.ts`, `utils/utils.ts`)

All percentages are whole numbers divided by 100 at the point of use.

```
craftLoadedRate =
    craftBase
  + craftBase * (burdenRate + overheadRate + laborProfitRate + fuelRate + consumablesRate) / 100
  + subsistence

  where craftBase   = customCraftBaseRate  || proposal.craftBaseRate
        subsistence = customSubsistenceRate || proposal.subsistenceRate
```

`totals.ts:26-27` uses **`||`, not `??`** → a per-activity override of **`0` silently falls back to
the proposal rate**. You cannot zero out an activity's base rate or subsistence.

```
welderLoadedRate =
    weldBaseRate
  + weldBaseRate * (burdenRate + overheadRate + laborProfitRate + fuelRate + consumablesRate) / 100
  + subsistenceRate
  + rigRate
  + rigRate * rigProfitRate / 100
```

No per-activity override exists for the welder side.

```
craftCost   = craftManHours  * craftLoadedRate      (skipped for subContractorItem)
welderCost  = welderManHours * welderLoadedRate

craftManHours  = quantity * craftConstant
welderManHours = quantity * welderConstant

materialCost      = quantity * price * (1 + (materialProfitRate + salesTaxRate)/100)
equipmentCost     = ownership == Owned
                      ? quantity * time * price
                      : quantity * time * price * (1 + (equipmentProfitRate + useTaxRate)/100)
subContractorCost = quantity * ( craftCost     * (1 + subP)
                               + materialCost  * (1 + subP + salesTax)
                               + equipmentCost * (1 + subP) )
                    where subP = subContractorProfitRate/100, salesTax = salesTaxRate/100
costOnlyCost      = quantity * price
totalCost         = craftCost + welderCost + materialCost + equipmentCost
                    + subContractorCost + costOnlyCost
                    (for subContractorItem: totalCost = subContractorCost only)
```

`getSubcontractorCost` destructures `useTaxRate` and never uses it (`totals.ts:106`) — dead
parameter.

**Activity types** (`models/activity.ts:138-145`): `laborItem`, `materialItem`, `equipmentItem`,
`subContractorItem`, `costOnlyItem`, `customLaborItem`. **Equipment ownership**
(`models/equipment.ts:38-42`): `Rental`, `Owned`, `Purchase`.

### Roll-ups feeding this screen's grid

`calculateTotals(activities)` → phase totals (`utils.ts:280-315`). Subcontractor items are
**excluded** from `materialCost`, `equipmentCost`, `craftCost` accumulation but **NOT** from
`welderCost`, `craftManHours`, `welderManHours` — an asymmetry that means a sub item with welder
hours double-counts into welder cost while its craft cost is suppressed.

`calculateWbsTotals(phases)` → WBS totals (`utils.ts:331-360`): plain sums of all 9 cost/hour
fields + `quantity`; `unit` is carried as `''` (always blank from this function; the real unit comes
from the separate derivation below).

### Derived WBS quantity / unit (`store.ts:168-174`, `utils.ts:198-246`)

```
wbs.quantity = wbs.customQuantity ?? getQuantityAndUnit(activitiesOfThatWbs, wbsDatabaseId).quantity
wbs.unit     = wbs.customUnit     ?? getQuantityAndUnit(...).unit
```

`getQuantityAndUnit` is hard-coded keyword matching on activity **descriptions**:

| wbsDatabaseId                         | rule                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20000 (SITE PREPARATION)              | sum quantity of activities whose description contains `EXCAVATE` or `BACKFILL / COMPACT`                                                                 |
| 30000 (CONCRETE)                      | unit = `EA` if the activity's constant `phaseDatabaseId ∈ {30011,30012,30013,30015}` else `CY`; quantity = sum where description matches `/clean\s*up/i` |
| 40000, 50000, 60000                   | keyword `CLEAN UP`                                                                                                                                       |
| 70000 (AG PIPING), 130000 (BG PIPING) | keyword `HE` (a bare two-letter substring match — matches "THE", "HEAT", etc.)                                                                           |
| everything else                       | quantity 0, unit `''`                                                                                                                                    |

It also `console.log`s on every activity of every WBS on every load (`utils.ts:244`).

`wbs.completed` = `relatedPhases.length > 0 && every(phase.completed)` (`store.ts:158-161`).

---

## 6. Save semantics, validation, permissions

### 6.1 How a save works

1. `handleSaveClick` fires on the Save button. No disabled/pending state → **double-click issues two
   writes**.
2. `updateSingleProposal` does `setDoc(ref, {...editData})` — **full overwrite**. Consequences:
   - Any field another user wrote between your page load and your save is **silently destroyed**
     (classic lost update). There is no version/etag/transaction.
   - `editData` originates from `getSingleProposal`, which **injects `id` into the object**
     (`api/proposal.ts:87`), so every save writes a redundant `id` field into the document.
   - Derived aggregates present on the doc are re-written verbatim.
3. Success → a bare `<Dialog>` containing an
   `<Alert severity='success'>Proposal information successfully saved.</Alert>` with **no OK
   button** — dismissed only by clicking the backdrop or pressing Esc (`proposal_home.tsx:210-216`).
4. Then `await loadFullProposalData(proposalId)` re-reads **every WBS, phase and activity in the
   proposal** and recomputes all costs client-side — to persist two text fields.
5. On failure: `console.error` only. The user sees the form leave edit mode as if it worked...
   actually no — `setIsEditMode(false)` is inside the `try` after the `await`, so on error the form
   stays in edit mode with **no message at all**.

### 6.2 Type coercion (the core data-integrity bug)

`handleChange` writes `e.target.value`, a **string**, into `editData`. Nothing coerces before
`setDoc`.

- All 15 rates are therefore persisted as **strings** (`"45.5"`) whenever they are edited through
  this screen.
- `proposalNumber`, `coNumber`, `contactZip` are likewise persisted as strings.
- `getSingleProposal` masks this on read via `convertRatesToNumbers` (`api/proposal.ts:40-76`),
  which `parseFloat`s a hard-coded list of 24 fields. **`proposalNumber`, `coNumber` and
  `contactZip` are NOT in that list** → they stay strings forever.
- Downstream damage: `proposal_select.tsx:74` sorts with
  `(b.proposalNumber||0) - (a.proposalNumber||0)` → `NaN` for string values → unstable ordering of
  the proposal dashboard; `add_proposal_dialog.tsx:29-33` computes the next number with
  `Math.max(...parseFloat(...))`, which happens to survive.
- `useCurrentProposalListener` and `useProposals` read raw docs with **no conversion**, so any
  consumer of those hooks sees the raw string types.

### 6.3 Validation

**None.** No required fields, no numeric guards on rates (a typo'd `4.5.5` becomes `NaN` after
`parseFloat` on read and silently zeroes every cost in the proposal), no range checks (a 5000%
burden is accepted), no confirmation when changing a rate that will re-price an entire estimate.

### 6.4 Permissions

`useUserProfile()` (`hooks/user_profile_hook.ts`) reads `users/{uid}` once and exposes `isAdmin`
(`role === ADMIN`) and `hasWritePermissions` (`permission === READ_WRITE`).

**The live Details and Rates tabs never call `useUserProfile`.** A read-only user sees the Edit
button, can type into every field and click Save; the write is only stopped (if at all) by Firestore
security rules. The **dead** accordion components _did_ honor `hasWritePermissions`
(`InputProps={{readOnly: !hasWritePermissions}}`) — the permission check was lost in the rewrite.
`WbsDataGrid` and `BottomPanel` do still check it.

---

## 7. Tab 2 — WBS Data Grid (`wbs_data_grid.tsx`)

### 7.1 Data source

`estimatorStore.visibleWbs[proposalId]` — i.e. only WBS whose `name` appears in
`preferences.wbsToDisplay` (`store.ts:184-189`, `264-274`). Sorted ascending by `wbsDatabaseId` in a
local `useEffect` (`wbs_data_grid.tsx:40-43`). Max 18 rows (the fixed WBS taxonomy).
`pageSize={100}`.

### 7.2 Columns (all `editable: false`)

| #   | `field`             | Header          | Visible by default | Align | Formatter            |
| --- | ------------------- | --------------- | ------------------ | ----- | -------------------- |
| 1   | `name`              | Wbs             | yes                | left  | —                    |
| 2   | `quantity`          | Quantity        | yes                | right | `toLocaleString` 2dp |
| 3   | `unit`              | Units           | yes                | right | —                    |
| 4   | `craftManHours`     | Craft MH        | yes                | right | 2dp                  |
| 5   | `craftCost`         | Craft Total     | yes                | right | `$` + 2dp            |
| 6   | `welderManHours`    | Welder MH       | yes                | right | 2dp                  |
| 7   | `welderCost`        | Welder Total    | yes                | right | `$` + 2dp            |
| 8   | `materialCost`      | Material Total  | **`hide: true`**   | right | `$` + 2dp            |
| 9   | `equipmentCost`     | Equip Total     | **`hide: true`**   | right | `$` + 2dp            |
| 10  | `subContractorCost` | Sub Total       | **`hide: true`**   | right | `$` + 2dp            |
| 11  | `costOnlyCost`      | Cost Only Total | **`hide: true`**   | right | `$` + 2dp            |
| 12  | `totalCost`         | Total           | yes                | right | `$` + 2dp            |

All `flex: 1` with `minWidth` 80–120, `headerAlign: 'center'`. There is **no total/footer row** —
the only proposal-level total is in the bottom panel. Column visibility is **not persisted** (unlike
the phase-level activity grid, which stores a visibility model per user+phase in Firestore via
`api/helpers.ts`).

### 7.3 Toolbar (`CustomToolbar`)

Left group: `GridToolbarColumnsButton` (show/hide columns), `GridToolbarDensitySelector`
(compact/standard/comfortable), `<ExportMenu>` ("Data Dump"). Right: a plain **`WBS Select`** button
opening `SelectWbsDialog`. No search/filter, no CSV export, no "add WBS", no refresh.

### 7.4 Editing machinery — present but 100% inert

- `onCellEditCommit` → uppercases non-numeric strings (`numberFields` allow-list) →
  `updateWbs(id, field, value)` → `updateDoc` on `wbs/{id}` (`api/wbs.ts:61-81`).
- `isCellEditable` → false if `!hasWritePermissions` or field ∈ `notEditableCells` (the 9 cost/hours
  fields).
- `getCellClassName` → adds `completed-row ` and/or `editable-cell`.

**But every column declares `editable: false`**, and MUI DataGrid requires column-level
`editable: true` for any cell to enter edit mode. So `onCellEditCommit` can never fire, `updateWbs`
is unreachable from this screen, and the whole permission branch is dead. Users therefore **cannot
set a WBS `customQuantity` or `customUnit` from anywhere in the UI** even though the model and the
roll-up logic support them (`store.ts:168-174`).

### 7.5 Row styling and interaction

- `getRowClassName` → `completed-row-light` / `completed-row-dark` (alternating pale green `#f0fdf4`
  / `#ecfdf5`) when `row.completed`.
- The `sx` block also defines `.under` (amber), `.over` (red), `.not-used` (gray + line-through),
  and `.completed-row` — **none of these class names are ever emitted**. Dead CSS copied from the
  activity grid.
- `onSelectionModelChange` stores `selectedRows`, which is **never read**. Dead state.
- **No `onRowClick` / `onRowDoubleClick`** → clicking a WBS row does nothing. To open a WBS you must
  use the drawer's WBS dropdown. This is the single most jarring interaction gap on the screen.
- `wbsId`/`phaseId` are destructured from `useParams()` and unused.

---

## 8. "WBS Select" dialog (`select_wbs_dialog.tsx`)

Purpose: choose which of the 18 WBS categories are _visible_ — this drives the grid on this screen,
the drawer's WBS dropdown, the bottom-panel totals, and **what gets included in the Excel export**.
It is effectively a scope filter masquerading as a display preference.

- Modal, `minHeight 60vh / maxHeight 80vh`, fixed `400×400` content box.
- Title area contains a `<Input placeholder='Search WBS...' autoFocus>` bound to a `search` state
  that is **never used to filter the list** (`select_wbs_dialog.tsx:32, 83`) — **the search box does
  nothing**.
- List source is the hard-coded `WbsArray` from `utils/enums.ts`, **not** the proposal's actual WBS
  documents, sorted by `wbsDatabaseId`. `.sort()` is called directly on the exported module-level
  array, mutating shared state.
- Each row: `Checkbox` + WBS name. Toggling mutates a local `checked: string[]` **of names, not
  IDs**.
- `Cancel` closes without saving; `Save` builds `{...proposalPreferences, wbsToDisplay: checked}`
  and calls `store.setPreferences(proposal.id, prefs)` → optimistic store update →
  `debouncedUpdateProposalPreferencesInFirestore` (300 ms, `newAPI/debounced.ts`) →
  `setDoc(..., {merge:true})` → `setVisibleWbs(proposalId)` recomputes the visible list.
- `updateProposalPreferences` from `api/proposal_preferences.ts` is left commented out at line 67 —
  the legacy path.

The 18 WBS categories and their `wbsDatabaseId`s (`utils/enums.ts`, mirrored in
`data/v1/wbs_v1.json`):

| id    | name                     |     | id     | name               |
| ----- | ------------------------ | --- | ------ | ------------------ |
| 10000 | MOBILIZE                 |     | 100000 | INSULATION         |
| 20000 | SITE PREPARATION         |     | 110000 | PAINTING           |
| 30000 | CONCRETE                 |     | 120000 | DISMANTLING        |
| 40000 | TOWERS/VESSELS/EQUIPMENT |     | 130000 | BG PIPING          |
| 50000 | PUMPS & DRIVERS          |     | 140000 | REFRACTORY         |
| 60000 | STRUCTURAL               |     | 150000 | BUILDINGS          |
| 70000 | AG PIPING                |     | 180000 | SPECIALTY SERVICES |
| 80000 | ELECTRICAL               |     | 190000 | DEMOBILIZE         |
| 90000 | INSTRUMENTS              |     | 200000 | SUPPORT            |

Indirect WBS (used by the bottom panel to split direct vs indirect hours, `bottom_pannel.tsx:29`):
`{10000 MOBILIZE, 190000 DEMOBILIZE, 200000 SUPPORT, 180000 SPECIALTY SERVICES}`.

Fragility: `proposal_home.tsx:34-36` passes `state.preferences[proposalId] || []` — an **array** as
the fallback for an object type. If preferences haven't loaded, `SelectWbsDialog` receives `[]`,
`setChecked(undefined)` runs, `handleToggle` would throw on `checked.filter`, and `handleSave` would
spread an array producing a prefs object with **no `id`**, making
`doc(firestore, 'proposal-preferences', undefined)` throw.

Duplicate sources of truth: `WbsDataGrid` separately calls `useProposalPreferences(proposalId)`
which opens **another** `onSnapshot` on the same document (and creates the doc if missing) purely to
hand preferences to the export menu, while the grid rows come from the Zustand store.

---

## 9. Export menu / "Data Dump" (`export_menu.tsx` + `api/data_dump.ts`)

### 9.1 UI

A `Button` labelled **"Data Dump"** with a `SaveAlt` icon opening a `Menu` with exactly **one**
item: **"WBS Cost Report"**. Clicking it sets a full-screen `Backdrop` + `CircularProgress` (modal,
cannot be cancelled) and awaits `fetchDD(proposalId, proposalPreferences)`.

### 9.2 What `fetchDD` does (`data_dump.ts:37-249`)

1. `getSingleProposal(proposalId)`.
2. `fetchDDActivities` — query `activities where proposalId ==`, then for **each** doc
   `calculateActivityData(...)` (a near-duplicate of `processRawActivity`) and
   `activityToDataDumpItem(...)`. Note `getSingleProposal` is called **again** inside this function.
3. `fetchDDPhases` — query `phase where proposalId ==`, and for **every phase** calls
   `getSingleWbs({wbsId})` — a **classic N+1**: one extra Firestore document read per phase, in a
   `Promise.all` fan-out.
4. `fetchDDWbs` — query `wbs where proposalId ==`, keeping only WBS whose `name` is in
   `preferences.wbsToDisplay`, then dropping any WBS with zero phases. **Anything hidden in WBS
   Select is silently absent from the report.**
5. Builds an array-of-arrays worksheet and writes it with `xlsx-js-style`, then
   `@tauri-apps/api/dialog.save()` with default filename `` `./${proposalNumber}-WBS-Cost-Report` ``
   (filter: Excel Workbook `.xlsx`) and `writeBinaryFile`.

### 9.3 Sheet layout

- Sheet name: **`'readme demo'`** (leftover scaffold name).
- Rows 1–7: proposal header block, labels right-aligned in col 32, values merged across cols 32→36:
  `Proposal #:` = `proposalNumber` · `Job #:` = `job` · `Change #:` = **never populated** (the
  assignment is commented out at `data_dump.ts:117`) · `Description:` = `proposalDescription` ·
  `Owner:` = `proposalOwner` · `Location:` = `` `${projectCity}, ${projectState}` `` · `Date:` =
  today formatted `Month D, YYYY`.
- Row 8: `topMarkupLabels` — `RIG` (col 18), `USE TAX` (col 35).
- Row 9: `topMarkups` — `$rigRate`, `useTaxRate%`.
- Row 10: the 37-column data header:
  `WBS, PHASE, SIZE, FLC, LINE / DESCRIP, SPEC, INSUL, INSL. SIZE, SHT, AREA, STATUS, SYS, SPCL RATE, SPCL SUB, OWNERSHIP, QTY, UNIT, CRAFT, WELD, SUB, TOTAL, BASE, BURDEN, OVERHEAD, LABOR PROFIT, FUEL, CNSMBLE, SUBSIST, LABOR, RIGS, MATERIAL, EQUIP, SUBS, COST ONLY, PROFIT TOTAL (R/M/E/S), SALES TAX, TOTAL`
- Row 11: `bottomMarkups` — the rate stamp: `$weldBaseRate`(18), `$craftBaseRate`(21),
  `burdenRate%`(22), `overheadRate%`(23), `laborProfitRate%`(24), `fuelRate%`(25),
  `consumablesRate%`(26), `$subsistenceRate`(27), `rigProfitRate%`(29), `materialProfitRate%`(30),
  `equipmentProfitRate%`(31), `subContractorProfitRate%`(32), `salesTaxRate%`(35). **All 15 rates
  are stamped into the export header** (rig + use tax on row 9, the other 13 here).
- Then, for each WBS (sorted by `wbsDatabaseId`): a WBS row (blue `ddebf7`, 14 pt bold), then each
  phase (yellow `fff2cc`, 12 pt bold) sorted by `phaseNumber`, then each activity (10 pt) sorted by
  `sortOrder`.
- Final row: a green `e2eeda` grand-total summary row summing all WBS rows.
- Keys skipped when serializing rows:
  `doNotInclude = ['phaseId','wbsId','proposalId','phases','activities']`.
- Medium right borders after: `sys`, `ownership`, `totalMH`, `subsistence`, `subcontractorCost`,
  `costOnlyCost`, `salesTax`.
- Currency cells get Excel accounting format `_("$"* #,##0.00_);…`; `0`/null currency cells render
  as `-`, other zero/null cells render as `''`.
- Column widths and the first 11 row heights are pinned; 8 merge ranges for the header block.

### 9.4 The export re-derives costs with DIFFERENT math (`activityToDataDumpItem`, `data_dump.ts:539-676`)

```
baseCost      = (customCraftRate ?? craftBaseRate) * craftMH + weldBaseRate * welderMH
burden        = burdenRate/100      * baseCost
overhead      = overheadRate/100    * baseCost
laborProfit   = laborProfitRate/100 * baseCost
fuel          = fuelRate/100        * baseCost
consumables   = consumablesRate/100 * baseCost
subsistence   = (craftMH + welderMH) * (customSubsistenceRate ?? subsistenceRate)
rigCost       = rigRate * welderMH
laborCost     = baseCost + burden + overhead + laborProfit + fuel + consumables + subsistence
materialCost  = materialItem  ? quantity * price              : 0     ← NO profit/tax here
equipmentCost = equipmentItem ? quantity * time * price       : 0     ← NO profit/tax here
subCost       = subItem ? quantity * (craftCost + equipmentCost + materialCost) : 0  ← NO profit
profitTotal   = materialProfitRate/100 * materialCost
              + rigProfitRate/100      * rigCost
              + equipmentProfitRate/100* equipmentCost
              + subContractorProfitRate/100 * subCost
salesTax      = materialCost * salesTaxRate/100 + equipmentCost * useTaxRate/100
total         = laborCost + rigCost + materialCost + equipmentCost + subCost
              + costOnlyCost + profitTotal + salesTax
if (owned equipment) { profitTotal = null; total = equipmentCost }
```

This is a **second, independent cost engine**. It decomposes profit/tax into separate columns rather
than folding them into the line cost, and it does **not** use
`getMaterialCost`/`getEquipmentCost`/`getSubcontractorCost` at all. The subcontractor treatment in
particular differs materially from the on-screen `getSubcontractorCost` (which applies `(1+subP)`
per leg plus sales tax on the material leg). Any Precision rewrite must decide which one is
"correct" and make the screen and the report agree.

`currencyRound(n) = parseFloat((Math.round(n*100)/100).toFixed(2))` (`api/helpers.ts:112`) is
applied per line, so rounding accumulates upward through phase → WBS → grand total.

---

## 10. `EditBaseRateDialog` (`src/components/edit_base_rate_dialog.tsx`)

Not reachable from Proposal Home — it lives on the **Phase Home** activity grid
(`activity_data_grid.tsx:1343`) — but it is the _only_ per-activity rate override UI and it reads
its defaults from the proposal rates, so it belongs in this area's parity picture.

- Trigger: select one or more activity rows in the activity grid, open "Edit Rates".
- Fields: two `FormattedNumberInput`s — **Base Rate** (`$`, → `activity.craftBaseRate`) and
  **Subsistence** (`$`, → `activity.subsistenceRate`). Both default to
  `activities[0]?.X ?? currentProposal?.X ?? 0`.
- Enable rules (`edit_base_rate_dialog.tsx:80-121`) — the dialog disables itself if **any** selected
  activity fails all three of:
  - `activity.activityType === customLaborItem`, or
  - `currentWbs.wbsDatabaseId === 200000` (SUPPORT), or
  - `currentPhase.phaseDatabaseId ∈ {'180002','180003','180004'}` — i.e. custom rates are only
    allowed on custom-labor items, the SUPPORT WBS, or three specific Specialty-Services phases
    (**hard-coded magic strings, phase IDs compared as strings**).
- With multiple rows selected it additionally requires all selected activities to already share the
  same `craftBaseRate` **and** `subsistenceRate`, else the dialog is disabled with no explanation.
- Fetching: on every `selectedRowIds` change it issues **one `getSingleActivity` Firestore read per
  selected row** (`Promise.all` over ids) — N+1 on a dialog open, even though those activities are
  already in the Zustand store.
- Save → `store.updateActivityRates(ids, baseRate, sub)` → batch write + local recompute via
  `processRawActivity` → `recalculatePhase(phaseId)` → close.
- No validation; there is **no way to clear an override back to "inherit from proposal"** (and
  because of the `||` bug in `getCraftLoadedRate`, entering `0` also just re-inherits).

---

## 11. Bottom panel (`components/bottom_pannel.tsx`) — always visible on this screen

Scope-aware dataset: activities of the current phase → phases of the current WBS → **`visibleWbs`**
at proposal level (`bottom_pannel.tsx:186-190`).

Status bar stats: **Total Cost**, **Total Hrs**, **Direct**, **Indirect**, **Sub Hrs**. Expandable
"Details" (state persisted in `localStorage['bottomPanelDetailsOpen']`) shows 3 mini-tables:

- _Hours_: Craft, Welder, Support, Mobe/Demobe, Specialty, Subcontractor, Total
- _Labor Costs_: Craft, Weld & Rig, Subcontractor
- _Other Costs_: Equipment, Material, Cost Only

Direct vs indirect split: hours in WBS `10000/190000/200000/180000` are indirect (bucketed to Mobe /
Demobe / Support / Specialty); everything else is direct craft/welder. Sub hours =
`Σ quantity × time` over `subContractorItem` activities.

**"Hidden WBS data" warning chip**: if any WBS **not** in `wbsToDisplay` has
`totalCost > 0 || craftManHours > 0 || welderManHours > 0`, an amber warning appears — an explicit
acknowledgement that the WBS Select filter silently excludes real money from the totals _and_ from
the export.

Quick-add bar (only when `hasWritePermissions` and inside a WBS/phase): at phase level — Activity
(primary), Equipment, Material, Cost Only, Custom Labor, Subcontractor; at WBS level — Phase. **At
proposal level the quick-add bar renders nothing**, so Proposal Home has zero creation affordances.

---

## 12. Data model reference

### `Proposal` (`models/proposal.ts`) — all optional, `Object.assign` constructor

`id, proposalNumber:number, job:string, coNumber:number, proposalDescription, proposalOwner, projectCity, projectState, jobSiteAddress, proposalEstimators, proposalDateReceived, proposalDateDue, projectStartDate, projectEndDate, bidType, proposalStatus, contactName, contactAddress, contactCity, contactState, contactZip:number, contactPhone, contactEmail, quantity, customQuantity, unit, customUnit, craftManHours, craftCost, welderManHours, welderCost, materialCost, equipmentCost, subContractorCost, costOnlyCost, totalCost, craftBaseRate, weldBaseRate, subsistenceRate, useTaxRate, salesTaxRate, overheadRate, consumablesRate, burdenRate, fuelRate, rigRate, laborProfitRate, materialProfitRate, equipmentProfitRate, subContractorProfitRate, rigProfitRate, datasetVersions`

### `FirestoreProposal` (`models/firestore models/proposal_firestore.ts`) — the write shape

Nullable strings/numbers for descriptive fields; **all 15 rates typed `number` and defaulted to
`0`**; the aggregate cost fields (`craftCost`, `totalCost`, …) are **not** part of this class even
though the live save path writes them back.

### `ProposalPreferences` (`models/proposal_preferences.ts`)

`{ id?: string|null; wbsToDisplay?: string[]|null }` — stored in collection `proposal-preferences`,
document id = proposalId. Only one preference exists in the whole app.

### `Wbs` (`models/wbs.ts`)

`id, proposalId, wbsDatabaseId:number, name, quantity, customQuantity, customUnit, unit, craftManHours, craftCost, welderManHours, welderCost, materialCost, equipmentCost, subContractorCost, costOnlyCost, totalCost, completed:boolean`

### Firestore collections touched

`proposals`, `wbs`, `phase` (singular!), `activities`, `proposal-preferences`, `users`,
`visibilityModels/{userId}_{phaseId}`.

---

## 13. UX problems observed (with evidence)

**Severity: high**

1. **A modal edit-mode toggle for a whole form.** Nothing on Details or Rates is editable until you
   find and press a small `Edit` button in the corner; then the entire page re-renders as inputs. No
   inline/click-to-edit, no per-field editing, no autosave. `proposal_details.tsx:124-141`,
   `proposal_rates.tsx:115-131`.
2. **Edit mode is shared across two tabs, and so is Save.** `isEditMode` and `editData` live in
   `proposal_home.tsx:28-29`. Pressing Edit on Rates also unlocks Details; pressing Save on Rates
   writes the Details fields too; pressing Cancel on either tab discards edits made on the other.
3. **Blocking, full-overwrite save with lost-update semantics.** `setDoc` (`api/proposal.ts:104`)
   replaces the document. Two estimators editing the same proposal clobber each other with no
   warning. Then `loadFullProposalData` re-reads _every activity in the proposal_ to confirm a
   two-field change (`proposal_home.tsx:71`).
4. **No validation at all.** No required fields, no numeric constraint on the 15 rate inputs (plain
   `TextField`, no `type='number'`), no email/zip checks, no date-order checks. A typo in a rate
   silently re-prices the entire estimate on next load.
5. **Everything defaults to zero.** A new proposal has `craftBaseRate: 0 … rigProfitRate: 0`
   (`proposal_firestore.ts:192-206`) — the whole estimate is $0.00 until a human types 15 numbers
   with no template, no company default, no "copy rates from proposal X".
6. **Read-only users can enter edit mode and click Save.** The live tabs never consult
   `hasWritePermissions`; the dead accordions did. Regression introduced by the rewrite.
7. **New proposals show an empty WBS grid.** `insertProposalPreferences` writes `wbsToDisplay: []`
   (and builds a `tempArray` of all WBS names that it then throws away —
   `api/proposal_preferences.ts:9-18`). The user must discover the "WBS Select" button before
   anything appears anywhere in the app.
8. **The visibility filter is load-bearing and silently excludes money.** `wbsToDisplay` filters the
   grid, the drawer dropdown, the bottom-panel totals _and_ the Excel export (`data_dump.ts:463`).
   The app itself admits this with the amber "Hidden WBS data" warning in the bottom panel
   (`bottom_pannel.tsx:478-487`).
9. **WBS rows are not clickable.** No `onRowClick` in `wbs_data_grid.tsx`. The only way into a WBS
   is the drawer dropdown — a completely different region of the screen from the table listing those
   WBS.
10. **The Excel export uses different formulas than the screen.** §9.4. Numbers reviewed on screen
    and numbers handed to a customer can disagree.

**Severity: medium**

11. **The "Search WBS…" input in WBS Select does nothing.** `search` state is written but never read
    (`select_wbs_dialog.tsx:32, 83`). 18 rows in a 400 px box with a decoy search field.
12. **Success confirmation is a button-less modal.** `<Dialog><Alert/></Dialog>` with no action and
    no auto-dismiss (`proposal_home.tsx:210-216`) — the user must click the backdrop. A toast is the
    obvious right answer.
13. **Silent failure.** Save errors only `console.error` (`proposal_home.tsx:73`); the form just
    stays in edit mode.
14. **Tab position is stored globally, not per proposal.** `sessionStorage['activeTab']`
    (`proposal_home.tsx:52-57, 112`) — open a different proposal and you land wherever you last
    were, possibly a WBS grid instead of the proposal's identity.
15. **Read mode uppercases everything, including email addresses.** `fmtVal` does `.toUpperCase()`
    _and_ the `Typography` sets `textTransform: 'uppercase'` (`proposal_details.tsx:42, 82`).
    `john@acme.com` displays as `JOHN@ACME.COM`. Meanwhile the stored value keeps its original case
    — display and data disagree.
16. **No keyboard support whatsoever.** No shortcut to enter edit mode, no Cmd/Ctrl+S to save, no
    Esc to cancel, no Enter-to-commit, no focus management when the form swaps to inputs, no
    tab-order thought. (Verified by absence: there is not a single `onKeyDown`/`useHotkeys` anywhere
    in this feature folder.)
17. **Estimator(s) is a free-text field** (`proposalEstimators: string`) — no user picker, no
    multi-select, despite the app having a `users` collection.
18. **State is stored as a full name** ("California"), so it can never be joined to tax tables or
    abbreviations without a mapping.
19. **Rate labels are inconsistent across the product.** `useTaxRate` = "Equipment Tax Rate" on
    screen, "Use Tax" in the dead accordion, "USE TAX" in Excel. `rigRate` = "Rig Rate" on screen,
    "Rig Pay" in the accordion, "RIG"/"RIGS" in Excel.
20. **No indication of what a rate change will do.** Changing `burdenRate` re-prices every activity
    in the proposal on the next load; there is no preview, no diff, no "N activities affected", no
    audit trail of who changed a rate or when.
21. **The export is a single hard-coded report** ("WBS Cost Report") behind a menu with one item,
    guarded by an uncancellable full-screen backdrop, with the sheet literally named `readme demo`.
22. **N+1 client fetches.** `fetchDDPhases` does `getSingleWbs` per phase (`data_dump.ts:298`);
    `EditBaseRateDialog` does `getSingleActivity` per selected row
    (`edit_base_rate_dialog.tsx:66-70`); `getSingleProposal` is called twice on mount (once by the
    store, once by `useCurrentProposal`) and again inside `fetchDDActivities`.
23. **Duplicate sources of truth for preferences**: the Zustand store _and_ a per-component
    `onSnapshot` in `useProposalPreferences` (which will also _create_ the doc as a side effect of
    reading it).
24. **Column visibility on the WBS grid is not persisted**, unlike the activity grid which stores a
    per-user/per-phase model in Firestore. Four of twelve columns are hidden by default with no
    discoverability.

**Severity: low**

25. `console.log`s in hot paths: `getQuantityAndUnit` logs per activity (`utils.ts:244`),
    `recalculatePhase` logs `QUANTITY`, `updateSingleProposal` logs "Proposal updated",
    `fetchDDPhases` logs every phase.
26. `MemoryRouter` means no deep links, no browser history, nothing shareable.
27. The MUI X Pro license key is **forged at runtime** (`App.tsx:29-35`) — a licensing/legal issue
    for any rewrite that keeps DataGridPro.
28. Grid has no empty state — with `wbsToDisplay: []` you get bare headers and nothing else.

---

## 14. Dead or broken code found in this area

| Item                                                    | Location                                          | Finding                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `proposal_info_accordion.tsx` (441 lines)               | feature folder                                    | **Never imported.** Older accordion version of the info form. Contains `console.log('TEST')` at `:114`. It _did_ have `hasWritePermissions` gating and `parseInt` coercion that the live version lost.                                                                                                   |
| `proposal_rates_accordion.tsx` (243 lines)              | feature folder                                    | **Never imported.** Older accordion rates form; used `FormattedNumberInput` (a proper numeric mask) which the live Rates tab does not.                                                                                                                                                                   |
| Every WBS grid column is `editable: false`              | `wbs_data_grid.tsx:160-377`                       | Makes `onCellEditCommit`, `isCellEditable`, `updateWbs`, the `numberFields` uppercase branch, and the `editable-cell` class all **unreachable**. WBS `customQuantity`/`customUnit` are therefore uneditable in the entire app.                                                                           |
| `.under` / `.over` / `.not-used` / `.completed-row` CSS | `wbs_data_grid.tsx:84-100`                        | Class names never emitted by `getCellClassName`/`getRowClassName`.                                                                                                                                                                                                                                       |
| `selectedRows` state                                    | `wbs_data_grid.tsx:36`                            | Set by `onSelectionModelChange`, never read.                                                                                                                                                                                                                                                             |
| `wbsId`, `phaseId` from `useParams`                     | `wbs_data_grid.tsx:30`                            | Unused.                                                                                                                                                                                                                                                                                                  |
| `const craftLoadedRate = getCraftLoadedRate(...)`       | `proposal_home.tsx:47`                            | Computed on every proposal change, never used.                                                                                                                                                                                                                                                           |
| `search` state                                          | `select_wbs_dialog.tsx:32`                        | Search box is wired to state that never filters.                                                                                                                                                                                                                                                         |
| `updateProposalPreferences`                             | `api/proposal_preferences.ts:21-31`               | Only call site is commented out (`select_wbs_dialog.tsx:67`).                                                                                                                                                                                                                                            |
| `tempArray`                                             | `api/proposal_preferences.ts:9-12`                | Built from all WBS names then discarded; `wbsToDisplay: []` is written instead. Almost certainly the intended default was "show all".                                                                                                                                                                    |
| `useLoadedRates`                                        | `hooks/rates_hook.ts`                             | Exported, never imported anywhere.                                                                                                                                                                                                                                                                       |
| `getSubProfit()`                                        | `data_dump.ts:540-548`                            | Defined, **never called** — and internally wrong: `materialProfit = baseActivity.craftCost * (subProfit + salesTax)` uses `craftCost` where `materialCost` is meant.                                                                                                                                     |
| `p3[32].v` (Change #)                                   | `data_dump.ts:117`                                | Commented out (`// p3[31].v = proposal`) — the "Change #:" row in every exported report is **permanently blank**, and the commented index is also wrong (31 vs 32).                                                                                                                                      |
| `useTaxRate` destructured in `getSubcontractorCost`     | `totals.ts:106`                                   | Never used in the expression.                                                                                                                                                                                                                                                                            |
| `deleteAssociatedData('phases', …)`                     | `api/proposal.ts:135`                             | The collection is named **`phase`** everywhere else (`api/phase.ts:28`, `newAPI/api.ts:48`, `data_dump.ts:291`). Deleting a proposal therefore **orphans all of its phases** — activities and WBS are cleaned up, phases are not. Confirmed by grepping every `collection(firestore, …)` call in `src/`. |
| `duplicateProposalAndAssociatedData`                    | `api/proposal.ts:172-223`                         | Entire function commented out; the UI now calls a Firebase Function `duplicateProposal` instead (`edit_proposals_dialog.tsx:49`).                                                                                                                                                                        |
| `                                                       |                                                   | `instead of`??` for rate overrides                                                                                                                                                                                                                                                                       | `totals.ts:26-27`      | An activity override of `0` silently falls back to the proposal rate. A `$0.00` base rate is unrepresentable. |
| `preferences[proposalId]                                |                                                   | []`                                                                                                                                                                                                                                                                                                      | `proposal_home.tsx:35` | Array fallback for an object type; see §8 for the crash paths.                                                |
| String rates / numbers persisted                        | `proposal_home.tsx:82-97` + `api/proposal.ts:104` | `proposalNumber`, `coNumber`, `contactZip` become strings permanently (not in `convertRatesToNumbers`); rates become strings that are only repaired on read by `getSingleProposal`.                                                                                                                      |
| `commented-out enum WbsEnum`                            | `models/wbs.ts:43-62`                             | Superseded by `utils/enums.ts`, left in place with a typo ("SITE PREPERATION").                                                                                                                                                                                                                          |
| `processRawActivity` vs `calculateActivityData`         | `utils/utils.ts:88` vs `api/activity.ts:470`      | Two near-identical copies of the activity cost pipeline (one sync, one `async`), plus a third fully commented-out version at `utils.ts:16-86`.                                                                                                                                                           |
| Sheet name `'readme demo'`                              | `data_dump.ts:247`                                | Scaffold leftover shipped to customers.                                                                                                                                                                                                                                                                  |
| `WbsArray.sort()`                                       | `select_wbs_dialog.tsx:92`                        | Sorts the exported module-level array in place.                                                                                                                                                                                                                                                          |

---

## 15. PARITY CHECKLIST

Every discrete capability Precision must eventually have from this area. (Behavior parity —
explicitly **not** UI parity.)

**Proposal identity & info**

- Create a proposal from a minimal form (proposal number + description), with the next proposal
  number auto-suggested as `max(existing) + 1` (seed `1300` when none exist)
- Store and edit `proposalNumber` (numeric)
- Store and edit `job`
- Store and edit `coNumber` / change-order number (numeric)
- Store and edit `proposalDescription`
- Store and edit `proposalOwner` (the customer/owner org)
- Store and edit `jobSiteAddress`
- Store and edit `projectCity`
- Store and edit `projectState` from a 50-state list (+ "None")
- Store and edit `proposalEstimators`
- Store and edit `proposalDateReceived` (date)
- Store and edit `proposalDateDue` (date)
- Store and edit `projectStartDate` (date)
- Store and edit `projectEndDate` (date)
- Store and edit `bidType` from
  `None | Lump Sum | Time and Materials | Budgetary | Rates | Cost Plus`
- Store and edit `proposalStatus` from
  `None | Bidding | Submitted | Awarded | Rejected | Declined | Open | Closed`
- Store and edit contact `contactName`
- Store and edit `contactPhone` with US phone formatting/normalization (digits-only storage,
  10-digit cap, leading-`1` stripping)
- Store and edit `contactEmail`
- Store and edit `contactAddress`
- Store and edit `contactCity`
- Store and edit `contactState` (independent of project state)
- Store and edit `contactZip`
- Persist `datasetVersions` per proposal (`labor`, `phases`, `wbs`, `equipment` → `v1`/`v2`) and
  honor it when seeding WBS/phases/activities
- Duplicate an entire proposal with all WBS, phases and activities
- Delete a proposal and **all** associated data (fix the orphaned-`phase` bug)

**Rates — all 15, per proposal**

- `craftBaseRate` ($/craft MH)
- `weldBaseRate` ($/welder MH)
- `rigRate` ($/welder MH, welder's rig)
- `subsistenceRate` ($/MH, flat, unmarked-up)
- `burdenRate` (%)
- `overheadRate` (%)
- `consumablesRate` (%)
- `fuelRate` (%)
- `salesTaxRate` (%, materials)
- `useTaxRate` (%, equipment — pick ONE canonical name)
- `laborProfitRate` (%)
- `materialProfitRate` (%)
- `equipmentProfitRate` (%)
- `subContractorProfitRate` (%)
- `rigProfitRate` (%)
- Show the derived **craft loaded rate** and **welder loaded rate** wherever rates are edited (the
  legacy app computes both but never surfaces them on this screen)
- Per-activity override of `craftBaseRate` and `subsistenceRate` (today: `EditBaseRateDialog`),
  including multi-select bulk apply
- Ability to **clear** an override back to inherit, and to set a legitimate `0` override (fix the
  `||` bug)
- Enforce/replace the legacy override eligibility rule: custom-labor items, WBS `200000 SUPPORT`, or
  phases `180002/180003/180004`
- Recompute all dependent costs when any rate changes (server-side in Precision)

**Cost formulas (must produce identical numbers)**

- `craftLoadedRate = base + base*(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence`
- `welderLoadedRate = weldBase + weldBase*(same %s)/100 + subsistence + rigRate + rigRate*rigProfit/100`
- `craftManHours = quantity * craftConstant`; `welderManHours = quantity * welderConstant`
- `craftCost = craftMH * craftLoadedRate` (suppressed for subcontractor items)
- `welderCost = welderMH * welderLoadedRate`
- `materialCost = qty * price * (1 + (materialProfit + salesTax)/100)`
- `equipmentCost` with the **Owned / Rental / Purchase** split (owned = raw `qty*time*price`, no
  profit, no use tax)
- `subContractorCost = qty * (craftCost*(1+subP) + materialCost*(1+subP+salesTax) + equipmentCost*(1+subP))`
- `costOnlyCost = qty * price`
- `totalCost` = sum of the six legs, except subcontractor items where total = `subContractorCost`
- Support all six activity types:
  `laborItem, materialItem, equipmentItem, subContractorItem, costOnlyItem, customLaborItem`
- Phase roll-up that excludes subcontractor items from craft/material/equipment accumulation (decide
  deliberately whether welder cost/hours should also be excluded — legacy does not, which is
  probably a bug)
- WBS roll-up = sum of its phases across all 9 cost/hour measures
- `wbs.completed` = has phases AND all phases completed

**Proposal-level WBS view**

- List the proposal's WBS with: name, quantity, unit, craft MH, craft total, welder MH, welder
  total, material total, equipment total, sub total, cost-only total, grand total
- Sort by `wbsDatabaseId`
- Column show/hide (and, unlike legacy, persist it)
- Density control (or an equivalent compact/comfortable toggle)
- Derived WBS quantity/unit from activity descriptions per the legacy keyword rules (SITE PREP
  `EXCAVATE`/`BACKFILL / COMPACT`; CONCRETE `clean up` + `EA`/`CY` by phase id ∈
  {30011,30012,30013,30015}; TOWERS/PUMPS/STRUCTURAL `CLEAN UP`; AG/BG PIPING `HE`) — **and** an
  explicit `customQuantity`/`customUnit` override that is actually editable
- Visual treatment for completed WBS rows
- Navigate from a WBS row into that WBS (legacy can't; Precision must)
- A grand-total row (legacy has none on the grid)

**WBS visibility / scope**

- Per-proposal selection of which of the 18 WBS categories are active/visible, persisted
  (`proposal-preferences.wbsToDisplay`)
- The 18-category taxonomy with its `wbsDatabaseId` numbering (10000…200000)
- The selection must drive: the proposal WBS grid, the WBS navigation dropdown, the bottom-panel
  totals, and the Excel export
- A working search/filter in that picker (legacy's is a decoy)
- Warn when hidden WBS contain non-zero cost or hours
- Sensible default (legacy defaults to _nothing selected_; Precision should default to all, or drive
  visibility off "has data")

**Totals bar**

- Scope-aware totals: proposal (visible WBS) / WBS (its phases) / phase (its activities)
- Headline: Total Cost, Total Hours, Direct Hours, Indirect Hours, Subcontractor Hours
- Breakdown: hours by Craft / Welder / Support / Mobe+Demobe / Specialty / Subcontractor
- Breakdown: labor costs by Craft / Weld & Rig / Subcontractor
- Breakdown: other costs by Equipment / Material / Cost Only
- Indirect classification via WBS `10000 MOBILIZE`, `190000 DEMOBILIZE`, `200000 SUPPORT`,
  `180000 SPECIALTY SERVICES`
- Sub hours = `Σ quantity × time` for subcontractor items
- Remember expanded/collapsed state

**Export**

- Export a **WBS Cost Report** to `.xlsx` with a native save dialog, default filename
  `{proposalNumber}-WBS-Cost-Report`
- Header block: Proposal #, Job #, **Change #** (must actually populate — legacy's is blank),
  Description, Owner, `City, State`, generated date
- Rate stamp in the header for all 15 rates (rig + use tax on one row, the other 13 on another)
- 37-column line grid:
  `WBS, PHASE, SIZE, FLC, LINE / DESCRIP, SPEC, INSUL, INSL. SIZE, SHT, AREA, STATUS, SYS, SPCL RATE, SPCL SUB, OWNERSHIP, QTY, UNIT, CRAFT, WELD, SUB, TOTAL, BASE, BURDEN, OVERHEAD, LABOR PROFIT, FUEL, CNSMBLE, SUBSIST, LABOR, RIGS, MATERIAL, EQUIP, SUBS, COST ONLY, PROFIT TOTAL (R/M/E/S), SALES TAX, TOTAL`
- Three-level nesting WBS → phase → activity with distinct row styling; WBS sorted by id, phases by
  `phaseNumber`, activities by `sortOrder`
- Per-activity decomposition of base / burden / overhead / labor profit / fuel / consumables /
  subsistence / labor / rig / material / equipment / subs / cost-only / profit total / sales tax /
  total
- Grand-total summary row
- Accounting number formats; zero currency cells render as `-`
- Owned-equipment special case (no profit column, total = raw equipment cost)
- Suppress WBS with no phases; respect the WBS visibility selection
- **Reconcile the export math with the on-screen math** — one engine, not two

**Cross-cutting behaviors to keep**

- Read/write permission model (`role: ADMIN`, `permission: READ_WRITE`) that actually gates the
  proposal info and rates forms
- Breadcrumb navigation Proposal › WBS › Phase
- Proposal search across all descriptive fields
- Proposal dashboard stats: total, in-progress (Bidding+Open), submitted, awarded, hit rate =
  awarded/(awarded+rejected+declined); status distribution; overdue (past due & Bidding/Open) and
  due-soon (≤7 days & Bidding) highlighting
- Manual refresh/reload of proposal data

**Behaviors to explicitly NOT carry over**

- Modal whole-form edit mode with a single shared Save across unrelated tabs
- Full-document `setDoc` overwrite with lost-update semantics
- Zero validation on 15 numeric fields
- All-zero default rates with no template
- Uppercasing display values (including emails)
- The decoy search box, the button-less success modal, the uncancellable export backdrop, and the
  unclickable grid rows
