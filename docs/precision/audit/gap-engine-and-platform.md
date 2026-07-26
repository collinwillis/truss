# Gap Analysis — Calculation Engine, Pools, Exports, Admin, Shell

**Domain:** calc parity + platform (pools / exports / admin / shell / packaging) **Method:** read
the source in both repos. Every claim below is traced to a file and line. Where a prior audit report
disagrees with the code, the code wins and I say so.

---

## 0. CORRECTION TO A PRIOR REPORT — READ THIS FIRST

`precision-current.md` opens with "**A real formula bug** — `computeWelderLoadedRate` omits
`rigProfitRate` from the weld-base markup. The legacy estimator includes it… Every welder cost in
Precision is understated." It cites `mcp_estimator/src/utils/calculations.ts:58-72` as the legacy
reference.

**That report is wrong, and the JSDoc it calls a lie is actually correct.**

`src/utils/calculations.ts` is the **dead** duplicate engine. `legacy-calc.md` §2 and defect
**B20**, and `legacy-docs-triage.md` §S3, both independently establish this: zero importers, and it
carries a _different_ welder formula that folds `rigProfitRate` into the wage multiplier.

The **live** engine is `src/api/totals.ts::getWelderLoadedRate` (lines 41-71), which I read
directly:

```ts
return (
  weldBaseRate +
  (weldBaseRate * (burdenRate + overheadRate + laborProfitRate + fuelRate + consumablesRate)) /
    100 +
  subsistenceRate +
  rigRate +
  (rigRate * rigProfitRate) / 100
);
```

`precision.ts:179-195` is algebraically identical. **Precision matches the live legacy engine
exactly.** Do not "fix" this — applying the change `precision-current.md` recommends would
_introduce_ a wrong-dollar bug of `weldBaseRate × rigProfitRate/100` per welder hour.

The trap is exactly the one `legacy-calc.md` warned about: anyone who greps `getWelderLoadedRate`
finds the dead file first. Delete `src/utils/calculations.ts` from any reference bundle before
anyone else validates against it.

---

## 1. CURRENT PARITY

### 1.1 The engine is real, server-side, and mostly correct

`packages/backend/convex/precision.ts` lines 142-311 hold the whole engine: `round2`,
`computeCraftLoadedRate`, `computeWelderLoadedRate`, `computeActivityCosts`. Costs are derived on
read from raw activity inputs plus the 15 `proposal.rates` fields; the `activities` table stores
**no** computed cost columns (`schema.ts:495-523`). The architecture bet holds and is the strongest
thing in the codebase.

Precision also has something legacy never had: a **real proposal-level rollup**
(`getProposalSummary`, precision.ts:879-950). Legacy had no proposal rollup at all — totals existed
only transiently in `bottom_pannel.tsx` and in the export summary row (`legacy-calc.md` §6.3).

### 1.2 Formula-by-formula verdict

Reference: legacy `src/api/totals.ts` + `src/utils/utils.ts::processRawActivity` (lines 87-183).

| #   | Formula                                          | Legacy (live)                                                                                                   | Precision                                                                | Verdict                                                                                  |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | craft loaded rate                                | `craftBase + craftBase·S + subsistence`, `S = (burden+overhead+laborProfit+fuel+consumables)/100`               | `computeCraftLoadedRate` :152-167                                        | **MATCH** algebraically. Diverges on override semantics — see §1.3 D1                    |
| 2   | welder loaded rate                               | `weldBase + weldBase·S + subsistence + rig + rig·rigProfit/100`                                                 | `computeWelderLoadedRate` :179-195                                       | **MATCH** — including _excluding_ `rigProfitRate` from `S`                               |
| 3   | craft man-hours                                  | `quantity · craftConstant`, unrounded                                                                           | `round2(qty · craftConstant)` :227                                       | **DIFFERS** — see §1.3 D2                                                                |
| 4   | welder man-hours                                 | `quantity · welderConstant`, unrounded                                                                          | `round2(qty · welderConstant)` :228                                      | **DIFFERS** — same                                                                       |
| 5   | craft cost                                       | `craftMH · craftLoaded`, all types except subcontractor                                                         | :239-241, same guard                                                     | **MATCH** (+ rounding)                                                                   |
| 6   | welder cost                                      | `welderMH · welderLoaded`, **all** types incl. subcontractor                                                    | :244, unconditional                                                      | **MATCH** (+ rounding)                                                                   |
| 7   | material cost                                    | `q·price·(1 + (materialProfit+salesTax)/100)`                                                                   | :248-252                                                                 | **MATCH**                                                                                |
| 8   | equipment, Owned                                 | `q·time·price` (no profit, no tax)                                                                              | :260-261                                                                 | **MATCH**                                                                                |
| 9   | equipment, Rental/Purchase                       | `q·time·price·(1 + (equipProfit+useTax)/100)`                                                                   | :262-265                                                                 | **MATCH**                                                                                |
| 10  | subcontractor cost                               | `q·[L·(1+p) + M·(1+p+salesTax) + E·(1+p)]`                                                                      | :269-283                                                                 | **MATCH** — and it implements the _app_ formula, not the legacy export's understated one |
| 11  | cost-only cost                                   | `q · price`                                                                                                     | :285-289                                                                 | **MATCH**                                                                                |
| 12  | activity total                                   | subcontractor → `subCost` only; else sum of all six                                                             | :294-308                                                                 | **MATCH**                                                                                |
| 13  | craft/welder constant resolution                 | `activity.craftConstant ?? activity.constant?.craftConstant ?? 0`                                               | `activity.labor?.craftConstant ?? 0` :225-226                            | **DIFFERENT MODEL** — see §1.3 D3                                                        |
| 14  | equipment price ← unit binding                   | `Hours→hourRate, Days→dayRate, Weeks→weekRate, Months→monthRate` rewritten on unit change (`newAPI/api.ts:346`) | `unitPrice` is a free scalar; `equipmentPoolId` stored but never re-read | **MISSING**                                                                              |
| 15  | subcontractor per-unit inputs visible as columns | legacy grid shows `craftCost`/`materialCost`/`equipmentCost` raw inputs on sub rows                             | `computeActivityCosts` returns 0 for those on sub rows; grid shows 0     | **DISPLAY GAP** (math is fine)                                                           |

**Bottom line on formulas: 11 of 12 core cost formulas are exact. The dollar-level risks are
rounding (D2) and the zero-override semantics (D1), not the algebra.**

### 1.3 The three real calc divergences

**D1 — `??` vs `||` on per-activity rate overrides.** Legacy `getCraftLoadedRate` uses
`customCraftBaseRate || craftBaseRate` (totals.ts:26-27). A stored override of **`0` is discarded**
and the proposal rate is used. Precision uses `customCraftRate ?? rates.craftBaseRate`
(precision.ts:157) — a stored `0` becomes a genuine $0.00/hr rate. `legacy-calc.md` logs this as
defect **B3**; `legacy-docs-triage.md` §2.2 #3 flags the same thing as a "silent behavior change."

Mitigating fact I verified: the Firestore importer only writes the override when non-zero —
`sync/fieldMapping.ts:208-214`, `if (fs.craftBaseRate != null && num(fs.craftBaseRate) !== 0)`. So
**no synced data can currently trigger it.** It becomes live the moment Precision ships a UI that
can set an override (which it must — see §2). Precision's behavior is the _correct_ one; it just
needs to be a deliberate, documented decision rather than an accident.

**D2 — Precision rounds man-hours before costing. Neither legacy path does.** There are now
**three** rounding policies in play:

|                                | man-hours                                                 | per-line cost            | rollup                                  |
| ------------------------------ | --------------------------------------------------------- | ------------------------ | --------------------------------------- |
| legacy screen (`store.ts`)     | unrounded                                                 | unrounded                | sum of unrounded                        |
| legacy export (`data_dump.ts`) | unrounded **in the math**, `currencyRound` only at output | `currencyRound` per line | sum of **rounded** lines                |
| **Precision**                  | **`round2` before costing** (:227-228)                    | `round2` per component   | sum of rounded, then `roundAccumulator` |

