# Momentum ↔ Precision Reuse Audit

**Scope:** `apps/momentum/src/**`, `apps/precision/src/**`, `packages/features/src/**`,
`packages/ui/src/**` **Question answered:** what can Precision reuse today, what should be promoted
out of Momentum, and what genuinely cannot be shared. **Method:** read the source. Every claim below
is anchored to a file and, where useful, a line number. Doc files (`BRANDING.md`, `CLAUDE.md`) were
checked _against_ the code and several are stale — flagged in §7.

---

## 0. Executive summary

The two apps already sit on a **large shared substrate**: `packages/ui` (36 shadcn components + a
3-layer token system) and `packages/features/desktop-shell` (AppShell, three-column layout, sidebar,
command palette, status bar, providers). Both apps mount the identical `AppShell` with a per-context
config object. That part of the "share as much UI as possible" goal is basically already done.

Where the two apps diverge is **the feature layer**, and the divergence is not architectural — it is
**maturity**. Momentum's dialogs, list surfaces, error handling, and keyboard affordances went
through a real polish pass (Matt's test-log batches are visible in the code as `#22`, `#25`, `#26`,
`#30`, `#31`, `#33`, `#34`, `#36`, `#38`, `#46`, `#48`, `#51` comment tags). Precision's equivalents
are the first draft that predates that pass. So "share UI between Momentum and Precision" is,
concretely, **"promote Momentum's polished components into `packages/features` and delete
Precision's first drafts."**

Three headline findings:

1. **`add-activity-dialog` is 80–85% unifiable today.** The Convex mutation payloads are
   _byte-identical in shape_ (`momentum.ts:3532` vs `precision.ts:1387`) and both pool queries read
   the same `laborPool` / `equipmentPool` tables. The differences are (a) how the labor catalog is
   _resolved_ (Momentum server-side in one query; Precision via a 3-query client waterfall), (b)
   `custom_labor` as a sub-mode vs a peer tab, and (c) the footer preview being MH-based vs needing
   to be $-based. All three are parameterizable.
2. **One grid abstraction is NOT viable; three shared grid _primitives_ are.** Momentum's workbook
   is a 3-level expandable tree with one editable column. Precision's activity grid is flat with ten
   editable columns plus multi-select. But both hand-roll the _same_ DOM-attribute keyboard
   navigation and the _same_ local-state/debounce/escape-discard editable cell. Extract the
   primitives, not the grid.
3. **Precision does not type-check and has a hard-broken admin page.** `apps/precision` has **27
   app-level TS errors** (Momentum: 2). `apps/precision/src/routes/admin/index.tsx:46` reads
   `workspace?.organizationId` — the field is `organization_id` — so the members query is
   permanently `"skip"` and the page renders a skeleton forever.

---

## 1. What is already shared (inventory)

### 1.1 `packages/ui/src/components` — 36 components, JIT (source, no build step)

| Used by both                                                                                                                                                                             | Used by one                                                                                                                                                                                                                                             | **Zero consumers (dead)**                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| button, input, label, dialog, select, badge, skeleton, dropdown-menu, table, tooltip, popover, command, separator, scroll-area, sonner, avatar, alert-dialog, collapsible, card, sidebar | switch, progress, checkbox (Precision only), sheet (Momentum only, via entry-history-panel), tabs (Precision only), breadcrumb (shell only), resizable (shell only), calendar + date-picker (Momentum only), status-badge (only by the dead `wbs-card`) | **menubar** (252 LOC), **context-menu** (219 LOC), **form** (152 LOC, react-hook-form + zod wrapper) |

`packages/ui/package.json` exposes a wildcard `"./components/*"`, so anything in the folder is
importable regardless of whether it is listed explicitly. `components/index.ts` barrel exists but
**no app or package imports from it** — every consumer uses the deep path
(`@truss/ui/components/button`). The barrel is dead code.

### 1.2 `packages/features/src/desktop-shell` — the real shared shell

Both apps mount it identically (`apps/momentum/src/routes/__root.tsx:173`,
`apps/precision/src/routes/__root.tsx:123`):

```
AppShell(config, linkComponent=RouterLink, navigate, currentPath, onLogout, topBarContent)
  └ ShellProvider → ThemeProvider → DensityProvider → KeyboardProvider
      └ ThreeColumnLayout (SidebarProvider + AppSidebar + AppBar + Resizable detail panel)
      └ StatusBar, CommandPalette, Toaster
```

- **`app-sidebar.tsx` (528 LOC)** — three item renderers: `NavSection` (collapsible group),
  `FlatNavItem`, and `TreeNavItem` (two-level parent→children with split chevron hit-target,
  child-count badge, left-edge 2px accent rail, and `parsePhaseLabel()` which splits
  `"42 — Pipe Spool"` into mono number + description). **Precision is the only consumer of
  `TreeNavItem`** (its WBS→Phase sidebar tree, `shell-config-estimate.ts:48-58`). Momentum's sidebar
  is 3 flat links.
- **`command-palette.tsx`** — ⌘K, category grouping, recents in
  `localStorage["truss-recent-commands"]`, opened by `document` event `open-command-palette`.
- **`keyboard-provider.tsx`** — global shortcut registry with `normalizeKey()`; note it treats
  **Ctrl and Cmd as the same modifier** (line 40), and allows only `cmd+k`/`cmd+p` to fire while
  focus is in an input (line 113).
- **`three-column-layout.tsx`** — the "master list" middle pane exists in the API but **neither app
  passes `showMasterList`**, so the resizable group currently renders a single 100% detail panel.
  Latent capability.
- **`status-bar.tsx`** — connection dot (real: `navigator.onLine`) + **fake sync indicator**
  (`const [syncStatus] = useState<SyncStatus>({ state: "idle" })`, line 31 — never updates) +
  clock + ⌘K button.
- **`use-layout-store.ts`** — zustand + persist (`truss-desktop-layout`), stores panel sizes/sidebar
  state.

