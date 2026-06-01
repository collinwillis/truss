/**
 * One-off organization maintenance for the single-org (InDemand) model.
 *
 * WHY: The app assumes every user belongs to the InDemand organization and
 * operates inside it. Two gaps can violate that assumption for existing data:
 *  - `auth.ts`'s `user.onCreate` trigger only ran for users created after it
 *    shipped (and silently skipped if the org wasn't found), so older or
 *    missed users may have no membership.
 *  - Better Auth never sets `activeOrganizationId` on a session, so even a
 *    valid member signs in with no active org and the client falls back to
 *    the "personal workspace" branch (the blank Admin > Members page).
 *
 * This module reconciles both. It is idempotent and safe to run repeatedly.
 *
 * @module
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { components } from "./_generated/api";

const DEFAULT_ORG_SLUG = "indemand";

/** Better Auth models this maintenance touches. */
type AuthModel = "user" | "member" | "session" | "organization";

/** Minimal shape of a Better Auth adapter row. */
interface AdapterDoc {
  _id: string;
}
interface UserDoc extends AdapterDoc {
  email?: string;
}
interface MemberDoc extends AdapterDoc {
  userId: string;
  organizationId: string;
}
interface SessionDoc extends AdapterDoc {
  userId: string;
  activeOrganizationId?: string;
  expiresAt?: number;
}

/**
 * Read every row of a Better Auth model through the adapter, following
 * pagination to completion. `where` is optional — omit it to read all rows.
 */
async function collectAll<T extends AdapterDoc>(
  ctx: MutationCtx,
  model: AuthModel,
  where?: Array<{ field: string; value: string }>
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model,
      ...(where ? { where } : {}),
      paginationOpts: { cursor, numItems: 500 },
    })) as { page: T[]; isDone: boolean; continueCursor: string };
    out.push(...res.page);
    if (res.isDone) break;
    cursor = res.continueCursor;
  }
  return out;
}

/**
 * Reconcile the InDemand single-org model:
 *  1. Ensure every user is a member of InDemand (existing memberships and
 *     their roles are left untouched — this only fills gaps).
 *  2. Point every active session's `activeOrganizationId` at InDemand so
 *     currently signed-in users are fixed without re-authenticating.
 *
 * Pass `{ dryRun: true }` to preview the exact changes without writing.
 */
export const backfillInDemandMembership = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;

    const org = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "organization",
      where: [{ field: "slug", value: DEFAULT_ORG_SLUG }],
    })) as AdapterDoc | null;
    if (!org) {
      throw new Error(`Organization "${DEFAULT_ORG_SLUG}" not found — cannot backfill.`);
    }
    const orgId = org._id;

    // ── 1. Membership ──────────────────────────────────────────────────────
    const users = await collectAll<UserDoc>(ctx, "user");
    const members = await collectAll<MemberDoc>(ctx, "member", [
      { field: "organizationId", value: orgId },
    ]);
    const memberUserIds = new Set(members.map((m) => m.userId));

    const createdFor: string[] = [];
    for (const user of users) {
      if (memberUserIds.has(user._id)) continue;
      createdFor.push(user.email ?? user._id);
      if (!dryRun) {
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "member",
            data: {
              userId: user._id,
              organizationId: orgId,
              role: "member",
              createdAt: Date.now(),
            },
          },
        });
      }
    }

    // ── 2. Active organization on sessions ─────────────────────────────────
    const now = Date.now();
    const sessions = await collectAll<SessionDoc>(ctx, "session");
    const repointed: string[] = [];
    for (const session of sessions) {
      // Skip already-correct and expired sessions (the latter will be
      // re-created with the right active org by the session.create hook).
      if (session.activeOrganizationId === orgId) continue;
      if (session.expiresAt !== undefined && session.expiresAt < now) continue;
      repointed.push(session._id);
      if (!dryRun) {
        await ctx.runMutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: "session",
            where: [{ field: "_id", value: session._id }],
            update: { activeOrganizationId: orgId },
          },
        });
      }
    }

    return {
      dryRun,
      orgId,
      totalUsers: users.length,
      existingMembers: members.length,
      membershipsCreated: createdFor.length,
      createdFor,
      totalSessions: sessions.length,
      activeSessionsRepointed: repointed.length,
    };
  },
});

/** Display code for the Change Orders WBS — mirrors momentum.ts. */
const CHANGE_ORDERS_WBS_CODE = "300000";

/**
 * Backfill `phaseCode` on existing change-order phases that predate the
 * phase-code feature, so they display as "300000-NNN" (matching newly added
 * change-order phases) instead of a bare sequence number. Idempotent; pass
 * `{ dryRun: true }` to preview.
 */
export const backfillChangeOrderPhaseCodes = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const projects = await ctx.db.query("momentumProjects").collect();

    let phasesUpdated = 0;
    const examples: string[] = [];
    for (const project of projects) {
      const phases = await ctx.db
        .query("momentumPhases")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const phase of phases) {
        if (phase.source !== "change_order" || phase.phaseCode || phase.removedAt) continue;
        const code = `${CHANGE_ORDERS_WBS_CODE}-${String(phase.phaseNumber).padStart(3, "0")}`;
        phasesUpdated++;
        if (examples.length < 8) examples.push(code);
        if (!dryRun) await ctx.db.patch(phase._id, { phaseCode: code });
      }
    }
    return { dryRun, phasesUpdated, examples };
  },
});