I verified the legacy export order directly:
`craftBase = (customCraftRate ?? craftBaseRate) * baseActivity.craftManHours` uses the raw unrounded
`craftManHours`, and `craftMH: currencyRound(baseActivity.craftManHours)` rounds only for display
(`data_dump.ts`, `activityToDataDumpItem`).

Concretely: `qty = 7`, `craftConstant = 0.037` → legacy MH `0.259`, Precision MH `0.26`. At a $95
loaded rate that is `$24.605` vs `$24.70` on one line. `legacy-calc.md` §11.3 already measures the
legacy screen-vs-export drift at ~$25 on a 5,000-line estimate; Precision adds a _second_,
independent source of drift on top. **Any parallel-run validation against production estimates will
show non-zero deltas that are not bugs — you will waste days chasing them if this is not settled
first.**

**D3 — no frozen constant snapshot, so "Reset Constants" has no home.** Legacy embeds the whole
`Constant` object on the activity doc and reads
`activity.craftConstant ?? activity.constant.craftConstant`. The scalar _shadows_ the snapshot,
which is why "Reset Constants" (nulls the scalars so the snapshot takes over) exists. Precision
stores `laborPoolId` + `labor.{craftConstant, welderConstant}` and no snapshot. This is a **better**
model (one source of truth, frozen at add time) but it means:

- "Reset Constants" must be re-implemented as "re-read `laborPool` by `poolId` + `datasetVersion`" —
  which is _not_ the same thing, because the pool row can have changed since. Legacy's snapshot
  froze history; Precision's `poolId` does not.
- There is no way to tell "this row uses the catalog value" from "someone typed the same number."

### 1.4 Rollup correctness — activity → phase → WBS → proposal

| Level                                   | Legacy                                                                                                                                                                                                     | Precision                                                                                                           | Verdict                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| activity → phase                        | `calculateTotals` (`utils.ts:280`) — **excludes** subcontractor rows from the craft/material/equipment buckets so their per-unit inputs aren't double-counted; forgets to exclude `welderCost` (asymmetry) | `accumulateCosts` (:678-688), plain sums                                                                            | **Equivalent and cleaner.** Precision keeps sub inputs in `activity.subcontractor.*`, never in the shared cost fields, so the double-count the legacy guard exists to prevent cannot arise. The legacy asymmetry is designed out. |
| phase quantity / unit                   | `getQuantityAndUnit` keyword heuristic + `customQuantity ?? inferred`                                                                                                                                      | **absent**                                                                                                          | **MISSING**                                                                                                                                                                                                                       |
| phase → WBS                             | `calculateWbsTotals` sums                                                                                                                                                                                  | `getWBSListWithCosts` (:809-870) groups by `wbsId`, sums                                                            | **MATCH**                                                                                                                                                                                                                         |
| WBS quantity / unit                     | re-derived from the WBS's _activities_ (ignoring phase overrides — legacy bug) + `customQuantity`                                                                                                          | **absent**                                                                                                          | **MISSING**                                                                                                                                                                                                                       |
| WBS `completed`                         | `relatedPhases.length > 0 && every(p.completed)`                                                                                                                                                           | **absent** — `isCompleted` on phases is rendered but never rolled up or togglable                                   | **MISSING**                                                                                                                                                                                                                       |
| WBS → proposal                          | **does not exist** in the legacy store                                                                                                                                                                     | `getProposalSummary` (:879-950)                                                                                     | **Precision is ahead**                                                                                                                                                                                                            |
| direct vs indirect hours                | 4 named buckets: mobe(10000), demobe(190000), support(200000), specialty(180000); everything else = direct craft/welder                                                                                    | one aggregate `indirectHours` (:917, :927-932); `INDIRECT_WBS_POOL_IDS` = same four ids (:634-639)                  | **PARTIAL** — classification correct, buckets lost                                                                                                                                                                                |
| subcontractor hours (`quantity × time`) | `bottom_pannel.tsx`                                                                                                                                                                                        | **absent** — grep across `precision.ts` and `packages/features/src/estimation/` returns nothing                     | **MISSING**                                                                                                                                                                                                                       |
| hidden-WBS handling + warning chip      | `wbsToDisplay` scopes bottom-panel totals _and_ the export; amber "Hidden WBS data" chip                                                                                                                   | `userWbsPreferences` / `wbsPoolNamesToDisplay` tables exist in `schema.ts` and **zero Convex functions touch them** | **MISSING**                                                                                                                                                                                                                       |
| incremental recompute staleness         | legacy `recalculatePhase` never refreshes WBS totals (bug B14 / §6.4)                                                                                                                                      | Convex reactive queries recompute every level automatically                                                         | **Precision is ahead** — this whole class of bug is designed out                                                                                                                                                                  |

**One latent consistency hazard:** `getProposalSummary` sums **all** activities for a proposal;
`getWBSListWithCosts` sums only activities whose `wbsId` matches a live WBS row. An activity whose
`wbsId` points at a deleted WBS is counted by the bottom panel and invisible in the WBS table — the
totals silently disagree with no error. `deleteWBS` cascades correctly (:1130+) but it is unwired,
so today the only way to orphan is a bad import. Add a reconciliation assertion or group the summary
by the same WBS set.

### 1.5 Does compute-on-read hold at 10k+ activities?

**No, not as currently wired — but the fix is query shape, not caching.** The comment on
`getWBSListWithCosts` ("For a 10K-activity proposal, this runs server-side in <100ms") is optimistic
about the wrong axis. CPU is not the problem; **read budget is.**

A Convex function may read at most **16,384 documents / 8 MiB** in one call. `getProposalSummary`
does three unbounded `.collect()`s in a single query — all activities + all phases + all WBS
(:888-911). At 10k activities (~400-700 B each) you are at 4-7 MB of read bandwidth in one function.
`getExportData` (:1630-1748) reads the identical set again.

Worse, `apps/precision/src/routes/estimate/$estimateId.index.tsx:79-82` subscribes to **three**
whole-tree queries at once:

```ts
const wbsItems = useQuery(api.precision.getWBSListWithCosts, { proposalId });
const summary = useQuery(api.precision.getProposalSummary, { proposalId });
const exportData = useQuery(api.precision.getExportData, { proposalId }); // ← for a button
```

`getExportData` is subscribed on mount purely so the Export button can be enabled. So opening an
estimate costs **3× a full-tree read**, and because Convex queries are reactive, **editing one
quantity cell re-runs all three** for every connected client.

What to do, in order:

1. **Unsubscribe `getExportData`.** Make export an `action`/on-demand fetch. Free, removes a third
   of the load immediately.
2. **Fold `getProposalSummary` into `getWBSListWithCosts`.** They read the same documents and
   produce compatible numbers; the summary is a second accumulator over the same loop. One query,
   one read budget.
3. **Paginate the export.** `getExportData` should stream per-WBS (`by_wbs` index) rather than
   `.collect()` the proposal. This is the query that will blow the 8 MiB ceiling first.
4. **Only if 1-3 aren't enough:** a `phaseRollups` denorm table written by a mutation-side recompute
   — but that reintroduces staleness and directly contradicts the architecture bet. Treat as a last
   resort and gate it on a measured proposal.

For calibration: legacy production proposals are big enough that `legacy-calc.md` §9.1 calls out
"10,000 activities pulled and processed on the UI thread." So 10k is a real number, not a
hypothetical.

### 1.6 Pools (rate libraries) — parity

Four pool tables exist and are populated: `wbsPool` (18 v1 rows), `phasePool` (228), `laborPool`
(~5,900 v1 / ~5,968 v2), `equipmentPool` (129 v1 / 133 v2), each carrying
`datasetVersion / poolId / sortOrder / isCustom / isActive` (`schema.ts:189-290`).

