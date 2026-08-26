# GAP ANALYSIS — WBS & Phase Management, Navigation, Hierarchy

**Domain:** Proposal → WBS → Phase tier. WBS codes/ordering/visibility, phase CRUD, duplication,
copy-from-phase, cross-proposal copy, navigating a large tree. **Method:** read the source in
`packages/backend/convex/precision.ts`, `apps/precision/src/**`, `apps/momentum/src/**`,
`packages/features/src/**`, plus the legacy tree at
`/Users/collinwillis/Dev/Personal/mcp_estimator/src/`. Where a claim needed data rather than code, I
ran read-only queries against the live Convex deployment `focused-civet-250`.

---

## 0. Headline findings (verified, not inferred)

**H1 — WBS ordering is broken for every estimate created natively in Precision.** `createProposal`
(`precision.ts:506-513`) copies `wbsPool.sortOrder` into `wbs.sortOrder`. I queried the live
`wbsPool` table; its `sortOrder` is the **array index of the legacy JSON file**, and that file is
ordered lexicographically by stringified id:

| sortOrder | 0        | 1          | 2        | 3           | 4         | 5          | 6         | 7         | 8          | 9         | 10      | 11       | 12     | 13    | 14         | 15        | 16         | 17          |
| --------- | -------- | ---------- | -------- | ----------- | --------- | ---------- | --------- | --------- | ---------- | --------- | ------- | -------- | ------ | ----- | ---------- | --------- | ---------- | ----------- |
| poolId    | 10000    | 100000     | 110000   | 120000      | 130000    | 140000     | 150000    | 180000    | 190000     | 20000     | 200000  | 30000    | 40000  | 50000 | 60000      | 70000     | 80000      | 90000       |
| name      | MOBILIZE | INSULATION | PAINTING | DISMANTLING | BG PIPING | REFRACTORY | BUILDINGS | SPECIALTY | DEMOBILIZE | SITE PREP | SUPPORT | CONCRETE | TOWERS | PUMPS | STRUCTURAL | AG PIPING | ELECTRICAL | INSTRUMENTS |

Every query that lists WBS uses `withIndex("by_proposal_sort", …)` — `getWBSForProposal:386`,
`getWBSWithPhasesForNav:410`, `getWBSListWithCosts:820`, `getExportData`, `duplicateProposal:1536` —
and no consumer re-sorts. So a native estimate renders its sidebar tree, its overview WBS table and
its Excel export as _MOBILIZE, INSULATION, PAINTING, DISMANTLING, BG PIPING…_ An estimator reads WBS
by code; this order is nonsense to them.

Firestore-synced proposals are fine: `sync/fieldMapping.ts:119` sets
`sortOrder: num(fs.wbsDatabaseId)`. I confirmed on proposal `#1744` in prod that its 18 WBS carry
`sortOrder` = 10000…200000. **The two populations disagree.** Today prod has 200 proposals, all
synced, 0 native — so the bug is latent and will fire on the first estimate anyone creates in
Precision.

**H2 — Precision does NOT have the Convex `Record<string,T>` key-order bug, but it has an
order-equivalent one.** Every precision query returns arrays (`Record<…>` appears only as a local
patch accumulator at lines 551, 1218, 1448), so array order does survive the wire. Momentum hit the
real key-order trap and documented it at
`packages/features/src/progress-tracking/workbook-table.tsx:283-295` (tagged `#36`) — it now sorts
client-side by numeric WBS code and explicitly does not trust the server's order. **Precision has no
such client-side safety net.** It trusts a `sortOrder` column that is wrong. Same symptom, different
cause, and Momentum's defence-in-depth is the right pattern to copy.

**H3 — Phases are ordered by insertion, not by phase number.** `getPhaseListWithCosts:757` reads
`by_wbs_sort` and returns `sortOrder`; `addPhase:1196` and `duplicatePhase:1291` set
`sortOrder = max+1`. Legacy sorted phases by `phaseNumber` ascending (`wbs_home.tsx:224`). Add phase
70050 then 70010 and Precision lists 70050 first. Momentum already has the right comparator —
`comparePhasesForDisplay` (`momentum.ts:307`) — and Precision has no equivalent.

**H4 — Phase numbers start at 1, not at the WBS code.** `add-phase-dialog.tsx:60-67`:
`existingPhases.length > 0 ? max+1 : 1`. The first phase an estimator adds under AG PIPING is
**phase 1**, not 70001. Legacy's rule (`add_phase_dialog.tsx:100-149`) is
`max(existing non-reserved number, wbsCode) + 1`, with 108 reserved catalog ids that become the
phase number verbatim. Phase numbers appear on the bid sheet, on the Excel export, and in every
conversation with a PM. This is the single most visible numeric-parity break in the domain.

**H5 — You cannot tell where you are.** The WBS detail breadcrumb is literally `#1744 › Phases`
(`$estimateId.wbs.$wbsId.tsx:123-136`) — no WBS name, no code. The phase detail breadcrumb is
`#1744 › Phase` (`$estimateId.phase.$phaseId.tsx:374-387`) — no phase number, no description, no
parent WBS. Legacy's app-bar breadcrumb was strictly better:
`{proposalNumber} - {description} › {wbs.name} › {phaseNumber} - {phaseDescription}`
(`drawer.tsx:185-220`). This is a **regression against the app we are replacing**.

**H6 — The mutations for the missing features already exist and are wired to nothing.** `addWBS`,
`deleteWBS`, `updatePhase`, `copyActivitiesToPhase` are all implemented, all correct in shape, and
all dead (0 call sites in `apps/precision/src`). Notably `copyActivitiesToPhase:1331` denormalizes
`proposalId`/`wbsId` from the **target** phase and never asserts the two phases share a proposal —
so **cross-proposal copy already works on the server today**; only the picker is missing. Legacy
never shipped cross-proposal copy at all (its `copy_activities_from_proposal_dialog.tsx` is misnamed
and scoped to one proposal).

---

## 1. CURRENT PARITY

Honest read: **~30% of the legacy WBS/Phase surface exists in Precision.** The skeleton and the
server-side rollups are real; almost nothing in this tier is editable, and two ordering rules are
wrong.

