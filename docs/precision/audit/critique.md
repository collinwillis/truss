# Adversarial critique of the Precision / MCP-Estimator audit

**Method.** I re-walked `/Users/collinwillis/Dev/Personal/mcp_estimator` (all of `src/`,
`functions/`, `src-tauri/`, `public/`, root `*.sql`, root `*.txt`), re-read
`packages/backend/convex/precision.ts`, `schema.ts`, `sync/*`, `auth.ts` and `apps/precision/src`,
and — where a claim was about production data — **queried the live Convex deployment**
(`focused-civet-250`) directly. Every claim below is either traced to a file+line or to a query
result printed inline.

Verdict up front: `gap-engine-and-platform.md` and `gap-wbs-phase.md` are strong and hold up under
checking. `gap-activity-grid.md` contains one **actively dangerous** wrong claim. The audit as a
whole has one **entire uncovered domain** (auth/identity), several parity-checklist items that fell
off the floor between the inventory reports and the gap reports, and — most importantly — **one
production data-corruption class that no report found**, which will make Precision's WBS totals
disagree with its own phase totals on real estimates.

---

## 1. WRONG-DOLLAR RISKS THE AUDIT MISSED OR UNDERSTATED

### W1 — `activity.wbsId` disagrees with `phase.wbsId` in production data. VERIFIED IN PROD. (New.)

**No report covers this.** It is the highest-consequence finding in this critique.

Legacy's copy-activities path writes only `phaseId`:

`mcp_estimator/src/newAPI/api.ts:236-245` (`copyActivitiesFromPhaseToPhaseInFirestore`)

```ts
const newActivityData = { ...activityDoc.data(), phaseId: toPhaseId, createdAt: new Date() };
```

`wbsId` (and `proposalId`) are copied verbatim from the **source** activity. Copy a phase's
activities into a phase under a different WBS and the new rows permanently claim the old WBS.

The Convex importer preserves the damage rather than repairing it —
`packages/backend/convex/sync/fieldMapping.ts:245`:

```ts
fsWbsId: str(fs.wbsId),          // taken from the activity, never derived from its phase
```

and `sync/syncMutations.ts:236-249` resolves that id straight into `activities.wbsId`.

**Measured on live prod** (34 proposals, 6,008 activities scanned before the read budget):
`mismatch: 4` rows, all in proposal **2042**. Small in that sample, unbounded across 713 proposals.

Why it matters in Precision specifically — the two rollups group by _different_ keys:

| Query                                | Groups by                                                   | File                     |
| ------------------------------------ | ----------------------------------------------------------- | ------------------------ |
| `getPhaseListWithCosts`              | `phaseId` (`by_wbs` for the fetch, then `activity.phaseId`) | `precision.ts:761-782`   |
| `getWBSListWithCosts`                | **`activity.wbsId`**                                        | `precision.ts:836-857`   |
| `getProposalSummary` direct/indirect | **`activity.wbsId`** vs `INDIRECT_WBS_POOL_IDS`             | `precision.ts:924`       |
| `getExportData`                      | nests phases under WBS, activities under phase              | `precision.ts:1655-1680` |

So on a proposal containing these rows: the WBS table shows cost under WBS **A**, the phase
drill-down under that WBS's phase shows it under WBS **B**, the export shows it under **B**, and the
bottom-panel direct/indirect split classifies its hours by **A**. Four surfaces, three answers, no
error. Legacy hid this because its phase rollup keyed on `phaseId` and only `getQuantityAndUnit`
keyed on `wbsId` — so legacy's symptom was a wrong _quantity_, not a wrong _cost bucket_.

`gap-engine-and-platform.md §1.4` gets close ("an activity whose `wbsId` points at a deleted WBS…")
but frames it as hypothetical ("today the only way to orphan is a bad import"). It is not
hypothetical, the WBS is not deleted, and the mechanism is a legacy bug faithfully imported.

**Fix:** derive `wbsId` from the phase at write time (a one-line change in `mapActivity` /
`syncMutations`), plus a repair migration, plus an invariant assertion. Do it before any
parallel-run validation, or every reconciliation on an affected proposal will chase a ghost.

### W2 — The engine and the importer contradict each other on subcontractor labor.

`precision.ts:243-244` is explicit and deliberate:

```
// ── Step 4: Welder cost — ALWAYS calculated (even subcontractor in legacy) ──
costs.welderCost = round2(costs.welderManHours * welderLoaded);
```

