# Legacy MCP Estimator — Activity Data Grid & Activity Entry (Phase Home)

**Audit date:** 2026-07-26 **Source root:** `/Users/collinwillis/Dev/Personal/mcp_estimator`
**Area:** The Phase Home screen — the activity data grid (the core workhorse of the app) plus every
path by which activities are created, edited, ordered, copied, rate-adjusted, and deleted.

Everything below was verified against source. Claims about "dead" or "broken" are backed by
grep-verified call-site evidence, noted inline.

---

## 0. File map (what actually runs)

| File                                                          | Lines | Status               | Role                                                                                                                                               |
| ------------------------------------------------------------- | ----- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/phase home/phase_home.tsx`                      | 35    | **LIVE**             | Screen shell: flex column = `<ActivityDataGrid/>` (scroll area) + `<BottomPanel/>` (fixed)                                                         |
| `src/features/phase home/components/activity_data_grid.tsx`   | 1378  | **LIVE**             | The whole grid: toolbar, visibility engine, editable-cell rules, cell classes, save path, rate bar, 4 dialogs                                      |
| `src/features/phase home/components/columns2.tsx`             | 442   | **LIVE**             | The **only** column definition set actually rendered (20 static columns)                                                                           |
| `src/features/phase home/components/columns.tsx`              | 656   | **HALF DEAD**        | Its `getActivityColumns()` (lines 11–521) is **never imported**. Only the 11 exported string arrays (`*AvailableCells`, `editable*Cells`) are used |
| `src/components/excel_navigation_data_grid.tsx`               | 816   | **LIVE**             | `ExcelNavigationDataGrid` — styled `DataGridPro` wrapper implementing the Excel keyboard contract                                                  |
| `src/components/bottom_pannel.tsx`                            | 566   | **LIVE**             | Quick-add bar + running totals status bar + collapsible breakdown                                                                                  |
| `src/features/phase home/components/add_activity_dialog.tsx`  | 198   | **LIVE**             | Multi-select labor-constant picker                                                                                                                 |
| `src/features/phase home/components/add_equipment_dialog.tsx` | 225   | **LIVE**             | Multi-select equipment picker                                                                                                                      |
| `src/components/copy_activities_from_proposal_dialog.tsx`     | 144   | **LIVE**             | Copy activities from **any** phase in the proposal                                                                                                 |
| `src/components/copy_from_phase_dialog.tsx`                   | 104   | **DEAD-ish**         | Rendered but its `open` prop (`openCopyDialog`) is never set true                                                                                  |
| `src/components/edit_base_rate_dialog.tsx`                    | 161   | **LIVE**             | Modal duplicate of the inline rate bar                                                                                                             |
| `src/components/formatted_number_input.tsx`                   | 55    | **LIVE**             | `react-number-format` + MUI TextField, `decimalScale=2`, thousand separators                                                                       |
| `src/components/custom_data_grid.tsx`                         | 62    | **NOT IN THIS AREA** | `StyledDataGrid` is used only by `proposal home/components/wbs_data_grid.tsx`                                                                      |
| `src/api/activity.ts`                                         | 677   | **MOSTLY DEAD**      | Superseded by `src/newAPI/api.ts` + Zustand store. See §19                                                                                         |
| `src/hooks/activity_hook.ts`                                  | 135   | **100% DEAD**        | `useActivities` is never imported anywhere                                                                                                         |
| `src/newAPI/api.ts`                                           | 615   | **LIVE**             | Real Firestore write layer used by the store                                                                                                       |
| `src/utils/store.ts`                                          | 798   | **LIVE**             | Zustand `estimatorStore` — single source of truth for activities                                                                                   |
| `src/utils/utils.ts`                                          | 525   | **LIVE**             | `processRawActivity`, `calculateTotals`, `numberToLetters`, sorting helpers                                                                        |
| `src/api/totals.ts`                                           | 148   | **LIVE**             | All cost formulas                                                                                                                                  |
| `src/api/helpers.ts`                                          | 114   | **LIVE**             | Column-visibility persistence to Firestore                                                                                                         |

Stack: React 18, MUI 5.11, **`@mui/x-data-grid-pro` 5.17.21** (v5 — this matters, see §8), Firebase
JS SDK 9, Zustand 4.5, `react-router-dom` `MemoryRouter`.

Route: `/proposal/:proposalId/wbs/:wbsId/phase/:phaseId` (`src/App.tsx:83-92`), wrapped in
`AuthRoute` → `EstimatorDrawer`.

---

## 1. Purpose and the actual user flow

The Phase Home screen is where an estimator does the real work: turning a phase of work into priced
line items. Hierarchy is **Proposal → WBS → Phase → Activity**; this screen is the leaf.

Typical session:

1. User picks a proposal in the left drawer, picks a WBS from `WbsDropdown`, picks a Phase from
   `PhaseList`. Breadcrumb in the app bar shows
   `Proposal# - Description / WBS name / PhaseNumber - Description`.
2. The screen renders the grid for `activities.filter(a => a.phaseId === phaseId)` out of the
   Zustand store. **There is no per-screen fetch** — `loadFullProposalData(proposalId)` loads _all_
   WBS + phases + activities for the whole proposal in one shot (triggered from the drawer's
   download icon and on proposal open).
3. The **Database** select in the grid toolbar chooses which _phase database_ (a JSON catalog of
   labor constants) this phase is pinned to. This is the gate that determines what appears in "Add
   Activity".
4. User clicks **Add → Activity** in the bottom quick-add bar. A modal lists every labor constant
   whose `phaseDatabaseId` matches the phase's, with a search box and checkboxes. Checking N items
   and clicking Add batch-creates N `laborItem` activities carrying a denormalized copy of the
   constant.
5. User clicks **Add → Equipment** for the equipment catalog (same UX), or **Material / Cost Only /
   Custom Labor / Subcontractor** which create a single blank row instantly with a placeholder
   description (`NEW MATERIAL ITEM` etc.) — no dialog.
6. User then lives in the grid: type quantities, tab/enter across, override craft/welder constants,
   set equipment duration/price/ownership. Every committed cell writes to Firestore immediately and
   the row is recomputed client-side.
7. The bottom panel continuously shows Total Cost / Total Hrs / Direct / Indirect / Sub Hrs, with a
   collapsible 3-column breakdown.
8. Row selection (click a row) enables the toolbar's **Delete**, **Reset Constants**, **Edit Rates**
   and the inline rate bar under the grid.
9. **Copy From Phase** clones every activity from another phase in the proposal into this one.
10. A **Complete / Incomplete** switch in the toolbar marks the phase done (green row tint is
    defined in CSS as `.completed-row` but is never applied — see §19).

---

## 2. Data model

### 2.1 `Activity` (runtime, computed) — `src/models/activity.ts`

Class with a 32-arg positional constructor. Fields:

| Field                   | Type                | Origin                                                                               |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `id`                    | `string`            | Firestore doc id                                                                     |
| `proposalId`            | `string`            | stored                                                                               |
| `wbsId`                 | `string`            | stored                                                                               |
| `phaseId`               | `string`            | stored                                                                               |
| `constant`              | `Constant \| null`  | **denormalized copy** of the labor-catalog row                                       |
| `equipment`             | `Equipment \| null` | **denormalized copy** of the equipment-catalog row                                   |
| `description`           | `string`            | stored, always upper-cased on write                                                  |
| `quantity`              | `number`            | stored, user-entered                                                                 |
| `sortOrder`             | `number`            | stored; `?? constant.sortOrder ?? dateAdded ?? 0`                                    |
| `activityType`          | `ActivityType`      | stored, defaults `laborItem`                                                         |
| `unit`                  | `string`            | stored `?? constant.craftUnits ?? ''`                                                |
| `craftConstant`         | `number`            | stored `?? constant.craftConstant ?? 0`                                              |
| `welderConstant`        | `number`            | stored `?? constant.weldConstant ?? 0`                                               |
| `price`                 | `number`            | stored                                                                               |
| `time`                  | `number`            | stored (rendered as "Duration")                                                      |
| `craftManHours`         | `number`            | **computed** `quantity * craftConstant`                                              |
| `welderManHours`        | `number`            | **computed** `quantity * welderConstant`                                             |
| `craftCost`             | `number`            | computed for all types **except** subcontractor (where it is user-entered)           |
| `welderCost`            | `number`            | **computed** always                                                                  |
| `materialCost`          | `number`            | computed for `materialItem`; user-entered for `subContractorItem`; stored otherwise  |
| `equipmentCost`         | `number`            | computed for `equipmentItem`; user-entered for `subContractorItem`; stored otherwise |
| `subContractorCost`     | `number`            | computed for `subContractorItem` only                                                |
| `costOnlyCost`          | `number`            | computed for `costOnlyItem` only                                                     |
| `totalCost`             | `number`            | computed                                                                             |
| `craftBaseRate`         | `number`            | stored override `?? proposal.craftBaseRate`                                          |
| `subsistenceRate`       | `number`            | stored override `?? proposal.subsistenceRate`                                        |
| `weldBaseRate`          | `number`            | always `proposal.weldBaseRate` (never overridable per-activity)                      |
| `customCraftRate`       | `number \| null`    | raw stored override (null = "inheriting")                                            |
| `customSubsistenceRate` | `number \| null`    | raw stored override                                                                  |
| `equipmentOwnership`    | `string \| null`    | `'Rental' \| 'Owned' \| 'Purchase'`                                                  |
| `dateAdded`             | `number \| null`    | epoch ms, assigned at insert (`Date.now()`)                                          |
| `rowId`                 | `string \| null`    | **not persisted** — recomputed as A, B, …, Z, AA, AB… by position                    |

### 2.2 `FirestoreActivity` (persisted shape) — `src/models/firestore models/activity_firestore.ts`

