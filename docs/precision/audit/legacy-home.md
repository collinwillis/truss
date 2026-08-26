# Legacy MCP Estimator — Audit: Home / Proposal List / Proposal Creation

Source tree audited: `/Users/collinwillis/Dev/Personal/mcp_estimator` Stack: React 18 + Vite + Tauri
v1 + MUI v5 + Firebase v9 (Firestore, Auth, Cloud Functions) + Zustand. App version in
`package.json`: `1.4.3`.

Everything below was read from source. Where I say "confirmed", I ran the arithmetic or traced the
call chain.

---

## 1. Purpose of the area and the real user flow

This area is the **entire entry point to the application**. There is no dashboard, no project
picker, no workspace concept — the app opens directly on a list of every proposal in the company's
Firestore `proposals` collection, and everything else in the app is reached by clicking one of them.

### 1.1 Files that make up the area

| File                                                          | Role                                                                                                   | Status                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `src/App.tsx`                                                 | Router. `/` → `<EstimatorDrawer><ProposalSelectScreen/></EstimatorDrawer>`                             | live                                              |
| `src/features/home/proposal_select.tsx`                       | The landing screen. Default export is actually named `ProposalOverviewDashboard` (filename lies)       | live                                              |
| `src/components/drawer.tsx`                                   | Persistent left sidebar + top app bar; owns search, the Add/Edit menu, and hosts both proposal dialogs | live                                              |
| `src/features/home/components/proposal_list.tsx`              | The sidebar proposal list                                                                              | live                                              |
| `src/features/home/components/add_proposal_dialog.tsx`        | "New Proposal" modal                                                                                   | live                                              |
| `src/features/home/components/edit_proposals_dialog.tsx`      | "Manage Proposals" modal (duplicate + delete)                                                          | live                                              |
| `src/components/alert_dialog.tsx`                             | Generic delete-confirmation modal                                                                      | live                                              |
| `src/api/proposal.ts`                                         | Firestore CRUD for proposals                                                                           | live                                              |
| `src/hooks/proposals_hook.ts`                                 | `useProposals()` — realtime listener on the whole collection                                           | live                                              |
| `functions/src/index.ts`                                      | `duplicateProposal` callable Cloud Function                                                            | live                                              |
| `src/features/home/components/add_proposal_dialog_button.tsx` | —                                                                                                      | **DEAD, never imported**                          |
| `src/components/project_card.tsx`                             | —                                                                                                      | **DEAD, never imported, lorem-ipsum placeholder** |

### 1.2 The actual flow

1. **App boot.** `App.tsx` uses `MemoryRouter` (line 2: `MemoryRouter as Router`). There is no URL
   bar, no deep linking, no browser history that survives a reload. The app always cold-starts at
   `/`.
2. **Auth gate.** `AuthRoute` (`src/components/auth_route.tsx`) subscribes to `onAuthStateChanged`.
   While resolving it renders the literal string `<p>loading ....</p>` — unstyled, no spinner, no
   branding. If `user.emailVerified === false` → redirect `/verify-email`; if no user → `/login`.
3. **Landing.** Two panes render simultaneously and show **the same data twice**:
   - **Left sidebar (280px, `drawerWidth`)** — a search box + a flat list of _all_ proposals
     (`ProposalList`), each row showing `proposalNumber` on line 1 and `proposalDescription` on
     line 2.
   - **Main pane** — `ProposalOverviewDashboard`: a 5-metric stat strip, a clickable
     status-distribution bar, and a 5-column table of the top 50 proposals.
4. **Finding a proposal.** The user either scrolls the sidebar, types into the sidebar search (which
   filters _only_ the sidebar, never the main table), or scans the main table (which has _no_ search
   box at all, and is hard-capped at 50 rows).
5. **Opening a proposal.** Clicking either a sidebar row or a table row calls
   `navigate('/proposal/{id}')`. The sidebar row additionally writes
   `sessionStorage['selectedProposalId']`.
6. **Creating a proposal.** Only reachable from a hamburger `MenuRounded` icon in the _sidebar
   header_, which only renders when `proposalId == null` (home mode) **and**
   `hasWritePermissions === true` (`drawer.tsx:313-317`). That menu has exactly two items: **Add**
   and **Edit**.
7. **Managing proposals.** "Edit" opens the `EditProposalsDialog` ("Manage Proposals") — a
   searchable list where each row has a duplicate icon and a delete icon. There is no rename, no
   status change, no archive, no bulk anything.
8. **Getting back home.** From inside a proposal, the only route back to `/` is a small `ArrowBack`
   IconButton in the sidebar header (`drawer.tsx:292`) — and it only renders if `currentProposal`
   successfully loaded (see §6, dead-end bug).

---

## 2. Complete feature enumeration

### 2.1 Landing dashboard — `proposal_select.tsx`

**Data source:** `useProposals()` → realtime `onSnapshot` on the entire `proposals` collection.

**Stat strip (5 inline stats, `StatInline`, lines 91-95).** No cards, label above value:

| Label       | Value               | Computation (lines 33-48)                                          |
| ----------- | ------------------- | ------------------------------------------------------------------ |
| Proposals   | `stats.total`       | `proposals.length` — every doc, including `Closed` and status-less |
| In Progress | `stats.pending`     | count where `proposalStatus ∈ {Bidding, Open}`                     |
| Submitted   | `stats.submitted`   | count where `proposalStatus === Submitted`                         |
| Awarded     | `stats.awarded`     | count where `proposalStatus === Awarded`                           |
| Hit Rate    | `${stats.hitRate}%` | see §4.1                                                           |

`stats.rejected` is computed (`Rejected` + `Declined`) but is **not** displayed in the strip — it
only feeds the distribution bar and the hit-rate denominator.

**Status distribution bar (lines 99-137).**

- A 6px-tall horizontal bar, `borderRadius: 3`, split into up-to-4 segments sized by
  `pct = count / stats.total * 100`.
- Segments and colors: Pending `#f59e0b`, Submitted `#3b82f6`, Awarded `#10b981`, Rejected
  `#ef4444`. Segments with `count === 0` are dropped (`items.filter(s => s.count > 0)`).
- **Clicking a segment or its legend dot toggles a filter** (`setActiveFilter`). Clicking the active
  one again clears it. Non-selected segments drop to `opacity 0.3` (bar) / `0.4` (legend).
- A "Clear filter" text link appears at the right of the legend row only while a filter is active.
- Below the bar: legend `● Label (count)` for each surviving segment.
- **This is the only filtering UI in the whole area.** It is 4 buckets, mouse-only, no ARIA roles,
  no keyboard focus, no visible affordance that a 6px bar is clickable.

**Proposal table (lines 141-228).**

- Fixed CSS grid: `gridTemplateColumns: '80px 1fr 160px 100px 80px'`.
- Sticky header row, `backgroundColor: #f9fafb`.
- Columns, in order:

