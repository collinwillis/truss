/**
 * Auth client for the Momentum desktop application.
 *
 * WHY: Re-exports from @truss/auth with Convex-aware plugins.
 * Auth requests go directly to Convex HTTP endpoints.
 */

export {
  tauriAuthClient,
  useSession,
  signIn,
  signOut,
  signUp,
  useActiveOrganization,
  useListOrganizations,
} from "@truss/auth/client/tauri";
