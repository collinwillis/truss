# Gap Analysis — Estimate Lifecycle (landing, list, creation, proposal info, rates)

**Domain owner question:** _"I hate the way that the proposal information and everything is entered
on the home screen when you go into a proposal."_

**Method:** read the actual source in `apps/precision/`, `packages/backend/convex/precision.ts`,
`packages/features/`, `apps/momentum/`, and `mcp_estimator/src/`. Every claim below is anchored to a
file and, where it matters, a line. The nine inventory reports were read in full and are cited, but
where a report's claim was load-bearing for a recommendation I re-verified it against source — and
one of them (the welder-rate "bug") **does not survive verification**. See §5.1.

---

## 1. CURRENT PARITY — honest assessment

**Overall: ~60% of legacy capability in this domain, but with the two worst legacy structures
faithfully reproduced and three new integrity bugs on top.**

### 1.1 Landing / estimate list — `apps/precision/src/routes/estimates.tsx` (345 lines)

This is a near-literal port of the legacy dashboard. Not "inspired by" — a port:

|               | Legacy `features/home/proposal_select.tsx`                        | Precision `routes/estimates.tsx`                                     |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Grid template | `gridTemplateColumns: '80px 1fr 160px 100px 80px'` (l.146, l.176) | `grid-cols-[80px_1fr_160px_100px_80px]` (l.204, l.248)               |
| Columns       | #, Description, Owner, Status, Due                                | identical                                                            |
| Due format    | `format(dueDate, 'MM/dd')` (l.216) — no year                      | `format(dueDate, "MM/dd")` (l.292) — no year                         |
| Stats         | Proposals / In Progress / Submitted / Awarded / Hit Rate          | identical (l.124-128)                                                |
| Filter        | 6px clickable status-distribution bar                             | 6px (`h-1.5`) clickable status-distribution bar (l.138)              |
| Sorting       | hardcoded `proposalNumber` desc, no control                       | hardcoded `parseFloat(proposalNumber)` desc, no control (l.108-113)  |
| Row           | `<Box onClick>` — not focusable                                   | `<div onClick>` (l.245-253) — not focusable, no ⌘-click, no `<Link>` |
| Dollars shown | none                                                              | none                                                                 |

**Genuinely better than legacy (3 things):** search filters the primary table (legacy's sidebar
search never did — legacy UX problem P4); no 50-row cap (`.slice(0, 50)`, legacy l.74); one Convex
query instead of four concurrent full-collection `onSnapshot` listeners (legacy P14).

**Still missing / regressed:** no sort control, no dollars, no pins/recents/tile-list (Momentum has
all three in `routes/projects.tsx`), no per-row actions at all (`deleteProposal` exists in
`precision.ts:591` and is called from nowhere), no archive concept, no keyboard operability, no
permission gating, and hardcoded non-theme palette chips (`bg-amber-100 text-amber-800`,
`estimates.tsx:21-39`) that render as light blobs in dark mode.

### 1.2 Creation — `components/create-estimate-dialog.tsx` (186 lines)

Collects 5 fields (`proposalNumber`, `description`, `ownerName`, `datasetVersion`, `bidType`) versus
legacy's 2. `precision.createProposal` (`precision.ts:452`) inserts the proposal **and** seeds one
`wbs` row per active `wbsPool` entry **in the same mutation** — this is atomic, and it fixes the
legacy `insertAllBaseWbs` fire-and-forget `forEach(async …)` bug outright. `status: "bidding"` is
set, so new estimates are not statusless (legacy P2 fixed).

**Regressions and gaps:**

- **No next-number suggestion.** Legacy auto-seeded `max(existing)+1`, or `1300` when empty
  (`add_proposal_dialog.tsx:26-38`). Precision starts with an empty field and the placeholder
  `"e.g., 2024-001"` (l.43, l.109) — a different numbering convention than the company actually
  uses.
- **No uniqueness check.** `proposals.by_number` index exists (`schema.ts:397`) and nothing queries
  it.
- `rates: DEFAULT_RATES` = all fifteen zeros (`packages/features/src/estimation/types.ts:34-50`), so
  a brand-new estimate prices at **$0.00** with no warning anywhere — same as legacy, and the single
  biggest first-run failure in the domain.
- `datasetVersion` is a raw **V1 / V2** select shown to estimators. `wbsPool`/`phasePool` have no v2
  rows, so `getWBSPool`/`getPhasePool` silently fall back to v1 (`precision.ts:497-503`). We are
  asking the user to choose between an option and a lie.
- Failure path is `console.error` (l.85). `sonner` is a dependency of the repo and is never imported
  anywhere in `apps/precision/src`.

### 1.3 Proposal info entry — `routes/estimate/$estimateId.index.tsx` Details tab

Structurally the same mistake as legacy, with tabs instead of Edit-mode: a screen whose **default
tab is a metadata form** and whose money lives on the third tab.

**Field coverage is exactly 11 of the legacy 22** (50%):

| Present                                                                                                                                  | Missing (legacy has it, Precision does not)                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| proposalNumber, jobNumber, changeOrderNumber, description, ownerName, estimators, jobSiteAddress, status, bidType, dateReceived, dateDue | projectCity, projectState (`projectAddress` is in the schema and written by the Firestore sync — displayed nowhere), projectStartDate, projectEndDate (accepted by `updateProposal`, no UI), and the entire 7-field contact block: contactName, contactPhone, contactEmail, contactAddress, contactCity, contactState, contactZip (`contacts` table exists in `schema.ts`; **zero Convex functions read or write it**) |