### 1.1 What genuinely works

| Capability                              | Where                                                                        | Note                                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed 18 WBS on proposal creation        | `precision.ts:493-513`                                                       | **Better than legacy** — one transaction, not legacy's un-awaited `forEach(async …)` race (`api/wbs.ts:30`)                                                                                                                                           |
| WBS cost rollup table on the overview   | `getWBSListWithCosts:809`, `WBSTable` at `$estimateId.index.tsx:484`         | Single indexed `by_proposal` activity read + in-memory grouping. No N+1.                                                                                                                                                                              |
| Phase list with per-phase rollups       | `getPhaseListWithCosts:743`                                                  | Same one-query pattern, scoped `by_wbs`                                                                                                                                                                                                               |
| **Click a WBS row to open it**          | `$estimateId.index.tsx:552-559` (`<Link>`)                                   | Legacy could not do this (`wbs_data_grid.tsx` has no nav) — legacy UX problem #2 is fixed                                                                                                                                                             |
| **Click a phase row to open it**        | `$estimateId.wbs.$wbsId.tsx:232-237`                                         | Legacy could not do this either — problem #1 fixed                                                                                                                                                                                                    |
| Sidebar WBS→Phase tree                  | `shell-config-estimate.ts:46-57` + `TreeNavItem` (`app-sidebar.tsx:327-520`) | Auto-expands to the active phase, 2px accent rail, child-count badge, `parsePhaseLabel` splits `"70001 — CARBON STEEL"` into mono number + description. Genuinely nicer than legacy's dropdown + flat list. Momentum doesn't even use this component. |
| Real URLs / deep links                  | TanStack Router                                                              | Legacy used `MemoryRouter` — no addressable state at all                                                                                                                                                                                              |
| Add phase from a WBS-scoped catalog     | `add-phase-dialog.tsx` + `getPhasePool:1006`                                 | 228 phasePool rows verified present in prod, correct per-WBS scoping, v2→v1 fallback                                                                                                                                                                  |
| Delete a phase, cascading to activities | `deletePhase:1237`                                                           | Correct cascade. No 10-item `in` ceiling like legacy (`newAPI/api.ts:160`)                                                                                                                                                                            |
| Duplicate a phase with all activities   | `duplicatePhase:1261`                                                        | Deep copy, resets `isCompleted`, and the caller computes `max(phaseNumber)+1` (`$estimateId.wbs.$wbsId.tsx:97-99`) — **better than legacy**, which copied the phase number verbatim and collided                                                      |
| Multi-select phases                     | `Set<string>` at `$estimateId.wbs.$wbsId.tsx:56` + checkbox column           | Legacy had **no** checkbox column; selection was invisible row-click                                                                                                                                                                                  |
| Duplicate a whole proposal incl. tree   | `duplicateProposal:1501`                                                     | Correct id remapping at every level; drops `firestoreId`, so a duplicate of a synced proposal becomes Precision-native and escapes the sync                                                                                                           |

### 1.2 What is partial or wrong

| Capability                        | Status                                                                                                                                                                                                                                                                                          | Evidence                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| WBS display order                 | **Broken for native estimates**                                                                                                                                                                                                                                                                 | H1                                                            |
| Phase display order               | **Wrong** — insertion, not phase number                                                                                                                                                                                                                                                         | H3                                                            |
| Phase numbering on create         | **Wrong** — starts at 1                                                                                                                                                                                                                                                                         | H4                                                            |
| Breadcrumbs / "where am I"        | **Regression vs legacy**                                                                                                                                                                                                                                                                        | H5                                                            |
| WBS identity on the WBS screen    | Absent — `getPhaseListWithCosts` doesn't even return the WBS name or `wbsPoolId`, so the screen _cannot_ render it                                                                                                                                                                              | `precision.ts:784-797`                                        |
| WBS code shown anywhere in the UI | Never. `WBSTable` renders `wbs.name` only, dropping `wbsPoolId` which is in the payload                                                                                                                                                                                                         | `$estimateId.index.tsx:551-560`                               |
| Phase grid columns                | **10 of legacy's 23**; `phaseNumber, description, pipingSpec.size, pipingSpec.spec, activityCount, craftMH, weldMH, totalCost` + checkbox + completed dot. Missing: FLC, Insul, Insl. Size, Sht, Area, Status, Sys, Quantity, Units, Craft $, Welder $, Material $, Equip $, Sub $, Cost-Only $ | `$estimateId.wbs.$wbsId.tsx:182-206`                          |
| Phase grid editability            | **0 of legacy's 14 editable fields.** `updatePhase` exists and is called from nowhere                                                                                                                                                                                                           | `precision.ts:1202`                                           |
| Mark a phase complete             | Rendered (`CheckCircle2` + emerald tint) but **not toggleable**                                                                                                                                                                                                                                 | `$estimateId.wbs.$wbsId.tsx:252-258`                          |
| Bulk duplicate                    | Acts on `[...selected][0]` only — select 3, get 1 copy, no feedback                                                                                                                                                                                                                             | `$estimateId.wbs.$wbsId.tsx:146-148`                          |
| Bulk delete                       | `for (const id of selected) await deletePhase(...)` — N round-trips, no confirmation, no progress, no atomicity, cascades to activities                                                                                                                                                         | `$estimateId.wbs.$wbsId.tsx:89-94`                            |
| Bottom panel scope label          | `scope="Phase"` on the WBS screen and `scope="Activity"` on the overview — mislabeled, and the WBS/phase panels re-sum client-side so `directHours`/`indirectHours` are absent below the overview                                                                                               | `$estimateId.wbs.$wbsId.tsx:309`, `$estimateId.index.tsx:303` |
| Error surfacing                   | `console.error` in `add-phase-dialog.tsx:109`; `sonner` is a dependency and never imported anywhere in `apps/precision/src`                                                                                                                                                                     | —                                                             |

### 1.3 What is entirely absent

