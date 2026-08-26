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
    // Tests live OUTSIDE `convex/` on purpose: Convex treats every .ts file in
    // that directory as a deployable module and pushes it. It skips `*.test.ts`
    // by name, but not helper modules — so `legacyReference.ts`, which holds a
    // second transcription of the cost formulas, was being deployed to the
    // backend. A duplicate formula file shipped to production is the exact
    // failure mode documented in docs/precision/DECISIONS.md D0.
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["convex/model/**/*.ts"],
    },
  },
});