**Three real defects in the save path:**

1. **One shared debounce ref for every field** (`$estimateId.index.tsx:90-102`). `patchField` does
   `clearTimeout(debounceRef.current)` on every call, so blurring "Job #" and then "CO #" inside 400
   ms **cancels the Job # write permanently**. Silent data loss, no indicator.
2. **No save state at all** — no dirty marker, no spinner, no confirmation, no error toast.
3. `estimators` round-trips through `.split(",")`, so a comma in a name splits one estimator into
   two.

### 1.4 Rates — same file, `RatesGrid` (l.416-478)

All 15 rate fields are editable and grouped Labor / Overhead & Burden / Profit Margins / Tax Rates
from the shared `RATE_FIELD_CONFIG` (`packages/features/src/estimation/types.ts:171-194`). That is
real parity with the legacy Rates tab, and it is _not_ hidden behind an Edit-mode button, which is
an improvement over both the legacy tab and the two dead legacy accordions.

**But:**

- `const [local, setLocal] = useState<ProposalRates>(rates)` (l.423) with **uncontrolled
  `defaultValue` inputs** (l.462) and no `useEffect` resync. When the server value changes
  underneath — which happens every 6 hours via the sync cron, see §1.5 — the grid keeps displaying
  and writing stale numbers.
- `parseFloat(raw) || 0` (l.426) turns any typo into a silent **0**, which prices that leg of the
  estimate at nothing.
- `type="number" step="any"` — browser spinners, locale decimal problems. Momentum solved this
  already with `NumberInput` (`add-activity-dialog.tsx:890-907`, text + `inputMode="decimal"`).
- **No derived-rate display.** Neither legacy nor Precision ever shows the craft loaded rate or the
  welder loaded rate — the two numbers the 15 fields exist to produce. The engine computes them
  server-side (`precision.ts:152`, `:179`) and throws them away.
- **No impact preview, no validation, no bounds, no undo, no templates, no copy-from-estimate, no
  audit of who changed a rate.** A 5000% burden rate is accepted, and re-prices the whole bid on
  next read.

### 1.5 The thing that makes all of the above moot for real data

`crons.ts` runs `sync.syncEngine.syncProposals` every 6 hours → `sync/syncMutations.ts:283`
`await ctx.db.patch(existing._id, proposal)` with the full `mapProposal` payload
(`sync/fieldMapping.ts:60-107`), which includes `description`, `ownerName`, `status`, `bidType`,
`projectAddress`, `jobSiteAddress`, `estimators`, all four dates, `jobNumber`, `changeOrderNumber`,
`datasetVersion` (forced `"v1"`), **and all 15 rates**.

For every proposal that came out of Firestore — i.e. all of production — anything typed into the
Details or Rates surface is silently reverted within 6 hours. **No redesign of this domain is worth
shipping until the record-ownership question is settled** (§5.2).

### 1.6 Parity scorecard

| Sub-area                                           | Parity                        | Note                                                                             |
| -------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Landing / list                                     | ~75%                          | ported layout; missing sort, dollars, row actions, keyboard, archive             |
| Creation                                           | ~60%                          | atomic WBS seeding is better; next-number + uniqueness + rates seeding are worse |
| Proposal info entry                                | ~50%                          | 11 of 22 fields; lossy debounce; no validation                                   |
| Rates                                              | ~85% functional / ~40% usable | all 15 fields present; stale state, no derived values, no consequence            |
| Lifecycle (duplicate / delete / archive / convert) | ~45%                          | duplicate works; delete unwired; archive nonexistent in both                     |

---

## 2. MISSING CAPABILITIES

