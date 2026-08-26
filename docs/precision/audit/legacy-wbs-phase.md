# LEGACY AUDIT — WBS Home, Phase Data Grid, Phase Management (MCP Estimator)

Source of truth: actual code at `/Users/collinwillis/Dev/Personal/mcp_estimator`. Everything below
was read from source; no doc/README claims are repeated.

Stack in this area: React 18 + MUI 5 + `@mui/x-data-grid-pro@5.17.21` + Zustand 4 + Firebase 9.10.0
(Firestore, direct client SDK), `react-router-dom` v6 with **MemoryRouter** (`src/App.tsx:46`).

---

## 1. Purpose of the area and the real user flow

### 1.1 Hierarchy

```
Proposal (Firestore 'proposals')
  └─ WBS       (Firestore 'wbs')        — 18 fixed, code-numbered work-breakdown buckets
       └─ Phase (Firestore 'phase')     — user-created line items inside a WBS
            └─ Activity ('activities')  — labor/material/equipment/sub/cost-only rows
```

WBS Home is the **middle tier**: a spreadsheet of every Phase inside one WBS, with rolled-up
hours/costs per phase, plus the only place phases can be created, renamed, renumbered, completed,
duplicated, or deleted.

### 1.2 Routes (`src/App.tsx`)

| Route                                             | Screen                                                  | File                                       |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `/`                                               | Proposal select                                         | `features/home/proposal_select.tsx`        |
| `/proposal/:proposalId`                           | Proposal home (3 tabs: Details / Rates / WBS Data Grid) | `features/proposal home/proposal_home.tsx` |
| `/proposal/:proposalId/wbs/:wbsId`                | **WBS Home**                                            | `features/wbs home/wbs_home.tsx`           |
| `/proposal/:proposalId/wbs/:wbsId/phase/:phaseId` | Phase home (activities)                                 | `features/phase home/phase_home.tsx`       |
| `/admin`                                          | Admin dashboard                                         | `features/admin/admin_dashboard.tsx`       |

Every screen except `/login`, `/verify-email` and `/admin` is wrapped in `AuthRoute` +
`EstimatorDrawer` (`components/drawer.tsx`), so the persistent left sidebar is the app chrome.

### 1.3 Actual flow a user walks

1. `/` → click a proposal in the sidebar list → navigate `/proposal/:id`.
2. `ProposalHomeScreen` mounts and calls `loadFullProposalData(proposalId)`
   (`features/proposal home/proposal_home.tsx:41-43`). **This is the only place the data ever
   loads**: it fetches _all_ WBS + _all_ phases + _all_ activities of the proposal in three
   collection queries and computes every roll-up client-side (`utils/store.ts:105-194`).
3. To reach a WBS the user must use the **sidebar WBS dropdown** (`components/wbs_drop_down.tsx`) —
   selecting an item calls `navigate('/proposal/:proposalId/wbs/:wbsId')`. _There is no navigation
   from the WBS Data Grid rows on Proposal Home_ (`wbs_data_grid.tsx` has no
   `onRowClick`/`onRowDoubleClick`/`useNavigate`).
4. WBS Home renders `PhaseDataGrid` (all phases whose `wbsId` matches, sorted by `phaseNumber` asc)
   plus the shared `BottomPanel` totals bar.
5. To open a phase the user must use the **sidebar phase list** (`components/phase_list.tsx`), which
   navigates to `/proposal/:p/wbs/:w/phase/:id`. _The phase data grid rows are not clickable to
   drill down_ — `features/wbs home/components/phase_data_grid.tsx` never imports `useNavigate`.
6. Phase creation happens from the **bottom panel "Add" bar**: when `wbsId` is present and no
   `phaseId`, the bar shows a single primary chip labelled **"Phase"**
   (`components/bottom_pannel.tsx:352-361`) which opens `AddPhaseDialog`.
7. Breadcrumbs in the app bar (`drawer.tsx:185-220`) show
   `"<proposalNumber> - <proposalDescription>" › <wbs.name> › "<phaseNumber> - <phaseDescription>"`;
   the first two are clickable links back up the tree. Sidebar also has explicit "Proposal Home" /
   "WBS Home" nav links (`drawer.tsx:379-388`), each disabled when already at or above that level
   (`WBS Home` is `disabled={phaseId == null}` — i.e. only usable from a phase).

### 1.4 Data freshness model

- WBS Home reads **only** from the Zustand store (`estimatorStore`), never from Firestore directly.
- The store is populated once per Proposal-Home mount, or manually via the ⭳ icon in the app bar
  (`drawer.tsx:223-230` → `loadFullProposalData(proposalId)`).
- All mutations are **optimistic**: write to Firestore, then patch local state. There are no
  Firestore listeners in the live path (the two `onSnapshot` hooks that exist are dead code, §7).
- Because the router is a `MemoryRouter`, a browser reload always returns to `/`; there is no
  deep-linking and no URL to share.

---

## 2. Data model — exact fields and types

### 2.1 `wbs` collection — `models/wbs.ts` (read model) / `models/firestore models/wbs_firestore.ts` (write model)

| Field            | Type           | Written by          | Notes                           |
| ---------------- | -------------- | ------------------- | ------------------------------- |
| `id`             | string         | Firestore doc id    | not stored in doc               |
| `proposalId`     | string \| null | `insertAllBaseWbs`  |                                 |
| `wbsDatabaseId`  | number \| null | `insertAllBaseWbs`  | **the WBS code** (10000…200000) |
| `name`           | string \| null | `insertAllBaseWbs`  | e.g. `AG PIPING`                |
| `customQuantity` | number \| null | never written by UI | override for roll-up quantity   |
| `customUnit`     | string \| null | never written by UI | override for roll-up unit       |

Read-model-only (computed at load, never persisted): `quantity`, `unit`, `craftManHours`,
`craftCost`, `welderManHours`, `welderCost`, `materialCost`, `equipmentCost`, `subContractorCost`,
`costOnlyCost`, `totalCost`, `completed`.

### 2.2 `phase` collection (note: singular `'phase'`) — `models/phase.ts` / `models/firestore models/phase_firestore.ts`

Persisted fields (`FirestorePhase`, all default to `null` except `completed`):

| Field               | Type           | Meaning                                                               |
| ------------------- | -------------- | --------------------------------------------------------------------- |
| `proposalId`        | string \| null | owner proposal                                                        |
| `wbsId`             | string \| null | owner WBS **doc id** (not the code)                                   |
| `phaseDatabaseId`   | number \| null | catalog id of the phase template chosen at creation                   |
| `phaseDatabaseName` | string \| null | catalog description of that template                                  |
| `phaseNumber`       | number \| null | the estimator-facing phase number (sort key)                          |
| `description`       | string \| null | "Line / Description", stored UPPERCASE                                |
| `size`              | string \| null | pipe size                                                             |
| `flc`               | string \| null | fluid/line class code                                                 |
| `system`            | string \| null | **declared in both models, no column, never written**                 |
| `sys`               | string \| null | "Sys" column                                                          |
| `spec`              | string \| null | spec code                                                             |
| `insulation`        | string \| null | "Insul"                                                               |
| `insulationSize`    | string \| null | "Insl. Size"                                                          |
| `sheet`             | string \| null | "Sht" (drawing sheet)                                                 |
| `area`              | string \| null | kept as **string** on purpose (never parsed to number)                |
| `status`            | string \| null | free-text status                                                      |
| `customQuantity`    | number \| null | manual quantity override (what the grid actually writes)              |
| `quantity`          | number \| null | legacy/derived; **ignored on read in the live path**                  |
| `customUnit`        | string \| null | manual unit override (only the _dead_ code path writes it)            |
| `unit`              | string \| null | what the grid actually writes today                                   |
| `completed`         | boolean        | drives green row styling + WBS completion roll-up                     |
| `createdAt`         | Date           | **only** added by duplication (`newAPI/api.ts:195`), not in the model |

