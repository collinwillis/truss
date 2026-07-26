# Legacy MCP Estimator — Cross-Cutting Audit

**Area:** shell / navigation, auth, admin, export & reporting, theme, Tauri integration, Cloud
Functions, misc infrastructure

**Repo audited:** `/Users/collinwillis/Dev/Personal/mcp_estimator` **Version at audit:**
`package.json` `1.4.3` / `src-tauri/tauri.conf.json` `package.version = 1.4.3` **Method:** direct
source reading. Every claim below is traced to a file + line. Docs (`CLAUDE.md`,
`MCP_ESTIMATOR_*.md`) were NOT trusted; where they disagree with code I say so.

---

## 1. Purpose of the area and how a user actually flows through it

### 1.1 What this area is

This is everything that is _not_ a data grid: the desktop shell (app bar + persistent left drawer),
the router, sign-in/sign-up/verify-email, the admin console, the single Excel export ("Data Dump"),
the MUI theme, the Tauri packaging/auto-update pipeline, and the one Firebase Cloud Function.

### 1.2 Actual user flow (traced from code)

1. **Launch.** Tauri opens a single window (`src-tauri/src/main.rs`): forced to 1200×800 logical px
   at startup, title set to `MCP Estimator`, resizable. There are **no native menus, no tray icon,
   no global shortcuts, no deep links** — `main.rs` registers exactly one command (`greet`, never
   called from JS) and nothing else.
2. **Web app boots** (`src/main.tsx`) wrapped in `React.StrictMode` **and**
   `@react-buddy/ide-toolbox`'s `<DevSupport>` — a JetBrains IDE preview harness that ships in the
   production bundle.
3. **`App.tsx`** installs a **locally forged MUI X Pro license key** (see §7.1), subscribes to
   `onAuthStateChanged`, and mounts a **`MemoryRouter`** (`Router` is aliased from `MemoryRouter`).
   Consequence: no URL bar, no browser history persistence, no deep-linking, and a reload always
   returns the user to `/`.
4. **`AuthRoute`** (`src/components/auth_route.tsx`) wraps every authenticated route. It renders the
   literal text `loading ....` until Firebase resolves the auth state, then:
   - no user → `navigate('/login')`
   - user but `!user.emailVerified` → `navigate('/verify-email')`
   - else render children.
5. **Login** (`/login`, `features/auth/presentation/auth_screen.tsx`) — a single screen that toggles
   between `LoginForm` and `RegisterForm` via local `formValue` state (1 = login, 2 = register). No
   route change between them.
6. On successful login the app navigates to `/` → `EstimatorDrawer` + `ProposalSelectScreen` (an
   overview dashboard listing the 50 most recent proposals).
7. **Drawer is the primary navigation.** Two completely different drawer modes depending on whether
   `useParams().proposalId` is present (see §2.2).
8. Selecting a proposal → `/proposal/:proposalId` → `ProposalHomeScreen` which, in a `useEffect`,
   calls `estimatorStore.loadFullProposalData(proposalId)` — a **full download of every WBS, phase
   and activity for the proposal into a Zustand store**. This is the _only_ place the store gets
   populated on navigation. WBS Home and Phase Home render **exclusively** from that store and have
   no loader of their own (`features/wbs home/wbs_home.tsx`, `features/phase home/phase_home.tsx`).
   So the proposal home screen is a mandatory gate.
9. Drawer WBS dropdown → `/proposal/:id/wbs/:wbsId`; drawer phase list → `.../phase/:phaseId`.
10. Export lives on the **WBS Data Grid tab of Proposal Home only** (`wbs_data_grid.tsx:70` mounts
    `<ExportMenu>`).
11. Admin console is reachable only from the app-bar hamburger menu, and only when
    `userProfile.role === 'admin'`.
12. Logout = `auth.signOut()` from the same hamburger menu; `AuthRoute` then bounces to `/login`.

### 1.3 Routes (exact, from `src/App.tsx`)

| Path                                              | Element                                                 | Guarded     | Shell                                |
| ------------------------------------------------- | ------------------------------------------------------- | ----------- | ------------------------------------ |
| `/login`                                          | `AuthScreen`                                            | no          | none                                 |
| `/verify-email`                                   | `EmailVerificationScreen` (receives `currentUser` prop) | no          | none                                 |
| `/`                                               | `ProposalSelectScreen`                                  | `AuthRoute` | `EstimatorDrawer`                    |
| `/proposal/:proposalId`                           | `ProposalHomeScreen`                                    | `AuthRoute` | `EstimatorDrawer`                    |
| `/proposal/:proposalId/wbs/:wbsId`                | `WbsHomeScreen`                                         | `AuthRoute` | `EstimatorDrawer`                    |
| `/proposal/:proposalId/wbs/:wbsId/phase/:phaseId` | `PhaseHomeScreen`                                       | `AuthRoute` | `EstimatorDrawer`                    |
| `/admin`                                          | `AdminDashboard`                                        | `AuthRoute` | **no drawer** (full-screen takeover) |

No 404/catch-all route. No nested layout routes — the drawer is re-mounted per route element.

---

## 2. Complete feature enumeration

### 2.1 App bar (`src/components/drawer.tsx`, lines 175–260)

Fixed `MuiAppBar`, background `#1f2937`, 1px bottom border `#374151`, forced `minHeight: 48px`.
Shifts right by `drawerWidth = 280` when the drawer is open.

| Control                                                  | Condition                      | Behavior                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drawer-open icon button (custom `DrawerIcon` SVG, white) | hidden when `open`             | `setOpen(true)`                                                                                                                                             |
| Breadcrumbs                                              | —                              | Up to 3 crumbs, `flexWrap: nowrap`                                                                                                                          |
| — Crumb 1: `{proposalNumber} - {proposalDescription}`    | `currentProposal` truthy       | navigates to `/proposal/{id}`; `maxWidth: 300`, ellipsised                                                                                                  |
| — Crumb 2: `{wbs.name}`                                  | `currentWbs` truthy            | navigates to `/proposal/{id}/wbs/{wbsId}`                                                                                                                   |
| — Crumb 3: `{phaseNumber} - {description}`               | `currentPhase` truthy          | **plain `Typography`, not clickable** (it is the leaf)                                                                                                      |
| `DownloadForOffline` icon button                         | only when `proposalId` present | calls `loadFullProposalData(proposalId)` — i.e. it is a **hard refresh of the store**, _not_ a download. Misleading icon, no label, no tooltip, no spinner. |
| `MenuRounded` icon button                                | always                         | opens the main menu                                                                                                                                         |
| Main menu → "Admin Console" (`AdminPanelSettings` icon)  | `isAdmin`                      | `navigate('/admin')`                                                                                                                                        |
| Main menu → "Logout" (`ExitToApp`, red `#dc2626`)        | always                         | `auth.signOut()`                                                                                                                                            |

The app bar has **no search, no command palette, no keyboard shortcuts, no window controls, no
save/dirty indicator, and no "unsaved changes" state at all**.

### 2.2 Drawer (`src/components/drawer.tsx`, lines 263–416)

`variant='persistent'`, `anchor='left'`, width 280, white paper, `zIndex: 999`. Initial open state:
`useState(proposalId === undefined)` — open on the home screen, **closed the moment you open a
proposal**, and it does not remember the user's preference (no localStorage). It also re-initialises
on every route element remount.

**Drawer header (48px, bottom border):**

- _Home mode_ (`proposalId == null`):
  - Title `MCP Estimator`.
  - `MenuRounded` icon button — **only rendered if `hasWritePermissions`** — opens `ProposalMenu`
    with two items:
    - **Add** (`AddRounded`) → opens `AddProposalDialog`
    - **Edit** (`EditRounded`) → opens `EditProposalsDialog`
  - There is **no collapse button in home mode** — once open on `/` the drawer cannot be closed.
- _Proposal mode_ (`proposalId != null`):
  - `ArrowBack` icon → `navigate('/')`
  - `proposalDescription` as a clickable title → `/proposal/{id}`
  - `ChevronLeftRounded` icon → `setOpen(false)`

**Drawer body — home mode:**

- Search `TextField` (`Search proposals...`, `SearchRounded` adornment, height 32, background
  `#f3f4f6`).
- `<ProposalList>` fed by `filteredProposals`.

**Client-side proposal search filter** (`drawer.tsx:134–162`) — concatenates _22 fields_ lower-cased
and space-joined, then `String.includes(searchKey)`:
`proposalNumber, job, coNumber, proposalDescription, proposalOwner, projectCity, projectState, jobSiteAddress, proposalEstimators, proposalDateReceived, proposalDateDue, projectStartDate, projectEndDate, bidType, proposalStatus, contactName, contactAddress, contactCity, contactState, contactZip, contactPhone, contactEmail`.
Because fields are joined with spaces, a query can accidentally match **across** field boundaries.
Search is substring only — no fuzzy, no tokenisation, no ranking.

**Drawer body — proposal mode:**

- Section label `NAVIGATE` (uppercase, 0.75rem, `#9ca3af`).
- `NavItem "Proposal Home"` — `disabled={wbsId == null}` (i.e. greyed out when you are already at
  proposal level).
- `NavItem "WBS Home"` — `disabled={phaseId == null}`.
- `<WbsDropdown>` — MUI `Select` listing `visibleWbs[proposalId]` sorted by `wbsDatabaseId`,
  rendering `"{wbsDatabaseId} {name}"`, placeholder `Select WBS`. Selecting navigates.
- Section label `PHASES` + `<PhaseList>` (only when `wbsId != null`).

**`PhaseList`** (`src/components/phase_list.tsx`): own search box (`Search phases...`) filtering on
`phaseNumber.includes(raw input)` OR `description.toLowerCase().includes(lowered input)` — note the
phase-number match is **not** lower-cased/normalised. Items show `phaseNumber` (bold when active)
over `description`. Active row: 2px left border `#111827` + `#f3f4f6` background. Empty state
`No phases found.`

**`ProposalList`** (`features/home/components/proposal_list.tsx`): sorts by numeric `proposalNumber`
descending (nulls last), highlights the row matching `sessionStorage['selectedProposalId']`, and on
mount scrolls that row into view (`scrollIntoView({behavior:'smooth', block:'center'})`). Clicking
sets `sessionStorage['selectedProposalId']` then navigates. `sessionStorage['selectedProposalId']`
is cleared by the drawer's unmount cleanup (`drawer.tsx:130-132`).

