/**
 * Project assignment queries and mutations.
 *
 * WHY: Enables scoped access control within Momentum projects. Construction
 * supervisors and foremen can be assigned to an entire project, a specific WBS,
 * or a single phase — limiting what they see and can enter quantities for.
 *
 * Scope inheritance: project → all WBS → all phases.
 * Multiple assignments per user are unioned; the highest role wins.
 *
 * @module
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { components } from "./_generated/api";
import { authComponent } from "./auth";

/** Shape of a Better Auth user record from the adapter. */
interface AuthUserRecord {
  _id: string;
  name?: string;
  email?: string;
  image?: string;
}

// ============================================================================
// VALIDATORS
// ============================================================================

const scopeTypeValidator = v.union(v.literal("project"), v.literal("wbs"), v.literal("phase"));

const projectRoleValidator = v.union(
  v.literal("superintendent"),
  v.literal("supervisor"),
  v.literal("foreman"),
  v.literal("viewer")
);

/** Role hierarchy — higher index = more permissions. */
const ROLE_HIERARCHY = ["viewer", "foreman", "supervisor", "superintendent"] as const;

type ProjectRoleType = (typeof ROLE_HIERARCHY)[number];

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Whether a user is a Momentum admin — mirrors the frontend `isWorkspaceAdmin`
 * (apps/momentum/src/lib/permissions.ts): an org owner/admin, OR a member whose
 * Momentum app permission is "admin". Admins bypass project member assignment
 * and can see/open every project (#43).
 */
export async function isMomentumAdmin(
  ctx: QueryCtx | MutationCtx,
  userId: string
): Promise<boolean> {
  const memberResult = await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "member",
    where: [{ field: "userId", value: userId }],
    paginationOpts: { cursor: null, numItems: 50 },
  });
  const members = (memberResult?.page ?? []) as Array<Record<string, unknown>>;
  if (members.length === 0) return false;

  // Org owner/admin → admin across all apps.
  if (members.some((m) => m.role === "owner" || m.role === "admin")) return true;

  // Otherwise a Momentum app-permission of "admin" on any of the user's member
  // records grants admin. appPermissions is keyed by the member id the frontend
  // passes as `currentMember.id`; check both `id` and `_id` so the match holds
  // regardless of which the Better Auth adapter surfaces.
  for (const m of members) {
    const candidates = [m.id, m._id].filter((id): id is string => typeof id === "string");
    for (const memberId of candidates) {
      const perm = await ctx.db
        .query("appPermissions")
        .withIndex("by_member_app", (q) => q.eq("memberId", memberId).eq("app", "momentum"))
        .first();
      if (perm?.permission === "admin") return true;
    }
  }
  return false;
}

/**
 * Resolve the effective scope for a user on a Momentum project.
 *
 * After the snapshot migration, scope IDs reference the Momentum tables
 * (`momentumWbs` / `momentumPhases`) via `newScopeId`. Pre-migration
 * assignments still carry only the legacy `scopeId` — those are resolved
 * by looking up the matching Momentum row through its `sourceWbsId` /
 * `sourcePhaseId` index. Either way, callers get back Momentum IDs.
 */