Only 21 fields are ever written:
`proposalId, wbsId, phaseId, unit, constant, equipment, craftConstant, welderConstant, price, time, activityType, description, quantity, craftBaseRate, subsistenceRate, equipmentCost, materialCost, craftCost, equipmentOwnership, dateAdded, sortOrder`.
All computed cost/hours fields are **not** persisted — they are recomputed on every read. (Same
architectural bet Precision is making with Convex; the legacy app already does compute-on-read, just
client-side.)

### 2.3 `Constant` (labor catalog row) — `src/models/constant.ts`

`{ id: number, phaseDatabaseId: number, description: string, sortOrder: number, craftConstant: number, craftUnits: string, weldConstant: number, weldUnits: string }`

Static JSON: `src/data/v1/labor_v1.json` (5,897 rows) and `src/data/v2/labor_v2.json` (5,968 rows),
across **170 distinct `phaseDatabaseId`s**. Largest single phase database has **219 constants**
(e.g. `70001`–`70011`, AG PIPING); median is 16.

### 2.4 `Equipment` (equipment catalog row) — `src/models/equipment.ts`

`{ id: number, description: string, hourRate, dayRate, weekRate, monthRate }`. `equipment_v1.json` =
129 rows, `equipment_v2.json` = 133 rows.

```ts
enum EquipmentUnit {
  hours = "Hours",
  days = "Days",
  weeks = "Weeks",
  months = "Months",
  each = "EA",
}
enum EquipmentOwnership {
  rental = "Rental",
  owned = "Owned",
  purchase = "Purchase",
}
```

### 2.5 Dataset versioning

`getProposalDatasetVersions(proposal)` reads `proposal.datasetVersions`
(`{labor, phases, wbs, equipment}`), falling back to the default version, and `resolveDataset()`
walks _backwards_ through `DATA_VERSION_ORDER` until it finds a dataset that exists. So a proposal
pinned to `v2` phases falls back to `v1` because only `phases_v1.json` exists. **Every proposal is
frozen against a catalog version** — this is a genuine requirement Precision must reproduce.

### 2.6 Proposal rate fields that drive activity cost (15)

From `src/models/proposal.ts`: `craftBaseRate`, `weldBaseRate`, `subsistenceRate`, `useTaxRate`,
`salesTaxRate`, `overheadRate`, `consumablesRate`, `burdenRate`, `fuelRate`, `rigRate`,
`laborProfitRate`, `materialProfitRate`, `equipmentProfitRate`, `subContractorProfitRate`,
`rigProfitRate`. All percentage rates are stored as whole numbers and divided by 100 in the
formulas.

### 2.7 WBS catalog (`wbs_v1.json`, 18 entries)

`10000 MOBILIZE, 20000 SITE PREPARATION, 30000 CONCRETE, 40000 TOWERS/VESSELS/EQUIPMENT, 50000 PUMPS & DRIVERS, 60000 STRUCTURAL, 70000 AG PIPING, 80000 ELECTRICAL, 90000 INSTRUMENTS, 100000 INSULATION, 110000 PAINTING, 120000 DISMANTLING, 130000 BG PIPING, 140000 REFRACTORY, 150000 BUILDINGS, 180000 SPECIALTY SERVICES, 190000 DEMOBILIZE, 200000 SUPPORT`

---

## 3. The 6 activity types

```ts
enum ActivityType {
  laborItem = "laborItem",
  materialItem = "materialItem",
  equipmentItem = "equipmentItem",
  subContractorItem = "subContractorItem",
  costOnlyItem = "costOnlyItem",
  customLaborItem = "customLaborItem",
}
```

### 3.1 Full behavior matrix

|                                             | **laborItem**                                                                                     | **customLaborItem**           | **equipmentItem**                                                   | **materialItem**                                          | **costOnlyItem**                                          | **subContractorItem**                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Created by                                  | Add Activity dialog (from a `Constant`)                                                           | quick-add button              | Add Equipment dialog (from an `Equipment`)                          | quick-add button                                          | quick-add button                                          | quick-add button                                                                     |
| Default description                         | constant's description                                                                            | `NEW CUSTOM LABOR ITEM`       | equipment description, upper-cased                                  | `NEW MATERIAL ITEM`                                       | `NEW COST ONLY ITEM`                                      | `NEW SUBCONTRACTOR`                                                                  |
| Carries `constant`                          | ✅ yes                                                                                            | ❌ null                       | ❌ null                                                             | ❌ null                                                   | ❌ null                                                   | ❌ null                                                                              |
| Carries `equipment`                         | ❌ null                                                                                           | ❌ null                       | ✅ yes                                                              | ❌ null                                                   | ❌ null                                                   | ❌ null                                                                              |
| Default `unit`                              | `constant.craftUnits`                                                                             | `null`                        | `Months`                                                            | `null`                                                    | `null`                                                    | `HOURS`                                                                              |
| Default `price`                             | 0                                                                                                 | 0                             | `equipment.monthRate`                                               | 0                                                         | 0                                                         | 0                                                                                    |
| Default `sortOrder`                         | `constant.sortOrder`                                                                              | `null` → falls to `dateAdded` | alphabetical insert (see §11.3)                                     | `null`                                                    | `null`                                                    | `null`                                                                               |
| Default ownership                           | null                                                                                              | null                          | `Rental`                                                            | null                                                      | null                                                      | null                                                                                 |
| **Editable cells**                          | rowId, description, quantity, unit, craftConstant, welderConstant                                 | _same as laborItem_           | rowId, description, quantity, price, time, unit, equipmentOwnership | rowId, description, quantity, price, unit                 | rowId, quantity, description, price                       | rowId, quantity, description, time, unit, **equipmentCost, materialCost, craftCost** |
| **"Applicable" (not struck-through) cells** | + craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate | _same_                        | + equipmentCost, totalCost, craftBaseRate, subsistenceRate          | + materialCost, totalCost, craftBaseRate, subsistenceRate | + costOnlyCost, totalCost, craftBaseRate, subsistenceRate | + subContractorCost, totalCost, craftBaseRate, subsistenceRate                       |
| **Cost formula that runs**                  | craftCost + welderCost                                                                            | craftCost + welderCost        | equipmentCost                                                       | materialCost                                              | costOnlyCost                                              | subContractorCost (+ welderCost is still computed!)                                  |
| **`totalCost` =**                           | sum of all 6 buckets                                                                              | sum of all 6 buckets          | sum of all 6 buckets                                                | sum of all 6 buckets                                      | sum of all 6 buckets                                      | **= `subContractorCost` only**                                                       |
| Per-activity rate override allowed          | only if WBS=200000 or phase∈{180002,180003,180004}                                                | ✅ always                     | only if WBS=200000 / special phases                                 | same                                                      | same                                                      | same                                                                                 |
| Ownership/unit dropdowns rendered           | ❌                                                                                                | ❌                            | ✅ both                                                             | ❌                                                        | ❌                                                        | ❌                                                                                   |

Source for the editable/available sets: `columns.tsx:523-648` (the 11 exported arrays). Source for
which formula runs: `utils.ts:151-183` (`processRawActivity`).

### 3.2 Notable per-type quirks (verified)

- **`welderCost` is computed for EVERY type**, including subcontractor, material, cost-only and
  equipment (`utils.ts:166`, unconditional). For non-labor types `welderConstant` is 0 so
  `welderManHours` is 0 and the cost is 0 — but the guard is absent, not the arithmetic.
- **`craftCost` is computed (overwriting stored value) for every type EXCEPT subcontractor**
  (`utils.ts:151`). That's why `craftCost` is a _user-editable_ cell for subcontractor rows only —
  it is the sub's labor component fed into the subcontractor formula.
- **`equipmentCost` / `materialCost` on a subcontractor row are raw stored numbers** (they're only
  recomputed for `equipmentItem` / `materialItem`), which is exactly why they're editable there.
- `laborItem` vs `customLaborItem` are **behaviorally identical in the grid** — same editable set,
  same formula. The only differences: `customLaborItem` has no `constant` (so Reset Constants zeroes
  it instead of restoring a catalog value, and the over/under coloring never fires), and it is
  **always allowed a per-activity base-rate override**.

---

## 4. Column inventory — `columns2.tsx` (the live set: 20 columns, fixed order)

All columns are `flex: 1` (except `time`, `price`, `materialCost`, `costOnlyCost`,
`subContractorCost` which have no flex), `headerAlign: 'center'`, `density='compact'`.

| #   | `field`              | Header                  | Align               | `editable` (column-level) | Formatter                                                                     |
| --- | -------------------- | ----------------------- | ------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| 1   | `rowId`              | **Item**                | center              | ✅                        | none; custom `sortComparator` (length-first, then lexicographic → A…Z, AA…AZ) |
| 2   | `description`        | **Description**         | left (minWidth 250) | ✅                        | none                                                                          |
| 3   | `quantity`           | **Quantity**            | right               | ✅                        | none (raw number, no thousands separator)                                     |
| 4   | `unit`               | **Unit**                | right               | ✅                        | `renderCell`: `<Select>` **only for `equipmentItem`**, else `null`            |
| 5   | `time`               | **Duration**            | right               | ✅                        | none                                                                          |
| 6   | `price`              | **Price**               | right               | ✅                        | `$` + 2dp, `toLocaleString`                                                   |
| 7   | `equipmentOwnership` | **Ownership**           | right               | ✅                        | `renderCell`: `<Select>` **only for `equipmentItem`**, else `null`            |
| 8   | `craftConstant`      | **Craft Const.**        | right               | ✅                        | none                                                                          |
| 9   | `welderConstant`     | **Welder Const.**       | right               | ✅                        | none                                                                          |
| 10  | `craftManHours`      | **Craft Hours**         | right               | ❌ (undefined)            | 2dp                                                                           |
| 11  | `welderManHours`     | **Welder Hours**        | right               | ❌                        | 2dp                                                                           |
| 12  | `welderCost`         | **Welder Total**        | right               | ❌                        | `$` + 2dp                                                                     |
| 13  | `craftCost`          | **Craft Total**         | right               | ✅                        | `$` + 2dp                                                                     |
| 14  | `craftBaseRate`      | **Craft Base**          | right               | ❌                        | `$` + `toLocaleString` (no forced 2dp)                                        |
| 15  | `subsistenceRate`    | **Subsistence**         | right               | ❌                        | `$` + `toLocaleString`                                                        |
| 16  | `equipmentCost`      | **Equipment Total**     | right               | ✅                        | `$` + 2dp                                                                     |
| 17  | `materialCost`       | **Material Total**      | right               | ✅                        | `$` + 2dp                                                                     |
| 18  | `costOnlyCost`       | **Cost Only Total**     | right               | ✅                        | `$` + 2dp                                                                     |
| 19  | `subContractorCost`  | **Subcontractor Total** | right               | ❌                        | `$` + 2dp                                                                     |
| 20  | `totalCost`          | **Total**               | right               | ❌                        | `$` + 2dp                                                                     |