**Dialogs always mounted by the drawer** (regardless of state): `AddProposalDialog`,
`AddPhaseDialog` (only when `wbsId != undefined`), `EditProposalsDialog`. Note `AddPhaseDialog`'s
open state (`addPhaseDialogOpen`) is **never set to true anywhere in drawer.tsx** — dead wiring
(§6).

### 2.3 Bottom panel (`src/components/bottom_pannel.tsx`) — shell chrome on all 3 proposal screens

Mounted by `proposal_home.tsx`, `wbs_home.tsx`, `phase_home.tsx`. It is a persistent status bar plus
a quick-add bar.

**Quick-add bar** (only when `hasWritePermissions` and there is something to add):

- At **phase** level: `Activity` (primary, opens `AddActivityDialog`), `Equipment` (opens
  `AddEquipmentDialog`), `Material`, `Cost Only`, `Custom Labor`, `Subcontractor`. The last four
  immediately create a Firestore row with a placeholder description (`NEW MATERIAL ITEM`,
  `NEW COST ONLY ITEM`, `NEW CUSTOM LABOR ITEM`, `NEW SUBCONTRACTOR` with `unit: 'HOURS'`) — no
  dialog, no undo.
- At **WBS** level: `Phase` (opens `AddPhaseDialog`).
- At **proposal** level: nothing.

**Status bar metrics** (always visible, horizontally scrollable): `Total Cost` ($), `Total Hrs`,
`Direct`, `Indirect`, `Sub Hrs`.

**Scope rule:** the dataset is `activities of this phase` at phase level, `phases of this WBS` at
WBS level, and **only the _visible_ WBS items** at proposal level.

**Indirect classification rule** (`INDIRECT_WBS_IDS`): `10000 = Mobe`, `190000 = Demobe`,
`200000 = Support`, `180000 = Specialty`. Hours in those WBS buckets count as _indirect_; everything
else is direct craft/welder hours. `subcontractorHours = quantity × time` summed over
`ActivityType.subContractorItem` rows only.

**"Hidden WBS data" warning chip** — at proposal level only, if any WBS _not_ in `visibleWbs` has
`totalCost > 0 || craftManHours > 0 || welderManHours > 0`, an amber pill appears: `Hidden WBS data`
with tooltip _"Some hidden WBS items contain data not reflected in these totals. Use WBS Select to
review."_ This is a genuinely good idea worth keeping.

**Details expander** — state persisted in `localStorage['bottomPanelDetailsOpen']`. Reveals three
mini-tables:

- _Hours_: Craft, Welder, Support, Mobe / Demobe (summed), Specialty, Subcontractor + Total footer.
- _Labor Costs_: Craft, Weld & Rig, Subcontractor.
- _Other Costs_: Equipment, Material, Cost Only.

All numbers formatted with `toLocaleString` at exactly 2 decimals.

### 2.4 Auth screens

**`auth_screen.tsx`** — full-viewport `#f9fafb`, absolute top-left wordmark `MCP ESTIMATOR`, a
`Header` (h1, 40px bold `#333333`, text = `Welcome Back!` / `Welcome!`), and `AuthCard` (`#FBFBFB`,
`width: 40vw`, `max 450 / min 300`, radius 10).

**`LoginForm`** (`components/login_form.tsx`) fields & controls: | Control | Detail | |---|---| |
`email` TextField | `type='email'`, placeholder `email`, width 80%, bg `#f0f4f4`. No label. | |
`password` TextField | `type='password'`, placeholder `password`. No show/hide toggle. | | `Login`
button | contained primary, 80% width, height 60 | | `Forgot password?` link | calls
`sendPasswordResetEmail(auth, userName)`; if the email box is empty shows
`Please enter your email address first.` | | `OR` divider text | — | | `Register` button | contained
secondary, 50% width — switches the form, does not navigate | | Error `Alert severity='error'` |
text from `getFirebaseAuthErrorMessage` | | Success `Alert severity='success'` |
`Password reset email sent! Check your inbox.` |

**Login post-auth check (important business rule):** after `signInWithEmailAndPassword` succeeds,
the form queries `users where email == userName` and:

- `userData.disabled === true` → error `This account has been disabled.`
- `userData.deleted === true` → error `This account does not exist.`
- no matching doc → error `User data not found.`
- else `navigate('/')`. **The Firebase session is NOT signed out in any of those failure branches**
  — the user stays authenticated and could reach the app by any other route (§5).

**`RegisterForm`** (`components/register_form.tsx`) fields: `Full Name` (plain text, has class
`normal-case` to opt out of the global uppercasing), `email` (`type='email'`), `password`
(`type='password'`). Buttons: `Register`, `OR`, `Sign In`.

**Email-domain allow-list (hard-coded, business rule):**

```
indemandis.com | tidybrackets.com | outlook.com
```

Any other domain → error text `Only @indemandis.com email addresses are allowed to register.` (the
message lies — two other domains are silently allowed). On success it writes `users/{uid}`:

```ts
{ uid, name: fullName, email, permission: 'read', role: 'user', disabled: false, deleted: false }
```

then `navigate('/')`. **It never calls `sendEmailVerification`,** so a brand-new user lands on `/`,
is bounced by `AuthRoute` to `/verify-email`, and must press "Resend Verification Email" to receive
the first one.

**`EmailVerificationScreen`** (`verify_email.tsx`): `EmailOutlinedIcon` (48px), heading
`Verify Your Email`, copy _"A verification link has been sent to your email address. Please check
your inbox and click the link to proceed."_, `Resend Verification Email` button (calls
`sendEmailVerification(user)` and shows a success `Alert` `Verification email sent!`), and a
`Logout` link (`signOut` then `/login`). **There is no "I've verified, continue" button and no
polling** — the user must quit and relaunch the app, because Firebase's cached `user.emailVerified`
only refreshes on token refresh.

**`getFirebaseAuthErrorMessage`** (`src/config/error_handler.ts`) maps exactly 7 codes: | code |
message | |---|---| | `auth/email-already-in-use`, `auth/account-exists-with-different-credential` |
`Email already used. Go to login page.` | | `auth/wrong-password` |
`Wrong email/password combination.` | | `auth/user-not-found` | `No user found with this email.` | |
`auth/user-disabled` | `User disabled.` | | `auth/too-many-requests` |
`Too many requests to log into this account.` | | `auth/operation-not-allowed` |
`Server error, please try again later.` | | `auth/invalid-email` | `Email address is invalid.` | |
_default_ | `An unexpected error occurred. Please try again.` |

Note: modern Firebase returns `auth/invalid-credential` for bad passwords, which falls through to
the generic default — so the most common failure gets the least useful message.

### 2.5 Admin console (`src/features/admin/admin_dashboard.tsx`)

Full-screen, **not** wrapped in the drawer. Dark 48px header (`#1f2937`) with an `ArrowBack`
`IconButton` calling `navigate(-1)` and the title `Admin Console`. Body max-width 1200, centered.

- Section label `USER MANAGEMENT`.
- Search `TextField` (`Search users...`, max width 360) — filters on `user.name` only
  (case-insensitive `includes`). **Cannot search by email.**
- Table columns: **Name | Email | Permission | Role | Actions**.
- `Permission` cell = MUI `Select` with `Read` (`read`) / `Read & Write` (`readWrite`).
- `Role` cell = MUI `Select` with `User` (`user`) / `Admin` (`admin`).
- Actions:
  - `Disable` / `Enable` toggle button (amber styling when disabled) — tooltip _"Disable this user"_
    / _"Re-enable this user"_. Sets `{ disabled: !user.disabled }`.
  - `Delete` button (red) — tooltip _"Permanently delete this user"_. Actually performs a **soft
    delete**: `updateDoc(users/{uid}, { deleted: true })`. **No confirmation dialog.**
- Data load: one-shot `getDocs(collection('users'))` in a `useEffect`, filtered client-side to
  `!user.deleted`. No pagination, no real-time listener, no sort, no refresh button.
- Every `Select`/button change writes to Firestore **immediately** with no optimistic-rollback and
  no error handling — `updateUser` has no `try/catch`.

**That is the entire admin surface.** There is no audit log, no invite flow, no per-proposal
permissions, no org/team concept, no rate-library administration, no dataset-version admin, and no
way to see who created or last edited a proposal.

### 2.6 Confirmation dialog (`src/components/alert_dialog.tsx`)

Exported as `DeleteConfirmationDialog`. Props: `title: ReactNode`, `content: string`, `open`,
`onClose`, `onConfirm`. Buttons are hard-coded **`Cancel`** and **`Delete`** (red `#dc2626`,
`autoFocus` on the destructive button). Used by `edit_proposals_dialog.tsx`, `phase_data_grid.tsx`,
`activity_data_grid.tsx`. Because the confirm label is hard-coded, it can only ever be used for
deletes.

### 2.7 Theme (`src/config/theme.ts`)

Two earlier theme definitions are left commented out at the top of the file (lines 1–48). The live
`estimatorTheme`:

- **Palette:** primary `#424242`/`#6d6d6d`/`#1b1b1b`; secondary `#bdbdbd`/`#efefef`/`#8d8d8d`; error
  `#d32f2f`; warning `#ffa000`; info `#1976d2`; success `#388e3c`; background `default #f9f9f9`,
  `paper #ffffff`; text `#333333` / `#555555`; divider `#e0e0e0`.
- **Typography:** `Roboto, Helvetica, Arial, sans-serif`; h1 3rem/700 … h6 1.25rem/500; `button`
  0.875rem, `textTransform: 'none'`.
- **Component overrides:** `MuiButton` (4px radius, 6/12 padding, contained/outlined
  primary+secondary variants), `MuiAppBar` (`#424242` — _overridden inline by the drawer's styled
  AppBar to `#1f2937`_), `MuiPaper`, `MuiCard` (8px radius), `MuiTypography`, `MuiTableHead`
  (`#f0f0f0`), `MuiTableCell`, `MuiDivider`, `MuiIconButton`, `MuiSelect`, `MuiCheckbox`,
  `MuiRadio`, `MuiSwitch`.