| Capability                                                                              | Why it matters                                                                                                                              | Effort                  | Blocks other work?                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| Settle sync record-ownership (cron vs Precision)                                        | Every info/rate edit on a legacy-origin proposal is reverted within 6h by `syncMutations.ts:283`. Any UX work here is theater until fixed   | M                       | **Yes — blocks everything in this domain**           |
| Per-field save state (dirty / saving / saved / error) + fix the shared `debounceRef`    | `$estimateId.index.tsx:90-102` silently drops writes today; users cannot tell whether anything saved                                        | S                       | Yes — blocks trusting any inline-edit surface        |
| Dedicated estimate **Settings** route with all 22 legacy info fields                    | 11 of 22 fields have no UI; contact block and project city/state/start/end are unreachable                                                  | M                       | No                                                   |
| Dedicated **Rates workbench** (derived loaded rates + build-up breakdown)               | The 15 rates exist to produce two numbers nobody can see; every legacy rate complaint traces back to this                                   | M                       | No                                                   |
| `previewProposalTotals(proposalId, candidateRates)` query                               | Answers "what will this rate change do to my bid" — the #1 unaddressed legacy pain (legacy UX problem #20)                                  | S                       | No — engine is already pure over `(activity, rates)` |
| Rate templates / presets (`rateTemplates` table + apply + save-as + copy-from-estimate) | New estimates price at $0.00 until 15 numbers are typed by hand, in both apps, with no company default                                      | M                       | No                                                   |
| Zero-rate / rate-health warning on overview + list                                      | A $0 estimate looks identical to a real one; a $0 rate snapshot also poisons Momentum, which freezes `rates` at import (`momentum.ts:2333`) | S                       | No                                                   |
| Next-proposal-number suggestion + duplicate-number guard                                | Legacy had `max+1` seeded at `1300`; Precision has an empty box and no uniqueness check despite a `by_number` index                         | S                       | No                                                   |
| Delete an estimate from the UI (confirm + cascade)                                      | `deleteProposal` (`precision.ts:591`) is implemented and unreachable; there is no way to remove a mistake                                   | S                       | No                                                   |
| Archive / lifecycle-close semantics                                                     | Neither app has one; the list will grow monotonically                                                                                       | S                       | No                                                   |
| Dollar value + man-hours on the estimates list                                          | The landing screen of an estimating app shows no money, in both legacy and Precision                                                        | M                       | No — but needs a cost decision (§5.3)                |
| Sort control, pins, recents, tile/list on the list                                      | Momentum has all of it in `routes/projects.tsx`; Precision has none                                                                         | M                       | No                                                   |
| Rows as real links + full keyboard operability                                          | `<div onClick>` rows; ⌘N works only when already on `/estimates`; ⌘⇧O / ⌘⇧E / ⌘B dispatch events with no listeners                          | S                       | No                                                   |
| Contact capture (7 fields)                                                              | Legacy parity; `contacts` table exists with zero functions                                                                                  | S (inline) / L (entity) | No                                                   |
| `organizationId` on `proposals` + server-side permission checks                         | `listProposals` returns every proposal in the deployment to every user; no function in `precision.ts` checks identity                       | L                       | Yes for production rollout                           |
| Toasts on every mutation in this domain                                                 | Create / duplicate / export failures are `console.error` only                                                                               | S                       | No                                                   |
| Golden-number tests for the rate engine                                                 | The one thing that must be exactly right has zero coverage — which is why §5.1 was arguable at all                                          | M                       | No                                                   |
| Audit trail for rate changes                                                            | No `updatedBy`/`updatedAt` anywhere; a bid can be re-priced with no record                                                                  | L                       | No                                                   |

---

## 3. REDESIGN RECOMMENDATIONS

### R1 — Split the screen along the "does this change a number?" line. Kill the tab triad.

The legacy mistake, faithfully inherited by Precision, is treating **proposal metadata** and **the
15 rates** as the same kind of object. They are not:

- **Metadata** (22 fields) is reference data about the job. Entered at intake, rarely revisited,
  affects zero dollars.
- **Rates** are the pricing model. Every dollar in the estimate is a pure function of them.

Legacy put them in two tabs sharing one `isEditMode` and one Save handler
(`proposal_home.tsx:28-29`), so pressing Save on Rates also wrote Details. Precision kept the shape
(Details / Rates / WBS, defaulting to Details) and lost the shared-Save bug but kept the structural
error: **the estimate is the third tab.**

Proposed routes:

```
/estimate/$estimateId              → Overview   — the money. Never a form.
/estimate/$estimateId/settings     → Settings   — the 22 metadata fields + danger zone
/estimate/$estimateId/rates        → Rates      — pricing workbench with consequence
/estimate/$estimateId/wbs/$wbsId   → (existing)
/estimate/$estimateId/phase/$id    → (existing)
```

Why two surfaces and not one settings page: metadata is a settings page (Momentum already has the
exact pattern at `apps/momentum/src/routes/project/$projectId.settings.tsx`). Rates are a _working_
surface — an estimator opens them deliberately, iterates, and wants to see the bid move. Burying
them in Settings repeats the legacy sin at a different address.

Sidebar (`config/shell-config-estimate.ts`) gains `Overview` / `Rates` / `Settings` above the Work
Breakdown tree, with `⌘1` / `⌘2` / `⌘,` — mirroring Momentum's `shell-config-project.ts:139-142`
("Project Settings", `/project/$projectId/settings`).

**Overview becomes the money dashboard:** headline total + total MH, direct/indirect split, cost by
category (craft / weld+rig / material / equipment / sub / cost-only), the WBS roll-up table that is
currently the third tab, status + due chips, a rate-health banner (R4), and quick actions (Export,
Duplicate, Convert to Momentum project, Open last-edited phase). No inputs on this page except the
status control.

### R2 — Metadata entry: grouped sections with explicit section save, not a 22-field wall

Do **not** reproduce the legacy 3-column `xs=12 sm=6 md=4` grid of 22 undifferentiated fields, and
do not reproduce Precision's current shared-debounce autosave.

Layout (`/estimate/$estimateId/settings`), house style copied verbatim from
`$projectId.settings.tsx`: `rounded-mac-card border bg-card` sections,
`text-body font-semibold text-muted-foreground` headers, a
`border-t px-5 py-3 bg-fill-quaternary/30` save footer per section, `AlertDialog` danger zone.

Group by **when the information arrives**, not by entity:

1. **Identification** (always expanded): Proposal #, Description, Owner/Client, Status, Bid Type.
2. **Intake** (always expanded): Date Received, Due Date, Estimator(s), Job #, CO #.
3. **Job Site** (collapsed when empty, badge shows filled count): Job-Site Address, City, State,
   Project Start, Project End.