That is correct legacy behavior (`src/api/activity.ts:548` computes `welderCost` for every type;
only `craftCost` is suppressed at :533, and `calculateTotals` at `src/utils/utils.ts:298` adds
`welderCost` unconditionally while excluding sub rows from craft/material/equipment).

But `sync/fieldMapping.ts:203-206` writes `labor` **only when `type !== "subcontractor"`**, so
`activity.labor` is `undefined` on every imported sub row → `craftConstant`/`welderConstant` = 0 →
`welderCost` and `welderManHours` are always 0 for subcontractor rows in Precision.

Live check: 109 subcontractor rows in the scanned sample, **0** carry labor — so it is latent today,
not live. But the engine claims a behavior the data model cannot express, and the moment Precision
ships a UI that lets a sub row carry a welder constant, the two diverge silently. Pick one: either
drop the Step-4 comment and suppress welder on sub rows deliberately, or map the constants.

### W3 — The export-vs-screen divergence is larger than `q · material · salesTax`.

`gap-engine-and-platform.md §1.7` names exactly one export math defect. Reading
`src/api/data_dump.ts::activityToDataDumpItem` (lines 538-668) there are **five**, all client-facing
because this sheet is the bid deliverable:

1. **Labor markups applied to subcontractor rows.** `craftBase` (:562) is
   `(customCraftRate ?? craftBaseRate)·craftMH + weldBaseRate·welderMH` with **no type guard**, and
   burden/overhead/laborProfit/fuel/consumables/subsistence all derive from it. The screen
   suppresses `craftCost` for sub rows (`api/activity.ts:533`). A sub row with any constant is
   priced in the export and not on screen.
2. **Custom subsistence leaks onto welder hours.** Export (:573-575):
   `subsistence = (craftMH + welderMH) · (customSubsistenceRate ?? proposal.subsistenceRate)`.
   Screen: `getWelderLoadedRate` (`api/totals.ts:44-74`) always uses the **proposal**
   `subsistenceRate`; the override only reaches craft. Any activity with a subsistence override
   prices differently in the two places.
3. **Owned equipment loses its labor in the export.** `total: isOwnedEquip ? equipmentCost : …`
   (:658-668) — an owned-equipment row carrying craft or welder hours contributes those costs on
   screen (`getTotalCost` sums all six legs) and **zero** of them in the export.
4. **Owned equipment emits a use-tax cell its own total ignores.** `salesTax` (:586-588) adds
   `equipmentCost · useTaxRate/100` for all equipment rows including owned; the owned branch of
   `total` never adds it. The SALES TAX column and the TOTAL column disagree on the same row.
5. **`getSubProfit()` (:539-548) is dead and buggy** —
   `materialProfit = baseActivity.craftCost * (subProfit + salesTax)` uses `craftCost` where it
   means `materialCost`. Zero call sites. Flag it as poison so nobody "restores" it while porting.

Precision inherits none of these (one engine — keep that), but they matter for **validation**: if
anyone reconciles Precision against a legacy _export_, these five will read as Precision bugs.

### W4 — Three implementations of `getQuantityAndUnit`, and the export uses the weakest one.

No report enumerates this; all three treat it as one function.

| Impl                                            | Live?    | Consumer                                                                 | WBS 30000 (CONCRETE) handling                                                                            |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `src/utils/utils.ts:198` `getQuantityAndUnit`   | **live** | `src/utils/store.ts:34` (the screen)                                     | unit = `EA` if phase id ∈ {30011,30012,30013,30015} else `CY`; quantity += rows matching `/clean\s*up/i` |
| `src/api/activity.ts:569` `getQuantityAndUnit`  | dead     | `hooks/phase_hook.ts`, `hooks/wbs_hook.ts` — neither hook has a consumer | sets the unit but **never accumulates quantity**                                                         |
| `src/utils/utils.ts:248` `getDDQuantityAndUnit` | **live** | `src/api/data_dump.ts:19` (the export)                                   | **none at all**                                                                                          |

Consequence: for CONCRETE, the screen shows a quantity in `CY`/`EA` and the exported bid sheet shows
`0` with a blank unit. `gap-engine-and-platform.md R1` ("do not port `getQuantityAndUnit`") is the
right call, but the replacement rule has to be specified against the _screen_ variant, and someone
has to decide what CONCRETE's takeoff quantity actually is — the legacy answer is two different
numbers.