- **THE UPPERCASE RULE.** `MuiInputBase`, `MuiOutlinedInput`, `MuiFilledInput` and `MuiTextField`
  all apply `text-transform: uppercase` to any input **except**
  `password | email | url | number | tel | date | time | datetime-local`. There is no `search`
  exemption in the theme, so the drawer's proposal-search and the admin user-search render uppercase
  as you type. This is _visual only_; the persisted uppercase happens separately in `utils/store.ts`
  (`updatePhase` / `updateActivity` uppercase any `string` value whose field is not in
  `numberFields`). `numberFields` =
  `quantity, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate, equipmentCost, materialCost, costOnlyCost, price, time, subContractorCost`.
- There is **no dark mode**, no density setting, and no theme toggle anywhere.
- `src/config/colors.js` (11 colours) and `src/config/fonts.js` (`montserrat`) are **legacy and
  unreferenced**; the actual UI is a mix of the MUI theme and several hundred hard-coded Tailwind-
  palette hex literals inlined in `sx` props (`#111827`, `#6b7280`, `#e5e7eb`, `#f3f4f6`, …).

### 2.8 Keyboard model (`src/components/excel_navigation_data_grid.tsx`)

The only real keyboard support in the app, and it is confined to the two data grids
(`phase_data_grid.tsx`, `activity_data_grid.tsx` — both pass `enableExcelNavigation`).
`ExcelNavigationDataGrid` wraps `DataGridPro` and configures Excel-like editing:

| Key                 | View mode                                                                          | Edit mode                                                             |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Arrow keys          | MUI default cell navigation                                                        | —                                                                     |
| `Enter`             | **navigates** in `enterDirection` instead of entering edit (default `next-row`)    | commit + move to next cell/row (or stay, if `enterBehavior==='stay'`) |
| `Shift+Enter`       | navigate opposite direction                                                        | commit + navigate opposite                                            |
| `Tab` / `Shift+Tab` | navigate to next/prev **editable** cell (MUI itself only handles Tab in edit mode) | commit + navigate                                                     |
| `F2`                | toggle into edit mode                                                              | commit and exit                                                       |
| `Delete`            | clears the cell and immediately commits, staying in view mode                      | —                                                                     |
| `Backspace`         | clears the cell and enters edit mode (MUI `deleteValue`)                           | —                                                                     |
| printable char      | type-to-replace (MUI `initialValue`)                                               | —                                                                     |
| `Escape`            | —                                                                                  | discard modifications, restore focus to the cell                      |
| double-click        | enter edit with caret at click position                                            | —                                                                     |
| click away          | commit, do **not** steal focus back                                                | —                                                                     |

Props: `enterBehavior: 'next-row' | 'stay' | 'next-cell'` (default `next-row`),
`tabBehavior: 'next-cell' | 'next-row' | 'default'` (default `next-cell`), `skipNonEditableCells`
(default `true`), `wrapNavigation` (default `true`), `autoCommitOnNavigation` (default `true`),
`debugMode`. Non-navigable columns: `__check__`, `actions`,
`type === 'actions' | 'checkboxSelection'`, any field starting with `__`, and any column with
`editable === false`.

**Outside the grids there are zero shortcuts** — no ⌘K, no ⌘S, no ⌘N, no Esc-to-close on most
dialogs beyond MUI defaults, no focus management on dialog open.

### 2.9 Persisted UI preferences (scattered across three mechanisms)

| Key                                                 | Store            | Written by               | Purpose                                                        |
| --------------------------------------------------- | ---------------- | ------------------------ | -------------------------------------------------------------- |
| `selectedProposalId`                                | `sessionStorage` | `proposal_list.tsx`      | drawer highlight + scroll-into-view; cleared on drawer unmount |
| `activeTab`                                         | `sessionStorage` | `proposal_home.tsx`      | remembers Details/Rates/WBS tab index                          |
| `bottomPanelDetailsOpen`                            | `localStorage`   | `bottom_pannel.tsx`      | bottom-panel expander                                          |
| `phases_visibility`, `phases_sort`, `phases_filter` | `localStorage`   | `phase_data_grid.tsx`    | phase grid state                                               |
| `activities_sort`, `activities_filter`              | `localStorage`   | `activity_data_grid.tsx` | activity grid state                                            |
| `visibilityModels/{userId}_{phaseId}`               | **Firestore**    | `api/helpers.ts`         | per-user, **per-phase** activity column visibility             |

Note the inconsistency: activity _column visibility_ is per-user-per-phase in Firestore, while
activity _sort/filter_ is a single global key in localStorage, and phase _visibility_ is also
localStorage. Nothing is scoped per-proposal.

`api/helpers.ts` also defines the default column set and auto-reveals columns based on which
activity types exist in the phase:

```
defaults: rowId, description, quantity, unit, craftConstant, welderConstant,
          craftManHours, welderManHours, welderCost, craftCost, totalCost  = visible
          time, price, equipmentOwnership, craftBaseRate, subsistenceRate,
          equipmentCost, materialCost, costOnlyCost, subContractorCost      = hidden
if any equipmentItem  -> show time, price, equipmentOwnership, equipmentCost
if any materialItem   -> show price, materialCost
if any costOnlyItem   -> show price, costOnlyCost
if any subContractor  -> show time, equipmentCost, materialCost
(customLaborItem branch is commented out — dead)
```

---

## 3. Exact data fields and types

### 3.1 `UserProfile` — Firestore `users/{uid}` (`src/models/user.ts`)

```ts
enum UserRole {
  USER = "user",
  ADMIN = "admin",
}
enum UserPermission {
  READ = "read",
  READ_WRITE = "readWrite",
}

interface UserProfile {
  uid: string; // == Firebase Auth uid == document id
  name: string; // free text, from RegisterForm "Full Name"
  email: string;
  permission: UserPermission; // 'read' | 'readWrite'
  role: UserRole; // 'user' | 'admin'
  disabled: boolean; // blocks login (client-side check only)
  deleted: boolean; // soft delete; blocks login, hides from admin table
}
```

Derived booleans (`src/hooks/user_profile_hook.ts`): `isAdmin = role === 'admin'`,
`hasWritePermissions = permission === 'readWrite'`. **There are only two permission levels and two
roles. Admin does not imply write.** An `{role:'admin', permission:'read'}` user sees the Admin
Console but cannot edit any estimate.

### 3.2 Firestore collections actually used (verified by grep)

| Collection             | Doc id                      | Written by                                     |
| ---------------------- | --------------------------- | ---------------------------------------------- |
| `proposals`            | auto                        | `api/proposal.ts`, Cloud Function              |
| `wbs`                  | auto                        | `api/wbs.ts`                                   |
| `phase` _(singular!)_  | auto                        | `newAPI/api.ts`, Cloud Function                |
| `activities`           | auto                        | `newAPI/api.ts`, Cloud Function                |
| `users`                | `uid`                       | `register_form.tsx`, `admin_dashboard.tsx`     |
| `proposal-preferences` | **same id as the proposal** | `api/proposal_preferences.ts`, `newAPI/api.ts` |
| `visibilityModels`     | `{userId}_{phaseId}`        | `api/helpers.ts`                               |

### 3.3 `ProposalPreferences` (`src/models/proposal_preferences.ts`)

```ts
class ProposalPreferences {
  id?: string | null; // == proposalId
  wbsToDisplay?: string[] | null; // array of WBS *names* (not ids, not numbers)
}
```

This single array drives: the drawer WBS dropdown, the proposal WBS grid, the bottom-panel
proposal-level totals, **and which WBS appear in the Excel export**. Matching by _name string_ is
fragile — renaming a WBS silently drops it from the export.

### 3.4 Dataset versioning (`src/data/dataset_types.ts`, `datasets.ts`, `proposal_datasets.ts`)

```ts
type DataVersion = "v1" | "v2";
type DataType = "labor" | "phases" | "wbs" | "equipment";
type DatasetVersions = Record<DataType, DataVersion>;
DATA_VERSION_ORDER = ["v1", "v2"];
DEFAULT_DATA_VERSION = "v1";
CURRENT_DATA_VERSION = "v2";
```

Available JSON bundles: `labor {v1,v2}`, `phases {v1}`, `wbs {v1}`, `equipment {v1,v2}`.
`resolveDatasetVersion(type, preferred)` walks _down_ the version order until a bundle exists, so a
proposal asking for `phases: v2` silently gets `v1`. New proposals get
`buildDatasetVersions(CURRENT_DATA_VERSION)` = `{labor:'v2', phases:'v1', wbs:'v1', equipment:'v2'}`
(`api/proposal.ts:27`). `Proposal.datasetVersions?: Partial<DatasetVersions>` is the persisted
field.

### 3.5 The 15 rate fields on `Proposal` (drive every cost formula and the whole export)

| Field                     | Type   | Unit           | Export slot              |
| ------------------------- | ------ | -------------- | ------------------------ |
| `craftBaseRate`           | number | $/craft-MH     | BASE column              |
| `weldBaseRate`            | number | $/weld-MH      | WELD column              |
| `rigRate`                 | number | $/weld-MH      | RIG (top markup row)     |
| `burdenRate`              | number | % of base      | BURDEN                   |
| `overheadRate`            | number | % of base      | OVERHEAD                 |
| `laborProfitRate`         | number | % of base      | LABOR PROFIT             |
| `fuelRate`                | number | % of base      | FUEL                     |
| `consumablesRate`         | number | % of base      | CNSMBLE                  |
| `subsistenceRate`         | number | $/MH           | SUBSIST                  |
| `rigProfitRate`           | number | % of rig cost  | RIGS                     |
| `materialProfitRate`      | number | % of material  | MATERIAL                 |
| `equipmentProfitRate`     | number | % of equipment | EQUIP                    |
| `subContractorProfitRate` | number | % of sub cost  | SUBS                     |
| `salesTaxRate`            | number | % of material  | SALES TAX                |
| `useTaxRate`              | number | % of equipment | USE TAX (top markup row) |

Per-activity overrides: `customCraftRate` (`specialCraftRate` in the dump) and
`customSubsistenceRate` (`specialSubRate`).

`api/proposal.ts:convertRatesToNumbers` coerces 24 fields from `string` → `parseFloat` on read (all
15 rates plus
`craftManHours, craftCost, welderManHours, welderCost, materialCost, equipmentCost, subContractorCost, costOnlyCost, totalCost`)
— evidence that these were historically stored as strings.

### 3.6 `DataDumpItem` — the export row shape (`src/models/data_dump/data_dump_item.ts`)

