# Precision — Plan of Record

**Replacing MCP Estimator with Precision, and unifying Momentum + Precision UI.**

Date: 2026-07-26 · Synthesized from 14 audit reports + live Convex (`focused-civet-250`) + source
re-verification. Read top to bottom.

---

## 0. READ THIS FIRST — three corrections to the audit record

Before any work is scheduled off these reports, three things must be struck, or you will ship a bug.

### 0.1 The "welder loaded rate bug" is not a bug. Do not fix it.

`precision-current.md` finding #1 and `gap-activity-grid.md` §2 item **#1** (marked "blocks other
work", i.e. scheduled first) both say `computeWelderLoadedRate` wrongly omits `rigProfitRate` from
the weld-base markup. **This is false and its remediation is harmful.**

I re-verified against source. `mcp_estimator/src/utils/calculations.ts` — the file both reports cite
— has **zero importers**. The live legacy engine is `mcp_estimator/src/api/totals.ts:41-71`, which
excludes `rigProfitRate` from the weld-base multiplier and applies it only to `rigRate`. Truss
`packages/backend/convex/precision.ts:179-195` is algebraically identical, and its JSDoc — which
`precision-current.md` calls "a lie" — is correct.

Executing that item overstates **every welder hour** by `weldBaseRate × rigProfitRate / 100`. On
live proposal `2020` (`weldBaseRate 40.7`, `rigProfitRate 10`) that is **+$4.07 per welder hour**
across the whole estimate.

**Action:** strike the item. Delete `mcp_estimator/src/utils/calculations.ts` from every reference
bundle handed to a future agent, and add a pointer in the `computeWelderLoadedRate` JSDoc saying the
dead duplicate exists and carries a different formula, so the next reader does not repeat this.

### 0.2 Production data corruption that no report found: `activity.wbsId` ≠ `phase.wbsId`

Legacy `copyActivitiesFromPhaseToPhaseInFirestore` (`src/newAPI/api.ts:236-245`) writes only
`phaseId` on a copied activity; `wbsId` is carried verbatim from the **source** activity. Copy a
phase's activities into a phase under a different WBS and the rows permanently claim the wrong WBS.
`sync/fieldMapping.ts:245` (`fsWbsId: str(fs.wbsId)`) imports the damage as-is.

**Measured live: 4 mismatched rows in a 34-proposal / 6,008-activity sample (proposal 2042).**
Unbounded across 713 proposals.

This matters more in Precision than it did in legacy, because Precision's rollups group by
_different keys_:

| Surface                      | Groups by            | File                     |
| ---------------------------- | -------------------- | ------------------------ |
| Phase drill-down             | `phaseId`            | `precision.ts:761-782`   |
| WBS table                    | **`activity.wbsId`** | `precision.ts:836-857`   |
| Bottom-panel direct/indirect | **`activity.wbsId`** | `precision.ts:924`       |
| Excel export                 | phase-nested         | `precision.ts:1655-1680` |

Four surfaces, three answers, no error raised. **Fix at the sync boundary (derive `wbsId` from the
phase at write time), add a repair migration, add an invariant assertion — before any parallel-run
validation.** Otherwise every reconciliation on an affected proposal chases a ghost.

### 0.3 Reference-material hygiene

- **Purge `work_log_items_library.txt` and `timesheet_*.txt`** from the reference set. The first
  self-describes as a phrase library for filling out billing timesheets and contains **invented**
  entries such as _"Fixed calculation error in welder loaded rate when rig profit rate was zero"_ —
  mining it hallucinates bugs that were never real, and that particular line sits suspiciously close
  to §0.1.
- **Do not purge the four root `*.sql` files.** `legacy-crosscutting.md:1067` dismisses them as
  "committed junk"; they are a prior design pass containing real product decisions nobody carried
  forward: `proposal_snapshots`, `proposal_status_history`, `audit_log`, per-activity `notes`,
  `custom_weld_rate`, `equipment_time_unit CHECK (hour|day|week|month)`. Triage them as a wish-list.
  **Trap:** `calculate_work_item_cost()` in `universal_supabase_schema.sql` is a _third_ cost
  formula with no authority. Never validate against it.
- `mcp_estimator/src/api/data_dump.ts` contains **five** export-vs-screen dollar divergences (labor
  markups on subcontractor rows at `:562`; custom subsistence leaking onto welder hours at `:573`;
  owned equipment dropping labor entirely at `:658`; owned equipment emitting a use-tax cell its own
  total ignores at `:586`; the dead-and-buggy `getSubProfit()` at `:539`). Precision inherits none
  of them — but anyone reconciling Precision against a legacy _export_ will read all five as
  Precision bugs. They belong in the test suite as **negative** cases.

---

## 1. CURRENT STATE

### 1.1 Where Precision actually is

**~35% of MCP Estimator's capability**, capability-weighted. The distribution is lopsided in a way
that matters for sequencing:

| Domain                                         | Parity   | Character of the gap                                                                                                              |
| ---------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Calculation formulas                           | **~90%** | 11 of 12 core formulas exact. Real divergences are rounding policy and zero-override semantics, not algebra.                      |
| Rollups (activity→phase→WBS→proposal)          | ~55%     | Levels correct and reactive. Missing: quantity/unit derivation, WBS completed, sub-hours, the 4 indirect buckets, WBS visibility. |
| Estimate lifecycle (list, create, info, rates) | ~60%     | Fields and screens exist; the _shape_ reproduces legacy's worst structural mistake.                                               |
| Pools / rate libraries                         | ~60%     | Data present and read correctly. Version model regressed 4-axis → 1 string. No authoring.                                         |
| Shell / navigation                             | ~85%     | Genuinely shared with Momentum. Four advertised shortcuts do nothing.                                                             |
| WBS & phase tier                               | ~30%     | Skeleton + server rollups real. Almost nothing editable. Two ordering rules wrong.                                                |
| Admin / permissions                            | ~40%     | Better model than legacy, hard-broken page, **zero** enforcement client _or_ server.                                              |
| Activity grid (the workhorse)                  | **~15%** | 12 of 20 columns, 2 of ~12 fields editable.                                                                                       |
| Export (the bid deliverable)                   | **~25%** | 13 of 37 columns, no component decomposition, no header block.                                                                    |
| Packaging / updater                            | ~30%     | CI already supports Precision. App is not wired.                                                                                  |

**The single most important reading of that table:** Precision is not 60%-done-needing-polish. The
engine is nearly right and almost nothing else is. **Most of the model cannot be edited at all** —
`updatePhase`, `addWBS`, `deleteWBS`, `copyActivitiesToPhase`, `reorderActivities`, `deleteProposal`
and `getWBSForProposal` are implemented, correct in shape, and called from nowhere (7 of 30 backend
functions, 23% dead). A typo in a phase description can only be fixed by deleting the phase, which
cascade-deletes every activity under it.

### 1.2 What is genuinely strong and must be protected

1. **Server-side compute-on-read.** No derived cost is persisted anywhere; `activities` has no cost
   columns. This designs out an entire class of legacy staleness bugs (`recalculatePhase` never
   refreshing WBS totals). **The bet holds. Do not add a cache.**
2. **One engine.** `getExportData` runs `computeActivityCosts`, the same function the screen uses.
   Legacy's export was a _second, divergent_ implementation and its Excel does not tie to its
   screen. Encode "one engine" as a hard invariant.
3. **A real proposal-level rollup** (`getProposalSummary`). Legacy never had one.
4. **A shared shell that already works.** Both apps mount the same `AppShell` from
   `@truss/features/desktop-shell`. Precision is the only consumer of `TreeNavItem`. The shell is
   not the problem.
5. Several things already beat legacy: atomic WBS seeding, click-through from WBS/phase rows, real
   URLs, checkbox multi-select, `copyActivitiesToPhase` correctly remapping `wbsId` from the target.

### 1.3 The facts that should shape every estimate

Measured live, not inferred:

| Fact                                                          | Value                                                                              | Consequence                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Production proposals                                          | **713**, all Firestore-synced, **0 native**                                        | Every ordering/schema bug is latent and fires on the first native estimate                                 |
| Largest estimate                                              | ~11,131–13,314 activities · 2,222 phases (two measurements disagree — reconcile)   | One `by_proposal` collect is ~68% of Convex's read ceiling; the overview subscribes **three** such queries |
| Median activities per phase                                   | **1** (p90 = 2, tail to 562)                                                       | The per-phase drill-down is the actual UX disease: 2,222 screens to touch one estimate                     |
| Activity type mix                                             | labor 73% + custom_labor 20% = **93%**                                             | Optimize throughput for labor lines first                                                                  |
| Proposals with `craftBaseRate = 0` **and** `weldBaseRate = 0` | **36 of 713**                                                                      | Both engines return $0.00 — choose validation proposals deliberately                                       |
| Duplicate `proposalNumber` values                             | **23 already exist**                                                               | The uniqueness guard cannot be applied without a cleanup pass                                              |
| Subcontractor rows carrying `labor`                           | **0 of 109**                                                                       | The engine/importer contradiction (§1.4) is latent, not live                                               |
| Pool rows                                                     | wbsPool 18 · phasePool 228 · laborPool ~5.9k v1 / ~6.0k v2 · equipmentPool 129/133 | Seeded **out-of-band** — no reproducible re-seed path exists in this repo                                  |

### 1.4 Live defects, ranked by dollar risk

