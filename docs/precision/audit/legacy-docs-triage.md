# Legacy Docs Triage — MCP Estimator prior analysis/redesign documents

Scope: triage of five documents in `/Users/collinwillis/Dev/Personal/mcp_estimator/`, verified
line-by-line against the actual source in `/Users/collinwillis/Dev/Personal/mcp_estimator/src/` at
HEAD (`553a865`, 2026-06-03).

---

## 0. Provenance — read this first

| Fact                                                                                              | Evidence                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All three big docs are dated **2026-02-15 12:04**                                                 | `ls -la` mtime                                                                                                                                                                                                                  |
| **None of them are tracked in git**                                                               | `git ls-files \| grep MCP_ESTIMATOR` → empty. Same for `CLAUDE.md`/`WARP.md`. They are untracked local artifacts, never reviewed in a PR.                                                                                       |
| HEAD is **2026-06-03**, ~3.5 months of commits after the docs                                     | `git log --format='%h %ad'`                                                                                                                                                                                                     |
| `WARP.md` is a **symlink to `CLAUDE.md`** — not a separate document                               | `lrwxr-xr-x WARP.md -> CLAUDE.md`                                                                                                                                                                                               |
| Critically: the ANALYSIS doc's structural claims were **already wrong on the day it was written** | `git show 641d66c:"src/features/proposal home/proposal_home.tsx"` (the Feb 15 commit) already used `<Tabs>`, not accordions; `git ls-tree -r 641d66c src/data` already showed `v1/`+`v2/` JSON, not `wbs.json`/`constants.json` |

**Implication:** these documents were not written by reading the repo they describe. The _formula_
content is accurate (it was almost certainly transcribed from `src/api/totals.ts`), but essentially
every claim about **file paths, UI structure, data flow, and configuration shape** is unreliable.
Treat formulas as verified; treat everything else as a hypothesis.

---

# DOCUMENT 1 — `MCP_ESTIMATOR_ANALYSIS.md` (~60 KB, 2091 lines)

## 1.1 What it is

A descriptive "as-built" technical analysis. 13 numbered sections: architecture, hierarchy, data
models with field-by-field annotations, reference libraries, the 6 activity types, the calculation
engine with worked numeric examples, 13 data-entry workflows, cost aggregation, UI components, and
ASCII data-flow diagrams. No recommendations — pure description.

Structurally it is the most useful of the three because it is the only one that tries to enumerate
_what exists_. Its per-field annotations on Proposal/WBS/Phase/Activity are the single highest-value
artifact across all three documents.

## 1.2 Spot-verification (15 claims)