40 optional fields. Column order in the sheet is determined by **object-literal insertion order**,
not by this interface, and `phaseId | wbsId | proposalId | phases | activities` are filtered out by
`doNotInclude`:

```
wbs, phase, size, flc, lineDescription, specification, insulation, insulationSize,
sheet, area, status, sys, specialCraftRate, specialSubRate, ownership, quantity, unit,
craftMH, weldMH, subMH, totalMH, baseCost, burden, overhead, laborProfit, fuel,
consumables, subsistence, laborCost, rigCost, materialCost, equipmentCost,
subcontractorCost, costOnlyCost, profitTotal, salesTax, total          → 37 columns
```

`DataDumpActivity` additionally carries `sortOrder`, which is **not** in `doNotInclude` (see §6 for
the resulting 38th column bug).

---

## 4. THE EXPORT — exhaustive spec

### 4.1 Inventory of export paths

There is exactly **one** export in the entire application.

- **UI:** Proposal Home → tab **"WBS Data Grid"** → toolbar button **`Data Dump`** (`SaveAlt` icon,
  `#424242`, 14px) → menu with a single item **`WBS Cost Report`**.
  (`features/proposal home/components/export_menu.tsx`, mounted at `wbs_data_grid.tsx:70`.)
- **Handler:** `fetchDD(proposalId, proposalPreferences)` from `src/api/data_dump.ts`. A full-screen
  `Backdrop` + `CircularProgress` blocks the UI for the whole duration. No progress %, no cancel,
  and **no error handling** — a throw leaves the backdrop up forever because `setLoading(false)` is
  after the un-guarded `await`.
- **No CSV export.** The grid toolbars (`phase_data_grid.tsx`, `activity_data_grid.tsx`,
  `wbs_data_grid.tsx`) mount only `GridToolbarColumnsButton` and `GridToolbarDensitySelector` —
  `GridToolbarExport` is never used.
- **No PDF export, no printing, no clipboard export, no email.** (`grep` for
  `jsPDF|pdf|print|csv|file-saver|saveAs` returns nothing.)
- Library: `xlsx-js-style` (`write(wb, {type:'buffer', bookType:'xlsx'})`). `xlsx` (SheetJS CDN
  tarball) and `xlsx-style-vite` are installed but unused by this path; `vite.config.ts` aliases
  `xlsx` → `./node_modules/xlsx/xlsx.mjs`.
- File is written through Tauri: `@tauri-apps/api/dialog.save` +
  `@tauri-apps/api/fs.writeBinaryFile`.
  - Save dialog title: **`Save to Spreadsheet`**
  - Default path: **`./{proposalNumber}-WBS-Cost-Report`** (relative path, no extension)
  - Filter: `[{ name: 'Excel Workbook', extensions: ['xlsx'] }]`
  - Cancelling returns silently.

### 4.2 Data assembly pipeline (`fetchDD`)

```
getSingleProposal(proposalId)
fetchDDActivities(proposalId)            // ALL activities of the proposal
  └ for each: calculateActivityData()   → activityToDataDumpItem()
fetchDDPhases(proposalId, activities)    // ALL phases; per-phase getSingleWbs() lookup  ← N+1
  └ rolls activity totals up into the phase; stamps phase attributes DOWN onto each activity
fetchDDWbs(proposalId, phases, prefs)    // ALL wbs, but only those whose NAME is in
                                         //   preferences.wbsToDisplay produce output rows
filter: keep only WBS with ≥1 phase
sort:   by wbs.wbsDatabaseId ascending
```

**Attribute inheritance (important):** in `fetchDDPhases` each activity row is mutated to inherit
the parent phase's
`phase(number), size, flc, specification(spec), insulation, insulationSize, sheet, area, status, sys`.
Activities are sorted by `sortOrder` then `sortOrder` is nulled.

**Phase quantity/unit resolution:**

```
quantity = phase.customQuantity ?? getDDQuantityAndUnit(activities, wbs.wbsDatabaseId).quantity
unit     = phase.customUnit ?? phase.unit
           ?? getDDQuantityAndUnit(activities, wbs.wbsDatabaseId).unit
```

`getDDQuantityAndUnit` (`utils/utils.ts:248`) sums the quantity of activities whose
`lineDescription` contains a WBS-specific keyword: | wbsDatabaseId | keywords | |---|---| | 20000 |
`EXCAVATE`, `BACKFILL / COMPACT` | | 40000 | `CLEAN UP` | | 50000 | `CLEAN UP` | | 60000 |
`CLEAN UP` | | 70000 | `HE` | | 130000 | `HE` | (all other WBS → quantity 0, unit ''). This is
**substring matching on a free-text description** to derive the headline takeoff quantity —
extremely brittle (`HE` matches "SHEET", "OTHER", …).

**WBS quantity/unit:** taken straight from `wbs.quantity` / `wbs.unit`.

### 4.3 Exact per-activity cost formulas used in the export (`activityToDataDumpItem`)

Let `P` = proposal, `A` = activity. All percentage rates are stored as whole numbers and divided
by 100.

```
craftBase   = (A.customCraftRate ?? A.craftBaseRate) * A.craftManHours
            + A.weldBaseRate * A.welderManHours
burden      = (P.burdenRate/100)        * craftBase
overhead    = (P.overheadRate/100)      * craftBase
laborProfit = (P.laborProfitRate/100)   * craftBase
fuel        = (P.fuelRate/100)          * craftBase
consumables = (P.consumablesRate/100)   * craftBase
subsistence = (A.craftManHours + A.welderManHours)
            * (A.customSubsistenceRate ?? P.subsistenceRate)
laborCost   = craftBase + burden + overhead + laborProfit + fuel + consumables + subsistence
rig         = P.rigRate * A.welderManHours

materialCost  = (type == materialItem)      ? A.quantity * A.price              : 0
equipmentCost = (type == equipmentItem)     ? A.quantity * (A.time * A.price)   : 0
subCost       = (type == subContractorItem) ? round2(A.quantity *
                    (A.craftCost + A.equipmentCost + A.materialCost))           : 0
costOnly      = (type == costOnlyItem)      ? A.costOnlyCost                    : 0

profitTotal = (P.materialProfitRate/100)       * materialCost
            + (P.rigProfitRate/100)            * rig
            + (P.equipmentProfitRate/100)      * equipmentCost
            + (P.subContractorProfitRate/100)  * subCost

salesTax    = materialCost  * (P.salesTaxRate/100)
            + equipmentCost * (P.useTaxRate/100)

total       = laborCost + rig + materialCost + equipmentCost + subCost
            + A.costOnlyCost + profitTotal + salesTax
```

**Owned-equipment special case**
(`isOwnedEquip = type==equipmentItem && equipmentOwnership=='owned'`): `profitTotal = null`,
`salesTax` still computed, and `total = equipmentCost` **only** — labor, rig and tax are excluded
from the line total. Also `equipmentCost` is _not_ rounded for owned items (rounded for rentals).

All monetary outputs pass through
`currencyRound(n) = parseFloat((Math.round(n*100)/100).toFixed(2))` (`api/helpers.ts:112`).

Roll-ups are plain sums of the child rows (activity → phase → WBS → grand total) over:
`craftMH, weldMH, baseCost, burden, overhead, laborProfit, fuel, consumables, subsistence, laborCost, rigCost, materialCost, equipmentCost, subcontractorCost, costOnlyCost, profitTotal, salesTax, total`,
with `totalMH = craftMH + weldMH`.

### 4.4 Exact workbook layout produced

Single worksheet. **Sheet name: `readme demo`** (a copy-paste leftover from a SheetJS sample —
`data_dump.ts:247`). 37 columns → A … AK.

**Column map (0-based index → letter → header text):**

```
0  A  WBS          10 K  STATUS        20 U  TOTAL (MH)   30 AE MATERIAL
1  B  PHASE        11 L  SYS           21 V  BASE         31 AF EQUIP
2  C  SIZE         12 M  SPCL RATE     22 W  BURDEN       32 AG SUBS
3  D  FLC          13 N  SPCL SUB      23 X  OVERHEAD     33 AH COST ONLY
4  E  LINE/DESCRIP 14 O  OWNERSHIP     24 Y  LABOR PROFIT 34 AI PROFIT TOTAL (R/M/E/S)
5  F  SPEC         15 P  QTY           25 Z  FUEL         35 AJ SALES TAX
6  G  INSUL        16 Q  UNIT          26 AA CNSMBLE      36 AK TOTAL
7  H  INSL. SIZE   17 R  CRAFT         27 AB SUBSIST
8  I  SHT          18 S  WELD          28 AC LABOR
9  J  AREA         19 T  SUB           29 AD RIGS
```

**Row map:**

| Sheet row | Content                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| 1         | `AF1 = "Proposal #:"`, merged `AG1:AK1` = `proposal.proposalNumber`                                                 |
| 2         | `AF2 = "Job #:"`, merged `AG2:AK2` = `proposal.job`                                                                 |
| 3         | `AF3 = "Change #:"`, merged `AG3:AK3` = **always blank** (the assignment is commented out — `data_dump.ts:117`)     |
| 4         | `AF4 = "Description:"`, merged = `proposalDescription`                                                              |
| 5         | `AF5 = "Owner:"`, merged = `proposalOwner`                                                                          |
| 6         | `AF6 = "Location:"`, merged = `` `${projectCity}, ${projectState}` ``                                               |
| 7         | `AF7 = "Date:"`, merged = today formatted `"Month D, YYYY"` (hand-rolled month-name array)                          |
| 8         | top markup **labels**: `S8 = "RIG"`, `AJ8 = "USE TAX"`                                                              |
| 9         | top markup **values**: `S9 = "$" + rigRate.toFixed(2)`, `AJ9 = useTaxRate.toFixed(2) + "%"`                         |
| 10        | **header row** (37 headers above), style: Calibri (Body) 10, centered, wrapped, thin top/bottom/right borders       |
| 11        | bottom markup values (see below), merged `AH11:AI11` = `"(no tax or mu)"`                                           |
| 12 …      | data rows: WBS row, then its phase rows, then that phase's activity rows, repeated; final row = grand-total summary |

**Row 11 markup values (all written as _strings_, blue bold Calibri 10 on `#ededed` with medium
borders):**