1. **`activity.wbsId` corruption** (§0.2) — four surfaces disagree silently. _Live in prod._
2. **The sync clobbers user edits.** Reconcile the three reports to one sentence:
   _`syncMutations.ts:279` reverts proposal metadata and all 15 rates on a 6-hour cron; `:172` /
   `:207` / `:249` revert WBS, phase and **activity** edits whenever anyone creates a Momentum
   project from that proposal._ The activity-level clobber is the destructive one and only one
   report has it. Every proposal in production is legacy-origin, so this applies to all of them.
3. **Rounding policy divergence.** Three policies exist: legacy screen (unrounded), legacy export
   (unrounded math, `currencyRound` at output), Precision (`round2` on man-hours _before_ costing,
   `precision.ts:227-228`). Man-hours are a **displayed and reported** quantity, so Precision will
   show a different MH figure than legacy for any non-terminating `qty × constant`, independent of
   cost. Any parallel-run validation produces non-zero deltas that are not bugs.
4. **Open, unverified, un-domained signup over 713 real bids.** `auth.ts:99`
   `requireEmailVerification: false` + `autoSignIn: true`; `allowedDomains` is declared at
   `auth.ts:212` and **enforced nowhere**; nothing checks the Better Auth ban flag; `precision.ts`
   has **zero** `ctx.auth` calls in 30 functions; `proposals` has no `organizationId` and
   `listProposals` returns every proposal in the deployment to every user. The exposure is not "any
   authenticated client" — it is anyone on the internet who signs up.
5. **Engine/importer contradiction on subcontractor labor.** `precision.ts:243` deliberately
   computes welder cost for subcontractor rows (correct legacy behavior), but `fieldMapping.ts:203`
   writes `labor` only when `type !== "subcontractor"`, so it is always 0. Latent today; diverges
   silently the moment a UI lets a sub row carry a welder constant.
6. **`deleteProposal` can orphan a live Momentum project.** `momentumProjects.proposalId`
   (`schema.ts:568`) is never checked by the cascade at `precision.ts:591-627`. Convex has no
   referential integrity. Momentum is in heavy production use. `deleteProposal` is dead code today —
   **fix it now, while the blast radius is zero.**
7. **WBS ordering is wrong for every native estimate.** `wbsPool.sortOrder` is the array index of
   the legacy JSON, ordered lexicographically by stringified id, so a native estimate renders
   _MOBILIZE, INSULATION, PAINTING, DISMANTLING…_. Synced proposals are fine (`fieldMapping.ts:119`
   uses `wbsDatabaseId`). The two populations disagree.
8. **Phases order by insertion, not phase number**, and **phase numbers start at 1, not at the WBS
   code**. Phase numbers appear on the bid sheet and in every PM conversation.
9. **Neither app type-checks.** `check-types` is literally an `echo` in both. Precision has 27–28
   app-level TS errors (the two reports disagree by one; neither is reproduced here). The admin page
   reads `workspace?.organizationId` where the field is `organization_id`, so the members query is
   permanently `"skip"` and the page renders a skeleton forever.
10. **Every failure is `console.error`.** `sonner` is a declared dependency of `apps/precision` and
    is imported nowhere in `apps/precision/src`.
11. **`@tanstack/react-table` is declared only in the root `package.json` devDependencies** and is
    imported by both apps and `packages/features` for production runtime code. It resolves purely by
    bun hoisting.

---

## 2. STRATEGY VERDICT

> **Collin's question:** _"Do we just try to get it all in there and then fine tune, or should we
> take a step back and start working on one area at a time?"_

### Neither, exactly. **Foundation-first, then depth-first by workflow area, with breadth deferred to one explicit parity sweep before cutover.**

### Why not breadth-first ("get it all in there, then fine tune")

Breadth-first is the right call when the remaining work is mostly _filling in_ and the foundations
are settled. Neither is true here.

1. **The gap is editability, not coverage.** Stubbing broadly means shipping a dozen surfaces that
   all lie — a phase grid with 23 columns you cannot edit, an Add menu that discards your choice, a
   Custom Labor tab whose helper text is false. Precision already has three of those and each one
   teaches distrust. Adding nine more makes it worse, faster.
2. **It maximizes rework on exactly the work you care most about.** You iterate on design and are
   exacting about polish. Every stub gets touched twice, and the second pass is the design-heavy
   one. The stated constraint — _sequencing should avoid re-doing polished work_ — is a direct
   argument against it.
3. **Four foundations get monotonically more expensive with surface count**, and three of them are
   invisible from the UI: the cost engine + its tests, the sync write-authority decision, the schema
   decisions (`datasetVersion` shape, `wbsId` invariant, `sortOrder`, soft delete), and the shared
   grid/cell primitives. Land them after three polished areas and you re-do three polished areas.
4. **A wrong number is worse than a missing feature**, and the audit itself proves how easy it is to
   get one. §0.1 is a "fix" that would have been scheduled first and would have inflated every
   welder hour in the company's bids. Breadth-first spreads that risk across a dozen surfaces at
   once.

### Why not pure depth-first either

Pure depth-first — take one area to finished quality, then the next — walks into the same trap from
the other side. If you polish the estimate-detail screen to Linear grade _before_ settling the sync
write-authority question, a cron silently reverts everything the user types into it within 6 hours,
and you've polished a screen that does not work. If you build the activity grid's 20 editable
columns before extracting `GridCellInput`, you have two hand-rolled focus/commit state machines
drifting apart across two apps, one of which is in production.

### The actual shape

```
M0–M1   FOUNDATION      correctness, data integrity, write authority, typecheck, auth close
        (~6 days)       no new features. Nothing above this line is safe to build on.
           ↓
M2–M6   DEPTH-FIRST     one workflow area at a time, each to finished quality,
        (~6 weeks)      each promoting shared UI as the mechanism (not as a side quest)
           ↓
M7      THE BIG BET     whole-estimate workbook (gated on one decision)
        (~3 weeks)
           ↓
M8–M9   THE TAIL        hierarchy control, quantity/unit, the 37-column bid deliverable
        (~3 weeks)
           ↓
M10–M11 CUTOVER         authz + multi-tenancy, breadth parity sweep, migration, hard switch
        (~4 weeks)
```

Three rules make this work:

**Rule 1 — Depth order follows _user workflow frequency_, not _code size_.** Order: fix-a-mistake →
enter-activities → set-rates → find-an-estimate. That is the order an estimator hits friction in,
and it front-loads the two screens you named as the ones you hate.

**Rule 2 — Every shared-UI promotion is a milestone deliverable, never a refactor sprint.** The
promotion _is_ the bug fix: adopting Momentum's `add-activity-dialog` is how Precision gets keyboard
catalog search, validation, toasts and a live preview. Doing it as separate "refactor" work is how
it gets deprioritized forever.

**Rule 3 — Breadth happens exactly once, at M11, against the merged parity checklist.** By then the
structure exists, so the tail items (the 5 remaining phase-grid columns, the search field list, the
window-position persistence) are cheap. Doing them early is what makes them expensive.

### What this buys you at each stage

Because Precision cannot replace the estimator until it has full parity — there is a hard cutover
with a one-time migration — Precision does **not** need to be production-ready early. That is
liberating: it means you can optimize the sequence for _correctness and reusable structure_ rather
than feature count, and it means every milestone can be judged by "can Collin open this and use it
on real data," not "can InDemand run on this." Dogfooding on real read-mostly data from M2 onward is
the only reliable way to surface the parity gaps these audits missed.

---

## 3. THE SHARED-UI PROGRAM

Sharing UI between Momentum and Precision is a first-class goal. It is also the highest-risk
activity in this roadmap, because **Momentum is fully released and in heavy production use at
InDemand**. The program below is designed so that a shared-component regression cannot reach
Momentum users.

### 3.1 The safety contract — non-negotiable

1. **Promote, don't generalize-then-adopt.** _Move_ Momentum's file into `packages/`, have Momentum
   import it from the new location **in the same commit**, verify Momentum, then adopt in Precision
   as a second commit. Never write a new "generic" component and migrate both.
2. **Momentum is always the first consumer.** If a promotion cannot ship with Momentum unchanged in
   behavior, it is not ready.
3. **Preserve the caller's props at the seam.** For the riskiest merges (the grid cell), keep
   `EntryCellInput` as a thin wrapper over the new `GridCellInput` with its exact current prop
   shape. Momentum's diff is then a one-line import change, provably behavior-preserving.
4. **No promotion lands before `check-types` is real** (M0). A shared-package refactor on a codebase
   where the compiler cannot tell you what broke is not a refactor, it is a gamble.
5. **Precision's forks get deleted in the adopting commit**, not "later". Two implementations is the
   state we are escaping.

### 3.2 Where things live

```
packages/ui/components/          leaf primitives, zero domain knowledge
    number-input, form-dialog, (existing 36)
packages/features/src/shared/    app-agnostic, domain-free
    forms/ (useFieldAutosave, SaveStateIndicator, SettingsSection, DangerZone)
    lists/ (EntityListRow, EntityCard, EntitySwitcher, use-entity-recents)
    skeletons.tsx, download.ts, async-job-panel.tsx, confirm-destructive-dialog.tsx
packages/features/src/grid/      NEW — the grid substrate for both apps
    GridCellInput, useGridKeyboardNav, useGridSelection, VirtualTableBody,
    buildHierarchyRows, useUndoStack, clipboard-grid.ts, BulkActionBar
packages/features/src/activities/ NEW — the estimating/tracking dialogs
    AddActivityDialog, EditActivityDialog, AddPhaseDialog, EditPhaseDialog,
    PhasePickerDialog, PoolBrowser, SelectedItemCard, SubModeToggle, Disclosure
packages/features/src/estimation/ Precision-domain shared (currently near-empty: 4 files)
    types.ts, RateEditor, LoadedRateBreakdown, ScopeTotalsBar, ordering.ts
packages/features/src/admin/     AdminMembersPage, AdminMemberDetail (currently types.ts only)
packages/features/src/updater/   NEW — UpdateProvider, UpdateChecker
packages/backend/convex/model/   costEngine.ts, ordering.ts (server-shared)
```

