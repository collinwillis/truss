/**
 * The ordering of application permission levels, for the backend.
 *
 * WHY THIS FILE EXISTS: this four-value ordering decides who may write to a bid,
 * and it had been copied SIX times across the repo — twice inside
 * `packages/features/src/organizations` alone, under the same name, in two
 * modules that could drift without anything failing. Nothing mechanically kept
 * them in agreement.
 *
 * ⚠️ ONE COPY REMAINS, DELIBERATELY. `packages/features/src/organizations/
 * permissions.ts` holds the client-side twin. It cannot import this module:
 * `@truss/features` already peer-depends on `@truss/backend`, so the reverse
 * import would close a dependency cycle, and no Convex module imports a
 * workspace package today — introducing that into the deploy path is not a
 * change to make casually.
 *
 * So the two copies are a known, bounded duplication rather than an accident.
 * IF YOU CHANGE THIS ORDERING, CHANGE THE OTHER ONE. The right long-term home is
 * a dependency-free foundation package (`@truss/types`) that both sides can
 * import, once someone has verified the Convex bundler resolves workspace
 * imports.
 *
 * @module
 */

/** Application permission levels, least to most permissive. */
export type AppPermissionLevel = "none" | "read" | "write" | "admin";

/**
 * The levels in ascending order.
 *
 * Order IS the semantics here — `indexOf` comparisons depend on it — so this is
 * not a set and must not be sorted or reordered.
 */
export const APP_PERMISSION_ORDER: readonly AppPermissionLevel[] = [
  "none",
  "read",
  "write",
  "admin",
];

/**
 * Whether `granted` satisfies `required`.
 *
 * An unrecognised value sorts below `none`, so a level this build does not know
 * about is refused rather than silently treated as sufficient. That matters if a
 * future level is added and an older client sends it.
 */
export function meetsPermissionLevel(granted: string, required: AppPermissionLevel): boolean {
  return (
    APP_PERMISSION_ORDER.indexOf(granted as AppPermissionLevel) >=
    APP_PERMISSION_ORDER.indexOf(required)
  );
}
