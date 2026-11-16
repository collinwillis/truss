import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";

import { useWorkspace } from "../organizations/workspace-context";
import { accessErrorText } from "./error-text";
import { toMemberRole } from "./labels";
import type {
  AccessCandidate,
  ImplicitAccessCounts,
  ItemAccessLevel,
  ItemAccessPerson,
} from "./types";

/** One estimate or one project, by its id. */
export type AccessItem = { proposalId: Id<"proposals"> } | { projectId: Id<"momentumProjects"> };

/** What {@link useItemAccess} returns: the panel's data and its actions. */
export interface ItemAccessState {
  /** `undefined` while loading. */
  people: ItemAccessPerson[] | undefined;
  /** `undefined` while loading. */
  implicit: ImplicitAccessCounts | undefined;
  /** `undefined` while loading. */
  candidates: AccessCandidate[] | undefined;
  /** The last failed action's reason, cleared by the next success. */
  error: string | null;
  /** Each action rejects on failure, after setting {@link ItemAccessState.error}. */
  add: (userId: string, level: ItemAccessLevel) => Promise<void>;
  changeLevel: (userId: string, level: ItemAccessLevel) => Promise<void>;
  remove: (userId: string) => Promise<void>;
}

/**
 * Who can open one estimate or project, who could be added, and the actions
 * to change it. Owner/Admin only: the queries refuse anyone else.
 *
 * Candidates come from the admin roster rather than the member picker because
 * the picker carries no role, and Owners and Admins cannot be added: their
 * role already reaches everything. Suspended people are left out too, since
 * the server refuses to add them.
 *
 * @param item - The estimate or project
 * @returns The panel's data, loading as `undefined`, and its actions
 */
export function useItemAccess(item: AccessItem): ItemAccessState {
  const { workspace } = useWorkspace();
  const orgId = workspace?.organization_id;

  const access = useQuery(api.access.listItemAccess, item);
  const members = useQuery(
    api.adminUsers.listOrganizationMembers,
    orgId ? { organizationId: orgId } : "skip"
  );
  const grant = useMutation(api.access.grantItemAccess);
  const revoke = useMutation(api.access.revokeItemAccess);
  const [error, setError] = useState<string | null>(null);

  const people = access?.people;
  const candidates = useMemo(() => {
    if (!members || !people) return undefined;
    const listed = new Set(people.map((person) => person.userId));
    return members
      .filter(
        (member) =>
          toMemberRole(member.orgRole) === "member" &&
          !member.isBanned &&
          !listed.has(member.userId)
      )
      .map((member): AccessCandidate => ({
        userId: member.userId,
        name: member.name,
        email: member.email,
        image: member.image,
      }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }, [members, people]);

  // Every action records its failure for the panel and rethrows, so the panel
  // can keep a pick or a row's level as it was.
  const report = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (failure) {
      setError(accessErrorText(failure));
      throw failure;
    }
  }, []);

  const proposalId = "proposalId" in item ? item.proposalId : undefined;
  const projectId = "projectId" in item ? item.projectId : undefined;

  const add = useCallback(
    (userId: string, level: ItemAccessLevel) =>
      report(() => grant({ proposalId, projectId, userId, level })),
    [report, grant, proposalId, projectId]
  );
  const remove = useCallback(
    (userId: string) => report(() => revoke({ proposalId, projectId, userId })),
    [report, revoke, proposalId, projectId]
  );

  return {
    people,
    implicit: access?.implicit,
    candidates,
    error,
    add,
    // Granting again at a new level is how a level changes: one row per person.
    changeLevel: add,
    remove,
  };
}