### 1.3 `packages/features/src/progress-tracking` — 14 files, Momentum-only today

`workbook-table` (1635), `phase-reassign-dialog` (352), `status-slices` (359), `entry-history-panel`
(248), `project-switcher` (245), `entry-cell-input` (176), `project-card` (141), `project-list-row`
(134), `wbs-card` (120, **dead**), `project-context` (120), `project-display-utils` (116),
`note-popover` (77), `types` (183).

### 1.4 `packages/features/src/estimation` — Precision-only, thin

Only **three** real artifacts: `editable-cell.tsx` (177), `bottom-panel.tsx` (262), `types.ts` (194
— the 15 `ProposalRates` fields + `RATE_FIELD_CONFIG` + `DEFAULT_RATES`). Everything else
Precision-specific lives in `apps/precision/src`, un-shared. This asymmetry is the core of the reuse
problem: Momentum earned a package, Precision never got one.

### 1.5 Other shared features

- `organizations/` — `WorkspaceProvider` + `useWorkspace` + permission helpers. Both apps use it.
- `auth/auth-screen.tsx` (619) — both apps render it with `appName`/`appDescription` props.
  Genuinely shared, works.
- `project-assignments/` — types + `scope-utils` (role labels/descriptions). Momentum-only in
  practice.
- `admin/types.ts` — `MemberStatusFilter`. Momentum-only.
- **`settings/` (7 files, ~950 LOC) — completely dead.** `SettingsPage`, `ProfileSection`,
  `AccountSection`, `PreferencesSection`, `SettingsSidebar`, `ProfileAvatarUpload` have **zero
  importers** in either app, and `packages/features/package.json` doesn't even export a `./settings`
  subpath. `PreferencesSection` also re-implements theme switching against a _different_
  localStorage key (`"theme"`) than `ThemeProvider` (`"truss-theme"`) — if it were ever mounted the
  two would fight.

---

## 2. Deep dive: `add-activity-dialog` — Momentum vs Precision

|                 | **Momentum** `apps/momentum/src/components/add-activity-dialog.tsx` (1001 LOC)                                                                                                                                    | **Precision** `apps/precision/src/components/add-activity-dialog.tsx` (621 LOC)                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Props           | `open, onOpenChange, projectId: Id<"momentumProjects">, phaseId: Id<"momentumPhases">, phaseDescription?`                                                                                                         | `open, onOpenChange, phaseId: string, estimateId: string`                                                                                                                     |
| Type selector   | One row of 5 pills (`TABS`, l.68) + a **secondary `SubModeToggle`** inside Labor: "From catalog" / "Custom entry" (l.379)                                                                                         | **6 `TabsTrigger`s in two 3-col rows** incl. `custom_labor` as a peer tab (l.272-293), each with an icon                                                                      |
| Catalog widget  | `PoolBrowser` built on **cmdk `Command`** — type-to-filter, ↑/↓, ↵ to select, `loop`, item value includes `poolId` so duplicate descriptions stay selectable (l.643-669)                                          | Hand-rolled `Input` + `useMemo` filter + `ScrollArea` of `<button>`s (l.309-346). **No keyboard navigation, no ↵-select, no focus management**                                |
| After selection | Collapses to a `SelectedItemCard` chip with derived detail (`3.4 MH/LF (craft) · 0 MH/LF (weld)`) + "Change ✕" (l.671-696); constants hidden behind a `Disclosure` "Override constants" (l.420)                   | List stays open with a check mark; craft/weld constant inputs are **always visible** below (l.348-371)                                                                        |
| Auto-focus      | `useEffect` (l.151-163) focuses catalog search → or quantity, re-running on tab/mode/selection change                                                                                                             | None                                                                                                                                                                          |
| Numeric input   | `NumberInput` — `type="text"` + `inputMode="decimal"` + regex strip; documented WHY (no spinners, locale-safe) (l.890-907)                                                                                        | `type="number" step="any"` — browser spinners, locale decimal issues                                                                                                          |
| Validation      | Per-type `isValid` memo (l.189-207): qty > 0 always; catalog labor needs a selection; material/cost-only need description **and** price; custom labor allows 0-MH quantity-only items (RFI case)                  | `!description.trim() \|\| !quantity.trim()` only (l.180, l.612) — a material with no price submits happily                                                                    |
| Live feedback   | **`ActivityPreview`** footer strip (l.925-1001): MH for labor (`craft · weld` split), extended cost for material/equipment/cost-only, `labor+material+equipment` sum for sub. Explicit "quantity-only item" state | None                                                                                                                                                                          |
| Submit          | ⌘↵ from anywhere via form-level `onKeyDown` (l.332-339); `min-w-[110px]` button avoids reflow                                                                                                                     | Click only                                                                                                                                                                    |
| Errors          | `toast.success` / `toast.error` with server message (l.284-292)                                                                                                                                                   | `console.error` (l.245) — **silent failure to the user**                                                                                                                      |
| Layout          | Fixed `h-[600px]`, `p-0 gap-0`, scroll region between sticky header and footer                                                                                                                                    | `max-h-[85vh]`, default dialog padding                                                                                                                                        |
| Data fetch      | **1 query per pool**, server resolves everything: `getLaborPoolForProject({projectId, phaseId})` (`momentum.ts:2143`) handles phase-type → WBS-union → full-catalog fallbacks _and_ dataset version internally    | **3-query client waterfall**: `getPhase` → `getProposal` → only then `getLaborPool({datasetVersion, phasePoolId})` (l.69-88). Catalog can't render until two round-trips land |

### 2.1 What actually differs _for real reasons_

Only three things, and none of them are UI:

1. **ID branding.** `Id<"momentumPhases">` vs `Id<"phases">`. Solved with a `string` prop at the
   component boundary + a cast at the mutation call site (both apps already cast).