| Legacy capability                                                              | Precision                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a WBS to a proposal                                                        | `addWBS:1089` exists — **0 UI call sites**                                                                                                                                                                                                                          |
| Remove a WBS from a proposal                                                   | `deleteWBS:1129` exists — **0 UI call sites**                                                                                                                                                                                                                       |
| WBS visibility set per proposal (`wbsToDisplay`)                               | No equivalent. `userWbsPreferences` (`schema.ts:965`) is orphaned **and mis-shaped**: `{userId, wbsPoolNamesToDisplay}` indexed `by_user` only — it's per-user-global, where legacy was per-proposal                                                                |
| "Hidden WBS still has cost" warning chip                                       | None                                                                                                                                                                                                                                                                |
| WBS `customQuantity` / `customUnit` override                                   | Schema fields exist; no derivation, no UI                                                                                                                                                                                                                           |
| **Derived phase/WBS quantity + unit** (`getQuantityAndUnit`)                   | **Completely absent from `precision.ts`.** Verified by grep: no `EXCAVATE`, no `BACKFILL`, no `CLEAN UP`, no keyword map, no `30011/30012/30013/30015 → EA else CY` rule. The Quantity/Units columns of the legacy phase grid have no server implementation at all. |
| WBS "completed" = all phases completed                                         | Not computed                                                                                                                                                                                                                                                        |
| Reserved phase numbers (108-id list)                                           | Absent                                                                                                                                                                                                                                                              |
| Auto-description + locked number for MOBILIZE / DEMOBILIZE / SUPPORT           | Absent                                                                                                                                                                                                                                                              |
| Per-WBS column presets (hide pipe columns for 12 of 18 WBS codes)              | Absent; there are no columns to hide                                                                                                                                                                                                                                |
| Column visibility / sort / filter persistence                                  | `proposalColumnPreferences` (`schema.ts:976`) orphaned                                                                                                                                                                                                              |
| Copy activities from another phase (same WBS)                                  | `copyActivitiesToPhase:1331` exists — 0 UI                                                                                                                                                                                                                          |
| Copy activities from any phase in the proposal                                 | Same mutation would serve it — 0 UI                                                                                                                                                                                                                                 |
| Cross-proposal copy                                                            | Mutation already permits it (H6) — 0 UI. Legacy never had it.                                                                                                                                                                                                       |
| Re-resolve labor constants when copying into a phase of a different template   | Absent (legacy's version is dead code in `api/phase.ts:156-205`; the shipped legacy path copies raw)                                                                                                                                                                |
| Change a phase's catalog template after creation, remapping activity constants | Absent (legacy: the `Database` select at `activity_data_grid.tsx:608-676`)                                                                                                                                                                                          |
| Excel-style keyboard nav on the _phase_ grid                                   | Absent — Precision's keyboard nav exists only on the activity grid, and only as linear DOM traversal of `input[data-cell-id]` (`$estimateId.phase.$phaseId.tsx:136-145`)                                                                                            |
| Jump to a WBS or phase from the command palette                                | Absent — `shell-config-estimate.ts:59-97` registers 4 static commands and none of the tree                                                                                                                                                                          |
| Sidebar tree search / filter / hide-empty                                      | Absent. All 18 WBS and every phase render as DOM nodes, unfiltered, unvirtualized, and expansion state is `useState(hasActiveChild)` so it collapses on every navigation                                                                                            |

---

## 2. MISSING CAPABILITIES

| Capability                                                                                                                                                                                                                                                                  | Why it matters                                                                                                                                                                                               | Effort | Blocks others?                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------- |
| **Fix WBS display ordering** — backfill `wbsPool.sortOrder = poolId`, make `createProposal` write `sortOrder: poolItem.poolId`, and add a client-side numeric sort as defence-in-depth (Momentum's `#36` lesson)                                                            | Every native estimate currently lists WBS in nonsense order in the sidebar, the overview table and the Excel export. Cheapest high-impact fix in the domain.                                                 | **S**  | Yes — any WBS UI built now inherits the bug |
| **Order phases by `phaseNumber`** in `getPhaseListWithCosts` / `getWBSWithPhasesForNav`; keep `sortOrder` only as a tiebreaker                                                                                                                                              | Estimators read phase numbers as an ordered ledger. Insertion order makes a 40-phase WBS unreadable.                                                                                                         | **S**  | Yes                                         |
| **Correct phase-number suggestion**: `max(existing non-reserved, wbsPoolId) + 1`, reserved catalog ids used verbatim                                                                                                                                                        | Phase numbers are on the bid sheet. Starting at 1 breaks every downstream conversation and the Excel export. Needs the 108-value reserved list ported from `add_phase_dialog.tsx:69-85`.                     | **M**  | No                                          |
| **Show WBS code + name on the WBS screen**; add `name`/`wbsPoolId` to `getPhaseListWithCosts`'s return                                                                                                                                                                      | You cannot currently tell which WBS you are looking at.                                                                                                                                                      | **S**  | No                                          |
| **Full breadcrumb** proposal › WBS › phase, in the shared `AppBar` not per-route                                                                                                                                                                                            | Restores parity with legacy; the deepest screen is currently unlabelled.                                                                                                                                     | **S**  | No                                          |
| **Wire `updatePhase`** — inline-editable phase grid (number, description, area, sheet, status, and the 6 `pipingSpec` fields) + an `EditPhaseDialog`                                                                                                                        | Today a typo in a phase description can only be fixed by deleting the phase, which cascade-deletes every activity under it. Collin's #1 day-to-day friction.                                                 | **M**  | Yes — blocks the 23-column grid             |
| **Toggle phase completed** from the grid, and roll `completed` up to the WBS                                                                                                                                                                                                | Rendered but not settable; the WBS-completion rollup that legacy showed doesn't exist.                                                                                                                       | **S**  | No                                          |
| **Add / remove WBS on an estimate** (wire `addWBS` / `deleteWBS` behind a picker dialog)                                                                                                                                                                                    | Every new estimate gets all 18 WBS permanently; a typical job uses 3-5. The overview shows 13 rows of `— — —`.                                                                                               | **M**  | No                                          |
| **WBS visibility / hide-empty**, replacing legacy `wbsToDisplay`                                                                                                                                                                                                            | Legacy defaulted to `[]` so new proposals showed **zero** WBS — do not port that. Momentum's `hideUnused` toggle is the right model. Requires re-shaping `userWbsPreferences` to be per-proposal.            | **M**  | No                                          |
| **Phase grid: the remaining 13 columns** (FLC, Insul, Insl. Size, Sht, Area, Status, Sys, Quantity, Units, Craft $, Welder $, Material $, Equip $, Sub $, Cost-Only $) with per-WBS presets                                                                                 | This grid is where estimators live. 10 read-only columns is a demo. `Area` must stay a string.                                                                                                               | **L**  | No                                          |
| **Derived phase/WBS quantity + unit** (`getQuantityAndUnit` port) + `customQuantity`/`customUnit` overrides with clear-to-restore semantics                                                                                                                                 | The Quantity/Units columns and the WBS-level quantity roll-up have no implementation. Legacy's per-phase override also fails to feed the WBS roll-up — fix, don't port.                                      | **M**  | Yes — blocks the Quantity/Units columns     |
| **Copy activities from another phase**, with a searchable picker showing `WBS · phase # · description`                                                                                                                                                                      | `copyActivitiesToPhase` is already correct. This is a picker dialog, nothing more.                                                                                                                           | **S**  | No                                          |
| **Cross-proposal copy** (same picker, proposal selector on top)                                                                                                                                                                                                             | Net-new vs legacy; the mutation already permits it.                                                                                                                                                          | **M**  | No                                          |
| **Re-resolve labor constants on copy / template change**                                                                                                                                                                                                                    | Copying a phase's activities into a phase of a different `phasePoolId` today carries the wrong constants. Legacy's _shipped_ path has the same defect; its dead path had the fix.                            | **M**  | No                                          |
| **Excel-grade keyboard model on the phase grid** — Tab/Shift+Tab to next editable cell skipping read-only columns, Enter/Shift+Enter row movement, F2, type-to-replace, Delete-clears-and-commits, Esc discards, auto-commit on navigation, focus restore after data change | Legacy's `excel_navigation_data_grid.tsx` (816 lines) is the best asset in the old repo and estimators are trained on it. Precision has linear DOM traversal only.                                           | **L**  | No                                          |
| **Multi-select bulk duplicate + confirmed bulk delete** with a count and a single server round-trip                                                                                                                                                                         | Duplicate silently ignores all but the first selection; delete has no confirmation and cascade-deletes activities.                                                                                           | **S**  | No                                          |
| **Navigate a large tree**: register every WBS and phase as a command-palette entry (`70001 CARBON STEEL — AG PIPING`), add sidebar tree filter, persist expansion, hide-empty toggle, virtualize past ~200 nodes                                                            | A real estimate is hundreds of phases. The sidebar renders all of them, unfiltered, and collapses on every navigation. `@tanstack/react-virtual` is already a devDependency of `@truss/features` and unused. | **L**  | No                                          |
| **Toasts + confirmations across the tier** (`sonner` already installed, never imported)                                                                                                                                                                                     | Every failure in this domain is currently `console.error`.                                                                                                                                                   | **S**  | No                                          |
| **Whole-estimate grid** (WBS → Phase → Activity in one expandable table)                                                                                                                                                                                                    | Collin's stated pain with legacy is the forced drill-down. Momentum's `workbook-table.tsx` already solves the tree/sticky-group/expand problem.                                                              | **XL** | No                                          |

---

## 3. REDESIGN RECOMMENDATIONS

Opinionated, specific, and deliberately **not** a port.

### R1 — Make the WBS code a first-class, always-visible identifier; derive order from it

Legacy carried the code in `wbsDatabaseId` and then never showed it, ordering by it implicitly.
Precision copied the omission and then broke the ordering.

Do this:

1. Backfill `wbsPool.sortOrder = poolId` (one-line migration; 18 v1 rows) **and** change
   `createProposal:511` to `sortOrder: poolItem.poolId`. Then native and synced WBS agree, and
   `by_proposal_sort` is meaningful.
2. Add `wbsPoolId` and `name` to the return of `getPhaseListWithCosts` so the WBS screen can render
   its own identity.
3. Render the code as a mono/tabular prefix everywhere a WBS appears — sidebar (`70000  AG PIPING`),
   overview table, breadcrumb, Excel. `TreeNavItem`'s `parsePhaseLabel` already does exactly this
   for phases; extend the same regex to WBS labels.
4. **Also sort client-side by numeric code**, exactly as `workbook-table.tsx:283-295` does. Server
   ordering is not a contract you should bet a bid sheet on. Extract one comparator (see §4,
   `wbsOrdering.ts`) and use it in both apps.

### R2 — Phase numbering is a business rule, not a UI increment. Move it to the server.

`add-phase-dialog.tsx:60-67` computing `max+1` in a `useEffect` is wrong twice: it starts at 1, and
it races (dialog opens → `phaseNumber=1` → user types `70050` → the query resolves →
`setPhaseNumber` clobbers the typed value).

Do this: add a query `precision.suggestPhaseNumber({ wbsId, phasePoolId })` that implements the
legacy rule server-side —

```
if phasePoolId ∈ RESERVED_PHASE_NUMBERS: return phasePoolId
return max( max(existing phaseNumber where ∉ RESERVED), wbs.wbsPoolId ) + 1
```

— with `RESERVED_PHASE_NUMBERS` as a checked-in constant module ported verbatim from
`mcp_estimator/src/components/add_phase_dialog.tsx:69-85`. The dialog then seeds once from the query
and never overwrites a dirty field. Add a soft "phase 70012 already exists in this WBS" inline
warning (legacy never checked; don't hard-block, estimators do intentionally duplicate numbers on
revisions).

**Decision needed (see §5):** Momentum's `add-phase-dialog.tsx:113` uses a simpler rule —
`phaseCode = String(poolId)` for every catalog pick. If we can converge Precision on that, the
108-value reserved list dies and the shared dialog gets simpler. That is a business call, not a code
call.

### R3 — Kill the "18 WBS dumped on you" problem without repeating legacy's cure

Legacy's `wbsToDisplay` defaulted to `[]`, so a brand-new proposal showed **zero** WBS and the user
had to find Proposal Home → tab 3 → "WBS Select" to see anything. That is worse than the disease.

Do this instead:

- Keep seeding all 18 (it is one cheap transaction and preserves codes).
- Default the overview and the sidebar to **hide WBS with zero phases**, with a persistent
  `Show all (13 hidden)` toggle — the exact shape of Momentum's `hideUnused` (`workbook-table.tsx`),
  including its rule that a user-added item is _never_ auto-hidden.
- `addWBS` / `deleteWBS` become the escape hatches: "Add WBS" opens the pool picker filtered to
  codes not yet on the estimate; deleting a WBS requires an `AlertDialog` naming the phase and
  activity count it will destroy.
- Reshape `userWbsPreferences` from `{userId, wbsPoolNamesToDisplay}` to
  `{proposalId, userId, hiddenWbsPoolIds: number[]}` with an index on `["proposalId","userId"]`. Key
  on **poolId, not name** — legacy keyed on name and had two sources of truth (`wbs_v1.json` for
  creation, `WbsEnum` for the picker) that could drift.

### R4 — The WBS screen should be a phase workbench, not a read-only report

Legacy's phase grid had 23 columns and 14 of them editable; Precision's has 10 and 0. But do not
reproduce legacy's mistakes while you close the gap:

- **No `editable: true` on non-editable columns.** Legacy declared all 23 editable and blocked 9 at
  runtime via a `notEditableCells` array, so cost cells looked editable and silently refused. Make
  computed columns visually distinct (muted, right-aligned, no hover affordance) and structurally
  non-editable.
- **Do not force-uppercase everything.** Legacy uppercased `description`, `size`, `flc`, `spec`,
  `area`, `status`, `sys`, `unit` — every text field — at both the grid and the store layer. Keep
  uppercase for code-like fields (`unit`, `spec`, `flc`, `size`) and leave `description` alone.
- **`Area` stays a string.** Legacy explicitly excluded it from numeric coercion; a numeric-looking
  area like `0500` must survive.
- **Quantity/unit overrides must be honest.** Legacy wrote Firestore `customQuantity` but patched
  local `quantity` as a string, so the override visually reverted after any activity edit, and the
  loader and the recalculator disagreed about `unit` vs `customUnit`. In Precision: one field pair
  (`customQuantity`, `customUnit`), server-computed derived values returned alongside them, an empty
  edit clears the override and restores the derived value, and the WBS roll-up respects phase-level
  overrides (legacy's did not).
- **Per-WBS column presets, per-WBS persistence.** Hide
  `size, flc, spec, insulation, insulationSize, sheet` for codes
  `10000, 20000, 30000, 40000, 50000, 60000, 80000, 110000, 150000, 180000, 190000, 200000`. Legacy
  got the preset right but persisted user overrides to a **single global**
  `localStorage['phases_visibility']` key shared across every WBS and proposal, and wrote
  `phases_sort` / `phases_filter` that nothing ever read. Scope persistence to
  `(userId, proposalId, wbsPoolId)` in `proposalColumnPreferences` — the table already exists,
  orphaned — and persist sort and filter for real.

### R5 — One "pick a phase" surface, three uses

Legacy had two copy dialogs, one of which (`copy_from_phase_dialog.tsx`) was mounted but unreachable
because `setOpenCopyDialog(true)` was never called anywhere. Don't build two.

Build one `PhasePickerDialog` (cmdk `Command`, searchable across `wbs.name`, `phaseNumber`,
`description`, grouped by WBS) with a `scope` prop:

- `scope: "wbs"` → phases in this WBS, excluding the current one
- `scope: "proposal"` → every phase in the estimate
- `scope: "global"` → a proposal selector on top, then phases in the chosen proposal

All three feed the same `copyActivitiesToPhase` mutation, which already handles all three cases
correctly. Show an activity count per option and a "will append N activities" confirmation line.

### R6 — Constant remapping on copy is a correctness decision, make it explicit

When activities move into a phase with a different `phasePoolId`, their `laborPoolId` points at a
constant that belongs to a different phase type. Legacy shipped the raw copy and left the smarter
version dead in `api/phase.ts:156-205`. Precision currently ships the raw copy too.

Recommendation: on copy, look up each labor activity's source `laborPool` row, try to find a row in
the target `phasePoolId` with the same `description`, and remap `laborPoolId`/`craftConstant`/
`welderConstant`/`unit` when found. When not found, keep the raw constants **and flag the row** in
the result summary ("3 of 18 labor lines kept their original constants"). Never silently guess.

### R7 — Navigation: the tree is the app, so give it a search and a memory

Concretely:

- Register every WBS and phase as a command-palette entry from `shell-config-estimate.ts` (they are
  already fetched by `getWBSWithPhasesForNav`), so `⌘K 70012` jumps straight to a phase. This is the
  single cheapest fix for "navigating a large tree" and it removes the need for a second search box.
- Add a filter input above the Work Breakdown section that filters WBS _and_ phases and auto-expands
  matches.
- Persist expansion state per estimate in the existing `useLayoutStore` (zustand+persist,
  `truss-desktop-layout`). Today `TreeNavItem` uses `useState(hasActiveChild)` and forgets on every
  navigation.
- Virtualize the phase children past a threshold — `@tanstack/react-virtual` is already a
  `@truss/features` devDependency and is imported by nothing.
- **Fix the three dead shortcuts before adding a fourth.** `⌘⇧O` (`open-estimate-switcher`), `⌘⇧E`
  (`export-estimate`) and `⌘B` (`toggle-sidebar`) all dispatch `CustomEvent`s with zero listeners
  (`shell-config-estimate.ts:78, 98, 193-200`), and `⌘P` is a decorative label with no registered
  handler. Advertised-but-dead shortcuts train users not to try shortcuts.

### R8 — Every destructive action in this tier gets a count and a confirmation

Deleting a WBS destroys phases and activities. Deleting phases destroys activities. Today both fire
immediately from a toolbar button. `AlertDialog` is already in `@truss/ui` and already used in
Precision's admin page. Confirm with the real count ("Delete 4 phases and 137 activities?"), then
run **one** server mutation (`batchDeletePhases`), not a client `for` loop of awaits.

### R9 — Do not port these legacy behaviours at all

`hide: true` colliding with a controlled `columnVisibilityModel`; write-only sort/filter
localStorage; invisible row-click selection; the duplicated `api/*` vs `newAPI/*` layers; the
unreachable dialogs; blanket uppercasing; silent `.catch(console.log)`; the `'phases'` vs `'phase'`
collection-name mismatch; the 10-item `in` ceiling on bulk delete; the 500-write unchunked duplicate
batch; and the `'HE'` naive substring match in quantity derivation (it matches SHEET, THE, HEAT).

---

## 4. SHARED UI PLAN

Precision's `packages/features/src/estimation/` has exactly three real artifacts today (`types.ts`,
`editable-cell.tsx`, `bottom-panel.tsx`). Momentum earned a package; Precision never did. Everything
below is about correcting that asymmetry, and every item is something **both** apps need in this
domain.

### 4.1 Promote now (this domain's critical path)

| #   | Component                                                                                                         | New home                                                                                                                     | Source today                                                                                                                                                                                                       | Refactor cost                                                                                                                                                                                                                                                                                                                                                                             | Payoff                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **`AddPhaseDialog`**                                                                                              | `packages/features/src/estimation/add-phase-dialog.tsx`                                                                      | `apps/momentum/src/components/add-phase-dialog.tsx` (368 LOC) is strictly better than `apps/precision/src/components/add-phase-dialog.tsx` (221 LOC)                                                               | **~0.5 day.** Parameterize: `modes: ("catalog"\|"custom")[]`, `extraFields?: ReactNode` (Momentum's change-order status/type select), `suggestedCode`/`suggestedDescription` as props, catalog rows passed **in** rather than queried inside (Momentum uses `getPhasePoolForWbs({wbsId})`, Precision uses `getPhasePool({datasetVersion, wbsPoolId})` — same rows, different resolution). | Precision deletes 221 LOC and gains: cmdk `Command` picker with type-to-filter and ↵-to-select, catalog/custom mode toggle, ⌘↵ submit from anywhere, `toast.success`/`toast.error` instead of `console.error`, a real Cancel, and a suggested-code hint. |
| S2  | **`EditPhaseDialog`**                                                                                             | same folder                                                                                                                  | `apps/momentum/src/components/edit-phase-dialog.tsx` (121 LOC); Precision has **none**                                                                                                                             | **~0.25 day** + adding Precision's extra fields (area, sheet, the 6 `pipingSpec` fields) behind a disclosure                                                                                                                                                                                                                                                                              | First-ever way to fix a phase in Precision. Wires the dead `updatePhase`.                                                                                                                                                                                |
| S3  | **`wbsOrdering.ts`** — `compareWbsForDisplay`, `comparePhasesForDisplay`, `wbsNumericCode`, `parseHierarchyLabel` | `packages/features/src/estimation/ordering.ts` (client) and a mirror in `packages/backend/convex/model/ordering.ts` (server) | `momentum.ts:299-318` + `workbook-table.tsx:283-330`                                                                                                                                                               | **~0.25 day**                                                                                                                                                                                                                                                                                                                                                                             | One ordering contract for both apps; the `#36` lesson stops being tribal knowledge. Precision's H1/H3 bugs become unrepresentable.                                                                                                                       |
| S4  | **`PhasePickerDialog`** (R5)                                                                                      | `packages/features/src/estimation/phase-picker-dialog.tsx`                                                                   | New, but built from Momentum's `PoolBrowser` idiom (`add-activity-dialog.tsx:643-669`)                                                                                                                             | **~1 day**                                                                                                                                                                                                                                                                                                                                                                                | Delivers same-WBS copy, in-proposal copy and cross-proposal copy from one component. Momentum can reuse it for phase reassignment targets.                                                                                                               |
| S5  | **`useGridKeyboardNav({ containerRef, cellAttr, mode })`**                                                        | `packages/features/src/shared/use-grid-keyboard-nav.ts`                                                                      | Duplicated verbatim: `workbook-table.tsx:602-626` and `$estimateId.phase.$phaseId.tsx:136-145`                                                                                                                     | **~0.5 day**                                                                                                                                                                                                                                                                                                                                                                              | One state machine instead of two drifting ones; add the 2-D arrow behaviour both grids lack. Prerequisite for the Excel-grade phase grid.                                                                                                                |
| S6  | **`GridCellInput`** (merge `EditableCell` + `EntryCellInput`)                                                     | `packages/features/src/shared/grid-cell-input.tsx`                                                                           | `packages/features/src/estimation/editable-cell.tsx` (177) + `packages/features/src/progress-tracking/entry-cell-input.tsx` (176) — same `localValue` sentinel, same 350 ms `DEBOUNCE_MS`, same escape-ref discard | **~0.5 day**; deltas are additive props (`saveState`, `maxAllowed`, `notePopover` from Momentum; `readOnly`, `displayFormat: "plain"\|"currency"`, `type` from Precision)                                                                                                                                                                                                                 | Two hand-rolled focus/commit state machines become one. Also fixes the API lie where Precision passes `readOnly` without the required `onCommit` on 6 columns.                                                                                           |
| S7  | **`ConfirmDestructiveDialog`**                                                                                    | `packages/features/src/shared/confirm-destructive-dialog.tsx`                                                                | Momentum's `AlertDialog` usage pattern                                                                                                                                                                             | **~2 hours**                                                                                                                                                                                                                                                                                                                                                                              | R8 for both apps. Takes `{ title, itemCount, cascadeSummary, onConfirm }`.                                                                                                                                                                               |

### 4.2 Promote when the whole-estimate grid story starts (not before)

| #   | Component                                                 | Source                                                                                                                 | Cost                                                                                                                                       | Note                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S8  | **`buildHierarchyRows()`** + **`<StickyGroupTableBody>`** | `workbook-table.tsx:252-462` (`buildTree`) and `:1513-1549` (per-`<tbody>` sticky groups at `top-[32px]`/`top-[72px]`) | **~2 days** to generalize the leaf-row type and pull the Momentum-only rules (change-orders-last, `isSplit` virtual rows) out behind props | Precision needs exactly this the moment it wants WBS→Phase→Activity in one table instead of the drill-down Collin dislikes. **Do not extract earlier** — a premature generalization here is the classic over-abstraction. |
| S9  | `ProjectSwitcher` → generic `EntitySwitcher`              | `packages/features/src/progress-tracking/project-switcher.tsx` (245)                                                   | ~0.5 day                                                                                                                                   | Precision's `estimate-switcher.tsx` (98 LOC) has no search and, critically, **no listener** for the `open-estimate-switcher` event it advertises on ⌘⇧O. Swapping in `ProjectSwitcher` fixes the dead shortcut for free.  |

### 4.3 Explicitly do NOT share

- **One `<DataGrid>` for both grids.** Momentum's workbook is a 3-level expandable tree with one
  editable column, sticky group headers and semantic filters; Precision's phase grid is flat with
  (eventually) ~14 editable columns and multi-select. A `mode: "tree" | "flat"` component with two
  column dialects is harder to change than two files. Share the primitives (S5, S6, S8), not the
  table.
- **`wbs-card.tsx`** (`packages/features/src/progress-tracking/wbs-card.tsx`, 120 LOC). It is the
  only consumer of `StatusBadge`, it has **zero importers in either app**, and its whole model is
  `percentComplete` / `earnedMH` — tracking semantics that have no meaning in an estimate. Delete
  it; do not adapt it for Precision's WBS overview.
- **Excel export.** Two genuinely different workbooks. Only the download-blob boilerplate overlaps.

### 4.4 One backend-shared item worth doing

`compareWbsForDisplay` / `comparePhasesForDisplay` currently live inside `momentum.ts`. Move them to
`packages/backend/convex/model/ordering.ts` and have `precision.ts` import them. Both files already
sit in the same Convex deployment; there is no reason for two definitions of "what order do WBS go
in".

---

## 5. RISKS AND UNKNOWNS

### Decisions Collin needs to make

| #   | Decision                                                                                                                                                                                                                              | Why it can't be made in code                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Phase numbering rule.** Port legacy exactly (108 reserved catalog ids kept verbatim + `max(non-reserved, wbsCode)+1`), or adopt Momentum's simpler `phaseCode = catalog poolId`?                                                    | Phase numbers appear on bid sheets and in PM conversations. Changing the rule changes numbers estimators recognise. Legacy's rule is also the thing that keeps MOBILIZE/DEMOBILIZE/SUPPORT phases at their canonical numbers. |
| D2  | **Do estimators want all 18 WBS, or do they pick?** Legacy seeded 18 and defaulted them all hidden. R3 proposes seed-18 + hide-empty + explicit add/remove. Confirm that matches how InDemand actually estimates.                     | Product behaviour, not a technical constraint.                                                                                                                                                                                |
| D3  | **Derived quantity/unit rules** (`getQuantityAndUnit`). Port the keyword rules as-is including the naive `'HE'` substring match (so numbers tie out to legacy), or tighten the match (so numbers are _right_ but differ from legacy)? | Tightening it changes the Quantity column on existing jobs. If any legacy bid was won on those numbers, changing them silently is worse than keeping the bug.                                                                 |
| D4  | **Uppercase policy.** Legacy uppercased every text field including free-text descriptions. Keep for code-like fields only, or keep everywhere?                                                                                        | Muscle memory / report appearance.                                                                                                                                                                                            |
| D5  | **Constant remapping on copy** (R6). Legacy shipped raw copy; its dead code remapped. Which is correct estimating practice?                                                                                                           | Arguably a correctness bug in the legacy app that nobody noticed. Needs an estimator's answer.                                                                                                                                |
| D6  | **Cross-proposal copy** — wanted? It is net-new (legacy's dialog of that name only ever scoped to one proposal), and the mutation already permits it.                                                                                 | Scope call.                                                                                                                                                                                                                   |
| D7  | **Drill-down vs whole-estimate grid.** Is the Proposal→WBS→Phase→Activity click path itself part of what Collin hates, or just the legacy _chrome_ around it?                                                                         | Determines whether S8 (~2 days extraction + an XL build) is on the roadmap or not.                                                                                                                                            |
| D8  | **Custom WBS.** `wbsPool.isCustom` exists and no mutation ever writes it. Should an estimator be able to invent a WBS that isn't in the catalog? Legacy: never.                                                                       | Affects the `addWBS` picker design.                                                                                                                                                                                           |

### Technical risks

| #   | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | **The `wbsPool.sortOrder` fix needs a data migration**, not just a code change. 18 v1 rows in `focused-civet-250`. Any WBS already created natively (0 in prod today, possibly some in dev) needs backfilling too. Do it now while the blast radius is zero.                                                                                                                                                                                                                                                             |
| T2  | **`syncProposalTree` patches WBS and phases.** The 6-hourly cron is proposals-only (`crons.ts`), so phase edits are safe from _it_. But `syncMutations.ts:172` and `:207` do `ctx.db.patch(existing._id, {...wbsData})` / `{...phaseData}` and that runs whenever someone creates a Momentum project from a legacy proposal. **Precision edits to a legacy-origin phase can be reverted by an unrelated Momentum action.** Needs the same "who owns the write" resolution the proposals cron needs, scoped to this tier. |
| T3  | **No authorization anywhere.** `precision.ts` has no `ctx.auth` in any of its 30 functions, and there is no client-side permission gate outside `admin/`. Adding `deleteWBS` to the UI means any authenticated user can destroy a WBS and everything under it. Ship the destructive WBS/phase actions _behind_ a permission check, or ship them last.                                                                                                                                                                    |
| T4  | **`apps/precision` does not type-check** (27 app-level errors; `check-types` is `echo`). Two of those are in `$estimateId.wbs.$wbsId.tsx` / `$estimateId.index.tsx`. Any refactor in this domain is unguarded.                                                                                                                                                                                                                                                                                                           |
| T5  | **`getExportData` is subscribed on overview mount** purely to enable the Export button — a full tree query with every activity and every computed cost. Adding WBS/phase columns to the export makes that heavier. Move it behind an on-demand action.                                                                                                                                                                                                                                                                   |
| T6  | **Nothing in this tier has a test.** The phase-number rule, the ordering comparators and the quantity-derivation rules are all pure functions — they are exactly what should be unit-tested, and there is no test infrastructure in `apps/precision` or `packages/features/src/estimation`. The `rigProfitRate` welder-rate bug survived precisely because of this.                                                                                                                                                      |
| T7  | **Reserved-phase-number list provenance.** The 108 values live only as a hard-coded array in `add_phase_dialog.tsx:69-85`. There is no documentation of why each id is reserved. Porting it means porting an undocumented business rule verbatim and hoping.                                                                                                                                                                                                                                                             |

### Open unknowns

- The `wbsPool` and `phasePool` tables are **not seeded by anything in this repo** — `seed.ts` has
  no pool code and no import script exists. They were populated out-of-band. That means the H1 fix
  has no reproducible seeding path today, and a future v2 dataset has no authoring surface.
- No v2 `wbsPool` or `phasePool` rows exist in prod (all 18 + 228 rows are `v1`), so every
  `datasetVersion: "v2"` estimate silently falls back to v1 in four separate query fallbacks. The
  4-axis dataset-versioning model legacy pinned per-proposal
  (`{labor:v2, phases:v1, wbs:v1, equipment:v2}`) is collapsed to a single `datasetVersion` string
  in Precision's schema — that is a deliberate simplification, but it means Precision cannot express
  "labor v2, wbs v1", which is what every legacy proposal created since the v2 rollout actually is.

---

## 6. SUGGESTED WORK BREAKDOWN

Ordered so each chunk is independently shippable and each unblocks the next.

**Chunk 0 — Ordering & identity (S, ~1 day). Do this before anything else.**

1. Migration: `wbsPool.sortOrder = poolId` for all 18 v1 rows; backfill any native `wbs` rows.
2. `createProposal:511` → `sortOrder: poolItem.poolId`.
3. Extract `packages/backend/convex/model/ordering.ts` with `compareWbsForDisplay` /
   `comparePhasesForDisplay` (moved out of `momentum.ts:299-318`); apply `comparePhasesForDisplay`
   in `getPhaseListWithCosts` and `getWBSWithPhasesForNav`.
4. Mirror the comparators client-side in `packages/features/src/estimation/ordering.ts` and sort
   defensively in `WBSTable`, the sidebar config and the phase table — Momentum's `#36` pattern.
5. Return `name` + `wbsPoolId` from `getPhaseListWithCosts`; render `70000 · AG PIPING` in the WBS
   screen header and `70001 — CARBON STEEL` in the phase breadcrumb.
6. Full breadcrumb (proposal › WBS › phase) hoisted into the shared `AppBar`.

**Chunk 1 — Make the tier editable (M, ~3 days).**

1. Promote `AddPhaseDialog` and `EditPhaseDialog` into `packages/features/src/estimation/` (S1, S2);
   delete `apps/precision/src/components/add-phase-dialog.tsx`.
2. Server-side `suggestPhaseNumber` per R2 + the ported `RESERVED_PHASE_NUMBERS` constant module
   (gated on D1).
3. Wire `updatePhase`: inline-editable `phaseNumber`, `description`, `area`, `sheet`, `status` in
   the phase grid, using `GridCellInput` (S6).
4. Toggle `isCompleted` from the grid; roll `completed` up to the WBS in `getWBSListWithCosts`.
5. `toast` on every mutation in the tier; `ConfirmDestructiveDialog` (S7) on phase delete with a
   real phase + activity count; replace the client `for`-loop delete with a single
   `batchDeletePhases` mutation; make Duplicate act on the whole selection.

**Chunk 2 — WBS lifecycle (M, ~2-3 days).**

1. Wire `addWBS` behind a pool picker filtered to codes not on the estimate.
2. Wire `deleteWBS` behind a confirmation naming the cascade.
3. Hide-empty-WBS toggle with a hidden count, defaulting to on (R3); reshape `userWbsPreferences` to
   `{proposalId, userId, hiddenWbsPoolIds}` and actually read/write it.
4. Widen the overview WBS table to the legacy 12-column roll-up (it already receives
   material/equipment/sub/cost-only in the payload and drops them).

**Chunk 3 — Copy flows (M, ~2 days).**

1. Build `PhasePickerDialog` (S4) with `scope: "wbs" | "proposal" | "global"`.
2. Wire `copyActivitiesToPhase` for all three scopes; show "will append N activities".
3. Constant remapping + unmatched-row reporting per R6 (gated on D5).

**Chunk 4 — The real phase grid (L, ~1 week).**

1. `useGridKeyboardNav` (S5) with 2-D arrow support + Tab/Shift+Tab skipping read-only columns,
   Enter/Shift+Enter row movement, F2, type-to-replace, Delete-clears-and-commits, Esc discards,
   auto-commit on navigation, focus restore after reactive data changes.
2. All 23 columns with the correct editable set, formats (`$` 2dp, 2dp thousands for MH/qty, blank
   for null), `Area` as a string, and code-field-only uppercasing.
3. Derived quantity/unit server-side + `customQuantity`/`customUnit` overrides with
   clear-to-restore, feeding the WBS roll-up (gated on D3).
4. Per-WBS column presets + per-`(user, proposal, wbs)` visibility/sort/filter persistence via
   `proposalColumnPreferences`.
5. Unit tests for `suggestPhaseNumber`, both comparators and the quantity-derivation rules.

**Chunk 5 — Navigating a large tree (L, ~1 week).**

1. Register every WBS and phase as a command-palette entry from `shell-config-estimate.ts`.
2. Sidebar tree filter with auto-expand-on-match; persist expansion per estimate in
   `useLayoutStore`.
3. Hide-empty in the tree, mirroring the overview toggle.
4. Virtualize phase children past a threshold using the already-installed `@tanstack/react-virtual`.
5. Fix or delete `open-estimate-switcher`, `export-estimate`, `toggle-sidebar` and the decorative
   `⌘P` label; swap `estimate-switcher.tsx` for the promoted `EntitySwitcher` (S9).

**Chunk 6 — Whole-estimate grid (XL, gated on D7).** Extract `buildHierarchyRows()` +
`<StickyGroupTableBody>` from `workbook-table.tsx` (S8), then build the WBS→Phase→Activity
single-surface grid. Only start this after Chunk 4 proves out the cell and keyboard primitives.
