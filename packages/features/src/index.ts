/**
 * @truss/features
 *
 * Modular business logic features for all applications
 *
 * @example
 * ```typescript
 * // Organizations and access
 * import { useWorkspace, WorkspaceProvider } from "@truss/features/organizations/workspace-context";
 * import type { WorkspaceContext } from "@truss/features/organizations/types";
 * import { AppAccessSelect, ShareEstimateDialog } from "@truss/features/access";
 * ```
 */

// Export organizations feature
export * from "./organizations";

// Export access feature
export * from "./access";

// Export auth feature
export * from "./auth";

// Export desktop-shell feature
export * from "./desktop-shell";

// Export progress-tracking feature
export * from "./progress-tracking";

// Export admin feature
export * from "./admin";