Read-model-only (recomputed from activities on every load): `craftManHours`, `craftCost`,
`welderManHours`, `welderCost`, `materialCost`, `equipmentCost`, `subContractorCost`,
`costOnlyCost`, `totalCost`, and the effective `quantity`/`unit`. `Phase.wbsDatabaseId` exists in
the read model but is never populated — WBS code is resolved by joining `phase.wbsId` → wbs doc.

### 2.3 `proposal-preferences` collection — doc id == proposalId

```ts
class ProposalPreferences {
  id?: string | null;
  wbsToDisplay?: string[] | null;
}
```

`wbsToDisplay` is an array of **WBS names** (strings), not ids. It is the _only_ WBS visibility
control in the app.

---

## 3. WBS: creation, codes, ordering, visibility

### 3.1 Creation — automatic, once, at proposal creation

`api/proposal.ts:23-38` `insertProposal(description, number)`:

1. builds `datasetVersions = buildDatasetVersions(CURRENT_DATA_VERSION /* 'v2' */)`,
2. `addDoc('proposals', …)`,
3. then `insertAllBaseWbs(docRef.id, datasetVersions)`.

`api/wbs.ts:23-42` `insertAllBaseWbs`:

```ts
const wbsData = resolveDataset<{ id: number; name: string }[]>("wbs", datasetVersions?.wbs ?? "v1");
wbsData.forEach(async (wbs) => {
  // NOT awaited — fire-and-forget
  await insertBaseWbs(
    proposalId,
    new FirestoreWbs({ name: wbs.name, wbsDatabaseId: wbs.id, proposalId })
  );
});
```

So **18 WBS documents** are created per proposal, one per entry of `data/v1/wbs_v1.json`. There is
no v2 wbs dataset (`data/datasets.ts:16-21` — `wbs: { v1: wbsV1 }`), so
`resolveDatasetVersion('wbs','v2')` falls back to `v1`.

**There is no UI anywhere to create, rename, delete, reorder, or add a custom WBS.**

### 3.2 The WBS code table (`data/v1/wbs_v1.json`, 18 rows)

| Code (`wbsDatabaseId`) | Name                     |
| ---------------------- | ------------------------ |
| 10000                  | MOBILIZE                 |
| 20000                  | SITE PREPARATION         |
| 30000                  | CONCRETE                 |
| 40000                  | TOWERS/VESSELS/EQUIPMENT |
| 50000                  | PUMPS & DRIVERS          |
| 60000                  | STRUCTURAL               |
| 70000                  | AG PIPING                |
| 80000                  | ELECTRICAL               |
| 90000                  | INSTRUMENTS              |
| 100000                 | INSULATION               |
| 110000                 | PAINTING                 |
| 120000                 | DISMANTLING              |
| 130000                 | BG PIPING                |
| 140000                 | REFRACTORY               |
| 150000                 | BUILDINGS                |
| 180000                 | SPECIALTY SERVICES       |
| 190000                 | DEMOBILIZE               |
| 200000                 | SUPPORT                  |

Codes 160000 and 170000 are intentionally unused/reserved. The same 18 are duplicated as a
hard-coded class in `utils/enums.ts` (`WbsEnum` + `WbsArray`) — the JSON drives _creation_, the enum
drives the _visibility dialog_ (two sources of truth for the same list).

### 3.3 Ordering

WBS are always sorted ascending by `wbsDatabaseId`:

- sidebar dropdown: `wbs_drop_down.tsx:50-52`
- proposal-home grid: `wbs_data_grid.tsx:40-43`
- WBS-select dialog: `select_wbs_dialog.tsx:91-95` (note: sorts `WbsArray` **in place**, mutating
  the shared module-level constant).

There is no user-controllable WBS ordering.

### 3.4 Visibility (the `wbsToDisplay` gate)

- Store keeps two maps: `wbs[proposalId]` (all 18) and `visibleWbs[proposalId]`
  (`wbs.filter(w => preferences.wbsToDisplay?.includes(w.name))`) — `utils/store.ts:184-189`.
- Sidebar WBS dropdown reads **`visibleWbs`** → hidden WBS are unreachable.
- Proposal-Home WBS grid reads `visibleWbs` too, and its toolbar has a **"WBS Select"** button that
  opens `SelectWbsDialog` (search box + checkbox list of the 18 names + Cancel/Save). Save →
  `store.setPreferences` → debounced Firestore write + `setVisibleWbs`.
- **Default for a brand-new proposal is an empty list**: `insertProposalPreferences`
  (`api/proposal_preferences.ts:8-19`) builds `tempArray` of all WBS names and then **throws it
  away**, writing `wbsToDisplay: []`. `fetchProposalPreferencesFromFirestore` also defaults to `[]`
  (`newAPI/api.ts:103`). Result: a new proposal shows **zero** WBS until the user finds Proposal
  Home → tab 3 → "WBS Select" and ticks boxes.
- The bottom panel warns about this indirectly: at proposal level it shows a "Hidden WBS data" amber
  chip when any _hidden_ WBS has non-zero cost/hours (`bottom_pannel.tsx:193-197`).

---

## 4. WBS Home screen composition

`features/wbs home/wbs_home.tsx` (59 lines) is almost pure plumbing:

```ts
const data     = estimatorStore(s => s.phases[proposalId] || []);
const wbsList  = estimatorStore(s => s.wbs[proposalId] || []);   // ALL wbs, not visibleWbs
const currentWbs = wbsList.find(w => w.id === wbsId);
useEffect(() => setFiltered(
  data.filter(p => p.wbsId === wbsId).sort((a,b) => a.phaseNumber! - b.phaseNumber!)
), [data, wbsId]);

<PhaseDataGrid phaseList={filtered} isLoading={false} wbsDatabaseId={currentWbs?.wbsDatabaseId} />
<BottomPanel />
```

- `isLoading` is hard-coded `false` → the grid never shows a loading state, even while
  `loadFullProposalData` is running (it shows an empty grid instead).
- There is no header: no WBS name, no code, no phase count, no per-WBS totals on this screen. The
  only identification of "where am I" is the app-bar breadcrumb and the sidebar dropdown.
- The grid is wrapped in a `overflow: 'auto'` Box **and** the DataGrid does its own virtualized
  scrolling → nested scroll containers.

### 4.1 Bottom panel behavior on this screen (`components/bottom_pannel.tsx`)

Dataset selection (`bottom_pannel.tsx:186-190`):

- phase route → activities of that phase
- **wbs route → phases of that WBS**
- proposal route → visible WBS rows

Status bar (always visible, 36px): `Total Cost` ($), `Total Hrs`, `Direct`, `Indirect`, `Sub Hrs`.
Expandable "Details" (persisted in `localStorage['bottomPanelDetailsOpen']`) shows three mini
tables:

- **Hours**: Craft, Welder, Support, Mobe/Demobe, Specialty, Subcontractor, Total
- **Labor Costs**: Craft, Weld & Rig, Subcontractor
- **Other Costs**: Equipment, Material, Cost Only

Direct/indirect split rule (`bottom_pannel.tsx:29`, `227-237`): WBS codes
`{10000 MOBILIZE, 180000 SPECIALTY, 190000 DEMOBILIZE, 200000 SUPPORT}` are **indirect**; each maps
to its own bucket (mobe/specialty/demobe/support). Everything else accumulates into directCraftHours
/ directWelderHours. Subcontractor hours = `Σ quantity × time` over
`activityType === subContractorItem`. All values rounded with `Number(n.toFixed(2))`.

Quick-add bar (only when `hasWritePermissions`): at WBS level exactly one chip — **"Phase"**
(primary/black) → opens `AddPhaseDialog`.

---

## 5. Phase creation — `components/add_phase_dialog.tsx`

Opened from the bottom-panel "Phase" chip. Modal, fixed 300×300 content, **no Cancel button**
(dismiss = backdrop click or Esc).

### 5.1 Controls

1. **`Database` (Select, standard variant)** — options = `phases` dataset rows filtered to
   `phase.wbsDatabaseId === currentWbs.wbsDatabaseId`. Dataset: `data/v1/phases_v1.json`, **228
   rows**, shape `{ wbsDatabaseId, phaseDatabaseId, description }`. Per-WBS counts: 10000:12,
   20000:18, 30000:20, 40000:23, 50000:9, 60000:25, 70000:30, 80000:2, 90000:20, 100000:2, 110000:2,
   120000:12, 130000:16, 140000:2, 150000:2, 180000:5, 190000:8, 200000:20. Selection is wired
   through `MenuItem onClick` — the `<Select>` has `value` but **no `onChange`**.
2. **`Phase Description` (TextField)** — rendered **only when the WBS name is NOT one of
   `['MOBILIZE','DEMOBILIZE','SUPPORT']`**. Typing sets `isDescriptionEdited = true`, which locks
   out auto-fill.
3. **`Phase Number` (TextField)** — `disabled` when the WBS is one of those three OR when no
   database option has been chosen. Typing sets `isPhaseNumberEdited = true`. Parsed with
   `parseInt(value, 10)`.
4. **`Add Phase` (contained Button)** — always enabled.

### 5.2 Auto-numbering / auto-description algorithm (`add_phase_dialog.tsx:100-149`)

Runs whenever a database option is selected (and on any change to the WBS phase list):

```
if (selectedDescription && selectedPhaseDatabaseId && currentWbs?.wbsDatabaseId):
   # description
   if currentWbs.name ∈ {MOBILIZE, DEMOBILIZE, SUPPORT} and not isDescriptionEdited:
        newPhaseDescription = selectedDescription
   # number
   maxPhaseNumber = currentWbs.wbsDatabaseId                  # e.g. 20000
   if selectedPhaseDatabaseId ∈ RESERVED_PHASE_NUMBERS and not isPhaseNumberEdited:
        newPhaseNumber = selectedPhaseDatabaseId              # fixed number == catalog id
   elif there are existing phases in this WBS:
        for each phase in this WBS:
            if phase.phaseNumber > maxPhaseNumber and phase.phaseNumber ∉ RESERVED:
                 maxPhaseNumber = phase.phaseNumber
        newPhaseNumber = maxPhaseNumber + 1
   else:
        newPhaseNumber = maxPhaseNumber + 1                   # first phase → wbsCode + 1
```

`RESERVED_PHASE_NUMBERS` (`listOfPhaseNumbersForSetPhaseName`, 108 hard-coded values,
`add_phase_dialog.tsx:69-85`) are catalog ids that must keep their own number (material lines,
cleanup lines, mobe/demobe/support items, e.g.
`10001…10011, 19999, 29987, 29998, 29999, 39982, …, 79999, 89999, 99986…, 109999, 119999, 129998/9, 139983…139999, 149999, 159999, 180001-180004, 189999, 190001-190007, 199999, 200100…201060, 209980…209999`).
Any _other_ catalog id gets a sequential number:
`max(existing non-reserved phase number in this WBS, wbsCode) + 1`.

### 5.3 What is written (`handlePhaseCreate`)

```ts
new FirestorePhase({
  phaseDatabaseName: selectedPhaseDescription,
  phaseDatabaseId:   selectedPhaseDatabaseId,
  phaseNumber:       newPhaseNumber,
  description: newPhaseDescription !== '' ? newPhaseDescription.toUpperCase()
                                          : selectedPhaseDescription.toUpperCase(),
  wbsId: currentWbs?.id, proposalId: currentProposal?.id,
})
→ store.addPhase → insertPhaseToFirestore (setDoc on a new auto-id doc in 'phase')
→ local state gets { ...newPhase, id: ref.id, ...calculateTotals([]) }   // all cost fields 0
```

Then all dialog state is cleared and `onClose()` fires. No toast/confirmation, no scroll-to or
selection of the new row; the row simply appears in the grid at its sorted position.

**No validation at all**: clicking "Add Phase" with nothing selected creates a phase with
`phaseNumber: 0`, `phaseDatabaseId: 0`, `description: ''`. Clearing the Phase Number field yields
`parseInt('') === NaN` which is written to Firestore. Duplicate phase numbers are never checked.

---

## 6. The phase data grid — `features/wbs home/components/phase_data_grid.tsx`

Rendered through `components/excel_navigation_data_grid.tsx` (a `DataGridPro` wrapper), with
`density='compact'`, `pageSize={100}` (inert — `pagination` is not enabled on DataGridPro),
`editMode='cell'`, `experimentalFeatures={{ newEditingApi: true }}`.

### 6.1 Every column, in order

| #   | field               | Header             | Editable (declared) | Editable (runtime) | Align               | Formatter                      |
| --- | ------------------- | ------------------ | ------------------- | ------------------ | ------------------- | ------------------------------ |
| 1   | `completed`         | Completed          | — (renderCell)      | via checkbox       | center              | MUI `<Checkbox size="medium">` |
| 2   | `phaseNumber`       | Phase              | ✅                  | ✅                 | default             | raw                            |
| 3   | `size`              | Size               | ✅                  | ✅                 | right               | raw                            |
| 4   | `flc`               | FLC                | ✅                  | ✅                 | right               | raw                            |
| 5   | `description`       | Line / Description | ✅                  | ✅                 | left (minWidth 250) | raw                            |
| 6   | `spec`              | Spec               | ✅                  | ✅                 | right               | raw                            |
| 7   | `insulation`        | Insul              | ✅                  | ✅                 | right               | raw                            |
| 8   | `insulationSize`    | Insl. Size         | ✅                  | ✅                 | right               | raw                            |
| 9   | `sheet`             | Sht                | ✅                  | ✅                 | right               | raw                            |
| 10  | `area`              | Area               | ✅                  | ✅                 | right               | raw                            |
| 11  | `status`            | Status             | ✅                  | ✅                 | right               | raw                            |
| 12  | `sys`               | Sys                | ✅                  | ✅                 | right               | raw                            |
| 13  | `quantity`          | Quantity           | ✅                  | ✅                 | right               | `toLocaleString(min2,max2)`    |
| 14  | `unit`              | Units              | ✅                  | ✅                 | right               | raw                            |
| 15  | `craftManHours`     | Craft MH           | ✅                  | ❌ blocked         | right               | `toLocaleString(min2,max2)`    |
| 16  | `craftCost`         | Craft Total        | ✅                  | ❌                 | right               | `$` + `toLocaleString(2)`      |
| 17  | `welderManHours`    | Welder MH          | ✅                  | ❌                 | right               | `toLocaleString(2)`            |
| 18  | `welderCost`        | Welder Total       | ✅                  | ❌                 | right               | `$…`                           |
| 19  | `materialCost`      | Material Total     | ✅ (`hide: true`)   | ❌                 | right               | `$…`                           |
| 20  | `equipmentCost`     | Equip Total        | ✅ (`hide: true`)   | ❌                 | right               | `$…`                           |
| 21  | `subContractorCost` | Sub Total          | ✅ (`hide: true`)   | ❌                 | right               | `$…`                           |
| 22  | `costOnlyCost`      | Cost Only Total    | ✅ (`hide: true`)   | ❌                 | right               | `$…`                           |
| 23  | `totalCost`         | Total              | ✅                  | ❌                 | right               | `$…`                           |