4. **Contact** (collapsed when empty): Name, Phone, Email, Address, City, State, ZIP.
5. **Advanced** (admin only): cost library / dataset version, `firestoreId` provenance, sync policy.
6. **Danger Zone**: Delete estimate (typed confirm naming the proposal, cascade count shown: "18
   WBS, 42 phases, 1,207 activities will be deleted").

Save semantics — **section-scoped explicit save for v1**:

- Each section has its own dirty state and `Save Changes` button (`⌘S` saves the focused section,
  `Esc` reverts it), exactly like Momentum. This is one afternoon of work and it _eliminates the
  entire lossy-debounce bug class_ rather than papering over it.
- v2 (after `useFieldAutosave` exists, §4.2): switch to per-field autosave with a per-field save
  tick and an "All changes saved" line in the page header. Do not attempt v2 before the shared
  primitive exists — the current code is what happens when you try.

Field-level rules that are non-negotiable (all are legacy defects, not preferences):

- ZIP is **text** (`contactZip` was a `number` in legacy — `07030` became `7030`).
- State is a 2-letter code with a searchable combobox (legacy stored `"California"`, unjoinable to
  anything).
- Email is `type="email"` with validation and is **never uppercased** (legacy's `fmtVal` rendered
  `JOHN@ACME.COM`).
- Phone stores 10 digits, displays `(555) 123-4567` (legacy's `sanitizePhoneDigits` behavior is
  correct — keep it).
- `proposalNumber` stays a **string** (Precision already does this — it is what makes `1956.01`
  possible; legacy's `parseInt` collapsed `1300.1` → `1300` on every save).
- Estimators become chips over an org-member picker (with free-text fallback), not a comma string.
- Description force-uppercase **on write**, not on render — the legacy split between stored case and
  displayed case broke its own search.

### R3 — The Rates workbench (the centrepiece)

Two-column layout at `/estimate/$estimateId/rates`.

**Left — inputs.** The 15 fields in the existing 4 groups from `RATE_FIELD_CONFIG`, each row
`label · NumberInput · unit`, ~32px rows. Controlled state seeded from the server with a resync
effect (fixes the stale-state bug), per-field dirty dot, arrow-key movement between fields,
type-to-replace.

**Right — consequence (sticky).** This is the part neither app has ever had:

1. **Craft loaded rate** with its build-up, straight out of the engine:
   ```
   Craft base                 $48.00
   + Burden        32.0%      $15.36
   + Overhead      12.5%       $6.00
   + Labor profit  10.0%       $4.80
   + Fuel           2.0%       $0.96
   + Consumables    1.5%       $0.72
   + Subsistence              $12.00
   = Craft loaded rate        $87.84 / MH
   ```
2. **Welder loaded rate** with the same build-up plus the two rig legs (`+ Rig $X`,
   `+ Rig profit n% $Y`). Note the welder markup applies to the same five percentages as craft —
   `rigProfitRate` is applied **only** to `rigRate` (see §5.1; this matches the live legacy engine
   `api/totals.ts:42-72` and Precision `precision.ts:179-195`).
3. **Non-labor multipliers**: Material `×1.0925`, Equipment (rental/purchase) `×1.1450`, Equipment
   (owned) `×1.0000 — no profit, no use tax`, Subcontractor legs. Each with the contributing rates
   named.
4. **Impact preview**: `Total: $1,241,880 → $1,317,414 (+6.1%)`, plus per-category deltas, computed
   by a new query:
   ```ts
   // packages/backend/convex/precision.ts
   export const previewProposalTotals = query({
     args: { proposalId: v.id("proposals"), rates: v.object(rateFields) },
     // reuse computeActivityCosts against the candidate rates; return the same
     // accumulator shape as getProposalSummary, plus the current-rates baseline
   });
   ```
   This is cheap precisely because of the architecture bet: `computeActivityCosts(activity, rates)`
   is already a pure function of the rates object, so previewing is the same scan with a different
   second argument. No pre-aggregation, nothing written.

**Save semantics — explicit Apply, deliberately different from metadata.** Rates re-price the entire
bid; a debounced silent write is the wrong default. Footer strip:
`3 unsaved rate changes · $1.24M → $1.32M` with `Discard` and `Apply Rates` (`⌘S` / `⌘↵`). On apply:
`updateProposalRates` returns the previous rates object, and the success toast carries an **Undo**
that writes it back. That is the undo Momentum's design checklist asks for (§XIII "Undo >
Confirmations") and neither app has.

**Lock on submit.** When `status ∈ {submitted, awarded}` the workbench renders read-only with an
"Unlock rates" action that requires a reason and records who/when. A bid that has gone to a customer
must not silently re-price. (Requires the audit-trail decision, §5.6.)

### R4 — Rate templates, presets and provenance (the fix for "everything defaults to zero")

New table:

```ts
rateTemplates: defineTable({
  organizationId: v.optional(v.string()), // see §5.10
  name: v.string(), // "Company Default 2026", "Gulf Coast T&M"
  description: v.optional(v.string()),
  rates: v.object(rateFields),
  isDefault: v.boolean(),
  createdBy: v.string(),
  updatedAt: v.number(),
})
  .index("by_default", ["isDefault"])
  .index("by_org", ["organizationId"]);
```

- `createProposal` accepts `rateTemplateId?`; with neither template nor explicit rates it uses the
  org default; only if no default exists does it fall back to zeros **and** flag the estimate as
  rates-unset.
- Create dialog gets a **Rates** select: `Company Default (2026)` / `Copy from estimate…` / `Blank`.
- `copyRatesFromProposal({ sourceProposalId, targetProposalId })` mutation + a cmdk estimate picker
  — this is the "how does a user copy rates from a prior proposal" answer, and it is what estimators
  actually do today by re-typing 15 numbers.
- Workbench header: `Load preset ▾`, `Save as preset…`, `Copy from estimate…`.
- **Provenance line**: _"Rates from Company Default 2026, applied 12 Mar · 2 fields overridden"_
  with the overridden fields marked. Clicking shows the diff against the template.

**Explicitly reject live inheritance.** Editing a template must never move the numbers inside an
existing bid. Snapshot on apply, show drift. (This mirrors what Momentum already does deliberately
at `momentum.ts:2331-2334` — _"Frozen snapshot — Precision edits never leak in"_.)

### R5 — Creation: one dialog, five decisions, zero implementation details

Keep it a single dialog (not a wizard), but change what it asks:

| Field          | Behavior                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proposal #     | Prefilled from a new `suggestNextProposalNumber` query — `max(numeric proposalNumber) + 1`, seeded `1300` when empty (legacy `add_proposal_dialog.tsx:26-38` parity). Mono. Live duplicate check against `by_number`: _"#1487 already exists — did you mean to create a revision? [Duplicate #1487 instead]"_ |
| Description    | required, uppercased on write                                                                                                                                                                                                                                                                                 |
| Owner / Client | combobox over distinct existing `ownerName` values, free text allowed                                                                                                                                                                                                                                         |
| Due date       | **new at creation** — it is the primary sort/urgency dimension and legacy forced a second edit pass to set it                                                                                                                                                                                                 |
| Rates          | select: Company Default / Copy from estimate / Blank (R4)                                                                                                                                                                                                                                                     |
| WBS scope      | compact multi-select of the 18 categories, default **all**, with a "Common (5)" quick pick                                                                                                                                                                                                                    |

Remove `datasetVersion` from the dialog. It is an implementation detail with a broken option (v2 has
no `wbsPool`/`phasePool` rows and silently falls back — `precision.ts:497-503`). Default it from a
constant and expose it in Settings → Advanced as _"Cost library"_ for admins.

Status is set to `bidding` silently. `⌘↵` submits. Errors surface via `toast.error` with the server
message. On success: toast + navigate to the new estimate's Overview, which shows the "Set rates"
nudge if the rates are blank.

**WBS pruning without deletion.** Legacy defaulted `wbsToDisplay: []` (nothing visible — clearly a
bug); Precision dumps all 18 permanently. Right answer: keep seeding all 18 rows so nothing is lost,
add `hidden: v.optional(v.boolean())` to the `wbs` table, drive the sidebar tree / overview table /
export off `!hidden`, and add a `Show empty categories` toggle. Keep `deleteWBS` for genuine removal
behind a confirm that names the phase/activity count. This delivers the legacy "WBS Select"
capability without its worst property — legacy's filter silently excluded real money from the totals
_and_ the export (the legacy bottom panel literally has an amber "hidden WBS data" warning admitting
it).

### R6 — Landing screen: port Momentum's list, not the legacy dashboard

`apps/momentum/src/routes/projects.tsx` already solved this screen: persisted sort
(`momentum:projects:sortBy`), persisted tile/list (`momentum:projects:viewMode`), Recent + All +
Active + Completed segmented pills with counts, pins, real empty states, `ProjectCard` /
`ProjectListRow` from `@truss/features/progress-tracking`.

Concretely for Precision:

- Replace the `<div onClick>` rows with `ProjectListRow`-derived rows wrapped in `<Link>` —
  focusable, `↑`/`↓` navigable, `↵` to open, `/` to focus search.
- Columns that matter to an estimator: `#`, Description, Owner, **Total $**, **Total MH**,
  Estimator, Status, Due (with year), Modified.
- Sort by any of number / due / total / modified / status, persisted to
  `precision:estimates:sortBy`.
- Tabs: `Recent` (needs recents storage, §4.9), `Active` (excludes closed/declined), `All`,
  `Awarded`. **Archive = `status: "closed"`**, excluded from the default view — do not invent a new
  lifecycle field.
- Row context menu via Tauri's native `Menu` (Momentum's documented pattern in
  `$projectId.index.tsx:713-938`): Open · Duplicate · Copy rates from this · Convert to Momentum
  project · Delete.
- Keep the status distribution bar, but as a secondary visual with keyboard-reachable legend
  buttons; the segmented pills are the primary filter.
- `⌘N` must work from anywhere: move the create dialog + its listener into `__root.tsx` (today
  `estimates.tsx:51-55` registers the listener, and the palette command dispatches the event
  immediately after `navigate("/estimates")`, before the route has mounted — so `⌘N` silently does
  nothing off-route).

### R7 — Things we deliberately do NOT carry over

| Legacy behavior                                                                    | Why not                                                                                                         | Instead                                                                                                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Whole-form `Edit` mode toggle (`proposal_details.tsx:124-141`)                     | Modal editing of reference data; nothing is editable until you find a corner button                             | Always-editable fields with explicit section save                                                                                   |
| One `isEditMode` + one Save spanning Details and Rates (`proposal_home.tsx:28-29`) | Saving rates wrote metadata and vice versa                                                                      | Separate routes, separate mutations (`updateProposal` / `updateProposalRates` — already separate server-side)                       |
| `setDoc` full-document overwrite (`api/proposal.ts:104`)                           | Lost updates; wiped every roll-up field                                                                         | Convex `patch` with defined-fields-only (already correct in `precision.ts:525-570`) — do not "improve" it into a whole-object write |
| Read-mode `toUpperCase()` on everything incl. email                                | Display and storage permanently disagree; broke legacy's own search                                             | Uppercase on write for descriptions only                                                                                            |
| `MM/dd` dates                                                                      | 2024 and 2026 look identical                                                                                    | `MMM d, yyyy`, relative for recent                                                                                                  |
| 6px bar as the only filter                                                         | Mouse-only, no focus ring, no role                                                                              | Segmented pills with counts + keyboard                                                                                              |
| Button-less success `<Dialog>` (`proposal_home.tsx:210-216`)                       | A modal used as a toast                                                                                         | `toast.success` with Undo where applicable                                                                                          |
| Decoy search box (`select_wbs_dialog.tsx:32`)                                      | State written, never read                                                                                       | If it renders, it filters                                                                                                           |
| Reload the entire proposal tree after a two-field save (`loadFullProposalData`)    | Legacy read every activity to confirm a text edit                                                               | Convex reactivity already handles this                                                                                              |
| A single all-or-nothing export button that subscribes to `getExportData` on mount  | Precision pulls the whole tree on page load for a button that may never be clicked (`$estimateId.index.tsx:82`) | Fetch export data on click (`useConvex().query(...)`)                                                                               |

---

## 4. SHARED UI PLAN

Everything below is built **once**, in `packages/`, and consumed by both apps. Order is by
value-per-day. Note: delete the existing dead `packages/features/src/settings/**` (7 files, ~950
LOC, no importers, no package export path) _before_ adding #3, or the repo will have two "settings"
modules.

| #   | Component                                                                                                                      | Home                                                                      | Source                                                                                                                                                                                                      | Cost                                                                                                              | Payoff                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `NumberInput` (text + `inputMode="decimal"`, no spinners, regex strip)                                                         | `@truss/ui/components/number-input`                                       | `apps/momentum/src/components/add-activity-dialog.tsx:890-907`                                                                                                                                              | 1 h                                                                                                               | Rates workbench, create dialog, activity grids in both apps stop using `type=number`                                                                                                                               |
| 2   | `useFieldAutosave` + `<SaveStateIndicator>` (per-field timer map, dirty/saving/saved/error, blur commit, `beforeunload` flush) | `packages/features/src/shared/forms/`                                     | the correct halves of `estimation/editable-cell.tsx` + `progress-tracking/entry-cell-input.tsx` (both use the same 350 ms constant) + Momentum's `beforeunload` blur guard (`$projectId.index.tsx:359-368`) | 1 d                                                                                                               | Kills the shared-`debounceRef` data-loss bug class in Precision _and_ unifies two hand-rolled commit state machines                                                                                                |
| 3   | `<SettingsSection>` (card + header + dirty state + save footer) and `<DangerZone>`                                             | `packages/features/src/shared/settings/`                                  | extracted from `apps/momentum/src/routes/project/$projectId.settings.tsx:189-333`                                                                                                                           | 0.5 d + 0.5 d to migrate Momentum                                                                                 | Precision's new `/estimate/$id/settings` looks and behaves identically to Momentum's project settings on day one                                                                                                   |
| 4   | `<FormDialog>` shell (`p-0 gap-0`, sticky header, scroll body, bordered `bg-muted/30` footer, `⌘↵`, busy guard)                | `@truss/ui/components/form-dialog`                                        | Momentum's newer dialogs (add-activity, create-project)                                                                                                                                                     | 0.5 d                                                                                                             | Ends the "two dialog shapes" split called out in the reuse audit §7.4; create/duplicate estimate adopt it                                                                                                          |
| 5   | `RateEditor` + `LoadedRateBreakdown` (+ `readOnly` variant)                                                                    | `packages/features/src/estimation/`                                       | **new**, built shared from the start                                                                                                                                                                        | 2 d                                                                                                               | Precision gets the workbench; **Momentum gets a read-only "Rates (snapshot)" card** — it freezes `rates` into `momentumProjects` (`momentum.ts:2333`) and today has nowhere to show what a project was priced with |
| 6   | `EntityListRow` / `EntityCard` / `ENTITY_LIST_GRID_COLS` — generalize with a pluggable metric slot                             | `packages/features/src/shared/lists/`                                     | `progress-tracking/project-list-row.tsx`, `project-card.tsx`, `project-display-utils.ts`                                                                                                                    | 1 d incl. Momentum regression pass                                                                                | Precision's list gets pins, tile/list, keyboard rows, real formatting utils; Momentum keeps `% + MH`, Precision gets `$ + due`                                                                                     |
| 7   | `EntitySwitcher` (cmdk, search, recents, own open-event listener)                                                              | `packages/features/src/shared/`                                           | `progress-tracking/project-switcher.tsx` (245 LOC)                                                                                                                                                          | 0.5 d                                                                                                             | Deletes `precision/src/components/estimate-switcher.tsx` (98 LOC, no search) and fixes the dead `⌘⇧O` / "Switch Estimate" command                                                                                  |
| 8   | `<AsyncJobPanel>` (staged progress + non-dismissible-while-busy)                                                               | `packages/features/src/shared/`                                           | `create-project-dialog.tsx:98-221`                                                                                                                                                                          | 0.5 d                                                                                                             | Duplicate Estimate deep-copies a whole tree behind a button label today; also reusable for the eventual Firestore cutover import                                                                                   |
| 9   | Recents + pins storage                                                                                                         | Convex `schema.ts` + `packages/features/src/shared/use-entity-recents.ts` | mirror of `momentumRecentViews` / `momentumPinnedProjects` (`momentum.ts:4606-4700`)                                                                                                                        | 0.5 d (per-app tables) / 1.5 d (generic `userEntityViews {userId, entityType, entityId, …}` + Momentum migration) | Recent/Pinned tabs on the estimates list. **Decision needed** (§5.9)                                                                                                                                               |
| 10  | `TableSkeleton` / `ListSkeleton` / `FormSkeleton`                                                                              | `packages/features/src/shared/skeletons.tsx`                              | `apps/momentum/src/components/skeletons.tsx`                                                                                                                                                                | 0.25 d                                                                                                            | Deletes 4 bespoke skeletons in Precision (`estimates.tsx:324`, `$estimateId.index.tsx:592`, and two more)                                                                                                          |
| 11  | `isWorkspaceAdmin`                                                                                                             | `packages/features/src/organizations/`                                    | `apps/momentum/src/lib/permissions.ts` (21 LOC)                                                                                                                                                             | 10 min                                                                                                            | Precision inlines the check in 4 places and gets the field name wrong in a 5th (`admin/index.tsx:46` uses `organizationId`; the field is `organization_id`)                                                        |

**Explicitly not shared:** the estimates list _page_ and the projects list _page_ (different
filters, different metrics — share the row/card, not the route), and the two Excel exporters.

---

## 5. RISKS AND UNKNOWNS

### 5.1 DECISION — the "welder loaded rate bug" is almost certainly not a bug. Do not fix it.

`precision-current.md` lists as finding #1: _"`computeWelderLoadedRate` omits `rigProfitRate` from
the weld-base markup… every welder cost in Precision is understated"_, and recommends fixing it as
priority 1.

I verified this against the legacy source and it does not hold:

- The **live** legacy engine is `mcp_estimator/src/api/totals.ts:42-72` (`getWelderLoadedRate`). It
  applies **only** burden + overhead + laborProfit + fuel + consumables to `weldBaseRate`, then adds
  subsistence, rig, and `rigRate × rigProfitRate/100`. **`rigProfitRate` is not in the weld-base
  markup.** Precision `precision.ts:179-195` is byte-for-byte equivalent.
- The report compared against `mcp_estimator/src/utils/calculations.ts:41-72`, which _does_ fold
  `rigProfitRate` into the markup sum — and which has **zero importers**
  (`grep -rn "calculations" src --include=*.ts*` returns only comments in `utils/utils.ts` and a
  docstring in `newAPI/api.ts`). It is dead code, and the docs-triage report independently flags it
  as "the trap a future reader falls into". The trap worked.
- The Excel export (`api/data_dump.ts`) independently agrees with `totals.ts`: rig profit appears
  only in `profitTotal` as `rigProfitRate/100 × rigCost`.

**Action:** confirm with Collin against one real bid, then (a) keep the code, (b) rewrite the
misleading JSDoc at `precision.ts:174-178` to cite `api/totals.ts` explicitly and warn about the
dead duplicate, (c) add golden-number tests. Applying the "fix" would inflate every welder hour in
every estimate.

### 5.2 DECISION — who owns a synced proposal's record?

Options: (1) whitelist the cron patch to sync-owned fields and never touch rates/status/dates once
Precision has written (add `precisionEditedAt` or a per-record `syncPolicy`); (2) render
legacy-origin proposals read-only in Precision with an explicit banner until cutover; (3) stop the
cron and accept a stale "New Project" list in Momentum. Recommendation: **(1) + (2)** —
natively-created estimates fully editable, imported ones read-only with a "Managed by MCP Estimator"
banner and an admin "Take ownership" action that sets `syncPolicy: "precision-owned"` and makes the
cron skip it.

### 5.3 DECISION — dollars on the list

`listProposals` (`precision.ts:323`) does an unfiltered `.collect()` and returns no costs,
deliberately. Showing a total per row means scanning that proposal's activities. Options: (a) cached
`proposalTotals` doc maintained by mutations — violates the no-pre-aggregation bet; (b) a separate
`getProposalTotals(proposalIds[])` query called for the visible rows only; (c) full totals in the
same query and accept the scan. Recommendation: **(b)**, with the column lazily populated and a `—`
placeholder, so the bet holds and the list stays fast. Needs Collin's sign-off on the extra round
trip.

### 5.4 DECISION — archive semantics. Reuse `status: "closed"` + a filter tab (my recommendation, zero

schema change, matches the legacy enum), or add a real `archivedAt` field with restore?