| #   | Claim (doc §)                                                                                                             | Verdict                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Proposal has `constantDataSet?: string` = `"2025"` or default (§3.1 "Configuration")                                      | ❌ **FALSE**                                               | `src/models/proposal.ts:106` — the field is `datasetVersions?: Partial<DatasetVersions>`. `constantDataSet` does not exist anywhere in `src/`.                                                                                                                                                                                                                                                                                                                                          |
| 2   | Reference data at `src/data/wbs.json`, `phases.json`, `constants.json`, `equipment.json`, `2025/constants_2025.json` (§4) | ❌ **FALSE**                                               | Actual: `src/data/v1/{wbs_v1,phases_v1,labor_v1,equipment_v1}.json` and `src/data/v2/{labor_v2,equipment_v2}.json`, wired in `src/data/datasets.ts:1-21`. Already true on 2026-02-15.                                                                                                                                                                                                                                                                                                   |
| 3   | WBS library = 18 standard disciplines, IDs 10000…200000 (§3.2)                                                            | ✅ **TRUE**                                                | `wbs_v1.json` = 18 records; ID/name pairs match the doc's JSON block exactly, and match `src/utils/enums.ts:7-97`.                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | "Hundreds of phase templates", "thousands of constants", "hundreds of equipment items" (§4)                               | ✅ **TRUE**                                                | phases_v1 = **228**; labor_v1 = **5,897**, labor_v2 = **5,968**; equipment_v1 = **129**, equipment_v2 = **133**.                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Calculation engine lives in `src/api/totals.ts` (§6)                                                                      | ✅ **TRUE**                                                | `src/api/totals.ts:6,44,77,87,99,123,130` — all seven functions.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | Craft loaded rate formula (§6.1)                                                                                          | ✅ **TRUE**                                                | `src/api/totals.ts:30-40`, exact match.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | Welder loaded rate formula (§6.2)                                                                                         | ✅ **TRUE for the live engine** — but doc omits a landmine | `src/api/totals.ts:61-73` matches. **However** a second, never-imported copy exists at `src/utils/calculations.ts:42-73` that uses a _different_ formula — it folds `rigProfitRate` into the markup sum applied to `weldBaseRate`. Two disagreeing "sources of truth" in one repo; the doc mentions only one.                                                                                                                                                                           |
| 8   | Material / equipment / subcontractor / cost-only / total formulas (§6.3–6.7)                                              | ✅ **TRUE**                                                | `src/api/totals.ts:77-148`, all five exact.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 9   | Special phase-quantity keyword logic per WBS (§8.2)                                                                       | ✅ **TRUE**                                                | `src/api/activity.ts:576-610` — `keywordMap` = 20000→[EXCAVATE, BACKFILL / COMPACT], 40000/50000/60000→[CLEAN UP], 70000/130000→[HE]; WBS 30000 sets unit `EA` when `constant.phaseDatabaseId ∈ {30011,30012,30013,30015}` else `CY`.                                                                                                                                                                                                                                                   |
| 10  | WBS unit map 20000 CY / 30000 CY / 40000 TON / 50000 EA / 60000 TON / 70000 LF / 130000 LF (§8.3)                         | ✅ **TRUE**                                                | `src/api/wbs.ts:90-98`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 11  | Proposal Home = "Proposal Details Accordion" + "Proposal Rates Accordion" (§9.1)                                          | ❌ **FALSE**                                               | `proposal_home.tsx:135-160` renders MUI `<Tabs>` — `Details` / `Rates` / `WBS Data Grid` — feeding `ProposalDetails` and `ProposalRates`. `proposal_info_accordion.tsx` and `proposal_rates_accordion.tsx` exist but have **zero importers** (grep) → dead code. Was already tabs on 2026-02-15.                                                                                                                                                                                        |
| 12  | Load flow = per-WBS → per-phase → per-activity nested fetches (§10.3)                                                     | ❌ **FALSE for the primary path**                          | Live path is `utils/store.ts:105 loadFullProposalData` → `newAPI/api.ts:82 fetchProposalData`, which fires **three flat `where('proposalId','==')` queries in `Promise.all`** and aggregates in memory. The nested N+1 path (`api/phase.ts:232 getPhasesForWbs` → `api/activity.ts:382 getActivitiesForPhase`, which re-fetches the proposal **once per phase**) still exists but is reached only via `hooks/wbs_hook.ts`, used by the add-phase / copy-phase / edit-base-rate dialogs. |
| 13  | Firestore collections incl. `proposalPreferences`, `wbsToDisplay` = array of WBS **IDs** (§10.4)                          | ⚠️ **PARTLY FALSE**                                        | `proposals`/`wbs`/`phase`/`activities`/`visibilityModels` are correct (`api/helpers.ts:8`). But the preferences collection is `'proposal-preferences'` (`newAPI/api.ts:97,109`), and `wbsToDisplay` stores WBS **names** (`select_wbs_dialog.tsx:102-107` toggles `wbs.name`; `store.ts:187` filters by name).                                                                                                                                                                          |
| 14  | "Real-time listeners; changes propagate immediately across all users" (§13.1)                                             | ⚠️ **HALF-TRUE**                                           | `onSnapshot` exists in `hooks/{proposals,wbs,phase,proposal_preferences,current_proposal_listener,activity}_hook`. But the three main grids read the Zustand store, hydrated by one-shot `getDocs`. `activity_hook.ts` and `rates_hook.ts` have zero importers; `current_proposal_listener_hook` is used only by the two dead accordions → transitively dead.                                                                                                                           |
| 15  | Phase Home hosts Add-Activity/Equipment dialogs and the add-Material/Cost-Only/Custom-Labor buttons (§7.6, §9.3)          | ⚠️ **RELOCATED**                                           | The API functions are real (`api/activity.ts:233-360`). But `phase_home.tsx` is a **35-line shell** rendering `<ActivityDataGrid/>` + `<BottomPanel/>`. The quick-add buttons now live in `components/bottom_pannel.tsx:289+`.                                                                                                                                                                                                                                                          |

**Score: 7 fully held, 3 partly, 5 false.** Every false claim is structural (paths, UI, flow); every
true claim is either a formula or a data constant.

## 1.3 What the doc completely misses

Four shipping capabilities appear in none of the three documents:

1. **Excel-grade keyboard navigation** — `src/components/excel_navigation_data_grid.tsx` (816
   lines).
2. **Direct vs. indirect man-hour classification** in `bottom_pannel.tsx` (see Salvaged Facts §S6).
3. **The per-activity-type column allowlists** in `columns.tsx:523-645`.
4. **Constant remapping on cross-phase copy** in `api/phase.ts:178-197`.

## 1.4 VERDICT: **USE THIS — with the structural half stripped out**

Keep §3 (data models), §4 (libraries), §5 (activity types), §6 (formulas), §8.2/§8.3 (quantity/unit
special logic), §11 (data-entry point inventory). Delete or ignore §9 (UI components), §10 (data
flow), §13.1 (real-time claims), and every file path in the document.

---

# DOCUMENT 2 — `MCP_ESTIMATOR_PRAGMATIC_REWRITE.md` (~57 KB, 1795 lines)

## 2.1 What it is

A 3–4-month solo rewrite plan positioned explicitly as the de-scoped counterweight to Document 3.
Structure: why-rewrite → keep/cut list → feature requirements → tech stack → full PostgreSQL DDL →
folder structure → ASCII UI mockups → a complete TypeScript calculation module → migration strategy
→ week-by-week 16-week timeline.

Its most useful content is the **explicit "That's it. No: …" cut lists** at the end of each feature
section. Those are decisions, and decisions are the scarcest thing in these documents.

## 2.2 Spot-verification (12 claims)