| #   | Header        | Bound field             | Formatting                                                     |
| --- | ------------- | ----------------------- | -------------------------------------------------------------- |
| 1   | `#`           | `p.proposalNumber`      | tabular-nums, weight 600                                       |
| 2   | `Description` | `p.proposalDescription` | `textTransform: uppercase`, single-line ellipsis, `—` if empty |
| 3   | `Owner`       | `p.proposalOwner`       | uppercase, ellipsis, `—` if empty                              |
| 4   | `Status`      | `p.proposalStatus`      | MUI `Chip`, colors from `STATUS_CONFIG`                        |
| 5   | `Due`         | `p.proposalDateDue`     | `format(dueDate, 'MM/dd')` — **no year** — or `—`              |

- **There are no other columns.** No total cost / dollar value, no estimator, no bid type, no
  created/updated date, no city/state, no job number. The landing screen of an _estimating_
  application shows zero dollars.
- **Sorting:** hardcoded `sort((a,b) => (b.proposalNumber || 0) - (a.proposalNumber || 0))` —
  descending by proposal number. Headers are plain `<Typography>`; **no column is clickable, no sort
  control exists**.
- **Row cap:** `.slice(0, 50)` (line 74). Proposal #51 and beyond are invisible on the landing
  screen, with no "show more", no pagination, no count of what was hidden.
- **Row click:** whole row is a `<Box onClick={() => navigate('/proposal/' + p.id)}>`. Not a link,
  not focusable, no keyboard activation, no middle-click/new-window.
- **Due-date emphasis** (lines 167-168, 213-214):
  - `isOverdue` → text `#dc2626`, weight 600
  - `isDueSoon` → text `#d97706`, weight 600
  - otherwise `#9ca3af`, weight 400
- **Empty state:** plain text `No proposals found.` — no illustration, **no "Create proposal" CTA**.
- **Loading state:** the whole pane is replaced by a centered 20px `CircularProgress`.

**Status chip config (`STATUS_CONFIG`, lines 14-21).** Only 6 of the 8 enum values are styled:

| Status    | text color | background |
| --------- | ---------- | ---------- |
| Bidding   | `#92400e`  | `#fef3c7`  |
| Open      | `#1e40af`  | `#dbeafe`  |
| Submitted | `#1e3a5f`  | `#e0e7ff`  |
| Awarded   | `#065f46`  | `#d1fae5`  |
| Rejected  | `#991b1b`  | `#fee2e2`  |
| Declined  | `#6b7280`  | `#f3f4f6`  |

`None` and `Closed` have no entry → `getStatusConfig` falls through to grey with the raw string as
label. Missing/undefined status renders an em-dash chip.

### 2.2 Sidebar — `drawer.tsx` (home mode, `proposalId == null`)

- Header: title `MCP Estimator` (hardcoded, `drawer.tsx:311`) + hamburger `MenuRounded` (write-perm
  gated).
- **Search field**: `placeholder='Search proposals...'`, `SearchRounded` start-adornment, 32px tall,
  `#f3f4f6` background. Controlled by `proposalSearchInput`.
  - Filter logic (`drawer.tsx:134-162`): lowercases the search term, builds a single space-joined
    lowercase string from **22 proposal fields**, and tests `joined.includes(searchKey)`:
    `proposalNumber, job, coNumber, proposalDescription, proposalOwner, projectCity, projectState, jobSiteAddress, proposalEstimators, proposalDateReceived, proposalDateDue, projectStartDate, projectEndDate, bidType, proposalStatus, contactName, contactAddress, contactCity, contactState, contactZip, contactPhone, contactEmail`.
  - Because it's a substring test on the _concatenation_, a query can match across a field boundary
    (searching `"1300 acme"` matches when number and description happen to be adjacent). No
    tokenization, no fuzzy matching, no field-scoped syntax, no debounce, no result count, no
    highlight.
  - **This search does not affect the main dashboard table.**
- **Proposal list** (`ProposalList`): sorted independently of the hook's own sort
  (`proposal_list.tsx:33-41`) — nulls last, numeric descending via `parseFloat`, falling back to
  reverse `localeCompare` when non-numeric. Each row is two lines: number (0.85rem) / description
  (0.75rem, uppercase). No status, no due date, no owner, no dollars.
- Active-row treatment: `borderLeft: 2px solid #111827` + `#f3f4f6` background when
  `sessionStorage['selectedProposalId'] === item.id` (effectively never — see §6.6).
- Empty state: `No proposals found.`
- No virtualization — every proposal renders a DOM node.

### 2.3 Proposal management menu — `ProposalMenu` (`drawer.tsx:480-501`)

Two items only:

| Item | Icon          | Action                      |
| ---- | ------------- | --------------------------- |
| Add  | `AddRounded`  | opens `AddProposalDialog`   |
| Edit | `EditRounded` | opens `EditProposalsDialog` |

Gated by `hasWritePermissions` at the trigger button (`drawer.tsx:313`). Both dialogs are _always
mounted_ regardless of permission; only the button that opens them is hidden.

### 2.4 Top app bar (`drawer.tsx:175-260`)

- Drawer-open icon (hidden while open).
- Breadcrumbs: `{proposalNumber} - {proposalDescription}` › `{wbs.name}` ›
  `{phaseNumber} - {description}`, each level clickable except the last. Renders nothing on the home
  screen.
- `DownloadForOffline` icon → `loadFullProposalData(proposalId)` (only when inside a proposal).
- `MenuRounded` → main menu: **Admin Console** (only if `isAdmin`) and **Logout**
  (`auth.signOut()`).

### 2.5 "New Proposal" dialog — `add_proposal_dialog.tsx`

- Title: `New Proposal`. `minWidth: 340`, `borderRadius: 2`.
- **Field 1 — "Proposal Number"**, `type='number'`, controlled by `proposalNumber` state.
  Auto-seeded by a `useEffect` on `[data, open]`:
  ```ts
  const maxNumber = Math.max(
    ...data.map((p) => parseFloat(p.proposalNumber?.toString() || "0")).filter((n) => !isNaN(n))
  );
  setProposalNumber((maxNumber + 1).toString());
  // else, when data.length === 0:
  setProposalNumber("1300");
  ```
- **Field 2 — "Proposal Description"**, `placeholder='Ex. Proposal'`. **Uncontrolled** — it has an
  `onChange` but **no `value` prop** (line 65-72).
- **Button — "Add Proposal"**, full width, black (`#111827`).
  `disabled={proposalDescription.length === 0 || proposalNumber.length === 0}`. The same condition
  is re-checked inside `onClick`.
- **That's the entire creation form: two fields.** No owner, no due date, no status, no bid type, no
  estimator, no client/contact, no job number, no template picker, no rate presets.