export async function resolveUserScope(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"momentumProjects">,
  userId: string
): Promise<{
  hasAccess: boolean;
  effectiveRole: ProjectRoleType | null;
  allowedWbsIds: Set<string> | "all";
  allowedPhaseIds: Set<string> | "all";
}> {
  // Admins bypass assignment entirely — full access to every project (#43).
  if (await isMomentumAdmin(ctx, userId)) {
    return {
      hasAccess: true,
      effectiveRole: "superintendent",
      allowedWbsIds: "all",
      allowedPhaseIds: "all",
    };
  }

  const assignments = await ctx.db
    .query("projectAssignments")
    .withIndex("by_project_user", (q) => q.eq("projectId", projectId).eq("userId", userId))
    .collect();

  if (assignments.length === 0) {
    return {
      hasAccess: false,
      effectiveRole: null,
      allowedWbsIds: new Set(),
      allowedPhaseIds: new Set(),
    };
  }

  let highestRoleIndex = -1;
  let hasProjectScope = false;
  const wbsIds = new Set<string>();
  const phaseIds = new Set<string>();

  for (const assignment of assignments) {
    const roleIndex = ROLE_HIERARCHY.indexOf(assignment.role as ProjectRoleType);
    if (roleIndex > highestRoleIndex) highestRoleIndex = roleIndex;

    if (assignment.scopeType === "project") {
      hasProjectScope = true;
      continue;
    }

    // Prefer the migrated Momentum ID; fall back to mapping the legacy
    // ID to its Momentum twin via the source-id index.
    let scopeMomentumId = assignment.newScopeId;
    if (!scopeMomentumId && assignment.scopeId) {
      if (assignment.scopeType === "wbs") {
        const m = await ctx.db
          .query("momentumWbs")
          .withIndex("by_source_wbs", (q) => q.eq("sourceWbsId", assignment.scopeId as Id<"wbs">))
          .first();
        if (m && m.projectId === projectId) scopeMomentumId = m._id as string;
      } else if (assignment.scopeType === "phase") {
        const m = await ctx.db
          .query("momentumPhases")
          .withIndex("by_source_phase", (q) =>
            q.eq("sourcePhaseId", assignment.scopeId as Id<"phases">)
          )
          .first();
        if (m && m.projectId === projectId) scopeMomentumId = m._id as string;
      }
    }

    if (!scopeMomentumId) continue;
    if (assignment.scopeType === "wbs") {
      wbsIds.add(scopeMomentumId);
    } else if (assignment.scopeType === "phase") {
      phaseIds.add(scopeMomentumId);
    }
  }

  if (hasProjectScope) {
    return {
      hasAccess: true,
      effectiveRole: ROLE_HIERARCHY[highestRoleIndex]!,
      allowedWbsIds: "all",
      allowedPhaseIds: "all",
    };
  }

  // Expand WBS-level assignments to include all child Momentum phases.
  if (wbsIds.size > 0) {
    const allPhases = await ctx.db
      .query("momentumPhases")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const phase of allPhases) {
      if (wbsIds.has(phase.wbsId as string)) {
        phaseIds.add(phase._id as string);
      }
    }
  }

  return {
    hasAccess: true,
    effectiveRole: ROLE_HIERARCHY[highestRoleIndex]!,
    allowedWbsIds: wbsIds.size > 0 ? wbsIds : new Set(),
    allowedPhaseIds: phaseIds,
  };
}

/**
 * Resolve a human-readable scope name from scope type and ID.
 */
function resolveScopeName(
  scopeType: string,
  scopeId: string | undefined,
  wbsMap: Map<string, Doc<"wbs">>,
  phaseMap: Map<string, Doc<"phases">>
): string {
  if (scopeType === "project") return "Entire Project";

  if (scopeType === "wbs" && scopeId) {
    const wbs = wbsMap.get(scopeId);
    return wbs ? `${wbs.name} (${wbs.wbsPoolId})` : `WBS ${scopeId}`;
  }

  if (scopeType === "phase" && scopeId) {
    const phase = phaseMap.get(scopeId);
    return phase ? `${phase.description} (${phase.phasePoolId})` : `Phase ${scopeId}`;
  }

  return "Unknown";
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Return the WBS + phases tree for a project's scope picker.
 *
 * WHY: The "Assign Member" dialog needs to show available WBS items and
 * their child phases so the admin can select a scope target.
 */
export const getProjectScopeTree = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;

    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    const allPhases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();

    return {
      wbs: wbsItems.map((w) => ({
        id: w._id as string,
        code: String(w.wbsPoolId),
        name: w.name,
      })),
      phases: allPhases.map((p) => ({
        id: p._id as string,
        wbsId: p.wbsId as string,
        code: String(p.phasePoolId),
        description: p.description,
        phaseNumber: p.phaseNumber,
      })),
    };
  },
});

// ============================================================================
// (continued)
// ============================================================================

