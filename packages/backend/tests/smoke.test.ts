/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Smoke test for the convex-test harness.
 *
 * Exists to prove the harness can boot at all before any real assertions depend
 * on it: it loads every module under `convex/`, so a single import-time failure
 * (a component registration, a missing env var) breaks every Convex test at once
 * and is much easier to diagnose here than inside a business-logic suite.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.*s");

describe("convex-test harness", () => {
  it("boots and can write and read a document", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("wbsPool", {
        datasetVersion: "v1",
        poolId: 70000,
        name: "AG PIPING",
        sortOrder: 7,
        isCustom: false,
        isActive: true,
      });
    });

    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.name).toBe("AG PIPING");
    expect(row?.poolId).toBe(70000);
  });
});