2. **Catalog resolution strategy.** Momentum's server query takes `(projectId, phaseId)`;
   Precision's takes `(datasetVersion, phasePoolId)`. **Both return rows from the same `laborPool`
   table** — identical row shape `{poolId, description, craftConstant, weldConstant, craftUnits}`;
   equipment likewise `{poolId, description, dayRate}`. So the shared component should take
   **already-fetched items**, not query refs.
3. **Semantics of the result.** Momentum is tracking: the number that matters is **man-hours** (they
   become earned MH). Precision is estimating: the number that matters is **cost after the 15 rate
   fields and markup**. That is exactly one prop's worth of difference — the preview renderer.

Everything else (two tabs vs pills, tab order, spinner inputs, missing toasts) is Precision being
older, not Precision being different.

### 2.2 Proposed shared component

`packages/features/src/activities/add-activity-dialog.tsx`, parameterized on:

```ts
interface AddActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** Free-text context line under the title ("Adding to 20020 — PIPE SPOOL"). */
  contextLabel?: string;

  /** Which of the 5 type groups to offer. Precision passes all; Momentum can hide none today. */
  enabledTypes?: ActivityKind[]; // "labor"|"material"|"equipment"|"subcontractor"|"cost_only"

  /** Catalog rows, already fetched by the app (apps own their Convex queries). */
  laborPool: LaborPoolItem[] | undefined; // undefined => loading
  equipmentPool: EquipmentPoolItem[] | undefined;

  /** Renders the always-visible footer strip. Momentum → MH; Precision → extended $ w/ rates. */
  renderPreview?: (draft: ActivityDraft) => React.ReactNode;

  /** One call, one payload shape — identical in both backends today. */
  onSubmit: (payload: AddActivityPayload) => Promise<void>;

  /** Defaults true; Precision may want createAnother for bulk entry. */
  closeOnSubmit?: boolean;
}
```

`AddActivityPayload` is literally the current mutation args, which are already identical:

```
{ phaseId, type, description, quantity, unit,
  laborPoolId?, equipmentPoolId?, labor?{craftConstant,welderConstant},
  equipment?{ownership,time}, subcontractor?{laborCost,materialCost,equipmentCost}, unitPrice? }
```

**Reusable sub-components to export alongside it** (all already written in the Momentum file, all
app-agnostic): `PoolBrowser`, `SelectedItemCard`, `PrimaryFields`, `DescriptionField`, `PriceField`,
`ConstantField`, `SubModeToggle`, `Disclosure`, `NumberInput`. `SubModeToggle`, `Disclosure` and
`NumberInput` in particular are generic enough to belong in `@truss/ui`.

**Effort:** ~1 day. Move the file, swap the two `useQuery` calls for props, swap `addActivity` for
`onSubmit`, add `renderPreview`. Precision then deletes 621 lines and gains keyboard-first catalog
search, validation, toasts, ⌘↵, and a live cost preview it never had.

**Bug to fix while you're there:** in
`apps/precision/src/routes/estimate/$estimateId.phase.$phaseId.tsx:408-415`, the "Add ▾" dropdown
lists all six types but **every item calls `setAddOpen(true)` with no type argument** — picking
"Material" opens the dialog on the Labor tab. The shared dialog should accept an `initialType`.

---

## 3. Reuse ledger

Legend: **(a)** already shared, usable as-is · **(b)** app-local, should be promoted (with cost) ·
**(c)** not reusable.

### 3.1 `packages/ui` — already shared

| Component                                                                                                                                                                                                                                                          | Class        | Note                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| button, input, label, dialog, select, badge, skeleton, dropdown-menu, table, tooltip, popover, command, separator, scroll-area, sonner, avatar, alert-dialog, collapsible, card, sidebar, tabs, checkbox, switch, progress, sheet, breadcrumb, resizable, calendar | **(a)**      | Zero changes needed                                                                                                                                                                  |
| `date-picker`                                                                                                                                                                                                                                                      | **(a)**      | Momentum-only today; Precision needs it for `dateDue`/`dateReceived` — it currently uses a raw `<input type="date">` (`$estimateId.index.tsx` `FormDate`). Straight swap.            |
| `status-badge`                                                                                                                                                                                                                                                     | **(a)**      | Correct semantic tokens (`mac-green/orange/red/blue`). Precision should use it instead of its hardcoded `STATUS_COLORS` maps.                                                        |
| `menubar`, `context-menu`, `form`                                                                                                                                                                                                                                  | **(c)** dead | 623 LOC with no consumers. `context-menu` is dead _because_ Tauri's WebView eats right-click — Momentum solved it with the native `Menu`/`MenuItem` API instead. Delete or document. |
| `components/index.ts` barrel                                                                                                                                                                                                                                       | **(c)** dead | Nothing imports it.                                                                                                                                                                  |

### 3.2 `packages/features` — already shared