Runtime blocking list (`notEditableCells`, lines 594-607):
`craftManHours, welderManHours, craftCost, welderCost, materialCost, equipmentCost, subContractorCost, costOnlyCost, totalCost`.
`isCellEditable` also returns `false` wholesale when `hasWritePermissions === false`
(`hooks/user_profile_hook.ts`: `users/{uid}.permission === 'READ_WRITE'`, role `ADMIN` for admin
UI).

`null`/`undefined` numeric values format to `''` (empty cell) in every money/number column.

### 6.2 Column visibility rules

Two layers merge into `mergedColumnVisibilityModel` (lines 659-669):

1. **Auto rules by WBS code** — `PHASE_AUTO_COLUMN_RULES`: for
   `10000, 20000, 30000, 40000, 50000, 60000, 80000, 110000, 150000, 180000, 190000, 200000` the
   _pipe columns_ `size, flc, spec, insulation, insulationSize, sheet` are hidden. → they remain
   visible only for
   `70000 AG PIPING, 90000 INSTRUMENTS, 100000 INSULATION, 120000 DISMANTLING, 130000 BG PIPING, 140000 REFRACTORY`.
2. **User overrides** — read/written to a single global `localStorage['phases_visibility']` key. On
   load, any override that equals the auto value is dropped; on change, the same reduction runs
   before persisting. `sanitizePhaseColumnVisibilityModel` is a pass-through no-op (`{...model}`,
   `_wbsDatabaseId` unused). Model state resets to `{}` whenever `wbsDatabaseId` changes (lines
   204-207) and is then re-read from localStorage — so overrides are **shared across all WBS and all
   proposals**, not scoped.

### 6.3 Toolbar (`CustomToolbar`, lines 65-170)

Left group (always): **Columns** (`GridToolbarColumnsButton`) and **Density**
(`GridToolbarDensitySelector`). Right group (only when `hasWritePermissions`):

- **Duplicate** — icon `ControlPointDuplicate`; disabled when `selectedRows.length <= 0`; calls
  `store.duplicatePhases(selectedIds)` immediately, no confirmation.
- **Delete** — red; disabled when nothing selected; opens the confirm dialog.

There is **no Add-Phase button in the grid toolbar** (creation lives in the bottom panel), no
export, no filter button, no search.

### 6.4 Selection

`checkboxSelection` is **not** enabled anywhere in this grid, and `disableSelectionOnClick` is not
set. Therefore selection is "click a row (or any cell) to select it", ctrl/⌘+click and shift+click
for multi-select — with **no visual affordance** telling the user that's possible. Clicking a cell
to edit it also selects that row, so the Duplicate/Delete buttons silently target whatever row was
last touched.

### 6.5 Delete confirmation (`components/alert_dialog.tsx`)

Title: `Are you sure you want to delete the selected phase?` (singular even for N rows) Body:
`Once deleted, this phase and its associated activities cannot be recovered.` Buttons: `Cancel`
(ghost) / `Delete` (red, `autoFocus`). On confirm → `store.deletePhases(ids)` then close.

### 6.6 Row / cell styling

- `getRowClassName`: completed rows alternate `completed-row-light` (`#c0e8d4`) /
  `completed-row-dark` (`#9fcbb9`); non-completed alternate `row-even` / `row-odd` (`#fafafa`).
- `getCellClassName`: adds `completed-row ` (no such CSS rule exists — dead) and `editable-cell`
  (`color: primary.dark`) for any runtime-editable field.
- The wrapper declares `.under` (`#ff525240`), `.over` (`#ffeb3b40`), `.not-used` (`#2d2d2d`)
  classes — **nothing in this grid ever assigns them** (dead styles copied from the activity grid).

### 6.7 Keyboard model (`ExcelNavigationDataGrid`, configured with

`enterBehavior='next-row'`, `tabBehavior='next-cell'`, `skipNonEditableCells`, `wrapNavigation`,
`autoCommitOnNavigation`, `debugMode={false}`)

| Key                    | Behavior                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Arrows                 | native MUI cell navigation                                                                            |
| Enter (view mode)      | **does not enter edit** — moves focus down one row (Shift+Enter = up); wraps last→first               |
| Enter (edit mode)      | commit + move down one row, land in view mode                                                         |
| Tab / Shift+Tab (view) | move right/left to next _editable_ cell, wrapping to next/previous row and finally row 0              |
| Tab / Shift+Tab (edit) | commit + same movement                                                                                |
| F2                     | toggle edit mode on the focused cell (no text pre-selection)                                          |
| Printable char (view)  | MUI native type-to-replace (starts edit with the typed char)                                          |
| Backspace (view)       | MUI native: clears value and enters edit                                                              |
| Delete (view)          | clears value and immediately commits, staying in view mode (`setTimeout(...,0)` → `stopCellEditMode`) |
| Esc (edit)             | discard modifications, stay on the cell                                                               |
| Double-click           | edit with cursor at click position                                                                    |
| Click away             | commit, no navigation, focus goes to the click target                                                 |

Non-editable columns are skipped during Tab/Enter traversal (`isNavigableColumn` +
`isCellRuntimeEditable`). Focus is restored to the last focused cell after row/column data changes
(`excel_navigation_data_grid.tsx:759-771`). There are **no application-level shortcuts** anywhere in
the app (a repo-wide grep for `onKeyDown`/`keydown`/`ctrlKey`/`metaKey` outside the grid returns
nothing).

### 6.8 Sorting / filtering persistence

- `onSortModelChange` → `localStorage['phases_sort']`
- `onFilterModelChange` → `localStorage['phases_filter']` Both keys are **write-only**: nothing ever
  reads them (verified by repo-wide grep). Sorting and filtering therefore reset on every
  navigation. Only `phases_visibility` is read back.

---

## 7. Phase editing semantics (what a cell edit actually does)

`onProcessRowUpdate` (`phase_data_grid.tsx:767-792`):

1. Diff `newRow` vs `oldRow`, take the first changed key.
2. `shouldUppercase = typeof value === 'string' && !numberFields.includes(field)` where
   `numberFields` (`utils/utils.ts:388-405`) =
   `quantity, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate, equipmentCost, materialCost, costOnlyCost, price, time, subContractorCost`.
   → **every text phase field is force-uppercased**, including `description`, `size`, `flc`, `spec`,
   `insulation`, `insulationSize`, `sheet`, `area`, `status`, `sys`, `unit`.
