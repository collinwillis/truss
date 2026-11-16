/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Public functions that answered anyone, closed.
 *
 * The access map (docs/ACCESS.md) found public functions with no caller check
 * at all: the migration reads, which map Firestore ids to Convex ids and count
 * every estimate's activities, and the sync job reads, one of them a mutation.
 * The deployment URL ships inside both desktop bundles, so "public" meant
 * anyone on the internet.
 *
 * Each got the remedy its real caller allows:
 *
 *   - The migration scripts call through `ConvexHttpClient` with no session,
 *     so their reads take the migration secret, as the migration writes
 *     always did. A signed-in Owner without the secret is refused too: the
 *     secret is the authorization here, not the session.
 *   - What nothing outside Convex calls is internal.
 *
 * The last block sweeps every module the way `momentumGuardCoverage.test.ts`
 * sweeps `momentum.ts`, so the next unguarded export fails on the day it is
 * written instead of on the day somebody audits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import * as migration from "../convex/migration";
import * as syncMutations from "../convex/sync/syncMutations";
import * as syncQueries from "../convex/sync/syncQueries";
import { authHarness, seedOrganization, seedPrincipal, type Caller } from "./authFixtures";
import { ensureTestBook, type TestRunner } from "./convexFixtures";
import { RATES_2020 } from "./rates";

const SECRET = "test-migration-secret";
const REFUSED = "Unauthorized: invalid migration secret.";

/** Firestore ids of the one mirrored estimate every migration test reads. */
const FS = {
  proposal: "fs-proposal",
  wbs: "fs-wbs",
  phase: "fs-phase",
  activity: "fs-activity",
} as const;

interface Seeded {
  proposalId: Id<"proposals">;
  wbsId: Id<"wbs">;
  phaseId: Id<"phases">;
  jobId: Id<"migrationJobs">;
}

/** One mirrored proposal → WBS → phase → activity, plus a migration job. */
async function seedMirroredEstimate(t: TestRunner): Promise<Seeded> {
  return t.run(async (ctx) => {
    const bookId = await ensureTestBook(ctx);
    const proposalId = await ctx.db.insert("proposals", {
      firestoreId: FS.proposal,
      proposalNumber: "2020",
      description: "Tank 8 installation",
      ownerName: "Test Owner",
      rates: { ...RATES_2020 },
      datasetVersion: "v1",
      bookId,
    });
    const wbsId = await ctx.db.insert("wbs", {
      firestoreId: FS.wbs,
      proposalId,
      wbsPoolId: 10000,
      name: "WBS 10000",
      sortOrder: 1,
    });
    const phaseId = await ctx.db.insert("phases", {
      firestoreId: FS.phase,
      proposalId,
      wbsId,
      phasePoolId: 70001,
      poolName: "CARBON STEEL",
      phaseNumber: 1,
      description: "Phase 1",
      isCompleted: false,
      sortOrder: 1,
    });
    await ctx.db.insert("activities", {
      firestoreId: FS.activity,
      proposalId,
      wbsId,
      phaseId,
      type: "equipment",
      description: "Crane",
      quantity: 1,
      unit: "EA",
      sortOrder: 1,
    });
    const jobId = await ctx.db.insert("migrationJobs", {
      type: "seeded",
      status: "running",
      totalProposals: 1,
      completedProposals: 0,
      totalActivities: 1,
      patchedActivities: 0,
      skippedActivities: 0,
      errors: [],
      startedAt: 0,
    });
    return { proposalId, wbsId, phaseId, jobId };
  });
}

/** A secret-guarded function, called as `caller` with `secret`. */
interface SecretGuarded {
  name: string;
  call: (caller: Caller, secret: string, seeded: Seeded) => Promise<unknown>;
  /** What the script gets back with the right secret. */
  expected: (seeded: Seeded) => unknown;
}