| Capability                                             | Legacy                                                              | Precision                                                                                                                                                                                                                                                  | Verdict                           |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| labor catalog scoped to the phase's catalog type       | `phaseDatabaseId` filter                                            | `getLaborPool(datasetVersion, phasePoolId)` :1036-1059                                                                                                                                                                                                     | **MATCH**                         |
| equipment catalog                                      | global list                                                         | `getEquipmentPool(datasetVersion)` :1067-1082                                                                                                                                                                                                              | **MATCH**                         |
| phase catalog scoped to WBS                            | `wbsDatabaseId` filter                                              | `getPhasePool` :1005-1028                                                                                                                                                                                                                                  | **MATCH**                         |
| per-type dataset version with backward fallback        | `resolveDatasetVersion` walks _down_ the version order per DataType | one `datasetVersion` per proposal + an inline `if empty → v1` fallback in each pool query                                                                                                                                                                  | **PARTIAL** — see below           |
| labor catalog fallback when the phase type has no rows | n/a                                                                 | **missing.** Momentum's `getLaborPoolForProject` (momentum.ts) has a 3-case ladder: phase type → union of the WBS's phase types → full catalog. Precision has only case 1, so a phase whose type has no labor rows shows an empty catalog with no recovery | **GAP**                           |
| pool authoring (add/edit/deactivate/custom rows)       | none in legacy either                                               | none — `isCustom`/`isActive` are never written by any mutation                                                                                                                                                                                             | **parity, but a stated goal gap** |
| catalog browsing UI                                    | none in legacy                                                      | `/pools/labor`, `/pools/equipment` read-only browsers                                                                                                                                                                                                      | **Precision is ahead**            |

**Dataset versioning is a real model regression.** Legacy stores
`datasetVersions: {labor, phases, wbs, equipment}` — four independent axes — and a new proposal is
stamped `{labor:'v2', phases:'v1', wbs:'v1', equipment:'v2'}` (`api/proposal.ts:27`). Precision
collapses this to a single `datasetVersion: "v1"|"v2"` on the proposal (`schema.ts:353-399`), and
the sync hardcodes `datasetVersion: "v1" as const` (`sync/fieldMapping.ts`). The per-query
`if empty → v1` fallback papers over it at read time, but the stored fact is lossy: you can no
longer represent "labor v2, equipment v1." This is exactly the mistake `legacy-docs-triage.md` §2.2
#7 warns about (`constant_data_set VARCHAR(50)` — "a single column cannot represent this"). Fix the
schema before more proposals are created.

**Content deltas are invisible.** The v1→v2 labor diff includes exactly one changed constant on a
row common to both: `phaseDatabaseId 30012, "REBAR", craftConstant 0.55 → 8` — a 14.5× labor
increase. Nothing surfaces it. Whatever version model you land on, dataset diffs need a UI.

### 1.7 Export — Precision produces a different report, not a worse one

|                                     | Legacy "WBS Cost Report"                                                                                    | Precision `lib/export-excel.ts`                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --- | ------------------------------- |
| columns                             | **37**                                                                                                      | **13**                                                                          |
| rows                                | 7-row proposal header block + 2 markup rows carrying all 15 rates + header + WBS/Phase/Activity/grand-total | title + subtitle + header + WBS/Phase/Activity/grand-total                      |
| component decomposition             | BASE, BURDEN, OVERHEAD, LABOR PROFIT, FUEL, CNSMBLE, SUBSIST, LABOR, RIGS, PROFIT TOTAL, SALES TAX          | **none** — only the six bucket totals                                           |
| phase attributes on activity rows   | SIZE, FLC, SPEC, INSUL, INSL. SIZE, SHT, AREA, STATUS, SYS inherited from parent                            | **none**                                                                        |
| SPCL RATE / SPCL SUB override flags | yes, with a boxed-cell highlight                                                                            | **none**                                                                        |
| OWNERSHIP, SUB MH, TOTAL MH         | yes                                                                                                         | **none**                                                                        |
| scoping                             | only WBS in `wbsToDisplay`, only WBS with ≥1 phase                                                          | all WBS                                                                         |
| engine                              | **second, divergent implementation** (`data_dump.ts`) that understates sub cost by `q·material·salesTax`    | **same server engine as the screen** (`getExportData` → `computeActivityCosts`) |
| delivery                            | Tauri native save dialog, `{number}-WBS-Cost-Report.xlsx`                                                   | browser `Blob` + `<a download>`; `Estimate_{number}.xlsx`                       |
| number formats                      | accounting formats, `-` for zero                                                                            | `"$"#,##0.00`, `                                                                |     | ""` → **empty string** for zero |

The one thing Precision got structurally right and legacy got structurally wrong: **one engine.**
Keep that invariant absolutely — `legacy-calc.md` §11.3 proves the legacy export does not tie to the
legacy screen, and "the Excel doesn't tie" is a credibility-destroying bug in a bid document.

Two concrete defects in `export-excel.ts` I verified:

- **Duplicate header row.** `sheet.columns = [{header: "Type", …}, …]` (:122-136) makes ExcelJS
  write a header row at **row 1**, and then a second, manually-built header row is added at row 4
  (:150). The `views: [{state:"frozen", ySplit: 4}]` freeze is therefore also off by one relative to
  the intended layout.
- **`|| ""` on numeric cells** (:180-234) turns a genuine `$0.00` into a text cell. Legacy uses the
  literal `"-"` with an accounting format — deliberate. Pick one and apply it consistently, but
  don't emit a mix of numeric and text cells in the same column: it breaks downstream `SUM()`.

The canonical spec for the real report is `mcp_estimator/src/api/tracking_report.xlsx` — a
hand-built model created 2021-01-04 by Mark Bieber, referenced by **no code**, containing live
formulas for every column (`legacy-crosscutting.md` §4.5). That file, not `data_dump.ts`, is the
source of truth for what the estimators actually expect. Note that the app's export inserts a `SYS`
column at L and shifts everything right by one relative to the template — so anyone with a
downstream sheet keyed to fixed columns is already broken.

### 1.8 Admin / permissions

|                         | Legacy                                                                                      | Precision                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model                   | `users/{uid}` 2×2: `role: user\|admin` × `permission: read\|readWrite`                      | Better Auth org `role: owner\|admin\|member` + `appPermissions` per-app `none\|read\|write\|admin` (`appPermissions.ts:13-19`) — **strictly better**                                                           |
| member list             | name/email/permission/role/disable/soft-delete, search by **name only**                     | search by name **and** email, All/Active/Suspended tabs, per-app permission badges                                                                                                                             |
| server-side enforcement | **none** (no `firestore.rules` in repo; the one Cloud Function never checks `context.auth`) | **none** — grep for `ctx.auth` / `getAuthUserId` across all 30 functions in `precision.ts` returns zero. Any authenticated client can mutate any proposal. Momentum's backend is equally unguarded.            |
| client write-gating     | `hasWritePermissions` gates every editable cell and every quick-add button                  | **none.** `WorkspaceContext` carries `precision_permission` (`organizations/types.ts:61`) and **nothing in `apps/precision/src` reads it.** A `read`-permission member can create, edit and delete everything. |
| multi-tenancy           | no org concept at all                                                                       | `proposals` has **no `organizationId`** (`schema.ts:353-399`); `listProposals` does an unfiltered `.collect()` and returns every proposal in the deployment to every user                                      |

**The Precision admin page is hard-broken.** `apps/precision/src/routes/admin/index.tsx:46` reads
`workspace?.organizationId`; the field is `organization_id`. I confirmed with `tsc`:

```
src/routes/admin/index.tsx(46,28): error TS2551: Property 'organizationId' does not exist on
  type 'WorkspaceContext'. Did you mean 'organization_id'?
```

`orgId` is always `undefined` → the members query is permanently `"skip"` → the page renders a
skeleton forever. On top of that both admin routes read `m.banned` / `m.role` /
`m.precisionPermission` while `adminUsers.listOrganizationMembers` returns `isBanned` / `orgRole` /
`appPermissions` — **the whole admin surface is written against a stale server shape.** 20 of
Precision's 28 app-level TS errors are in those two files.

`tsc --noEmit` on `apps/precision`: **68 total errors, 28 at `src/`**. There is no
`eslint.config.mjs` and `check-types` is literally
`echo 'App type checking handled by IDE and Vite...'` — **in both apps.** Type errors ship.

### 1.9 Shell, navigation, command palette

The shell is genuinely shared and is not the problem. Precision mounts `AppShell` from
`@truss/features/desktop-shell` with the same config-factory convention as Momentum, and is the
**only** consumer of `TreeNavItem` (its WBS→Phase sidebar tree) — a nicer pattern than Momentum's
three flat links.

What is broken, verified by repo-wide grep for each event name:

