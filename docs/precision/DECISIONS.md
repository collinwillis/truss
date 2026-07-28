# Precision — Decision Record

Decisions that change what number Precision reports, or that a future reader would otherwise
re-litigate. Each entry states the decision, the evidence, and what would justify revisiting it.

Milestone plan: [`audit/ROADMAP.md`](./audit/ROADMAP.md). Audit reports: [`audit/`](./audit/).

---

## D0 — The legacy engine of record is `totals.ts`, not `calculations.ts`

**Status:** settled (M0)

`mcp_estimator/src/utils/calculations.ts` has **zero importers** and carries a _different_ welder
formula from the code that actually runs. The live legacy engine is
`mcp_estimator/src/api/totals.ts` plus `calculateActivityData()` in
`mcp_estimator/src/api/activity.ts`.

Two independent audit passes read the dead file, concluded that `computeWelderLoadedRate` wrongly
omitted `rigProfitRate`, and scheduled that "fix" first. It is not a bug. `rigProfitRate` multiplies
the rig leg only; it is absent from the base markup in the live engine, and Precision matches it.
Applying the proposed fix would have overstated **every welder hour** by
`weldBaseRate × rigProfitRate / 100` — $4.07/hr on proposal 2020.

Locked by `costEngine.test.ts` → _"welder loaded rate — rigProfitRate applies to the rig leg only"_,
which asserts the correct value **and** pins the $4.07 delta the wrong version would introduce.

**Also not reference material:** `work_log_items_library.txt` and `timesheet_*.txt` at the legacy
repo root. They self-describe as a phrase library for filling in billing timesheets and contain
invented entries — including one describing a welder/rig-profit calculation bug that never existed.
Mining them hallucinates defects.

**Genuinely useful and previously dismissed:** the four root `*.sql` files are a prior design pass
containing decisions nobody carried forward (`proposal_snapshots`, `proposal_status_history`,
`audit_log`, per-activity `notes`, `custom_weld_rate`, `equipment_time_unit`). Treat as a wish list.
Trap: `calculate_work_item_cost()` in `universal_supabase_schema.sql` is a _third_ cost formula with
no authority — never validate against it.

---

## D2 — Full-precision arithmetic; round only at the display boundary

**Status:** settled (M0) · introduced at `CALC_VERSION` 2 (current value is 3 — see D3)

Legacy rounds **nowhere**. Precision previously rounded at nine points, including man-hours _before_
costing. Man-hours are themselves displayed and reported, so that produced a visible divergence from
legacy independent of any cost difference — and it would have made parallel-run validation at M11
unclosable, with days lost to deltas that were not bugs.

The engine now rounds nothing. `round2` / `roundCosts` are display helpers, applied once where
numbers leave the server. Rollups accumulate raw, so a WBS total cannot drift from the sum of its
phases.

Operation order is part of the contract: callers compute `(base × percent) / 100`, never
`base × (percent / 100)`. Those differ in the last bits of IEEE-754, and legacy uses the former. The
parity suite asserts **exact** equality, so a "harmless" refactor of that expression will fail the
build. That is intentional.

`CALC_VERSION` is stamped so a future formula correction can apply to new estimates without silently
re-pricing bids that were already submitted.

**Caveat pinned in the tests:** `round2` follows the float, not the decimal literal.
`round2(1.005) === 1` because `1.005 * 100` is `100.49999999999999`, while `round2(2.675) === 2.68`
because `2.675 * 100` is exactly `267.5`. This is acceptable for a display helper over derived
costs. If a report ever needs banker's rounding or decimal-exact currency, add a separate function —
every pinned golden value depends on this one.

---

## D3 — Absence inherits; a rate override of `0` means $0.00/hr

**Status:** settled (M0) · `CALC_VERSION = 3` · **the one deliberate divergence from legacy**

The question was framed as "does a typed `0` mean $0/hr or inherit?". Both answers are wrong,
because the field was being asked to carry two meanings in one number.

Legacy chose "inherit": it composed `??` at the model layer (`calculateActivityData:514`) with `||`
at the rate layer (`getCraftLoadedRate:26`), so a stored `0` fell through to the proposal rate. The
cost of that is real — **legacy cannot express "labor on this line is free"**, which is a genuine
situation: warranty rework, donated labor, or labor carried on another line. The estimator's only
recourse is a workaround.