3. `store.updatePhase(id, field, finalValue)` (uppercases again, then):
4. `updatePhaseFieldInFirestore` (`newAPI/api.ts:119-147`):
   - `field === 'quantity'` → writes **`customQuantity: parseFloat(value)`** (or `null` when not
     numeric). The `quantity` field itself is never written.
   - else if value is numeric AND field ∉ `{area, quantity, description}` → `parseFloat` and write
     as a number. (So `phaseNumber` is stored numeric; `area` stays a string even when it looks
     numeric; a numeric-looking `description` stays a string.)
   - else → write the raw value.
   - **`unit` is NOT routed to `customUnit`** in the live path (only the dead `api/phase.ts` version
     does that).
5. Local state patch: `phases[*][i] = { ...phase, [field]: finalValue }` — writes the _grid's_ field
   name, so a quantity edit sets local `quantity` (as a **string**) while Firestore got
   `customQuantity` (a number). The two diverge until the next full reload (see §9 bugs).

The **Completed** checkbox calls `updatePhase(id, 'completed', boolean)` directly
(`handleCheckboxChange`, line 252) — same path, boolean survives the numeric check.

Phase fields editable **outside** this grid: on Phase Home, the activity-grid toolbar has a
`Database` select that rewrites `phaseDatabaseName` + `phaseDatabaseId` of the current phase and
then re-points every activity's labor constant to the equivalent constant under the new phase
database (`activity_data_grid.tsx:608-676`), and a `Complete/Incomplete` switch that writes
`completed`.

---

## 8. Duplicate, delete, copy-from-phase

### 8.1 Duplicate (`store.duplicatePhases` → `duplicatePhasesAndActivitiesInFirestore`, `newAPI/api.ts:176-220`)

- For each selected phase: read the doc, mint a new doc ref,
  `batch.set(newRef, {...oldData, createdAt: new Date()})`, then query
  `activities where phaseId == oldId` and `batch.set` a copy of each with `phaseId = newPhaseId`.
  One single `writeBatch` for everything.
- Returns `{ newPhaseIds: string[], newActivityMappings: {oldActivityId: newActivityId} }`.
- Store then rebuilds local rows by **index alignment**: `newPhaseIds[index] ↔ phaseIds[index]` and
  `newPhaseIds[phaseIds.indexOf(activity.phaseId)]` (`utils/store.ts:356-379`).
- Everything is copied verbatim, **including `phaseNumber` and `description`** → duplicates collide
  on phase number; nothing renumbers or appends "(Copy)".
- No confirmation, no toast, no selection of the new rows.

### 8.2 Delete (`store.deletePhases` → `deletePhasesInFirestore`, `newAPI/api.ts:149-170`)

- `batch.delete` each phase doc, then `query(activities, where('phaseId','in', phaseIds))` and
  `batch.delete` every matching activity, single commit.
- Local state removes the phases **and** their activities.
- Cascade is one level: activities are removed, nothing else references phases.

### 8.3 Copy activities from another phase

Two dialogs exist; **only one is reachable**.

- `components/copy_from_phase_dialog.tsx` — "Copy From Phase": From = `<Select>` of phases in the
  **same WBS** (excluding current), To = disabled select showing the current phase, `Copy` button
  disabled until a source is picked. On submit → `store.copyActivitiesFromPhase(from, phaseId)` →
  `recalculatePhase(phaseId)`. **`setOpenCopyDialog(true)` is never called anywhere** — the dialog
  is mounted at `activity_data_grid.tsx:1355` and can never be opened (§10).
- `components/copy_activities_from_proposal_dialog.tsx` — despite the filename it copies from any
  phase **in the same proposal** (all WBS). Autocomplete labelled `From Phase`, options
  `"<WBS name> - <phaseNumber> - <description>"`, sorted by WBS name then phase number, free-text
  filter across wbsName/description/phaseNumber; `To Phase` is a disabled select of the current
  phase; button `Copy Activities`. This is what the visible **"Copy From Phase"** toolbar button on
  Phase Home actually opens (`activity_data_grid.tsx:375`).

Live copy implementation (`copyActivitiesFromPhaseToPhaseInFirestore`, `newAPI/api.ts:222-248`):
straight duplication of each source activity doc with `phaseId = toPhaseId` and
`createdAt: new Date()`. **No labor-constant remapping** — the smarter version that re-resolves the
labor constant when the target phase has a different `phaseDatabaseId` lives in
`api/phase.ts:156-205` and is dead code.

---

## 9. Computed values — exact formulas

### 9.1 Phase roll-ups (`calculateTotals`, `utils/utils.ts:280-315`)

For the activities belonging to the phase:

```
costOnlyCost      = Σ a.costOnlyCost
subContractorCost = Σ a.subContractorCost
materialCost      = Σ a.materialCost      (skipped when a.activityType === subContractorItem)
equipmentCost     = Σ a.equipmentCost     (skipped for subContractorItem)
craftCost         = Σ a.craftCost         (skipped for subContractorItem)
welderCost        = Σ a.welderCost
craftManHours     = Σ a.craftManHours
welderManHours    = Σ a.welderManHours
totalCost         = Σ a.totalCost
```

Then, at load (`utils/store.ts:122-148`):

```
phase.craftManHours  = (doc.craftManHours  && isNumber(doc.craftManHours))  ? doc.craftManHours  : totals.craftManHours
phase.welderManHours = (doc.welderManHours && isNumber(doc.welderManHours)) ? doc.welderManHours : totals.welderManHours
phase.quantity       = doc.customQuantity ?? getQuantityAndUnit(activities, wbsCode).quantity
phase.unit           = doc.unit           ?? getQuantityAndUnit(activities, wbsCode).unit
```

(the man-hour override branch is vestigial — nothing in the app writes `craftManHours` onto a phase
doc; only imported/legacy documents could.)

`recalculatePhase(phaseId)` (`utils/store.ts:196-254`), called after activity mutations, recomputes
the same totals but uses `customQuantity ?? computed` **and `customUnit ?? computed`** — a different
rule than the loader (see §10 bugs).

### 9.2 Quantity/unit derivation (`getQuantityAndUnit`, `utils/utils.ts:198-246`)

Per-activity scan, keyed by the WBS code:

```
keywordMap = { 20000: ['EXCAVATE','BACKFILL / COMPACT'],
               40000: ['CLEAN UP'], 50000: ['CLEAN UP'], 60000: ['CLEAN UP'],
               70000: ['HE'], 130000: ['HE'] }

if wbsCode === 30000 (CONCRETE):
     unit = 'EA' if activity.constant.phaseDatabaseId ∈ {30011,30012,30013,30015} else 'CY'   # last activity wins
     if /clean\s*up/i.test(activity.description): quantity += activity.quantity
else:
     if any keyword ⊂ activity.description.toUpperCase():
         quantity += activity.quantity
         unit = activity.unit          # last matching activity wins
# any other WBS code → quantity 0, unit ''
```

Notes: the `'HE'` keyword for AG/BG piping is a naive substring match (matches SHEET, THE, HEAT…);
`unit` is overwritten by each match rather than validated for consistency; a stray
`console.log(quantity, unit)` fires for every phase on every recompute.