| Event                    | Dispatched                                                                                               | Listener                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toggle-sidebar`         | `precision/shell-config-{global,estimate}.ts`, `momentum/shell-config-{global,project}.ts` (⌘B, 4 sites) | **none anywhere.** ⌘B only works because `packages/ui/.../sidebar.tsx` has its own independent handler — meaning `KeyboardProvider` intercepts and `preventDefault`s ⌘B for nothing             |
| `open-estimate-switcher` | `shell-config-estimate.ts:78, 200` (⌘⇧O + palette)                                                       | **none**                                                                                                                                                                                        |
| `export-estimate`        | `shell-config-estimate.ts:98` (palette, labelled ⌘⇧E)                                                    | **none** — and there is no `cmd+shift+e` in the `shortcuts` array either, so the badge is doubly decorative                                                                                     |
| `open-create-estimate`   | `shell-config-global.ts:43`                                                                              | ✅ `estimates.tsx:53` — but the command `navigate("/estimates")` then dispatches **synchronously**, so if you aren't already on `/estimates` the listener isn't mounted yet and ⌘N does nothing |
| `open-command-palette`   | `app-sidebar.tsx:59`                                                                                     | ✅ `command-palette.tsx:51`                                                                                                                                                                     |
| `open-project-switcher`  | `momentum/shell-config-project.ts:82, 218`                                                               | ✅ `project-switcher.tsx:71` — **this is the pattern Precision should copy**                                                                                                                    |

`⌘P` is advertised in the palette for "All Estimates" with no registered handler. Four of
Precision's advertised shortcuts do nothing. Per `legacy-crosscutting.md` §2.8, the legacy app had
_zero_ application-level shortcuts — so this isn't a parity gap, it's a quality-bar gap, and dead
shortcuts are worse than no shortcuts because they train users not to trust the layer.

### 1.10 Tauri packaging / updater

The CI is already app-agnostic and **already supports Precision**:
`.github/workflows/release-desktop.yml` triggers on `precision-v*`, builds macOS ARM64 + macOS Intel

- Linux x64 + Windows x64, signs update bundles with `TAURI_SIGNING_PRIVATE_KEY`, passes
  `includeUpdaterJson: true`, and publishes `latest.json` to GitHub Pages at
  `/updates/{app}/latest.json`. It even handles "no `latest.json` found — app does not have updater
  configured. Skipping."

That last branch is exactly what happens today, because the gap is entirely inside the app:

|                                                                                       | Momentum                                                                | Precision                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Cargo.toml` `tauri-plugin-updater`                                                   | ✅ (cfg-gated for macos/windows/linux)                                  | **missing**                                                                                                                                            |
| `Cargo.toml` `tauri-plugin-process`                                                   | ✅                                                                      | **missing**                                                                                                                                            |
| `Cargo.toml` `tauri-plugin-prevent-default`                                           | ✅                                                                      | missing                                                                                                                                                |
| `tauri.conf.json` `plugins.updater` (pubkey + endpoint + `installMode: passive`)      | ✅ endpoint `collinwillis.github.io/truss/updates/momentum/latest.json` | **absent**                                                                                                                                             |
| `bundle.createUpdaterArtifacts: true`                                                 | ✅                                                                      | **absent**                                                                                                                                             |
| `capabilities/default.json` `updater:default`, `process:default`, `core:menu:default` | ✅                                                                      | **absent**                                                                                                                                             |
| `components/update-checker.tsx` + `lib/update-context.tsx`                            | ✅ (200 + 294 LOC)                                                      | **none** — `__root.tsx` passes `undefined` for `onCheckForUpdate` at both shell-config call sites, so "Check for Updates" never appears in the palette |
| `@tauri-apps/plugin-updater` / `plugin-process` in `package.json`                     | ✅                                                                      | **✅ already a dependency** — JS side installed, Rust side absent                                                                                      |
| tauri crate version                                                                   | `2.10`                                                                  | `2`                                                                                                                                                    |
| `csp`                                                                                 | `null`                                                                  | `null` — same gap in both                                                                                                                              |

Against legacy this is still a big win: legacy was Windows-only, unsigned, polled a **public GitHub
Gist** for its manifest, and had its **minisign private key and password committed to git** in
`src/.env` (`legacy-crosscutting.md` B15). None of that is carried forward.

### 1.11 Honest parity score for this domain

- Calculation formulas: **~90%** (12 formulas essentially right; 3 divergences, 1 model gap)
- Rollups: **~55%** (levels correct; quantity/unit, completed, sub-hours, indirect buckets, WBS
  visibility all missing)
- Pools: **~60%** (data + reads present; version model regressed, no fallback ladder, no authoring)
- Export: **~25%** (13 of 37 columns, no decomposition, no header block, no scoping — but one
  engine)
- Admin/permissions: **~40%** (better model, broken page, zero enforcement client _or_ server)
- Shell/nav: **~85%** (real shell, four dead shortcuts)
- Packaging/updater: **~30%** (CI ready, app not wired)

**Domain rollup: ~45%.**

---

## 2. MISSING CAPABILITIES