### W5 — 36 of 713 production proposals have `craftBaseRate = 0` **and** `weldBaseRate = 0`.

Queried live. Any parallel-run validation that lands on one of these returns `$0.00` from both
engines and proves nothing. Choose validation proposals deliberately — and note `1734` (11,131
activities) has `rigRate: 0`, `fuelRate: 0`, `consumablesRate: 0`, `weldBaseRate: 0`, so it
exercises almost none of the markup paths despite being the biggest estimate.

### W6 — Rounding (affirming D2, with one addition).

`gap-engine-and-platform.md §1.3 D2` is correct and important. One thing it misses: `round2` is also
applied to `craftManHours`/`welderManHours` (`precision.ts:227-228`), and man-hours are a
**displayed and reported** quantity, not just an intermediate. Legacy displays them unrounded on
screen (`store.ts` path) and rounds only at export (`currencyRound(baseActivity.craftManHours)`,
`data_dump.ts:619`). So Precision will show a different MH figure than legacy for any
non-terminating `qty × constant`, independent of any cost.

---

## 2. COVERAGE HOLES

### H-A — Auth, registration and identity: **zero coverage in all four gap reports.**

`legacy-crosscutting.md §9` lists ten essential auth capabilities. Grepping the four gap reports:
`"password reset"` → 0 hits. `"allow-list"` → 0. `"disabled"` → 0. Not one of the following appears
in any missing-capability table:

- Email-domain allow-list on registration (legacy: `indemandis.com`, `tidybrackets.com`,
  `outlook.com`)
- Email verification required before app access, auto-send at registration, resend, "I've verified"
  path
- Password reset by email from the sign-in screen
- Blocking sign-in for `disabled` / `deleted` accounts **and terminating the session**
- Human-readable auth error messages
- Route guard with a real loading state

Current truss reality, verified in `packages/backend/convex/auth.ts`:

|                        | Legacy                         | Truss / Precision                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| email verification     | required, gated                | `requireEmailVerification: false` (:99), `autoSignIn: true`                                                                                                                                                                                                                                                      |
| domain restriction     | hard-coded 3-domain allow-list | `allowedDomains` is declared as an org field (:212) and **enforced nowhere** — grep across `packages/` + `apps/` finds only the schema declaration and a pass-through into `workspace-context.tsx:144`                                                                                                           |
| password reset         | yes                            | yes, Resend-based (:100-129) — **this one is parity or better**                                                                                                                                                                                                                                                  |
| disabled-account block | yes                            | Better Auth `admin()` plugin ships ban support (:199); nothing in `apps/precision/src` checks it                                                                                                                                                                                                                 |
| org assignment         | n/a                            | `databaseHooks.session.create.before` (:172-190) **force-pins every new session to the InDemand org**, while `organization({ allowUserToCreateOrganization: true, organizationLimit: 10 })` invites users to create their own. These two decisions are in direct conflict and will fight any multi-tenancy work. |

Combine with the verified facts that `precision.ts` contains **zero** `ctx.auth` / `getAuthUserId`
calls (grep count: 0 across all 30 functions) and `proposals` has no `organizationId`
(`schema.ts:353-399`) and the exposure is stronger than gap-engine states. It is not "any
authenticated client can mutate any proposal" — with open, unverified, undomained email signup it is
**anyone on the internet who signs up**, against 713 real bids.

### H-B — The four root `*.sql` files were dismissed in one line and never read.

`legacy-crosscutting.md:1067` files them under "committed junk / migration experiments". They are
not junk; they are a prior _design_ pass, and they contain requirements that appear in **no** gap
report:

`supabase_schema_final.sql` — `proposal_snapshots` (:668), `proposal_status_history` (:684),
`audit_log` (:651), `activity_templates` (:720), `user_preferences` (:703), plus on `activities`:
`custom_weld_rate` (a per-activity **welder** rate override, which neither legacy nor Precision
has), `equipment_time_unit CHECK (hour|day|week|month)` (Precision stores a free `unit` string), and
per-activity `notes`. `universal_supabase_schema.sql` adds `approvals`, `comments`,
`project_versions` and a `calculate_work_item_cost()` SQL function.