Column-level `editable: true` is only a _gate_; the real per-row rule is `isCellEditable` (§5). The
`hide: true` flags on `craftBaseRate` / `subsistenceRate` are the **MUI v4 API and are inert** in v5
when `columnVisibilityModel` is controlled — those two columns are hidden only because the default
persisted visibility model says so.

### 4.1 Why there are two column files

`columns.tsx` (July 2025) is the **original dynamic column builder**: it took `activities[]`,
scanned them for `hasEquipment / hasMaterial / hasCostOnly / hasSubcontractor`, then **mutated a
`baseColumns` array with `splice()`** to insert the `equipmentOwnership`, `time`, `price`,
`equipmentCost`, `materialCost`, `costOnlyCost`, `subContractorCost` columns at hand-computed
indices (`baseColumns.length - 2`, `baseColumns.length - 1`, `3`, `1`…). It also duplicated
`equipmentCost` (it's in `baseColumns` at line 256 **and** spliced in again at line 291 — a genuine
duplicate-field bug) and looked each row's activity up with
`activities.find(a => a.id === params.id)` inside `renderCell` — an O(n) scan per cell render.

`columns2.tsx` (Dec 2025) is the rewrite: **static 20-column array, no `activities` dependency, no
splicing**, `params.row` used directly instead of `.find()`, and a comment at line 440 stating
visibility is now managed by `columnVisibilityModel`. `activity_data_grid.tsx:67` imports
`getActivityColumns` from `columns2`; `columns.tsx`'s `getActivityColumns` is **never imported by
anything** (grep-verified). Only its 11 constant arrays survive.

**Net: `columns.tsx` lines 1–521 are dead code, ~500 lines.**

---

## 5. Which cells are editable — `isCellEditable`

`activity_data_grid.tsx:936-956`:

```ts
if (!hasWritePermissions) return false;
const map = {
  laborItem: editableLaborItemCells,
  customLaborItem: editableLaborItemCells,
  materialItem: editableMaterialItemCells,
  equipmentItem: editableEquipmentItemCells,
  costOnlyItem: editableCostOnlyItemCells,
  subContractorItem: editableSubcontractorItemCells,
};
return map[activity.activityType]?.includes(params.field) ?? false;
```

`hasWritePermissions` comes from `useUserProfile()` → Firestore
`users/{uid}.permission === 'READ_WRITE'` (`src/hooks/user_profile_hook.ts`). Read-only users get an
entirely non-editable grid **and** no toolbar action buttons and no quick-add bar.

## 6. Cell class semantics — `getCellClassName`

`activity_data_grid.tsx:959-1068`. Returns space-joined class names; CSS at lines 1157–1177.

| Class                  | Applied when                                                                                                                                               | Visual                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `editable-cell`        | field ∈ that type's editable set                                                                                                                           | `color:#111827; font-weight:500`                  |
| `not-used`             | field ∉ that type's **available** set                                                                                                                      | **line-through**, `bg #f9fafb`, `color #d1d5db`   |
| `used`                 | fallback (available but not editable)                                                                                                                      | no styling                                        |
| `over`                 | `laborItem`/`customLaborItem`, field is `craftConstant` and `activity.craftConstant < constant.craftConstant`; or `welderConstant < constant.weldConstant` | red-ish: `bg rgba(239,68,68,.1)`, `color #991b1b` |
| `under`                | same fields, value **greater than** the catalog constant                                                                                                   | amber: `bg rgba(251,191,36,.15)`, `color #92400e` |
| `row-even` / `row-odd` | zebra striping by `indexRelativeToCurrentPage % 2`                                                                                                         | transparent / `#fafafa`                           |
| `completed-row`        | **never applied** — no `getRowClassName` branch produces it                                                                                                | green tint (dead CSS)                             |

⚠️ **The `over`/`under` naming is inverted from intuition**: entering a _lower_ constant than the
catalog (a more aggressive/optimistic estimate) paints the cell **red / `over`**; a _higher_
constant paints it **amber / `under`**. Whatever the intended semantics ("over/under the standard
productivity"), the mapping is not self-evident and there is no legend anywhere in the UI.

---

## 7. The save path (what happens when a cell is committed)

`onProcessRowUpdate` — `activity_data_grid.tsx:1223-1253`:

1. Diff `newRow` vs `oldRow` with `Object.keys(newRow).find(k => newRow[k] !== oldRow[k])`. If
   nothing changed → return `newRow`.
2. If the changed field is **`rowId`** → treat it as a **move command**:
   `handleRowOrderChangeByRowId(id, value)` (case-insensitive lookup of the target letter →
   `changeActivitySortOrder(id, targetIndex, phaseId)`).
3. Otherwise: if the value is a `string` and the field is **not** in `numberFields`, **upper-case
   it**. `numberFields` =
   `quantity, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate, equipmentCost, materialCost, costOnlyCost, price, time, subContractorCost`
   (`utils.ts:388-405`). → so `description` and `unit` are **always forced to UPPERCASE**.
4. `await updateActivity(id, field, finalValue)` (store) → `updateActivityFieldInFirestore` →
   `updateDoc(activities/{id}, {field: value})`. Numeric fields are validated
   (`Number.isNaN(parseFloat(v)) || v.trim()===''` → return `{success:false}`). On success the store
   replaces the row in-memory via `processRawActivity(...)`, re-deriving every computed field.
5. `recalculatePhase(phaseId)` re-derives phase-level totals and the phase's rolled-up `quantity` /
   `unit`.

**Every keystroke-commit is one Firestore `updateDoc` round-trip, awaited before navigation
completes.** There is no batching, no debounce, no optimistic-then-reconcile.

### 7.1 The phase-quantity keyword rule (business logic hidden in the grid)

`getQuantityAndUnit(activities, wbsDatabaseId)` (`utils.ts:198-246`) derives the _phase's_ headline
quantity by **string-matching activity descriptions**:

| `wbsDatabaseId`                   | Keyword(s) matched in `description.toUpperCase()`                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 20000 SITE PREP                   | `EXCAVATE`, `BACKFILL / COMPACT`                                                                                        |
| 40000, 50000, 60000               | `CLEAN UP`                                                                                                              |
| 70000 AG PIPING, 130000 BG PIPING | `HE`                                                                                                                    |
| 30000 CONCRETE                    | special: regex `/clean\s*up/i`; unit forced to `EA` if `constant.phaseDatabaseId ∈ {30011,30012,30013,30015}` else `CY` |

Matching rows have their `quantity` summed and their `unit` adopted. So **renaming an activity can
silently change the phase's reported quantity**. (A commented-out block shows an earlier, wider
keyword set `["HE","OFF","HYDRO","PNEU"]`.)

---

## 8. Excel-style keyboard navigation contract

Implemented in `ExcelNavigationDataGrid` (`excel_navigation_data_grid.tsx`). Props passed by the
activity grid: `enableExcelNavigation={true}`, `autoCommitOnNavigation={true}`,
`enterBehavior='next-row'`, `tabBehavior='next-cell'`, `skipNonEditableCells={true}`,
`wrapNavigation={true}`, `debugMode={false}`, `editMode='cell'`,
`experimentalFeatures={{newEditingApi:true}}`.

### 8.1 What actually works