| Capability                                                                                                                                                                                                                                              | Why it matters                                                                                                                                                                                                                                      | Effort | Blocks others?                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------- |
| **Golden-number test suite for the engine** — 6 activity types × ownership branches × override cases, asserted against outputs captured from live legacy proposals                                                                                      | The engine is the one thing that must be exactly right and has **zero** test coverage. This is why a prior audit "found" a welder bug that doesn't exist and recommended introducing one. Nothing else in this domain is safe to change without it. | M      | **YES — blocks everything**                 |
| **Settle the rounding policy** (§1.3 D2) and apply it in one place                                                                                                                                                                                      | Three different policies exist. Until this is fixed, parallel-run validation produces deltas that look like bugs and aren't.                                                                                                                        | S      | **YES — blocks validation**                 |
| **Fix the sync/edit conflict** — the 6-hourly `upsertProposalsBatch` does `ctx.db.patch(existing._id, proposal)` with a full `mapProposal` payload including all 15 rates (`sync/syncMutations.ts:279`, `crons.ts:30`)                                  | Every rate and detail edit a user makes on a Firestore-origin proposal — i.e. **all production data** — is silently reverted within 6 hours. Rates drive every dollar.                                                                              | S      | **YES — blocks the Rates tab being usable** |
| **Fix the Precision admin page** (`organizationId` → `organization_id`, `banned`→`isBanned`, `role`→`orgRole`, `precisionPermission`→`appPermissions.precision`)                                                                                        | Page renders a skeleton forever. 20 of 28 app-level TS errors.                                                                                                                                                                                      | S      | YES — blocks permission work                |
| **Client write-gating from `workspace.precision_permission`**                                                                                                                                                                                           | A `read` member can create, edit and delete everything. Legacy at least gated every editable cell.                                                                                                                                                  | S      | no                                          |
| **Server-side authorization in `precision.ts`** — identity + org + permission check on all 30 functions                                                                                                                                                 | No function performs any auth check. Any authenticated client can mutate any proposal. Legacy had the same hole (no `firestore.rules`), so this is a platform decision, not a Precision regression — but it must be closed before cutover.          | L      | no                                          |
| **`organizationId` on `proposals` + scoped `listProposals`**                                                                                                                                                                                            | `listProposals` returns every proposal in the deployment to every user.                                                                                                                                                                             | M      | YES — feeds authorization                   |
| **Full 37-column WBS Cost Report** — proposal header block, 2 markup rows, component decomposition, phase attributes inherited onto activity rows, SPCL RATE/SUB flags, ownership, sub MH, accounting formats, WBS/Phase/Activity/grand-total hierarchy | This is _the_ deliverable of the legacy app. Estimators hand this sheet to clients. `tracking_report.xlsx` is the canonical spec. Non-negotiable for cutover.                                                                                       | L      | no                                          |
| **Component decomposition in the engine** — return `{base, burden, overhead, laborProfit, fuel, consumables, subsistence, laborTotal, rig, profitTotal, salesTax}` per activity                                                                         | Required by the export, and independently the single best UX idea salvaged from the redesign docs: click a cost, see how it was assembled. Cheap because the server already has the rates.                                                          | M      | YES — blocks the real export                |
| **Native save dialog for exports** (`tauri-plugin-dialog`)                                                                                                                                                                                              | Today it's a browser blob download into `~/Downloads`. Legacy let you choose the path. Desktop app should behave like one.                                                                                                                          | S      | no                                          |
| **Phase / WBS quantity & unit** with an explicit user override                                                                                                                                                                                          | Drives the QTY/UNIT columns of the report and the estimators' headline takeoff numbers. Do **not** port the keyword heuristic (see §3).                                                                                                             | M      | no                                          |
| **Sub-hours (`quantity × time`) + mobe/demobe/support/specialty buckets in the summary**                                                                                                                                                                | Bottom-panel parity. `legacy-docs-triage.md` §S6 calls the direct/indirect classification "a hard parity requirement none of the docs mention."                                                                                                     | S      | no                                          |
| **WBS visibility (`wbsToDisplay`) + hidden-data warning**                                                                                                                                                                                               | Scopes the bottom panel _and_ the export in legacy. `userWbsPreferences` / `wbsPoolNamesToDisplay` tables already exist and are orphaned. The amber warning chip is a genuinely good idea worth keeping.                                            | M      | no                                          |
| **Restore 4-axis dataset versioning** (`{labor, phases, wbs, equipment}` each `v1\|v2`, resolve-down per type)                                                                                                                                          | Precision's single `datasetVersion` cannot represent the real model. Fix before more proposals exist.                                                                                                                                               | M      | no                                          |
| **Labor-pool fallback ladder** (phase type → union of the WBS's phase types → full catalog), i.e. port `momentum.getLaborPoolForProject`'s 3-case logic to `precision.getLaborPool`                                                                     | A phase whose type has no labor rows shows an empty catalog with no recovery.                                                                                                                                                                       | S      | no                                          |
| **Pool administration** — create/edit/deactivate rows, author a new dataset version, surface v1→v2 diffs                                                                                                                                                | Legacy has none either, but the REBAR `0.55 → 8` change silently repricing rebar 14.5× is exactly the kind of thing that must be visible.                                                                                                           | L      | no                                          |
| **Per-activity rate overrides (craft base + subsistence), bulk-editable** with legacy's gating rule                                                                                                                                                     | `computeCraftLoadedRate` honors them, the schema stores them, the sync populates them, and **nothing in the UI can set them**. Also unblocks D1 needing a decision.                                                                                 | M      | no                                          |
| **"Reset Constants"** (re-read `laborPool` by `poolId` + version)                                                                                                                                                                                       | Legacy toolbar action. Needs a decision on snapshot-vs-live (§3).                                                                                                                                                                                   | S      | no                                          |
| **Equipment unit ↔ price binding + ownership/unit coupling** (`Hours→hourRate…`, `Purchase↔EA`, `Owned\|Rental↔Months`)                                                                                                                                 | Without it, an equipment row's price cannot be corrected after creation and the unit is meaningless.                                                                                                                                                | S      | no                                          |
| **Wire the 7 dead mutations** — `deleteProposal`, `addWBS`, `deleteWBS`, `updatePhase`, `copyActivitiesToPhase`, `reorderActivities`, `getWBSForProposal` (verified: zero `api.precision.<name>` references in `apps/precision/src`)                    | `addWBS`/`deleteWBS` in particular: every new estimate gets all 18 WBS permanently, with no way to prune.                                                                                                                                           | M      | no                                          |
| **Tauri updater wiring** — 2 Cargo deps, `plugins.updater` block, `createUpdaterArtifacts`, 2 capabilities, promote Momentum's `UpdateChecker`                                                                                                          | Precision cannot self-update. CI already supports it. This is a ~2-hour job.                                                                                                                                                                        | S      | no                                          |
| **Wire or delete `toggle-sidebar` / `open-estimate-switcher` / `export-estimate`; fix the ⌘N race; remove the decorative ⌘P**                                                                                                                           | Four advertised shortcuts do nothing.                                                                                                                                                                                                               | S      | no                                          |
| **Toasts + error surfacing** — `sonner` is a dependency and is **never imported** in `apps/precision/src`; every failure path is `console.error`                                                                                                        | A failed `addActivity` shows the user nothing.                                                                                                                                                                                                      | S      | no                                          |
| **Real `check-types` + `eslint` in both apps**                                                                                                                                                                                                          | `check-types` is an `echo`; no eslint config in either app; 68 TS errors in Precision. Platform gap.                                                                                                                                                | S      | YES — keeps regressions out                 |
| **Unsubscribe `getExportData` from the overview; fold `getProposalSummary` into `getWBSListWithCosts`; paginate export reads**                                                                                                                          | 3× whole-tree read on mount and on every cell edit; the export query will hit Convex's 8 MiB read ceiling first.                                                                                                                                    | M      | no                                          |

---

## 3. REDESIGN RECOMMENDATIONS

### R1 — Do NOT port `getQuantityAndUnit`. Replace it with a declarative, per-WBS rule that estimators can see.

Legacy infers a phase's headline quantity by substring-matching activity **descriptions** against a
hardcoded keyword map (`utils.ts:198`): WBS 70000/130000 match `'HE'`, which also matches `SHEET`,
`THREAD`, `OTHER`. 11 of 18 divisions can never produce a quantity at all. CONCRETE has a special
case that sets the unit from the _last_ activity in iteration order. There are **four divergent
copies** of the heuristic in the legacy repo and they disagree — the one the export uses has no
CONCRETE branch, so concrete phases export blank.

**Instead:** add a `quantityRule` to the `phasePool` row (or `wbsPool`):
`{ mode: "sum-matching" | "none", match: string[], defaultUnit: string }`, seeded from the legacy
map so the outcomes are preserved:

- 20000 SITE PREP → sum `EXCAVATE`, `BACKFILL / COMPACT`; unit `CY`
- 40000 / 50000 / 60000 → sum `CLEAN UP`
- 70000 / 130000 AG/BG PIPING → sum the piping-takeoff activities; unit `LF`
- 30000 CONCRETE → sum `CLEAN UP`; unit `EA` for phase types {30011, 30012, 30013, 30015}, else `CY`

Then render it: the phase row shows `1,240 LF (derived from 3 activities)` with a hover that lists
them, and an explicit override field that always wins. One implementation, server-side, used by
screen and export alike.

**Decision needed from Collin:** legacy also contains a _second_, dead per-WBS unit map
(`api/wbs.ts:90-98`: `{20000:CY, 30000:CY, 40000:TON, 50000:EA, 60000:TON, 70000:LF, 130000:LF}`).
Ask the estimators which behavior they actually rely on before seeding.

### R2 — One override field per concept. Kill the `quantity`/`customQuantity` and `unit`/`customUnit` duality.

Legacy has two fields per concept, **three** reader precedences, and **two** writers — one of which
(the migrating one) is dead, so the migration the code comments describe never happens
(`legacy-calc.md` §9.4, defect B19). Precision's schema already copied both `customQuantity` and
`customUnit` onto `wbs` and `phases` — good, but do not also add the legacy `quantity`/`unit` slots.
Model it as `derived` (computed, never stored) + `override` (nullable, stored).
`override ?? derived`, one reader, one writer, everywhere.

### R3 — Make the export a projection of the engine, never a second implementation.

The single most expensive bug class in the legacy app: `data_dump.ts` reimplements the math and
understates every subcontractor line by `quantity × material × salesTaxRate`, and applies
per-activity subsistence overrides to welder hours where the app does not (`legacy-calc.md` §11.3,
both proven). The estimator's screen and the estimator's bid sheet disagree.

Precision already has this right (`getExportData` → `computeActivityCosts`). **Encode it as an
invariant:** extend `ActivityCosts` with the component decomposition
(`base, burden, overhead, laborProfit, fuel, consumables, subsistence, laborTotal, rig, profitTotal, salesTax`)
so the 37-column report is a pure _projection_ of one struct. Add a test that asserts
`sum(components) === totalCost` for every activity type. If a report ever needs a number the engine
doesn't produce, the fix is to add it to the engine.

### R4 — Emit live Excel formulas, not baked values.

`tracking_report.xlsx` — the hand-built 2021 template the Data Dump was reverse-engineered from — is
**all formulas**: `U = ($Qn*$U$13)+((Rn*$R$13))`, `AB = SUM(Un:AAn)`, rollups as `=SUM(child rows)`
(`legacy-crosscutting.md` §4.5). The app's export replaced them with static values. That is why the
markup rows exist at all: they are the _inputs_ the formulas reference.

Emitting formulas costs almost nothing with ExcelJS and gives estimators the thing they actually
want — an exported sheet they can what-if on. It also makes the export self-verifying: if the
sheet's own formulas disagree with the server's number, one of them is wrong and you'll see it
immediately. **Also fix the column offset:** the app's export inserts `SYS` at L and shifts
everything right by one vs. the template, so anyone with a downstream sheet keyed to fixed columns
is already broken. Decide whether to match the template exactly or version the layout explicitly.

### R5 — Snapshot the catalog values, don't just reference them.

Precision stores `laborPoolId` + `labor.{craftConstant, welderConstant}`. That's the right shape,
but add `labor.sourceVersion` and `labor.sourceValues` (the pool values at add time). Then:

- "Reset Constants" restores `sourceValues` — deterministic, no re-read, works even if the pool row
  changed.
- The grid can show "overridden" vs "catalog" per row — which is the signal legacy's `SPCL RATE`
  column tries to convey and gets wrong (defect B14: costs are fine but the override flag drifts).
- Dataset version bumps become inspectable: "12 activities use a constant that changed in v2."

### R6 — Make the ambiguous semantics an explicit, versioned decision — and stamp it on the proposal.

Three questions the legacy code answers inconsistently:

1. Does a per-activity subsistence override apply to welder hours? App says **no**; export says
   **yes**. (`legacy-calc.md` §11.3.)
2. Does an override of `0` mean "$0/hr" or "inherit"? Legacy `||` says inherit; Precision `??` says
   $0.
3. Where does rounding happen? Three answers today (§1.3 D2).

Put a `calcVersion: number` on the proposal and pin the semantics per version. Old proposals keep
their numbers; new ones get the corrected ones. This is the only way to fix a formula without
silently repricing historical bids — and legacy has **no** protection against that at all: editing a
rate re-prices every activity in the proposal including phases already marked `completed`
(`legacy-calc.md` §12.1).

### R7 — Don't build a cache. Fix the query shape first.

`MCP_ESTIMATOR_REDESIGN.md` prescribes materialized views with a `WHERE` clause that isn't valid
PostgreSQL, and a cached `activity_costs` table — both void against the Convex bet
(`legacy-docs-triage.md` §3.2 #13, §3.3). Precision's compute-on-read is correct. The problem is
that the overview subscribes to **three** whole-tree reads simultaneously and one of them exists
only to enable a button. Do §1.5 steps 1-3. Only consider denormalization after you have measured a
real proposal against the 16,384-doc / 8 MiB per-query ceiling.

### R8 — Ship the updater with the release, not after it.

Precision has the JS packages, the CI, and the GitHub Pages manifest pipeline. It's missing 2 Cargo
deps, one `tauri.conf.json` block, `createUpdaterArtifacts: true`, 2 capability strings, and a UI
component that already exists in Momentum. Do it _before_ the first internal build goes out, because
the first build without an updater is a build you have to chase people down to replace. And do not
carry forward legacy's approach: a public Gist manifest, unsigned Windows-only installers, and the
minisign private key committed to git.

### R9 — Uppercase is a display/normalization concern, not a storage mutation.

Legacy force-uppercases every non-numeric value on write (`store.ts`) _and_ every text input via the
MUI theme — including the search boxes. It corrupts `unit` (`'Months'` → `'MONTHS'`), which breaks
the equipment price lookup and puts the `Select` out of range (defect B15). The convention itself is
real and worth keeping (industry expectation). Implement it as an input mask + a normalize-on-write
list that explicitly **excludes** enum-valued fields (`unit`, `ownership`, `status`, `bidType`) and
person names.

### R10 — Adopt Momentum's landing-surface and switcher patterns wholesale for Collin's stated pain points.

Collin specifically hates the legacy proposal home screen and proposal info entry. The answer is not
to redesign from scratch — Momentum's `projects.tsx` (recents, pinning, tile/list toggle, 4 sort
modes, all persisted, real empty states) and `ProjectSwitcher` (cmdk, search, recents, and it
**listens for its own open event**) already solve exactly these problems and have been through a
real polish pass. See §4.

---

## 4. SHARED UI PLAN

Ordered by value-per-day. Only components in _this_ domain — the add-activity/add-phase dialog
promotion is covered by `momentum-reuse.md` §2 and should be done first regardless.

| #   | Component                                                                 | Build once at                                                                       | What it replaces                                                                                                                                                                                                                                                                      | Cost                            | Payoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`UpdateProvider` + `UpdateChecker`**                                    | `packages/features/src/updater/`                                                    | `momentum/src/components/update-checker.tsx` (200) + `lib/update-context.tsx` (294); Precision has nothing                                                                                                                                                                            | **~2 h**                        | Precision gains auto-update. App-agnostic except the literal string "Momentum" in 3 copy strings → one `appName` prop. Must land with the Cargo/capability changes.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **`isWorkspaceAdmin(workspace)`**                                         | `packages/features/src/organizations/permissions.ts` (already exists, add it there) | `momentum/src/lib/permissions.ts` (21 LOC, 5 call sites); Precision inlines `role === "owner" \|\| "admin"` in 3 places and **gets the org-id field name wrong in the 4th**                                                                                                           | **~15 min**                     | Directly fixes the broken admin page. The Momentum version already encodes a non-obvious rule (the personal-workspace fallback with a null `organization_id` is why the members query hangs) — that comment is the whole reason to share it.                                                                                                                                                                                                                                                                                                                                      |
| 3   | **`AdminMembersPage` + `AdminMemberDetail`**                              | `packages/features/src/admin/` (the package already exists with only `types.ts`)    | `momentum/src/routes/admin/index.tsx` + `member.$memberId.tsx` vs Precision's stale forks with 20 TS errors and 2 never-called mutation handles                                                                                                                                       | **~1 day**                      | Both call the **same** `adminUsers` / `appPermissions` Convex functions against the **same** Better Auth org. There is no app-specific logic beyond which app's permission column to emphasize — one `app: "precision"\|"momentum"` prop. This deletes Precision's broken fork rather than repairing it.                                                                                                                                                                                                                                                                          |
| 4   | **`ScopeTotalsBar`** (generalized `BottomPanel`)                          | `packages/features/src/shared/scope-totals-bar.tsx`                                 | `estimation/bottom-panel.tsx` (262, persists to `localStorage["precision:bp"]`) + Momentum's `ProjectStatusSlices` (359, persists to `localStorage["momentum:workbook:statusCollapsed"]`)                                                                                             | **~1 day**                      | Two implementations of "persisted collapsible summary bar scoped to the current level." Share the **chrome** (bar, collapse, persistence key, scope label, pluralization, formatters) and keep the _metric renderer_ pluggable — Momentum shows MH slices, Precision shows cost buckets. `momentum-reuse.md` §3.2 argues to leave them separate; I disagree on the chrome specifically, because Precision must add sub-hours + 4 indirect buckets + a hidden-WBS warning chip and it'd be re-solving collapse/persist a third time.                                               |
| 5   | **`useGridKeyboardNav` + `GridCellInput`**                                | `packages/features/src/shared/grid/`                                                | `estimation/editable-cell.tsx` (177) + `progress-tracking/entry-cell-input.tsx` (176) — the **same** state machine, same 350 ms `DEBOUNCE_MS` constant, same escape-ref discard, independently written twice; plus two hand-rolled `querySelectorAll("input[data-*-cell]")` nav loops | **~0.5 day**                    | This is the riskiest duplication in the repo: two focus/commit state machines drifting apart while Precision's grid is about to grow from 2 editable columns to ~10. Do it **before** that growth. Also fixes the `EditableCell` API lie (`readOnly` without `onCommit` is 6 of Precision's TS errors). Target contract: legacy's `excel_navigation_data_grid.tsx` — F2 / Tab / Shift+Tab / Enter / Shift+Enter / Delete / Backspace / type-to-replace / Escape-discards / skip-non-editable / wrap. That file is the best asset in the legacy repo and no prior doc mentions it. |
| 6   | **`exportWorkbook(blob, filename)` download/save helper**                 | `packages/features/src/shared/download.ts`                                          | `precision/src/routes/.../index.tsx:119-131` (blob + `<a download>`) and Momentum's equivalent                                                                                                                                                                                        | **~2 h**                        | Small, but it's where the Tauri native save dialog goes. Do it once and both apps get a real file picker instead of a silent `~/Downloads` drop. The _workbooks themselves_ should stay separate — a 37-column estimate report and a progress tracking sheet share nothing but boilerplate (`momentum-reuse.md` §3.3 is right about this).                                                                                                                                                                                                                                        |
| 7   | **`PoolBrowser`** (cmdk catalog picker) + `SelectedItemCard`              | `packages/features/src/activities/`                                                 | Momentum's `add-activity-dialog.tsx` internals vs Precision's hand-rolled `Input` + `ScrollArea` of `<button>`s with no keyboard nav                                                                                                                                                  | ships with the dialog promotion | Also the right widget for Precision's `/pools/labor` and `/pools/equipment` browsers, and for future pool administration. Both apps read the **same** `laborPool`/`equipmentPool` tables with identical row shapes.                                                                                                                                                                                                                                                                                                                                                               |
| 8   | **`TableSkeleton` / `ListSkeleton`**                                      | `packages/features/src/shared/skeletons.tsx`                                        | `momentum/src/components/skeletons.tsx` (114); Precision hand-rolls one per route in **4** routes                                                                                                                                                                                     | **~0.25 day**                   | Pure deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9   | **`AsyncJobPanel`** (staged progress + non-dismissible-while-busy dialog) | `packages/features/src/shared/`                                                     | `momentum/create-project-dialog.tsx:98-221, 289-295`                                                                                                                                                                                                                                  | **~0.5 day**                    | Precision's `duplicate-estimate-dialog` shows a bare spinner for an operation that deep-copies a whole tree. Also the right chrome for a long export and for a future dataset-version migration.                                                                                                                                                                                                                                                                                                                                                                                  |