```
S11  = "$" + weldBaseRate.toFixed(2)          AD11 = rigProfitRate.toFixed(2) + "%"
V11  = "$" + craftBaseRate.toFixed(2)         AE11 = materialProfitRate.toFixed(2) + "%"
W11  = burdenRate.toFixed(2) + "%"            AF11 = equipmentProfitRate.toFixed(2) + "%"
X11  = overheadRate.toFixed(2) + "%"          AG11 = subContractorProfitRate.toFixed(2) + "%"
Y11  = laborProfitRate.toFixed(2) + "%"       AH11:AI11 = "(no tax or mu)"
Z11  = fuelRate.toFixed(2) + "%"              AJ11 = salesTaxRate.toFixed(2) + "%"
AA11 = consumablesRate.toFixed(2) + "%"
AB11 = "$" + subsistenceRate.toFixed(2)
```

**Merges:** `AH11:AI11`, plus `AG1:AK1 … AG7:AK7` (7 merges for the proposal-info block).

**Column widths** (`ws['!cols']`): `10, 10, 8.5, 7, 55, 11, 8, 8, 7,` then `15` for every column
through AJ, and `18` for AK. **Row heights** (`ws['!rows']`, rows 1-11):
`15,15,15,15,15,15,15,23,16,31,16` px.

**Cell styling by row type (`styles` map in `data_dump.ts:707`):**

| Row type    | Font                | Fill                     | Alignment                                                       |
| ----------- | ------------------- | ------------------------ | --------------------------------------------------------------- |
| WBS         | Calibri **14 bold** | `#ddebf7` (light blue)   | right; `wbs` number **centered**; `lineDescription`/`unit` left |
| Phase       | Calibri **12 bold** | `#fff2cc` (light yellow) | right; `lineDescription`/`unit` left                            |
| Activity    | Calibri 10          | none                     | right; `lineDescription`/`unit` left                            |
| Grand total | Calibri **14 bold** | `#e2eeda` (light green)  | right; medium top+bottom borders                                |

**Medium right-hand borders** are added to these columns to visually group the report
(`rightBorderedCells`): `sys (L)`, `ownership (O)`, `totalMH (U)`, `subsistence (AB)`,
`subcontractorCost (AG)`, `costOnlyCost (AH)`, `salesTax (AJ)`.

**Override highlight:** an activity cell in `SPCL RATE` or `SPCL SUB` that has a non-null, non-zero
value gets `activityBorderAll` — a full medium box border — so overridden rates are visually
flagged.

**Number formats:**

- currency columns
  (`baseCost, burden, overhead, laborProfit, fuel, consumables, subsistence, laborCost, rigCost, materialCost, equipmentCost, subcontractorCost, costOnlyCost, profitTotal, salesTax, total, specialSubRate, specialCraftRate`)
  → `_("$"* #,##0.00_);_("$"* \(#,##0.00\);_("$"* "-"??_);_(@_)`
- plain-number columns (`quantity, craftMH, weldMH, subMH, totalMH`) →
  `_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)` — note the **doubled backslashes**, an
  almost certainly broken negative-number section.
- A `0` or `null` value becomes the literal string `"-"` in currency columns and `""` elsewhere, and
  is written with cell type `s` (text), so those cells are not numeric.

**Everything is written as static values. The exported workbook contains NO formulas.**

### 4.5 `src/api/tracking_report.xlsx` — the source-of-truth artifact

This file is **not referenced by any code** (`grep tracking_report` → 0 hits in `src/`,
`functions/`, `src-tauri/`). It is the hand-built Excel model the Data Dump export was
reverse-engineered from — the canonical spec for the report.

Metadata: created `2021-01-04` by **Mark Bieber**, last modified `2023-08-14`, last printed
`2021-03-17`. One sheet, **`Tracking Report`**, range `A1:AJ171`, freeze panes at `A14`, autofilter
`A14:AJ147`, print titles = rows `9:13`, an embedded logo image, a printer-settings blob, and an
**external link to a SharePoint workbook**
(`indemandis-my.sharepoint.com/.../1078.06-COR-001.xlsx`). Sample project: proposal `1539`,
`FLARE #2 METER RELOCATION`, owner `CALUMET`, `GREAT FALLS, MT`.

**Layout of the original (differs from the app export by one column):**

```
row 1-7  : AE labels ("Proposal #:", "Job #:", "Change #:", "Description:",
           "Owner:", "Location:", "Date:"),  values merged AF:AJ (AF7 = =NOW())
row 9    : B9 merged "WBS TRACKING REPORT"
row 10   : R10 "RIG"        AI10 "USE TAX"
row 11   : R11 = 15         AI11 = 0
row 12   : headers A..AJ  (36 columns — NO "SYS" column)
row 13   : markups  R13=40.7 (weld base $)  U13=37.35 (craft base $)
                    V13=0.2105 burden  W13=0.10 overhead  X13=0.10 labor profit
                    Y13=0.03 fuel      Z13=0.10 consumables  AA13=14 subsistence $/MH
                    AC13=0.10 rig profit  AD13=0.075 material profit
                    AE13=0.075 equip profit  AF13=0.075 sub profit
                    AG13="(no tax or mu)"  AI13=0 sales tax
row 15+  : data; WBS rollups in col A, phase numbers in col B
row 147  : grand total,  E147 = =AF4 (echoes the description)
```

**The app's export inserts a `SYS` column at L, shifting everything right by one** — so the
generated file is _not_ byte-compatible with the template and existing downstream sheets that
reference fixed columns will break.

**The original stores markups as real numbers (0.2105) and every cell as a live formula.** The
canonical formulas, which the app's TypeScript reproduces exactly, are:

| Column            | Formula (row _n_)                                                                                 | Meaning                                     |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `T` TOTAL MH      | `=SUM(Qn,Rn,Sn)`                                                                                  | craft + weld + sub MH                       |
| `U` BASE          | `=($Qn*$U$13)+((Rn*$R$13))` — or `=($Qn*$Ln)+((Rn*$R$13))` when a **SPCL RATE** is present in `L` | craft MH × craft base + weld MH × weld base |
| `V` BURDEN        | `=$Un*V$13`                                                                                       |                                             |
| `W` OVERHEAD      | `=$Un*W$13`                                                                                       |                                             |
| `X` LABOR PROFIT  | `=$Un*X$13`                                                                                       |                                             |
| `Y` FUEL          | `=$Un*Y$13`                                                                                       |                                             |
| `Z` CNSMBLE       | `=$Un*Z$13`                                                                                       |                                             |
| `AA` SUBSIST      | `=($Qn+$Rn)*AA$13` — or `*$Mn` when a **SPCL SUB** rate is present                                | total MH × $/MH                             |
| `AB` LABOR        | `=SUM(Un:AAn)`                                                                                    |                                             |
| `AC` RIGS         | `=($R$11*$Rn)`                                                                                    | rig rate × weld MH                          |
| `AH` PROFIT TOTAL | `=(AD$13*ADn)+(AC$13*ACn)+(AE$13*AEn)+(AF$13*AFn)`                                                | material + rig + equip + sub profit         |
| `AI` SALES TAX    | `=($ADn*AI$13)+($AEn*AI$11)`                                                                      | material×sales tax + equip×use tax          |
| `AJ` TOTAL        | `=SUM(ABn:AIn)`                                                                                   |                                             |
| rollup rows       | `=SUM(child rows)` per column; grand total `=A15+A31+A38+…`                                       |                                             |

`OWNERSHIP` (col N) takes the literal values `OWNED` / `RENTAL`; in the original, owned equipment is
entered as a **COST ONLY** amount in `AG` (no tax, no markup) rather than as an equipment cost —
which is exactly why the app special-cases `isOwnedEquip`.

WBS rollup rows observed in the sample: `10000 MOBILIZE`, `20000 SITE PREPARATION`,
`60000 STRUCTURAL`, `70000 AG PIPING`, `110000 PAINTING`, `120000 DISMANTLING`,
`180000 SPECIALTY SERVICES`, `190000 DEMOBILIZE`, `200200 SUPPORT`. Units seen at WBS level:
`EA, CY, TON, LF, SF`.

---

## 5. Tauri integration, packaging and auto-update

### 5.1 `src-tauri/tauri.conf.json`

- `productName: "MCP Estimator"`, `version: 1.4.3`, `identifier: com.mcpestimator`,
  `category: "DeveloperTool"` (wrong category for a construction estimator).
- Window: `title: "mcp_estimator"` (lower-case, immediately overwritten to `MCP Estimator` by
  `main.rs`), `800×600` in config but forced to `1200×800` at runtime, `resizable: true`,
  `fullscreen: false`. **Only one window.**
- Dev server `http://localhost:1420`, `distDir: ../dist`, `beforeDevCommand: yarn dev`,
  `beforeBuildCommand: yarn build` (yarn, even though the repo README/CLAUDE.md talk about npm).
- **Allowlist: `"all": true`** — the entire Tauri v1 API surface is exposed to the webview, plus
  explicit `fs.all`, `dialog.all`, `path.all`, `http.all` with scope `https://**`.
- **`security.csp: null`** — no Content-Security-Policy at all.
- Bundle targets `"all"`; icons `32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico`; macOS
  signing identity `null`, entitlements `null`; Windows `certificateThumbprint: null`,
  `digestAlgorithm: sha256`, empty `timestampUrl` → **unsigned installers on both platforms.**
- **Updater:**
  ```
  active: true
  dialog: true      // Tauri's built-in "A new version is available" modal
  endpoints: ["https://gist.githubusercontent.com/collinwillis/40b8751c25f6d48248e78aafb33cb638/raw"]
  pubkey: <minisign public key, base64>
  ```
  The update manifest lives in a **public GitHub Gist**.

### 5.2 `src-tauri/src/main.rs`

37 lines. Windows subsystem attribute for release builds. One unused `#[tauri::command] greet`.
`setup` hook: gets window `main`, prints `Initializing...`, sets logical size 1200×800, sets title
`MCP Estimator`, sets resizable, prints `Done set size.`. No menu, no tray, no event handlers, no
custom commands, no single-instance guard, no deep-link handler.

Cargo: `tauri 1.1` with features `["api-all", "updater"]`, `serde`, `serde_json`. Package
`name = "mcp_estimator"`, `version = "0.0.0"` (never bumped — the real version lives in
`tauri.conf.json`).

### 5.3 Release pipeline (`.github/workflows/release.yml`)

Trigger: push of a tag matching `v*`. Runner: **`windows-latest` only** → macOS/Linux builds are
never produced despite `targets: "all"`.