const SECRET_GUARDED: readonly SecretGuarded[] = [
  {
    name: "resolveParentIds",
    call: (c, secret) =>
      c.query(api.migration.resolveParentIds, {
        secret,
        proposalFirestoreId: FS.proposal,
        wbsFirestoreId: FS.wbs,
        phaseFirestoreId: FS.phase,
      }),
    expected: (s) => ({ proposalId: s.proposalId, wbsId: s.wbsId, phaseId: s.phaseId }),
  },
  {
    name: "activityExistsByFirestoreId",
    call: (c, secret) =>
      c.query(api.migration.activityExistsByFirestoreId, { secret, firestoreId: FS.activity }),
    expected: () => true,
  },
  {
    name: "getActivityCountForProposal",
    call: (c, secret) =>
      c.query(api.migration.getActivityCountForProposal, {
        secret,
        proposalFirestoreId: FS.proposal,
      }),
    expected: (s) => ({ proposalId: s.proposalId, count: 1 }),
  },
  {
    name: "findMissingFirestoreIds",
    call: (c, secret) =>
      c.query(api.migration.findMissingFirestoreIds, {
        secret,
        firestoreIds: [FS.activity, "fs-not-mirrored"],
      }),
    expected: () => ["fs-not-mirrored"],
  },
  {
    name: "patchActivityBatch",
    call: (c, secret) =>
      c.mutation(api.migration.patchActivityBatch, {
        secret,
        patches: [{ firestoreId: FS.activity, unitPrice: 125 }],
      }),
    expected: () => ({ patched: 1, skipped: 0, errors: [] }),
  },
  {
    name: "insertMissingActivityBatch",
    call: (c, secret, s) =>
      c.mutation(api.migration.insertMissingActivityBatch, {
        secret,
        activities: [
          {
            firestoreId: "fs-new-activity",
            proposalId: s.proposalId,
            wbsId: s.wbsId,
            phaseId: s.phaseId,
            type: "material",
            description: "Pipe",
            quantity: 2,
            unit: "LF",
            sortOrder: 2,
          },
        ],
      }),
    expected: () => ({ inserted: 1, skipped: 0, errors: [] }),
  },
  {
    name: "createMigrationJob",
    call: (c, secret) =>
      c.mutation(api.migration.createMigrationJob, {
        secret,
        type: "fresh",
        totalProposals: 1,
        totalActivities: 1,
      }),
    expected: () => expect.any(String),
  },
  {
    name: "updateJobProgress",
    call: (c, secret, s) =>
      c.mutation(api.migration.updateJobProgress, {
        secret,
        jobId: s.jobId,
        completedProposals: 1,
        patchedActivities: 1,
        skippedActivities: 0,
      }),
    expected: () => null,
  },
  {
    name: "completeMigrationJob",
    call: (c, secret, s) =>
      c.mutation(api.migration.completeMigrationJob, {
        secret,
        jobId: s.jobId,
        status: "completed",
      }),
    expected: () => null,
  },
];

