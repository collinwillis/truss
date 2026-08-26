# Gap Analysis — Activity Data Grid, Data Entry & Bulk Operations

**Domain:** the highest-volume surface in Precision — the activity spreadsheet, cell editing, and
every bulk mutation that runs off it. **Date:** 2026-07-26 **Method:** read the 9 inventory reports,
then verified every load-bearing claim against source. Production scale numbers below were measured
directly against the live Convex deployment `focused-civet-250` with read-only one-off queries.

---

## 0. The measurement that should change the plan

Before anything else. I queried production. These are not estimates.

| Measurement                                             | Value                                                                                                  | Source                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Total `activities` rows in prod                         | **> 32,000** (hit Convex's per-function 32k document read ceiling)                                     | `runOneoffQuery`, full-table `.take(60000)` rejected |
| Largest single estimate — proposal **`1734.LA`**        | **13,314 activities · 2,222 phases · 18 WBS (13 populated)**                                           | indexed `by_proposal` collect                        |
| → total rows if rendered as one WBS→Phase→Activity tree | **15,554**                                                                                             | computed                                             |
| → largest single phase inside it                        | **562 activities**                                                                                     | computed                                             |
| Phases per proposal, across 557 proposals               | median **12**, p75 **34**, p90 **87**; 27 proposals > 200; 12 proposals > 500                          | 30k-row `phases` sample                              |
| Activities per phase, across 21,454 phases              | median **1**, p90 **2**, but tail to **562**                                                           | 30k-row `activities` sample                          |
| Activity type mix                                       | labor **73%**, custom_labor **20%**, equipment 2.3%, material 2.3%, subcontractor 1.4%, cost_only 1.4% | same sample                                          |

Three consequences, and they are the spine of this whole document:

1. **The per-phase grid is the wrong unit of work.** The median phase holds _one_ activity. An
   estimator working proposal `1734.LA` under the legacy navigation model (and under Precision's
   current copy of it — `routes/estimate/$estimateId.phase.$phaseId.tsx`) must open **2,222 separate
   screens** to touch the estimate. That, not cell latency, is the real reason the legacy app feels
   awful. The primary editing surface must be a **whole-estimate (or whole-WBS) workbook**, with the
   per-phase view demoted to a filtered projection of the same component.

2. **Virtualization is mandatory, and the target is ~15,000 rows × 20 columns**, not the "5-50
   activities per phase — efficient and fast" that the JSDoc on `precision.ts:707` assumes. 15,554
   rows × 20 columns = 311,000 cells. Nothing survives that unvirtualized.
   `@tanstack/react-virtual@^3.10.8` is already a devDependency of `@truss/features` and is imported
   by **exactly zero files** in the repo (grep-verified).

3. **Labor + custom_labor are 93% of all rows.** Every throughput decision — the add dialog, paste,
   fill-down, the default column set — should be optimized for labor lines first and everything else
   second.

---

## 1. CURRENT PARITY — honest assessment

**Rough parity with the legacy activity grid: ~15%.**

### What genuinely works

`apps/precision/src/routes/estimate/$estimateId.phase.$phaseId.tsx` (541 lines) is a real, working
TanStack Table v8 grid. It has:

- 12 columns rendered from a `useMemo`'d `ColumnDef<ActivityRow>[]`: select checkbox, type
  icon+abbr, description, qty, unit, Craft MH, Weld MH, Craft $, Mat $, Equip $, Sub $, Total.
- Sticky `<thead>`, 30px zebra-striped rows, right-aligned tabular-nums money.
- Multi-select via TanStack's `rowSelection` state with `getRowId: (r) => r._id`, and a "Delete N"
  button calling `precision.batchDeleteActivities`. **This is genuinely better than legacy**, which
  never enabled `checkboxSelection` and forced ctrl+click row selection.
- Inline editing of **two** fields (`description`, `quantity`) through the shared `EditableCell` in
  `packages/features/src/estimation/editable-cell.tsx` (177 lines), which implements a correct
  local-state/debounce/escape-discard state machine: `localValue: string | undefined` as the editing
  sentinel, 350 ms idle auto-commit, commit-on-blur with the pending timer cancelled, `escapeRef` +
  blur to discard.
- Tab / Shift+Tab / Enter cell traversal via `nav()` (`$estimateId.phase.$phaseId.tsx:136-145`) — a
  DOM query over `input[data-cell-id]`.
- Server-computed costs. `precision.getActivitiesWithCosts` (`precision.ts:711`) reads
  `by_phase_sort` and maps each row through `computeActivityCosts`. **Nothing is pre-aggregated and
  no derived cost is persisted** — the architecture bet holds, and it is the strongest thing in the
  codebase.
- Formula fidelity for material, equipment (both ownership branches), subcontractor, cost-only, and
  the subcontractor `totalCost` special case — all verified against
  `mcp_estimator/src/api/totals.ts`.

### What is present but wrong

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **`computeWelderLoadedRate` omits `rigProfitRate` from the weld-base markup.** Every welder cost in Precision is understated. The JSDoc at `precision.ts:169-177` explicitly asserts the opposite.                                                                                                                                                                                                                                                                                                                                                                                                                           | `precision.ts:179-195` vs `mcp_estimator/src/api/totals.ts` |
| **`round2` is applied mid-calculation, not at the boundary.** `costs.craftManHours = round2(qty * craftConstant)` then `craftCost = round2(craftManHours * craftLoaded)`. Legacy multiplies unrounded and rounds only at display/export. On a 562-row phase this drifts, and it will make a Precision-vs-legacy reconciliation impossible to close.                                                                                                                                                                                                                                                                          | `precision.ts:143-145, 224-241`                             |
| **`EditableCell`'s `React.memo` is defeated on every render.** The cell renderers pass a fresh inline arrow: `onCommit={(v) => commit(row.original._id, "description", v)}`. New identity every render ⇒ the memo never short-circuits ⇒ every Convex push re-renders every cell. Momentum solved this correctly with `stableOnCommit`/`stableOnKeyDown` refs (`workbook-table.tsx:628-660`); Precision did not.                                                                                                                                                                                                             | `$estimateId.phase.$phaseId.tsx:202, 217`                   |
| **Invalid numeric input is silently swallowed** — `commit()` does `if (!isNaN(n)) updateRef.current(...)` with **no else branch**. The cell keeps showing the bad value, nothing is saved, nothing is reported. This is _literally_ legacy UX bug #3 reproduced in new code.                                                                                                                                                                                                                                                                                                                                                 | `$estimateId.phase.$phaseId.tsx:125-133`                    |
| **Mutation errors are unhandled promise rejections.** `updateRef.current({...})` is never awaited and has no `.catch`. `sonner` is a declared dependency of `apps/precision` and is imported **nowhere** in `apps/precision/src`.                                                                                                                                                                                                                                                                                                                                                                                            | same, + package.json                                        |
| **The "Add ▾" dropdown discards the chosen type.** All six `DropdownMenuItem`s call `onClick={() => setAddOpen(true)}` with no argument; the dialog always opens on Labor.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `$estimateId.phase.$phaseId.tsx:411`                        |
| **`@tanstack/react-table@^8.21.3` is declared only in the ROOT `package.json` `devDependencies`.** Neither `apps/precision`, `apps/momentum`, nor `packages/features` declares it, yet all three import it. It resolves purely by bun hoisting, from a _dev_ dependency, for _production runtime_ code. This violates the repo's own package rules in `CLAUDE.md` and is a silent build landmine.                                                                                                                                                                                                                            | root `package.json:36`; grep of all package.jsons           |
| **`getExportData` is subscribed on mount of the estimate overview.** `$estimateId.index.tsx:82` — an unconditional `useQuery` pulling the _entire_ WBS→phase→activity tree with computed costs, purely to enable an Export button. For `1734.LA` that is 15,554 documents streamed and held in the Convex client cache on every estimate open.                                                                                                                                                                                                                                                                               | `$estimateId.index.tsx:82`; `precision.ts` `getExportData`  |
| **Precision edits to activities get destroyed by the Firestore sync.** `sync/syncMutations.ts:248` does `ctx.db.patch(existing._id, {...activityData, proposalId, wbsId, phaseId})` on every activity matched by `firestoreId`. This runs from `momentum.createProjectFromProposal` → `internal.sync.syncEngine.syncProposalTree` (`momentum.ts:2420`) — whose progress label literally reads _"Pulling estimate from Precision"_ while in fact overwriting Precision from Firestore. The `precision-current` audit flagged this for the Details/Rates tabs; **it applies to every activity field too**, which is far worse. | verified in source                                          |

### What is simply absent

Everything else. Concretely, against the legacy parity checklist:

- 8 of the 20 legacy columns are missing entirely (`Item` row label, `Duration`/time, `Price`,
  `Ownership`, `Craft Const.`, `Welder Const.`, `Craft Base`, `Subsistence`, `Cost Only $`).
- 10 of ~12 meaningful fields are non-editable. `precision.updateActivity` accepts `unit`, `labor`,
  `equipment`, `subcontractor`, `unitPrice` — **none of them has a column**. `commit()` even lists
  `unitPrice` in its `numeric` set (line 126) for a column that does not exist: a dead code path.
- No per-activity-type editable rule. All six types render the identical two editors. The legacy's
  six distinct editable sets and its `not-used` strike-through treatment do not exist.
- No copy, no paste, no fill-down, no range selection, no undo — same as legacy, which is the point:
  **we are currently tied with the app we are replacing on the one thing estimators complain about
  most.**
- No row ordering UI. `precision.reorderActivities` exists and is called from nowhere.
- No bulk ops beyond delete: no Reset Constants, no bulk rate override, no bulk retype, no
  duplicate.
- No copy-activities-from-another-phase UI. `precision.copyActivitiesToPhase` exists and is dead.
- No column visibility. The `proposalColumnPreferences` table in `schema.ts:976` enumerates all 20
  legacy columns with per-user toggles and is **orphaned** — no Convex function reads or writes it.
- No confirmation on `batchDeleteActivities`; no undo; no count warning.
- No permission gating anywhere in `apps/precision/src` outside `admin/`.
- No tests. The cost engine — the one thing that must be exactly right — has zero coverage, which is
  exactly why the `rigProfitRate` bug shipped.

---

## 2. MISSING CAPABILITIES

Effort scale: **S** ≤ 1 day · **M** 2–4 days · **L** 1–2 weeks · **XL** 3+ weeks.

| #   | Capability                                                                                                                                                                                                                                                                                     | Why it matters                                                                                                                                                                                                                                                                                                                                                      | Effort                                            | Blocks other work?                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | **Extract the cost engine into an isomorphic module** (`packages/backend/convex/model/costEngine.ts`, exported via a new `@truss/backend/cost-engine` subpath) + unit tests for all 7 cost paths against known legacy outputs; fix `rigProfitRate`; move `round2` to the presentation boundary | Every number in the app comes from here, it is currently private to `precision.ts:143-311`, provably wrong for welders, and untestable. Optimistic updates are impossible without a client-runnable copy — and a _second_ client copy would drift exactly like legacy's `calculations.ts` vs `totals.ts`                                                            | **S**                                             | **Yes** — blocks optimistic updates, blocks any paste/fill preview, blocks reconciliation with legacy |
| 2   | **Row virtualization** (`@tanstack/react-virtual`, already installed, zero usage) with fixed 30px rows, padding-row technique to preserve `<table>` semantics, and a `rangeExtractor` that pins the active WBS/phase group rows for sticky headers                                             | 15,554 rows × 20 cols on the largest real estimate. Without it the whole-estimate grid is unshippable and even a 562-row phase stutters                                                                                                                                                                                                                             | **M**                                             | **Yes** — blocks the whole-estimate grid; forces the keyboard rewrite (#3)                            |
| 3   | **State-based 2-D keyboard navigation** (`useGridKeyboardNav`) replacing DOM-order `querySelectorAll` traversal                                                                                                                                                                                | Both current implementations (`workbook-table.tsx:602-626` and `$estimateId.phase.$phaseId.tsx:136-145`) query the DOM for mounted inputs. **They break the instant virtualization lands** — Tab from the last visible row finds nothing. Also they are linear-only: no ↑/↓ within a column, no Home/End, no wrap                                                   | **M**                                             | **Yes** — blocks range selection, paste, fill-down, and #2 shipping safely                            |
| 4   | **Full editable column set with per-type rules** — all 20 legacy columns, 6 distinct editable sets, `not-applicable` visual treatment, in-cell selects for equipment `unit`/`ownership`                                                                                                        | Today you cannot fix a labor constant, a material price, an equipment duration, or a subcontractor cost breakdown without deleting and re-adding the row. This is the #1 day-to-day friction in Precision                                                                                                                                                           | **L**                                             | **Yes** — paste/fill-down/bulk-edit have nothing to target without editable columns                   |
| 5   | **`applyActivityEdits` batch mutation** with a _flat sparse_ patch validator (`quantity?`, `craftConstant?`, `equipmentOwnership?`, `subLaborCost?`, `type?`, …) that the server merges into the nested `labor`/`equipment`/`subcontractor` objects, returning prior values                    | `precision.updateActivity` takes `labor: v.object(laborFields)` — a **whole object**. Editing one constant requires a client read-modify-write, which loses concurrent edits and is un-batchable. One flat batch mutation serves single-cell edit, fill-down, paste, bulk retype, reset-constants and rate override — one code path, one transaction, one undo unit | **S**                                             | **Yes** — blocks undo, paste, fill-down, bulk retype, bulk rate override                              |
| 6   | **Optimistic updates** via `useMutation(...).withOptimisticUpdate` mirroring the server rollup with the _same_ cost-engine function                                                                                                                                                            | Legacy's worst perf sin is one awaited network round-trip per committed cell (`activity_data_grid.tsx:1243`). If Precision awaits Convex before advancing the cursor, we have shipped the same app. Momentum already proves the pattern at `$projectId.index.tsx:130-240`                                                                                           | **M**                                             | No, but it is the difference between "beats legacy" and "matches legacy"                              |
| 7   | **Range selection** (Shift+Arrow, Shift+Click, Cmd+A) as a first-class `{anchor, focus}` model separate from row selection                                                                                                                                                                     | Prerequisite for copy, paste and fill-down. MUI X v5 could not do this at all, which is _why_ legacy has none of them                                                                                                                                                                                                                                               | **M**                                             | **Yes** — blocks #8, #9, #10                                                                          |
| 8   | **Paste from Excel** — TSV parse, per-column coercion + validation, a preview dialog ("Apply 240 values to 60 rows × 4 columns · 3 rejected"), then one `applyActivityEdits`                                                                                                                   | The single most-requested spreadsheet capability legacy never had. Estimators live in Excel; today they retype                                                                                                                                                                                                                                                      | **L**                                             | No                                                                                                    |
| 9   | **Copy as TSV** (raw numbers on `text/plain`, formatted `text/html` flavor for Excel)                                                                                                                                                                                                          | Round-trip to Excel and back is the practical escape hatch for anything the grid can't do                                                                                                                                                                                                                                                                           | **S**                                             | No                                                                                                    |
| 10  | **Fill-down (Cmd+D) / fill-right (Cmd+R)**                                                                                                                                                                                                                                                     | Setting the same craft base rate or unit down 60 rows currently means 60 edits                                                                                                                                                                                                                                                                                      | **S**                                             | No                                                                                                    |
| 11  | **Undo/redo stack** (bounded, ~50 deep) built on the inverse-edit payload from #5, plus **soft delete** (`deletedAt` field + filtered reads + purge cron) so deletes are undoable                                                                                                              | `design-principles.md §XIII` says "Undo > Confirmations". Precision has neither today. Bulk delete with no confirm and no undo on 562 rows is a data-loss event waiting to happen                                                                                                                                                                                   | **M**                                             | No                                                                                                    |
| 12  | **Whole-estimate workbook grid** — WBS→Phase→Activity tree, expand/collapse, sticky group headers, search + filters, over a new paginated `getEstimateGrid({proposalId, wbsId?})` query                                                                                                        | Median phase = 1 activity; largest estimate = 2,222 phases. The drill-down navigation model is the actual UX disaster Collin is describing. This is the marquee win over legacy                                                                                                                                                                                     | **XL**                                            | No, but it is the highest-value item in the domain                                                    |
| 13  | **Multi-select catalog add** (check N labor constants → one batch insert) + a new plural `addActivities` mutation on both backends                                                                                                                                                             | Legacy's `AddActivityDialog` batch-creates N rows from N checkboxes; neither Momentum's nor Precision's dialog can. Labor is 93% of all rows — this is the throughput path. Also fixes an N-reads problem: `precision.addActivity:1406` does a full `.collect()` of the phase per insert, so 30 adds = 30 collects                                                  | **M**                                             | No                                                                                                    |
| 14  | **Add-activity dialog unification** into `packages/features/src/activities/`, promoted from Momentum's 1,001-line version, with `initialType`, injected pools, `renderPreview`, and `multiSelect`                                                                                              | Collin's explicitly named goal. Payloads are already byte-identical in shape (`momentum.ts:3532` vs `precision.ts:1387`); Precision deletes 621 lines and gains cmdk catalog search, validation, ⌘↵, toasts, and a live cost preview                                                                                                                                | **M**                                             | No                                                                                                    |
| 15  | **Per-activity rate override** — `craftBaseRate` / `subsistenceRate` columns + a bulk "Set rates on N rows" action                                                                                                                                                                             | `computeCraftLoadedRate` already honors `customCraftRate`/`customSubsistenceRate`, the schema stores them, the Firestore sync populates them, and **nothing in the UI can set them.** The Custom Labor tab's helper text claims otherwise and is false                                                                                                              | **S** (columns) / **M** (bulk + eligibility rule) | No                                                                                                    |
| 16  | **Reset Constants** — re-read `laborPool` by `(datasetVersion, laborPoolId)` and write the catalog values back                                                                                                                                                                                 | Legacy nulls the fields so the _embedded snapshot_ takes over. **Precision has no embedded snapshot** — it stores `laborPoolId: number`. So this must be a server-side re-read mutation, not a null-out. Different implementation, same user-facing capability                                                                                                      | **S**                                             | No                                                                                                    |
| 17  | **Bulk retype** (change 40 rows from labor to custom_labor, etc.)                                                                                                                                                                                                                              | `precision.updateActivity` cannot set `type` at all. Legacy also cannot — this is a net-new capability, and it needs a documented rule table for what happens to type-specific fields                                                                                                                                                                               | **M**                                             | No — but needs a decision (§5)                                                                        |
| 18  | **Row ordering** — persisted `sortOrder` with fractional midpoint insertion, drag-to-reorder, and the A/B/…/AA row label                                                                                                                                                                       | Legacy _intended_ drag-reorder (`onRowOrderChange` is wired) but never set `rowReordering`, so its only reorder affordance is typing a letter into the Item cell — unguessable. `precision.reorderActivities` exists, is dead, and rewrites `sortOrder = i+1` for the whole list (the legacy whole-phase-rewrite problem, repeated)                                 | **M**                                             | No                                                                                                    |
| 19  | **Column visibility** — auto-visibility driven by which types are present in scope, plus per-user overrides persisted to the orphaned `proposalColumnPreferences` table                                                                                                                        | 20 columns on a labor-only phase is noise. Legacy's Layer 1 auto-visibility is the rule that actually matters; its Layer 2 per-WBS baseline table is provably inert (`false \|\| cond === cond`) and must **not** be ported                                                                                                                                         | **M**                                             | No                                                                                                    |
| 20  | **Copy activities between phases / across proposals** — UI for the dead `precision.copyActivitiesToPhase`, plus a cross-proposal variant                                                                                                                                                       | Legacy's `CopyActivitiesFromProposalDialog` is heavily used. Note legacy's live copy path has a **`wbsId` not remapped** bug; Precision's `copyActivitiesToPhase:1362-1364` correctly takes `targetPhase.wbsId` — do not regress that                                                                                                                               | **S** (same-proposal) / **M** (cross-proposal)    | No                                                                                                    |
| 21  | **Error surfacing + validation feedback** — `toast` on every mutation failure, inline invalid-cell state, and a rejection path that does not silently drop the value                                                                                                                           | Estimators must be able to trust that what they typed is saved. Both legacy and Precision fail this identically today                                                                                                                                                                                                                                               | **S**                                             | **Yes** — nothing else is trustworthy without it                                                      |
| 22  | **Declare `@tanstack/react-table` properly** (peerDep of `@truss/features`, dep of both apps) and move `@tanstack/react-virtual` out of devDependencies                                                                                                                                        | A production runtime dependency resolving by hoist from a root devDependency. One `bun install --production` or a hoisting change and both grids stop building                                                                                                                                                                                                      | **S**                                             | **Yes** — blocks reliable builds                                                                      |
| 23  | **Read-only mode by permission**                                                                                                                                                                                                                                                               | Legacy gates every editable cell, every toolbar action and the quick-add bar on `permission === 'READ_WRITE'`. Precision has **zero** permission checks in the grid, and `precision.ts` has no `ctx.auth` in any of its 30 functions                                                                                                                                | **S** (client) / **M** (server)                   | No                                                                                                    |
| 24  | **Direct/indirect hour classification in the phase & WBS bottom panels**                                                                                                                                                                                                                       | `getProposalSummary` computes it; the phase and WBS screens re-sum client-side (`$estimateId.phase.$phaseId.tsx:339-365`) and therefore cannot show it. Legacy shows Direct/Indirect/Sub Hrs at every scope                                                                                                                                                         | **S**                                             | No                                                                                                    |

---

## 3. REDESIGN RECOMMENDATIONS

Opinionated. Each item names what legacy does, why not to copy it, and what to build instead.

### 3.1 Kill the per-phase drill-down as the primary editing surface

**Legacy:** `/proposal/:id/wbs/:wbsId/phase/:phaseId` — one grid per phase, reached through a
sidebar phase list. Precision copied this route-for-route.

**Why not:** production data says the median phase holds **one** activity and proposal `1734.LA` has
**2,222 phases**. The estimator's real task is "price this estimate," and the app forces them to
express it as 2,222 separate page loads. No amount of cell-level polish fixes that.

**Instead:** the primary surface is a **whole-estimate workbook** — a single virtualized grid of
`WBS → Phase → Activity` rows with expand/collapse, group search, and inline editing at the activity
level. This is structurally Momentum's `workbook-table.tsx` shape, which already exists, already
carries the hard-won lessons (client-side numeric WBS ordering because Convex does not preserve
record-key order over the wire, `workbook-table.tsx:285-295`), and is already in
`packages/features`. Keep `/estimate/:id/wbs/:wbsId` and `/estimate/:id/phase/:phaseId` as **scoped
presets of the same component** (`scope={{ wbsId }}` / `scope={{ phaseId }}`), reachable from the
sidebar tree, not as separate implementations.

Backing query: a new `precision.getEstimateGrid({ proposalId, wbsId?, phaseId? })` returning the
flattened row array plus per-group summaries — modeled on `momentum.getBrowseData`
(`momentum.ts:696`). It must be **paginated or WBS-scoped by default**: `1734.LA` is 15,554
documents and Convex's per-function ceiling is 32,000 documents / 16 MiB. We are at 48% of the hard
limit on a real, current estimate.

### 3.2 Do not use DOM-order traversal for keyboard navigation

**Legacy:** `ExcelNavigationDataGrid` (816 lines) is genuinely the best asset in the old repo — F2,
Tab/Enter with non-editable skipping, Escape-discard, type-to-replace, wrap-around, and focus
restoration across async re-sorts. **Precision must reimplement all of it.** But not the
_mechanism_.

**Momentum and Precision both** locate the next cell with
`container.querySelectorAll("input[data-entry-cell]")` / `("input[data-cell-id]")`. Two independent
hand-rolls of the same idiom, and **both are incompatible with virtualization**: only mounted rows
have DOM nodes, so Tab from the last visible row finds nothing and Cmd+Down finds nothing.

**Instead:** one hook, `useGridKeyboardNav`, owning an explicit focus model:

```ts
type GridFocus = { rowId: string; columnId: string; mode: "nav" | "edit" };
```

Navigation is index arithmetic over the row model and the visible-column array; movement calls
`virtualizer.scrollToIndex(nextRowIndex)` and _then_ focuses the input by `data-cell` attribute on
the next frame. Focus is addressed by `rowId`, never by index, so an async save that re-sorts rows
does not lose the cursor (legacy solves this with a `useEffect` on `[rows, columns]` — the intent is
right, the implementation is a DOM query).

**The contract to implement** (legacy behaviors marked ✅, net-new marked ➕):

| Key                           | Nav mode                                                            | Edit mode                                            |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| ✅ ← ↑ → ↓                    | move focus through **all** cells, incl. read-only (estimators scan) | —                                                    |
| ✅ Enter / Shift+Enter        | move down / up to the next **editable** cell (skip non-editables)   | commit, then move down / up, landing in **nav** mode |
| ✅ Tab / Shift+Tab            | move right / left to the next editable cell, wrapping at row ends   | commit, then move right / left, landing in nav mode  |
| ✅ printable char             | enter edit with that char (type-to-replace)                         | —                                                    |
| ✅ F2                         | enter edit, caret at end, **no select-all**                         | —                                                    |
| ✅ Escape                     | —                                                                   | discard, stay on cell, return to nav mode            |
| ✅ Backspace / Delete         | Backspace: clear + edit. Delete: clear + commit + stay in nav       | —                                                    |
| ✅ click away                 | —                                                                   | commit, **no navigation**, do not steal focus back   |
| ➕ Home / End                 | first / last editable cell in the row                               | —                                                    |
| ➕ Cmd+Home / Cmd+End         | first / last row, same column                                       | —                                                    |
| ➕ Cmd+↑↓←→                   | jump to the edge of the contiguous data block                       | —                                                    |
| ➕ Shift+arrows / Shift+Click | extend the **range** selection                                      | —                                                    |
| ➕ Cmd+C / Cmd+V / Cmd+D      | copy TSV / paste TSV / fill down                                    | —                                                    |
| ➕ Cmd+Z / Cmd+Shift+Z        | undo / redo                                                         | —                                                    |
| ➕ Space / Shift+Space        | toggle row selection / select row                                   | —                                                    |
| ➕ Cmd+Backspace              | delete selected rows (with undo, not a confirm dialog)              | —                                                    |

Two legacy props to **not** port: `autoCommitOnNavigation` (accepted, destructured, never
referenced) and `pageSize={100}` (inert with pagination off).

### 3.3 Commit on cell exit, not on a typing debounce

**Legacy:** every committed cell is one `await`ed Firestore `updateDoc` before navigation completes.
Typing down a 60-row column is 60 sequential network round-trips, each gating the cursor.

**Precision today:** `EditableCell` fires `onCommit` after **350 ms of typing idle**, then again on
blur. That is correct for Momentum — one number per cell, users pause to think. It is wrong for
Precision: an estimator tabbing across 8 columns in 3 seconds fires 8 half-typed writes, and
`updateActivity` is not idempotent-safe against a paste that lands mid-debounce.

**Instead:**

- Commit on **cell exit only** — Tab, Enter, blur, Escape (discard). Keep a 1,200 ms idle timer
  purely as a crash/quit safety net (Momentum's `beforeunload` blur-to-commit at
  `$projectId.index.tsx:359-368` is the right companion and Precision has nothing equivalent).
- **Coalesce** every commit inside a 120 ms window into a single
  `applyActivityEdits({ edits: [...] })` call. Typing down a 60-row column becomes ~5 mutations,
  not 60.
- **Never** await the mutation before advancing the cursor. Advance immediately, apply the
  optimistic update, and reconcile.

### 3.4 One flat batch mutation, not seven field-shaped ones

**Legacy:** `updateActivityFieldInFirestore(id, field, value)`, one field per call, with a
stringly-typed `numberFields` allowlist and a validator that returns `{success:false}` which the
caller ignores.

**Precision today:** `updateActivity` takes nested object validators —
`labor: v.optional(v.object(laborFields))` where `laborFields` requires both `craftConstant` and
`welderConstant`. Changing one constant means the client must read the whole `labor` object, mutate
it, and send it back: a read-modify-write with a lost-update race against the Firestore sync cron
and against a second user.

**Instead** — one mutation, flat and sparse:

```ts
export const applyActivityEdits = mutation({
  args: {
    edits: v.array(
      v.object({
        activityId: v.id("activities"),
        patch: v.object({
          description: v.optional(v.string()),
          quantity: v.optional(v.number()),
          unit: v.optional(v.string()),
          type: v.optional(activityType),
          unitPrice: v.optional(v.number()),
          craftConstant: v.optional(v.number()),
          welderConstant: v.optional(v.number()),
          customCraftRate: v.optional(v.union(v.number(), v.null())),
          customSubsistenceRate: v.optional(v.union(v.number(), v.null())),
          equipmentOwnership: v.optional(equipmentOwnership),
          equipmentTime: v.optional(v.number()),
          subLaborCost: v.optional(v.number()),
          subMaterialCost: v.optional(v.number()),
          subEquipmentCost: v.optional(v.number()),
          sortOrder: v.optional(v.number()),
        }),
      })
    ),
  },
  // returns: Array<{ activityId, before: patchShape }>  ← the inverse edit, for undo
});
```

The server merges flat keys into the nested `labor` / `equipment` / `subcontractor` objects, applies
the type-transition rules on `type` changes, and returns the **prior values** for every field it
touched. That return value _is_ the undo entry. This one mutation then serves single-cell edit,
fill-down, paste, bulk retype, reset-constants, and bulk rate override — six features, one
transaction shape, one undo unit, one place to add authorization.

`v.union(v.number(), v.null())` on the rate overrides matters: the legacy uses `||` not `??` for the
fallback, so an intentional per-activity rate of `$0` silently reverts to the proposal rate.
Precision's `computeCraftLoadedRate` correctly uses `??` — preserve that, and make "clear the
override" an explicit `null`.

### 3.5 Optimistic updates must run the _same_ cost function as the server

**Legacy:** all math is client-side, so there is no drift — but also no server. Precision's bet is
server-side compute, which creates a new hazard: any client-side preview (optimistic update, paste
preview, live footer) needs the math too, and a second implementation will drift _exactly_ the way
`mcp_estimator/src/utils/calculations.ts` drifted from `src/api/totals.ts` (different welder
formula, one of them dead, nobody noticed).

**Instead:** move `computeCraftLoadedRate` / `computeWelderLoadedRate` / `computeActivityCosts` out
of `precision.ts` (they are currently private, lines 143-311) into
`packages/backend/convex/model/costEngine.ts`, typed over a plain `ActivityInput` rather than
`Doc<"activities">`, and add `"./cost-engine": "./convex/model/costEngine.ts"` to
`packages/backend/package.json` exports. Then:

- Every Convex query imports it (they already call the private copy).
- `withOptimisticUpdate` imports the identical function, patches the cached `getActivitiesWithCosts`
  / `getEstimateGrid` row, recomputes, and re-rolls the group summaries — exactly the shape Momentum
  proves at `$projectId.index.tsx:130-240`.
- It becomes unit-testable in plain Node, which is how the `rigProfitRate` bug gets caught and how a
  Precision-vs-legacy reconciliation harness gets written.

Fix the two correctness issues in the same move: add `weldBaseRate × rigProfitRate / 100` to the
welder markup, and stop rounding intermediates — round only at the display boundary and in the final
accumulator.

### 3.6 Paste needs a preview, not a leap of faith

Pasting 240 values into a grid where 6 activity types have 6 different editable sets will hit
rejections. Do not silently drop them (legacy's exact failure mode) and do not silently write
garbage.

**The flow:** Cmd+V → parse `text/plain` as TSV → map onto the selected range anchored at the active
cell → per-column coerce and validate against the _target row's_ type rules → show a compact
preview: _"Apply 240 values across 60 rows × 4 columns. 3 cells rejected (Welder Const. is not
editable on Material rows)."_ with a Rows/Columns mismatch warning if the shapes differ → one
`applyActivityEdits`, one undo entry. Skipping the preview would be the single easiest way to turn a
helpful feature into a data-corruption incident on a 562-row phase.

### 3.7 Do not port these legacy behaviors

| Legacy behavior                                                                                                                                                                                                                                            | Verdict                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVITY_BASELINE_VISIBILITY` — 35 entries across 14 WBS ids                                                                                                                                                                                              | **Inert.** `model[field] = baseValue \|\| condition` with every `baseValue === false`. Do not port. Port only Layer 1 (auto-visibility by present activity types).                                                            |
| Reordering by typing a target letter into the "Item" column                                                                                                                                                                                                | **Unguessable.** Keep the A/B/…/AA label as a read-only positional gutter; make reordering drag + Cmd+Shift+↑↓.                                                                                                               |
| Two parallel rate-editing UIs (toolbar `EditBaseRateDialog` + inline rate bar) with independently reimplemented eligibility rules                                                                                                                          | **One surface only.** The dialog also fires N `getDoc` calls on mere row selection (no `open` guard).                                                                                                                         |
| Free-text editing of enum cells (`equipmentOwnership`, `unit`) — legacy renders a `<Select>` in view mode but a plain text editor on double-click, then upper-cases the result, so `Rental` → `RENTAL` and `ownership === 'Owned'` silently stops matching | **Never.** Enum cells get an in-cell combobox with type-ahead and nothing else. Precision's typed `equipmentOwnership` validator already prevents the write; make the UI match.                                               |
| `over` / `under` constant-variance colors                                                                                                                                                                                                                  | **Keep the feature, fix the semantics.** A constant _below_ the catalog is currently painted red/`over`. Rename to "faster/slower than standard" with an actual legend.                                                       |
| Phase quantity inferred by string-matching activity descriptions (`EXCAVATE`, `CLEAN UP`, `HE`, plus a CONCRETE special case)                                                                                                                              | **Do not port silently.** Renaming an activity currently changes the phase's reported quantity. Four divergent copies of this heuristic exist in legacy. Needs an explicit decision from Collin (§5).                         |
| Force-uppercasing every text field on write                                                                                                                                                                                                                | **Keep** (it is a real convention estimators rely on) but do it visibly — `text-transform: uppercase` in the input while typing, not a surprise transform on save.                                                            |
| Bottom panel double-counting subcontractor craft/material/equipment                                                                                                                                                                                        | **Fix.** Legacy's grid roll-up excludes them; its bottom panel does not. Precision's `BottomPanel` must use the roll-up rule (exclude a subcontractor row's component buckets — they are already inside `subcontractorCost`). |

---

## 4. SHARED UI PLAN

**Verdict on the big question: one shared `<DataGrid>` for both apps is still the wrong call — but
the reasoning has changed.** The `momentum-reuse` audit said no because Momentum is a tree with one
editable column and Precision is flat with several. That premise is now obsolete: Precision's
primary grid _should_ be a WBS→Phase→Activity tree (§3.1). What remains genuinely different is the
**cell dialect** (one MH entry cell + note popover + max-clamp vs. twenty typed cells with per-type
editability) and the **row semantics** (virtual split rows, change-order gating). So: share the
**table shell and every primitive**; keep two thin column-definition modules.

New package: **`packages/features/src/grid/`** (add `"./grid": "./src/grid/index.ts"` to
`packages/features/package.json` exports).

| Component                                                                                                                                | Where it comes from                                                                                                          | Plan                                                                                                                                                                                                                                                                                                                                                                                                 | Payoff                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`useGridKeyboardNav`**                                                                                                                 | net-new; replaces `workbook-table.tsx:602-626` and `$estimateId.phase.$phaseId.tsx:136-145`                                  | State-based `{rowId, columnId, mode}` focus model, virtualization-aware, implements the full §3.2 contract. Consumers supply `rows`, `visibleColumns`, `isCellEditable(row, col)`, `virtualizer`                                                                                                                                                                                                     | Removes two divergent hand-rolls; unblocks virtualization for **both** apps; Momentum gains ↑/↓ column movement it never had. **~2 days**                                                                                                                                                                           |
| **`GridCellInput`**                                                                                                                      | merge `progress-tracking/entry-cell-input.tsx` (176) + `estimation/editable-cell.tsx` (177)                                  | Same state machine already, down to the identical `const DEBOUNCE_MS = 350`. Deltas are purely additive props: `saveState` indicator, `NotePopover` slot, `maxAllowed` clamp (Momentum) · `readOnly` render path, `displayFormat`, `type` (Precision). Add `commitOn: "exit" \| "idle"` for §3.3                                                                                                     | Kills the riskiest duplication in the repo — two hand-rolled focus/commit state machines drifting apart. Fixes the memo-defeat bug once. **~0.5 day**                                                                                                                                                               |
| **`<VirtualTableBody>`**                                                                                                                 | net-new, wrapping `@tanstack/react-virtual`                                                                                  | Fixed-height rows, padding-row spacers (preserves `<table>`/`<colgroup>` semantics — do **not** use absolutely-positioned rows), `rangeExtractor` pinning the active group-header indices for sticky WBS/Phase rows. Replaces Momentum's per-`<tbody>` sticky trick (`workbook-table.tsx:1513-1549`), which cannot be sliced by one virtualizer                                                      | Both apps become O(viewport) instead of O(rows). Momentum's workbook is unvirtualized today too. **~2 days**                                                                                                                                                                                                        |
| **`buildHierarchyRows()`**                                                                                                               | promote from `workbook-table.tsx:252-462`                                                                                    | Generic WBS→Phase→leaf flattener with pluggable group summaries. Carries the Convex-record-key-order lesson (`:285-295`) that Precision's rollups will hit identically                                                                                                                                                                                                                               | Precision's whole-estimate grid gets its row model for free. **~1 day to generalize**                                                                                                                                                                                                                               |
| **`useGridSelection`**                                                                                                                   | net-new                                                                                                                      | Two selection models in one hook: **row** selection (TanStack `rowSelection`, keyboard-driven) and **range** selection (`{anchorRowId, anchorCol, focusRowId, focusCol}`). Precision's WBS page currently hand-rolls a `Set<string>` while its phase page uses TanStack — unify                                                                                                                      | Prerequisite for copy/paste/fill-down. **~1.5 days**                                                                                                                                                                                                                                                                |
| **`useUndoStack`**                                                                                                                       | net-new                                                                                                                      | Bounded inverse-edit stack fed by `applyActivityEdits`'s return value. Registers `cmd+z`/`cmd+shift+z` through the existing `KeyboardProvider`                                                                                                                                                                                                                                                       | Satisfies `design-principles.md §XIII` for both apps. **~1 day**                                                                                                                                                                                                                                                    |
| **`clipboard-grid.ts`**                                                                                                                  | net-new                                                                                                                      | `serializeRange(rows, cols) → {tsv, html}` and `parseTSV(text) → string[][]`. Pure functions, trivially testable                                                                                                                                                                                                                                                                                     | Copy/paste for both apps. **~0.5 day**                                                                                                                                                                                                                                                                              |
| **`BulkActionBar`**                                                                                                                      | net-new, generalized from `$estimateId.phase.$phaseId.tsx:391-400`                                                           | "N selected" + slot for actions + Escape-to-clear. Momentum has no bulk-selection surface at all today                                                                                                                                                                                                                                                                                               | Consistent bulk UX; Momentum gains a capability. **~0.5 day**                                                                                                                                                                                                                                                       |
| **`AddActivityDialog`** + `PoolBrowser`, `SelectedItemCard`, `NumberInput`, `SubModeToggle`, `Disclosure`, `PriceField`, `ConstantField` | promote `apps/momentum/src/components/add-activity-dialog.tsx` (1,001) → `packages/features/src/activities/`                 | Props: `laborPool`/`equipmentPool` **passed in** (apps own their Convex queries — the two backends resolve catalogs differently but return identical row shapes), `initialType`, `renderPreview` (Momentum → MH; Precision → extended $ via the shared cost engine), `onSubmit(payload[])`, `multiSelect`, `keepOpenAfterSubmit`. Payload is already the exact shape of both `addActivity` mutations | **Collin's named goal.** Precision deletes 621 lines and gains cmdk catalog search, real validation, ⌘↵, toasts, live preview. Both apps gain multi-select batch add (§2 #13) and the fix for the dead "Add ▾" menu. **~1.5 days** (up from the 1-day estimate once `multiSelect` and `renderPreview` are in scope) |
| **`EditActivityDialog`, `AddPhaseDialog`, `EditPhaseDialog`**                                                                            | promote from `apps/momentum/src/components/` (193 / 368 / 121)                                                               | Straight promotion with a `modes` prop on AddPhase and the change-order branch parameterized out                                                                                                                                                                                                                                                                                                     | Precision has **none** of these; today a typo in a phase description means delete-and-re-add, losing every activity under it. **~1 day total**                                                                                                                                                                      |
| **`NumberInput`**                                                                                                                        | lift from Momentum's dialog (`:890-907`) → `@truss/ui/components/number-input`                                               | `type="text"` + `inputMode="decimal"` + regex strip; no browser spinners, locale-safe                                                                                                                                                                                                                                                                                                                | Precision's `EditableCell` and `add-activity-dialog` both use `type="number" step="any"` today. Grid-wide consistency. **~2 hours**                                                                                                                                                                                 |
| **Cost engine** (`computeActivityCosts` et al.)                                                                                          | extract from `precision.ts:143-311` → `packages/backend/convex/model/costEngine.ts`, new `@truss/backend/cost-engine` export | Pure, typed over `ActivityInput`, unit-tested                                                                                                                                                                                                                                                                                                                                                        | Server queries, client optimistic updates, and paste previews all run **one** implementation. **~1 day incl. tests**                                                                                                                                                                                                |

**What stays app-local:** the column-definition modules (`precision/columns.ts` with the 20
columns + 6 editable sets; Momentum's `entryColumns`/`fullColumns`), the toolbars, and the Convex
query wiring. That is the correct seam — it is where the two products genuinely differ.

**Total promotion cost: ~12–13 engineer-days**, and roughly half of it is work Precision has to do
anyway.

---

## 5. RISKS AND UNKNOWNS

### Needs a decision from Collin

1. **Whole-estimate grid vs. per-phase grid as the primary surface.** This is the single biggest
   scoping call in the domain. The production data (median 1 activity/phase, 2,222 phases on the
   largest estimate) says whole-estimate; it is also 3+ weeks of work and it changes the navigation
   model, the sidebar, and every route. _Recommendation: yes, and make it the phase-2 headline._

2. **The base-rate override eligibility rule.** Legacy allows per-activity rate overrides only for
   `customLaborItem`, **or** WBS `200000` (SUPPORT), **or** phase pool `180002` FIREWATCH / `180003`
   MANWATCH / `180004` TOOLS & EQUIPMENT RUNNER — and for multi-select, only when every selected row
   already shares the same base rate and subsistence. This rule exists in exactly one place
   (`activity_data_grid.tsx:530-599`) and is reimplemented divergently in
   `edit_base_rate_dialog.tsx:80-121`. Is it real business policy or an accident? Precision
   currently has no restriction at all.

3. **Should the welder loaded rate honor a per-activity subsistence override?** Legacy's app says no
   (`getWelderLoadedRate` takes no custom args); legacy's Excel export says **yes**. They disagree,
   so the exported bid sheet does not tie to the screen. Precision must pick one and document it.

4. **Should `weldBaseRate` be overridable per activity?** Legacy: no. Precision: no. Confirm that is
   intentional.

5. **Bulk retype — does it make sense?** Changing a row from `labor` to `material` must drop
   `labor`, require a `unitPrice`, and change which columns are editable. Legacy has no such
   operation. Either we define the transition rules or we say "delete and re-add" and skip #17
   entirely.

6. **The phase quantity/unit keyword heuristic.** Legacy derives a phase's headline quantity by
   string-matching activity descriptions per WBS (`EXCAVATE` / `CLEAN UP` / `HE`, plus a CONCRETE
   `EA`-vs-`CY` special case). Consequence: renaming an activity silently changes the phase's
   reported quantity. Is the business still relying on this, or can Precision make phase quantity an
   explicit field?

7. **Soft delete.** Undoable deletes require a `deletedAt` field on `activities`, filtered reads,
   and a purge cron. This is a schema change to a table that is also written by the Firestore sync.
   Confirm before building #11.

### Technical risks

| Risk                                                                      | Detail                                                                                                                                                                                                                                                                                                                                                                                                         | Mitigation                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Firestore sync silently destroys grid edits**                       | `sync/syncMutations.ts:248` patches every synced activity by `firestoreId` on `syncProposalTree`, triggered by `momentum.createProjectFromProposal` (`momentum.ts:2420`). Every field a Precision user edits on a legacy-origin proposal is overwritten — and every proposal in production is legacy-origin. The import UI's own stage label says _"Pulling estimate from Precision"_ while doing the opposite | **Blocking.** Decide the write authority before shipping editable columns. Either (a) mark legacy-origin proposals read-only in Precision until cutover, or (b) make the sync field-additive (never patch a field the user has touched, tracked via a `precisionDirtyFields` set), or (c) stop tree-syncing once a proposal is opened in Precision |
| **Convex per-function limits**                                            | `1734.LA` is 15,554 documents. `getExportData` and `getProposalSummary` `.collect()` all of them; the ceiling is 32,000 docs / 16 MiB. We are at ~48% on a real, current estimate, and `getExportData` is subscribed **on mount** at `$estimateId.index.tsx:82`                                                                                                                                                | WBS-scope or paginate `getEstimateGrid`; move `getExportData` behind an on-demand action; add a size guard that returns a typed "estimate too large for single query" result rather than throwing                                                                                                                                                  |
| **Optimistic-update divergence**                                          | If the client mirror of the rollup drifts from the server, numbers flicker and users stop trusting the app                                                                                                                                                                                                                                                                                                     | One shared cost-engine module (§3.5) + a dev-mode assertion that compares the optimistic value to the settled server value and logs on mismatch                                                                                                                                                                                                    |
| **Float noise in money**                                                  | Momentum already hit this (`#51` tags: round to 2dp so summed deltas don't surface `10.799999…`). Precision compounds it by rounding _intermediates_                                                                                                                                                                                                                                                           | Compute in full precision, round at the boundary, and use the same rounding rule in the optimistic path and the server path                                                                                                                                                                                                                        |
| **Virtualization + sticky group headers + keyboard nav is the hard part** | These three interact. The `rangeExtractor` must pin group rows; the keyboard hook must `scrollToIndex` before focusing; focus restoration must survive a Convex push that reorders rows                                                                                                                                                                                                                        | Build them together in one chunk with a synthetic 15,000-row fixture from the shape of `1734.LA`. Do not ship them separately                                                                                                                                                                                                                      |
| **Precision does not type-check**                                         | 27 app-level TS errors; `check-types` is literally `echo '...'` in `apps/precision/package.json`. `EditableCell` is already misused (`readOnly` passed without the required `onCommit` on 6 columns)                                                                                                                                                                                                           | Fix the errors and make `check-types` real **before** the grid grows. Otherwise the shared-package refactor lands on a codebase where the compiler cannot tell you what broke                                                                                                                                                                      |
| **No tests on the money**                                                 | Zero test files in `apps/precision` or `packages/features/src/estimation`. That is how the `rigProfitRate` bug shipped with a JSDoc claiming correctness                                                                                                                                                                                                                                                       | Cost-engine unit tests are chunk 1, not chunk 9. Include a golden-file reconciliation against a real legacy proposal's Data Dump export                                                                                                                                                                                                            |
| **MUI X Pro license key**                                                 | Legacy `App.tsx:29-35` synthesizes a Data Grid Pro license at runtime. Irrelevant to us technically — TanStack Table is MIT — but worth stating that none of this is being ported                                                                                                                                                                                                                              | n/a                                                                                                                                                                                                                                                                                                                                                |

---

## 6. SUGGESTED WORK BREAKDOWN

Ordered, each chunk independently shippable and independently valuable.

### Chunk 0 — Stop the bleeding (2 days)

- Fix `computeWelderLoadedRate` (`precision.ts:179-195`): add `weldBaseRate × rigProfitRate / 100`;
  delete the false JSDoc claim.
- Extract the cost engine to `packages/backend/convex/model/costEngine.ts` +
  `@truss/backend/cost-engine` export; move rounding to the boundary; write unit tests for all 7
  cost paths.
- Declare `@tanstack/react-table` in `packages/features` peerDeps and both apps' deps; promote
  `@tanstack/react-virtual` out of devDeps.
- Make `apps/precision`'s `check-types` real and drive the 27 errors to zero.
- Add `sonner` toasts to every mutation call site in the grid; make invalid numeric input show an
  error instead of vanishing.
- **Decide the sync/edit authority** (risk #1) and implement whichever guard is chosen.

### Chunk 1 — Grid primitives (4 days)

- `packages/features/src/grid/` with `GridCellInput` (merged), `useGridKeyboardNav` (state-based,
  full §3.2 contract minus range ops), `useGridSelection` (row model only for now).
- Repoint Precision's phase grid and Momentum's workbook at both. Delete
  `estimation/editable-cell.tsx` and `progress-tracking/entry-cell-input.tsx`.
- Fix the memo-defeat: stable `(id, field, value)` callbacks like Momentum's `stableOnCommit`.
- No behavior change visible to users except that Momentum gains ↑/↓ and Precision gains Home/End —
  this chunk is about deleting the divergence before it grows.

### Chunk 2 — Editable columns + the real write path (5 days)

- `applyActivityEdits` mutation (flat sparse patch, returns inverse) replacing per-field
  `updateActivity`.
- Precision column module: all 20 columns, the 6 per-type editable sets, `not-applicable` visual
  treatment, in-cell comboboxes for equipment `unit`/`ownership` with the price-reset side effects,
  auto column visibility from present types.
- Commit-on-exit + 120 ms coalescing.
- `withOptimisticUpdate` using the shared cost engine.
- Per-activity `craftBaseRate` / `subsistenceRate` columns.
- **Ship it.** At this point Precision is a usable estimating grid for the first time.

### Chunk 3 — Add/edit dialogs, unified (3 days)

- Promote `AddActivityDialog` (+ `PoolBrowser`, `SelectedItemCard`, `NumberInput`, `SubModeToggle`,
  `Disclosure`) to `packages/features/src/activities/`; add `initialType`, injected pools,
  `renderPreview`, `multiSelect`, `keepOpenAfterSubmit`.
- New plural `addActivities` mutation on both backends (one `maxSort` computation for N inserts).
- Promote `EditActivityDialog`, `AddPhaseDialog`, `EditPhaseDialog`. Wire `precision.updatePhase`
  (dead today).
- Delete Precision's 621-line and 221-line forks.

### Chunk 4 — Bulk operations (4 days)

- Range selection (Shift+arrows, Shift+Click, Cmd+A) in `useGridSelection`.
- `clipboard-grid.ts`; Cmd+C copy as TSV+HTML; Cmd+V paste with the validation preview dialog; Cmd+D
  fill-down.
- `useUndoStack` + soft delete + Cmd+Z/Cmd+Shift+Z.
- `BulkActionBar`: delete (with undo, not a confirm), duplicate selected, Reset Constants
  (server-side re-read from `laborPool` by `laborPoolId`), bulk rate override.
- Bulk retype **only if** the §5 decision says yes.

### Chunk 5 — Virtualization + the whole-estimate workbook (8–10 days)

- `<VirtualTableBody>` with fixed rows, padding spacers, and a group-pinning `rangeExtractor`;
  retrofit Momentum's workbook at the same time.
- `buildHierarchyRows()` promoted and generalized.
- New `precision.getEstimateGrid({proposalId, wbsId?, phaseId?})` modeled on
  `momentum.getBrowseData`, WBS-scoped by default with a document-count guard.
- The whole-estimate workbook route; demote the phase and WBS routes to scoped presets of it.
- Move `getExportData` off mount.
- Verify against a synthetic 15,554-row fixture shaped like `1734.LA`: target sub-16 ms
  keystroke-to-paint and sub-100 ms scroll frame budget with the profiler open.

### Chunk 6 — Ordering, preferences, polish (3 days)

- Fractional `sortOrder` with midpoint insertion; drag-to-reorder; Cmd+Shift+↑↓; A/B/…/AA positional
  gutter.
- Per-user column visibility persisted to the (currently orphaned) `proposalColumnPreferences`
  table.
- Copy-activities-from-phase UI over the dead `copyActivitiesToPhase`; cross-proposal variant.
- Constant-variance highlighting **with a legend**.
- Read-only mode by permission (client + `ctx.auth` on the mutations).
- Direct/indirect hours in the phase and WBS bottom panels (server-side, not client re-sum).

---

## Appendix — files this domain touches

**Precision (to change):**

- `apps/precision/src/routes/estimate/$estimateId.phase.$phaseId.tsx` (541)
- `apps/precision/src/routes/estimate/$estimateId.wbs.$wbsId.tsx` (351)
- `apps/precision/src/routes/estimate/$estimateId.index.tsx` (607) — the `getExportData` mount
  subscription
- `apps/precision/src/components/add-activity-dialog.tsx` (621) — **delete**
- `apps/precision/src/components/add-phase-dialog.tsx` (221) — **delete**

**Shared packages (to create / change):**

- `packages/features/src/estimation/editable-cell.tsx` (177) — **merge away**
- `packages/features/src/progress-tracking/entry-cell-input.tsx` (176) — **merge away**
- `packages/features/src/progress-tracking/workbook-table.tsx` (1,635) — source of `buildTree`,
  sticky groups, stable-callback pattern
- `packages/features/src/grid/**` — **new**
- `packages/features/src/activities/**` — **new**
- `packages/features/package.json` — new `./grid`, `./activities` exports; `@tanstack/react-table` +
  `@tanstack/react-virtual` as peerDeps

**Backend (to change):**

- `packages/backend/convex/precision.ts` — `computeActivityCosts` (143-311) extract;
  `updateActivity` (1432) replace; `addActivity` (1387) batch; `reorderActivities` (1475)
  fractional; `getActivitiesWithCosts` (711); new `getEstimateGrid`
- `packages/backend/convex/model/costEngine.ts` — **new**
- `packages/backend/convex/schema.ts` — `activities.deletedAt?`; `proposalColumnPreferences` wiring
- `packages/backend/convex/sync/syncMutations.ts:248` — the activity-overwrite guard

**Momentum (source of promotions):**

- `apps/momentum/src/components/add-activity-dialog.tsx` (1,001), `add-phase-dialog.tsx` (368),
  `edit-activity-dialog.tsx` (193), `edit-phase-dialog.tsx` (121)
- `apps/momentum/src/routes/project/$projectId.index.tsx:130-240` — the `withOptimisticUpdate`
  reference implementation
