import { defineConfig } from "vitest/config";

/**
 * Precision's first test setup.
 *
 * Scoped to pure logic — the column-visibility rules that decide what an
 * estimator sees. Those rules encode a business template and shipped a real
 * defect (an OR where an AND belonged, which showed a wall of empty columns),
 * so they are exactly the kind of thing that must not regress silently.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