Steps:

1. Derive `VERSION` from `GITHUB_REF_NAME` minus the leading `v`.
2. Rewrite `src-tauri/tauri.conf.json` → `package.version = VERSION` with an inline Node script.
3. Node 18 + yarn cache; Rust stable; `swatinem/rust-cache` on `src-tauri -> target`.
4. `yarn install --frozen-lockfile`.
5. `tauri-apps/tauri-action@v0` — creates a GitHub Release named `MCP Estimator v{VERSION}`, body
   `See the assets below to download and install.`, not a draft, not a prerelease. Signs with
   `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` secrets.
6. Locate `src-tauri/target/release/bundle/msi/*.msi.zip.sig`, read the signature; locate the
   matching `*.msi.zip`, and rewrite spaces in the name to dots to match GitHub's asset URL.
7. `PATCH https://api.github.com/gists/40b8751c25f6d48248e78aafb33cb638` writing the manifest to
   **both** `updater.json` and `mcp_estimator_current_release.json`. The in-repo comment explains
   why: _the gist's bare `/raw` URL serves the alphabetically-first file_, so both must be kept in
   sync or installed apps never see updates.

Manifest shape:

```json
{
  "version": "<v>",
  "notes": "MCP Estimator <tag>",
  "pub_date": "<ISO>",
  "platforms": { "windows-x86_64": { "signature": "<sig>", "url": "<release asset URL>" } }
}
```

Only `windows-x86_64` is published — a macOS install would poll the endpoint and find no matching
platform key forever.

### 5.4 Vite / build config

`vite.config.ts`: React plugin, `clearScreen:false`, dev server `port 1420` `strictPort`,
`envPrefix: ['VITE_','TAURI_']`, build target `['es2021','chrome100','safari13']`, minify unless
`TAURI_DEBUG`, sourcemaps only when `TAURI_DEBUG`, and an alias `xlsx → node_modules/xlsx/xlsx.mjs`.

`index.html`: title **`Tauri + React + TS`** (never customised — it is what the OS window/task
switcher may show before `main.rs` retitles), favicon `/vite.svg`, a Google-Fonts preconnect + Open
Sans stylesheet (**a network font load in a desktop app**, and the theme actually asks for Roboto),
and `<script src="dist/xlsx.bundle.js">` which **does not exist** in `dist/` — a dead 404 on every
launch.

`README.md` is still the unmodified Tauri template readme.

---

## 6. Firebase Cloud Functions and server-side logic

`firebase.json` declares exactly one codebase: `functions/` (Node 18, `firebase-admin ^12.2.0`,
`firebase-functions ^4.3.1`), with predeploy `npm run lint && npm run build`. `.firebaserc` →
project `mcp-estimator`.

**There is no `firestore.rules`, no `firestore.indexes.json`, no `storage.rules` and no `hosting`
block anywhere in the repo.** All server-side authorisation is therefore invisible to this codebase
— it lives only in the Firebase console. Nothing in the repo enforces the `read` / `readWrite`
distinction; it is a purely cosmetic client-side check (§7.2).

### 6.1 `duplicateProposal` — the only deployed function (`functions/src/index.ts`)

`https.onCall`, `timeoutSeconds: 540`, `memory: "8GB"`. Client caller:
`features/home/components/edit_proposals_dialog.tsx:48-50`.

**Input:** `{ proposalId: string }` → throws `invalid-argument` if missing, `not-found` if the
proposal doc doesn't exist.

**Revision-numbering algorithm:**

```
base = parseFloat(proposal.proposalNumber)
query proposals where proposalNumber >= base and proposalNumber < base+1
decimals = those numbers minus base, keeping >= 0
nextDecimal = 0.1; while (decimals contains nextDecimal) nextDecimal += 0.1  (toFixed(1))
newProposalNumber = base + nextDecimal
revisionNumber    = round(nextDecimal * 10)      // 0.1 -> 1, 0.2 -> 2 …
```

i.e. proposal `9` duplicates to `9.1`, then `9.2`, … **capped implicitly at `.9`** — a tenth
revision would collide with the next integer proposal number.

**Description handling:** strips any trailing `" - Rev N"` (regex `/\s*-\s*Rev\s+\d+$/i`) to prevent
stacking, then appends `" - Rev {revisionNumber}"`.

**What is copied** (all via batched writes, committing every 500 ops):

1. the proposal doc (spread + `createdAt: new Date()`, new description, new number)
2. `proposal-preferences/{oldId}` → `proposal-preferences/{newId}` (with `id` rewritten)
3. every `wbs` where `proposalId == old` → new docs, building `wbsIdMap[old] = new`
4. every `phase` where `proposalId == old` → new docs with remapped `wbsId`, building `phaseIdMap`
5. for **each** phase, a separate query of `activities where phaseId == oldPhaseId` → new docs with
   remapped `phaseId`, `proposalId`, `wbsId`

**Returns:** `{ newProposalId }`.

Notes / risks:

- Step 5 is a sequential N+1 query loop — one Firestore query per phase.
- `context` (auth) is **never checked** — any authenticated _or unauthenticated_ caller with the
  project's public config can duplicate any proposal by id.
- The client throws away `newProposalId` and shows no success feedback.

### 6.2 One-off maintenance scripts (`functions/scripts/`, run manually via npm scripts)

Both are dry-run-by-default, page through `proposals` ordered by document id, and require an
explicit `--apply --confirm=<TOKEN>` plus `--scan-all` or `--limit=N`.

- **`backfill_dataset_versions.js`** (`npm run backfill:datasetVersions`, confirm token
  `BACKFILL_DATASET_VERSIONS`). For proposals lacking a `datasetVersions` object, writes
  `{ labor:'v1', phases:'v1', wbs:'v1', equipment: constantDataSet === '2026' ? 'v2':'v1' }` via
  `set(..., {merge:true})`. Batch flush at 450 ops.
- **`cleanup_proposal_legacy_fields.js`** (`npm run cleanup:proposalLegacyFields`, confirm token
  `CLEANUP_PROPOSAL_LEGACY_FIELDS`). For proposals that _do_ have `datasetVersions`, deletes the
  legacy `constantDataSet` and `dataVersion` fields (`FieldValue.delete()`).

These document a real historical migration: `constantDataSet: '2026'` → per-type dataset versions.

### 6.3 Client-side operations that should have been server-side

- **`deleteProposalAndAssociatedData`** (`api/proposal.ts:128`) — a _client_ cascade delete. Builds
  one `writeBatch`, adds deletes for `activities`, `phases`(sic), `wbs` where `proposalId == id`,
  then `deleteDoc(proposal)` **before** `batch.commit()`. See §8 for the two bugs this contains.
- **`loadFullProposalData`** — the client downloads the whole proposal tree and recomputes every
  total in the browser (`utils/store.ts:105`).

---

## 7. UX problems observed (with evidence)

**7.1 The MUI X Pro licence is forged at runtime.** `App.tsx:29-35` builds a licence string with
`orderNumber = ''` and `expiryTimestamp = Date.now()`, then
`LicenseInfo.setLicenseKey(md5(btoa(licenseInfo)) + btoa(licenseInfo))`. This is a known
key-generation bypass for `@mui/x-license-pro`. It is a legal/compliance liability, and it silently
pins the app to `@mui/x-data-grid-pro@5.17.21` (a 2022 release). _Precision must not carry this
forward._

**7.2 Permissions are decoration.** `hasWritePermissions` only sets `readOnly` / `disabled` / hides
toolbar buttons. There is no `firestore.rules` in the repo, `duplicateProposal` never checks
`context.auth`, and the login "disabled/deleted" check happens **after** a successful sign-in
without signing the user back out (`login_form.tsx:52-60`). A disabled user retains a valid Firebase
session.

**7.3 `useUserProfile` re-fetches the user document in eight different components.** `drawer.tsx`,
`bottom_pannel.tsx`, `phase_data_grid.tsx`, `activity_data_grid.tsx` (twice), `wbs_data_grid.tsx`,
`proposal_info_accordion.tsx`, `proposal_rates_accordion.tsx`. Each mount issues its own
`getDoc(users/{uid})`. There is no context/provider, no cache, and it initialises
`hasWritePermissions = false` — so every screen **flashes read-only** for one round-trip before
controls become editable.

**7.4 The app-bar "download" icon is a refresh button.** `DownloadForOffline` →
`loadFullProposalData(proposalId)` (`drawer.tsx:224-230`). No tooltip, no label, no loading
indicator, and it re-downloads the entire proposal tree. Users cannot tell it apart from an export.

**7.5 The drawer collapses itself the moment you open a proposal** and there is no persistence:
`useState(proposalId === undefined)` (`drawer.tsx:122`). In home mode there is no collapse button at
all, and in proposal mode there is no re-open button inside the drawer (only the app-bar icon).

**7.6 Two separate navigation models fight each other.** The proposal-mode drawer has
`Proposal Home` / `WBS Home` links that are _disabled precisely when you are at that level_, so the
user sees greyed-out items as the "you are here" indicator — the inverse of the usual convention.

**7.7 Three independent search boxes with three different semantics.** Drawer proposal search (22
fields joined by spaces, cross-field false positives), phase search (number match is not
case-normalised), admin user search (name only, cannot find a user by email).

**7.8 Everything is SHOUTED.** The theme force-uppercases every text input, including the search
boxes, and `store.ts` uppercases values on write. Only `RegisterForm`'s Full Name opts out via
`className='normal-case'`. There is no way to enter mixed-case data anywhere in the estimate.

**7.9 The export blocks the whole app with an unlabelled spinner.** `export_menu.tsx:45-50`:
`setLoading(true); await fetchDD(...); setLoading(false);` with a full-screen `Backdrop`. No
progress, no cancel, no error path — an exception leaves the app permanently covered.

**7.10 Export silently omits data.** Only WBS whose _name_ appears in `preferences.wbsToDisplay` are
exported (`data_dump.ts:463`), and only WBS with at least one phase (`data_dump.ts:44-46`). The user
gets no warning that rows were dropped (the bottom panel's "Hidden WBS data" chip is the only hint,
and it is not shown on the export dialog).

**7.11 Duplicate/delete in `EditProposalsDialog` share a single busy flag.** `isDuplicating` /
`isDeleting` are dialog-level, so clicking one row's duplicate button spins **every** row's icon
(`edit_proposals_dialog.tsx:38, 142-151`). Duplicate has no success toast; the new proposal just
appears in the list when the `onSnapshot` fires.