A sentinel inside the valid data range is the anti-pattern. "Inherit" is a distinct state, so it
gets a distinct representation:

| Stored value                  | Meaning                        |
| ----------------------------- | ------------------------------ |
| absent (`null` / `undefined`) | inherit the proposal rate      |
| `0`                           | a real override worth $0.00/hr |
| any other number              | that rate                      |

This is how every override UI worth copying behaves — the field renders the inherited value as a
placeholder, typing replaces it, and an explicit reset returns it to inherited. The user never has
to know a magic number.

**Safe to adopt now:** `sync/fieldMapping.ts` only stores an override when the source value is
non-zero, so no stored zero exists across the 713 production proposals. Nothing re-prices.

**Contract the M4 override columns must honour** — the decision is only half-made until the UI
carries it:

- render the inherited proposal rate as a placeholder, visually distinct from a typed value, so
  "inherited" is never something the user has to guess at;
- an explicit reset (clearing the field) writes `null`, never `0`;
- the mutation arg must be `v.union(v.number(), v.null())`, so "clear the override" is
  distinguishable from "leave this field alone". `v.optional(v.number())` cannot express that.

**How the tests handle the divergence:** `0` is excluded from the `OVERRIDES` array the parity suite
iterates, and gets a dedicated test — _"a rate override of 0 means $0.00/hr, diverging from legacy
on purpose"_ — which pins **both** engines' answers so the difference stays visible. Divergence is
asserted, never assumed.

---

## D-sub — Legacy stores subcontractor labor in the activity's `craftCost` field

**Status:** settled (M0) — verified, no change needed

`getSubcontractorCost` reads the activity's raw `craftCost` / `materialCost` / `equipmentCost`. That
works because those fields are only overwritten for non-subcontractor types, so on a sub row they
retain their stored input values. `sync/fieldMapping.ts` maps
`fs.craftCost → subcontractor.laborCost`, preserving the semantics under an honest name. **The
mapping is correct.**

Two legacy behaviours that look like bugs are load-bearing and are locked by tests:

1. Welder cost accrues on **every** type including subcontractor. It is excluded from a sub line's
   total, but still counts toward man-hour rollups.
2. A subcontractor line's total is its subcontractor cost **alone**, not the sum of components.
   Every other type sums all six.

**Known latent gap:** Precision's schema omits `labor` entirely on subcontractor rows, so a sub row
cannot carry craft/welder constants the way a legacy row could. Zero of 109 production sub rows do,
so nothing diverges today — but the model cannot express the behaviour the engine implements.
Resolve before any UI lets a sub row take a welder constant.

---

## Corrections to the audit's stated facts

Measured directly rather than inferred. The roadmap should be read with these applied.

| Claim in the audit                                                       | Measured                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Convex read ceiling is 16,384 docs (reports disagreed: 16,384 vs 32,000) | **4,096 `ctx.db.get()` calls in one execution throws.** Indexed `.collect()` of ~4,300 docs did not. Sizing for M7 must be re-measured against the real limit, not either figure in the reports.                   |
| `activity.wbsId` corruption is "unbounded across 713 proposals"          | **Sparse, not systemic.** 0 mismatches in 2,323 activities across 6 proposals. Proposal 2042 confirmed at exactly 4 of 680 — CHANGE TRAILER, TOOL TRAILER, EQUIPMENT, TOOLS, all labor rows copied between phases. |
| Precision has 27–28 app-level TS errors                                  | **28** — but only after adding `@types/node`. Without it the raw count is 54, the extra 26 being `process` not found in backend sources the app type-checks through JIT package resolution.                        |
| Momentum type-checks clean                                               | **False.** 3 errors (`assign-member-dialog.tsx` ×2, `main.tsx` ×1). The production app has never been type-checked either.                                                                                         |

**Not previously reported:** `syncEngine.startSync` scheduled `processOneProposal` with
`proposalFsId: undefined` when the first Firestore page came back empty, which fails the arg
validator at runtime and strands the job as "running" forever. Fixed in M0. This is the full-tree
sync that M11's one-time migration depends on.

---

## D1 — Detach-on-edit: the first Precision write takes ownership of an estimate

**Status:** settled · **rejects the roadmap's recommendation, deliberately**

The Firestore→Convex sync is a **one-way mirror** of the MCP Estimator, and it patched blindly. Two
paths destroyed user work with no error and no warning:

| Path                                    | What it reverted                       | When                                                          |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `syncMutations.upsertProposalsBatch`    | proposal metadata **and all 15 rates** | every 6 hours, on cron                                        |
| `syncMutations.upsertProposalHierarchy` | the whole WBS/phase/activity tree      | whenever anyone created a Momentum project from that proposal |

So an estimator could set rates in Precision, come back after lunch, and find the estimator's values
silently restored. Everything downstream of this — the rates workbench, estimate settings, the
activity grid — was theatre until it was fixed.

**The rule:** `proposals.precisionOwnedAt` (optional timestamp). The first Precision write to an
estimate's tree stamps it, and the sync skips that record from then on. Absent means "still
mirroring from the estimator". Copy-on-write, the same model as a Figma component override or a git
fork.

**Why the roadmap's recommendation was rejected.** It proposed that legacy-origin proposals render
**read-only** with a banner, plus an admin "Take ownership" action. But **all 713 production
proposals are legacy-origin, and 0 are native** — so that rule makes the entire application
read-only, and gates every edit behind an admin ceremony. Detach-on-edit gives zero-friction editing
with zero data loss and needs no ceremony at all.

**Design details that matter:**

- The claim happens **after validation, before the first write**, so a mutation that throws does not
  detach an estimate it never modified.
- `upsertProposalHierarchy` returns **before any write** when it sees ownership. A partial sync
  would leave an estimate half-reverted, which is worse than either clean outcome.
- `upsertProposalsBatch` skips **per proposal** rather than aborting the batch — one owned estimate
  must not stop the other ~622 from staying current.
- `createProjectFromProposal` does not re-pull from Firestore for an owned estimate; it snapshots
  what is in Convex, because Precision is the source of truth for that estimate. This is also the
  direction of the eventual cutover.
- A duplicate is a native estimate: stamped at creation, and it must **not** carry the source's
  `firestoreId`, or the sync would match the copy to the original and overwrite it.

**Escape hatch, deliberately manual:** clearing `precisionOwnedAt` re-attaches the estimate to the
mirror and the next sync overwrites local edits. That is a destructive admin action and should stay
one — it must never be automatic.

**Still to build:** the UI indicator. The queries now return the field so a later change can show
"mirroring from MCP Estimator" versus "edited in Precision — no longer syncing". Until that lands,
the behaviour is correct but invisible, and a user cannot tell which state an estimate is in.

---

## D6 — Per-activity rate overrides are restricted, and the restriction is real policy

**Status:** settled · confirmed by Collin as intentional business policy

An activity may override the proposal's `craftBaseRate` / `subsistenceRate` only when **any** of:

| Condition                 | What it is                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `type === "custom_labor"` | a hand-entered line — the estimator is already specifying the work, so they specify the rate |
| WBS pool `200000`         | **SUPPORT**                                                                                  |
| phase pool `180002`       | **FIREWATCH**                                                                                |
| phase pool `180003`       | **MANWATCH**                                                                                 |
| phase pool `180004`       | **TOOLS & EQUIPMENT RUNNER**                                                                 |

The rule reads as three arbitrary conditions until the pool ids are resolved to names. Then it is
obvious: **every eligible case is a labor-standby or support role paid at a different rate than a
pipefitter.** You override the craft base rate precisely when the body doing the work isn't craft.
That coherence is what corroborates the answer — this is not accumulated accident.

It is an **OR**, and the set of three phase pools is **not a range**. Neighbouring specialty pools
(`180000` SPECIALTY SERVICES itself, `180001`, `180005`, `189999`) are ineligible, and a test pins
that so nobody "helpfully" widens it later.

**Eligibility is positional.** The type is the activity's own, but the other two conditions come
from its phase and its WBS — so moving an activity between phases can change whether its override is
legal. The mutation therefore re-derives eligibility from the **stored** position rather than
trusting anything the caller sends.

**Now enforced server-side, which it never was.** Legacy implemented this rule twice, both times in
React — `activity_data_grid.tsx:552` and `edit_base_rate_dialog.tsx:46` — and never on the write
path. The restriction was advisory: any client could set an override on an ineligible line and
legacy would happily price it. It now lives in one tested predicate
(`convex/model/rateOverrides.ts`) called by both `updateActivity` and `getActivitiesWithCosts`, so
the grid renders exactly the answer the mutation will enforce.

