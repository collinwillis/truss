/**
 * Auth server type re-export.
 *
 * WHY: The auth server now runs inside Convex (packages/backend/convex/auth.ts).
 * This file exists only for backward compatibility of the `@truss/auth/server`
 * export path. No runtime server logic lives here anymore.
 */

// Re-export the createAuth type for client-side type inference
export type { GenericCtx } from "@convex-dev/better-auth";