### 9.3 WBS roll-ups (`utils/store.ts:150-178`)

```
totals   = calculateWbsTotals(phasesOfThisWbs)   // simple Σ of the 9 phase money/hour fields
completed = phases.length > 0 && phases.every(p => p.completed)
quantity  = wbs.customQuantity ?? getQuantityAndUnit(activitiesOfThisWbs, wbsCode).quantity
unit      = wbs.customUnit     ?? getQuantityAndUnit(activitiesOfThisWbs, wbsCode).unit
```

`calculateWbsTotals` also accumulates `quantity`/`unit`, but both are immediately overwritten by the
two lines above — dead computation. Note the WBS quantity is computed **from activities**, so
per-phase `customQuantity` overrides are _not_ reflected in the WBS row.

### 9.4 Underlying activity cost formulas (`api/totals.ts`, for context — the phase grid only sums these)

```
craftLoadedRate  = craftBase + craftBase*(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence
welderLoadedRate = weldBase  + weldBase *(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence
                   + rigRate + rigRate*rigProfit/100
craftCost   = craftManHours  * craftLoadedRate            (except subcontractor items)
welderCost  = welderManHours * welderLoadedRate
materialCost  = qty * price * (1 + (materialProfit + salesTax)/100)
equipmentCost = owned ? qty*time*price : qty*time*price*(1 + (equipmentProfit + useTax)/100)
costOnlyCost  = qty * price
subContractorCost = qty * ( craftCost*(1+subProfit) + materialCost*(1+subProfit+salesTax)
                            + equipmentCost*(1+subProfit) )
totalCost = craft + welder + material + equipment + sub + costOnly   (sub items: = subContractorCost)
craftManHours = activityQuantity * craftConstant ;  welderManHours = activityQuantity * welderConstant
```

---

## 10. UX problems observed (with evidence)

| #   | Problem                                                                                                                                                                        | Evidence                                                                                       | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------- |
| 1   | **You cannot open a phase from the phase grid.** Drill-down only exists in the sidebar phase list.                                                                             | `phase_data_grid.tsx` never imports `useNavigate`; no `onRowClick`/`onRowDoubleClick`.         | High     |
| 2   | **You cannot open a WBS from the WBS grid** either; the only entry point is the sidebar dropdown.                                                                              | `wbs_data_grid.tsx` — no navigation handlers.                                                  | High     |
| 3   | **New proposals show zero WBS.** `wbsToDisplay` defaults to `[]`; the user must discover Proposal Home → tab "WBS Data Grid" → "WBS Select".                                   | `api/proposal_preferences.ts:8-19` builds the full list then writes `[]`; `newAPI/api.ts:103`. | High     |
| 4   | **Add Phase has no validation and no Cancel.** Empty submit creates `phaseNumber 0 / description ''`; clearing the number field writes `NaN`; duplicate numbers never blocked. | `add_phase_dialog.tsx:153-174`, `226-236`.                                                     | High     |
| 5   | **Phase creation is buried in a bottom status bar chip** labelled only "Phase", not in the grid toolbar where phases live.                                                     | `bottom_pannel.tsx:352-361`.                                                                   | Med      |
| 6   | **Destructive actions target an invisible selection.** No checkbox column; clicking any cell selects the row; Duplicate fires with no confirmation.                            | no `checkboxSelection` anywhere (repo-wide grep); `phase_data_grid.tsx:140-152`.               | High     |
| 7   | **Duplicate produces colliding phase numbers/descriptions** with no renumbering or "(Copy)" marker.                                                                            | `newAPI/api.ts:194-196` copies `{...oldPhaseDoc.data()}` verbatim.                             | Med      |
| 8   | **Sort and filter never persist** although the code writes them to localStorage.                                                                                               | `phase_data_grid.tsx:730-756` writes `phases_sort` / `phases_filter`; nothing reads them.      | Med      |
| 9   | **Column visibility is one global key** shared across every WBS and proposal.                                                                                                  | single `localStorage['phases_visibility']`.                                                    | Med      |
| 10  | **No loading state.** `isLoading={false}` hard-coded, so during the multi-second full-proposal load the grid shows "no rows".                                                  | `wbs_home.tsx:48`.                                                                             | Med      |
| 11  | **No context on screen**: no WBS name/code header, no phase count, no per-WBS totals on WBS Home; identity comes only from the breadcrumb.                                     | `wbs_home.tsx` renders grid + bottom panel only.                                               | Med      |
| 12  | **Everything the user types is force-uppercased**, including free-text descriptions.                                                                                           | `phase_data_grid.tsx:780-782` + `store.updatePhase:296`.                                       | Low/Med  |
| 13  | **Cost columns look editable** (`editable: true`, editable-cell styling excluded but hover/cursor rules apply) yet silently refuse edits.                                      | `columns` all declare `editable: true`; `notEditableCells` blocks 9 of them at runtime.        | Low      |
| 14  | **Enter does not open the editor** (it moves down a row) — a deviation from Excel that requires learning F2 or double-click.                                                   | `excel_navigation_data_grid.tsx:601-617`.                                                      | Low      |
| 15  | **Errors are silent.** All mutation paths swallow/ignore failures — no snackbars in this area; `handleProcessRowUpdateError` only `console.error`s.                            | `excel_navigation_data_grid.tsx:751-753`; `api/wbs.ts:74-80` `.catch(console.log)`.            | Med      |
| 16  | **Nested scroll containers** (page `overflow:auto` around a virtualized grid) plus a 3-layer chrome (app bar + drawer + bottom panel) squeeze the grid.                        | `wbs_home.tsx:40-51`.                                                                          | Low      |
| 17  | Deleting many phases at once **throws** (Firestore `in` limit, §11.3) with no user-visible error.                                                                              | `newAPI/api.ts:160-163`.                                                                       | High     |
| 18  | The proposal-level "WBS Select" dialog list is hard-coded from `WbsEnum`, not from the dataset that actually created the WBS docs — the two can drift.                         | `select_wbs_dialog.tsx:39` uses `WbsArray`; creation uses `data/v1/wbs_v1.json`.               | Low      |

---

## 11. Dead or broken code found

### 11.1 Dead files / components (never imported or never reachable)

- **`components/add_phase_button.tsx`** — an extended FAB "Add Phase". Repo-wide grep: imported
  nowhere. Fully dead.
- **`components/copy_from_phase_dialog.tsx`** — mounted at `activity_data_grid.tsx:1355` but
  `setOpenCopyDialog(true)` is never called → unreachable UI. The same-WBS "copy from phase" flow is
  therefore **not shippable today**.
- **`AddPhaseDialog` instance inside `components/drawer.tsx:432`** — `setAddPhaseDialogOpen` is
  declared (line 123) and never called; the dialog is mounted twice in the tree (drawer + bottom
  panel), only the bottom-panel one is reachable.
- **`hooks/wbs_hook.ts` (`useWbs`)** — 165 lines, an `onSnapshot`-based WBS loader with per-WBS
  `getActivitiesForWbs` + `getPhasesForWbs` (classic N+1: one query per WBS, then one query per
  phase for its activities). Imported nowhere.
- **`hooks/phase_hook.ts` (`usePhases`)** — same shape for phases (one activity query per phase).
  Imported nowhere. It contains the _correct_ `customUnit`/`customQuantity` handling that the live
  store lacks.