**Where things should live.** `packages/features/src/estimation/` currently holds only 4 files
(`types.ts`, `index.ts`, `editable-cell.tsx`, `bottom-panel.tsx`) and
`packages/features/src/index.ts` does **not** re-export `./estimation` — consumers must use the
subpath. That package is the natural home for estimating-specific shared code, and it is nearly
empty. Genuinely app-agnostic pieces (updater, skeletons, download, admin, grid primitives, async
job panel) belong in `packages/features/src/shared/` and `packages/features/src/{updater,admin}/`,
not in `estimation/`.

**Promotion cost accounting.** Items 1, 2, 6, 8 total under a day and are pure wins. Items 3, 4, 5
are ~2.5 days and each deletes a broken or duplicated Precision implementation rather than adding to
it — i.e. the promotion _is_ the bug fix. Nothing here requires touching Momentum's behavior, which
matters because Momentum is in heavy production use.

---

## 5. RISKS AND UNKNOWNS

### Needs a decision from Collin

1. **Rounding policy.** Round at the activity, at the phase, or only at display? Precision currently
   rounds man-hours _before_ costing, which neither legacy path does. Whatever you pick, it changes
   totals by a few dollars per thousand lines relative to the legacy screen. **Decide before any
   parallel-run validation**, or you'll chase phantom bugs.
