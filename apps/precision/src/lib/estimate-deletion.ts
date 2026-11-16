/**
 * Estimates this window is deleting.
 *
 * WHY it exists: a deleted estimate leaves `listProposals` before the delete's
 * own promise resolves, which is exactly what losing access looks like to the
 * shell. The shell checks here so the person who deleted an estimate is not
 * told they no longer have access to it; the delete flow says what happened.
 */
const deleting = new Set<string>();

/**
 * Note that this window is deleting an estimate.
 *
 * @param estimateId - The estimate being deleted
 * @returns Undo, for when the delete fails and the estimate stays
 */
export function markEstimateDeleting(estimateId: string): () => void {
  deleting.add(estimateId);
  return () => {
    deleting.delete(estimateId);
  };
}

/**
 * Whether this window is deleting an estimate.
 *
 * @param estimateId - The estimate in question
 * @returns True between the delete starting and failing; true for good once it succeeds
 */
export function isEstimateDeleting(estimateId: string): boolean {
  return deleting.has(estimateId);
}
