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

**Status:** settled (M0) · `CALC_VERSION = 2`

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

## D3 — A per-activity rate override of `0` means "inherit", not "$0/hr"

**Status:** implemented legacy-faithful (M0) · **needs Collin's confirmation before M4**

Legacy composes `??` at the model layer (`calculateActivityData:514`) with `||` at the rate layer
(`getCraftLoadedRate:26`), so a stored `0` falls through to the proposal rate. Precision previously
used `??` throughout, making `0` mean literally zero dollars per hour.

Implemented to match legacy, because M0's purpose is provable parity and matching exactly is what
lets the suite assert equality across the whole input space rather than only over inputs that happen
to occur.

**Unreachable on current data:** `sync/fieldMapping.ts` only stores an override when the source
value is non-zero, so no zero override exists in the 713 production proposals. It becomes reachable
the moment M4 ships editable override columns.

**The open question for Collin:** when an estimator types `0` into a craft base rate override, do
they mean "this line is free" or "use the proposal default"? Legacy trained them on the latter. If
the answer is "$0/hr", change `resolveRateOverride` in `costEngine.ts` and bump `CALC_VERSION`; the
test _"a rate override of 0 inherits the proposal rate"_ is the tripwire.

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

## Deferred deliberately

- **Closing the signup hole.** `requireEmailVerification: false` + `autoSignIn: true`, an unenforced
  `allowedDomains`, and no ban check. Not flipped unilaterally: it changes live auth for an app in
  production use, `allowedDomains` is an organization _schema field_ rather than a config flag
  (enforcement needs a new signup hook), and the domain list is Collin's call.
