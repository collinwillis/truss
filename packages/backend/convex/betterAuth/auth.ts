/**
 * Static auth instance for Better Auth CLI schema generation.
 *
 * WHY: The @better-auth/cli needs a static instance to introspect
 * plugins and generate the correct schema tables.
 *
 * @module
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { createAuth } from "../auth";

// Export a static instance for schema generation
// The `any` cast is intentional - CLI only needs plugin metadata, not a real Convex context
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const auth = createAuth({} as any);