### 3.3 The ordered promotion list

Dependency-ordered. Each row names the milestone it ships in.

| #   | Component                                                                                                             | Source → Home                                                                                | Cost                               | Milestone | Momentum risk                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `isWorkspaceAdmin`                                                                                                    | `momentum/lib/permissions.ts` (21 LOC) → `features/organizations/permissions`                | 15 min                             | M0        | none                                                                                                                                                  |
| 2   | `NumberInput`                                                                                                         | `momentum/add-activity-dialog.tsx:890-907` → `@truss/ui`                                     | 2 h                                | M2        | none                                                                                                                                                  |
| 3   | `TableSkeleton`/`ListSkeleton`/`FormSkeleton`                                                                         | `momentum/components/skeletons.tsx` (114) → `features/shared`                                | 0.25 d                             | M2        | none                                                                                                                                                  |
| 4   | `FormDialog` shell                                                                                                    | Momentum's newer dialog idiom → `@truss/ui`                                                  | 0.5 d                              | M2        | low                                                                                                                                                   |
| 5   | `ConfirmDestructiveDialog`                                                                                            | Momentum's AlertDialog pattern → `features/shared`                                           | 2 h                                | M2        | none                                                                                                                                                  |
| 6   | `AsyncJobPanel`                                                                                                       | `create-project-dialog.tsx:98-221` → `features/shared`                                       | 0.5 d                              | M2        | low                                                                                                                                                   |
| 7   | `UpdateProvider` + `UpdateChecker`                                                                                    | `momentum/update-checker.tsx` + `lib/update-context.tsx` (494) → `features/updater`          | 2 h                                | M2        | low — `appName` prop is the only change                                                                                                               |
| 8   | `AdminMembersPage` + `AdminMemberDetail`                                                                              | `momentum/routes/admin/*` → `features/admin`                                                 | 1 d                                | M2        | **medium** — same Convex fns, one `app` prop; deletes Precision's broken fork rather than repairing it                                                |
| 9   | `EntitySwitcher`                                                                                                      | `progress-tracking/project-switcher.tsx` (245) → `features/shared/lists`                     | 0.5 d                              | M2        | low                                                                                                                                                   |
| 10  | `ordering.ts` comparators                                                                                             | `momentum.ts:299-318` → `convex/model/ordering.ts` + client mirror                           | 0.25 d                             | M2        | **medium** — Momentum's workbook ordering depends on it; move, don't rewrite                                                                          |
| 11  | `AddActivityDialog` + `PoolBrowser`, `SelectedItemCard`, `SubModeToggle`, `Disclosure`, `PriceField`, `ConstantField` | `momentum/add-activity-dialog.tsx` (1,001) → `features/activities`                           | 1.5 d                              | M3        | **high** — the most-used dialog in a live app. Props: injected pools, `initialType`, `renderPreview`, `multiSelect`, `keepOpenAfterSubmit`            |
| 12  | `AddPhaseDialog`, `EditPhaseDialog`, `EditActivityDialog`                                                             | `momentum/components/*` (368/121/193) → `features/activities`                                | 1 d                                | M3        | medium                                                                                                                                                |
| 13  | `GridCellInput`                                                                                                       | merge `estimation/editable-cell.tsx` (177) + `progress-tracking/entry-cell-input.tsx` (176)  | 0.5 d                              | M4        | **highest** — two hand-rolled focus/commit state machines, identical `DEBOUNCE_MS = 350`. Ship as a wrapper first (§3.1 rule 3)                       |
| 14  | `useGridKeyboardNav`                                                                                                  | replaces `workbook-table.tsx:602-626` + `$estimateId.phase.$phaseId.tsx:136-145`             | 2 d                                | M4        | **high** — state-based `{rowId, columnId, mode}`; both current impls are DOM-query based and **break the instant virtualization lands**               |
| 15  | `useGridSelection` (row + range)                                                                                      | net-new                                                                                      | 1.5 d                              | M4        | low                                                                                                                                                   |
| 16  | `SettingsSection` + `DangerZone`                                                                                      | `momentum/routes/project/$projectId.settings.tsx:189-333` → `features/shared/forms`          | 1 d incl. Momentum migration       | M5        | medium                                                                                                                                                |
| 17  | `useFieldAutosave` + `SaveStateIndicator`                                                                             | the correct halves of #13's two sources + Momentum's `beforeunload` blur guard               | 1 d                                | M5        | low                                                                                                                                                   |
| 18  | `RateEditor` + `LoadedRateBreakdown`                                                                                  | **new, built shared from day one**                                                           | 2 d                                | M5        | none — Momentum gains a read-only "Rates (snapshot)" card it has nowhere to show today (`momentum.ts:2333` freezes rates at import)                   |
| 19  | `EntityListRow`/`EntityCard`/`ENTITY_LIST_GRID_COLS`                                                                  | `progress-tracking/project-{list-row,card,display-utils}` → `features/shared/lists`          | 1 d incl. Momentum regression pass | M6        | **high** — Momentum's landing screen. Pluggable metric slot: Momentum `% + MH`, Precision `$ + due`                                                   |
| 20  | Recents + pins storage                                                                                                | mirror of `momentumRecentViews`/`momentumPinnedProjects` (`momentum.ts:4606-4700`)           | 0.5 d per-app / 1.5 d generic      | M6        | depends on decision D12                                                                                                                               |
| 21  | `VirtualTableBody` + `buildHierarchyRows`                                                                             | net-new wrapper + promote `workbook-table.tsx:252-462`                                       | 3 d                                | M7        | **highest** — retrofits Momentum's production workbook onto a virtualizer. Do it with a synthetic 15k-row fixture and a full Momentum regression pass |
| 22  | `useUndoStack`, `clipboard-grid.ts`, `BulkActionBar`                                                                  | net-new                                                                                      | 2 d                                | M7        | low — Momentum gains capabilities it lacks                                                                                                            |
| 23  | `ScopeTotalsBar`                                                                                                      | generalize `estimation/bottom-panel.tsx` (262) + `progress-tracking/status-slices.tsx` (359) | 1 d                                | M8        | medium — share the chrome (collapse, persistence, scope label), keep the metric renderer pluggable                                                    |
| 24  | `exportWorkbook()` download/save helper                                                                               | both apps' blob code → `features/shared/download.ts`                                         | 2 h                                | M9        | none — this is where the Tauri native save dialog goes                                                                                                |

**Explicitly NOT shared:**

- **One `<DataGrid>` for both apps.** Share the shell and every primitive; keep two thin
  column-definition modules. Precision needs ~20 typed columns with 6 per-type editable sets;
  Momentum needs one MH entry cell with a note popover and a max clamp. A `mode: "tree" | "flat"`
  component with two column dialects and two cell dialects is harder to change than two files.
