/**
 * @truss/auth
 *
 * Authentication package - client-only. The auth server runs inside
 * Convex (packages/backend/convex/auth.ts).
 */

export * from "./client";
export { tauriAuthClient } from "./client/tauri";