- No `<form>` element, no `onKeyDown`, no `type='submit'` → **Enter does not submit**. Mouse only.
- No submit spinner and the button is not disabled while the write is in flight → double-click
  creates two proposals.
- On success: `toggleAddDialog()` then clears state. **No navigation to the new proposal**, no
  toast, no scroll-to. The user has to go find it in the list.
- No error handling at all — `insertProposal` is awaited bare; a rejected promise is an unhandled
  rejection and the dialog stays open with no message.

### 2.6 "Manage Proposals" dialog — `edit_proposals_dialog.tsx`

- `maxWidth='sm'`, `fullWidth`. Header `Manage Proposals` + `Close` icon.
- **Search field** (its own, separate from the sidebar's): matches against the composed string
  `` `${proposal.proposalNumber} - ${proposal.proposalDescription}`.toLowerCase() `` (line 41). Only
  2 fields, unlike the sidebar's 22.
- Scroll region `maxHeight: 55vh`, no virtualization, `Divider` between rows.
- Each row: `{proposalNumber} - {proposalDescription}` + two icon buttons:
  - **Duplicate** (`CopyAllRounded`) →
    `httpsCallable(functions, 'duplicateProposal')({ proposalId })`. No confirmation. No success
    feedback. Errors → `console.error` only.
  - **Delete** (`DeleteIcon`) → sets `selectedProposal` and opens the nested confirmation dialog.
- **Nested confirm dialog** (`DeleteConfirmationDialog`, rendered _inside_ the
  `EditProposalsDialog`, line 161) — a modal stacked on a modal:
  - Title: `Delete {number} - {description}?`
  - Body: `This action cannot be undone. All associated data will be permanently removed.`
  - Buttons: `Cancel` (grey outline) / `Delete` (red `#dc2626`, `autoFocus`).
  - On confirm: closes confirm → `setIsDeleting(true)` → `await deleteProposalAndAssociatedData(id)`
    → `setIsDeleting(false)`. The Manage dialog stays open. No toast.
- **No rename, no status edit, no archive, no bulk select, no multi-delete, no export, no sort.**

### 2.7 Keyboard shortcuts

**There are none anywhere in this area.** No `onKeyDown`, no `useHotkeys`, no command palette, no
`Cmd+K`, no Enter-to-submit, no arrow-key list navigation, no Esc handling beyond MUI's default
modal close. Every row and every "button-like" element in the dashboard and sidebar is a
`<Box onClick>` — not focusable, not tab-reachable, no `role`, no `aria-label`.

---

## 3. Exact data fields and types

### 3.1 `Proposal` — the read model (`src/models/proposal.ts`)

A class with `constructor(data: Partial<Proposal>) { Object.assign(this, data); }`. **Every field is
optional.** No runtime validation of any kind.

| Field                     | TS type                     | Notes                                                          |
| ------------------------- | --------------------------- | -------------------------------------------------------------- |
| `id`                      | `string?`                   | Firestore doc id, injected client-side after read              |
| `proposalNumber`          | `number?`                   | primary sort key and human identifier                          |
| `job`                     | `string?`                   | job number/name                                                |
| `coNumber`                | `number?`                   | change-order number                                            |
| `proposalDescription`     | `string?`                   | displayed uppercased everywhere                                |
| `proposalOwner`           | `string?`                   | the _client/owner company_, not a user                         |
| `projectCity`             | `string?`                   |                                                                |
| `projectState`            | `string?`                   | one of `UnitedStatesStates`                                    |
| `jobSiteAddress`          | `string?`                   | **write-only in one surface; never editable in the accordion** |
| `proposalEstimators`      | `string?`                   | free text, plural in name but a single string                  |
| `proposalDateReceived`    | `string?`                   | HTML `type=date` → `"YYYY-MM-DD"`                              |
| `proposalDateDue`         | `string?`                   | `"YYYY-MM-DD"`                                                 |
| `projectStartDate`        | `string?`                   | `"YYYY-MM-DD"`                                                 |
| `projectEndDate`          | `string?`                   | `"YYYY-MM-DD"`                                                 |
| `bidType`                 | `string?`                   | one of `BidType`                                               |
| `proposalStatus`          | `string?`                   | one of `ProposalStatus`                                        |
| `contactName`             | `string?`                   |                                                                |
| `contactAddress`          | `string?`                   |                                                                |
| `contactCity`             | `string?`                   |                                                                |
| `contactState`            | `string?`                   | one of `UnitedStatesStates`                                    |
| `contactZip`              | `number?`                   | **numeric** — leading-zero ZIPs (e.g. `07030`) are corrupted   |
| `contactPhone`            | `string?`                   | manually masked `(XXX) XXX-XXXX`                               |
| `contactEmail`            | `string?`                   | no validation anywhere                                         |
| `quantity`                | `number?`                   | roll-up, computed elsewhere                                    |
| `customQuantity`          | `number?`                   | manual override                                                |
| `unit`                    | `string?`                   | roll-up                                                        |
| `customUnit`              | `string?`                   | manual override                                                |
| `craftManHours`           | `number?`                   | roll-up                                                        |
| `craftCost`               | `number?`                   | roll-up                                                        |
| `welderManHours`          | `number?`                   | roll-up                                                        |
| `welderCost`              | `number?`                   | roll-up                                                        |
| `materialCost`            | `number?`                   | roll-up                                                        |
| `equipmentCost`           | `number?`                   | roll-up                                                        |
| `subContractorCost`       | `number?`                   | roll-up                                                        |
| `costOnlyCost`            | `number?`                   | roll-up                                                        |
| `totalCost`               | `number?`                   | roll-up                                                        |
| `craftBaseRate`           | `number?`                   | **rate 1/15**                                                  |
| `weldBaseRate`            | `number?`                   | rate 2/15                                                      |
| `subsistenceRate`         | `number?`                   | rate 3/15                                                      |
| `useTaxRate`              | `number?`                   | rate 4/15                                                      |
| `salesTaxRate`            | `number?`                   | rate 5/15                                                      |
| `overheadRate`            | `number?`                   | rate 6/15                                                      |
| `consumablesRate`         | `number?`                   | rate 7/15                                                      |
| `burdenRate`              | `number?`                   | rate 8/15                                                      |
| `fuelRate`                | `number?`                   | rate 9/15                                                      |
| `rigRate`                 | `number?`                   | rate 10/15                                                     |
| `laborProfitRate`         | `number?`                   | rate 11/15                                                     |
| `materialProfitRate`      | `number?`                   | rate 12/15                                                     |
| `equipmentProfitRate`     | `number?`                   | rate 13/15                                                     |
| `subContractorProfitRate` | `number?`                   | rate 14/15                                                     |
| `rigProfitRate`           | `number?`                   | rate 15/15                                                     |
| `datasetVersions`         | `Partial<DatasetVersions>?` | see §3.4                                                       |

### 3.2 `FirestoreProposal` — the write model (`src/models/firestore models/proposal_firestore.ts`)

The constructor takes a named-arg object and coerces every value:

- all string/date/enum fields → `value ?? null`
- `contactZip`, `coNumber`, `proposalNumber` → `value ?? null`
- **all 15 rate fields → `value ?? 0`**

**Critical asymmetry:** `FirestoreProposal` does **not** contain `id`, `quantity`, `unit`, or any of
the 9 roll-up cost fields (`craftManHours`, `craftCost`, `welderManHours`, `welderCost`,
`materialCost`, `equipmentCost`, `subContractorCost`, `costOnlyCost`, `totalCost`). Since
`updateSingleProposal` uses `setDoc` (full document overwrite, **not** `merge`), any save that goes
through a real `new FirestoreProposal(...)` **wipes every stored roll-up field**.
`src/api/proposal.ts:96-108`:

```ts
export const updateSingleProposal = async ({ proposalId, proposal }) => {
  const proposalRef = doc(firestore, "proposals", proposalId);
  await setDoc(proposalRef, { ...proposal }); // full overwrite, no merge
  console.log("Proposal updated");
};
```

### 3.3 Enums (`src/models/proposal.ts`)

- **`BidType`** (6): `None`, `Lump Sum`, `Time and Materials`, `Budgetary`, `Rates`, `Cost Plus`.
- **`ProposalStatus`** (8): `None`, `Bidding`, `Submitted`, `Awarded`, `Rejected`, `Declined`,
  `Open`, `Closed`. The dashboard only understands 6 of them (see §2.1).
- **`UnitedStatesStates`** (51): `None` + all 50 states. No DC, no Puerto Rico, no territories, no
  Canada.

### 3.4 `DatasetVersions` (`src/data/dataset_types.ts`)

```ts
type DataVersion = "v1" | "v2";
type DataType = "labor" | "phases" | "wbs" | "equipment";
type DatasetVersions = Record<DataType, DataVersion>;
DEFAULT_DATA_VERSION = "v1";
CURRENT_DATA_VERSION = "v2";
```

`buildDatasetVersions('v2')` walks `DATA_VERSION_ORDER` backwards from the preferred version until
it finds a dataset that exists. Given the registry in `src/data/datasets.ts` (`labor: {v1,v2}`,
`phases: {v1}`, `wbs: {v1}`, `equipment: {v1,v2}`), a proposal created today gets:

```json
{ "labor": "v2", "phases": "v1", "wbs": "v1", "equipment": "v2" }
```

This is **pinned onto the proposal at creation time and never migrated**. It is the app's only
versioning mechanism for cost datasets.

### 3.5 Related Firestore collections

| Collection             | Written by this area                               | Notes                                                             |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `proposals`            | create / update / delete / duplicate               |                                                                   |
| `wbs`                  | 18 docs created per new proposal                   | deleted with proposal (correctly)                                 |
| `phase`                | —                                                  | **`'phase'` is the real name.** Delete uses `'phases'` → see §6.1 |
| `activities`           | —                                                  | deleted with proposal (correctly)                                 |
| `proposal-preferences` | lazily created on first read; duplicated by the CF | **never deleted** → orphan on every proposal delete               |
| `users`                | read for `role` / `permission`                     |                                                                   |

---

## 4. Exact formulas and business rules

### 4.1 Hit Rate (`proposal_select.tsx:39-47`)

```
pending    = count(status ∈ {Bidding, Open})
submitted  = count(status === Submitted)
awarded    = count(status === Awarded)
rejected   = count(status ∈ {Rejected, Declined})
totalDecided = awarded + rejected
hitRate    = totalDecided > 0
             ? parseFloat(((awarded / totalDecided) * 100).toFixed(1))
             : 0
```

Submitted-but-undecided proposals are excluded from the denominator. `Closed` and `None` are
excluded from every bucket but still counted in `total` — so the four distribution segments do
**not** sum to 100% whenever any proposal is `Closed` or status-less.

### 4.2 Due-date urgency (`proposal_select.tsx:166-168`)

```
dueDate   = parseISO(p.proposalDateDue || '')
isOverdue = isValid(dueDate)
            && differenceInDays(dueDate, now) < 0
            && status ∈ {Bidding, Open}
isDueSoon = isValid(dueDate)
            && 0 <= differenceInDays(dueDate, now) <= 7
            && status === Bidding          // NOTE: Open is excluded here but included above
```

The asymmetry is in the source: `isOverdue` accepts `Bidding | Open`, `isDueSoon` accepts only
`Bidding`. An `Open` proposal due tomorrow gets no warning colour.

### 4.3 Next proposal number (`add_proposal_dialog.tsx:26-38`)

```
if (data.length > 0)
   next = max( parseFloat(p.proposalNumber) for all p, dropping NaN ) + 1
else
   next = 1300      // magic seed
```

Then on write: `proposalNumber: parseInt(proposalNumber)` (`api/proposal.ts:31`).

Consequences:

- The `+1` is applied to the _maximum including revision decimals_. If the max is `1300.1`, the
  seeded default is `1301.1`, which `parseInt` then truncates to `1301` on save — the UI shows a
  number that is not the number that gets stored.
- If every stored `proposalNumber` is non-numeric, the filter empties the array and `Math.max()`
  returns `-Infinity`, so the field is seeded with the string `"-Infinity"`.
- **There is no uniqueness check.** Two proposals can trivially share a number.
- `parseInt` silently truncates any decimal the user types.

### 4.4 Proposal creation (`api/proposal.ts:23-38`)

```ts
export const insertProposal = async (proposalDescription, proposalNumber) => {
  const datasetVersions = buildDatasetVersions(CURRENT_DATA_VERSION);
  const proposal = new FirestoreProposal({
    proposalDescription,
    proposalNumber: parseInt(proposalNumber),
    datasetVersions,
  });
  await addDoc(collection(firestore, "proposals"), { ...proposal }).then(async (docRef) => {
    await insertAllBaseWbs(docRef.id, datasetVersions);
  });
};
```

The written document therefore is:

- `proposalDescription` = whatever was typed (**not** uppercased, not trimmed)
- `proposalNumber` = `parseInt(...)`
- `datasetVersions` = `{labor:'v2', phases:'v1', wbs:'v1', equipment:'v2'}`
- **all 15 rate fields = `0`**
- **every other field = `null`**, including `proposalStatus`

So a brand-new proposal has **no status**, which means it renders as a grey `—` chip and is counted
in `total` but in **none** of the In Progress / Submitted / Awarded buckets. It is invisible to
every filter.

There is **no `createdAt`, no `createdBy`, no `updatedAt`, no `updatedBy`** on creation. (The
duplicate Cloud Function does set `createdAt` — inconsistently.)

### 4.5 Base WBS seeding (`api/wbs.ts:23-41`)

Every new proposal gets 18 WBS documents inserted from `src/data/v1/wbs_v1.json`:

| wbsDatabaseId | name                     |
| ------------- | ------------------------ |
| 10000         | MOBILIZE                 |
| 20000         | SITE PREPARATION         |
| 30000         | CONCRETE                 |
| 40000         | TOWERS/VESSELS/EQUIPMENT |
| 50000         | PUMPS & DRIVERS          |
| 60000         | STRUCTURAL               |
| 70000         | AG PIPING                |
| 80000         | ELECTRICAL               |
| 90000         | INSTRUMENTS              |
| 100000        | INSULATION               |
| 110000        | PAINTING                 |
| 120000        | DISMANTLING              |
| 130000        | BG PIPING                |
| 140000        | REFRACTORY               |
| 150000        | BUILDINGS                |
| 180000        | SPECIALTY SERVICES       |
| 190000        | DEMOBILIZE               |
| 200000        | SUPPORT                  |

(160000 and 170000 do not exist. The JSON is ordered lexicographically by stringified id, so the
insertion order is `10000, 100000, 110000, …, 20000, 200000, 30000, …` — not numeric.)

The loop is `wbsData.forEach(async (wbs) => { await insertBaseWbs(...) })` — **an async callback
inside `forEach`**, so `insertAllBaseWbs` resolves immediately and `insertProposal` resolves before
any of the 18 writes complete. The dialog closes while 18 writes are still racing, with no error
handling and no rollback.

### 4.6 Deletion cascade (`api/proposal.ts:128-170`)

```ts
export async function deleteProposalAndAssociatedData(proposalId: String) {
  const batch = writeBatch(firestore);
  await deleteAssociatedData('activities', proposalId, batch);
  await deleteAssociatedData('phases',     proposalId, batch);   // ← wrong collection name
  await deleteAssociatedData('wbs',        proposalId, batch);
  const proposalRef = doc(firestore, 'proposals', proposalId.toString());
  try {
    await deleteDoc(proposalRef);     // ← proposal deleted BEFORE the batch commits
    await batch.commit();
  } catch (error) { console.error(...); }   // ← swallowed, user never told
}
```

`deleteAssociatedData` runs `where('proposalId','==',proposalId)` and stages a `batch.delete` per
doc.

Business rules as implemented:

- Deletion is **immediate and permanent**. There is no soft delete, no trash, no undo, no archive
  anywhere in the codebase (a case-insensitive grep for `archive` across `src/` returns **zero**
  hits).
- `proposal-preferences/{proposalId}` is not touched → orphaned.
- See §6.1 for the two data-integrity bugs in this function.

### 4.7 Duplication (`functions/src/index.ts`, callable `duplicateProposal`)

Runs with `timeoutSeconds: 540, memory: '8GB'`.

1. Load `proposals/{proposalId}`; 404 → `HttpsError('not-found')`. Missing arg →
   `HttpsError('invalid-argument')`.
2. `baseProposalNumber = parseFloat(proposalData.proposalNumber)`.
3. Query siblings: `where('proposalNumber','>=', base).where('proposalNumber','<', base+1)`.
4. `decimalParts = siblings.map(n => n - base).filter(p => p >= 0)`.
5. Find the next free decimal:
   ```ts
   let nextDecimal = 0.1;
   while (decimalParts.includes(nextDecimal))
     nextDecimal = parseFloat((nextDecimal + 0.1).toFixed(1));
   ```
6. `newProposalNumber = base + nextDecimal`; `revisionNumber = Math.round(nextDecimal * 10)`.
7. New description: strip any trailing `" - Rev N"` via `/\s*-\s*Rev\s+\d+$/i`, then append
   `" - Rev {revisionNumber}"` (prevents `Rev 1 - Rev 1` stacking).
8. Copy the proposal doc verbatim plus `createdAt: new Date()`, the new number and the new
   description.
9. Copy `proposal-preferences/{oldId}` → `proposal-preferences/{newId}` (with `id` rewritten).
10. Copy every `wbs` where `proposalId == old`, building `wbsIdMap[oldWbsId] = newWbsId`.
11. Copy every `phase` where `proposalId == old`, remapping `wbsId` via `wbsIdMap`, building
    `phaseIdMap`.
12. For each phase, copy every `activity` where `phaseId == oldPhaseId`, remapping `phaseId`,
    `wbsId`, `proposalId`.
13. Batches flush every 500 operations.

**The revision-numbering loop is broken by floating point** — confirmed by execution:

```
base = 1300, existing = [1300, 1300.1]
decimalParts        → [0, 0.09999999999990905]
0.09999999999990905 === 0.1 → false
⇒ nextDecimal stays 0.1 ⇒ newProposalNumber = 1300.1 (again), revisionNumber = 1 (again)
```

The same holds for small numbers (`9.1 - 9 === 0.09999999999999964`). **Every duplicate of a given
proposal is always `base + 0.1` and always labelled `Rev 1`.** Duplicating twice produces two
documents with an identical number and an identical description.

---

## 5. UX problems observed (with evidence)

**P1 — Creation captures 2 fields out of ~23 user-editable ones.** `add_proposal_dialog.tsx`
collects only number + description. Status, owner, due date, estimator, bid type, contact — all
null. The user must create, hunt for the new proposal in the list, open it, find the Details tab,
click Edit, fill everything, click Save. Two disjoint entry surfaces for one mental task.

**P2 — New proposals are statusless and therefore invisible to every filter.** `insertProposal`
never sets `proposalStatus`. Evidence: `FirestoreProposal` defaults it to `null`
(`proposal_firestore.ts:182`) and `insertProposal` doesn't pass it. Result: the dashboard shows `—`,
and `stats.pending/submitted/awarded/rejected` all skip it.

**P3 — The landing table silently hides everything past row 50.** `proposal_select.tsx:74`:
`.slice(0, 50)`. No indicator, no pagination, no "showing 50 of N".

**P4 — Two search boxes that search different things, neither of which searches the main table.**
Sidebar search (`drawer.tsx:134-162`) covers 22 fields and filters only the sidebar.
Manage-Proposals search (`edit_proposals_dialog.tsx:40-43`) covers 2 fields and filters only that
dialog. The main dashboard table has **no search at all**.

**P5 — The sidebar and the main pane are redundant, and disagree.** Both render the full proposal
list from the same hook; the sidebar shows number+description, the table shows
number/description/owner/status/due and is capped at 50. Filtering one never affects the other.

**P6 — Filtering is a 6-pixel bar.** `proposal_select.tsx:99-115`. The only status filter in the app
is a click target 6px tall with no cursor affordance beyond `cursor: pointer`, no focus ring, no
`role`, and no keyboard path.

**P7 — Zero sorting control.** Always `proposalNumber` descending (`proposal_select.tsx:74`,
`proposals_hook.ts`, `proposal_list.tsx:33`) — three independent re-implementations of the same
sort. You cannot sort by due date, status, or owner.

**P8 — Modal stacked on modal for delete.** `DeleteConfirmationDialog` is rendered inside the
`EditProposalsDialog`'s JSX (`edit_proposals_dialog.tsx:161`). Confirm-on-top-of-manage, both
dimming the app behind them.

**P9 — Per-row action state is global.** `isDuplicating` / `isDeleting` are single booleans
(`edit_proposals_dialog.tsx:37-38`) applied to **every** row's buttons (lines 142-151). Duplicating
one proposal spins and disables the duplicate button on all of them, and there is no indication
_which_ one is running.

**P10 — Duplicate has no confirmation, no feedback, and no error surface.** `handleDuplicate` (lines
45-56) fires a callable that can run up to 9 minutes and only `console.error`s on failure. The user
sees a spinner disappear and must infer success from the list changing.

**P11 — Delete errors are swallowed.** `api/proposal.ts:148` —
`catch (error) { console.error(...) }`. Nothing bubbles to the UI. The dialog happily returns to its
normal state whether or not anything was deleted.

**P12 — No optimistic/pending affordance on create.** The "Add Proposal" button never enters a
loading state (`add_proposal_dialog.tsx:73-81`). Double-click → two proposals.

**P13 — Mouse-only everything.** No `onKeyDown` in the entire area. Rows are `<Box onClick>`, not
`<button>`/`<a>`. The New Proposal dialog has no `<form>`, so Enter does nothing. Nothing is
tab-reachable except MUI's own inputs.

**P14 — Four simultaneous realtime listeners on the entire `proposals` collection.**
`useProposals()` is called by `drawer.tsx:127`, `proposal_select.tsx:30`,
`add_proposal_dialog.tsx:21`, and `edit_proposals_dialog.tsx:33`. Both dialogs are always mounted
(`drawer.tsx:427` and `:434`) even when closed, so all four `onSnapshot` subscriptions on
`collection('proposals')` are live at once, on the home screen, forever. No `limit()`, no `where()`,
no pagination — every proposal document is streamed to every client on every change, four times
over.

**P15 — Due dates render with no year.** `format(dueDate, 'MM/dd')` (`proposal_select.tsx:216`). A
proposal due 03/14/2024 and one due 03/14/2026 are indistinguishable.

**P16 — An estimating app's home screen shows no money.** No column, stat, or chip anywhere in
`proposal_select.tsx` references `totalCost`, `craftCost`, or any dollar amount — even though those
fields exist on the model.

**P17 — Data entry is destructive by construction.** `updateSingleProposal` is a `setDoc` full
overwrite (`api/proposal.ts:104-106`) and the write shape (`FirestoreProposal`) omits the 9 roll-up
cost fields plus `quantity`/`unit`. Any save through `ProposalInfoAccordion` erases them.

**P18 — Accordion-hidden fields.** `features/proposal home/components/proposal_info_accordion.tsx`
puts all ~20 proposal fields inside a collapsed MUI `<Accordion>` with a single "Save" button at the
bottom of a 3-column layout. The confirmation is a `<Dialog>` containing a bare
`<Alert severity='info'>Proposal information successfully saved.</Alert>` (line 436-438) — a modal
used as a toast.

**P19 — Blocking full-pane spinner.** `proposal_select.tsx:77-83` replaces the entire screen with a
20px spinner while the first snapshot lands. No skeleton, no stale-while-revalidate.

**P20 — MemoryRouter means no addressable state.** `App.tsx:2`. No shareable link to a proposal, no
browser back, no restore-on-reload, no "open in new window".

**P21 — Empty state is a dead end.** `No proposals found.` with no create button
(`proposal_select.tsx:222-228`, `proposal_list.tsx:98-102`). A brand-new user with write permission
must discover the hamburger in the sidebar header.

**P22 — Uppercase is applied at render, not at storage.** `textTransform: 'uppercase'` on
description and owner in both the table (`proposal_select.tsx:188, 191`) and the sidebar
(`proposal_list.tsx:89`), while search compares `toLowerCase()` against raw stored values. The
display casing and the stored casing are permanently out of sync, which also means the "Ex.
Proposal" placeholder in the create dialog is misleading.

---

## 6. Dead or broken code

### 6.1 BROKEN — deleting a proposal orphans every phase (data corruption)

`src/api/proposal.ts:135` deletes from collection **`'phases'`**:

```ts
await deleteAssociatedData("phases", proposalId, batch);
```

The actual collection is **`'phase'`** — confirmed across `src/api/phase.ts` (lines 28, 34, 61, 72,
86, 96, 108, 150, 236), `src/hooks/phase_hook.ts:20`, `src/api/data_dump.ts:291`, and the Cloud
Function (`functions/src/index.ts:154`). A collection-name census of the client shows only
`activities` (24), `phase` (11), `wbs` (6), `proposals` (6) — **`phases` does not exist**.

Effect: every proposal deletion leaves 100% of its phase documents in Firestore forever, referencing
a proposal id that no longer exists. Activities and WBS are removed correctly, so the orphaned
phases are also childless. This has been silently accumulating garbage in production.

### 6.2 BROKEN — the proposal doc is deleted before the cascade is committed

`api/proposal.ts:145-146`: `await deleteDoc(proposalRef)` runs **before** `await batch.commit()`,
both inside one `try`. If the commit throws (e.g. the 500-write batch limit — a proposal with more
than ~500 activities+wbs docs will exceed it), the proposal is already gone and all its children
survive as unreachable orphans. The error is caught and only `console.error`'d.

There is no batching/chunking on the client side at all — unlike the Cloud Function, which correctly
flushes every 500 operations.

### 6.3 BROKEN — duplicate revision numbering never advances (float equality)

`functions/src/index.ts:61-72`. Confirmed by execution:

```
1300.1 - 1300  = 0.09999999999990905   → !== 0.1
   9.1 -    9  = 0.09999999999999964   → !== 0.1
```

`decimalParts.includes(nextDecimal)` is therefore always `false`, the `while` loop never runs, and
every duplicate is `base + 0.1` / `Rev 1`. Duplicating the same proposal twice yields two documents
with the same `proposalNumber` and the same description.

### 6.4 BROKEN — saving a duplicated revision collapses its number

`proposal_info_accordion.tsx:117` — `proposalNumber: parseInt(proposalNumber)`.
`parseInt('1300.1') === 1300` (confirmed). Opening a `Rev 1` duplicate and pressing Save silently
renumbers it back onto the original, producing two proposals numbered `1300`.

### 6.5 BROKEN — `NaN` written to Firestore for empty numeric fields

`proposal_info_accordion.tsx:119` `coNumber: parseInt(coNumber)` and `:129`
`contactZip: parseInt(zip)`. When the field is blank, `parseInt('')` is `NaN`, and `NaN ?? null` in
`FirestoreProposal` evaluates to `NaN` (nullish coalescing does not catch `NaN`). Firestore stores
`NaN` as a double; the value then renders as the string `"NaN"` on read-back.

### 6.6 BROKEN — the sidebar's "active proposal" highlight and scroll-restore never fire

`drawer.tsx:130-132`:

```ts
useEffect(() => {
  return () => {
    sessionStorage.removeItem("selectedProposalId");
  };
}, []);
```

Each `<Route>` in `App.tsx` renders its own `<EstimatorDrawer>` instance, so navigating between `/`
and `/proposal/:id` unmounts one drawer and mounts another — firing the cleanup and clearing the
key. `ProposalList` reads that key both for `isActive` styling (`proposal_list.tsx:31, 47`) and for
the `scrollIntoView` restore effect (`proposal_list.tsx:17-23`). Both are therefore dead in
practice.

Additionally `savedProposalId` is read from `sessionStorage` during render rather than held in state
(`proposal_list.tsx:31`), so the highlight only updates by accident when the router re-renders.

### 6.7 BROKEN — a missing/deleted proposal is an unrecoverable dead end

`drawer.tsx:290` gates the whole header on `proposalId && currentProposal`. If the proposal document
doesn't exist (deleted in another session, bad id), `currentProposal` stays `undefined`, so:

- the `ArrowBack` → `/` button is not rendered,
- the breadcrumb (`drawer.tsx:192`) is not rendered,
- but `proposalId != null`, so the home list block (`:329`) is skipped and the proposal-nav block
  (`:368`) renders with `Proposal Home` and `WBS Home` both disabled.

There is no route back to the home screen. MemoryRouter means there is no browser back button
either.

### 6.8 BROKEN — `hasWritePermissions` can latch to `false` forever on cold start

`src/hooks/user_profile_hook.ts` runs its effect with `[]` deps and reads `getAuth().currentUser`
synchronously. It never subscribes to `onAuthStateChanged`. On a cold app start the Firebase auth
session is restored asynchronously, so `currentUser` is frequently `null` at that moment →
`userProfile = null` → `isAdmin = false`, `hasWritePermissions = false`, and the effect never
re-runs. Consequence: the Add/Edit hamburger (`drawer.tsx:313`) and the Admin Console menu item
(`:245`) can be permanently missing for a legitimately privileged user until they trigger a remount.

### 6.9 DEAD — `src/components/project_card.tsx` (77 lines)

Never imported anywhere (grep across `src/` returns only its own definition). It is a Chakra UI
pricing card with a hardcoded `$349`, `unlimited build minutes`, and two `Lorem, ipsum dolor.` list
items, plus a "View Proposal" button. It is also the only Chakra UI component left in the app
(everything else is MUI), which is why `@chakra-ui/react` is still a dependency.

### 6.10 DEAD — `src/features/home/components/add_proposal_dialog_button.tsx` (23 lines)

Never imported. Superseded by the `ProposalMenu` "Add" item in `drawer.tsx:491`. Still contains a
`<Divider/>` nested _inside_ a `<MenuItem>`, which is invalid.

### 6.11 DEAD — commented-out client-side duplication (`api/proposal.ts:172-223`)

52 lines of commented-out `duplicateProposalAndAssociatedData` / `duplicateAssociatedData`,
including the literal placeholder `doc(firestore, 'proposals', "d;lskfa;sldfk")`. Superseded by the
Cloud Function.

### 6.12 DEAD — unused imports and props

- `proposal_select.tsx:1` imports `useEffect` (unused), `:11` imports `addDays` (unused), `:10`
  imports `Proposal` (unused).
- `add_proposal_dialog.tsx:21` destructures `loading` — never used.
- `edit_proposals_dialog.tsx:33` destructures `loading` — never used, so the list flashes empty.
- `EditProposalsDialogProps.onDelete` is required, is passed `() => {}` from `drawer.tsx:434`, and
  is **never called** inside the dialog.
- `ProposalListProps.onClick` is required, is passed `() => {}` from `drawer.tsx:362`, and does
  nothing.
- `drawer.tsx:123` `addPhaseDialogOpen` is stateful but nothing ever sets it to `true`
  (`AddPhaseDialog` at `:432` can never open from here).
- `api/proposal_preferences.ts:9-12` builds a `tempArray` of WBS names and never uses it.

### 6.13 DEAD — `convertRatesToNumbers` doesn't cover the field that matters

`api/proposal.ts:40-76` coerces 24 fields from string→number on read but **does not include
`proposalNumber`**. Meanwhile `proposal_home.tsx:82-90` `handleChange` writes raw `e.target.value`
strings, so editing "Proposal #" in the newer Proposal Details surface stores a **string**. A
string-typed `proposalNumber` will never match the Cloud Function's numeric range query
(`where('proposalNumber','>=', number)`), so duplication silently loses collision detection for it.

### 6.14 MISNAMED — `src/components/copy_activities_from_proposal_dialog.tsx`

Despite the name, it only lists phases from the **current** proposal
(`allPhases = store.phases[proposalId]`, filtered to `phase.id !== phaseId`). There is no
cross-proposal copy anywhere in the app.

### 6.15 MISSING — no Firestore security rules in the repo

`firebase.json` declares only the `functions` codebase. There is no `firestore.rules` file anywhere
outside `node_modules`. All authorization is client-side (`useUserProfile` → `hasWritePermissions`),
which means it is advisory only.

---

## 7. PARITY CHECKLIST

Every discrete capability Precision must eventually have from this area. `[essential]` marks a hard
requirement for replacing the legacy app; `[optional]` marks behavior that exists but that a
redesign may legitimately drop or replace.

**Landing / list**

- [essential] Land on a list of all proposals immediately after auth, with no intermediate picker.
- [essential] List each proposal with at minimum: proposal number, description, owner, status, due
  date.
- [essential] Sort proposals by proposal number, descending, as the default.
- [essential] Open a proposal by clicking its row, navigating to the proposal workspace.
- [essential] Show an explicit empty state when no proposals exist.
- [essential] Show a loading state while proposals are being fetched.
- [essential] Reflect creates / edits / deletes / duplications made elsewhere in real time, without
  a manual refresh.
- [optional] Show a count of total proposals.
- [optional] Show counts of proposals in progress (Bidding + Open), submitted, and awarded.
- [optional] Show a hit-rate percentage = awarded / (awarded + rejected + declined), one decimal.
- [optional] Show a proportional status-distribution visualization across Pending / Submitted /
  Awarded / Rejected.
- [optional] Filter the list by clicking a status bucket, and clear that filter.
- [optional] Highlight overdue proposals (due date in the past, status Bidding or Open).
- [optional] Highlight due-soon proposals (due within 7 days, status Bidding).
- [optional] A persistent secondary navigation list of proposals alongside the main content.
- [optional] Highlight the currently-open proposal in that navigation list and scroll it into view.

**Search**

- [essential] Free-text search over proposals that matches, at minimum, proposal number and
  description.
- [essential] Search must apply to the primary proposal list, not only to a secondary panel.
- [optional] Extend search across all 22 legacy-searchable fields: proposalNumber, job, coNumber,
  proposalDescription, proposalOwner, projectCity, projectState, jobSiteAddress, proposalEstimators,
  proposalDateReceived, proposalDateDue, projectStartDate, projectEndDate, bidType, proposalStatus,
  contactName, contactAddress, contactCity, contactState, contactZip, contactPhone, contactEmail.

**Creation**

- [essential] Create a new proposal.
- [essential] Capture a proposal number and a description at creation time.
- [essential] Auto-suggest the next proposal number as `max(existing) + 1`, seeded at `1300` when
  the collection is empty.
- [essential] Allow the suggested number to be overridden.
- [essential] Block submission when number or description is empty.
- [essential] Seed the new proposal with the 18 base WBS records (ids 10000, 20000, 30000, 40000,
  50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000, 130000, 140000, 150000, 180000, 190000,
  200000).
- [essential] Seed all 15 rate fields to a defined default (legacy: 0).
- [essential] Pin the cost-dataset versions onto the proposal at creation (legacy:
  `{labor:'v2', phases:'v1', wbs:'v1', equipment:'v2'}`), and honor that pin thereafter.
- [essential] Guarantee the proposal and its seeded WBS are created atomically (legacy does not —
  fix this).
- [essential] Give the new proposal a valid initial status rather than null (legacy does not — fix
  this).
- [essential] Enforce, or at minimum warn on, duplicate proposal numbers (legacy does not — fix
  this).
- [essential] Record who created the proposal and when (legacy does not — fix this).
- [optional] Capture the remaining proposal fields during creation instead of forcing a second edit
  pass.

**Editing proposal information**

- [essential] Edit every field in §3.1: `proposalNumber`, `job`, `coNumber`, `proposalDescription`,
  `proposalOwner`, `jobSiteAddress`, `projectCity`, `projectState`, `proposalEstimators`,
  `proposalDateReceived`, `proposalDateDue`, `projectStartDate`, `projectEndDate`, `bidType`,
  `proposalStatus`, `contactName`, `contactAddress`, `contactCity`, `contactState`, `contactZip`,
  `contactPhone`, `contactEmail`.
- [essential] Constrain `bidType` to: None, Lump Sum, Time and Materials, Budgetary, Rates, Cost
  Plus.
- [essential] Constrain `proposalStatus` to: None, Bidding, Submitted, Awarded, Rejected, Declined,
  Open, Closed.
- [essential] Constrain `projectState` / `contactState` to a US-state list (legacy: None + 50
  states).
- [essential] Never destroy computed roll-up fields when saving proposal information (legacy
  `setDoc` overwrite does — fix this).
- [essential] Preserve decimal proposal numbers on save (legacy `parseInt` truncates — fix this).
- [essential] Never write `NaN` for a blank numeric field (legacy does — fix this).
- [essential] Store `contactZip` as text so leading zeros survive (legacy stores it as a number —
  fix this).
- [optional] Auto-format phone input to `(XXX) XXX-XXXX`.
- [optional] Confirm a successful save with non-blocking feedback.

**Duplication**

- [essential] Duplicate a proposal, deep-copying: the proposal document, its preferences, all WBS,
  all phases (with WBS references remapped), and all activities (with phase / WBS / proposal
  references remapped).
- [essential] Assign the duplicate a revision number derived from the source (legacy: `base + 0.1`,
  `+ 0.2`, …) and a description suffixed `" - Rev N"`.
- [essential] Strip any existing `" - Rev N"` suffix before appending, so revisions never stack.
- [essential] Correctly detect existing revisions and advance to the next free one (legacy float
  comparison is broken — fix this).
- [essential] Handle proposals large enough to exceed a single write batch.
- [essential] Record `createdAt` on the duplicate.
- [essential] Report duplication progress and failure to the user (legacy only logs to console — fix
  this).
- [optional] Navigate to the new revision once duplication finishes.

**Deletion**

- [essential] Delete a proposal.
- [essential] Require explicit confirmation naming the proposal being deleted, and state that the
  action is irreversible.
- [essential] Cascade the delete to all activities, all phases, and all WBS belonging to the
  proposal (legacy misses phases entirely — fix this).
- [essential] Cascade the delete to the proposal's preferences record (legacy orphans it — fix
  this).