- **The two Excel exporters.** A 37-column bid report and a progress-tracking sheet share nothing
  but download boilerplate (#24).
- **The two list _pages_.** Share the row and the card, not the route.

### 3.4 Dead code to delete as part of the program

`packages/features/src/settings/**` (7 files, ~950 LOC, zero importers, no package export path, and
it re-implements theme switching against a _different_ localStorage key than `ThemeProvider` — they
would fight if it were ever mounted) · `progress-tracking/wbs-card.tsx` (120, zero importers, only
consumer of `StatusBadge`) · `@truss/ui` `menubar`/`context-menu`/`form` (623 LOC, zero importers) ·
`packages/ui/src/components/index.ts` barrel (zero importers) · the dead `SidebarConfig` /
`FeatureFlags` / `LayoutMode` keys · the density system (`density.css`, 185 lines,
`var(--density-*)` has zero consumers) · the fake `StatusBar` sync indicator
(`useState({state:"idle"})` with no setter — misleading, not merely dead). Also hoist the two
byte-identical `styles.css` files (~250 lines each, differing only in comments) into
`@truss/ui/styles`.

---

## 4. MILESTONES

Every milestone is independently shippable and ends in something you can open and use. Sizes: **S**
≤ 1 week · **M** 1–2 weeks · **L** 2–4 weeks · **XL** 4+ weeks.

---

### M0 — Ground truth: correct numbers, correct types, closed door · **S** (~4 days)

**Goal:** make it impossible for the next three months of work to be built on a wrong number, a
wrong type, or an open front door.

**Depends on:** nothing.

Contents:

- Strike the `rigProfitRate` "fix" (§0.1). Amend `gap-activity-grid.md`. Delete
  `mcp_estimator/src/utils/calculations.ts` from the reference bundle. Add the warning pointer to
  the `computeWelderLoadedRate` JSDoc.
- **Extract the cost engine** to `packages/backend/convex/model/costEngine.ts`, typed over a plain
  `ActivityInput` rather than `Doc<"activities">`, exported as `@truss/backend/cost-engine`. Every
  Convex query imports it; it becomes unit-testable in plain Node. This is the prerequisite for
  optimistic updates, paste preview, and any reconciliation harness — and a _second client copy_ is
  precisely how legacy's `calculations.ts` drifted from `totals.ts`.
- **Golden-number test suite**: 6 activity types × both equipment ownership branches × override
  cases, asserted against outputs captured from 3–5 real legacy proposals. **Choose the proposals
  deliberately** — avoid the 36 with `craftBaseRate = weldBaseRate = 0`, and avoid `1734`
  (`rigRate`, `fuelRate`, `consumablesRate`, `weldBaseRate` all 0, so it exercises almost no markup
  path despite being the biggest estimate). Include the five `data_dump.ts` export divergences as
  **negative** cases (§0.3).
- **Settle and implement the rounding policy** (D2): compute in full precision, round only at the
  display/accumulator boundary, including man-hours. Stamp `calcVersion` on the proposal so a future
  formula correction never silently re-prices historical bids.
- **Repair `activity.wbsId`** (§0.2): derive from the phase at write time in `mapActivity` /
  `syncMutations`, run a repair migration across all 713 proposals, add an invariant assertion.
- **Guard `deleteProposal` against `momentumProjects.proposalId`** before the delete UI ever ships.
- **Close the signup hole**: `requireEmailVerification: true`, enforce the declared `allowedDomains`
  (currently declared at `auth.ts:212` and enforced nowhere), block banned/disabled accounts at
  session create and terminate their sessions.
- **Real `check-types`** (`tsc --noEmit`) + `eslint.config.mjs` in **both** apps, wired into CI.
  Drive Precision to 0 app-level errors — including `workspace?.organizationId` → `organization_id`
  and the stale admin member shape (`banned`→`isBanned`, `role`→`orgRole`,
  `precisionPermission`→`appPermissions.precision`).
- Declare `@tanstack/react-table` as a peerDep of `@truss/features` and a dep of both apps; move
  `@tanstack/react-virtual` out of devDependencies.
- Add `sonner` toasts to every mutation call site in Precision (~8 `console.error` sites). Make
  invalid numeric input show an error instead of silently vanishing.
- Promote `isWorkspaceAdmin` (#1).

**Ships:** the admin page loads. Nothing type-errors. Every number in Precision is provably equal to
the live legacy engine on a golden set. Nobody outside the company can sign up. **You can open
Precision and trust what it says.**

---

### M1 — Write authority: make edits durable · **S** (~2 days)

**Goal:** stop the sync from destroying user work. Everything downstream is theater until this
lands.

**Depends on:** M0 (typecheck).

Contents:

- Implement the record-ownership model (decision D1). Recommended: **both halves** — (a)
  legacy-origin proposals render **read-only** in Precision with a "Managed by MCP Estimator"
  banner, and (b) an admin **"Take ownership"** action sets `syncPolicy: "precision-owned"`, after
  which the sync skips that record entirely.
- Fix **all four** clobber sites, not just the proposals one: `syncMutations.ts:279` (proposals +
  all 15 rates, 6-hour cron) **and** `:172` / `:207` / `:249` (WBS / phase / **activity**, fires
  whenever anyone creates a Momentum project from that proposal). The activity-level clobber is the
  destructive one.
- Resolve the engine/importer contradiction on subcontractor labor (§1.4 #5): either map the
  constants in `fieldMapping.ts:203` or delete the Step-4 comment and suppress welder on sub rows
  deliberately. Pick one and document it.

**Ships:** what you type in Precision stays typed. Legacy-origin estimates are honestly labelled.

---

### M2 — Sibling app: shared chrome, correct hierarchy, self-update · **M** (~1.5 weeks)

**Goal:** Precision stops being a stale fork of Momentum and starts being its sibling. Fix the two
ordering rules that are wrong for every native estimate, and make it possible to tell where you are.

**Depends on:** M0.

Contents:

- **Shared-UI promotions #2–#10**: `NumberInput`, skeletons, `FormDialog`,
  `ConfirmDestructiveDialog`, `AsyncJobPanel`, `UpdateProvider`/`UpdateChecker`,
  `AdminMembersPage`/`Detail`, `EntitySwitcher`, `ordering.ts`. Momentum is first consumer on each.
  Delete Precision's admin fork and `estimate-switcher.tsx`.
- **Tauri updater wiring**: `tauri-plugin-updater` + `tauri-plugin-process` in `Cargo.toml`, the
  `plugins.updater` block (pubkey + `.../updates/precision/latest.json` + `installMode: passive`),
  `bundle.createUpdaterArtifacts: true`, the two capability strings. The JS packages are _already_
  dependencies; CI (`release-desktop.yml`) already triggers on `precision-v*`. Dry-run a
  `precision-v0.1.1-beta` tag. **Do this before the first internal build goes out** — the first
  build without an updater is one you have to chase people down to replace.
- **Ordering & identity:** migrate `wbsPool.sortOrder = poolId` (18 rows), change
  `createProposal:511` to write `sortOrder: poolItem.poolId`, sort phases by `phaseNumber` in
  `getPhaseListWithCosts` and `getWBSWithPhasesForNav`, and **also sort client-side** as defence in
  depth — Momentum learned this the hard way (`workbook-table.tsx:283-295`, tagged `#36`) and
  Precision has no such safety net.
- Return `name` + `wbsPoolId` from `getPhaseListWithCosts`; render the WBS **code** everywhere a WBS
  appears (`70000 · AG PIPING`); full breadcrumb `proposal › WBS › phase` hoisted into the shared
  `AppBar`. Today the deepest screen's breadcrumb is literally `#1744 › Phase` — a **regression
  against the app we are replacing**.
- Fix or delete the four dead shortcuts (`toggle-sidebar`, `open-estimate-switcher`,
  `export-estimate` dispatch `CustomEvent`s with zero listeners; `⌘P` is a decorative label; `⌘N`
  races the route mount). Advertised-but-dead shortcuts train users not to trust the layer.
- Register every WBS and phase as a command-palette entry from `shell-config-estimate.ts` — the
  cheapest possible fix for "navigating a large tree", and it removes the need for a second search
  box.
- Delete the dead code in §3.4; hoist the duplicated `styles.css`; move Precision to the macOS named
  type scale and semantic color tokens (its `bg-amber-100` chips render as light blobs in dark
  mode).

**Ships:** Precision self-updates, has a working admin page, shows WBS in an order an estimator
recognizes, and tells you where you are. It looks and feels like Momentum.

---

### M3 — Fix-a-mistake: the tier becomes editable · **M** (~1.5 weeks)

**Goal:** the single biggest day-to-day friction. Today a typo in a phase description can only be
fixed by deleting the phase, which cascade-deletes every activity under it.

**Depends on:** M1 (edits must be durable), M2 (`FormDialog`, `ConfirmDestructiveDialog`).

Contents:

- **Promotions #11–#12**: `AddActivityDialog` (+ `PoolBrowser`, `SelectedItemCard`, `SubModeToggle`,
  `Disclosure`, `PriceField`, `ConstantField`), `AddPhaseDialog`, `EditPhaseDialog`,
  `EditActivityDialog` → `packages/features/src/activities/`. **This is the goal you named.**
  Payload shapes are already byte-identical (`momentum.ts:3532` vs `precision.ts:1387`). Delete
  Precision's 621-line and 221-line forks — net **−842 LOC** — and gain cmdk catalog search with
  ↵-select, per-type validation, ⌘↵ submit, focus management, toasts, and a live preview.
- `initialType` prop, which fixes the Add ▾ dropdown that currently discards your choice (all six
  items call `setAddOpen(true)` with no argument; picking "Material" opens the Labor tab).
- `multiSelect` + `keepOpenAfterSubmit` + a plural `addActivities` mutation on **both** backends.
  Labor + custom_labor is 93% of all rows; this is the throughput path. It also fixes an N-reads
  problem: `addActivity:1406` does a full `.collect()` of the phase per insert, so 30 adds = 30
  collects.
- **Wire `updatePhase`** (dead today): inline-editable phase number, description, area, sheet,
  status, plus an `EditPhaseDialog` for the 6 `pipingSpec` fields.
- Server-side `suggestPhaseNumber({wbsId, phasePoolId})` implementing the real business rule (gated
  on D5). Today `add-phase-dialog.tsx:60-67` computes `max+1` in a `useEffect` — it starts at 1
  instead of the WBS code, and it **races**: the query resolving after you type clobbers what you
  typed.
- Toggle `isCompleted` from the grid; roll `completed` up to the WBS.
- `ConfirmDestructiveDialog` with real counts on every destructive action ("Delete 4 phases and 137
  activities?"); replace the client `for`-loop of awaits with one `batchDeletePhases` mutation; make
  Duplicate act on the whole selection instead of `[...selected][0]`.

**Ships:** you can fix a mistake without destroying work. Adding 30 labor lines stops being 30
open/search/click/type/submit cycles.

---

### M4 — The activity grid becomes a real grid · **L** (~2.5 weeks)

**Goal:** Precision stops being a demo. This is where it becomes a tool an estimator would choose.

**Depends on:** M3 (dialogs promoted), M0 (cost engine extracted — optimistic updates need it).

Contents:

- **Promotions #13–#15**: `GridCellInput` (merge the two 350ms state machines — ship as a wrapper
  first per §3.1 rule 3), `useGridKeyboardNav` (state-based `{rowId, columnId, mode}`),
  `useGridSelection` (row model now, range model in M7). Retrofit Momentum's workbook in the same PR
  with a full regression pass. **Do this before Precision's grid grows past 2 editable columns.**
- Implement the **full Excel keyboard contract** — the legacy `excel_navigation_data_grid.tsx` (816
  lines) is the best asset in the old repo and estimators are trained on it: F2, type-to-replace,
  Enter/Shift+Enter down/up skipping non-editables, Tab/Shift+Tab with wrap, Escape discards,
  Backspace clears-and-edits, Delete clears-and-commits, click-away commits without stealing focus,
  focus survives an async re-sort. Plus the net-new: Home/End, ⌘Home/⌘End, ⌘-arrow block jumps. **Do
  not port the mechanism** — both apps currently use `querySelectorAll`, which breaks the instant
  virtualization lands.
- **`applyActivityEdits`** batch mutation: flat sparse patch (`quantity?`, `craftConstant?`,
  `equipmentOwnership?`, `subLaborCost?`, …) that the server merges into the nested
  `labor`/`equipment`/`subcontractor` objects and **returns the prior values**. That return value
  _is_ the undo entry. This one mutation serves single-cell edit, fill-down, paste, bulk retype,
  reset constants and bulk rate override. It replaces `updateActivity`'s whole-object validators,
  which force a client read-modify-write with a lost-update race. Use
  `v.union(v.number(), v.null())` on rate overrides so "clear the override" is explicit.
- **All 20 columns with 6 per-type editable sets** and a `not-applicable` visual treatment. In-cell
  comboboxes (never free-text) for equipment `ownership` and `unit`, with the unit↔price binding
  (`Hours→hourRate`, …) and the ownership↔unit coupling (`Purchase↔EA`, `Owned|Rental↔Months`). Auto
  column visibility driven by which activity types are present — **port layer 1 only**; legacy's
  per-WBS baseline table is provably inert (`model[field] = false || condition`).
- **Commit on cell exit**, not on a typing debounce (350ms idle is right for Momentum's one-number-
  per-cell model and wrong for an estimator tabbing across 8 columns in 3 seconds). Coalesce commits
  inside a 120ms window into one `applyActivityEdits`. **Never await before advancing the cursor** —
  legacy's worst perf sin is one awaited round-trip per cell.
- **Optimistic updates** via `withOptimisticUpdate` running the _same_ `costEngine` function as the
  server (Momentum proves the pattern at `$projectId.index.tsx:130-240`), plus a dev-mode assertion
  comparing the optimistic value to the settled server value.
- Fix the memo-defeat: cell renderers pass a fresh inline arrow every render, so `EditableCell`'s
  `React.memo` never short-circuits and every Convex push re-renders every cell. Momentum solved
  this with `stableOnCommit` refs.
- **Per-activity rate overrides** (`craftBaseRate` / `subsistenceRate` columns) — computed by
  `computeCraftLoadedRate`, stored in the schema, populated by the sync, and settable by **nothing**
  today. Note the semantic decision D3 (`??` vs `||` on a stored `0`) becomes live the moment this
  ships. Gated on D6 for the eligibility rule.
- "Reset Constants" as a server-side re-read of `laborPool` by `(datasetVersion, laborPoolId)` —
  _not_ legacy's null-out, because Precision has no embedded snapshot. Consider adding
  `labor.sourceValues` + `labor.sourceVersion` so reset is deterministic and the grid can
  distinguish "catalog value" from "someone typed the same number".
- Direct/indirect hours in the phase and WBS bottom panels (server-side, not the current client
  re-sum).
- `beforeunload` blur-to-commit guard (Momentum has it; Precision loses debounced edits on quit).

**Ships:** a usable estimating grid, for the first time. Every field an estimator needs to change is
changeable, with Excel muscle memory, and the cursor never waits on the network.

---

### M5 — The two screens you named: rates workbench + estimate settings · **M** (~2 weeks)

**Goal:** directly answer _"I hate the way that the proposal information and everything is entered
on the home screen."_

**Depends on:** M1 (rates edits must be durable), M0 (engine extracted — `previewProposalTotals`
reuses it), M2 (`SettingsSection` source available).

The structural diagnosis: legacy treated **proposal metadata** (22 reference fields, entered at
intake, affects zero dollars) and **the 15 rates** (the pricing model; every dollar is a pure
function of them) as the same kind of object — two tabs sharing one `isEditMode` and one Save
handler, so saving Rates also wrote Details. Precision inherited the _shape_ (Details / Rates / WBS,
defaulting to Details) and dropped the shared-Save bug but kept the real error: **the estimate is
the third tab.**

Contents:

- **Route split:**
  - `/estimate/$id` — **Overview, the money.** Never a form. Headline total + total MH,
    direct/indirect split, cost by category, the WBS rollup table that is currently the third tab,
    status/due chips, a rate-health banner, quick actions. The only input is the status control.
  - `/estimate/$id/rates` — the workbench.
  - `/estimate/$id/settings` — the 22 metadata fields + danger zone.
  - Sidebar gains Overview / Rates / Settings above the Work Breakdown tree, with `⌘1` / `⌘2` /
    `⌘,`.
- **Rates workbench** (#18): left = the 15 fields in the existing 4 `RATE_FIELD_CONFIG` groups with
  controlled state + resync (today `RatesGrid` holds `useState(rates)` with **uncontrolled
  `defaultValue` inputs and no resync effect**, so it displays and writes stale numbers when the
  server changes underneath). Right, sticky = **consequence**, the thing neither app has ever had:
  - **Craft loaded rate with its build-up**
    (`Craft base $48.00 / + Burden 32% $15.36 / … / = $87.84 per MH`) and welder loaded rate with
    the same build-up plus the two rig legs.
  - Non-labor multipliers named: Material `×1.0925`, Equipment rental/purchase `×1.1450`, Equipment
    owned `×1.0000 — no profit, no use tax`, subcontractor legs.
  - **`previewProposalTotals(proposalId, candidateRates)`** — cheap _precisely because of the
    architecture bet_: `computeActivityCosts(activity, rates)` is already pure over the rates
    object, so previewing is the same scan with a different second argument.
    `Total: $1,241,880 → $1,317,414 (+6.1%)`.
  - **Explicit Apply**, deliberately unlike metadata: rates re-price the whole bid, so a debounced
    silent write is the wrong default. `updateProposalRates` returns the previous rates and the
    success toast carries **Undo**.
  - Read-only lock when `status ∈ {submitted, awarded}` with an explicit unlock (gated on D9).
- **Rate templates** (`rateTemplates` table + apply / save-as / `copyRatesFromProposal`) with a
  provenance line ("Rates from Company Default 2026, applied 12 Mar · 2 fields overridden").
  `DEFAULT_RATES` is **fifteen zeros**, so today a brand-new estimate prices at $0.00 with no
  warning — the single biggest first-run failure in the product. **Explicitly reject live
  inheritance**: snapshot on apply, show drift (Momentum already does this deliberately at
  `momentum.ts:2331-2334`).
- **Settings route** (#16, #17): the 22 fields in five groups ordered by _when the information
  arrives_ — Identification, Intake, Job Site, Contact, Advanced — plus a Danger Zone wiring the
  dead `deleteProposal` behind a typed confirm naming the cascade ("18 WBS, 42 phases, 1,207
  activities"). **Section-scoped explicit save for v1** (`⌘S` saves the focused section, `Esc`
  reverts): one afternoon of work that _eliminates_ the lossy-debounce bug class rather than
  papering over it. Only move to per-field autosave once `useFieldAutosave` exists — the current
  code is what happens when you try it the other way.
- Non-negotiable field rules, all legacy defects rather than preferences: ZIP is **text** (`07030`
  became `7030`), State is a 2-letter code (legacy stored `"California"`, unjoinable), Email is
  never uppercased (legacy rendered `JOHN@ACME.COM`), Phone stores 10 digits and displays formatted,
  `proposalNumber` stays a **string** (legacy `parseInt` collapsed `1300.1`→`1300` on every save),
  Estimators become chips over an org-member picker (today a comma in a name splits one person into
  two), description uppercased **on write** not on render.
- Contacts: the 7 legacy fields (gated on D10). Note the `contacts` table is a **read-nothing/
  write-nothing dead end** — one reference outside the schema (`precision.ts:542`), no join in
  `getProposal`, no create mutation — so the entity branch needs three mutations and a join query
  that do not exist. The "S (inline) / L (entity)" estimate understates the entity branch.
- **Fix the shared `debounceRef`** (`$estimateId.index.tsx:90-102`): every `patchField` call does
  `clearTimeout(debounceRef.current)`, so blurring "Job #" and then "CO #" within 400 ms **cancels
  the Job # write permanently**, with no dirty marker, no spinner, no error toast.

**Ships:** the estimate opens on its money. The 15 rates finally show what they do. Nothing you type
disappears.

---

### M6 — Find an estimate: landing screen + lifecycle · **M** (~1.5 weeks)

**Goal:** the other screen you named. Port Momentum's list, not the legacy dashboard.

**Depends on:** M2 (`EntitySwitcher`), M5 (settings route for the danger zone).

Precision's `estimates.tsx` is a near-literal port of legacy `proposal_select.tsx` — the same
`80px 1fr 160px 100px 80px` grid template, the same five columns, the same `MM/dd` dates with no
year, the same hardcoded sort with no control, the same non-focusable `<div onClick>` rows, and the
same **zero dollars anywhere on the landing screen of an estimating app**. Momentum's `projects.tsx`
already solved this screen.

Contents:

- **Promotions #19–#20**: `EntityListRow`/`EntityCard` with a pluggable metric slot, recents + pins.
  Real `<Link>` rows — focusable, `↑`/`↓` navigable, `↵` to open, ⌘-click to open elsewhere, `/` to
  focus search.
- Columns an estimator cares about: `#`, Description, Owner, **Total $**, **Total MH**, Estimator,
  Status, Due (**with year**), Modified. Dollars via a separate `getProposalTotals(proposalIds[])`
  called for visible rows only, lazily populated with a `—` placeholder (decision D8) — this keeps
  the no-pre-aggregation bet intact and the list fast.
- Persisted sort / tile-list / segmented filter pills with counts; keep the status distribution bar
  as a secondary visual with keyboard-reachable legend buttons. **Archive = `status: "closed"`**
  excluded from the default view — do not invent a new lifecycle field (decision D11).
- Native Tauri context menu per row (Momentum's documented pattern): Open · Duplicate · Copy rates
  from this · Convert to Momentum project · Delete.
- **Creation redesign**: `suggestNextProposalNumber` (`max(numeric) + 1`, seeded `1300` when empty —
  legacy parity that Precision dropped in favor of an empty box with a placeholder
  `"e.g., 2024-001"` in a numbering convention the company does not use); live duplicate check
  against the existing `by_number` index; **due date at creation** (the primary sort/urgency
  dimension, which legacy forced into a second edit pass); rates source select; WBS scope
  multi-select. **Remove `datasetVersion` from the dialog** — it is an implementation detail with a
  broken option (`wbsPool`/`phasePool` have no v2 rows, so v2 silently falls back to v1 in four
  separate query fallbacks). Move it to Settings → Advanced as "Cost library" for admins.
- **Duplication correctness**: revision numbering that actually **queries for collisions**
  (`duplicate-estimate-dialog.tsx:52-58` does pure local arithmetic — duplicating `1734` twice
  yields `1734.1` twice); the `" - Rev N"` description suffix with any existing suffix stripped
  first; and **chunk `duplicateProposal`**, which is one mutation against an 11,131-activity tree
  and will fail on the largest estimates. Use `AsyncJobPanel` for progress.
- Move the create dialog + its listener into `__root.tsx` so `⌘N` works from anywhere (today the
  palette command dispatches synchronously right after `navigate("/estimates")`, before the listener
  mounts).

**Ships:** the landing screen shows money, remembers your preferences, and is fully
keyboard-operable. Creating and duplicating estimates is correct.

---

### M7 — The whole-estimate workbook · **XL** (~3 weeks) — gated on D7

**Goal:** the marquee win over legacy. This is the item that most directly addresses "the legacy app
feels awful."

**Depends on:** M4 (grid primitives proven), D7 (Collin's answer on drill-down).

The case, from production data: the **median phase holds one activity**, and the largest estimate
has **2,222 phases**. Under the legacy navigation model — which Precision copied route-for-route —
an estimator must open **2,222 separate screens** to touch that estimate. That, not cell latency, is
the real disease. No amount of cell-level polish fixes it.

Contents:

- **Promotions #21–#22**: `VirtualTableBody` (fixed 30px rows, **padding-row spacers** to preserve
  `<table>`/`<colgroup>` semantics — not absolutely-positioned rows — with a `rangeExtractor`
  pinning active group-header indices for sticky WBS/Phase rows), `buildHierarchyRows`,
  `useUndoStack`, `clipboard-grid.ts`, `BulkActionBar`. Retrofit Momentum's workbook onto the
  virtualizer in the same chunk. Momentum's per-`<tbody>` sticky trick cannot be sliced by one
  virtualizer, so this is a real change to a production surface — do it with a synthetic 15k-row
  fixture and a full regression pass.
- New `precision.getEstimateGrid({proposalId, wbsId?, phaseId?})` modeled on
  `momentum.getBrowseData`, **WBS-scoped or paginated by default**, with a document-count guard
  returning a typed "estimate too large for a single query" result rather than throwing.
- The whole-estimate route. **Demote `/estimate/:id/wbs/:wbsId` and `/estimate/:id/phase/:phaseId`
  to scoped presets of the same component** (`scope={{wbsId}}` / `scope={{phaseId}}`), reachable
  from the sidebar tree — not as separate implementations.
- Range selection (Shift+Arrow, Shift+Click, ⌘A); **copy as TSV** (raw numbers on `text/plain`,
  formatted `text/html` for Excel); **paste from Excel** with a mandatory preview (_"Apply 240
  values across 60 rows × 4 columns. 3 cells rejected (Welder Const. is not editable on Material
  rows)."_) — skipping the preview is the easiest way to turn a helpful feature into a
  data-corruption incident on a 562-row phase; **fill-down ⌘D / fill-right ⌘R**; **undo/redo** on
  the inverse-edit payload from `applyActivityEdits`, plus soft delete (`deletedAt` + filtered
  reads + purge cron) so bulk delete is undoable rather than confirm-gated (decision D13).
- Sidebar tree filter with auto-expand-on-match; persist expansion per estimate in the existing
  `useLayoutStore`; hide-empty toggle; virtualize phase children past a threshold.
- **Query-shape work that must land here regardless:** unsubscribe `getExportData` from the overview
  (it is a full-tree query subscribed on mount purely to enable a button — three whole-tree
  subscriptions per estimate open, all three re-running on every cell edit for every connected
  client); fold `getProposalSummary` into `getWBSListWithCosts` (same documents, second
  accumulator); paginate `getExportData` per-WBS.

**Ships:** one screen for the whole estimate, Excel-grade, virtualized, with copy/paste/fill/undo.
2,222 page loads become one.

---

### M8 — Hierarchy control, copy flows, takeoff quantities · **M** (~1.5 weeks)

**Goal:** close the WBS/phase capability gap and put the takeoff quantities back on the bid sheet.

**Depends on:** M3 (phase editing), M4 (grid).

Contents:

- **Wire `addWBS` / `deleteWBS`** behind a pool picker and a cascade-naming confirm. Today every new
  estimate gets all 18 WBS permanently and the overview shows 13 rows of `— — —`. **Do not port
  legacy's cure** — its `wbsToDisplay` defaulted to `[]`, so a brand-new proposal showed **zero**
  WBS. Instead: keep seeding all 18 (cheap, preserves codes), default to hiding WBS with zero
  phases, with a persistent `Show all (13 hidden)` toggle — the exact shape of Momentum's
  `hideUnused`, including its rule that a user-added item is never auto-hidden. Reshape the orphaned
  `userWbsPreferences` from `{userId, wbsPoolNamesToDisplay}` to
  `{proposalId, userId, hiddenWbsPoolIds: number[]}` — keyed on **poolId, not name**; legacy keyed
  on name and had two drifting sources of truth.
- **One `PhasePickerDialog`, three scopes** (`"wbs"` / `"proposal"` / `"global"`), all feeding
  `copyActivitiesToPhase` — which already denormalizes from the **target** phase and never asserts
  the two phases share a proposal, so **cross-proposal copy already works server-side; only the
  picker is missing**. Legacy never had cross-proposal copy (its
  `copy_activities_from_proposal_dialog.tsx` is misnamed and scoped to one proposal, `:41-47`) — so
  this is net-new (decision D14). Legacy also had a same-WBS copy dialog that was mounted but
  unreachable. Build one component, not two.
- **Constant remapping on copy** (decision D4): when activities move into a phase with a different
  `phasePoolId`, their `laborPoolId` points at a constant belonging to a different phase type.
  Legacy shipped the raw copy and left the smarter version dead in `api/phase.ts:156-205`.
  Recommendation: remap by matching description within the target pool, keep raw constants when
  unmatched, and **flag the rows** ("3 of 18 labor lines kept their original constants"). Never
  silently guess.
- **Derived phase/WBS quantity + unit** — completely absent from `precision.ts` today, and it drives
  the QTY/UNIT columns of the bid report. **Do not port `getQuantityAndUnit`.** There are _three_
  implementations in legacy and they disagree: the live screen version (`utils.ts:198`), a dead one
  (`api/activity.ts:569`) that sets the unit but never accumulates quantity, and the one the
  **export** uses (`getDDQuantityAndUnit`, `utils.ts:248`) which has **no CONCRETE branch at all** —
  so for CONCRETE the screen shows a quantity in CY/EA and the exported bid sheet shows `0` with a
  blank unit. Replace with a declarative `quantityRule` on the pool row
  (`{mode, match: string[], defaultUnit}`), seeded from the legacy map, rendered honestly
  (`1,240 LF (derived from 3 activities)` with a hover listing them) plus an explicit override that
  always wins. **Kill the `quantity`/`customQuantity` duality**: model it as `derived` (computed,
  never stored) + `override` (nullable, stored), `override ?? derived`, one reader, one writer. Note
  the storage half already exists (`schema.ts:396,419,466`) — what is missing is the derivation and
  any read path. Gated on D8.
- Roll `completed` up to the WBS (`every(phase.isCompleted)`); add sub-hours (`quantity × time`) and
  the four named indirect buckets (mobe 10000 / demobe 190000 / support 200000 / specialty 180000)
  to `getProposalSummary` — Precision currently collapses them to one aggregate. Move
  `INDIRECT_WBS_POOL_IDS` out of a literal `Set` in source and behind an admin surface.
- **Promotion #23** (`ScopeTotalsBar`) with the hidden-WBS warning chip — a genuinely good legacy
  idea worth keeping.
- Widen the overview WBS table to the full rollup (it already _receives_ material/equipment/sub/
  cost-only in the payload and drops them).
- Restore 4-axis dataset versioning (`{labor, phases, wbs, equipment}`) — decision D15. Legacy
  pinned four independent axes; Precision collapsed them to one string, so it **cannot express
  "labor v2, wbs v1"**, which is what every legacy proposal created since the v2 rollout actually
  is. This gets more expensive every month. Also port Momentum's 3-case labor-pool fallback ladder
  (phase type → WBS union → full catalog); Precision has only case 1, so a phase whose type has no
  labor rows shows an empty catalog with no recovery. And surface dataset diffs: the v1→v2 labor
  change includes `phaseDatabaseId 30012 "REBAR" craftConstant 0.55 → 8` — a **14.5× labor
  increase** that nothing currently surfaces.

**Ships:** full control of the hierarchy, working copy flows, and honest takeoff quantities.

---

### M9 — The bid deliverable: the 37-column WBS Cost Report · **L** (~2 weeks)

**Goal:** the thing estimators hand to clients. Hard cutover requirement.

**Depends on:** M8 (quantity/unit, WBS visibility), M0 (engine extracted).

Precision's export is 13 columns to legacy's 37, with no component decomposition, no proposal header
block, no markup rows, and no phase attributes inherited onto activity rows. It also has two
verified defects: `sheet.columns = [{header:...}]` writes a header row at row 1 _and_ a manual
header at row 4 (so the `ySplit: 4` freeze is off by one), and `|| ""` on numeric cells turns a
genuine `$0.00` into a text cell, which breaks downstream `SUM()`.

Contents:

- **Component decomposition in the engine**: extend `ActivityCosts` with
  `{base, burden, overhead, laborProfit, fuel, consumables, subsistence, laborTotal, rig, profitTotal, salesTax}`
  so the 37-column report is a pure **projection** of one struct, with a test asserting
  `sum(components) === totalCost` for every type. If a report ever needs a number the engine doesn't
  produce, the fix is to add it to the engine — never a second implementation. This is independently
  the best UX idea salvaged from the redesign docs: click a cost, see how it was assembled.
- The full report: proposal header block (Proposal #, Job #, Change #, Description, Owner, Location,
  Date), the two markup rows echoing all 15 rates under their matching cost columns, the 37-column
  row shape, three-level indented WBS/Phase/Activity structure + grand total, activity rows
  inheriting `size / flc / spec / insulation / insulationSize / sheet / area / status / sys` from
  their parent phase, SPCL RATE / SPCL SUB boxed-cell flags, OWNERSHIP, SUB MH, TOTAL MH, accounting
  number formats with `-` for zero, the blue/yellow/green hierarchy fills, and the section-grouping
  right rules.
- The canonical spec is **`mcp_estimator/src/api/tracking_report.xlsx`** — a hand-built 2021 model
  referenced by no code — not `data_dump.ts`. Note the app's export inserts a `SYS` column at L and
  shifts everything right by one relative to the template, so anyone with a downstream sheet keyed
  to fixed columns is **already broken** (decision D16).
- Emit **live formulas** rather than baked values if D16 says so — the template is all formulas
  (`U = ($Qn*$U$13)+((Rn*$R$13))`, `AB = SUM(Un:AAn)`), which is _why_ the markup rows exist at all.
  Formulas make the sheet what-if-able and self-verifying: if the sheet's own arithmetic disagrees
  with the server's number, you see it immediately.
- Export scoped by WBS visibility **with a visible warning** ("3 WBS excluded, $412,000 not shown")
  — legacy silently drops them.
- **Promotion #24** + `tauri-plugin-dialog`: a native save dialog defaulting to
  `{number}-WBS-Cost-Report.xlsx`, replacing the silent browser blob drop into `~/Downloads`. Named
  worksheet (legacy emits `readme demo`). Progress indication, a cancel path, and a real error
  message.
- Load the five `data_dump.ts` divergences (§0.3) into the test suite as negative cases and document
  them for whoever runs the parallel validation.

**Ships:** the bid sheet. Precision produces the document the business actually sells with.

---

### M10 — Authorization and multi-tenancy · **L** (~2 weeks)

**Goal:** make Precision safe to put in front of anyone. Gates cutover.

**Depends on:** M0 (signup closed — that was the emergency half), decision D17.

Contents:

- `organizationId` on `proposals` + backfill of all 713 to the InDemand org; scope `listProposals`
  (today an unfiltered `.collect()` returning every proposal in the deployment to every user).
- `ctx.auth` + org + permission checks on **all 30** `precision.ts` functions. Momentum's backend
  has the identical hole — this is a platform decision, not a Precision regression, but Precision is
  the app where wrong access costs money.
- Client write-gating from `workspace.precision_permission` (carried in `WorkspaceContext` and read
  by **nothing** in `apps/precision/src`). A `read` member can currently create, edit and delete
  everything. Legacy at least gated every editable cell.
- Resolve the auth contradiction: `databaseHooks.session.create.before` (`auth.ts:172-190`)
  **force-pins every new session to the InDemand org** while
  `organization({allowUserToCreateOrganization: true, organizationLimit: 10})` invites the opposite.
  These will fight any multi-tenancy work.
- The remaining legacy auth parity: human-readable error messages (email in use, wrong credentials,
  user not found, disabled, too many requests, `invalid-credential`), a route guard with a real
  loading state, verification resend + "I've verified — continue". Password reset is already at
  parity or better (Resend-based, `auth.ts:100-129`).
- Confirmation before destructive admin actions.

**Ships:** an app you can hand to the whole estimating team.

---

### M11 — Cutover · **L** (~2–3 weeks)

**Goal:** hard switch. MCP Estimator goes read-only, Precision becomes the system of record.

**Depends on:** everything.

Contents:

- **The breadth pass** — the one and only one. Walk the merged parity checklist from all six legacy
  inventory reports and close the tail. Now cheap because the structure exists. Known tail items
  with no gap-report home today: per-grid sort/filter/density persistence · session memory
  (last-selected proposal, last tab, nav collapse, window size/position) · an explicit "reload this
  proposal's data" affordance · search across all 22 proposal fields · the uppercase
  normalize-on-write list with its numeric and enum exclusions · fractional `sortOrder` with
  midpoint insertion + drag-to-reorder + the A/B/…/AA positional gutter · per-user column visibility
  persisted to the orphaned `proposalColumnPreferences` table · constant-variance highlighting
  **with a legend** (and fix the semantics — a constant _below_ catalog is currently painted "over")
  · bulk retype (decision D18).
- **Data cleanup, before migration:** repair the `wbsId` mismatches; resolve the **23 duplicate
  `proposalNumber` values** (the uniqueness guard cannot be applied to existing data without this,
  and any "jump to proposal number" UX has to handle collisions).
- **The one-time migration.** `sync.syncEngine.startSync` — the full-tree sync — is deliberately
  parked off-cron for exactly this. Run it for all 713 proposals. Verify counts at every level.
- **Parallel-run validation** on a deliberately chosen set of proposals: exercise all six activity
  types, both equipment ownership branches, rate overrides, and a large tree — while **avoiding**
  the 36 zero-rate proposals (both engines return $0.00 and prove nothing) and `1734` (four of its
  rate fields are 0). Reconcile against the legacy **screen**, and treat legacy-export deltas as
  expected using the §0.3 negative cases.
- Stop the crons. Make MCP Estimator read-only. Cut.

**Ships:** MCP Estimator is retired.

---

## 5. DECISIONS ONLY COLLIN CAN MAKE

Ordered by when they block work. Each has a recommendation.

| #       | Decision                                                                                                                                                                                                                                                                                                            | Blocks                                       | Recommendation                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | **Who owns a synced proposal's record?** Whitelist the cron patch, mark legacy-origin proposals read-only, or stop the cron?                                                                                                                                                                                        | **M1 — everything**                          | Both: legacy-origin = read-only with a banner, plus an admin "Take ownership" that sets `syncPolicy: "precision-owned"` and makes the sync skip it.                                                                             |
| **D2**  | **Rounding policy.** Round at the activity, at the phase, or only at display? Precision rounds man-hours _before_ costing; neither legacy path does.                                                                                                                                                                | **M0 — all validation**                      | Full precision throughout, round only at the display/accumulator boundary, including man-hours. Stamp `calcVersion` so the change never re-prices old bids silently.                                                            |
| **D3**  | **Does a per-activity rate override of `0` mean "$0/hr" or "inherit"?** Legacy `\|\|` says inherit; Precision `??` says $0.                                                                                                                                                                                         | M4 (goes live when the UI can set overrides) | Precision's `??` is correct — but confirm estimators weren't using `0` as "inherit". Currently unreachable: the importer only writes non-zero overrides.                                                                        |
| **D4**  | **Constant remapping on copy.** Legacy shipped the raw copy; its _dead_ code did the remap. Which is correct estimating practice?                                                                                                                                                                                   | M8                                           | Remap by description within the target pool; keep raw when unmatched and **flag** those rows. Never silently guess.                                                                                                             |
| **D5**  | **Phase numbering rule.** Legacy's 108 reserved catalog ids used verbatim + `max(non-reserved, wbsCode)+1`, or Momentum's simpler `phaseCode = poolId`?                                                                                                                                                             | M3                                           | Converge on Momentum's if the business allows — the 108-value list is an **undocumented** business rule with no provenance beyond a hardcoded array. But phase numbers are on bid sheets, so this is your call, not the code's. |
| **D6**  | **The rate-override eligibility rule.** Legacy allows overrides only for `custom_labor`, **or** WBS 200000 (SUPPORT), **or** phase pool 180002/180003/180004 — and for multi-select only when all rows share the same base rate. Real policy or accident?                                                           | M4                                           | Need an estimator's answer. Precision has no restriction today.                                                                                                                                                                 |
| **D7**  | **Whole-estimate grid vs. per-phase drill-down.** Is the Proposal→WBS→Phase→Activity click path itself the pain, or just the legacy chrome around it?                                                                                                                                                               | **M7 (XL — 3 weeks)**                        | The production data (median 1 activity/phase, 2,222 phases) says whole-estimate, strongly. But this is 3 weeks and it changes the navigation model, the sidebar, and every route.                                               |
| **D8**  | **Derived quantity/unit rules.** Port the keyword heuristic verbatim (including the naive `'HE'` substring that matches SHEET/THREAD/OTHER) so numbers tie to legacy, or fix it so numbers are _right_ but differ? Also: what is CONCRETE's real takeoff quantity — the screen says one thing, the export says `0`. | M8, M9                                       | Ask an estimator, not the code. If a bid was won on those numbers, changing them silently is worse than keeping the bug — so version the rule rather than replacing it.                                                         |
| **D9**  | **Lock rates after submit/award?** Today (both apps) editing a rate re-prices every activity including completed phases, with no versioning, no snapshot, no warning.                                                                                                                                               | M5                                           | Yes, with an explicit unlock requiring a reason. Implies the first audit record in the product.                                                                                                                                 |
| **D10** | **Contacts: inline 7 fields, or the `contacts` entity?**                                                                                                                                                                                                                                                            | M5                                           | Inline now, normalize when there is a second consumer. Note the entity branch needs 3 mutations + a join query that do not exist.                                                                                               |
| **D11** | **Archive semantics.** Reuse `status: "closed"` + a filter tab, or a real `archivedAt` with restore?                                                                                                                                                                                                                | M6                                           | `status: "closed"`. Zero schema change, matches the existing enum, and legacy had no archive at all.                                                                                                                            |
| **D12** | **Recents/pins storage:** per-app tables (fast, duplicative) or a generic `userEntityViews` + a Momentum migration (~1 extra day)?                                                                                                                                                                                  | M6                                           | Generic, if Momentum's migration is acceptable.                                                                                                                                                                                 |
| **D13** | **Soft delete for undo?** Requires `deletedAt` on `activities`, filtered reads and a purge cron — on a table the Firestore sync also writes.                                                                                                                                                                        | M7                                           | Yes. `design-principles.md §XIII` says "Undo > Confirmations", and bulk delete on a 562-row phase with no undo is a data-loss event waiting to happen.                                                                          |
| **D14** | **Cross-proposal copy — wanted?** Net-new; legacy never had it; the mutation already permits it.                                                                                                                                                                                                                    | M8                                           | Scope call. Cheap given the picker exists.                                                                                                                                                                                      |
| **D15** | **Restore 4-axis dataset versioning?** Precision's single `datasetVersion` cannot express "labor v2, wbs v1", which is what every post-v2 legacy proposal actually is.                                                                                                                                              | M8                                           | Yes, and soon — this gets more expensive every month.                                                                                                                                                                           |
| **D16** | **Excel: formulas or baked values? Match the 2021 template's column layout exactly (no `SYS`), or version the layout and accept that downstream sheets break?**                                                                                                                                                     | M9                                           | Formulas — self-verifying and what-if-able. Layout: version it explicitly; downstream sheets are already broken by the `SYS` shift.                                                                                             |
| **D17** | **Multi-tenancy scope.** InDemand-only forever, or real org scoping like Momentum? Determines how much of M10 is needed.                                                                                                                                                                                            | M10                                          | —                                                                                                                                                                                                                               |
| **D18** | **Bulk retype** (change 40 rows from labor to custom_labor). Net-new; needs a documented rule table for what happens to type-specific fields.                                                                                                                                                                       | M11                                          | Skip unless estimators ask. "Delete and re-add" is acceptable for a rare operation.                                                                                                                                             |

---

## 6. RISKS

Ordered by expected damage.

1. **Acting on a confident wrong finding.** §0.1 was scheduled _first_ in one gap report and would
   have inflated every welder hour in every bid. Until the golden tests exist, treat every "the
   formula is wrong" claim — including the ones in this document — as unverified. **Mitigation:** M0
   is entirely about establishing ground truth; no formula changes before the test suite.

2. **The `wbsId` corruption makes Precision disagree with itself.** Four surfaces, three answers, no
   error. It will look like a Precision bug during validation and it is a faithfully-imported legacy
   bug. **Mitigation:** M0 fixes the write path, repairs the data, and asserts the invariant.

3. **Momentum destabilization from a shared-component refactor.** Momentum is fully released and in
   heavy production use. The three highest-risk promotions are `GridCellInput` (#13, two hand-rolled
   focus/commit state machines), `useGridKeyboardNav` (#14) and `VirtualTableBody` (#21, which
   replaces Momentum's per-`<tbody>` sticky trick). **Mitigation:** §3.1's five rules — promote
   don't generalize, Momentum first consumer, preserve props at the seam via a wrapper, no promotion
   before real typecheck, delete forks in the adopting commit.

4. **Rounding drift makes parallel-run validation unclosable.** Three policies exist today;
   Precision adds an independent fourth source of drift by rounding man-hours before costing. Days
   will be lost chasing deltas that are not bugs. **Mitigation:** D2 in M0, before anyone validates
   anything.

5. **Convex read ceiling on real estimates.** One `by_proposal` collect on the largest proposal is
   ~68% of the limit, and the overview subscribes **three** whole-tree queries — one of which
   (`getExportData`) exists only to enable a button, and all three of which re-run on every cell
   edit for every connected client. **Note the reports disagree on the ceiling itself** (16,384 docs
   / 8 MiB vs 32,000 / 16 MiB) and on the largest estimate's size (11,131 vs 13,314 activities).
   **Mitigation:** measure the real limit and the real largest proposal before sizing M7; do the
   query-shape fixes (unsubscribe, fold, paginate) as soon as M7 starts, and earlier if anything
   throws.

6. **Open signup + zero server-side authorization over 713 real bids.** Not "any authenticated
   client" — anyone on the internet who signs up. **Mitigation:** the emergency half (verification,
   domain allow-list, ban enforcement) is a 2-hour job in M0; the full authz is M10.

7. **Scope: full parity is non-negotiable and the tail is heavy.** The 37-column report alone is two
   weeks. The 108-value reserved phase-number list is an undocumented business rule. The pools were
   seeded out-of-band and there is **no reproducible re-seed path in this repo** and no v2 authoring
   surface. **Mitigation:** the parity checklists in the six legacy inventory reports are the
   contract; merge them into one tracked list at M11 and treat any item not on it as out of scope.

8. **`duplicateProposal` is one mutation against an 11,131-activity tree.** Convex write limits make
   it a guaranteed failure on the largest estimates, and it is already wired to a UI button.
   **Mitigation:** chunk it in M6; until then, it is a known failure mode.

9. **Design rework.** You iterate, and the milestones deliberately front-load structure. The
   mitigation is baked in: M2 lands the shared chrome so every subsequent surface inherits
   Momentum's already- polished vocabulary rather than establishing a new one, and shared components
   mean a polish pass applies to both apps at once.

10. **No repeatable pool seeding.** `wbsPool` / `phasePool` / `laborPool` / `equipmentPool` were
    loaded out-of-band; `seed.ts` has no pool code and no import script exists. The M2 `sortOrder`
    fix has no reproducible seeding path today, and a future v2 dataset has no authoring surface.
    **Mitigation:** write the seed/import script as part of M2's migration.

---

## 7. START HERE

**M0, and inside M0, the cost-engine extraction plus its golden-number test suite.**

Concretely, the first day: create `packages/backend/convex/model/costEngine.ts` by moving `round2` /
`computeCraftLoadedRate` / `computeWelderLoadedRate` / `computeActivityCosts` out of
`precision.ts:142-311`, typed over a plain `ActivityInput`; export it as
`@truss/backend/cost-engine`; capture golden numbers from 3–5 deliberately-chosen real legacy
proposals; write the tests; then settle the rounding policy against them.

Why this first, ahead of everything including the screens you dislike:

- It is the **only** thing that makes every subsequent claim about a number checkable. The audit
  process itself produced a confident, first-scheduled recommendation that would have overstated
  every welder hour by `weldBaseRate × rigProfitRate / 100`. There is currently nothing in the
  repository that would have caught it.
- It is **cheap and permanent**. One day of work, and it never needs redoing.
- It **unblocks three separate later items** that would otherwise each grow a second, drifting copy
  of the math: optimistic updates (M4), paste preview (M7), and the parallel-run reconciliation
  harness (M11). Legacy's most expensive bug class is exactly this — `calculations.ts` drifting from
  `totals.ts` until nobody knew which was live, plus `data_dump.ts` as a third implementation that
  made the bid sheet disagree with the screen.
- Calculation correctness is stated as non-negotiable, and a wrong dollar amount is worse than a
  missing feature. This is the cheapest possible way to make that true rather than aspirational.
