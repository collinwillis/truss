import { defineConfig } from "vitest/config";

/**
 * Backend test config.
 *
 * The cost engine is deliberately free of Convex imports so it runs in a plain
 * Node environment with no Convex test harness — see `convex/model/costEngine.ts`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
    // `__tests__` helper modules (e.g. legacyReference.ts) are imported by
    // tests, never collected as suites themselves.
    coverage: {
      provider: "v8",
      include: ["convex/model/**/*.ts"],
      exclude: ["convex/model/__tests__/**"],
    },
  },
});