- [essential] Make the cascade atomic, or ordered so children die before the parent (legacy deletes
  the parent first — fix this).
- [essential] Surface deletion failures to the user (legacy swallows them — fix this).
- [essential] Handle proposals whose child count exceeds a single write batch.
- [essential] Never leave the user stranded in a proposal that no longer exists — always provide a
  route home (legacy dead-ends — fix this).

**Archiving**

- No archive capability exists in the legacy app at all (`grep -ri archive src/` → 0 hits). The only
  removal mechanism is permanent deletion, and the only lifecycle signal is the `proposalStatus`
  enum (`Closed` / `Declined` / `Rejected`), which the landing dashboard does not filter on.
  Anything Precision does here is net-new, not parity.
- [optional] Treat `Closed` as an archived-like state and exclude it from the default list view.

**Permissions**

- [essential] Gate proposal creation, editing, duplication, and deletion behind a write permission
  (legacy: `UserProfile.permission === 'readWrite'`).
- [essential] Gate an admin console behind an admin role (legacy: `UserProfile.role === 'admin'`).
- [essential] Resolve the user's permissions reliably after auth restore (legacy latches to
  read-only on cold start — fix this).
- [essential] Enforce permissions server-side (legacy has no Firestore rules in the repo at all —
  fix this).

**Management surface**

- [essential] A place to see every proposal with per-row duplicate and delete actions.
- [essential] Search within that surface.
- [essential] Per-row (not global) pending state for row actions (legacy disables every row's
  buttons — fix this).
- [optional] Bulk selection and bulk delete.
- [optional] Rename / status change directly from the list.

**Cross-cutting expectations Precision must beat**

- [essential] Do not cap the visible list at an arbitrary 50 rows without telling the user.
- [essential] Do not open two independent search boxes over the same data with different field
  coverage.
- [essential] Do not run four concurrent full-collection realtime subscriptions to render one
  screen.
- [essential] Full keyboard operability: Enter submits the create form, list rows are focusable and
  activatable, Escape closes dialogs, and no action is mouse-only.
- [essential] Never stack a confirmation modal on top of another modal.
- [essential] Show dates with an unambiguous year (legacy renders `MM/dd` only).
- [essential] Deep-linkable / restorable navigation state (legacy uses `MemoryRouter` — no URLs at
  all).
- [optional] Surface each proposal's total estimated value on the landing screen — the legacy home
  screen displays no dollar figure anywhere despite `totalCost` existing on the model.
