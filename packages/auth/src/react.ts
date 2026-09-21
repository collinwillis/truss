import { ConvexBetterAuthProvider as UpstreamProvider } from "@convex-dev/better-auth/react";
import type { ComponentProps, ReactNode } from "react";
import type { tauriAuthClient } from "./client/tauri";
import type { authClient as webAuthClient } from "./client/index";

/**
 * The clients this workspace actually builds — the only values that will ever
 * be passed as `authClient`, and therefore the truthful prop type.
 */
type TrussAuthClient = typeof tauriAuthClient | typeof webAuthClient;

type UpstreamProps = ComponentProps<typeof UpstreamProvider>;

/**
 * The Better Auth React provider, re-typed at THIS one boundary — and apps must
 * import it from here, never from @convex-dev/better-auth/react.
 *
 * TWO SEPARATE PROBLEMS FORCE THIS FILE, and version alignment fixes neither:
 *
 * 1. INSTANTIATION IDENTITY. Bun instantiates a package once per distinct peer
 *    set, and an app does not share one with this package — so an app importing
 *    the provider directly gets a different directory of identical .d.ts files
 *    than the one `tauriAuthClient` was built against, and TypeScript treats
 *    the two as unrelated. Importing through this re-export makes client and
 *    provider come from one instantiation by construction.
 *
 * 2. THE UPSTREAM PROP TYPE IS UNSATISFIABLE. @convex-dev/better-auth@0.12.5's
 *    `AuthClient` computes `useSession().data: never` under better-auth@1.6.30
 *    — its `createAuthClient<{ plugins: (A | B)[] }>` instantiation collapses
 *    under 1.6.30's inference, so NO client can satisfy it; the compiler error
 *    ends in `Type 'null' is not assignable to type 'never'`. Dropping to the
 *    peer floor (1.6.11) instead breaks `useBetterAuthTauri`, which needs the
 *    newer types: the declared range `>=1.6.11 <1.7.0` holds no version that
 *    satisfies both consumers. Verified against a single deduplicated
 *    instantiation before concluding this, so it is the type itself, not the
 *    layout.
 *
 * The assertion below is therefore not a convenience: it swaps a provably
 * impossible contract for a NARROWER, TRUE one — only this workspace's real
 * clients are accepted, which is stricter than upstream intended. The runtime
 * component is untouched, and every other use of the clients keeps full
 * inference. Delete this file the moment an upstream pairing type-checks
 * directly; that state is one `npx tsc --noEmit` per app to detect.
 */
export const ConvexBetterAuthProvider = UpstreamProvider as unknown as (
  props: Omit<UpstreamProps, "authClient"> & { authClient: TrussAuthClient }
) => ReactNode;