| Module                                                                                                                                                    | Class                          | Note                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-shell/*` (AppShell, layouts, providers, hooks, app-bar, app-sidebar, command-palette, status-bar, theme-switcher, user-menu, workspace-switcher) | **(a)**                        | Both apps consume it. See §5 for the dead config keys inside it.                                                                                                                                                                                                                                                                                                                            |
| `organizations/*`                                                                                                                                         | **(a)**                        | Both apps.                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth/auth-screen`                                                                                                                                        | **(a)**                        | Both apps, prop-driven.                                                                                                                                                                                                                                                                                                                                                                     |
| `estimation/editable-cell`                                                                                                                                | **(a)**                        | Precision-only; should merge with `entry-cell-input` (§4.3).                                                                                                                                                                                                                                                                                                                                |
| `estimation/bottom-panel`                                                                                                                                 | **(a)**                        | Precision-only. Momentum's analogue is `ProjectStatusSlices`. Could converge into one "scope totals bar" but semantics differ enough (cost buckets vs MH slices) that convergence is cosmetic, not structural. Leave separate.                                                                                                                                                              |
| `estimation/types` (`ProposalRates`, `RATE_FIELD_CONFIG`, `DEFAULT_RATES`)                                                                                | **(a)**                        | The 15 rate fields. Momentum doesn't need them.                                                                                                                                                                                                                                                                                                                                             |
| `progress-tracking/project-card`, `project-list-row`, `project-display-utils`                                                                             | **(a)**, reusable by Precision | Precision's estimates list is a bare `<div onClick>` table. `ProjectCard`/`ProjectListRow` + `PROJECT_LIST_GRID_COLS` are already generic over `Project`; a small generalization (rename `Project` → an `EntityListItem` shape, make the metric column pluggable: `% + MH` for Momentum, `$ total + due date` for Precision) gives Precision tile/list parity for free. **Cost: ~0.5 day.** |
| `progress-tracking/project-switcher`                                                                                                                      | **(a)**, reusable              | Precision hand-rolled `estimate-switcher.tsx` (98 LOC, `DropdownMenu`, top-10 hardcoded, **no search**). `ProjectSwitcher` is cmdk-based with search + recents + actions and already listens for its own open event. Precision should use it with renamed labels. **Cost: ~0.5 day** (extract labels/icon as props).                                                                        |
| `progress-tracking/phase-reassign-dialog`                                                                                                                 | **(a)** for the _pattern_      | Multi-row allocation UI with live remainder. Estimating equivalent = "move/copy activities between phases", not yet built in Precision. Reuse the component when that story lands.                                                                                                                                                                                                          |
| `progress-tracking/entry-history-panel`, `note-popover`, `entry-cell-input`, `workbook-table`, `status-slices`, `project-context`                         | **(c)** for Precision          | Tracking-specific semantics (daily entries, earned MH, notes-per-day). Only the _primitives_ inside them travel (§4).                                                                                                                                                                                                                                                                       |
| `progress-tracking/wbs-card`                                                                                                                              | **(c)** dead                   | Zero importers in either app; the only consumer of `StatusBadge`. Delete.                                                                                                                                                                                                                                                                                                                   |
| `settings/*` (7 files, ~950 LOC)                                                                                                                          | **(c)** dead                   | Zero importers, no package export path, duplicate theme logic. Delete or finish it — but do not count it as "shared UI".                                                                                                                                                                                                                                                                    |

### 3.3 `apps/momentum/src/components` — promotion candidates

| Component                                       | LOC       | Class                                             | Promotion cost & what Precision gains                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | --------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add-activity-dialog.tsx`                       | 1001      | **(b) promote — highest value**                   | ~1 day (see §2.2). Precision deletes 621 LOC; gains cmdk catalog, validation, live preview, ⌘↵, toasts. **This is the one Collin named.**                                                                                                                                                                                                                                                                                                                                           |
| `add-phase-dialog.tsx`                          | 368       | **(b) promote**                                   | ~0.5 day. Momentum's version has catalog/custom modes, cmdk picker, ⌘↵, smart code suggestion, toasts; Precision's (221 LOC) is catalog-only, no custom phase, `console.error` on failure. Parameterize the "change-order" branch out (it is Momentum-only) → shared `AddPhaseDialog` with `modes: ("catalog"\|"custom")[]` + `extraFields?: ReactNode`.                                                                                                                            |
| `edit-activity-dialog.tsx`                      | 193       | **(b) promote**                                   | ~0.25 day. Precision has **no** edit-activity dialog — it edits inline in the grid only, so there is no way to fix craft/weld constants on a `custom_labor` row. Shares the same `DecimalInput`/preview-strip idiom.                                                                                                                                                                                                                                                                |
| `edit-phase-dialog.tsx`                         | 121       | **(b) promote**                                   | ~0.25 day. Precision has no phase rename at all.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `create-project-dialog.tsx`                     | 511       | **(b) promote the _pattern_, not the file**       | The valuable generic parts: the **`ImportProgressPanel` + `ImportStepper` + `progressPct/progressDetail`** staged-progress panel (l.98-221), the non-dismissible-while-busy dialog guard (l.289-295, 355-356), and the borderless selectable-row list. Precision's `duplicate-estimate-dialog` blocks with a plain spinner and its `create-estimate-dialog` swallows errors. Extract `<AsyncJobPanel>` + `<SelectableRowList>` → `packages/features/src/shared/`. **Cost: ~1 day.** |
| `assign-member-dialog.tsx`                      | 423       | **(b) promote when Precision gets scoped access** | Org-member picker + scope picker (project/WBS/phase) + role select. Precision has no per-estimate assignment model yet; the member-picker half is immediately reusable for "estimators on this proposal". Cost ~0.5 day for the picker only.                                                                                                                                                                                                                                        |
| `project-team-section.tsx`                      | 237       | **(b) promote with the above**                    | Table + empty state + remove-confirm. Generic once `projectId` → `scopeId`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `change-order-details-dialog.tsx`               | 175       | **(c)**                                           | Momentum-only domain (CO status gates earned MH).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `skeletons.tsx`                                 | 114       | **(b) promote the primitives**                    | Precision hand-rolls a bespoke skeleton in **four** routes (`estimates.tsx:324`, `$estimateId.index.tsx:596`, `$estimateId.phase.$phaseId.tsx:517`, `$estimateId.wbs.$wbsId.tsx`). A shared `<TableSkeleton rows cols>` + `<ListSkeleton>` kills all of it. Cost ~0.25 day.                                                                                                                                                                                                         |
| `update-checker.tsx` + `lib/update-context.tsx` | 200 + 294 | **(b) promote — cheap, high value**               | Precision **already depends on `@tauri-apps/plugin-updater` and `plugin-process`** (`apps/precision/package.json`) but has **no update UI at all** and passes `undefined` for `onCheckForUpdate` in both shell configs. The context is app-agnostic except the literal string "Momentum" in three copy strings. **Cost: ~2 hours** → `packages/features/src/updater/` with an `appName` prop.                                                                                       |
| `lib/permissions.ts` (`isWorkspaceAdmin`)       | 21        | **(b) promote**                                   | Precision inlines `workspace?.role === "owner" \|\| "admin"` in 4 places and gets the org-id field name wrong in a 5th (§6). Cost: 10 minutes.                                                                                                                                                                                                                                                                                                                                      |
| `lib/export-excel.ts`                           | 814       | **(c)**                                           | Two genuinely different workbooks (progress template vs estimate). Only the download-blob boilerplate is shared — not worth a package.                                                                                                                                                                                                                                                                                                                                              |
| `config/shell-config-*.ts`                      | 172 + 245 | **(c)** by design                                 | Per-app config is the intended extension point.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 3.4 `apps/precision/src/components` — verdicts

| Component                             | Verdict                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `add-activity-dialog.tsx` (621)       | **Delete** → replaced by the promoted Momentum dialog.                       |
| `add-phase-dialog.tsx` (221)          | **Delete** → replaced by the promoted Momentum dialog.                       |
| `estimate-switcher.tsx` (98)          | **Delete** → replaced by `ProjectSwitcher`. Also fixes a dead shortcut (§6). |
| `create-estimate-dialog.tsx` (186)    | Keep the field set; adopt the shared dialog chrome + toasts.                 |
| `duplicate-estimate-dialog.tsx` (148) | Keep; adopt `AsyncJobPanel` for the copy progress.                           |

---

## 4. The shared data-grid question

### 4.1 What each grid actually is

**Momentum — `packages/features/src/progress-tracking/workbook-table.tsx` (1635 LOC)**

- TanStack Table with `getCoreRowModel` + `getExpandedRowModel` + `getFilteredRowModel`;
  `getSubRows` over a tree built by `buildTree()` (l.252-462) → WBS → Phase → Detail.
- `buildTree` carries real business rules: numeric WBS ordering done **client-side on purpose**
  because Convex does not preserve record-key order over the wire (l.285-295, tagged `#36`);
  Change-Orders WBS always last and never hidden; `hideUnused` hides only the un-bid _estimate_
  tail, never user-added rows (`#34`).
- Two column sets: `entryColumns` (Item / Left / Entry) and `fullColumns` (9 columns), toggled by
  `columnMode`.
- Sticky **per-group** headers: each WBS gets its own `<tbody>` so WBS rows stick at `top-[32px]`
  and phase rows at `top-[72px]` (l.1513-1549).
- Volatile data (`existingEntries`, `saveStates`, notes, callbacks) is read through **refs** so
  column defs stay referentially stable under Convex's reactive pushes (l.536-547) — this is what
  keeps `React.memo` on `EntryCellInput` effective and focus intact while typing.
- Keyboard nav by DOM query: `container.querySelectorAll("input[data-entry-cell]")`, Tab/Enter
  forward, Shift+Tab back (l.602-626). ⌘S blurs to force a commit (l.1310-1321).
- Toolbar: search, 3 filter pills with live counts, column-mode toggle, hide-unused with hidden
  count, expand/collapse-all, shortcut hint.
- **No virtualization** (`@tanstack/react-virtual` is a devDependency of `@truss/features` but
  unused). Bounded by `max-h-[calc(100vh-280px)]` + browser scroll.

**Precision — `apps/precision/src/routes/estimate/$estimateId.phase.$phaseId.tsx` (541 LOC)**

- TanStack Table, **flat** (`getCoreRowModel` only), 12 columns, `rowSelection` + `getRowId`, batch
  delete of selected rows.
- Columns: select checkbox, type icon+abbr, description (editable text), qty (editable), unit
  (read-only text), craftMH, weldMH, craftCost, matCost, equipCost, subCost (all read-only
  `EditableCell`s), total.
- Zebra striping, 30px rows, sticky `<thead>`.
- Keyboard nav by DOM query: `gridRef.current.querySelectorAll("input[data-cell-id]")` (l.136-145) —
  **the same idiom as Momentum, independently re-implemented**.

### 4.2 Are the requirements genuinely different? Yes — at the table level.

|                 | Momentum workbook                                    | Precision activity grid                         |
| --------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Shape           | 3-level tree, expand/collapse, sticky group rows     | Flat list per phase                             |
| Editable        | 1 column (+ note popover)                            | up to 4 (description, qty, unit, type-specific) |
| Selection       | none                                                 | multi-select + bulk delete                      |
| Row identity    | activity **or virtual split** (`isSplit`, `splitId`) | activity                                        |
| Filtering       | search + 3 semantic modes + hide-unused              | none                                            |
| Ordering        | business-rule sort (WBS code, CO last)               | server `sortOrder`, no reorder UI               |
| Read-only cells | most                                                 | most (computed costs)                           |
| Scale           | whole project (thousands of rows)                    | one phase (tens)                                |

Forcing one `<DataGrid>` over both would mean a component with `mode: "tree" | "flat"`, optional
selection, optional filters, two column-def dialects and two cell dialects — the classic
over-abstraction that ends up harder to change than two files. **Don't.**

### 4.3 What _should_ be shared (three primitives)

1. **`useGridKeyboardNav({ containerRef, cellAttr })`** — one hook replacing
   `workbook-table.tsx:602-626` and `$estimateId.phase.$phaseId.tsx:136-145`. Add the 2-D behaviour
   both grids are missing (↑/↓ between rows in the same column; Momentum only moves linearly today).
2. **One editable-cell primitive.** `EntryCellInput` (176) and `EditableCell` (177) implement the
   _same_ state machine: `localValue: string | undefined` = editing sentinel, debounced auto-commit
   (350 ms in both — `DEBOUNCE_MS` is literally the same constant in both files), commit-on-blur
   with the pending timer cancelled, Escape sets an `escapeRef` then blurs to discard. Their deltas
   are **additive props**, not conflicts:
   - `EntryCellInput` adds: `saveState` indicator (saving/saved/error), `NotePopover`, `maxAllowed`
     clamp with destructive ring on overflow, `data-entry-cell`.
   - `EditableCell` adds: `readOnly` render path, `displayFormat: "plain" | "currency"`,
     `type: "text" | "number"`, `data-cell-id`. A merged `<GridCellInput>` with
     `variant`/`adornments` covers both. **Cost: ~0.5 day**, and it removes the single riskiest kind
     of duplication in the codebase (two hand-rolled focus/commit state machines drifting apart).
3. **`buildHierarchyRows()` + `<StickyGroupTableBody>`** — the WBS→Phase→Detail tree builder and the
   per-`<tbody>` sticky-group renderer. **Precision will need exactly this** the moment it wants a
   whole-estimate grid instead of the current one-phase-at-a-time drill-down (which is the legacy
   estimator's navigation model and, per Collin, part of what makes it painful). Extract when that
   story starts, not before — but keep the tree builder's Convex-key-order lesson
   (`workbook-table.tsx:285-295`) documented, because Precision's rollups will hit the identical
   trap.

**Verdict:** one grid abstraction — no. Three shared primitives — yes, and #2 should be done before
Precision's grid grows any further.

---

## 5. Shell & navigation: what Precision already has vs what Momentum does better

**Precision already uses, unchanged:** `AppShell`, `ThreeColumnLayout`, `AppSidebar` (including
`TreeNavItem`, which Momentum doesn't use), `CommandPalette`, `StatusBar`, `AppBar`,
`ThemeSwitcher`, `WorkspaceSwitcher`, `UserMenu`,
`ShellProvider`/`ThemeProvider`/`DensityProvider`/`KeyboardProvider`, `useLayoutStore`,
`AuthScreen`, `WorkspaceProvider`, the `RouterLink` adapter, and the
`getXShellConfig(navigate, onCheckForUpdate, options)` config factory convention. **The shell is not
the problem.**

**Patterns Momentum has that Precision should adopt:**

| Pattern                              | Momentum                                                                                                                              | Precision                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context switcher wired to a shortcut | `ProjectSwitcher` listens for `open-project-switcher` (`project-switcher.tsx:69-73`) → ⌘⇧P and the palette command both work          | `EstimateSwitcher` has **no listener** → ⌘⇧O and the "Switch Estimate" command are **dead** (§6)                                                          |
| Route-aware context                  | `__root.tsx:112-134` derives `projectId` from the path, syncs `ProjectProvider`, and calls `recordProjectView` to power a Recent list | Derives `estimateId` but has no provider and no recency tracking                                                                                          |
| Admin-gated nav                      | `isWorkspaceAdmin(workspace)` gates Reports/Settings items, commands **and** shortcuts (`shell-config-project.ts:48-73, 184-210`)     | Only gates one command; the admin route itself is broken (§6)                                                                                             |
| Native context menus                 | Tauri `Menu`/`MenuItem`+`popup()` for row/phase/WBS actions, with a documented WHY (`$projectId.index.tsx:713-938`)                   | No context menus at all; all actions live in a header dropdown                                                                                            |
| Error surfacing                      | `toast.success`/`toast.error` on every mutation                                                                                       | `console.error` in `add-activity-dialog`, `add-phase-dialog`, `create-estimate-dialog`, export handler                                                    |
| Landing surface                      | `projects.tsx`: recents tab, pinning, tile/list toggle, 4 sort modes, all persisted to localStorage, real empty states                | `estimates.tsx`: no pins, no recents, no sort control, no persistence; rows are `<div onClick>` — **not focusable, not keyboard-activatable, no ⌘-click** |
| Scroll ownership                     | `projects.tsx:255` comment (`#46`): the shell detail panel is fixed-height and clips, so pages must own their scroll                  | Handled per-route ad hoc                                                                                                                                  |
| Data-loss guard                      | `beforeunload` blurs the active input to force a commit (`$projectId.index.tsx:359-368`)                                              | None (debounced edits can be lost on quit)                                                                                                                |

**Patterns Precision has that Momentum could take:** the sidebar WBS→Phase tree (`TreeNavItem`) is
genuinely nicer than Momentum's 3 flat links for deep hierarchies, and `BottomPanel`'s persisted
collapse state (`localStorage["precision:bp"]`) is the same idea Momentum later re-implemented in
`ProjectStatusSlices` (`localStorage["momentum:workbook:statusCollapsed"]`) — two implementations of
"persisted collapsible summary bar" that could be one.

---

## 6. Dead or broken (verified against source)

**Broken**

1. **`apps/precision/src/routes/admin/index.tsx:46`** — `const orgId = workspace?.organizationId;`
   The field is `organization_id` (`packages/features/src/organizations/types.ts:55`). `orgId` is
   always `undefined` → `useQuery(..., "skip")` → `members === undefined` forever → **the admin
   members page renders a loading skeleton permanently**. Confirmed by `tsc`:
   `error TS2551: Property 'organizationId' does not exist on type 'WorkspaceContext'. Did you mean 'organization_id'?`
2. **Precision does not type-check — 27 app-level errors** (`admin/index.tsx` 13,
   `admin/member.$memberId.tsx` 5, `$estimateId.phase.$phaseId.tsx` 6, `$estimateId.index.tsx` 2,
   `$estimateId.wbs.$wbsId.tsx` 1). The admin pages read `m.banned` / `m.role` /
   `m.precisionPermission` but the query returns `isBanned` / `orgRole` / `appPermissions` — **the
   whole admin surface is written against a stale server shape**. Momentum has 2 app-level errors
   (`assign-member-dialog.tsx` 102 and 371). Both apps additionally inherit ~40 errors from
   `packages/backend`.
3. **`EditableCell` misused** — `$estimateId.phase.$phaseId.tsx` passes `readOnly` without
   `onCommit` on 6 columns; `onCommit` is a required prop of `NumberCellProps`
   (`editable-cell.tsx:24-28`). Runtime-safe (read-only path returns early) but the API lies.
4. **Precision "Add ▾" dropdown discards the chosen type** —
   `$estimateId.phase.$phaseId.tsx:408-415`, all six items call `setAddOpen(true)`; the dialog
   always opens on Labor.
5. **`$estimateId.index.tsx:90,104`** — `useRef<ReturnType<typeof setTimeout>>()` with no argument
   (TS2554). The debounced field-patch and rate-patch refs.

**Dead code / dead wiring**

| Item                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-estimate-switcher` event                                                                                                                              | Dispatched by ⌘⇧O and the "Switch Estimate" palette command (`shell-config-estimate.ts:78,200`); **no listener anywhere**.                                                                                                                                              |
| `export-estimate` event                                                                                                                                     | Dispatched by ⌘⇧E / "Export Estimate" (`shell-config-estimate.ts:98`); **no listener** — export only works from the Overview button.                                                                                                                                    |
| `toggle-sidebar` event                                                                                                                                      | Dispatched by ⌘B in **both** apps (3 shell configs); **no listener**. ⌘B still works only because `packages/ui/src/components/sidebar.tsx:98-107` has its own independent handler — meaning `KeyboardProvider` also intercepts ⌘B and `preventDefault`s it for nothing. |
| `SidebarConfig.collapsedWidth` / `expandedWidth` / `defaultCollapsed`(partly) / `pinnedItems` / `footer.showSettings` / `showHelp` / `showConnectionStatus` | Present in every shell config; **zero consumers** outside `types.ts`. Widths are hardcoded in `sidebar.tsx:31-34` (`17rem` / `3rem`) — the configured 240/48 are ignored.                                                                                               |
| `LayoutConfig.allowModeSwitch`, `persistState`; `FeatureFlags.globalSearch`, `activityBar`, `multiWindow`                                                   | Same — configured, never read.                                                                                                                                                                                                                                          |
| `AppShellConfig.theme.accent: "zinc"`                                                                                                                       | Never read; `ThemeProvider` only handles light/dark/system.                                                                                                                                                                                                             |
| `LayoutMode` "split" and "focus"                                                                                                                            | `app-shell.tsx:132-143` — "split" falls through to three-column with a `TODO`; "focus" drops the sidebar entirely. Neither is reachable from either app.                                                                                                                |
| `ThreeColumnLayout` master pane                                                                                                                             | `showMasterList` never passed by either app.                                                                                                                                                                                                                            |
| `StatusBar` sync indicator                                                                                                                                  | `status-bar.tsx:31` — `useState({state:"idle"})` with no setter. It always says "Sync / idle" regardless of Convex state. Misleading, not just dead.                                                                                                                    |
| Density system                                                                                                                                              | `density.css` (185 lines) defines `--density-scale` etc.; **`var(--density-*)` has zero consumers**. `DensityProvider` + the density switch in `PreferencesSection` do nothing.                                                                                         |
| `packages/features/src/settings/**` (7 files, ~950 LOC)                                                                                                     | No importers, no package export path.                                                                                                                                                                                                                                   |
| `progress-tracking/wbs-card.tsx` + its `StatusBadge` usage                                                                                                  | No importers.                                                                                                                                                                                                                                                           |
| `@truss/ui` `menubar`, `context-menu`, `form` (623 LOC)                                                                                                     | No importers.                                                                                                                                                                                                                                                           |
| `packages/ui/src/components/index.ts`                                                                                                                       | No importers.                                                                                                                                                                                                                                                           |
| `@tanstack/react-virtual` in `packages/features` devDeps                                                                                                    | Never imported — the workbook is unvirtualized.                                                                                                                                                                                                                         |
| `precision.addWBS` mutation                                                                                                                                 | Exists in the backend; **no Precision UI calls it**. The WBS tab's empty state reads "No WBS categories initialized." with no action — an estimate with no WBS is a dead end.                                                                                           |
| `momentum.updateActivity` / `deletePhase` etc.                                                                                                              | Fine — listed only to contrast: Momentum's mutations all have UI.                                                                                                                                                                                                       |

---

## 7. Design-system inconsistencies between the apps

1. **There is no per-app brand theming at all.** `AppShell` sets `data-app="momentum" | "precision"`
   on `<html>` (`app-shell.tsx:60-68`) and both `styles.css` files document a per-app accent — but
   **no CSS anywhere selects on `[data-app]`** (only a comment in `sidebar.css:5`).
   `semantics.css:61` and `:219` set `--primary: var(--mac-blue)` unconditionally, so **both apps
   render the identical #0088FF blue**. `.context/BRANDING.md` (updated 2026-02-18) claims teal for
   both apps and a `packages/ui/src/styles/themes/{precision,momentum}.css` directory **that does
   not exist**. Either implement `[data-app]` overrides or delete the claim — right now the docs
   describe a brand system the code doesn't have.
2. **Two typographic vocabularies.** Momentum uses the macOS named scale throughout (`text-body`,
   `text-callout`, `text-subheadline`, `text-footnote`, `text-title3`). Precision uses raw Tailwind
   plus arbitrary values (`text-xs`, `text-sm`, `text-[10px]`, `text-[11px]`). They resolve to
   overlapping sizes (`text-xs` = 11px = `text-subheadline`), so the result is drift-by-accident
   rather than a deliberate scale. Precision should move to the named scale.
3. **Hardcoded palette colors in Precision.** `estimates.tsx:21-39`
   (`bg-amber-100`/`text-amber-800`, `bg-emerald-500`…) and `$estimateId.phase.$phaseId.tsx:52-58`
   (`text-blue-500`, `text-amber-500`…). These do not adapt to dark mode (a `bg-amber-100` chip on a
   dark surface is a light blob) and violate the "Don't hardcode hex/palette values" rule in
   `BRANDING.md`. Momentum consistently uses `mac-*`, `success-text`, `fill-*`, `destructive`. (One
   partial exception in Momentum: the Monday-style `GROUP_COLORS` hex array, duplicated in
   `workbook-table.tsx:39-50` **and** `$projectId.reports.tsx:33-44` — deliberate categorical
   colors, but they should be one exported constant.)
4. **Two dialog "shapes."** Momentum's newer dialogs are `p-0 gap-0` with padded sections, an
   optional result strip, and a bordered footer on `bg-muted/30` (add-activity, edit-activity,
   edit-phase, create-project, assign-member). Precision's use default `DialogContent` padding +
   plain `DialogFooter`. Pick one and encode it as a `<FormDialog>` shell in `@truss/ui`.
5. **Control-height drift.** Momentum: `h-8`/`h-9` controls, some `h-6` inputs (create-project
   search, assign-member selects). Precision: `h-7`/`h-8`, 30px grid rows. `design-principles.md`
   asks for ≥32px hit targets (≥28px dense) — several `h-6` (24px) controls in both apps miss that.
6. **The two app stylesheets are duplicates.** `apps/momentum/src/styles.css` and
   `apps/precision/src/styles.css` differ **only in comments** (verified with a normalized diff) —
   ~250 lines of `@theme` mapping copy-pasted. This belongs in `@truss/ui/styles`.
7. **Skeletons:** Momentum has content-aware shared skeletons (`components/skeletons.tsx`);
   Precision re-invents one per route.
8. **Empty states:** Momentum's are three-part (icon, headline, guidance) and often carry an action;
   Precision's are one muted line ("No proposals yet.", "No WBS categories initialized.").

---

## 8. Standards Precision must meet

`.context/design-principles.md` exists (210 lines). **`.context/style-guide.md` does NOT exist**,
despite `CLAUDE.md` instructing agents to consult `/context/style-guide.md` — the closest real
artifact is `.context/BRANDING.md` (which is partly stale, §7.1). Worth fixing, since every agent
working this repo is told to read a file that isn't there.

The checklist items Precision most visibly fails today:

| Principle (`design-principles.md`)                                                                              | Precision status                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §I "Keyboard First" — global + contextual shortcuts, full keyboard traversal                                    | Catalog lists are mouse-only; estimate rows are `<div onClick>`; two registered shortcuts are dead                                                                                                   |
| §I "Immediate Feedback"                                                                                         | Mutations fail silently to `console.error`                                                                                                                                                           |
| §VI "Command Palette / Shortcut System"                                                                         | Palette works, but "Switch Estimate" and "Export Estimate" do nothing                                                                                                                                |
| §VI "Selection Models: multi-select + bulk-action toolbar"                                                      | ✅ the phase grid does this well (checkbox column + "Delete N") — Momentum has no equivalent                                                                                                         |
| §VII "Loading: skeletons for views"                                                                             | ✅ present, but duplicated per route                                                                                                                                                                 |
| §VII "Saving: optimistic UI, toasts with undo"                                                                  | No toasts, no undo anywhere in Precision                                                                                                                                                             |
| §XI.A Data tables — "sticky header, right-align numerics, filters above table, global search, CSV/Excel export" | Sticky ✅, numerics ✅, export ✅; **no filters/search on the activity grid**                                                                                                                        |
| §XI.B Config panels — "grouping, inline validation, live preview, apply vs save clarity"                        | Rates tab is grouped ✅; no validation; no live preview of what a rate change does to the total (the `BottomPanel` does update, which is close)                                                      |
| §XIII "Hit targets ≥40×40 (dense ≥32)"                                                                          | 24px (`h-6`) and 28px (`h-7`) controls are common in both apps                                                                                                                                       |
| §XIII "Undo > Confirmations"                                                                                    | Precision's `handleDeleteSelected` (`$estimateId.wbs.$wbsId.tsx:89`) deletes phases in a loop **with no confirmation and no undo** — Momentum gates every destructive action behind an `AlertDialog` |
| §II "Persist & Reset layout"                                                                                    | Panel sizes persist ✅ (shared store); no Reset Layout action in either app                                                                                                                          |

Momentum meets most of these. That is the second argument for promotion: adopting Momentum's
components _is_ the compliance work.

---

## 9. Recommended sequence

**Phase 0 — unblock (0.5 day).** Fix `workspace?.organizationId` → `organization_id` and the stale
member-shape fields; get `apps/precision` to zero app-level TS errors. Wire or delete the three dead
custom events. Without this, any shared component you add lands on a page that doesn't render.

**Phase 1 — the dialogs Collin named (2–3 days).** Create `packages/features/src/activities/`:
promote `add-activity-dialog` (props per §2.2), `add-phase-dialog`, `edit-activity-dialog`,
`edit-phase-dialog`, plus the shared field primitives (`NumberInput`, `PoolBrowser`,
`SelectedItemCard`, `SubModeToggle`, `Disclosure`, `PriceField`, `ConstantField`). Delete
Precision's two drafts. Add `initialType` so the phase-grid "Add ▾" menu works. Precision nets
**−842 LOC** and gains keyboard-first entry, validation, toasts and a live cost preview.

**Phase 2 — grid primitives (1 day).** Merge `EntryCellInput` + `EditableCell` into one
`GridCellInput`; extract `useGridKeyboardNav`. Two hand-rolled focus/commit state machines become
one.

**Phase 3 — shared chrome (1–2 days).** `<FormDialog>` shell, `<AsyncJobPanel>` (from
create-project), shared skeleton primitives, `isWorkspaceAdmin`, and the updater (`UpdateProvider` +
`UpdateChecker` with an `appName` prop — Precision already ships the plugin).

**Phase 4 — list surfaces (1–2 days).** Generalize `ProjectCard`/`ProjectListRow`/`ProjectSwitcher`
so Precision's estimate home gets pins, recents, tile/list, persisted sort, real links and keyboard
access. **This is the screen Collin says he hates in the legacy estimator — do not port the legacy
layout, port Momentum's.**

**Phase 5 — housekeeping.** Delete `settings/**`, `wbs-card`, `menubar`/`context-menu`/`form`, the
UI barrel, the dead `SidebarConfig`/`FeatureFlags` keys and the unreachable layout modes; either
implement `[data-app]` brand tokens + the density variables or delete both and update `BRANDING.md`;
hoist the duplicated `styles.css` into `@truss/ui`; make the StatusBar sync indicator real or remove
it.