None of these are parity requirements — but "estimate versioning / snapshots", "who changed this
rate" (which `gap-estimate-lifecycle.md` independently reaches as "Audit trail for rate changes")
and "per-activity notes" are real product decisions that past-Collin already wrote down. They
deserve a triage line each, not a dismissal. **Also flag the trap:** `calculate_work_item_cost()` is
a _third_ cost formula in this repo. It has no authority. Do not validate against it.

### H-C — The `timesheet_*.txt` / `work_log_items_library.txt` files encode **no** domain requirements.

The brief hypothesized they might. They do not, and someone should be told so explicitly before they
mine them. `work_log_items_library.txt` is self-describing: _"Comprehensive list of realistic
development tasks for timesheet entries… Items marked ✓ USED have been utilized in timesheets."_ It
is a phrase library for filling out billing timesheets, containing invented items like "Fixed
calculation error in welder loaded rate when rig profit rate was zero". **Any agent that mines this
file for requirements will hallucinate bugs that were never real** — and note how close that
particular line sits to the false welder claim in §3 C1. The `timesheet_*.txt` files are hour grids
plus work-log prose. Treat both as billing artifacts. Recommend deleting them from any reference
bundle.

### H-D — Files no report names at all.

`src/models/data_dump/data_dump_{activity,phase,wbs}.ts` (the export row/rollup shapes — the actual
37-column contract lives here, and gap-engine's "full 37-column report" work item points at no
schema), `src/hooks/current_phase_hook.ts`, `src/hooks/current_wbs_hook.ts`,
`src/models/firestore models/proposal_preferences_firestore.ts`,
`src/features/auth/presentation/components/{auth_card,header}.tsx`,
`src/components/drawer_icon.tsx`. Only the `data_dump` models matter; the rest are noise. (Overall
file coverage across the reports is otherwise good — I cross-referenced all 126 legacy source files
by basename.)

### H-E — `contacts` has a write-nothing / read-nothing dead end.

`schema.ts:320` defines a `contacts` table; `proposals.contactId` references it. A repo-wide grep
for `"contacts"` across `packages/backend/convex/` returns **exactly one** hit outside the schema:
`precision.ts:542`, the `updateProposal` arg. There is no `createContact`, no `getContact`, and
`getProposal` (:350-372) returns the raw `contactId` with no join. So the legacy proposal form's
seven contact fields are unreachable in Precision _by construction_, not just "no UI yet".
`gap-estimate-lifecycle.md` lists "Contact capture (7 fields)" and §5.7 raises the inline-vs-entity
decision — good — but neither notes that the entity path needs three mutations and a join query that
do not exist, so the "S (inline) / L (entity)" estimate understates the entity branch.

### H-F — Cross-app blast radius: Precision can orphan a live Momentum project.

`momentumProjects.proposalId: v.id("proposals")` (`schema.ts:568`). `precision.deleteProposal`
(:591-627) cascades activities → phases → WBS → proposal and **never checks `momentumProjects`**.
Convex does not enforce referential integrity, so the project keeps a dangling id. Momentum is
_fully released and in heavy production use_. Likewise `updateProposal` / `updateProposalRates`
mutate the same row Momentum reads. No report treats the shared `proposals` table as a cross-app
coupling risk. Given that `deleteProposal` is currently dead code, this is cheap to fix **now**,
before the delete UI ships.

---

## 3. CLAIMS THAT DO NOT HOLD

### C1 — `gap-activity-grid.md`: "`computeWelderLoadedRate` omits `rigProfitRate` … Every welder cost in Precision is understated." **FALSE, and its remediation is harmful.**

`gap-engine-and-platform.md §0` and `gap-estimate-lifecycle.md §5.1` both say the opposite. I
settled it against source rather than by vote:

```
$ grep -rn "utils/calculations" src/ | grep -v "^src/utils/calculations.ts"
(no output — exit 1)
$ grep -rln "api/totals" src/
src/features/proposal home/proposal_home.tsx
src/utils/utils.ts
src/hooks/rates_hook.ts
src/api/activity.ts
```

`src/utils/calculations.ts` has **zero importers**. It is dead, and it is the only file that folds
`rigProfitRate` into the weld-base multiplier (`calculations.ts:58-72`). The live engine
(`src/api/totals.ts:44-74`) excludes it, exactly as `precision.ts:179-195` does.