### 5.5 DECISION — rate template scope. Per-organization (needs §5.10 first), global, or per-user? Who may

edit the company default — org admins only? What happens to estimates that reference a template that
is later deleted (recommendation: nothing, because rates are snapshotted).

### 5.6 DECISION — lock rates after submit/award? I recommend yes, with an explicit unlock. That implies

the first audit record in the product (`rateChangeLog` or a generic `auditEvents` table). Is that in
scope now, or do we ship the lock without the log?

### 5.7 DECISION — contacts. Inline the 7 legacy contact fields on the proposal (parity, ~2 h) or build

the `contacts` entity that the schema already declares (`contacts` table, `contactId` on proposals,
`by_email`/`by_name` indexes, zero functions)? Recommendation: inline now, normalize when there is a
second consumer.

### 5.8 UNKNOWN — is dataset v2 real? `laborPool` and `equipmentPool` have v2 rows; `wbsPool` and

`phasePool` do not, so every v2 estimate silently resolves WBS and phases from v1. Legacy modelled
this correctly as four independent per-type versions
(`{labor:'v2', phases:'v1', wbs:'v1', equipment:'v2'}`); Precision collapsed it to one string. If
per-type versioning matters for reproducing an old bid, `datasetVersion: v.string()` needs to become
an object before more data accumulates. **This is a schema decision that gets more expensive every
month.**