**7.12 Admin destructive actions have no confirmation.** `Delete` writes `deleted: true` immediately
(`admin_dashboard.tsx:207`), yet its tooltip claims _"Permanently delete this user"_ — which is
doubly wrong: it isn't permanent, and it isn't confirmed. Permission/role dropdown changes also
write instantly, with no `try/catch`.

**7.13 Email verification is a dead end.** `RegisterForm` never sends a verification email;
`verify_email.tsx` has no "check again" button and no polling, so the user must fully restart the
app after clicking the emailed link.

**7.14 `AuthRoute` renders the literal string `loading ....`** (`auth_route.tsx:34`) — unstyled,
un-centred, four dots.

**7.15 No global error handling or telemetry.** There is no error boundary anywhere, no toast
system, no Sentry/analytics. Failures are reported via `console.error` (34+ call sites) or swallowed
entirely (`deleteProposalAndAssociatedData` catches and only logs).

**7.16 No offline/conflict story.** `useProposals` is a real-time `onSnapshot` on the whole
`proposals` collection, but the proposal tree is a one-shot fetch into Zustand. Two estimators on
the same proposal will overwrite each other with no warning and no last-writer indicator.

**7.17 The `<DevSupport>` IDE preview harness ships to production** (`main.tsx`), pulling
`@react-buddy/ide-toolbox`, `@react-buddy/palette-chakra-ui` and `@react-buddy/palette-mui` into the
bundle.

**7.18 Two UI frameworks are installed.** `@chakra-ui/react` + `framer-motion` are dependencies,
`setup/chakra_theme.tsx` exists, but no `ChakraProvider` is ever mounted — pure bundle weight.

**7.19 `MemoryRouter` means the app forgets where you were.** No deep links, no window-state
restore, and any reload (or the Tauri updater relaunch) dumps the user back on `/`.

**7.20 Google Fonts is fetched over the network at startup** (`index.html`) for a font (`Open Sans`)
the theme doesn't even use — the app renders in Roboto/system fonts and blocks on a remote request
that will fail offline.

---

## 8. Dead or broken code

### 8.1 Broken (real defects)

| #   | Location                                    | Defect                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `api/proposal.ts:135`                       | `deleteAssociatedData('phases', ...)` targets a **collection named `phases`**, but every other call site uses **`phase`** (singular — verified: 11 references). Deleting a proposal therefore **orphans every phase document**.                                                 |
| B2  | `api/proposal.ts:141-146`                   | The proposal doc is deleted (`deleteDoc`) _before_ `batch.commit()`. If the batch exceeds Firestore's 500-op limit (any proposal with >500 activities), the commit throws, the `catch` only `console.error`s, and the proposal is gone while its children remain.               |
| B3  | `data_dump.ts:117`                          | `p3[31].v = proposal` is commented out, so **`Change #:` (row 3) is always blank** in every exported report. `Proposal.coNumber` is never exported.                                                                                                                             |
| B4  | `data_dump.ts:601-674` + `data_dump.ts:449` | `DataDumpActivity.sortOrder` is **not** in `doNotInclude`, so activity rows emit a **38th cell (column AL)** that WBS/phase/summary rows don't have. It is always empty (sortOrder is nulled at `data_dump.ts:360`) but it makes the sheet ragged.                              |
| B5  | `data_dump.ts:434-438`                      | `wbs` sort comparator reads `const second = a.data()` — should be `b.data()`. The comparator always returns 0. (Masked later by `wbs.sort((a,b)=>a.wbs-b.wbs)` in `fetchDD`.)                                                                                                   |
| B6  | `data_dump.ts:63-79`                        | `topMarkups` / `bottomMarkups` / `proposalInfo1..7` are **module-level mutable `let` arrays** mutated in place on every export. Concurrent or repeated exports share state; a missing rate yields the literal string `"$undefined"` / `"undefined%"` because of `?.toFixed(2)`. |
| B7  | `data_dump.ts:852`                          | Plain-number format string uses `\\\\(` (double-escaped backslashes), producing an invalid negative-number section in the Excel format code.                                                                                                                                    |
| B8  | `data_dump.ts:247`                          | Sheet name is `'readme demo'` — leftover from a SheetJS example.                                                                                                                                                                                                                |
| B9  | `login_form.tsx:52-60`                      | Disabled/deleted users are shown an error but **are not signed out**; the Firebase session remains valid.                                                                                                                                                                       |
| B10 | `register_form.tsx:36-42`                   | Error text says "Only @indemandis.com" while the allow-list also accepts `tidybrackets.com` and `outlook.com`. No verification email is sent on registration.                                                                                                                   |
| B11 | `drawer.tsx:123, 431-433`                   | `addPhaseDialogOpen` is declared and the dialog rendered, but **nothing ever sets it to `true`** — the drawer's Add-Phase path is unreachable.                                                                                                                                  |
| B12 | `functions/src/index.ts:69-74`              | Revision numbering breaks past `.9`: `base + 1.0` collides with the next integer proposal number. Float arithmetic on `0.1` increments is also fragile (mitigated by `toFixed(1)` but not by `includes()` on floats).                                                           |
| B13 | `functions/src/index.ts:26`                 | `duplicateProposal` never inspects `context.auth`.                                                                                                                                                                                                                              |
| B14 | `index.html:17`                             | `<script src="dist/xlsx.bundle.js">` — file does not exist in `dist/`.                                                                                                                                                                                                          |
| B15 | `src/.env`, `~/.tauri/myapp.key`            | **Both are tracked in git** (`git ls-files` confirms) even though `.gitignore` lists `src/.env`. They contain the **Tauri updater minisign private key and its password in plaintext**. Anyone with repo access can sign a malicious update for the public-gist endpoint.       |
| B16 | `data_dump.ts:692`                          | `const extension = selected.slice(...)` computed then ignored; `bookType` is hard-coded `'xlsx'`. Choosing another extension in the save dialog still writes xlsx bytes.                                                                                                        |
| B17 | `data_dump.ts:540-548`                      | `getSubProfit()` is defined inside `activityToDataDumpItem` and **never called**; its body is also wrong (`materialProfit = craftCost * (subProfit + salesTax)` uses craft cost for material).                                                                                  |
| B18 | `admin_dashboard.tsx:67-73`                 | `updateUser` has no error handling and optimistically mutates local state; a failed write leaves the UI showing a role/permission the server rejected. Unused imports `BlockIcon`, `DeleteIcon` remain.                                                                         |
| B19 | `proposal_home.tsx:46`                      | `const craftLoadedRate = getCraftLoadedRate({proposal})` is computed and discarded every time the proposal changes.                                                                                                                                                             |

### 8.2 Dead code (unreferenced by anything)