This is not a bookkeeping error — `gap-activity-grid.md` §2 item **#1** is "fix `rigProfitRate`" and
is marked **"Blocks other work: Yes"**, i.e. it is scheduled first. Executing it would **overstate**
every welder hour by `weldBaseRate × rigProfitRate / 100`. On live proposal `2020`
(`weldBaseRate 40.7`, `rigProfitRate 10`) that is **+$4.07 per welder hour**, applied to every
welder hour in the estimate. **Strike item #1's `rigProfitRate` clause and the corresponding row in
§1 "What is present but wrong" before anyone reads that report as a work order.** (The rest of item
#1 — extract the engine, add golden-number tests, move `round2` to the boundary — is right and
should survive.)

### C2 — `gap-wbs-phase.md` H1: "Today prod has 200 proposals, all synced, 0 native."

Live count: **713 proposals**, 0 native (`firestoreId` present on all 713). The "0 native" half is
right and is the load-bearing part of H1, so the conclusion stands — but 713 is the number, and it
changes the scale of every migration/repair estimate in that report by 3.5×.

### C3 — `gap-engine-and-platform.md §1.4`: phase and WBS "quantity / unit → **absent**".

Half right. The **storage** exists: `wbs.customQuantity` / `wbs.customUnit` (`schema.ts:419-420`),
`phases.customQuantity` / `phases.customUnit` (:466-467), and even `proposals.customQuantity` /
`proposals.customUnit` (:396-397). What is absent is (a) the derivation and (b) any read path — no
query in `precision.ts` returns these fields, and `updateProposal` / `updatePhase` cannot set them.
Worth correcting because the report's own R2 ("kill the `quantity`/`customQuantity` duality") is
aimed at a duality that Precision has **already** half-imported.

### C4 — Sync clobber scope is stated three different ways across three reports.

- `gap-estimate-lifecycle.md §1.5`: proposals only, cites `syncMutations.ts:283`.
- `gap-engine-and-platform.md §2`: proposals only, cites `:279`.
- `gap-activity-grid.md`: activities too, cites `:248`.

Source: `sync/syncMutations.ts` full-tree upsert patches **wbs (:172), phases (:207), activities
(:249)**, and `upsertProposalsBatch` patches **proposals (:279)** — the correct line is 279,
not 283. `crons.ts` schedules **only** `syncProposals` (every 6h); the full tree runs on demand from
`momentum.createProjectFromProposal`. So the accurate statement is: _proposal metadata and all 15
rates are reverted on a 6-hour schedule; WBS / phase / activity edits are reverted whenever anyone
creates a Momentum project from that proposal._ The three reports should be reconciled to that
sentence — the activity-level clobber is the more destructive one and only one report has it.

### C5 — `gap-activity-grid.md` #20: "Legacy's `CopyActivitiesFromProposalDialog` is heavily used."

Unsupported, and the name misleads. `src/components/copy_activities_from_proposal_dialog.tsx:41-47`
sources its phase list from `state.phases[proposalId]` — **the current proposal only**. There is no
cross-proposal copy in legacy. `gap-wbs-phase.md` H6 has this right. No usage telemetry exists in
either repo, so "heavily used" is an assertion about a customer workflow presented as a finding; it
should be re-labelled as a question for Collin.

### C6 — TS-error counts disagree and neither is reproduced here.

`gap-engine-and-platform.md §1.8`: "68 total errors, 28 at `src/`".
`gap-estimate-lifecycle.md §5.12`: "27 app-level TS errors". I did not re-run `tsc`, so I flag the
discrepancy rather than resolve it — but note that both reports independently confirm `check-types`
in both apps is literally an `echo`, which is the finding that actually matters.

**Claims I checked and that DO hold** (worth affirming so nobody re-litigates them): the 7 dead
mutations list is exact (`getWBSForProposal`, `deleteProposal`, `addWBS`, `deleteWBS`,
`updatePhase`, `copyActivitiesToPhase`, `reorderActivities` — verified by enumerating every
`api.precision.*` reference in `apps/precision/src` + `packages/features/src`); `getExportData` is
subscribed at `$estimateId.index.tsx:82`; `fieldMapping.ts:209-214` does guard overrides on
non-zero; zero `ctx.auth` in `precision.ts`; `proposals` has no `organizationId`; the
`wbsPool.sortOrder` table in `gap-wbs-phase.md` H1 matches the live table row-for-row; the legacy
override-eligibility rule (custom-labor **or** WBS 200000 **or** phase ∈ {180002,180003,180004}) is
at `activity_data_grid.tsx:551-564`; the legacy phase-number rule (`max(non-reserved, wbsCode) + 1`,
reserved catalog ids used verbatim) is at `add_phase_dialog.tsx:100-140`; the equipment unit↔price
binding is at `newAPI/api.ts:309-345` with the ownership↔unit coupling at :346-385.