describe("migration functions take the migration secret", () => {
  let t: TestRunner;
  let seeded: Seeded;
  let member: Caller;
  let owner: Caller;

  beforeEach(async () => {
    vi.stubEnv("MIGRATION_SECRET", SECRET);
    t = authHarness();
    const organizationId = await seedOrganization(t, "acme");
    owner = (await seedPrincipal(t, { organizationId, role: "owner", email: "owner@acme.test" }))
      .as;
    member = (await seedPrincipal(t, { organizationId, role: "member", email: "m@acme.test" })).as;
    seeded = await seedMirroredEstimate(t);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each(SECRET_GUARDED)("$name", (fn) => {
    it("refuses an anonymous caller", async () => {
      await expect(fn.call(t, "guess", seeded)).rejects.toThrow(REFUSED);
    });

    it("refuses a signed-in member, and an Owner, without the secret", async () => {
      await expect(fn.call(member, "guess", seeded)).rejects.toThrow(REFUSED);
      await expect(fn.call(owner, "guess", seeded)).rejects.toThrow(REFUSED);
    });

    it("refuses everyone once the secret is unset on the deployment", async () => {
      vi.stubEnv("MIGRATION_SECRET", "");
      await expect(fn.call(t, "", seeded)).rejects.toThrow(REFUSED);
    });

    it("answers the script that holds the secret", async () => {
      expect(await fn.call(t, SECRET, seeded)).toEqual(fn.expected(seeded));
    });
  });
});

/** Only what is needed to read a registered function's visibility. */
interface Registered {
  isPublic?: boolean;
  isInternal?: boolean;
}

describe("reads nothing outside Convex calls are internal", () => {
  const INTERNAL: ReadonlyArray<[string, Registered]> = [
    ["migration.getMigrationStatus", migration.getMigrationStatus],
    ["migration.getActivitiesWithMissingData", migration.getActivitiesWithMissingData],
    ["sync/syncQueries.getLatestSyncJobs", syncQueries.getLatestSyncJobs],
    ["sync/syncQueries.getSyncJobErrors", syncQueries.getSyncJobErrors],
  ];

  it.each(INTERNAL)("%s cannot be called by a client", (_name, fn) => {
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).toBeUndefined();
  });

  it("drops the public sync mutation that only read", () => {
    expect("getLatestSyncJobs" in syncMutations).toBe(false);
  });

  it("still answers the dashboard and the CLI", async () => {
    const t = authHarness();
    const seeded = await seedMirroredEstimate(t);
    const syncJobId = await t.mutation(internal.sync.syncMutations.createSyncJob, {
      totalProposals: 3,
    });
    if (!syncJobId) throw new Error("expected a sync job");

    const jobs = await t.query(internal.migration.getMigrationStatus, {});
    expect(jobs.map((j) => j._id)).toEqual([seeded.jobId]);

    const missing = await t.query(internal.migration.getActivitiesWithMissingData, {
      proposalId: seeded.proposalId,
    });
    expect(missing.issues.map((i) => i.issue)).toEqual(["Missing unitPrice"]);

    const syncJobs = await t.query(internal.sync.syncQueries.getLatestSyncJobs, {});
    expect(syncJobs.map((j) => j._id)).toEqual([syncJobId]);

    const errors = await t.query(internal.sync.syncQueries.getSyncJobErrors, {
      jobId: syncJobId,
    });
    expect(errors).toEqual({ status: "running", errors: [] });
  });
});

// ============================================================================
// THE WHOLE BACKEND
// ============================================================================

// The two globs must match the same files; Vite only accepts literal patterns,
// so they are written out twice. The Better Auth component is excluded because
// component functions are not reachable from a client.

/** Every module's source, to find each public function's body. */
const SOURCES = import.meta.glob<string>(
  [
    "../convex/**/*.ts",
    "!../convex/_generated/**",
    "!../convex/betterAuth/**",
    "!../convex/**/*.config.ts",
  ],
  { query: "?raw", import: "default", eager: true }
);

/** Every module's exports, to learn which are public from Convex itself. */
const MODULES = import.meta.glob<Record<string, unknown>>(
  [
    "../convex/**/*.ts",
    "!../convex/_generated/**",
    "!../convex/betterAuth/**",
    "!../convex/**/*.config.ts",
  ],
  { eager: true }
);

/**
 * A call that establishes who the caller is or what they may reach. A coarse
 * floor, as in `momentumGuardCoverage.test.ts`: it proves a guard is
 * mentioned, not that it is right or that it runs first.
 *
 * `requireX` throws; `readX` is the resolver's non-throwing twin, for queries
 * that answer "nothing" instead (`readCaller`, `readProjectLevel`). The
 * `internal.…assertX` form is how an action guards: it has no `ctx.db`, so it
 * runs an internal query that does (`rateBooks.stageImport`).
 */
const GUARD =
  /\b(require[A-Z]\w*|read(Caller|Project|Proposal|Momentum|Precision)\w*|safeGetAuthUser|getUserIdentity|isMomentumAdmin|_callerIsMomentumAdmin|internal\.[\w.]+\.(assert|require)[A-Z]\w*)\b/;

/**
 * Public on purpose, with the reason. Keep this short: each entry is a
 * standing claim that a function needs no caller check.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map<string, string>([]);

interface PublicFunction {
  id: string;
  body: string | null;
}

/** Whether an export is a client-callable Convex function (a function value). */
function isPublicFunction(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as Registered).isPublic === true &&
    (value as Registered).isInternal !== true
  );
}

/** The source of one export: from its declaration up to the next export. */
function exportBody(source: string, name: string): string | null {
  const start = source.search(new RegExp(`export const ${name}\\b`));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next < 0 ? rest : rest.slice(0, next);
}

function publicFunctions(): PublicFunction[] {
  const found: PublicFunction[] = [];
  for (const [path, exports] of Object.entries(MODULES)) {
    const module = path.replace(/^\.\.\/convex\//, "").replace(/\.ts$/, "");
    for (const [name, value] of Object.entries(exports)) {
      if (!isPublicFunction(value)) continue;
      found.push({ id: `${module}.${name}`, body: exportBody(SOURCES[path] ?? "", name) });
    }
  }
  return found;
}

describe("every public function in the backend checks its caller", () => {
  const all = publicFunctions();

  it("finds the functions at all, so a glob change cannot silently pass", () => {
    expect(all.length).toBeGreaterThan(150);
    const ids = all.map((fn) => fn.id);
    expect(ids).toContain("momentum.deleteProject");
    expect(ids).toContain("precision.getProposal");
    expect(ids).toContain("migration.resolveParentIds");
  });

  it("every public function mentions a caller check", () => {
    const unguarded = all
      .filter((fn) => !EXEMPT.has(fn.id))
      .filter((fn) => fn.body === null || !GUARD.test(fn.body))
      .map((fn) => (fn.body === null ? `${fn.id} (declaration not found)` : fn.id));

    expect(
      unguarded,
      `Reachable by anyone with the deployment URL, which ships inside both desktop ` +
        `bundles:\n  ${unguarded.join("\n  ")}\n\nAdd a guard, make it internal, or ` +
        `add an EXEMPT entry saying why none is needed.`
    ).toEqual([]);
  });

  it("keeps every exemption justified", () => {
    for (const [id, reason] of EXEMPT) {
      expect(
        all.some((fn) => fn.id === id),
        `${id} is no longer public`
      ).toBe(true);
      expect(reason.length, `${id} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