### 5.9 DECISION — recents/pins storage: per-app tables (fast, duplicative) or a generic

`userEntityViews` table with a Momentum migration (cleaner, ~1 extra day)?

### 5.10 RISK — no multi-tenancy in this domain. `proposals` has no `organizationId` (verified: the string

does not appear in `schema.ts`), `listProposals` returns every proposal in the deployment to every
authenticated user, and no function in `precision.ts` performs any auth check. Adding the field
requires backfilling every synced proposal to a default org. This blocks any external rollout, and
it should be decided before the list gets pins/recents keyed on user identity.

### 5.11 RISK — proposal-number identity. Precision stores `proposalNumber` as a string (correct — it

preserves `1956.01`), but nothing enforces uniqueness and the duplicate dialog's suggestion
heuristic is `+0.1` for integers and `+0.01` for decimals (`duplicate-estimate-dialog.tsx:53-60`),
while legacy's convention was `+0.1` with a `" - Rev N"` description suffix (and its increment loop
was broken by floating point, so every legacy duplicate is `Rev 1`). Needs one canonical revision
convention, a uniqueness guard, and — worth designing — revision grouping on the list (`1300`,
`1300.1`, `1300.2` collapsed under one expandable row), which legacy never had.

### 5.12 RISK — Precision does not type-check. 27 app-level TS errors, including