2. **Zero-value rate overrides.** Should a per-activity craft base rate of `0` mean "$0/hr" or
   "inherit from proposal"? Legacy says inherit (via `||`); Precision says $0 (via `??`). Precision
   is right, but it's a behavior change and the estimators may have used `0` as "inherit."
3. **Per-activity subsistence on welder hours.** App says no, export says yes. One answer.
4. **Which quantity/unit rule is real** — the live keyword heuristic, or the dead per-WBS unit map
   (`{20000:CY, 30000:CY, 40000:TON, 50000:EA, 60000:TON, 70000:LF, 130000:LF}`)? Ask an estimator,
   not the code.
5. **Excel formulas or values?** The 2021 template is all formulas; the app export baked them out.
   Formulas make the sheet what-if-able and self-verifying. Also: match the template's column layout
   exactly (no `SYS`), or version the layout and accept that downstream sheets break?
6. **Is the 37-column WBS Cost Report the _only_ report at cutover, or do we add a client-facing
   summary?** The legacy app has exactly one export. `MCP_ESTIMATOR_PRAGMATIC_REWRITE.md` lists PDF
   export as "parity" — it is not; no PDF export exists anywhere in the legacy source.
7. **Immutable bid snapshots?** Today (both apps) editing a rate re-prices every activity in the
   proposal, including phases marked `completed`. There is no versioning, no snapshot, no warning.
   If a bid has been submitted, should it be frozen?
8. **Cutover model for the Firestore sync.** Either Precision becomes the write authority and the
   proposals cron stops patching user-owned fields, or legacy-origin proposals are explicitly
   read-only in Precision until a one-shot migration. There is no third option — the current state
   silently destroys user edits every 6 hours.
9. **Multi-tenancy scope.** `proposals` has no `organizationId` and `listProposals` returns
   everything to everyone. Is Precision single-tenant (InDemand only) forever, or does it need org
   scoping like Momentum? This determines how much of the authorization work is needed.

### Technical unknowns

- **Real proposal size.** I could not measure production activity counts from this repo. The 10k
  figure comes from `legacy-calc.md` §9.1. If real proposals are 2-3k activities, §1.5 items 1-2 are
  sufficient forever; if they're 15k+, the export query needs pagination on day one.
- **Convex read ceiling in practice.** The 16,384-doc / 8 MiB per-query limit is the binding
  constraint, not CPU. Needs one measurement against the largest real proposal before committing to
  the compute-on-read bet at scale.
- **Are the pools fully seeded in production Convex?** I found no seed/import mutation for
  `laborPool`/`equipmentPool`/`phasePool`/`wbsPool` anywhere in `packages/backend/convex` — the data
  was loaded out-of-band. That means there is **no repeatable path to re-seed or to author a v2
  dataset.** Worth confirming before pool administration is scoped.
- **`csp: null` in both apps.** Same as legacy. A real CSP is on the quality bar but may break the
  Convex/Better Auth connections; needs a spike.
- **Whether the `precision-v*` release path has ever run.** The workflow supports it, but the "no
  `latest.json` found" branch suggests it has been exercised without an updater. First real
  Precision release should be a dry run on a `-beta` tag.

### Risks

- **The biggest risk in this domain is a confident wrong fix.** One prior audit report recommends
  changing `computeWelderLoadedRate` in a way that would introduce a real wrong-dollar bug, based on
  reading a dead file. Until golden-number tests exist, treat every "the formula is wrong" claim as
  unverified — including mine.
- **Two audits disagree** on the welder formula. Reconcile explicitly before anyone touches the
  engine, and delete `src/utils/calculations.ts` from any reference material handed to future
  agents.
- **No tests + no typecheck + no lint** in either app means an engine change can ship broken. This
  is a platform gap that Precision inherits, not a Precision-specific failing — but Precision is the
  app where wrong numbers cost money.
- **Legacy defects must not be ported.** From `legacy-calc.md` / `legacy-crosscutting.md`: the
  forged MUI X Pro license key (`App.tsx:29-35`, a legal exposure), the `'phases'` vs `'phase'`
  collection typo that orphans every phase of a deleted proposal, the `in`-clause 10-item caps, the
  committed minisign private key. Precision has avoided all of these so far. Keep it that way.