| Path                                                                                                         | Note                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/stores/activity_store.ts`, `phase_store.ts`, `preference_store.ts`, `proposal_store.ts`, `wbs_store.ts` | **Entire `stores/` folder is dead.** The real store is `src/utils/store.ts`. CLAUDE.md's claim of "Zustand stores for each major entity" is false.                                                                           |
| `src/hooks/wbs_hook.ts`, `phase_hook.ts`, `activity_hook.ts`, `rates_hook.ts`                                | never imported                                                                                                                                                                                                               |
| `src/api/phase.ts`                                                                                           | only imported by the dead `wbs_hook.ts` → effectively dead                                                                                                                                                                   |
| `src/context/auth_context.tsx`                                                                               | `AuthProvider`/`useAuth` never mounted; the context value is a literal `{}` and `signUp`/`signIn` are unreachable                                                                                                            |
| `src/setup/chakra_theme.tsx`                                                                                 | no `ChakraProvider` anywhere                                                                                                                                                                                                 |
| `src/components/project_card.tsx`                                                                            | Chakra-based, never imported                                                                                                                                                                                                 |
| `src/components/add_phase_button.tsx`                                                                        | never imported                                                                                                                                                                                                               |
| `src/utils/test.ts`                                                                                          | a `useCounterStore` scratch file                                                                                                                                                                                             |
| `src/features/proposal home/components/proposal_info_accordion.tsx` (418 lines)                              | never imported — superseded by `proposal_details.tsx`. This is the old accordion-based proposal-information UI.                                                                                                              |
| `src/features/proposal home/components/proposal_rates_accordion.tsx` (~220 lines)                            | never imported — superseded by `proposal_rates.tsx`                                                                                                                                                                          |
| `src/style.css` (41 lines) and `src/App.css`                                                                 | **never imported by `main.tsx` or `index.html`** — the global uppercase rule _and_ `html { user-select: none }` in them are inert. The uppercase behaviour that ships comes from the MUI theme + `store.ts`.                 |
| `src/config/colors.js`, `src/config/fonts.js`                                                                | unreferenced                                                                                                                                                                                                                 |
| `src/api/tracking_report.xlsx`                                                                               | reference artifact, no code path                                                                                                                                                                                             |
| `src/dev/` (`index.ts`, `palette.tsx`, `previews.tsx`, `useInitial.ts`, `README.md`)                         | JetBrains React-Buddy scaffolding; `useInitial` returns a static `{loading:false, error:false}`; `PaletteTree` only registers an `ExampleLoaderComponent` that renders `Loading...`. **Wired into `main.tsx`, so it ships.** |
| `printFiles.js` / `printFiles.mjs`                                                                           | dev utility that recursively `console.log`s a directory tree's file contents (was presumably used to paste the codebase into an LLM)                                                                                         |
| `src-tauri/src/main.rs:11-14`                                                                                | `greet` command never invoked                                                                                                                                                                                                |
| `data_dump.ts:1459-1476`                                                                                     | `dollarFormatCells` array declared, never used                                                                                                                                                                               |
| `config/theme.ts:1-48`                                                                                       | two commented-out earlier themes                                                                                                                                                                                             |
| `api/proposal.ts:172+`                                                                                       | large commented-out `duplicateProposalAndAssociatedData` (superseded by the Cloud Function)                                                                                                                                  |
| root `*.sql` files, 14 `timesheet_*.txt`, `work_log_items_library.txt`, `firebase-debug.log` (340 KB)        | committed junk / migration experiments                                                                                                                                                                                       |

---

## 9. PARITY CHECKLIST

Every discrete capability Precision must eventually have from this area. (E) marks items that are
essential for functional parity; the rest are "must exist in some form, redesign freely".

**Shell & navigation**

- (E) Four-level navigation model: proposal list → proposal → WBS → phase, with the
  proposal/WBS/phase context always visible
- (E) Breadcrumb showing `{proposalNumber} - {description}` › `{wbs.name}` ›
  `{phaseNumber} - {description}`, with the first two clickable
- (E) Persistent left navigation containing: proposal list (home mode) and WBS selector + phase list
  (proposal mode)
- (E) WBS selector rendering `{wbsDatabaseId} {name}`, sorted by `wbsDatabaseId`, limited to the
  proposal's _visible_ WBS set
- (E) Phase list sorted by `phaseNumber`, showing number + description, with the current phase
  highlighted
- (E) Search over the proposal list across all 22 proposal fields (number, job, CO number,
  description, owner, city, state, job-site address, estimators, date received, date due, project
  start/end, bid type, status, contact name/address/city/state/zip/phone/email)
- (E) Search over the phase list by phase number or description
- Collapse/expand of the side navigation, with the state remembered
- Remember and restore the last-selected proposal
- Remember the last-selected tab on the proposal screen
- Back navigation from a proposal to the proposal list
- Explicit "reload this proposal's data" affordance (replacing the mislabelled download icon), with
  a visible loading state
- Menu containing Admin Console (admin only) and Logout

**Persistent status bar / bottom panel** (used on proposal, WBS and phase screens)

- (E) Live totals bar: Total Cost, Total Hours, Direct Hours, Indirect Hours, Subcontractor Hours
- (E) Scope rule: phase level = that phase's activities; WBS level = that WBS's phases; proposal
  level = **visible WBS only**
- (E) Indirect-hours classification by WBS number: `10000` Mobe, `190000` Demobe, `200000` Support,
  `180000` Specialty; everything else is direct
- (E) Subcontractor hours = `quantity × time` over subcontractor activities
- (E) Expandable breakdown: Hours (Craft, Welder, Support, Mobe/Demobe, Specialty, Subcontractor,
  Total), Labor Costs (Craft, Weld & Rig, Subcontractor), Other Costs (Equipment, Material, Cost
  Only)
- (E) "Hidden WBS data" warning when a WBS excluded from display still contains cost or hours
- (E) Quick-add bar: at phase level — Activity, Equipment, Material, Cost Only, Custom Labor,
  Subcontractor; at WBS level — Phase
- Remember the expanded/collapsed state of the breakdown

**Auth**

- (E) Email + password sign-in
- (E) Registration with full name, email, password
- (E) Email-domain allow-list on registration (currently `indemandis.com`, `tidybrackets.com`,
  `outlook.com`) with an accurate error message
- (E) Email verification required before app access, with a resend action **and** a working "I've
  verified — continue" path
- (E) Send the verification email automatically at registration
- (E) Password reset by email from the sign-in screen
- (E) Block sign-in for accounts flagged `disabled` or `deleted`, and terminate the session when
  blocked
- (E) Sign out
- Human-readable auth error messages covering at minimum: email in use, wrong credentials, user not
  found, user disabled, too many requests, invalid email, and modern `invalid-credential`
- Route guard that redirects unauthenticated → sign-in and unverified → verification, with a real
  loading state

**Users, roles and permissions**

- (E) User profile record with: display name, email, permission (`read` | `readWrite`), role (`user`
  | `admin`), `disabled`, `deleted`
- (E) Admin console listing all non-deleted users with Name, Email, Permission, Role, Actions
- (E) Admin can change a user's permission between Read and Read & Write
- (E) Admin can change a user's role between User and Admin
- (E) Admin can disable / re-enable a user
- (E) Admin can delete a user (soft delete)
- (E) Admin search over users — by name **and** email
- (E) Read-only users see the whole estimate but cannot edit any field, and
  creation/duplication/deletion controls are hidden
- (E) **Server-side enforcement** of read vs read-write and admin (the legacy app has none)
- Confirmation before destructive admin actions
- Admin console reachable only by admins

**Proposal lifecycle actions surfaced in the shell**

- (E) Create proposal (from the side navigation)
- (E) Manage-proposals dialog with search, duplicate and delete per proposal
- (E) Duplicate proposal → copies proposal, preferences, all WBS, all phases, all activities, with
  all parent ids remapped
- (E) Duplicate revision numbering: next free `base + 0.1`-style decimal; description gets
  `" - Rev N"` with any existing suffix stripped first; must not break past the 9th revision
- (E) Delete proposal → cascade-delete WBS, phases **and** activities (the legacy version orphans
  phases), with a typed/explicit confirmation
- (E) Per-proposal dataset versioning (`labor`, `phases`, `wbs`, `equipment` each pinned to a
  version), defaulting new proposals to the current version and falling back to the newest available
  bundle

**Export / reporting**

- (E) A "WBS Cost Report" export producing an .xlsx file
- (E) Native save dialog with a default filename of `{proposalNumber}-WBS-Cost-Report.xlsx`
- (E) Report header block: Proposal #, Job #, **Change #** (currently broken), Description, Owner,
  Location (`City, State`), Date (generation date)
- (E) Two markup rows echoing all 15 proposal rates positioned under their matching cost columns:
  rig rate and use-tax rate above the header; weld base, craft base, burden, overhead, labor profit,
  fuel, consumables, subsistence, rig profit, material profit, equipment profit, sub profit, sales
  tax below it, plus the `(no tax or mu)` annotation over the Cost-Only column
- (E) The 37-column row shape: WBS, PHASE, SIZE, FLC, LINE/DESCRIP, SPEC, INSUL, INSL. SIZE, SHT,
  AREA, STATUS, SYS, SPCL RATE, SPCL SUB, OWNERSHIP, QTY, UNIT, CRAFT, WELD, SUB, TOTAL(MH), BASE,
  BURDEN, OVERHEAD, LABOR PROFIT, FUEL, CNSMBLE, SUBSIST, LABOR, RIGS, MATERIAL, EQUIP, SUBS, COST
  ONLY, PROFIT TOTAL (R/M/E/S), SALES TAX, TOTAL
- (E) Three-level indented row structure — WBS rollup row, phase rollup rows, activity detail rows —
  followed by a grand-total row
- (E) Activity rows inherit
  `phase number, size, flc, spec, insulation, insulation size, sheet, area, status, sys` from their
  parent phase
- (E) Activities ordered by `sortOrder` within a phase; phases ordered by `phaseNumber`; WBS ordered
  by `wbsDatabaseId`
- (E) Export scoped to the WBS selected in the proposal's display preferences, skipping WBS with no
  phases — **with a visible warning about what was excluded**
- (E) Phase quantity/unit resolution: `customQuantity` → keyword-derived quantity; `customUnit` →
  `unit` → keyword-derived unit (keyword map: 20000 `EXCAVATE`/`BACKFILL / COMPACT`;
  40000/50000/60000 `CLEAN UP`; 70000/130000 `HE`)
- (E) Exact per-activity cost math reproduced (base, burden, overhead, labor profit, fuel,
  consumables, subsistence, labor, rig, material, equipment, subcontractor, cost-only, profit total,
  sales tax, total) — see §4.3
- (E) Owned-equipment special case: no profit applied and line total = equipment cost only
- (E) Currency values rounded to 2 decimals; zero/blank currency cells rendered as `-`
- (E) Accounting number formats on currency columns and 2-dp formats on quantity/man-hour columns
- (E) Visual hierarchy: WBS rows 14pt bold on light blue, phase rows 12pt bold on light yellow,
  activity rows 10pt, total row 14pt bold on light green with medium rules
- (E) Section-grouping right-hand rules after SYS, OWNERSHIP, TOTAL(MH), SUBSIST, SUBS, COST ONLY,
  SALES TAX
- (E) Boxed-cell highlight on activities carrying a special craft rate or special subsistence rate
- (E) Column widths and header row heights tuned for printing (55-wide description column, 5-row
  print-title block in the original)
- Named worksheet (not `readme demo`)
- Progress indication and a cancel path during export; a real error message on failure
- Consider: emit live formulas rather than static values, so the workbook remains usable downstream
- Consider: grid-level CSV/Excel export (the legacy grids deliberately have none)

**Data model / storage requirements implied by this area**

- (E) Per-proposal display preferences (which WBS are shown) — keyed more robustly than by WBS
  _name_
- (E) Per-user, per-phase activity column-visibility persistence
- (E) Per-grid sort/filter/density persistence
- (E) Uppercase normalisation of text values on write, with an explicit numeric-field exclusion list
  (`quantity, craftConstant, welderConstant, craftManHours, welderManHours, craftCost, welderCost, totalCost, craftBaseRate, subsistenceRate, equipmentCost, materialCost, costOnlyCost, price, time, subContractorCost`)
  and an opt-out for name/free-text fields

**Keyboard / grid interaction (cross-cutting)**

- (E) Excel-style grid keyboard model: Enter = commit + move down (Shift+Enter = up), Tab = commit +
  move right (Shift+Tab = left), F2 = toggle edit, Escape = discard, Delete = clear in place,
  Backspace = clear and edit, printable key = type-to-replace, double-click = edit with caret at
  click point, click-away = commit without stealing focus
- (E) Navigation skips non-editable columns and wraps at row ends
- Application-level keyboard shortcuts (the legacy app has none): command palette, save, new
  proposal, jump-to-WBS/phase

**Desktop / packaging**

- (E) Desktop app with a single main window, correct product name and window title
- (E) Native file-save dialog for exports
- (E) Auto-update with signed release artifacts and an update prompt
- (E) Tagged-release CI that builds, signs, publishes and updates the update manifest
- Builds for macOS in addition to Windows (the legacy pipeline is Windows-only)
- Code-signed / notarised installers (the legacy ones are unsigned)
- A least-privilege capability allowlist and a real CSP (legacy grants the entire API surface with
  `csp: null`)
- Signing keys held in CI secrets only — never in the repository
- Update manifest served from real infrastructure rather than a public gist
- Window size/position persistence

**Cross-cutting quality gaps to close (not parity, but explicitly required by the quality bar)**

- Single shared session/permission context instead of eight independent profile fetches
- Error boundary + toast/notification system instead of `console.error`
- Optimistic UI with rollback on write failure
- Concurrent-edit awareness (the legacy app silently last-writer-wins)
- No forged third-party licences