`$estimateId.index.tsx:90,104` (`useRef<ReturnType<typeof setTimeout>>()` with no argument) — the
exact lines this redesign rewrites. Fix as part of chunk 0 or the new code inherits a red build.

---

## 6. SUGGESTED WORK BREAKDOWN

Ordered so each chunk ships something a user can feel, and nothing is built on a foundation that is
about to move.

**Chunk 0 — Stop the bleeding (0.5 day).** Fix `admin/index.tsx:46` `organizationId` →
`organization_id`; fix the two `useRef<Timeout>()` type errors; replace the single `debounceRef` in
`$estimateId.index.tsx:90-102` with a per-field timer map; add `sonner` toasts to create / duplicate
/ export failure paths. No visual change; three silent data-loss/failure modes disappear.

**Chunk 1 — Record ownership (1 day).** Implement §5.2: whitelist the cron patch and/or the
read-only banner for legacy-origin proposals. _Blocks 2 and 3 — do not skip._

**Chunk 2 — Shared primitives (2 days).** Promote `NumberInput` (#1), `SettingsSection`/`DangerZone`
(#3), `FormDialog` (#4), shared skeletons (#10), `isWorkspaceAdmin` (#11). Delete
`packages/features/src/settings/**`. Migrate Momentum's settings page onto `SettingsSection` to
prove the extraction.

**Chunk 3 — Estimate Settings route (2 days).** New `/estimate/$estimateId/settings` with all 22
fields in the five groups from R2, plus Danger Zone wiring `deleteProposal` with a cascade-count
confirm. Remove the Details tab from the overview. Add the sidebar item + `⌘,`.

**Chunk 4 — Rates workbench (3 days).** New `/estimate/$estimateId/rates`; `RateEditor` +
`LoadedRateBreakdown` in `packages/features/src/estimation/`; `previewProposalTotals` query;
Apply/Discard with Undo toast; zero-rate banner on the overview and a `ratesConfigured` flag on the
list. Add golden tests for the two loaded-rate formulas and all six activity types while the math is
in your head (§5.1).

**Chunk 5 — Rate presets and copy-from (2 days).** `rateTemplates` table + `applyRateTemplate` /
`saveRateTemplate` / `copyRatesFromProposal`; workbench header actions; provenance line + drift
markers.

**Chunk 6 — Creation redesign (2 days).** `suggestNextProposalNumber` query + duplicate-number
guard; due date; rates source select; WBS scope multi-select; drop `datasetVersion`; `FormDialog` +
`⌘↵` + toasts; move the create dialog and its listener to `__root.tsx` so `⌘N` works everywhere.

**Chunk 7 — Overview as the money dashboard (2 days).** Totals, category breakdown, direct/indirect,
WBS roll-up table, rate-health banner, quick actions (Export on demand rather than `getExportData`
on mount), Convert-to-Momentum-project entry point.

**Chunk 8 — Landing screen (3 days).** Promote `EntityListRow`/`EntityCard`/`EntitySwitcher`; real
links + keyboard; sort/tile/list persistence; Recent + Pinned (chunk depends on §5.9); status pills;
native context menu; delete + archive; `$`/MH columns per §5.3.

**Chunk 9 — Org scoping and permissions (2 days, gated on §5.10).** `organizationId` on
`proposals` + backfill + filtered `listProposals`; server-side write checks in every `precision.ts`
mutation in this domain; client gating of create/settings/rates/danger-zone behind the Precision app
permission.

Total ≈ 19–20 working days for the domain, of which chunks 0–4 (8.5 days) already resolve the
specific complaint that started this.
