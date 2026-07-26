# Runbook — Move production onto the real prod deployment

**Status:** not yet scheduled · **Owner:** Collin · **Window needed:** ~2 hours, out of hours

Moves live InDemand data off a personal _dev_ deployment and onto the project's actual production
deployment, so `convex dev` stops writing to production and `npx convex deploy` stops pointing at an
empty database.

---

## 0. The situation

|                     | Deployment                                | Role in Convex | Reality today                                                                                                              |
| ------------------- | ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `focused-civet-250` | `dev:` (Collin's personal dev deployment) | development    | **All production data.** 713 proposals, 21 Momentum projects, 23 user accounts. Every shipped Momentum client talks to it. |
| `good-whale-838`    | `prod:`                                   | production     | **Completely empty** — zero tables. Nothing points at it.                                                                  |

Two consequences, both live right now:

1. `npx convex deploy` — the documented command, the one CI would use — pushes to `good-whale-838`,
   where it has no effect on anything real. A fix deployed that way looks applied and isn't.
2. `bun run dev:backend` runs `convex dev` in watch mode against `focused-civet-250`, which means
   **local edits stream straight into production data**. There is no safe place to test a backend
   change.

---

## 1. What makes this non-trivial

The deployment URL is **compiled into every desktop binary at build time**.
`apps/momentum/src/main.tsx:24` reads `import.meta.env.VITE_CONVEX_URL`, and
`.github/workflows/release-desktop.yml:230` injects it from the `PRODUCTION_CONVEX_URL` GitHub
secret. Every Momentum install at InDemand has the old URL burned in.

So this is **a coordinated release, not a config change**. There is no server-side switch.

Two things make it tractable right now, and both get worse with time:

- Momentum has a working auto-updater (`apps/momentum/src-tauri/tauri.conf.json:56`,
  `createUpdaterArtifacts: true`), so rollout is push-based.
- Precision has **no** updater yet and is not released. Once it ships to anyone, this becomes two
  coordinated releases instead of one. **Do this before Precision goes out.**

---

## 2. Verify before scheduling

Three unknowns. Answer all three before picking a date — each is a mid-cutover showstopper.

### 2.1 ⚠️ Does the snapshot export include **component** data?

**This is the one that can ruin the cutover.** Better Auth stores users, sessions, organizations,
members and password hashes inside a Convex _component_ (`components.betterAuth`), not in the app's
own tables. `convex import` has a separate `--component <path>` flag, which strongly implies
component data is handled separately from a plain snapshot.

If a snapshot export does not carry component data, then importing it gives you all 713 proposals
and **zero user accounts** — nobody can log in, and the app looks bricked.

**Rehearse this.** Export from dev, import into a throwaway preview deployment, and confirm the user
table arrives:

```bash
npx convex export --path /tmp/rehearsal.zip
unzip -l /tmp/rehearsal.zip | grep -i "user\|betterAuth\|component"
```

If components are absent, the cutover needs a separate migration path for auth data — plan for that
before booking a window, not during one.

### 2.2 What is `PRODUCTION_CONVEX_URL` actually set to?

Read it in GitHub → Settings → Secrets. It is almost certainly `focused-civet-250` (the shipped app
reads that data, so it must be), but confirm rather than infer — this is the value the whole rollout
hinges on. Same for `PRODUCTION_CONVEX_SITE_URL`.

### 2.3 Where does `BETTER_AUTH_SECRET` come from?

It appears in `turbo.json`'s env lists but in **no** `process.env` read under
`packages/backend/convex/`. Find out whether Better Auth reads it from the Convex deployment env or
somewhere else. If it differs between deployments, tokens minted by the old one are invalid on the
new one.

---

## 3. Pre-flight — do this days ahead, zero risk

Nothing here affects live users.

**3.1 Copy environment variables to prod.** The backend reads eleven, plus `BETTER_AUTH_SECRET`
(§2.3):

```
ALLOWED_SIGNUP_DOMAINS   FIREBASE_API_KEY        FIREBASE_AUTH_EMAIL
FIREBASE_AUTH_PASSWORD   GITHUB_CLIENT_ID        GITHUB_CLIENT_SECRET
GOOGLE_CLIENT_ID         GOOGLE_CLIENT_SECRET    MIGRATION_SECRET
RESEND_API_KEY           SITE_URL
```

```bash
cd packages/backend
npx convex env list                    # source (dev — no flag needed, see §8)
npx convex env set NAME value --prod   # target, one per variable
npx convex env list --prod             # confirm all twelve
```

**3.2 Update the OAuth provider callback URLs.** GitHub and Google OAuth apps have the deployment's
`.convex.site` URL registered as a redirect target. Add `good-whale-838`'s alongside the existing
one — adding is non-breaking, so do it now and remove the old one after cutover.

**3.3 Deploy the code to prod.** Safe: it is an empty deployment.

```bash
cd packages/backend && npx convex deploy
```

**3.4 Rehearse the export/import** per §2.1 against a preview deployment. Time it — the duration of
the real export tells you how long the freeze window has to be.

---

## 4. Cutover

Order matters. Data must land before clients are repointed, or the app hits an empty database.

**4.1 Announce a freeze.** Everyone closes Momentum. Nothing writes from here until step 4.6.

**4.2 Disable the cron** so the 6-hourly Firestore sync cannot write mid-copy. Comment out the
`crons.interval("proposals-sync", ...)` line in `packages/backend/convex/crons.ts`, then
`npx convex dev --once`. Re-enable in 4.7.

**4.3 Capture a baseline** so the import can be verified against something. Run
`packages/backend/convex/model/__tests__/`-style counts, or use the dashboard's table view.
Reference values as of 2026-07-26 — **re-capture on the day, these will have moved**:

| Table              | Count                                       |
| ------------------ | ------------------------------------------- |
| `proposals`        | 713                                         |
| `momentumProjects` | 21                                          |
| `momentumWbs`      | 396                                         |
| `momentumPhases`   | 670                                         |
| Better Auth users  | 23 (22 `@indemandis.com`, 1 `@outlook.com`) |

**4.4 Export.** Note there is **no `--prod` flag** here — the source is the dev deployment:

```bash
cd packages/backend
npx convex export --path ~/truss-cutover-$(date +%Y%m%d).zip --include-file-storage
```

Keep this file. It is also the rollback artifact.

**4.5 Import into prod:**

```bash
npx convex import ~/truss-cutover-YYYYMMDD.zip --replace-all --prod
```

`--replace-all` is correct for a full-deployment restore: it clears tables not present in the
archive. It is safe here only because prod is empty — never run it against a populated deployment
without a fresh export in hand.

**4.6 Verify before repointing anyone** — see §5. Do not proceed on a mismatch.

**4.7 Re-enable the cron** and redeploy: uncomment `crons.interval(...)`, then `npx convex deploy`.

**4.8 Repoint the clients.** Update the GitHub secrets `PRODUCTION_CONVEX_URL` →
`https://good-whale-838.convex.cloud` and `PRODUCTION_CONVEX_SITE_URL` →
`https://good-whale-838.convex.site`. Then cut a release:

```bash
git tag momentum-v0.1.13 && git push origin momentum-v0.1.13
```

**4.9 Confirm the rollout.** The updater only checks **on app launch** — a user who leaves Momentum
open will not update. "Quit and reopen Momentum" is a step in the announcement, not an afterthought.
Confirm with each user, or watch the old deployment's logs go quiet.

**4.10 Tell everyone they will sign in again.** Sessions do not survive the move. Password hashes do
(they travel with the user records), so credentials still work — but the prompt will surprise people
who were not warned.

---

## 5. Verification

Run against `good-whale-838` before repointing any client.

- [ ] Row counts match the 4.3 baseline **exactly**, table by table. Any shortfall means a partial
      import — stop.
- [ ] **User accounts exist**, all 23, including `collin.willis@outlook.com`. This is the §2.1
      failure mode; check it first.
- [ ] Organization + memberships exist. A user with no membership lands in the "personal workspace"
      branch and sees a blank Admin → Members page.
- [ ] Open a Momentum project and check total man-hours against the same project on the old
      deployment. Costs are computed on read, so any discrepancy means missing rows, not arithmetic.
- [ ] Open a Precision estimate and check the proposal total the same way.
- [ ] `npx convex env list --prod` shows all twelve variables.
- [ ] Sign-up from a non-`indemandis.com` address is rejected; sign-in as an existing user works.
- [ ] `npx convex logs --prod` is clean.

---

## 6. Rollback

Cheap until step 4.8, and that is where the decision point is.

- **Before 4.8** (clients still point at the old deployment): change nothing. Production never
  moved. Re-enable the cron, investigate, reschedule.
- **After 4.8:** revert the GitHub secrets, re-tag a release with the old URL, and push it. Any data
  written to `good-whale-838` in the interim must be reconciled by hand — which is the reason 4.9 is
  short and closely watched.

The old deployment is **not** wiped as part of this runbook. It stays intact as a live fallback
until §7, and that is deliberate.

---

## 7. After — the part that is easy to skip

The migration is not finished until the old deployment stops being production.

1. Leave `focused-civet-250` untouched for **at least a week** as a fallback.
2. Then reset it into an actual dev sandbox and seed it with **test** data. Until this happens,
   `bun run dev:backend` still writes to a database full of real bids — which is the problem this
   whole exercise exists to solve.
3. Update `apps/*/.env.local` for local development to point at the sandbox, not prod.
4. Remove the old deployment's callback URLs from the GitHub and Google OAuth apps.
5. Add a `deploy:backend:check` or a CI guard so nobody deploys to prod by accident from a feature
   branch.
6. Link this runbook from `DEPLOYMENT.md`, which CLAUDE.md designates as the single source of truth
   for deployment.

---

## 8. Command reference and traps

| Intent                                            | Command                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| Push code to **dev** (`focused-civet-250`)        | `npx convex dev --once`                              |
| Push code to **prod** (`good-whale-838`)          | `npx convex deploy`                                  |
| Watch mode → dev (**writes to production today**) | `npx convex dev` / `bun run dev:backend`             |
| Export from dev                                   | `npx convex export --path X.zip`                     |
| Export from prod                                  | `npx convex export --path X.zip --prod`              |
| Import to prod                                    | `npx convex import X.zip --replace-all --prod`       |
| Env vars, dev / prod                              | `npx convex env list` / `npx convex env list --prod` |

**Traps:**

- **Every Convex CLI command defaults to the _dev_ deployment.** Since dev is currently production,
  an omitted `--prod` is usually harmless and an accidental `--prod` usually does nothing. After the
  cutover this inverts, and an omitted flag starts hitting the sandbox. Re-read this table on the
  day.
- `convex deploy` prompts for confirmation when run interactively. It cannot prompt in CI or a
  non-interactive shell — it fails instead. Use `--yes` deliberately, never reflexively.
- `--replace-all` deletes tables absent from the archive. Correct for a restore, destructive
  anywhere else.
- The desktop auto-updater fires **on app launch only**.