- **`api/phase.ts`** — almost entirely dead: `insertPhase`, `updatePhase`, `deletePhaseBatch`,
  `duplicatePhases`, `copyActivitiesFromPhase` (the version with labor-constant remapping),
  `updateSingleProposal` (a duplicate of the one in `api/proposal.ts`), `getPhasesForWbs` (used only
  by dead `useWbs`), `getSinglePhase` (used only by the dead copy function). All live phase writes
  go through `newAPI/api.ts` instead. Two divergent implementations of every phase operation now
  exist in the repo.
- **`api/wbs.ts:83-109` `getQuantityAndUnitForWbs`** — never called. Also carries a _different_ unit
  map than the live code (it includes `30000: 'CY'`, the live one does not).
- Unused imports in `api/wbs.ts` (`deleteDoc`, `getDocs`, `query`, `where`, `WbsEnum`,
  `numberFields` partially) and a commented-out `WbsEnum` block at the bottom of `models/wbs.ts`.

### 11.2 Dead code paths inside live files

- `sanitizePhaseColumnVisibilityModel` (`phase_data_grid.tsx:50-55`) — takes a `_wbsDatabaseId` it
  ignores and returns `{...model}`. Vestigial.
- `.under` / `.over` / `.not-used` CSS in `phase_data_grid.tsx:689-700` — no code assigns these
  class names in this grid.
- `'completed-row '` class added by `getCellClassName` — no matching CSS rule exists (only
  `completed-row-light` / `-dark`).
- `calculateWbsTotals`'s `quantity`/`unit` accumulation — overwritten immediately in
  `loadFullProposalData`.
- Phase-level `craftManHours` / `welderManHours` doc override branch — nothing writes those fields.
- `insertProposalPreferences` builds `tempArray` of all WBS names and discards it.
- `copy_from_phase_dialog.tsx:60-66` `checkSameValue` helper — declared, never used; `toPhase` state
  and the `sorted` local (line 56) are computed and never used.
- `localStorage['phases_sort']` / `['phases_filter']` — write-only.
- `store.changeActivityOrder` is marked `// TODO: COME BACK TO THIS AND FIX` (`utils/store.ts:552`).

### 11.3 Actual bugs

1. **Deleting more than 10 phases throws.** `deletePhasesInFirestore` uses
   `where('phaseId','in', phaseIds)`; Firebase JS SDK 9.10.0 caps `in` at **10 elements**. The phase
   docs would already be staged in the batch, but the throw happens before `commit()`, so the
   operation aborts entirely — with no user feedback (the error propagates out of an unhandled
   `await` in the click handler). `newAPI/api.ts:160-163`.
2. **Duplicate of multiple phases can scramble local state.** `newPhaseIds.push()` happens _after_
   `await getDoc(...)` inside `phaseIds.map(async …)` + `Promise.all`, so array order follows
   completion order, not input order. The store then pairs `newPhaseIds[i]` with `phaseIds[i]` and
   remaps activities via `newPhaseIds[phaseIds.indexOf(oldPhaseId)]` — with ≥2 phases the optimistic
   UI can attach copies/activities to the wrong phase until a full reload. `newAPI/api.ts:187-216` +
   `utils/store.ts:356-379`.
3. **Batch-size ceiling.** Duplication puts every phase _and every activity_ into a single
   `writeBatch` (Firestore hard limit 500 writes) — duplicating a handful of dense phases fails.
   `newAPI/api.ts:182-218`. (The activity batch-update helper _does_ chunk at 500; this one
   doesn't.)
4. **Quantity override disappears until reload.** Editing `Quantity` writes Firestore
   `customQuantity` but patches local `quantity` (as a **string**). Any subsequent
   `recalculatePhase` (fired by every activity add/edit/copy on the phase screen) recomputes
   `quantity = customQuantity ?? computed` using the _stale_ local `customQuantity` → the user's
   override visually reverts. `newAPI/api.ts:133-138` vs `utils/store.ts:300-315` vs `:229-233`.
5. **Unit override is inconsistent between loader and recalculator.** Grid edits write the `unit`
   field; `loadFullProposalData` reads `phase.unit ?? computed` (works), but `recalculatePhase`
   reads `phase.customUnit ?? computed` (ignores `unit`) → a manually typed unit vanishes from the
   UI after any activity change, and returns after a reload. `utils/store.ts:143-146` vs `:234-236`.
6. **Quantity displays unformatted after an edit.** Because local state holds the raw string, the
   `toLocaleString(min2,max2)` formatter is a no-op on it (String.prototype.toLocaleString ignores
   options) — the cell loses its 2-decimal formatting until reload.
7. **`hide: true` on the four money columns is ignored.** MUI v5 sets
   `shouldRegenColumnVisibilityModelFromColumns = !isUsingColumnVisibilityModel`
   (`@mui/x-data-grid/hooks/features/columns/useGridColumns.js:14,24`), and this grid always passes
   a controlled `columnVisibilityModel` → `materialCost`, `equipmentCost`, `subContractorCost`,
   `costOnlyCost` render **visible** despite `hide: true`. (The Proposal-Home WBS grid, which has no
   controlled model, does honor its `hide` flags — so the two grids disagree.)
8. **`insertAllBaseWbs` does not await its writes** (`forEach(async …)`), so `insertProposal`
   resolves before the 18 WBS docs exist; a fast navigation into the new proposal can load zero WBS.
   No idempotency guard either — a re-run would create duplicates.
9. **Proposal deletion orphans phases.** `deleteProposalAndAssociatedData` deletes from collection
   `'phases'` (`api/proposal.ts:135`) while the real collection is `'phase'` — every phase document
   of a deleted proposal is left behind.
10. `AddPhaseDialog`'s `<Select>` is controlled without `onChange` (selection handled by
    `MenuItem onClick`) — React logs a controlled-component warning and keyboard selection semantics
    are non-standard. `add_phase_dialog.tsx:193-207`.
11. `SelectWbsDialog` sorts `WbsArray` **in place**, mutating a shared exported constant
    (`select_wbs_dialog.tsx:91-95`).
12. `getQuantityAndUnit` `'HE'` keyword matching is substring-based over the whole description →
    false positives on any description containing "HE" (SHEET, THE, HEAT…).
    `utils/utils.ts:210-241`.
13. Debug `console.log` left in the hot path: `getQuantityAndUnit` logs for every phase on every
    recompute; `recalculatePhase` logs `'QUANTITY'`; `activity_data_grid` logs on every filter pass.

---

## 12. PARITY CHECKLIST — capabilities Precision must eventually have from this area

**WBS structure & lifecycle**

- Seed every new proposal with the standard 18-WBS set, each carrying a numeric code
  (`10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000, 130000, 140000, 150000, 180000, 190000, 200000`)
  and its canonical name.
- Seeding must be atomic/idempotent (legacy fire-and-forget creation is a bug to fix, not port).
- WBS ordering by code ascending everywhere it is listed.
- WBS visibility per proposal: a persisted set of "WBS shown for this proposal" (legacy stores names
  in `proposal-preferences.wbsToDisplay`) + a picker UI with search and multi-select.
- A signal that hidden WBS still contain cost/hours (legacy: amber "Hidden WBS data" chip).
- Read-only WBS roll-up row/table: quantity, unit, craft MH, craft total, welder MH, welder total,
  material total, equipment total, sub total, cost-only total, grand total, plus a "completed" state
  derived from _all phases completed_.