| #   | Claim (doc §)                                                                                       | Verdict                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 6 activity types: labor, material, equipment, sub, cost-only, custom labor (§2, §3.5)               | ✅ **TRUE**                                 | `src/models/activity.ts:138-145`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | All five calculation formulas reproduced "exact same as current" (§3.6)                             | ✅ **TRUE**                                 | Match `src/api/totals.ts` line-for-line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Its reference implementation `calculateCraftLoadedRate` uses `??` for the custom-rate fallback (§8) | ❌ **SILENT BEHAVIOR CHANGE**               | Legacy uses `\|\|` (`api/totals.ts:26-27`), and `calculateActivityData` **always passes a number** — `rawActivity.craftBaseRate ?? proposalCraftBase` (`api/activity.ts:514-515`, passed at `:526-527`). Under `\|\|`, a stored `0` falls back to the proposal rate. Under the doc's `??`, a stored `0` becomes a genuine $0/hr rate. This silently changes costs on any activity whose custom rate was ever zeroed.                                                                                                     |
| 4   | Parity export = "Excel **and PDF**" (§3.7, §2 keep-list)                                            | ⚠️ **HALF**                                 | Excel is real: `api/data_dump.ts:4` imports `xlsx-js-style`; `:679-696` writes `.xlsx` via the Tauri `save` dialog + `writeBinaryFile`. There is **no PDF export anywhere in `src/`**. PDF is aspirational, mislabeled as parity.                                                                                                                                                                                                                                                                                        |
| 5   | "User roles (admin, estimator, viewer)" (§3.1)                                                      | ❌ **FALSE**                                | `src/models/user.ts`: `UserRole { user, admin }` **×** `UserPermission { read, readWrite }` — a 2×2, surfaced as `isAdmin` / `hasWritePermissions` (`hooks/user_profile_hook.ts:28-31`). No "estimator" or "viewer" role exists.                                                                                                                                                                                                                                                                                         |
| 6   | "Organization isolation (each company sees only their data)" as parity (§3.1)                       | ❌ **NOT IN LEGACY**                        | No org/tenant/company concept anywhere in `src/`. Legitimate new requirement — but it is not parity, and Truss already solves it via `@truss/features/organizations`.                                                                                                                                                                                                                                                                                                                                                    |
| 7   | `constant_data_set VARCHAR(50) DEFAULT 'default' -- 'default' or '2025'` (§5 DDL)                   | ❌ **FALSE**                                | Real model: four **independent per-DataType versions** (`labor`, `phases`, `wbs`, `equipment`), each `'v1' \| 'v2'`, with graceful downgrade when a version is missing for a type (`data/datasets.ts:23-44`). Only `labor` and `equipment` have a v2. New proposals are stamped `buildDatasetVersions(CURRENT_DATA_VERSION='v2')` at creation (`api/proposal.ts:27,31`), so a v2 proposal actually resolves to labor=v2, equipment=v2, phases=v1, wbs=v1. A single `constant_data_set` column **cannot represent this**. |
| 8   | "WBS: no custom creation, no reordering, no templates" (§3.3)                                       | ✅ **TRUE**                                 | `api/wbs.ts:23-42 insertAllBaseWbs` seeds all 18 from the library at proposal creation; the only user control is show/hide.                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | "Show/hide WBS items" (§3.3)                                                                        | ✅ **TRUE**                                 | `select_wbs_dialog.tsx` + `ProposalPreferences.wbsToDisplay` + `store.ts:264 setVisibleWbs`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 10  | "Rate change = recalculate entire proposal (10+ seconds)" (§1)                                      | ⚠️ **DIRECTIONALLY TRUE, NUMBER UNSOURCED** | Saving rates calls `updateSingleProposal` then `await loadFullProposalData(proposalId)` (`proposal_home.tsx:63-74`) — a full 3-query refetch plus in-memory recompute of every activity. Real. "10+ seconds" is asserted, never measured. **The doc also misses the worse bug here:** the save uses Firestore `setDoc` (full-document overwrite, `api/proposal.ts:104`), and the editors spread `...currentProposal` first — so any field absent from `editData` is silently destroyed.                                  |
| 11  | "Filter by activity type or description" (§3.5)                                                     | ⚠️ **PARTIAL**                              | The generic MUI DataGrid filter panel is available; there is no activity-type filter control. Type-awareness is expressed as **column visibility** (`api/helpers.ts:10-99`), not filtering.                                                                                                                                                                                                                                                                                                                              |
| 12  | Whole stack: Next.js 15 + PostgreSQL + Prisma + NextAuth + Vercel + Neon (§4, §6)                   | ❌ **CONTRADICTS TRUSS**                    | Precision is Tauri v2 + React 19 + Vite; backend is Convex (`packages/backend/convex/precision.ts`); auth is Better Auth. Every hosting, ORM, auth, and API-route prescription in this document is void.                                                                                                                                                                                                                                                                                                                 |

## 2.3 What survives

- The **cut lists** (§2 "CUTTING", and each "That's it. No: …") are reusable scope decisions.
- The **feature requirement enumeration** (§3.1–3.8) is a decent parity checklist — after removing
  the three items that were never in the legacy app (PDF export, org isolation, three-tier roles).
- The **calculation dispatcher shape** (`switch (activityType)`) maps cleanly onto a Convex module —
  but fix the `??`/`||` bug before copying it.

## 2.4 VERDICT: **USE THIS FOR SCOPE ONLY — IGNORE ALL ARCHITECTURE**

Salvage §2 and §3. Discard §4 (stack), §5 (DDL), §6 (folder structure), §9 (migration —
Firestore→Convex is a different problem), §10 (timeline — written for a Next.js greenfield, not for
a Tauri app that already exists).

---

# DOCUMENT 3 — `MCP_ESTIMATOR_REDESIGN.md` (~161 KB, 4166 lines)

## 3.1 What it is