---

## 4. PARITY-CHECKLIST ITEMS THAT FELL OFF THE FLOOR

Present in an inventory report's PARITY CHECKLIST, absent from every gap report's missing-capability
table:

**Duplication (from `legacy-home.md` §7 and `legacy-crosscutting.md` §9)**

- Revision numbering derived from the source (`base + 0.1`, `+ 0.2`, …) with **existing revisions
  detected**. Precision's `duplicate-estimate-dialog.tsx:52-58` does pure local arithmetic on the
  source string — `base + 0.1`, or `base + 0.01` if it already contains a `.` — and **never queries
  for collisions**. Duplicating `1734` twice produces `1734.1` twice. `gap-estimate-lifecycle.md`
  covers a duplicate-number guard for _creation_ only.
- The `" - Rev N"` description suffix, and stripping an existing suffix before appending. Not
  implemented, not listed anywhere.
- "Handle proposals large enough to exceed a single write batch." `duplicateProposal`
  (`precision.ts:1501`) is one mutation; proposal `1734` has **11,131 activities** (measured).
  Convex mutation write limits make this a guaranteed failure on the largest estimates. No report
  raises it.

**Auth / admin** — the entire block from §2 H-A above, plus "confirmation before destructive admin
actions".

**Shell / session memory (`legacy-crosscutting.md` §9)** — remember and restore the last-selected
proposal; remember the last-selected tab; nav collapse state; window size/position persistence; an
explicit "reload this proposal's data" affordance.

**Grid persistence** — "per-grid sort/filter/density persistence". `gap-activity-grid.md` #19 covers
column _visibility_ only.

**Export ergonomics** — progress indication + cancel path + a real error message during export; a
named worksheet (legacy emits `readme demo`). Neither appears in the export work item.

---

## 5. TWO SCALE / DATA FACTS THAT SHOULD SHAPE THE PLAN

- **`getProposalSummary` is already at ~68% of Convex's document read ceiling on one real
  estimate.** Proposal `1734` returned **11,131 activities** from a single `by_proposal` collect
  (measured live); add its phases and WBS and one query is reading ~13.4k of the 16,384-document
  limit — and the overview subscribes three such queries (`$estimateId.index.tsx:79-82`).
  `gap-engine-and-platform.md §1.5` reaches the right conclusion from an estimated 10k; the real
  number is 11,131 and it is already there, not "at scale later".
- **23 duplicate `proposalNumber` values already exist in production** (measured: `1579`, `1594`,
  `1630`, `1636`, `1639`, `1689`, `1789`, `1790`, `1887`, `1918`, … ×2 each). The recommended
  uniqueness constraint / duplicate-number guard **cannot be applied to existing data** without a
  cleanup pass, and any "jump to proposal number" UX has to handle collisions. No report notes this.

---

## 6. WHAT I WOULD CHANGE IN THE PLAN, IN ORDER

1. **Strike the `rigProfitRate` "fix"** from `gap-activity-grid.md` §1/§2-#1. It is scheduled first
   and it is a wrong-dollar change. Delete `src/utils/calculations.ts` from the reference bundle.
2. **Repair `activity.wbsId` at the sync boundary and in the existing data**, then add an invariant
   assertion. Until then Precision's WBS totals cannot be trusted against its own phase totals, and
   no reconciliation is meaningful.
3. **Add auth/identity as a fifth domain** with its own gap report. Open unverified signup + no
   domain allow-list + zero server-side authorization + no org scoping over 713 real bids is the
   largest uncovered risk in the audit.
4. **Reconcile the sync-clobber statement** to one sentence across the three reports, with the
   activity-level clobber named explicitly.
5. **Fold the export-math divergences (W3) into the golden-number test suite** as _negative_ cases —
   they are the traps a validator will hit first.
6. **Guard `deleteProposal` against `momentumProjects`** before the delete UI ships.
7. **Purge `work_log_items_library.txt` and `timesheet_*.txt` from the reference set**, and triage
   the four `*.sql` files as a product wish-list rather than junk.