**One legacy check deliberately NOT moved to the server:** legacy also required a multi-select to
share the same current base rate before opening the override dialog. That is a UI affordance — the
dialog shows one input and needs one value to seed it — not a data constraint. The server has no
business knowing how many rows a user selected, so `shareSameOverrideBasis` is exported for the grid
and enforced in no mutation.

**Interacts with D3:** an inherited row and a row explicitly overridden to `0` are different states,
and the shared-basis check must not collapse them. Pinned by test.

---

## D-orgauthz — The server, not React, decides who may administer an organization

**Status:** settled · **corrects an earlier claim in this document's history**

Every function behind Admin → Members was enforced only in the client. An audit of `adminUsers.ts`
and `appPermissions.ts` found that **not one verified the caller may administer the organization**:

| Function                  | What it checked                  |
| ------------------------- | -------------------------------- |
| `listOrganizationMembers` | nothing                          |
| `getMemberDetail`         | nothing                          |
| `updateMemberRole`        | authenticated + target-not-owner |
| `banMember`               | authenticated + target-not-owner |
| `unbanMember`             | authenticated                    |
| `removeMember`            | authenticated + target-not-owner |
| `setPermission`           | nothing                          |

So any authenticated account could read the full roster with names and emails, ban or remove
colleagues, change roles, and — through `setPermission` — grant **itself** `admin` on either
application. The target-not-owner checks bounded the blast radius to non-owners; they were never
authorization.

**An earlier note in this session claimed `adminUsers.ts` "does this correctly" and that
`setPermission` was "the outlier rather than the pattern." That was wrong.** `setPermission` was the
worst case, not the exception — the whole surface was unguarded. Recording the correction because
the original claim would have made a future reader skip the audit.

**The rule:** authorization is evaluated against the **record being changed**, not the caller's
active organization. `requireOrgAdminForMember(ctx, memberId)` resolves the target's membership
first, then requires the caller to be an `owner`/`admin` _of that same organization_. Checking
against the caller's own active org would look correct and be wrong — an admin of org A could act on
a member of org B by passing that member's id.

**Failure messages deliberately do not distinguish** "not a member of this organization" from "a
member but not an admin". Separating them confirms an organization's existence, and the shape of its
membership, to an outsider.

**Owner rules are per-action, not blanket.** Banning, demoting, removing and changing app access are
refused against the owner; **unbanning is not**, because locking an owner out with no way back is
the failure mode that matters more.

**The one function that must stay open to everyone:** `getMemberPermissions` is called by
`WorkspaceProvider` for the current user on every session in **both** apps. Requiring org-admin
there would sign every non-admin out of Momentum and Precision entirely. It is guarded as "your own
permissions, or you are an org admin" — never admin-only.

**The UI keeps its own checks**, but only as affordance: a control you may not use should not look
usable. The UI is no longer what makes the rule true.

---

## D-wbsId — The phase owns the WBS relationship; no data migration needed

**Status:** settled (M0)

Legacy's `copyActivitiesFromPhaseToPhaseInFirestore` wrote only `phaseId` and carried `wbsId` over
from the _source_ activity, so any row copied across a WBS boundary permanently claims the wrong
one. `sync/fieldMapping.ts` imported that verbatim. It matters more in Precision than it did in
legacy because the rollups group by different keys — the WBS table and the direct/indirect split use
`activity.wbsId`, while the phase drill-down and the Excel export group by phase. Four surfaces,
three answers, no error raised.

**Rule: an activity's WBS is always derived from its phase, never from its own `wbsId`.** Applied at
both write paths:

- `sync/syncMutations.ts` resolves `wbsId` from `phaseWbsMap` and logs a per-proposal correction
  count.
- `momentum.ts::snapshotProposalIntoProject` does the same when creating a Momentum project, so a
  snapshot is internally consistent **even if the source proposal still carries the corrupted
  value**.

**No repair migration was run, and none is needed.** The second fix is what makes that true: the
only consumer that could propagate a bad value into new data now derives correctly, and Precision's
own rollups will agree once a proposal is re-synced. M11's full-tree migration sweeps the rest. At
the measured rate — 4 rows in proposal 2042, 0 in 2,323 activities elsewhere — writing to 713
production proposals was not justified.