- WBS quantity/unit override fields (`customQuantity`, `customUnit`) — modeled in legacy, no UI;
  Precision should either implement or explicitly drop them.
- Versioned reference datasets per proposal (`datasetVersions.{labor,phases,wbs,equipment}` with
  fallback resolution) so old proposals keep their original catalogs.

**Navigation**

- Navigate Proposal → WBS → Phase and back, with a breadcrumb showing proposal number/description ›
  WBS name › phase number/description.
- Selecting a WBS from a list/dropdown of visible WBS (shows `code + name`).
- Phase list in the navigation rail, searchable by phase number **or** description, showing number +
  description with active-item highlighting.
- **Fix in Precision:** open a WBS from the WBS table row and open a phase from the phase table row
  (legacy supports neither).

**Phase creation**

- Create a phase inside a WBS from a catalog of phase templates scoped to that WBS's code (`phases`
  dataset: 228 rows of `{wbsDatabaseId, phaseDatabaseId, description}`).
- Persist `phaseDatabaseId` + `phaseDatabaseName` on the phase (later used to re-resolve labor
  constants).
- Auto-suggest phase number: reserved catalog ids (108-value list) become the phase number verbatim;
  otherwise `max(existing non-reserved phase number in the WBS, wbsCode) + 1`.
- Auto-fill description from the catalog for MOBILIZE / DEMOBILIZE / SUPPORT, and lock their phase
  number; free-text description for all other WBS.
- Allow manual override of the suggested number and description (override sticks until the template
  selection changes).
- Uppercase normalization of the stored description (legacy behavior — decide whether to keep).
- **Fix in Precision:** validation (required template, numeric/unique phase number, non-empty
  description), a Cancel affordance, and creation from the grid itself.

**Phase grid (the core deliverable)**

- One row per phase in the selected WBS, sorted by phase number ascending by default.
- Columns: Completed (checkbox), Phase (number), Size, FLC, Line/Description, Spec, Insul, Insl.
  Size, Sht, Area, Status, Sys, Quantity, Units, Craft MH, Craft Total, Welder MH, Welder Total,
  Material Total, Equip Total, Sub Total, Cost Only Total, Total.
- Editable set: phase number, size, flc, description, spec, insulation, insulation size, sheet,
  area, status, sys, quantity, unit, completed. All hour/cost columns are read-only derived values.
- Number formatting: 2-decimal thousands separators for quantity/man-hours; `$` + 2 decimals for all
  cost columns; blank for null.
- `Area` must remain a string (never coerced to a number).
- Quantity edits write a **manual override** distinct from the derived quantity, and a cleared value
  must restore the derived value.
- Unit edits write a manual override distinct from the derived unit.
- Per-WBS column presets: hide `size, flc, spec, insulation, insulationSize, sheet` for WBS codes
  `10000, 20000, 30000, 40000, 50000, 60000, 80000, 110000, 150000, 180000, 190000, 200000`; show
  them for `70000, 90000, 100000, 120000, 130000, 140000`.
- User column show/hide on top of those presets, persisted (Precision should scope persistence per
  WBS/user, and also persist sort + filter, which legacy writes but never reads).
- Density control.
- Completed phases visually distinct (legacy: green row background, alternating shades).
- Zebra striping and a compact, tabular-numeral spreadsheet look.
- Read-only mode for users without write permission (all editing, duplicate and delete disabled).

**Grid keyboard / editing model (must match or beat)**

- Arrow-key cell navigation; Tab / Shift+Tab move to the next/previous **editable** cell, skipping
  read-only columns, wrapping across rows.
- Enter / Shift+Enter move down/up a row (configurable next-row vs next-cell vs stay).
- F2 toggles edit mode; double-click edits with the cursor at the click point.
- Type-to-replace on a printable key; Backspace clears and enters edit; Delete clears and commits.
- Esc discards the in-progress edit; click-away commits without stealing focus back.
- Auto-commit on navigation; focus restoration after the underlying rows change.

**Phase management actions**

- Multi-select phases (Precision must add an explicit checkbox column — legacy relies on invisible
  row-click selection).
- Duplicate selected phases _with all of their activities_ (Precision must also resolve the
  phase-number collision and support >500 writes).
- Delete selected phases with a confirmation dialog, cascading to their activities (must support
  arbitrary selection sizes — legacy breaks above 10).
- Mark a phase completed/incomplete from the grid (and from the phase screen), rolling up to "WBS
  completed" when all phases are complete.
- Copy all activities from another phase in the **same WBS** into the current phase (legacy dialog
  exists but is unreachable — parity means making this work).
- Copy all activities from **any phase in the proposal** into the current phase, with a searchable
  picker showing WBS name + phase number + description.
- When copying across phases with different phase-database templates, re-resolve each labor
  activity's constant (craft constant, weld constant, craft units) to the equivalent constant for
  the destination template (legacy logic exists in `api/phase.ts` but is dead — the shipped path
  copies raw, which is arguably wrong).
- Change a phase's catalog template after creation, remapping every activity's labor constant
  (legacy: the "Database" select on the phase screen).

**Derived numbers / business rules to reproduce**

- Phase totals = sums of activity
  `costOnlyCost, subContractorCost, materialCost, equipmentCost, craftCost, welderCost, craftManHours, welderManHours, totalCost`,
  where subcontractor items are excluded from the material/equipment/craft sums but included in
  `subContractorCost` and `totalCost`.
- WBS totals = sums of phase totals.
- Derived phase quantity/unit by WBS code:
  - `20000` → sum of activities whose description contains `EXCAVATE` or `BACKFILL / COMPACT`
  - `40000 / 50000 / 60000` → sum of `CLEAN UP` activities
  - `70000 / 130000` → sum of activities matching `HE` (Precision should tighten this match)
  - `30000` → sum of activities matching `/clean\s*up/i`; unit `EA` when the activity's constant
    `phaseDatabaseId ∈ {30011, 30012, 30013, 30015}`, else `CY`
  - all other WBS → no derived quantity
- Manual `customQuantity` on a phase takes precedence over the derived quantity — and (fix) must
  also feed the WBS roll-up.
- Indirect vs direct hour classification: WBS codes `10000` (mobe), `190000` (demobe), `200000`
  (support), `180000` (specialty) are indirect; everything else is direct craft/welder.
- Subcontractor hours = `Σ quantity × time` over subcontractor activities.
- Loaded-rate formulas (craft & welder) and per-type cost formulas as in §9.4 — the phase grid is
  their display surface.

**Status/summary surfaces**

- A context-aware totals bar that scopes to proposal / WBS / phase, showing Total Cost, Total Hrs,
  Direct, Indirect, Sub Hrs, with an expandable breakdown (Hours: craft, welder, support,
  mobe/demobe, specialty, subcontractor; Labor costs: craft, weld & rig, subcontractor; Other:
  equipment, material, cost only), and remembering its expanded state.

**Things NOT to port**

- The `hide`-vs-`columnVisibilityModel` conflict, the write-only sort/filter persistence, the
  invisible row selection, the unreachable dialogs, the duplicated API layer (`api/*` vs
  `newAPI/*`), blanket uppercasing of user text, silent error handling, and the
  `'phases'`-vs-`'phase'` collection-name mismatch.