/** List all assignments for a project with scope names. */
export const listProjectAssignments = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    if (assignments.length === 0) return [];

    const project = await ctx.db.get(args.projectId);
    if (!project) return [];

    // Build lookup maps for scope name resolution
    const wbsItems = await ctx.db
      .query("wbs")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();
    const wbsMap = new Map(wbsItems.map((w) => [w._id as string, w]));

    const phases = await ctx.db
      .query("phases")
      .withIndex("by_proposal", (q) => q.eq("proposalId", project.proposalId))
      .collect();
    const phaseMap = new Map(phases.map((p) => [p._id as string, p]));

    // Batch-fetch user details from Better Auth component
    const userIds = [...new Set(assignments.map((a) => a.userId))];
    const userMap = new Map<string, { name: string; email: string; image?: string }>();

    for (const userId of userIds) {
      try {
        const raw = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "user",
          where: [{ field: "_id", value: userId }],
        });
        if (raw) {
          const user = raw as unknown as AuthUserRecord;
          userMap.set(userId, {
            name: user.name ?? "",
            email: user.email ?? "",
            image: user.image,
          });
        }
      } catch {
        // User lookup failed — use userId as fallback
      }
    }

    return assignments.map((a) => ({
      id: a._id as string,
      projectId: a.projectId as string,
      userId: a.userId,
      userName: userMap.get(a.userId)?.name ?? a.userId,
      userEmail: userMap.get(a.userId)?.email ?? "",
      userImage: userMap.get(a.userId)?.image,
      scopeType: a.scopeType,
      scopeId: a.scopeId,
      scopeName: resolveScopeName(a.scopeType, a.scopeId, wbsMap, phaseMap),
      role: a.role,
      assignedBy: a.assignedBy,
      assignedAt: a.assignedAt,
    }));
  },
});

/** List all project assignments for a specific user across all projects. */
export const listUserAssignments = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (assignments.length === 0) return [];

    // Fetch project info and scope names
    const projectIds = [...new Set(assignments.map((a) => a.projectId as string))];
    const projectMap = new Map<string, Doc<"momentumProjects">>();
    for (const id of projectIds) {
      const project = await ctx.db.get(id as Id<"momentumProjects">);
      if (project) projectMap.set(id, project);
    }

    // Resolve scope names
    const scopeNames = new Map<string, string>();
    for (const a of assignments) {
      if (a.scopeType === "project") {
        scopeNames.set(a._id as string, "Entire Project");
        continue;
      }

      if (!a.scopeId) {
        scopeNames.set(a._id as string, "Unknown");
        continue;
      }

      if (a.scopeType === "wbs") {
        const wbs = await ctx.db.get(a.scopeId as Id<"wbs">);
        scopeNames.set(
          a._id as string,
          wbs ? `${wbs.name} (${wbs.wbsPoolId})` : `WBS ${a.scopeId}`
        );
      } else if (a.scopeType === "phase") {
        const phase = await ctx.db.get(a.scopeId as Id<"phases">);
        scopeNames.set(
          a._id as string,
          phase ? `${phase.description} (${phase.phasePoolId})` : `Phase ${a.scopeId}`
        );
      }
    }

    return assignments.map((a) => ({
      id: a._id as string,
      projectId: a.projectId as string,
      projectName: projectMap.get(a.projectId as string)?.name ?? "Unknown Project",
      userId: a.userId,
      scopeType: a.scopeType,
      scopeId: a.scopeId,
      scopeName: scopeNames.get(a._id as string) ?? "Unknown",
      role: a.role,
      assignedAt: a.assignedAt,
    }));
  },
});

/**
 * Resolve the effective scope for a user on a project.
 *
 * WHY: Powers workbook filtering and save validation. Returns whether
 * the user has access, and if scoped, which WBS/phase IDs are visible.
 * When no assignments exist for a project, returns isUnscoped=true
 * (backward compatible — everyone sees everything).
 */
export const getUserProjectScope = query({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if any assignments exist for this project at all
    const anyAssignment = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .first();

    // No assignments on this project = everyone has access (opt-in)
    if (!anyAssignment) {
      return {
        hasAccess: true,
        isUnscoped: true,
        effectiveRole: null as string | null,
        allowedWbsIds: "all" as string[] | "all",
        allowedPhaseIds: "all" as string[] | "all",
      };
    }

    const scope = await resolveUserScope(ctx, args.projectId, args.userId);

    return {
      hasAccess: scope.hasAccess,
      isUnscoped: false,
      effectiveRole: scope.effectiveRole,
      allowedWbsIds: scope.allowedWbsIds === "all" ? ("all" as const) : [...scope.allowedWbsIds],
      allowedPhaseIds:
        scope.allowedPhaseIds === "all" ? ("all" as const) : [...scope.allowedPhaseIds],
    };
  },
});