⚠️ **Production-visible for Momentum:** a project created from an affected proposal will now group
those activities under the phase's WBS instead of the activity's stale one. That is the correct
grouping and existing projects are untouched, but it is a behavioural change to a released app and
should be called out in the release notes rather than shipped silently.

---

## D-auth — Sign-up is gated to approved email domains

**Status:** settled (M0) · email verification deliberately **not** required

Sign-up was open to the internet: `emailAndPassword.enabled` with `autoSignIn: true` and no gate
meant anyone who found the endpoint could create an account and land inside the InDemand workspace
and its 700+ real bids.

Closed with a `databaseHooks.user.create.before` hook that rejects disallowed domains. **Every**
path that creates a user runs this hook — email/password and every social provider — so there is no
second door to remember to lock.

**Verified against production before enforcing** — and the first pass read the wrong table, which is
worth recording.

An initial check of the app's `users` table reported 23 accounts (22 `@indemandis.com`, 1
`@outlook.com`). **That table is not the auth system.** It carries
`externalId // Firebase/Clerk UID` and `firestoreId` — it is the MCP Estimator's user list, synced
from Firestore, and nothing signs in with it. `adminUsers.ts` reads through
`components.betterAuth.adapter`, so the real accounts live in the Better Auth component.

The actual login-capable accounts, read from a snapshot export:

| Domain             | Count |
| ------------------ | ----- |
| `indemandis.com`   | 5     |
| `collinwillis.dev` | 1     |
| `testuser.com`     | 1     |

All 7 have `emailVerified: false` (consistent with verification being off) and none are banned. Org
side: 6 memberships — 1 owner, 3 admin, 2 member.

**Nobody is locked out**, because the hook fires on user _creation_ only: all 7 sign in untouched,
including the two on non-company domains. The gate stops new strangers, not current users. Two
things it surfaced:

- **A `@testuser.com` account exists in production** with valid credentials against 713 real bids.
  It has no org membership, so it lands in an empty workspace — mild containment, not a control.
  Delete it. It is also precisely what this gate now prevents.
- **`user` (7) exceeds `member` (6)** — the test account is the orphan. Per the comment on
  `authComponent.triggers.user.onCreate`, a user without membership falls into the "personal
  workspace" branch and sees a blank Admin → Members page.

If the `collinwillis.dev` account should be able to _re-create_ itself later, add that domain to
`ALLOWED_SIGNUP_DOMAINS`. Leaving it out is the tighter default; an invite flow (M10) is a better
long-term answer than widening the list.

Configured via `ALLOWED_SIGNUP_DOMAINS` (comma-separated Convex env var, default `indemandis.com`),
declared in `turbo.json` so the undeclared-env-var lint rule stays satisfied.

**Why config rather than the organization's `allowedDomains` field:** that field exists on the org
schema and is read by nothing. Resolving it would put a database lookup on the sign-up path _before_
we know which org the user belongs to. With a single tenant, config is simpler and more robust.
Revisit when M10 makes multi-tenancy real.

**Two corrections to the audit here.** The claim that "nothing checks the Better Auth ban flag" is
**false** — the `admin` plugin blocks banned users natively
(`better-auth/dist/plugins/admin/admin.mjs:37-52` throws `BANNED_USER`), and the plugin is
configured. And `allowedDomains` at `auth.ts:212` was described as needing enforcement; it is an
organization _schema field_, not a config option, which is why enforcement is a hook rather than a
flag flip.

**Email verification stays off**, by decision. A domain gate plus admin-managed accounts is adequate
for a 23-person internal tool, and requiring verification adds a failure mode (undelivered mail) to
every new hire's first day.

**This is a floor, not the access model.** Invitation-only is the correct end state and is M10 work,
alongside the real gap: `ctx.auth` appears **zero** times across all 30 functions in `precision.ts`
_and_ all of `momentum.ts`. Authentication is now gated; **authorization is still absent in both
apps.**

---

## Deferred deliberately

- **Closing the signup hole.** `requireEmailVerification: false` + `autoSignIn: true`, an unenforced
  `allowedDomains`, and no ban check. Not flipped unilaterally: it changes live auth for an app in
  production use, `allowedDomains` is an organization _schema field_ rather than a config flag
  (enforcement needs a new signup hook), and the domain list is Collin's call.
