import type { api } from "@truss/backend/convex/_generated/api";
import type { EffectiveAppAccess } from "@truss/features/access/types";
import type { WorkspaceContext } from "@truss/features/organizations/types";
import type { FunctionReturnType } from "convex/server";

/**
 * Client-side twins of the server's Precision rules (docs/ACCESS.md,
 * `packages/backend/convex/model/precisionAccess.ts`). The server is the
 * authority; these only stop the UI offering what it would refuse.
 *
 * Two questions, answered in two places: what the caller may do in the APP
 * comes from the workspace, and what they may do with ONE ESTIMATE comes from
 * that estimate's own `access`, because an "Only assigned" or "Can view all"
 * member can hold Can edit on one estimate and nothing on the next.
 */

/**
 * What the caller may do with one estimate: `full` (Owner or Admin), `edit`
 * or `view`.
 *
 * Read off `getProposal` rather than restated, so a level the server adds
 * fails the type check here instead of quietly reading as view-only.
 */
export type EstimateAccess = FunctionReturnType<typeof api.precision.getProposal>["access"];

function precisionAccess(workspace: WorkspaceContext | null): EffectiveAppAccess {
  return workspace?.precisionAccess ?? "none";
}

/**
 * Whether the workspace may open Precision at all.
 *
 * Gates the shell itself: the root layout subscribes to Precision queries the
 * server refuses at No access, so a workspace that fails this gets the access
 * wall rather than a shell full of errors. "Only assigned" passes even with no
 * estimates yet, because starting one is how they get work in.
 */
export function canOpenPrecision(workspace: WorkspaceContext | null): boolean {
  return precisionAccess(workspace) !== "none";
}

/**
 * Whether the workspace may start a new estimate, and so revise or duplicate
 * one it can see (the server's `requireStartEstimate`).
 *
 * "Can view all" is the one seat that may open Precision and still not start
 * one: it is read-only by definition.
 */
export function canStartEstimate(workspace: WorkspaceContext | null): boolean {
  const access = precisionAccess(workspace);
  return access === "full" || access === "edit_all" || access === "assigned";
}

/** Whether the workspace is an Owner or Admin: rate books, members and sharing. */
export function isAdmin(workspace: WorkspaceContext | null): boolean {
  return workspace?.role === "owner" || workspace?.role === "admin";
}

/**
 * The caller's access to the estimate on screen, or `null` while it is not
 * known.
 *
 * Checked against the id because `useStableQuery` keeps the previous
 * estimate's result while the next one loads: without it, moving from an
 * estimate you edit to one you only view would offer edit controls for that
 * moment.
 */
export function estimateAccessOf(
  proposal: { _id: string; access: EstimateAccess } | null | undefined,
  proposalId: string
): EstimateAccess | null {
  if (!proposal || proposal._id !== proposalId) return null;
  return proposal.access;
}

/**
 * Whether that access allows changing the estimate.
 *
 * Unknown reads as no, so edit controls appear once the estimate has said so
 * rather than vanishing after they were offered.
 */
export function canEditEstimate(access: EstimateAccess | null): boolean {
  return access === "full" || access === "edit";
}