The maximalist vision document. 13 sections plus appendix: problem analysis, design principles with
quantified targets, a full-stack diagram spanning ~15 services, ~530 lines of PostgreSQL DDL, four
alternative UI "view modes", AI/LLM natural-language activity entry, Yjs CRDT collaboration,
calculation engine 2.0, performance/caching, security, PWA/offline, integrations (Bluebeam, Procore,
QuickBooks), and a 12-month 5-phase roadmap.

Roughly 85% of its volume describes software that does not exist and was never started.

## 3.2 Spot-verification (13 claims)

| #   | Claim (doc §)                                                                                                                                                                | Verdict                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Appendix "Calculation Compatibility" — 7 formulas, "100% Compatible"                                                                                                         | ✅ **TRUE**                                       | Match `src/api/totals.ts` exactly. Identical to Docs 1 & 2 → three independent transcriptions agree; treat these formulas as **confirmed**.                                                                                                                                                                                                                                                                                                                                                          |
| 2   | WBS library seed, 18 rows (§4.1)                                                                                                                                             | ✅ **TRUE**                                       | Matches `wbs_v1.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | "Grid-Only Editing — single view mode" (§1.1)                                                                                                                                | ✅ **TRUE**                                       | Only view is the MUI DataGrid at each level.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | "No Undo/Redo — permanent deletions" (§1.1)                                                                                                                                  | ✅ **TRUE**                                       | `api/activity.ts:362 deleteActivityBatch` and `api/phase.ts:93 deletePhaseBatch` are hard `batch.delete`. Only guard is the `alert_dialog.tsx` confirm. No soft delete, no trash, no history.                                                                                                                                                                                                                                                                                                        |
| 5   | "No Version Control / no audit trail" (§1.1)                                                                                                                                 | ✅ **TRUE**                                       | No history collection; no `updatedBy`/`updatedAt` on any model.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | "No Bulk Operations — must edit items individually" (§1.1)                                                                                                                   | ❌ **FALSE**                                      | Bulk delete, bulk `resetConstantsBatch` (`api/activity.ts:370`), and bulk `updateActivityRates` (`:453`) are all live, driven by DataGrid checkbox multi-select from the toolbar (`activity_data_grid.tsx:322-379`). Plus `duplicatePhases` and `copyActivitiesFromPhase`.                                                                                                                                                                                                                           |
| 7   | "No Template System — copy-paste entire proposals" (§1.1)                                                                                                                    | ⚠️ **HALF**                                       | No template _entity_ — true. But `duplicatePhases` (`api/phase.ts:101`) and `copyActivitiesFromPhase` (`:156`) exist. The latter does something the doc never mentions: when source and target `phaseDatabaseId` differ, it **remaps each labor activity to the equivalently-named constant in the target phase** (`:178-197`).                                                                                                                                                                      |
| 8   | "Flat collections → orphaned records possible" (§1.1)                                                                                                                        | ✅ **TRUE — and there is a live instance**        | `api/proposal.ts:135` deletes from collection `'phases'`, while every reader/writer uses `'phase'` singular (`api/phase.ts:28,34,61,96,108,150`; `newAPI/api.ts:48,114`). **Deleting a proposal orphans every one of its phase documents.**                                                                                                                                                                                                                                                          |
| 9   | "Rate changes = recalculate ENTIRE proposal" (§1.1)                                                                                                                          | ✅ **TRUE**                                       | See Doc 2 claim #10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10  | Multi-modal views, NL entry, ML cost prediction, Yjs CRDT, Pinecone, Temporal, Meilisearch, Kanban, what-if scenarios, PWA/offline, Bluebeam/Procore/QuickBooks integrations | ❌ **NONE BUILT**                                 | Zero corresponding code in `src/`. 100% aspirational.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | Excel-like grid interaction (Tab between cells, copy/paste) presented as a **new** redesign feature (§5.3, §5.8)                                                             | ❌ **ALREADY SHIPPED, AND BETTER THAN DESCRIBED** | `src/components/excel_navigation_data_grid.tsx` — 816 lines, added 2025-11-23 (`c8e8874`), refined through 2025-12. Implements: `F2` toggle-edit, Tab/Shift+Tab in **both** view and edit mode, Enter/Shift+Enter row navigation that auto-enters edit, Delete/Backspace to clear, arrow-key navigation, editable-cell skipping. Consumed by `activity_data_grid.tsx:1179` and `phase_data_grid.tsx:729`. **This is the single most valuable asset in the legacy repo and no document mentions it.** |
| 12  | "Cross-Proposal Copy" listed as new (§5.8)                                                                                                                                   | ✅ **CORRECTLY NEW**                              | Despite the filename `copy_activities_from_proposal_dialog.tsx`, it reads `state.phases[proposalId]` (`:43`) — same-proposal phases only. Cross-proposal copy genuinely does not exist.                                                                                                                                                                                                                                                                                                              |
| 13  | Incremental refresh SQL: `REFRESH MATERIALIZED VIEW CONCURRENTLY phase_totals WHERE phase_id = $1;` (§8.2)                                                                   | ❌ **NOT VALID POSTGRESQL**                       | `REFRESH MATERIALIZED VIEW` accepts no `WHERE` clause. The document's headline "100x faster / <100ms" optimization is **not implementable as written** — a real refresh rescans every activity in every proposal, making it _worse_ than targeted recomputation.                                                                                                                                                                                                                                     |

## 3.3 Where it contradicts the Truss/Convex bet

| Redesign prescribes                                                | Truss/Precision reality                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| GraphQL + Apollo Server v4                                         | Convex functions (`packages/backend/convex/precision.ts`)  |
| PostgreSQL 16 + Prisma + materialized views                        | Convex documents, **computed on read, no pre-aggregation** |
| Cached `activity_costs` table + `calculation_version`              | Directly contradicts the no-pre-aggregation bet            |
| Redis + BullMQ + Temporal background workers                       | No worker tier                                             |
| Yjs/Hocuspocus/Socket.io                                           | Convex reactive queries already give live updates          |
| Meilisearch, Pinecone, MinIO/S3, Python FastAPI ML                 | None planned                                               |
| Next.js on Vercel, PWA/offline, mobile web                         | Precision is a **Tauri desktop app**                       |
| NextAuth / RLS on `current_setting('app.current_organization_id')` | Better Auth + `@truss/features/organizations/permissions`  |

The one architectural idea worth keeping is **§8.3 "Calculation Transparency"** — the drill-down
that shows how a loaded rate was assembled from base + each markup. That is cheap on Convex (the
server already computes it) and directly addresses a real pain: the legacy app shows a `totalCost`
with no way to see where it came from.

## 3.4 VERDICT: **IGNORE THIS — mine three sections and delete the rest**

Keep only: §1.1/§1.2 (the pain-point catalogue, ~90% verified — an excellent redesign input), §8.3
(calculation transparency), and the Appendix (formula confirmation). Everything else is either
already built, contradicts the Convex architecture, or is a 12-month AI/collaboration program that
has nothing to do with reaching parity.

---

# DOCUMENT 4 — `CLAUDE.md` (3.9 KB) / `WARP.md` (symlink)

Short repo orientation file. Spot-checks:

| Claim                                                                          | Verdict                         | Evidence                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hierarchy Proposal → WBS → Phase → Activity                                    | ✅ TRUE                         | Models + routes.                                                                                                                                                                                                                                            |
| Chakra UI **and** MUI + MUI X Data Grid Pro                                    | ✅ TRUE                         | `setup/chakra_theme.tsx` exists; MUI is dominant. Dual UI kits = real tech debt.                                                                                                                                                                            |
| React Router **MemoryRouter**                                                  | ✅ TRUE                         | `App.tsx:2` — `MemoryRouter as Router`. Means no deep-linking and no back/forward from the OS shell.                                                                                                                                                        |
| Route table `/`, `/proposal/:proposalId`, `/…/wbs/:wbsId`, `/…/phase/:phaseId` | ✅ TRUE (incomplete)            | `App.tsx:48-100`. Omits `/login`, `/verify-email`, `/admin`.                                                                                                                                                                                                |
| Zustand stores "for each major entity"                                         | ⚠️ MISLEADING                   | `src/stores/{activity,wbs,phase,preference,proposal}_store.ts` all have **zero importers**. The one live store is `src/utils/store.ts` (798 lines).                                                                                                         |
| "MUI X Data Grid Pro license configured in App.tsx"                            | ⚠️ **UNDERSTATED — LEGAL FLAG** | `App.tsx:29-35` **synthesizes** a license key from an empty order number and `Date.now()`, then MD5s it. This is a license bypass, not a configuration. Precision must not port this pattern; it needs a genuine Data Grid Pro license or a different grid. |
| "Batched writes and real-time listeners where appropriate"                     | ⚠️ HALF                         | Batched writes yes; listeners are partly dead (see Doc 1 #14).                                                                                                                                                                                              |

**VERDICT: USE THIS** — it is short, ~80% accurate, and the most reliable of the five. Correct the
Zustand claim and escalate the license line.

---

# SALVAGED FACTS

Everything below was read directly out of `src/` at HEAD and is safe to carry into Precision.

### S1 — Proposal: complete field list (`src/models/proposal.ts`)

**Identity (4):** `id`, `proposalNumber`, `job`, `coNumber` **Project (6):** `proposalDescription`,
`proposalOwner`, `projectCity`, `projectState`, `jobSiteAddress`, `proposalEstimators` **Dates
(4):** `proposalDateReceived`, `proposalDateDue`, `projectStartDate`, `projectEndDate` — all stored
as `string` (HTML `type="date"`), not Date **Classification (2):** `bidType`, `proposalStatus`
**Contact (7):** `contactName`, `contactAddress`, `contactCity`, `contactState`, `contactZip`
(number), `contactPhone`, `contactEmail` **Quantity (4):** `quantity`, `customQuantity`, `unit`,
`customUnit` **Rollup totals (9):** `craftManHours`, `craftCost`, `welderManHours`, `welderCost`,
`materialCost`, `equipmentCost`, `subContractorCost`, `costOnlyCost`, `totalCost` **Config (1):**
`datasetVersions?: Partial<DatasetVersions>`

### S2 — The 15 rate fields that drive every formula

Currency (4): `craftBaseRate` ($/hr), `weldBaseRate` ($/hr), `subsistenceRate`
($, added flat), `rigRate` ($/hr) Percent markups (5): `burdenRate`, `overheadRate`,
`laborProfitRate`, `fuelRate`, `consumablesRate` Percent taxes (2): `salesTaxRate`, `useTaxRate`
Percent profits (4): `materialProfitRate`, `equipmentProfitRate`, `subContractorProfitRate`,
`rigProfitRate`

All percents are stored as whole numbers and divided by 100 at use. UI labels in
`proposal_rates_accordion.tsx:113-221`: `rigRate` is labelled **"Rig Pay"**, `useTaxRate` is **"Use
Tax"**.

### S3 — Verified formulas (`src/api/totals.ts`, triple-confirmed)

```
craftLoadedRate  = craftBase + craftBase*(burden+overhead+laborProfit+fuel+consumables)/100 + subsistence
                   where craftBase   = customCraftBaseRate  || proposal.craftBaseRate      ← note ||, not ??
                         subsistence = customSubsistenceRate || proposal.subsistenceRate