| Input                                   | Behavior (verified)                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Arrow ↑ ↓ ← →** (view mode)           | MUI native cell focus movement. Moves through **all** cells including non-editable and struck-through ones. Not intercepted by the wrapper.                                                                                        |
| **Enter** (view mode)                   | Intercepted in `handleCellEditStart` (`reason === enterKeyDown`) → `defaultMuiPrevented = true` → **navigates down** to the next _editable_ cell (skipping non-editables) instead of entering edit mode. Does NOT open the editor. |
| **Shift+Enter** (view mode)             | Same, direction **up**.                                                                                                                                                                                                            |
| **Enter** (edit mode)                   | `handleCellEditStop` → `stopCellEditMode` (commit) → find next editable cell **down** → `setCellFocus` there, **in view mode** (`navigateAndEdit(next, false)`).                                                                   |
| **Shift+Enter** (edit mode)             | Commit, move **up**.                                                                                                                                                                                                               |
| **Tab** (view mode)                     | Handled in `handleCellKeyDown` → `preventDefault` → next editable cell **right** (wrapping to the next row's first editable cell, and from the last row wrapping to row 0).                                                        |
| **Shift+Tab** (view mode)               | Next editable cell **left**, wrapping backwards; from row 0 col 0 it wraps to the **last row's last column**.                                                                                                                      |
| **Tab / Shift+Tab** (edit mode)         | Commit + move right/left, landing in **view mode**.                                                                                                                                                                                |
| **F2**                                  | Toggle edit mode. Sets `suppressSelectOnEdit` so the text is **not** select-all'd (cursor placed, Excel-like). No MUI default for F2 — this is bespoke.                                                                            |
| **Escape** (edit mode)                  | `stopCellEditMode({ignoreModifications:true})` → discard, stay on the cell, re-focus via `requestAnimationFrame`.                                                                                                                  |
| **Any printable character** (view mode) | MUI native: enters edit mode with `initialValue` = the typed char (type-to-replace).                                                                                                                                               |
| **Backspace** (view mode)               | MUI native `deleteValue`: clears the cell and enters edit mode empty.                                                                                                                                                              |
| **Delete** (view mode)                  | Bespoke: lets MUI enter edit with `deleteValue`, then `setTimeout(…, 0)` calls `stopCellEditMode` → commits an empty value and returns to view mode.                                                                               |
| **Double-click**                        | MUI native edit entry; the wrapper explicitly returns early to let MUI place the caret at the click position.                                                                                                                      |
| **Click away while editing**            | `reason === 'cellFocusOut'` → commit, **no navigation**, `lastFocusedCell` cleared so MUI doesn't steal focus back from the click target.                                                                                          |
| Focus restoration                       | `useEffect` on `[rows, columns]` re-focuses `lastFocusedCell` via `requestAnimationFrame` if the row+column still exist — so an async save that reshuffles rows doesn't lose your place.                                           |

### 8.2 Navigation algorithm details

- `getNavigableColumns()` = visible columns filtered by `isNavigableColumn`: drops `__check__`,
  `actions`, `type==='actions'|'checkboxSelection'`, any field starting `__`, and any column with
  `editable === false`. **Columns with `editable` undefined are treated as navigable** — they are
  then rejected one level deeper by `isCellRuntimeEditable` (which calls the grid's `isCellEditable`
  prop), so they are skipped in practice.
- `findNextEditableCell` loops with a `maxIterations = rows × cols` guard.
- Wrap semantics with `wrapNavigation=true`: right past the last column → next row col 0; from the
  **last** row → **row 0, col 0**. Down past the last row → row 0 (same column). Symmetric for
  left/up.
- `navigateAndEdit(pos, startEdit)` always defers via `requestAnimationFrame` so MUI finishes its
  `stopCellEditMode` before a new edit session starts. For Enter/Tab, `startEdit` is **false** — you
  land in view mode and rely on type-to-replace.
- `selectEditingCellInput()` does
  `document.querySelector('.MuiDataGrid-cell--editing input, … textarea').select()` — a global DOM
  query, only used from `navigateAndEdit(…, true)` and F2's suppression flag.

### 8.3 What is **NOT** supported (important gaps)

- ❌ **No copy / paste at all.** Grep for `clipboard|onPaste|copyToClipboard` returns zero hits. MUI
  X **v5** Pro has no clipboard feature (Ctrl+C landed in v6, paste is a v6.9+ _Premium_ feature).
  There is no Ctrl+C, no Ctrl+V, no paste-a-column-from-Excel.
- ❌ **No fill-down / fill handle / Ctrl+D.**
- ❌ **No multi-cell range selection.** MUI v5 has no cell-selection model. Only whole-row
  selection.
- ❌ **No Ctrl+Z / undo.** No undo stack anywhere in the codebase.
- ❌ **No Home/End/PageUp/PageDown/Ctrl+Arrow** handling beyond MUI defaults.
- ❌ **No keyboard shortcut for add/delete/duplicate row.** Every mutation is mouse-driven.
- ❌ **No column-header keyboard sort/filter shortcuts.**
- ⚠️ `autoCommitOnNavigation` is accepted as a prop and **never referenced** in the implementation —
  dead prop.

---

## 9. Row selection and bulk operations

- **`checkboxSelection` is never enabled** (grep-verified: the only hit is a type string inside
  `isNavigableColumn`). So selection is MUI's default click-to-select: clicking any cell selects its
  row; `DataGridPro` allows **Ctrl/Cmd+click** to toggle and **Shift+click** for a range
  (`disableMultipleSelection` is not set).
- `onSelectionModelChange` → `setSelectedRows(GridRowId[])`.
- **Arrow-key navigation does NOT change the selection** — only focus. So to bulk-delete you must
  physically click/ctrl-click rows.
- Selection drives four things: the toolbar **Delete**, **Reset Constants**, **Edit Rates** buttons,
  and the inline rate bar.

### Bulk operations available

| Operation                              | Trigger                                                                                                                                                                                                                                | Implementation                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Delete activities**                  | Toolbar 🗑 Delete (disabled when 0 selected) → `DeleteConfirmationDialog` ("Are you sure you want to delete the selected activity?" / "Once deleted, this activity cannot be recovered." / Cancel + red Delete, `autoFocus` on Delete) | `deleteActivityBatchInFirestore(ids)` — one Firestore `writeBatch` of deletes → store filter → `recalculatePhase`                                                                                                                                                                                                                                   |
| **Reset Constants**                    | Toolbar ↻ (disabled when 0 selected) — **no confirmation**                                                                                                                                                                             | `resetConstantsBatchInFirestore(ids)` sets `craftConstant: null, welderConstant: null, unit: null`. On re-read `processRawActivity` falls back to `constant.craftConstant / constant.weldConstant / constant.craftUnits`, i.e. **"revert to catalog standard"**. For `customLaborItem` (no constant) this zeroes the constants and blanks the unit. |
| **Edit Rates (modal)**                 | Toolbar ✏️ (disabled when 0 selected) → `EditBaseRateDialog`                                                                                                                                                                           | Re-fetches each selected activity **one `getDoc` at a time**, re-derives the same enable/disable rule, then `updateActivityRatesInFirestore(ids, base, sub)` batch-writes `craftBaseRate` + `subsistenceRate`                                                                                                                                       |
| **Edit Rates (inline bar)**            | The strip directly under the grid                                                                                                                                                                                                      | Same store call `updateActivityRates(ids, base, sub)` + `recalculatePhase`, but reads from the already-loaded `filtered` array (no refetch)                                                                                                                                                                                                         |
| **Copy activities from another phase** | Toolbar 📄 "Copy From Phase" → `CopyActivitiesFromProposalDialog`                                                                                                                                                                      | `copyActivitiesFromPhaseToPhaseInFirestore(from, to)` — reads all source activities, `writeBatch.set` clones with the new `phaseId` + `createdAt: new Date()`                                                                                                                                                                                       |
| **Change phase database**              | Toolbar "Database" `<Select>`                                                                                                                                                                                                          | Updates `phase.phaseDatabaseName` + `phase.phaseDatabaseId`, then remaps **every** activity's embedded `constant` to the same-description constant in the new database via `updateActivitiesBatch`                                                                                                                                                  |
| **Mark phase complete**                | Toolbar `<Switch>`                                                                                                                                                                                                                     | `updatePhase(phaseId, 'completed', bool)`                                                                                                                                                                                                                                                                                                           |

❌ **There is no "Duplicate Activity"** anywhere in the app. `duplicatePhases` exists at the phase
level only (`store.duplicatePhases` → `duplicatePhasesAndActivitiesInFirestore`), reachable from the
phase list, not from this grid.

❌ **There is no row context menu** (no right-click menu of any kind).

❌ **There is no export** (no `GridToolbarExport` in this grid; only Columns + Density).

---

## 10. Toolbar inventory (`CustomActivityToolbar`, lines 142–385)

Left cluster:

1. **Database** `<Select>` (label "Database", `minWidth 200`). Options = every entry in
   `phases_v#.json` whose `wbsDatabaseId` matches the current WBS. **Note: there is no `onChange`
   handler on the `Select`** — each `MenuItem` carries its own `onClick` calling
   `onChangePhaseDatabase(option)`.
2. `<GridToolbarColumnsButton>` — MUI's column show/hide panel.
3. `<GridToolbarDensitySelector>` — Compact / Standard / Comfortable.
4. **Complete / Incomplete** `<Switch>` + label; the pill turns light green (`#f0fdf4`) when
   complete.

Right cluster (rendered **only** when `hasWritePermissions`): 5. **Delete** (red outline,
`TrashIcon`) — disabled unless rows selected. 6. **Reset Constants** (`RefreshIcon`) — disabled
unless rows selected. 7. **Edit Rates** (`EditRounded`) — disabled unless rows selected. 8. **Copy
From Phase** (dark filled, `FileCopy`) — always enabled.

No search box, no filter button, no export, no undo, no "add row" button (add lives in the bottom
panel, physically separated from the rest of the actions).

---

## 11. Row ordering

### 11.1 `rowId` — the "Item" column

Not persisted. Recomputed on every recalculation of `filtered`:

```ts
const sorted = sortActivitiesWithEquipmentLogic(activitiesForPhase);
sorted.map((a, i) => ({ ...a, rowId: numberToLetters(i + 1) })); // A, B, … Z, AA, AB …
```

`numberToLetters` is base-26 bijective (`utils.ts:187-196`).

### 11.2 Reordering by typing a letter

The **only working reorder mechanism**: edit the "Item" cell and type another row's letter.
`onProcessRowUpdate` routes `rowId` changes to `handleRowOrderChangeByRowId`, which finds the index
of the row whose `rowId` matches (case-insensitive) and calls
`changeActivitySortOrder(activityId, targetIndex, phaseId)`.

`store.changeActivitySortOrder` (lines 746–797):

- filters the phase's activities, sorts by `sortOrder`, splices the moved activity to `newIndex`;
- new `sortOrder` = midpoint of the neighbors' sort orders, or `prev + 0.01` if they collide;
- **mutates `activity.sortOrder` directly on the store object** (not immutably);
- fires `updateSortOrderBatchInFirestore(updatedActivities)` **without awaiting it** — a
  `writeBatch` that rewrites the `sortOrder` of **every activity in the phase**, not just the moved
  one.

### 11.3 Equipment auto-sorting

`calculateEquipmentSortOrder(description, existingActivities)` (`utils.ts:465-525`) computes an
alphabetical insertion point among existing equipment items and returns a midpoint sort order, or
`lastEquipmentSort + 100`, or `maxNonEquipmentSort + 1000` when there is no equipment yet.
`AddEquipmentDialog` sorts the checked equipment alphabetically first and feeds each new item back
into the running list so subsequent items land correctly.

`sortActivitiesWithEquipmentLogic` (`utils.ts:408-462`) is supposed to keep equipment alphabetical,
but: its first branch tests `activities.some(a => a.sortOrder && a.sortOrder > 0)` — which is
**effectively always true** in production (labor items get `constant.sortOrder` ≥ 10; quick-adds get
`dateAdded` ≈ 1.7e12). So the "no custom sort orders" branch (lines 435–461, non-equipment first,
equipment alphabetical) is **unreachable dead code**.

### 11.4 Drag-and-drop reordering is DEAD

`activity_data_grid.tsx:1219` passes `onRowOrderChange={handleRowOrderChange}`, but
**`rowReordering` is never set anywhere in the codebase** (grep: zero hits). MUI X requires
`rowReordering` to render the drag handle and emit `rowOrderChange`. Therefore:

- `handleRowOrderChange` (lines 707–712) never fires — dead.
- There is **no drag-to-reorder** in the app.

---

## 12. Column visibility — a three-layer system

This is the most convoluted subsystem in the file.

**Layer 1 — auto-visibility from row content.** A `useMemo` scans `filtered` and sets five flags
(`hasEquipmentItems`, `hasMaterialItems`, `hasCostOnlyItems`, `hasSubcontractorItems`,
`hasLaborItems`), then derives:

| Column(s)                                                                                       | Shown when                                            |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `equipmentOwnership`, `equipmentCost`                                                           | equipment **or** subcontractor rows exist             |
| `materialCost`                                                                                  | material **or** subcontractor rows exist              |
| `costOnlyCost`                                                                                  | cost-only rows exist                                  |
| `subContractorCost`                                                                             | subcontractor rows exist                              |
| `price`                                                                                         | equipment **or** material **or** cost-only rows exist |
| `time` (Duration)                                                                               | equipment **or** subcontractor rows exist             |
| `craftConstant`, `welderConstant`, `craftManHours`, `welderManHours`, `craftCost`, `welderCost` | any labor or custom-labor rows exist                  |

**Layer 2 — per-WBS baseline (`ACTIVITY_BASELINE_VISIBILITY`, lines 89–105).** A map of 14
`wbsDatabaseId`s to forced-hidden columns (`time`, `price`, `equipmentOwnership`; and for 20000 SITE
PREP: `welderConstant`, `welderManHours`, `welderCost`). **This entire table is INERT.**
`applyVisibility` does `model[field] = baseValue || condition`, and every value in the table is
`false`, so `false || condition === condition`. 35 map entries with zero effect.

**Layer 3 — user overrides persisted per user + per phase.**
`loadColumnVisibilityModel(userId, phaseId, activities)` reads Firestore doc
`visibilityModels/{userId}_{phaseId}`. If absent it synthesizes a starter model from
`defaultColumns` (`api/helpers.ts:10-31`) plus per-type unlocks. `saveColumnVisibilityModel` writes
the doc on every `onColumnVisibilityModelChange`. Only overrides that **differ** from the auto value
are persisted; an effect drops overrides that have converged back to the auto value.
`hasLoadedVisibility` (a ref) guards against reloading, and is reset when `phaseId` or `userId`
changes.

`defaultColumns` (used only when no saved doc exists): visible =
`rowId, description, quantity, unit, craftConstant, welderConstant, craftManHours, welderManHours, welderCost, craftCost, totalCost`;
hidden =
`time, price, equipmentOwnership, craftBaseRate, subsistenceRate, equipmentCost, materialCost, costOnlyCost, subContractorCost`.

---

## 13. Add flows

### 13.1 Bottom quick-add bar (`bottom_pannel.tsx:299-363`)

Rendered only when `hasWritePermissions && quickAdds.length > 0`. When `phaseId` is present:

| Button            | Style          | Action                                                                             |
| ----------------- | -------------- | ---------------------------------------------------------------------------------- |
| **Activity**      | primary (dark) | opens `AddActivityDialog`                                                          |
| **Equipment**     | outline        | opens `AddEquipmentDialog`                                                         |
| **Material**      | outline        | **instant create** `{description:'NEW MATERIAL ITEM', activityType: materialItem}` |
| **Cost Only**     | outline        | instant create `NEW COST ONLY ITEM`                                                |
| **Custom Labor**  | outline        | instant create `NEW CUSTOM LABOR ITEM`                                             |
| **Subcontractor** | outline        | instant create `NEW SUBCONTRACTOR`, `unit:'HOURS'`                                 |

When only `wbsId` is present (WBS Home), the bar shows a single **Phase** button. At proposal level
the bar is hidden.

All instant creates go through `createActivity(payload)` →
`new FirestoreActivity({... sortOrder:null, dateAdded: Date.now(), quantity:0, price:0, time:0, craftConstant:0, welderConstant:0 ...})`
→ `addActivities([activity])` → `recalculatePhase`. **No confirmation, no focus-into-the-new-row, no
scroll-to-new-row.** The row appears at the bottom (because `sortOrder` falls back to `dateAdded`).

### 13.2 `AddActivityDialog`

- Uncontrolled MUI `Dialog` (default size — `DialogContent` hard-coded `height:400px; width:400px`,
  and the inner `<List>` is capped at `maxWidth: 360`).
- Title "Add Activities" + a bare `<Input>` search box (`autoFocus`).
- Body = a **non-virtualized** `<List>` of every `Constant` whose
  `phaseDatabaseId === currentPhase.phaseDatabaseId`, sorted by `sortOrder`, each a `ListItemButton`
  with a `Checkbox`. Up to **219 rows** in the worst case.
- Display quirk: `endsWithNumber(description)` appends a `"` (inch mark) to the label — display
  only, never saved.
- Search filter: `d.includes(s) || d.toLowerCase().includes(s) || d.toUpperCase().includes(s)`.
  Descriptions are uppercase, so **all-lowercase and all-uppercase queries work but mixed-case
  queries (e.g. "Pipe") match nothing.**
- Actions: **Cancel** (plain, unstyled — inconsistent with every other dialog) and **Add**.
- On Add: builds one `FirestoreActivity` per checked constant with
  `craftConstant = constant.craftConstant`, `welderConstant = constant.weldConstant`,
  `unit = constant.craftUnits`, `description = constant.description`,
  `sortOrder = constant.sortOrder`, `quantity: 0, price: 0, time: 0`, embedded `constant`; then
  `addActivities(batch)` + `recalculatePhase` + clears state + closes.
- **Cancel does NOT clear `checked`** — reopening the dialog shows your previous checkmarks.
- No "select all", no selected-count indicator, no keyboard submit (Enter does nothing), no
  grouping.

### 13.3 `AddEquipmentDialog`

Same shape, over the equipment catalog (129/133 rows, sorted by `id`, **not** alphabetically, so the
list order does not match the alphabetical sort the grid will apply). Search is case-insensitive
here (properly lowercases both sides). Creates with `activityType: equipmentItem`,
`description = equipment.description.toUpperCase()`, `unit: 'Months'`, `price: equipment.monthRate`,
`equipmentOwnership: 'Rental'`, `quantity: 0`, `time: 0`, and an alphabetically-computed
`sortOrder`. Clears `checked`/`search` on Add but **not on Cancel**.

---

## 14. Equipment-specific interactions

### 14.1 Ownership `<Select>` (in-cell, equipment rows only)

Options: `Rental`, `Owned`, `Purchase`. On change → `updateEquipmentOwnership(activity, value)` →
`updateEquipmentOwnershipInFirestore` then `recalculatePhase`. Side effects:

| Transition                       | Side effect                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Purchase` → `Owned` or `Rental` | `unit` forced to `'Months'`, `price` set to `equipment.monthRate`                                                                                    |
| `Owned` or `Rental` → `Purchase` | `unit` forced to `'EA'`, and since `'EA'` matches none of hours/days/weeks/months, **`price` is set to 0** — the user must retype the purchase price |
| `Rental` ↔ `Owned`               | no unit/price change, but the cost formula changes (Owned drops profit + use tax)                                                                    |

### 14.2 Unit `<Select>` (in-cell, equipment rows only)

Options: if ownership is `Purchase` → only `EA`; otherwise `Hours / Days / Weeks / Months` (`EA`
explicitly excluded). On change, `price` is reset to the corresponding rate from the embedded
`equipment` record (`hourRate|dayRate|weekRate|monthRate`), else 0.

⚠️ The `unit` and `equipmentOwnership` columns are **also** in `editableEquipmentItemCells`, so a
double-click puts a plain **free-text editor** over the `<Select>` — you can type `BANANAS` into
Ownership and it will be saved (upper-cased) and break the equipment formula's
`ownership === 'Owned'` check.

---

## 15. Rate editing (two parallel UIs for the same thing)

### 15.1 The inline rate bar (`activity_data_grid.tsx:1272-1342`)

A strip below the grid: `"N rows selected"` / `"Select rows to edit rates"` on the left, then
`FormattedNumberInput` **Base Rate** (`$` prefix), `FormattedNumberInput` **Subsistence** (`$`), and
a **Save Rates** button. All three disabled together via `rateEditingDisabled`.

`rateEditingDisabled` logic (lines 530–599):

```
if no rows selected                      -> disabled
for each selected activity:
   if type !== customLaborItem
      && currentWbs.wbsDatabaseId !== 200000            (SUPPORT)
      && currentPhase.phaseDatabaseId not in {180002,180003,180004}
                                          -> disabled   (180002 FIREWATCH,
                                                         180003 MANWATCH,
                                                         180004 TOOLS & EQUIPMENT RUNNER)
if >1 selected and still enabled:
   require all selected share the same craftBaseRate AND the same subsistenceRate
                                          -> else disabled
seed values from selectedActivities[0], falling back to proposal.craftBaseRate / subsistenceRate
```

Save → `updateActivityRates(ids, base, sub)` → batch `updateDoc` of `craftBaseRate` +
`subsistenceRate` → `recalculatePhase`.

### 15.2 `EditBaseRateDialog` (toolbar "Edit Rates")

**Functionally identical** but re-implements the rule and, critically, re-fetches each selected
activity from Firestore individually:

```ts
const promises = ids.map((id) => getSingleActivity({ activityId: id })); // one getDoc per row
```

and its `useEffect` is keyed on `[selectedRowIds]` with **no `open` guard** — so simply selecting
rows in the grid fires N Firestore reads even when the dialog is closed.

---

## 16. Bottom panel (`bottom_pannel.tsx`)

Three stacked bands, `flexShrink: 0`, never clipped.

**(a) Quick-add bar** — see §13.1.

**(b) Status bar** (height 36px). Five `Stat` chips separated by hairlines, horizontally scrollable:

| Stat           | Value                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **Total Cost** | `$` Σ `totalCost`                                                                                     |
| **Total Hrs**  | Σ direct + indirect hours                                                                             |
| **Direct**     | Σ `craftManHours + welderManHours` for rows whose WBS is **not** in `{10000, 190000, 200000, 180000}` |
| **Indirect**   | Σ hours for rows whose WBS **is** mobe(10000)/demobe(190000)/support(200000)/specialty(180000)        |
| **Sub Hrs**    | Σ `quantity * time` for `subContractorItem` rows                                                      |

Right side: an amber "**Hidden WBS data**" warning chip (proposal level only, when a hidden WBS has
non-zero totals) and a **Details** toggle whose open/closed state is persisted in
`localStorage['bottomPanelDetailsOpen']`.

**(c) Collapsible breakdown** — 3 `MiniTable`s in a responsive grid:

| Hours                                                                                       | Labor Costs                      | Other Costs                    |
| ------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| Craft, Welder, Support, Mobe / Demobe (summed), Specialty, Subcontractor — footer **Total** | Craft, Weld & Rig, Subcontractor | Equipment, Material, Cost Only |

The panel is **scope-aware**: at phase level it sums `activities.filter(phaseId)`; at WBS level it
sums that WBS's phases; at proposal level it sums only the **visible** WBS items.

⚠️ **Double-count bug:** the bottom panel adds `craftCost`, `equipmentCost` and `materialCost` for
**every** row including subcontractor rows (`bottom_pannel.tsx:212-217`, no type guard), whereas
`calculateTotals` in `utils.ts:285-297` deliberately **excludes** those three for subcontractor rows
(they're already baked into `subContractorCost`). So on any phase containing subcontractor rows the
panel's "Labor Costs → Craft" and "Other Costs → Equipment/Material" over-report relative to the
phase/WBS/proposal roll-ups shown elsewhere in the app.

---

## 17. Exact formulas (`src/api/totals.ts` + `utils.ts:88-185`)

All percentage inputs are whole numbers (e.g. `35` = 35%).

```
craftConstant   = activity.craftConstant  ?? constant.craftConstant ?? 0
welderConstant  = activity.welderConstant ?? constant.weldConstant  ?? 0
craftManHours   = quantity * craftConstant
welderManHours  = quantity * welderConstant

craftBase   = activity.craftBaseRate   || proposal.craftBaseRate     // NOTE: `||`, so 0 falls back
subsistence = activity.subsistenceRate || proposal.subsistenceRate   // NOTE: `||`

craftLoadedRate =
    craftBase
  + craftBase * (burdenRate + overheadRate + laborProfitRate + fuelRate + consumablesRate) / 100
  + subsistence

welderLoadedRate =
    weldBaseRate
  + weldBaseRate * (burdenRate + overheadRate + laborProfitRate + fuelRate + consumablesRate) / 100
  + proposal.subsistenceRate            // ALWAYS the proposal's — never the per-activity override
  + rigRate
  + rigRate * rigProfitRate / 100

craftCost   = craftManHours  * craftLoadedRate      // all types EXCEPT subContractorItem
welderCost  = welderManHours * welderLoadedRate     // ALL types, unconditionally

materialCost  = quantity * price * (1 + (materialProfitRate + salesTaxRate) / 100)   // materialItem only

equipmentCost = ownership === 'Owned'
                ? quantity * time * price
                : quantity * time * price * (1 + (equipmentProfitRate + useTaxRate) / 100)
                                                                                     // equipmentItem only

costOnlyCost  = quantity * price                                                     // costOnlyItem only

subContractorCost = quantity * (
      craftCost    * (1 + subContractorProfitRate/100)
    + materialCost * (1 + subContractorProfitRate/100 + salesTaxRate/100)
    + equipmentCost* (1 + subContractorProfitRate/100)
  )                                                                                  // subContractorItem only
  // craftCost/materialCost/equipmentCost here are the RAW user-entered per-unit values

totalCost = (type === subContractorItem)
          ? subContractorCost
          : craftCost + welderCost + materialCost + equipmentCost + subContractorCost + costOnlyCost
```

**Phase roll-up** (`calculateTotals`, `utils.ts:280-315`) — sums `costOnlyCost`,
`subContractorCost`, `welderCost`, `craftManHours`, `welderManHours`, `totalCost` across all rows;
sums `materialCost`, `equipmentCost`, `craftCost` **only for non-subcontractor rows**.

**Known formula oddities**

- `getSubcontractorCost` destructures `useTaxRate` from the proposal and **never uses it**
  (`totals.ts:106`).
- `craftBase`/`subsistence` use `||` not `??`, so an intentional per-activity rate of **$0**
  silently reverts to the proposal rate.
- `welderLoadedRate` ignores the per-activity subsistence override entirely — a phase with a custom
  subsistence gets it applied to craft but not to welders.
- `weldBaseRate` has no per-activity override at all.

---

## 18. UX problems observed (with evidence)

| #   | Problem                                                                                                                                                                                                                                                                                                               | Evidence                                                                                              | Severity         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | **No copy/paste, no fill-down, no undo, no range selection** on the app's most-used data-entry screen. Estimators cannot paste a column of quantities out of Excel.                                                                                                                                                   | Zero hits for `clipboard\|onPaste`; MUI X Pro v5.17.21 has no clipboard feature                       | **Critical**     |
| 2   | **Every committed cell is one awaited Firestore round-trip.** `onProcessRowUpdate` `await`s `updateActivity` before returning, so Enter/Tab navigation is gated on network latency. Typing down a 60-row column = 60 sequential writes.                                                                               | `activity_data_grid.tsx:1243-1244`; `newAPI/api.ts:286`                                               | **Critical**     |
| 3   | **Invalid numeric input fails silently.** `updateActivityFieldInFirestore` returns `{success:false}` for a non-numeric value; the store then skips the state update, but `onProcessRowUpdate` has already returned `newRow`, so MUI keeps the bad value on screen. Nothing is saved and nothing is reported.          | `newAPI/api.ts:273-283`; `store.ts:459` (`if (result.success)`)                                       | **Critical**     |
| 4   | **The error Snackbar is wired but can never fire.** `const [snackbarMessage] = useState('')` — the setter is never destructured, and `setSnackbarOpen(true)` is never called.                                                                                                                                         | `activity_data_grid.tsx:399-400, 1363-1374`                                                           | High             |
| 5   | **Two separate UIs for base-rate editing** (toolbar dialog + inline bar) with duplicated, independently-implemented enable/disable rules that can drift.                                                                                                                                                              | `activity_data_grid.tsx:530-611` vs `edit_base_rate_dialog.tsx:80-121`                                | High             |
| 6   | **N+1 Firestore reads on mere row selection.** `EditBaseRateDialog`'s fetch effect keys on `selectedRowIds` with no `open` guard → selecting 40 rows fires 40 `getDoc` calls with the dialog closed.                                                                                                                  | `edit_base_rate_dialog.tsx:60-78`                                                                     | High             |
| 7   | **Redundant proposal fetches.** `useCurrentProposal` does its own `getSingleProposal` Firestore read even though `estimatorStore.proposal` already holds it. On the phase screen it is called by `ActivityDataGrid`, `AddActivityDialog`, `AddEquipmentDialog` and `EditBaseRateDialog` → 4 duplicate document reads. | `hooks/current_proposal_hook.ts`; 4 call sites                                                        | High             |
| 8   | **Enum fields are free-text editable.** `equipmentOwnership` and `unit` render a `<Select>` in view mode but a plain text editor on double-click, and the value is upper-cased on save — so `Rental` becomes `RENTAL` and the `ownership === 'Owned'` branch in `getEquipmentCost` silently stops matching.           | `columns2.tsx:107,143,178,208` + `editableEquipmentItemCells` + `store.updateActivity` uppercase rule | High             |
| 9   | **Add/Delete/Reorder are spread across three different regions** — Add is in the bottom panel, Delete/Reset/Copy are in the top toolbar, Reorder is by typing a letter into a cell. Nothing is discoverable and there are no keyboard shortcuts for any of them.                                                      | §10, §13.1, §11.2                                                                                     | High             |
| 10  | **Reordering by typing a letter into the "Item" column is unguessable** and there is no drag handle, because `rowReordering` was never enabled.                                                                                                                                                                       | `activity_data_grid.tsx:1219` + zero `rowReordering` hits                                             | High             |
| 11  | **Non-virtualized picker lists** in Add Activity (up to 219 items) and Add Equipment (133) inside a hard-coded `400×400px` `DialogContent` with an inner `maxWidth: 360` `<List>` — content is clipped and scroll is cramped.                                                                                         | `add_activity_dialog.tsx:152-154`; `add_equipment_dialog.tsx:182-184`                                 | Medium           |
| 12  | **Mixed-case search finds nothing** in Add Activity ("Pipe" matches zero rows; "pipe" and "PIPE" work).                                                                                                                                                                                                               | `add_activity_dialog.tsx:121-132`                                                                     | Medium           |
| 13  | **Dialog state leaks across opens** — Cancel does not clear `checked` (Add Activity) or `search` (both dialogs).                                                                                                                                                                                                      | `add_activity_dialog.tsx:189`; `add_equipment_dialog.tsx:214`                                         | Medium           |
| 14  | **`Reset Constants` is destructive with no confirmation** (it nulls craft/welder constants and unit on every selected row), while Delete gets a confirm dialog.                                                                                                                                                       | `activity_data_grid.tsx:336-351`                                                                      | Medium           |
| 15  | **Sort and filter models are written to `localStorage` but never read back.** `activities_sort` and `activities_filter` are `setItem`-only; the grid receives no `sortModel`/`filterModel` prop. Sorting is lost on navigation.                                                                                       | `activity_data_grid.tsx:1213-1218` (grep: no `getItem` for those keys)                                | Medium           |
| 16  | **`over`/`under` constant-variance colors are unlabeled and semantically inverted** relative to naive reading (a constant _below_ the catalog is painted red/`over`). No legend exists.                                                                                                                               | `activity_data_grid.tsx:973-989`, CSS 1157-1164                                                       | Medium           |
| 17  | **Column visibility loads once, possibly against an empty row set.** The `loadModels` effect can run while `filtered` is still `[]`, compute a starter model from zero activities, then latch `hasLoadedVisibility.current = true` and never recompute.                                                               | `activity_data_grid.tsx:874-910`                                                                      | Medium           |
| 18  | **Renaming an activity can silently change the phase's headline quantity** via the description-keyword rules.                                                                                                                                                                                                         | `utils.ts:198-246`                                                                                    | Medium           |
| 19  | **`Delete` key on a numeric cell appears to clear the value but saves nothing** (empty string is rejected by the numeric validator).                                                                                                                                                                                  | `excel_navigation_data_grid.tsx:696-715` + `newAPI/api.ts:274`                                        | Medium           |
| 20  | **Direct state mutation in the store.** `changeActivitySortOrder` writes `activity.sortOrder = …` on an object still referenced by the Zustand state array, and the Firestore batch write is fire-and-forget (not awaited, no error handling).                                                                        | `store.ts:774-781`                                                                                    | Medium           |
| 21  | **Reordering one row rewrites `sortOrder` on every activity in the phase** in a single unbatched-by-size `writeBatch`. Phases with >500 activities would exceed Firestore's batch limit.                                                                                                                              | `store.ts:781` → `newAPI/api.ts:401-410`                                                              | Medium           |
| 22  | **The toolbar remounts on every selection change** — `components={{Toolbar: renderToolbar}}` where `renderToolbar` is a `useCallback` keyed on `selectedRows`, so the Database `<Select>` closes if you change selection while it's open.                                                                             | `activity_data_grid.tsx:1071-1112`                                                                    | Low              |
| 23  | **`console.log` left in hot paths** — `'HERE'`, the whole activities array, `'QUANTITY'`, per-cell logging on every filter recompute.                                                                                                                                                                                 | `activity_data_grid.tsx:633, 655, 668, 686, 690, 693`; `store.ts:224, 448`; `utils.ts:244`            | Low              |
| 24  | **Ownership → Purchase silently zeroes the price.**                                                                                                                                                                                                                                                                   | `newAPI/api.ts:319-327` (no `EA` branch)                                                              | Low              |
| 25  | **Numbers render inconsistently** — `quantity`, `time`, `craftConstant`, `welderConstant` have no formatter at all (raw JS number, no thousands separators); `craftBaseRate`/`subsistenceRate` use `toLocaleString()` with no forced 2dp while every other money column forces 2dp.                                   | `columns2.tsx` per-column `valueFormatter`                                                            | Low              |
| 26  | **MUI X Pro license key is forged at runtime** (`md5(btoa(licenseInfo)) + btoa(licenseInfo)` with an empty order number).                                                                                                                                                                                             | `App.tsx:29-35`                                                                                       | ⚠️ Legal, not UX |

---

## 19. Dead or broken code found

**Fully dead files / functions**

1. `src/hooks/activity_hook.ts` — `useActivities` (135 lines, a full Firestore `onSnapshot`
   subscription with its own `numberToLetters`) is **imported by nothing**. Grep-verified.
2. `src/features/phase home/components/columns.tsx` lines **11–521** (`getActivityColumns`) and the
   local `comparator` — never imported. Only the 11 constant arrays at lines 523–648 are used.
   Within it: `equipmentCost` is defined twice (line 256 in `baseColumns` **and** spliced again
   at 291) — a duplicate-field bug that never ships because the function is dead.
3. `src/api/activity.ts` — the following exports have **zero call sites**: `insertActivityBatch`,
   `updateActivity`, `updateActivitiesBatch`, `addCustomLabor`, `addCostOnly`, `addMaterial`,
   `addSubcontractor`, `deleteActivityBatch`, `resetConstantsBatch`, `updateActivityRates`, plus a
   local `isNumber` and `changeActivityOrder`. `updateEquipmentUnit` / `updateEquipmentOwnership`
   are imported **only** by the dead `columns.tsx`. Still-live exports: `getSingleActivity`,
   `getActivitiesForPhase`, `getActivitiesForWbs`, `calculateActivityData`, `getQuantityAndUnit`.
   The file also ends with ~60 lines of commented-out `insertActivitiesFromFile` (twice).
4. `store.changeActivityOrder` (`store.ts:553-627`) — declared in `StoreState`, implemented, marked
   `// TODO: COME BACK TO THIS AND FIX`, and **never called**. Its body mixes indices from the
   filtered array and the full array (`activities[targetActivityIndex]` vs
   `newActivities[selectedFilteredActivityIndex]`) and would corrupt sort orders if used.
5. `CopyFromPhaseDialog` is rendered at `activity_data_grid.tsx:1355-1358` bound to
   `openCopyDialog`, which is **never set to `true`** — `setOpenCopyDialog` is never called. The
   live copy path is `CopyActivitiesFromProposalDialog`. Its own `checkSameValue` helper and the
   `toPhase`/`disabled` state inside it are also unused.

**Dead configuration / props**

6. `ACTIVITY_BASELINE_VISIBILITY` (35 entries across 14 WBS ids) — inert, because
   `false || condition === condition` (see §12).
7. `autoCommitOnNavigation` — accepted by `ExcelNavigationDataGrid`, destructured, never referenced.
8. `pageSize={100}` — `DataGridPro` v5 has pagination **off** by default and `pagination` is never
   passed, so this prop does nothing.
9. `hide: true` on `craftBaseRate` / `subsistenceRate` in `columns2.tsx` — v4 API, inert under a
   controlled `columnVisibilityModel`.
10. `onRowOrderChange` / `handleRowOrderChange` — can never fire (`rowReordering` unset).
11. `.completed-row` CSS rule — no code path assigns that class (`getRowClassName` only produces
    `row-even`/`row-odd`).
12. `sortActivitiesWithEquipmentLogic` lines 435–461 (the "no custom sort orders" branch) —
    unreachable in practice.
13. `sanitizeVisibilityModel` is `(model) => ({...model})` — a no-op wrapped in `useCallback`.
14. `withDateAdded` / `withoutDateAdded` in the dead `activity_hook.ts` are computed and discarded.
15. `getSubcontractorCost` destructures `useTaxRate` and never uses it.
16. `ListItemText` imported but unused in both copy dialogs; `useCurrentWbs` imported but unused in
    `copy_activities_from_proposal_dialog.tsx`; `sorted` computed and discarded in
    `copy_from_phase_dialog.tsx:56`.

**Genuinely broken**

17. 🔴 **Changing the phase Database throws on any phase with more than 10 activities.**
    `onChangePhaseDatabase` → `store.updateActivitiesBatch` → `updateActivitiesBatchInFirestore`,
    which finishes with
    `query(collection(firestore,'activities'), where('__name__','in', updatedActivityIds))`
    (`newAPI/api.ts:587-590`). Firebase JS SDK v9's `in` operator accepts a **maximum of 10
    values**. Any phase with ≥11 activities will reject. The writes will have already committed, so
    the phase's database changes but the local store never refreshes and the UI throws. The same
    function also creates a `batch` at line 568 that is only ever committed **empty** at line 583.
18. 🔴 **Silent constant mismatch on database change.** The remap matches
    `constant.description === activity.constant?.description && constant.phaseDatabaseId === newId`.
    If the description doesn't exist in the new database, the activity **keeps its old constant**
    with no warning, so its craft/welder constants no longer belong to the phase's database.
    (`activity_data_grid.tsx:649-663`.) `onChangePhaseDatabase` also never calls `recalculatePhase`.
19. 🟠 **Non-numeric input is discarded without feedback** (see §18 #3).
20. 🟠 **Bottom-panel cost double-count for subcontractor rows** (see §16).
21. 🟠 **`Reset Constants` on a `customLaborItem`** zeroes the constants and sets `unit` to `null`
    (rendered as blank) rather than restoring anything, because there is no `constant` to fall back
    to — the button's label promises something it cannot deliver for 1 of the 6 types.

---

## 20. PARITY CHECKLIST

Every discrete capability Precision must eventually have from this area. `[essential]` = required
for functional parity; unmarked items are behaviors that exist and should be consciously kept,
redesigned, or dropped.

**Grid core**

- [essential] Render all activities for a phase in a spreadsheet-style grid, ordered by a persisted
  `sortOrder`
- [essential] 20 logical columns: Item, Description, Quantity, Unit, Duration, Price, Ownership,
  Craft Const., Welder Const., Craft Hours, Welder Hours, Welder Total, Craft Total, Craft Base,
  Subsistence, Equipment Total, Material Total, Cost Only Total, Subcontractor Total, Total
- [essential] Per-activity-type editable-cell rules (6 distinct editable sets — §3.1)
- [essential] Per-activity-type "not applicable" cell treatment (columns that don't apply to a row
  are visually neutralized — legacy uses strike-through + gray)
- [essential] Read-only mode driven by user permission: no editable cells, no action buttons, no add
  bar
- [essential] Currency columns formatted `$` + exactly 2 decimals; hour columns 2 decimals
- [essential] Positional row label (A, B, … Z, AA, AB …) recomputed on every reorder
- Constant-variance highlighting: color a labor row's craft/welder constant when it differs from the
  catalog constant (with a legend — the legacy has none)
- Zebra striping and compact/standard/comfortable density switching
- Column show/hide panel
- [essential] Column visibility persisted **per user, per phase**
- [essential] Automatic column visibility driven by which activity types are present in the phase
  (§12 layer 1 — this is the rule that actually matters; the per-WBS baseline table is inert and
  should not be ported)
- Custom "Item" sort comparator (length-first so A…Z sorts before AA)

**Cell editing**

- [essential] Type-to-replace: any printable key in view mode starts editing with that character
- [essential] Enter commits and moves **down** to the next editable cell; Shift+Enter moves up
- [essential] Tab commits and moves **right** to the next editable cell; Shift+Tab moves left
- [essential] Non-editable cells are skipped during Enter/Tab traversal
- [essential] Escape discards the edit and stays on the cell
- [essential] Click-away commits the edit without navigating, and does not steal focus back
- [essential] Arrow keys move focus in view mode
- [essential] Focus survives an async save that re-sorts or re-renders rows
- F2 toggles edit mode with the caret placed (not select-all)
- Double-click enters edit with the caret at the click position
- Backspace in view mode clears and enters edit; Delete clears and stays in view mode
- Wrap-around navigation at row/column boundaries (configurable)
- [essential] Text fields (`description`, `unit`) auto-upper-cased on save
- [essential] Numeric validation on numeric fields — **with visible error feedback**, which the
  legacy lacks
- **NEW for Precision (legacy gap):** clipboard copy, clipboard paste from Excel, fill-down,
  multi-cell range selection, undo/redo

**Row selection & bulk actions**

- [essential] Multi-row selection (legacy: click / Ctrl+click / Shift+click; checkboxes would be an
  improvement)
- [essential] Selected-row count indicator
- [essential] Bulk delete with confirmation, batched, followed by phase recalculation
- [essential] Bulk "Reset Constants" — clears `craftConstant`, `welderConstant`, `unit` so they fall
  back to the catalog values
- [essential] Bulk base-rate / subsistence override on selected rows, batched
- [essential] The rate-override eligibility rule: allowed only for `customLaborItem`, **or** WBS
  `200000` (SUPPORT), **or** phases `180002` FIREWATCH / `180003` MANWATCH / `180004` TOOLS &
  EQUIPMENT RUNNER; and for multi-select only when every selected row already shares the same base
  rate and subsistence
- [essential] Rate inputs default to the proposal's rates when a row has no override

**Creating activities**

- [essential] Add labor activities from the phase's labor-constant catalog: searchable,
  multi-select, batch insert
- [essential] New labor activity inherits `craftConstant`, `weldConstant`, `craftUnits`,
  `description` and `sortOrder` from the catalog row, and embeds a snapshot of the catalog row
- [essential] Add equipment from the equipment catalog: searchable, multi-select, batch insert
- [essential] New equipment defaults to unit `Months`, price `monthRate`, ownership `Rental`, and is
  inserted at its **alphabetical** position among existing equipment
- [essential] One-click creation of a blank **Material** item
- [essential] One-click creation of a blank **Cost Only** item
- [essential] One-click creation of a blank **Custom Labor** item
- [essential] One-click creation of a blank **Subcontractor** item (unit defaults to `HOURS`)
- [essential] All adds trigger a phase recalculation
- **NEW for Precision (legacy gap):** a "Duplicate activity / duplicate N selected rows" command —
  the legacy has none
- **NEW:** focus/scroll to the newly-created row
- Search must be case-insensitive (legacy's activity search breaks on mixed case)
- Picker dialogs must be virtualized (up to 219 catalog rows per phase database)

**Equipment behavior**

- [essential] In-cell **Ownership** selector on equipment rows: Rental / Owned / Purchase
- [essential] In-cell **Unit** selector on equipment rows: Hours / Days / Weeks / Months, or
  **only** `EA` when ownership is Purchase
- [essential] Selecting a unit resets `price` to the matching catalog rate
  (`hourRate`/`dayRate`/`weekRate`/`monthRate`)
- [essential] Purchase → Rental/Owned forces unit `Months` and price `monthRate`
- [essential] Rental/Owned → Purchase forces unit `EA` (legacy also zeroes price — decide
  intentionally)
- [essential] `Owned` equipment skips the equipment profit + use-tax markup

**Ordering**

- [essential] Persisted per-activity `sortOrder`, with midpoint insertion so a single move rewrites
  minimal data (the legacy rewrites the whole phase — do better)
- [essential] A discoverable reorder affordance — **drag-and-drop, which the legacy intended but
  never enabled**
- Keep (or replace) the "type a target row letter into the Item cell to move a row" command
- Alphabetical auto-placement for newly added equipment

**Copying**

- [essential] Copy all activities from **any other phase in the proposal** into the current phase
  (searchable phase picker showing `WBS name – Phase # – Description`)
- Copy from a phase within the same WBS (the legacy has a second, currently-unreachable dialog for
  this)

**Phase-level controls surfaced on this screen**

- [essential] Select which **phase database** (constant catalog) the phase is pinned to, from the
  catalogs belonging to the phase's WBS
- [essential] On database change, remap every activity's embedded constant to the same-description
  constant in the new database — **and surface the activities that had no match** (the legacy
  silently keeps the stale constant)
- [essential] Phase **Complete / Incomplete** toggle
- [essential] Recalculate phase roll-ups (totals, quantity, unit) after every mutation

**Totals panel**

- [essential] Always-visible running totals: Total Cost, Total Hours, Direct Hours, Indirect Hours,
  Subcontractor Hours
- [essential] Indirect-hours classification by WBS: MOBILIZE (10000), DEMOBILIZE (190000), SUPPORT
  (200000), SPECIALTY SERVICES (180000); everything else is direct
- [essential] Subcontractor hours = Σ `quantity × time` over subcontractor rows
- [essential] Collapsible breakdown — Hours (Craft, Welder, Support, Mobe/Demobe, Specialty,
  Subcontractor + Total), Labor Costs (Craft, Weld & Rig, Subcontractor), Other Costs (Equipment,
  Material, Cost Only)
- [essential] Roll-up must **exclude** a subcontractor row's craft/material/equipment components
  from those buckets (they're already inside `subContractorCost`) — the legacy's grid roll-up does
  this but its bottom panel does not; fix the inconsistency
- Panel expand/collapse state persisted
- Scope-aware totals (phase / WBS / proposal) with a warning when hidden WBS items carry data

**Calculation engine (server-side in Precision)**

- [essential] `craftManHours = quantity × craftConstant`,
  `welderManHours = quantity × welderConstant`
- [essential]
  `craftLoadedRate = base + base×(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence`
- [essential]
  `welderLoadedRate = weldBase + weldBase×(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence + rigRate + rigRate×rigProfit/100`
- [essential] `materialCost = qty × price × (1 + (materialProfit + salesTax)/100)`
- [essential]
  `equipmentCost = qty × time × price × (Owned ? 1 : 1 + (equipmentProfit + useTax)/100)`
- [essential] `costOnlyCost = qty × price`
- [essential]
  `subContractorCost = qty × (craftCost×(1+subProfit) + materialCost×(1+subProfit+salesTax) + equipmentCost×(1+subProfit))`
- [essential] `totalCost` = subcontractor cost for subcontractor rows; the 6-bucket sum for
  everything else
- [essential] Per-activity `craftBaseRate` / `subsistenceRate` overrides falling back to the
  proposal (use `??`, not `||`, so an explicit $0 is honored — legacy bug)
- Decide deliberately whether the welder loaded rate should honor a per-activity subsistence
  override (legacy does not) and whether `weldBaseRate` should be overridable at all (legacy: no)
- [essential] Compute-on-read: no cost/hour field is persisted (already the legacy architecture)

**Catalog / data**

- [essential] Per-proposal dataset version pinning for labor, phases, WBS and equipment catalogs,
  with fallback to the newest available version ≤ the requested one
- [essential] Denormalized snapshot of the catalog `constant` / `equipment` row stored on the
  activity
- Phase headline quantity/unit derivation from activity descriptions by WBS-specific keywords
  (`EXCAVATE`/`BACKFILL / COMPACT` for 20000, `CLEAN UP` for 40000/50000/60000, `HE` for
  70000/130000, and the CONCRETE `EA`/`CY` rule for 30000) — port only if the business still relies
  on it; it is a fragile string-matching rule

**Shared-with-Momentum candidates (per the stated goal)**

- The searchable multi-select catalog picker (Add Activities / Add Equipment) is the same component
  shape Momentum uses for "add activities" — one component, two catalogs
- The delete-confirmation dialog
- The formatted currency/number input
- The Excel-navigation data-grid wrapper itself
- The bottom totals/status bar with collapsible breakdown