- **`copyActivitiesToPhase` gets the hard part right** (it remaps `proposalId` and `wbsId`, fixing
  legacy's worst bug B1) but does **not** remap `laborPoolId`/constants to the target phase's
  `phasePoolId`. Legacy's dead `api/phase.ts::copyActivitiesFromPhase` did that remap — and silently
  dropped activities with no match. Decide which behavior you want before wiring the UI.

---

## 6. SUGGESTED WORK BREAKDOWN

Ordered. Each chunk is independently shippable.

**Chunk 0 — Stop the bleeding (0.5 day)**

- Fix `workspace?.organizationId` → `organization_id` and the stale member field names
  (`banned`→`isBanned`, `role`→`orgRole`, `precisionPermission`→`appPermissions.precision`) in both
  Precision admin routes.
- Fix the two `useRef<ReturnType<typeof setTimeout>>()` calls and the 6 `EditableCell` `readOnly`
  prop errors. Get `apps/precision` to **0** app-level TS errors.
- Turn `check-types` into a real `tsc --noEmit` in both apps; add `eslint.config.mjs`; wire both
  into CI so this can't regress.
- Delete or wire the three dead custom events; fix the ⌘N race; remove the decorative ⌘P badge.

**Chunk 1 — Lock the engine (2-3 days) — do this before touching any formula**

- Capture golden numbers from 3-5 real legacy proposals covering all 6 activity types, both
  equipment ownership branches, and at least one activity with rate overrides.
- Write the test suite in `packages/backend` asserting `computeActivityCosts` against them.
- Settle and implement the rounding policy (§5 decision 1). Document it in the engine's JSDoc.
- Settle the `??`/`||` and welder-subsistence semantics; add `calcVersion` to the proposal.
- **Correct the JSDoc situation:** the `computeWelderLoadedRate` comment is right; add a pointer
  noting that `mcp_estimator/src/utils/calculations.ts` is dead and carries a different formula, so
  the next reader doesn't repeat the mistake.

**Chunk 2 — Sync/edit conflict + write-gating (1 day)**

- Make `upsertProposalsBatch` skip user-owned fields on existing records (or mark Firestore-origin
  proposals read-only in Precision, per §5 decision 8).
- Promote `isWorkspaceAdmin` to `@truss/features/organizations/permissions`; gate every Precision
  mutation call site on `workspace.precision_permission`.
- Add `sonner` toasts to every mutation path (replaces ~8 `console.error` sites).

**Chunk 3 — Engine completeness (3-4 days)**

- Extend `ActivityCosts` with the component decomposition (base, burden, overhead, laborProfit,
  fuel, consumables, subsistence, laborTotal, rig, profitTotal, salesTax) + the `sum === total`
  invariant test.
- Add sub-hours (`quantity × time`) and the four indirect buckets (mobe/demobe/support/specialty) to
  `getProposalSummary`.
- Add derived phase/WBS quantity + unit via a declarative `quantityRule` on the pool (§R1), with
  `override ?? derived`.
- Derive WBS `isCompleted` from its phases.
- Restore the 4-axis `datasetVersions` model.
- Port Momentum's labor-pool fallback ladder into `precision.getLaborPool`.

**Chunk 4 — Query shape / scale (1 day)**

- Unsubscribe `getExportData` from the overview; make export an on-demand fetch.
- Fold `getProposalSummary` into `getWBSListWithCosts` (one read of the tree).
- Paginate `getExportData` per-WBS.
- Measure against the largest real proposal; record the doc count and read bytes.

**Chunk 5 — The real export (3-4 days)**

- Rebuild `export-excel.ts` as the 37-column WBS Cost Report: proposal header block, the two markup
  rows carrying all 15 rates, phase attributes inherited onto activity rows, SPCL RATE/SPCL SUB
  boxed-cell flags, ownership, sub MH, accounting number formats, WBS/Phase/Activity/grand-total
  hierarchy with the legacy fills (blue/yellow/green) and the section-grouping right borders.
- Emit live formulas (§R4) if decision 5 says so.
- Fix the duplicate header row and the `|| ""` zero handling.
- Add `tauri-plugin-dialog` and a native save dialog via the shared download helper.
- Scope by WBS visibility with an explicit "N WBS excluded, $X not shown" warning **on the export
  dialog** — legacy silently drops them.

**Chunk 6 — Platform / packaging (1 day)**

- Add `tauri-plugin-updater` + `tauri-plugin-process` to `apps/precision/src-tauri/Cargo.toml`; add
  the `plugins.updater` block (pubkey +
  `https://collinwillis.github.io/truss/updates/precision/latest.json`
  - `installMode: passive`); add `bundle.createUpdaterArtifacts: true`; add `updater:default` and
    `process:default` to `capabilities/default.json`.
- Promote `UpdateProvider`/`UpdateChecker` to `packages/features/src/updater/` with an `appName`
  prop; wire `onCheckForUpdate` in both Precision shell configs.
- Dry-run a `precision-v0.1.1-beta` tag through `release-desktop.yml`.
- Bump `tauri` to `2.10` to match Momentum.

**Chunk 7 — Shared UI promotion (2.5 days)** — items 3, 4, 5, 8 from §4

- `AdminMembersPage`/`AdminMemberDetail` → `@truss/features/admin`; delete Precision's fork.
- `GridCellInput` + `useGridKeyboardNav` → `@truss/features/shared/grid`; **do this before** the
  activity grid grows past 2 editable columns.
- `ScopeTotalsBar` chrome with a pluggable metric renderer.
- Shared skeleton primitives.

**Chunk 8 — Editing surface (ongoing, feeds other domains)**

- Wire `updatePhase`, `addWBS`, `deleteWBS`, `deleteProposal`, `copyActivitiesToPhase`,
  `reorderActivities`.
- Per-activity rate overrides + bulk edit, with legacy's gating rule.
- "Reset Constants" against a `labor.sourceValues` snapshot (§R5).
- Equipment unit ↔ price binding and the ownership/unit coupling.

**Chunk 9 — Server-side authorization (L, schedule separately)**

- `organizationId` on `proposals`; scope `listProposals`.
- Identity + org + permission checks across all 30 `precision.ts` functions (and the equivalent in
  `momentum.ts` — it's the same hole).

---

## Files referenced

**Truss**

- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/precision.ts` (1,749 lines —
  engine at 142-311, rollups at 633-950, export at 1630-1749)
- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/schema.ts`
- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/crons.ts`
- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/sync/syncMutations.ts`
  (`upsertProposalsBatch`)
- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/sync/fieldMapping.ts`
  (`mapProposal`, `mapActivity`)
- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/appPermissions.ts`,
  `adminUsers.ts`
- `/Users/collinwillis/Dev/Personal/truss/packages/backend/convex/momentum.ts`
  (`getLaborPoolForProject`)
- `/Users/collinwillis/Dev/Personal/truss/apps/precision/src/lib/export-excel.ts`
- `/Users/collinwillis/Dev/Personal/truss/apps/precision/src/routes/estimate/$estimateId.index.tsx`
- `/Users/collinwillis/Dev/Personal/truss/apps/precision/src/routes/admin/index.tsx`
- `/Users/collinwillis/Dev/Personal/truss/apps/precision/src/config/shell-config-estimate.ts`
- `/Users/collinwillis/Dev/Personal/truss/apps/precision/src-tauri/Cargo.toml`, `tauri.conf.json`,
  `capabilities/default.json`
- `/Users/collinwillis/Dev/Personal/truss/apps/momentum/src-tauri/Cargo.toml`, `tauri.conf.json`,
  `capabilities/default.json`
- `/Users/collinwillis/Dev/Personal/truss/apps/momentum/src/lib/permissions.ts`
- `/Users/collinwillis/Dev/Personal/truss/.github/workflows/release-desktop.yml`
- `/Users/collinwillis/Dev/Personal/truss/packages/features/src/estimation/bottom-panel.tsx`,
  `editable-cell.tsx`, `index.ts`
- `/Users/collinwillis/Dev/Personal/truss/packages/features/src/organizations/types.ts`

**Legacy**

- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/api/totals.ts` (**the** live engine)
- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/utils/utils.ts` (`processRawActivity`,
  `getQuantityAndUnit`, `calculateTotals`, `calculateWbsTotals`)
- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/utils/calculations.ts` (**DEAD** — different
  welder formula, do not use as reference)
- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/api/data_dump.ts` (`activityToDataDumpItem` —
  the divergent second engine)
- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/api/tracking_report.xlsx` (canonical formula
  spec, referenced by no code)
- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/components/bottom_pannel.tsx` (direct/indirect
  classification)
- `/Users/collinwillis/Dev/Personal/mcp_estimator/src/components/excel_navigation_data_grid.tsx`
  (the keyboard contract to match)