welderLoadedRate = weldBase + weldBase*(burden+overhead+laborProfit+fuel+consumables)/100
                   + subsistence + rigRate + rigRate*rigProfit/100        ← rigProfit NOT in the weldBase sum

materialCost     = qty * price * (1 + (materialProfit + salesTax)/100)
equipmentCost    = ownership==='Owned' ? qty*time*price
                                       : qty*time*price*(1 + (equipmentProfit + useTax)/100)
subContractorCost= qty * ( craftCost*(1+subProfit)
                         + materialCost*(1+subProfit+salesTax)
                         + equipmentCost*(1+subProfit) )
costOnlyCost     = qty * price
totalCost        = craftCost+welderCost+materialCost+equipmentCost+subContractorCost+costOnlyCost
```

Dispatch order in `calculateActivityData` (`api/activity.ts:470-566`), which matters:

1. `craftConstant = activity.craftConstant ?? constant.craftConstant ?? 0`;
   `welderConstant = activity.welderConstant ?? constant.weldConstant ?? 0`
2. `craftManHours = qty*craftConstant`; `welderManHours = qty*welderConstant`
3. `craftCost = craftManHours * craftLoadedRate` — **skipped for subcontractor items** (`:533`),
   because for subs the `craftCost` field is a user-entered per-unit input
4. `welderCost = welderManHours * welderLoadedRate` — applied to **all** types unconditionally
   (`:548`)
5. Type-specific: equipment → `equipmentCost`; material → `materialCost`; costOnly → `costOnlyCost`;
   sub → `subContractorCost`
6. `totalCost = getTotalCost(...)` **except** subcontractor, where `totalCost = subContractorCost`
   (`:561-565`)
7. `sortOrder` fallback chain: `activity.sortOrder ?? constant.sortOrder ?? dateAdded ?? 0`
   (`:495-498`)

### S4 — The 6 activity types and their per-type field allowlists

Enum (`models/activity.ts:138-145`): `laborItem`, `materialItem`, `equipmentItem`,
`subContractorItem`, `costOnlyItem`, `customLaborItem`.

Visible/editable sets, verbatim from `features/phase home/components/columns.tsx:523-645`:

| Type          | Visible columns                                                                                                                                                    | **Editable**                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| labor         | rowId, description, quantity, unit, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate | rowId, description, quantity, unit, craftConstant, welderConstant                |
| customLabor   | _(identical to labor)_                                                                                                                                             | _(same as labor)_                                                                |
| material      | rowId, description, quantity, price, materialCost, totalCost, unit, craftBaseRate, subsistenceRate                                                                 | rowId, description, quantity, price, unit                                        |
| equipment     | rowId, description, quantity, price, time, unit, equipmentCost, totalCost, craftBaseRate, subsistenceRate, equipmentOwnership                                      | rowId, description, quantity, price, time, unit, equipmentOwnership              |
| costOnly      | rowId, quantity, description, price, costOnlyCost, totalCost, craftBaseRate, subsistenceRate                                                                       | rowId, quantity, description, price                                              |
| subContractor | rowId, quantity, description, time, unit, equipmentCost, materialCost, craftCost, subContractorCost, totalCost, craftBaseRate, subsistenceRate                     | rowId, quantity, description, time, unit, equipmentCost, materialCost, craftCost |

Header labels (`columns2.tsx`): `rowId`→"Item", `time`→"Duration", `craftConstant`→"Craft Const.",
`craftManHours`→"Craft Hours", `craftCost`→"Craft Total", `welderCost`→"Welder Total".

### S5 — Default column visibility + auto-reveal rules (`src/api/helpers.ts:10-99`)

Persisted per user+phase at `visibilityModels/{userId}_{phaseId}`. Default ON: rowId, description,
quantity, unit, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost,
totalCost. Default OFF: time, price, equipmentOwnership, craftBaseRate, subsistenceRate,
equipmentCost, materialCost, costOnlyCost, subContractorCost. Auto-reveal on first load, by activity
types present in the phase:

- equipment present → time, price, equipmentOwnership, equipmentCost
- material present → price, materialCost
- costOnly present → price, costOnlyCost
- subcontractor present → time, equipmentCost, materialCost
- customLabor → **commented out** (`:86-93`), so `subContractorCost` is never auto-revealed either —
  a real gap

### S6 — Direct vs. indirect hours (undocumented in all three docs)

`src/components/bottom_pannel.tsx:29,200-257`:
`INDIRECT_WBS_IDS = {10000 MOBILIZE, 190000 DEMOBILIZE, 200000 SUPPORT, 180000 SPECIALTY SERVICES}`.
Any activity whose WBS is in that set contributes to `mobeHours` / `demobeHours` / `supportHours` /
`specialtyHours`; everything else splits into `directCraftHours` / `directWelderHours`.
`subcontractorHours = quantity × time` for `subContractorItem`. Panel surfaces: Total Cost, Total
Hrs, Direct, Indirect, Sub Hrs; expandable to an hours table (Craft / Welder / Support / Mobe+Demobe
/ Specialty / Subcontractor) and a cost table (Craft / Weld & Rig / Subcontractor / Equipment /
Material / Cost Only). It also warns when hidden WBS items carry non-zero cost (`:479`). **This is a
parity requirement.**

### S7 — Dataset versioning (the real model)

`data/dataset_types.ts`: `DataVersion = 'v1'|'v2'`; `DataType = 'labor'|'phases'|'wbs'|'equipment'`;
`DEFAULT='v1'`, `CURRENT='v2'`. `data/datasets.ts:23-35 resolveDatasetVersion` walks **down** from
the preferred version to the newest available for that type. Availability matrix: labor {v1,v2},
equipment {v1,v2}, phases {v1}, wbs {v1}. A proposal created today records
`{labor:'v2', equipment:'v2', phases:'v1', wbs:'v1'}` (`api/proposal.ts:27`). Existing proposals
with no `datasetVersions` default to all-v1 (`data/proposal_datasets.ts:15-27`). Record counts:
labor_v1 5,897 → labor_v2 5,968; equipment_v1 129 → equipment_v2 133; phases 228; wbs 18.

### S8 — Library record shapes

`Constant` (`models/constant.ts`): `id`, `phaseDatabaseId`, `description`, `sortOrder`,
`craftConstant`, `craftUnits`, `weldConstant`, `weldUnits`. `Equipment` (`models/equipment.ts`):
`id`, `description`, `hourRate`, `dayRate`, `weekRate`, `monthRate`. `EquipmentUnit`: Hours | Days |
Weeks | Months | EA. `EquipmentOwnership`: Rental | Owned | Purchase. Unit→price binding
(`api/activity.ts:130-156`): changing the unit rewrites `price` from the matching rate field.
Ownership transitions (`:158-186`): Purchase→Owned/Rental forces unit "Months";
Owned/Rental→Purchase forces "EA".

### S9 — Enumerations

`BidType`: None, Lump Sum, Time and Materials, Budgetary, Rates, Cost Plus. `ProposalStatus`: None,
Bidding, Submitted, Awarded, Rejected, Declined, Open, Closed. `UnitedStatesStates`: None + 50
states. `UserRole`: user | admin. `UserPermission`: read | readWrite. WBS library (id → name): 10000
MOBILIZE · 20000 SITE PREPARATION · 30000 CONCRETE · 40000 TOWERS/VESSELS/EQUIPMENT · 50000 PUMPS &
DRIVERS · 60000 STRUCTURAL · 70000 AG PIPING · 80000 ELECTRICAL · 90000 INSTRUMENTS · 100000
INSULATION · 110000 PAINTING · 120000 DISMANTLING · 130000 BG PIPING · 140000 REFRACTORY · 150000
BUILDINGS · 180000 SPECIALTY SERVICES · 190000 DEMOBILIZE · 200000 SUPPORT.

### S10 — Phase descriptive fields (`models/phase.ts`)

`phaseNumber`, `description`, `size`, `flc`, `system`, `sys`, `spec`, `insulation`,
`insulationSize`, `sheet`, `area`, `status`, plus `customQuantity`/`quantity`/`customUnit`/`unit`,
the 9 rollups, and `completed`. Override semantics (`api/phase.ts:58-87`): editing "quantity" writes
`customQuantity`; editing "unit" writes `customUnit` **and nulls the legacy `unit`**. Read
precedence: `customQuantity ?? quantity ?? computed` and `customUnit ?? unit ?? computed`
(`:288-293`). Text fields are force-uppercased on save (`store.ts:296-297`, `api/wbs.ts:66-69`) — a
deliberate industry convention, worth preserving.

### S11 — Excel keyboard navigation contract (carry this forward verbatim)

`src/components/excel_navigation_data_grid.tsx`, used by both the activity and phase grids:

- `F2` — toggle edit mode on the focused cell
- `Tab` / `Shift+Tab` — move to next/previous **editable** cell, in both view and edit mode,
  committing on the way
- `Enter` / `Shift+Enter` — move down/up a row and enter edit mode
- `Delete` / `Backspace` in view mode — clear the cell
- Arrow keys — grid navigation Skips non-editable cells. This is the interaction model Precision's
  grid must match or beat.

### S12 — Export (the only report that exists)

One menu item, "WBS Cost Report", under a button labelled **"Data Dump"** (`export_menu.tsx:36,51`),
mounted inside the WBS grid toolbar (`wbs_data_grid.tsx:70`). `api/data_dump.ts` (1,476 lines)
builds a styled `.xlsx` via `xlsx-js-style`, stamping the proposal's rates into fixed header/footer
cells (`:64-79`) and saving through the Tauri `save` dialog. Sheet is named `'readme demo'`
(`:247`). Hidden WBS are filtered out via `ProposalPreferences`. **No PDF, no CSV, no other
report.**

### S13 — Decisions already made and still valid

- Server-authoritative calculation. All three docs converge on it; the legacy client-side recompute
  is the #1 verified performance problem. This is exactly the Truss/Convex bet.
- Separate stored inputs from computed outputs. The legacy schema persists `craftCost`, `totalCost`
  etc. onto activity docs and then recomputes them on read anyway — pure waste and a stale-data
  risk.
- Keep the 4-level hierarchy and all 6 activity types. Verified, and the estimators' mental model.
- Preserve the 7 formulas bit-for-bit; validate new output against old.
- Grid-first for the activity level. The keyboard grid is the app's best feature.
- Do **not** replicate: PDF export, three-tier roles, or a single `constantDataSet` column — none of
  those describe the real system.

---

# DEAD OR BROKEN IN THE LEGACY SOURCE

These are not doc problems — they are code facts a parity effort must not blindly copy.

**Broken**

1. `api/proposal.ts:135` — `deleteProposalAndAssociatedData` deletes from `'phases'`; the real
   collection is `'phase'`. **Deleting a proposal orphans every phase document.**
2. `api/totals.ts` vs `utils/calculations.ts` — two calculation engines with **different welder
   formulas**. `utils/calculations.ts` is never imported, but it is the trap a future reader falls
   into.
3. `api/phase.ts:273-276` — `cmh`/`wmh` accumulators add `craftManHours`/`welderManHours` **twice**;
   the parallel `craftManHours`/`welderManHours` accumulators are correct. Both land on the phase
   object via `...costs`.
4. `api/activity.ts:599-610` — for WBS 30000 (CONCRETE) the loop sets a unit but **never accumulates
   quantity**, and 30000 has no `keywordMap` entry, so concrete phase quantity is always 0.
5. `api/phase.ts:178-197` — `copyActivitiesFromPhase` **silently drops** any labor activity with no
   same-named constant in the target phase. Silent data loss on copy.
6. `api/wbs.ts:33` — `insertAllBaseWbs` uses `forEach(async …)` with awaits inside: fire-and-forget,
   unordered, unawaited. WBS seeding can partially fail without surfacing an error.
7. `api/proposal.ts:104` + `proposal_home.tsx:63-74` — rate/detail saves use `setDoc` (full
   overwrite). Fields absent from the edit payload are destroyed.
8. `add_activity_dialog.tsx:124-129` — the constant search ORs `includes(search)`,
   `toLowerCase().includes(search)`, `toUpperCase().includes(search)`. A mixed-case query like
   `"Pipe"` matches **nothing**, because the needle is never normalized.
9. `App.tsx:29-35` — the MUI X Data Grid Pro license key is **synthesized locally** rather than
   configured. Legal exposure; must not be ported.
10. `api/totals.ts:106` — `getSubcontractorCost` destructures `useTaxRate` and never uses it.
11. `api/activity.ts:470` — `calculateActivityData` is `async` but performs no async work; it forces
    `Promise.all` ceremony at every call site.
12. `api/activity.ts:521` — `rowId` is always written as `null` here, so the reorder-by-`rowId`
    feature depends entirely on a value assigned later in the grid layer.

**Dead code (zero importers — verified by grep)**

- `src/utils/calculations.ts` (155 lines) — duplicate calc engine
- `src/stores/{activity,wbs,phase,preference,proposal}_store.ts` — the entire `stores/` directory;
  the live store is `src/utils/store.ts`
- `src/hooks/activity_hook.ts`, `src/hooks/rates_hook.ts`
- `src/features/proposal home/components/proposal_info_accordion.tsx` and
  `proposal_rates_accordion.tsx` — and therefore `hooks/current_proposal_listener_hook.ts`
  transitively
- `src/components/project_card.tsx`, `src/components/add_phase_button.tsx`
- `src/dev/` (palette, previews, useInitial)
- `columns.tsx` and `columns2.tsx` both export `getActivityColumns` and both are imported by
  `activity_data_grid.tsx:66-67` — one of the two is redundant
- Large commented-out blocks: `api/activity.ts:615-677`, `api/proposal.ts:172-223`,
  `utils/utils.ts:41-72`

**Structural UX problems worth designing away**

- MemoryRouter (`App.tsx:2`) — no deep links, no restorable location
- Dual UI kits (Chakra + MUI) in one app
- `proposal_home.tsx:47-48` computes `craftLoadedRate` and discards it
- Proposal edit is a modal-ish full-form Save with a blocking success `<Dialog>` (`:210-217`) rather
  than inline autosave — this is the "how proposal information is entered" pain point, and it is
  real
- Add-Activity dialog is a fixed 400×400 checkbox list with no keyboard selection, no unit/quantity
  entry at add time, and no preview — every added row starts at quantity 0

---

# ONE-LINE VERDICTS

| Document                             | Verdict                      | Keep                                                                                      | Discard                                                                                             |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MCP_ESTIMATOR_ANALYSIS.md`          | **USE (partial)**            | §3 models, §4 libraries, §5 types, §6 formulas, §8.2–8.3 quantity logic, §11 entry points | §9 UI, §10 data flow, §13.1, all file paths, `constantDataSet`                                      |
| `MCP_ESTIMATOR_PRAGMATIC_REWRITE.md` | **USE FOR SCOPE ONLY**       | §2 cut lists, §3 feature requirements                                                     | §4 stack, §5 DDL, §6 structure, §9 migration, §10 timeline, PDF/roles/org-isolation "parity" claims |
| `MCP_ESTIMATOR_REDESIGN.md`          | **IGNORE (mine 3 sections)** | §1.1–1.2 pain points, §8.3 calc transparency, Appendix                                    | Everything else — ~85% never built and contradicts Convex                                           |
| `CLAUDE.md`                          | **USE**                      | Whole file                                                                                | Zustand-stores claim; escalate the license line                                                     |
| `WARP.md`                            | **N/A**                      | —                                                                                         | Symlink to `CLAUDE.md`; not a separate document                                                     |