/** Quick summary of all members assigned to a project. */
export const getProjectMembers = query({
  args: { projectId: v.id("momentumProjects") },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Group by userId
    const byUser = new Map<string, { roles: Set<string>; scopeCount: number }>();
    for (const a of assignments) {
      const entry = byUser.get(a.userId) ?? { roles: new Set(), scopeCount: 0 };
      entry.roles.add(a.role);
      entry.scopeCount++;
      byUser.set(a.userId, entry);
    }

    return [...byUser.entries()].map(([userId, data]) => ({
      userId,
      roles: [...data.roles],
      scopeCount: data.scopeCount,
    }));
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/** Assign a user to a project scope. */
export const assignUserToProject = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
    scopeType: scopeTypeValidator,
    scopeId: v.optional(v.string()),
    role: projectRoleValidator,
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    // Validate scope references
    if (args.scopeType === "wbs") {
      if (!args.scopeId) throw new Error("WBS scope requires a scopeId.");
      const wbs = await ctx.db.get(args.scopeId as Id<"wbs">);
      if (!wbs) throw new Error("WBS item not found.");
      if (wbs.proposalId !== project.proposalId) {
        throw new Error("WBS does not belong to this project's proposal.");
      }
    }

    if (args.scopeType === "phase") {
      if (!args.scopeId) throw new Error("Phase scope requires a scopeId.");
      const phase = await ctx.db.get(args.scopeId as Id<"phases">);
      if (!phase) throw new Error("Phase not found.");
      if (phase.proposalId !== project.proposalId) {
        throw new Error("Phase does not belong to this project's proposal.");
      }
    }

    if (args.scopeType === "project" && args.scopeId) {
      throw new Error("Project scope should not have a scopeId.");
    }

    // Check for exact duplicate
    const existing = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId)
      )
      .collect();

    const duplicate = existing.find(
      (a) =>
        a.scopeType === args.scopeType && (a.scopeId ?? undefined) === (args.scopeId ?? undefined)
    );
    if (duplicate) {
      throw new Error("This user already has an assignment for this scope.");
    }

    const currentUser = await authComponent.safeGetAuthUser(ctx);

    return ctx.db.insert("projectAssignments", {
      projectId: args.projectId,
      userId: args.userId,
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      role: args.role,
      assignedBy: currentUser?._id ?? undefined,
      assignedAt: Date.now(),
    });
  },
});

/** Update the role on an existing assignment. */
export const updateAssignment = mutation({
  args: {
    assignmentId: v.id("projectAssignments"),
    role: projectRoleValidator,
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found.");

    await ctx.db.patch(args.assignmentId, { role: args.role });
  },
});

/** Remove an assignment. */
export const removeAssignment = mutation({
  args: { assignmentId: v.id("projectAssignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found.");

    await ctx.db.delete(args.assignmentId);
  },
});

/** Assign a user to multiple scopes at once. */
export const bulkAssignUser = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
    assignments: v.array(
      v.object({
        scopeType: scopeTypeValidator,
        scopeId: v.optional(v.string()),
        role: projectRoleValidator,
      })
    ),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found.");

    const currentUser = await authComponent.safeGetAuthUser(ctx);
    const assignedBy = currentUser?._id ?? undefined;
    const assignedAt = Date.now();

    const ids: Id<"projectAssignments">[] = [];

    for (const assignment of args.assignments) {
      if (assignment.scopeType === "wbs" && assignment.scopeId) {
        const wbs = await ctx.db.get(assignment.scopeId as Id<"wbs">);
        if (!wbs || wbs.proposalId !== project.proposalId) {
          throw new Error(`Invalid WBS scope: ${assignment.scopeId}`);
        }
      }
      if (assignment.scopeType === "phase" && assignment.scopeId) {
        const phase = await ctx.db.get(assignment.scopeId as Id<"phases">);
        if (!phase || phase.proposalId !== project.proposalId) {
          throw new Error(`Invalid phase scope: ${assignment.scopeId}`);
        }
      }

      const id = await ctx.db.insert("projectAssignments", {
        projectId: args.projectId,
        userId: args.userId,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
        role: assignment.role,
        assignedBy,
        assignedAt,
      });
      ids.push(id);
    }

    return ids;
  },
});

/** Remove all assignments for a user on a specific project. */
export const removeAllUserAssignments = mutation({
  args: {
    projectId: v.id("momentumProjects"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query("projectAssignments")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId)
      )
      .collect();

    for (const assignment of assignments) {
      await ctx.db.delete(assignment._id);
    }

    return assignments.length;
  },
});
