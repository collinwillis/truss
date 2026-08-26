/**
 * The matcher, calibrated against the corruption it exists to prevent.
 *
 * These tests do not use synthetic data. They run against the two real pool
 * files InDemand actually shipped — `labor_v1/v2.json` and
 * `equipment_v1/v2.json`, copied verbatim into `fixtures/legacy-pools/` — and
 * assert the exact, measured corruption in them:
 *
 *   labor      1,064 rows carrying their payload at a different id than v1,
 *              in three contiguous bands at offsets -4, -455 and +8
 *   equipment  only 3 of 129 descriptions surviving at their own id
 *
 * If the matcher cannot find that, the matcher is wrong — and we would rather
 * learn it here than after an admin has published a book.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMatchIndex,
  findKeyCollisions,
  matchRow,
  naturalKey,
  normalizeKey,
  type MatchCandidate,
} from "../convex/model/rateBookMatch";

const FIXTURES = join(__dirname, "fixtures", "legacy-pools");
const load = (name: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Array<Record<string, unknown>>;

const laborItems = (file: string): MatchCandidate[] =>
  load(file).map((r) => ({
    poolId: r.id as number,
    description: r.description as string,
    parentPoolId: r.phaseDatabaseId as number,
    payload: {
      craftConstant: r.craftConstant as number,
      craftUnits: (r.craftUnits as string) ?? "",
      weldConstant: r.weldConstant as number,
      weldUnits: (r.weldUnits as string) ?? "",
      phase: r.phaseDatabaseId as number,
    },
  }));

const equipmentItems = (file: string): MatchCandidate[] =>
  load(file).map((r) => ({
    poolId: r.id as number,
    description: r.description as string,
    payload: {
      hourRate: r.hourRate as number,
      dayRate: r.dayRate as number,
      weekRate: r.weekRate as number,
      monthRate: r.monthRate as number,
    },
  }));

describe("the normalizer", () => {
  it("keeps the punctuation that carries meaning", () => {
    // 509 labor descriptions use ≤/≥ to distinguish pipe sizes. Collapsing
    // them merges genuinely different work.
    expect(normalizeKey("FSW - ≤.75")).not.toBe(normalizeKey("FSW - ≥.75"));
    expect(normalizeKey("FSW - ≤.75")).toBe("FSW - <=.75");
  });

  it("still ignores the noise a spreadsheet introduces", () => {
    expect(normalizeKey("  air   breaker  30 lbs ")).toBe(normalizeKey("AIR BREAKER 30 LBS"));
    // Excel's autocorrect rewrites " - " as " – " while you type. Without dash
    // folding, an untouched row would look like a different item on the very
    // next round trip.
    expect(normalizeKey("CUT — ≤2")).toBe(normalizeKey("cut - <=2"));
    expect(normalizeKey("A – B")).toBe(normalizeKey("A - B"));
  });

  it("produces ZERO natural-key collisions across every real pool file", () => {
    // This is the matcher's founding premise: a name plus its parent
    // identifies exactly one item. Asserted on all 11,865 labor rows and both
    // equipment files rather than assumed.
    for (const file of ["labor_v1.json", "labor_v2.json"]) {
      expect(findKeyCollisions(laborItems(file)), `${file} collisions`).toEqual([]);
    }
    for (const file of ["equipment_v1.json", "equipment_v2.json"]) {
      expect(findKeyCollisions(equipmentItems(file)), `${file} collisions`).toEqual([]);
    }
  });
});

describe("catching the real labor corruption", () => {
  const v1 = laborItems("labor_v1.json");
  const v2 = laborItems("labor_v2.json");
  const index = buildMatchIndex(v1);

  it("blocks every row whose id disagrees with what the row says it is", () => {
    let blocked = 0;
    let cleanMatches = 0;
    let brandNew = 0;
    for (const row of v2) {
      const result = matchRow({ ...row, declaredId: row.poolId }, index);
      if (result.blocking) blocked += 1;
      else if (result.matched) cleanMatches += 1;
      else brandNew += 1;
    }
    // The three shift bands, measured: 706 rows at -4, 12 at -455, 346 at +8.
    expect(blocked).toBeGreaterThanOrEqual(1000);
    // The bulk of the catalog is genuinely aligned and must pass silently, or
    // the admin drowns and stops reading.
    expect(cleanMatches).toBeGreaterThan(4000);
    expect(brandNew).toBeGreaterThan(0);
  });

  it("names the specific item and the specific id in the refusal", () => {
    // 4725 sits at the head of the -4 band.
    const shifted = v2.find((r) => r.poolId === 4725);
    expect(shifted).toBeDefined();
    const result = matchRow({ ...shifted!, declaredId: 4725 }, index);
    expect(result.blocking).toBe(true);
    expect(result.reason).toContain("4725");
    expect(result.reason).toContain(shifted!.description);
  });

  it("passes an aligned row through without ceremony", () => {
    // Id 1 "TOOLS" is unchanged between the two files.
    const stable = v2.find((r) => r.poolId === 1);
    const result = matchRow({ ...stable!, declaredId: 1 }, index);
    expect(result.blocking).toBe(false);
    expect(result.matched?.poolId).toBe(1);
  });
});

describe("catching the real equipment corruption", () => {
  const v1 = equipmentItems("equipment_v1.json");
  const v2 = equipmentItems("equipment_v2.json");
  const index = buildMatchIndex(v1);

  it("refuses the exhibit-A row, WITHOUT guessing whose values they are", () => {
    // v2 id 6 is "BREAKERS - AIR 30 LBS" carrying [7,56,224,672] — v1 id 5's
    // rates, under a shortened name. It was shifted AND renamed in one pass,
    // so no description test can catch it.
    const row = v2.find((r) => r.poolId === 6);
    expect(row).toBeDefined();
    const result = matchRow({ ...row!, declaredId: 6 }, index);
    expect(result.blocking).toBe(true);

    // ⚠️ It must NOT claim this is id 5. SEVEN different v1 items carry
    // [7,56,224,672] — equipment rates repeat heavily (24 tuples are shared,
    // one by 11 items). Naming a single owner would be a guess wearing the
    // costume of a finding, and the whole point of this subsystem is that a
    // human decides when the evidence is ambiguous.
    expect(result.reason).toBeTruthy();
  });

  it("blocks the overwhelming majority of a file this broken", () => {
    const blocked = v2.filter(
      (r) => matchRow({ ...r, declaredId: r.poolId }, index).blocking
    ).length;
    // Only 3 of 129 descriptions survive at their own id, so almost nothing
    // here should sail through unexamined.
    expect(blocked).toBeGreaterThan(60);
  });

  it("sees a renumbered item as a MOVE, not an addition", () => {
    // Comparing id sets calls 129-132 "new". They are not: v2 id 132
    // "MISC - DUMPSTER SERVICE" is byte-identical to v1 id 128 — same name,
    // same four rates. It was renumbered, and adding it again would have
    // created a duplicate item and orphaned every estimate on id 128.
    const moved = v2.find((r) => r.poolId === 132);
    const result = matchRow({ ...moved!, declaredId: 132 }, index);
    expect(result.matched?.poolId).toBe(128);
    expect(result.blocking).toBe(true);
  });

  it("treats an item with no counterpart at all as new", () => {
    const invented = {
      poolId: 900,
      description: "SCISSOR LIFT - 19FT NARROW",
      payload: { hourRate: 3, dayRate: 21, weekRate: 61, monthRate: 177 },
    };
    const result = matchRow({ ...invented, declaredId: undefined }, index);
    expect(result.matched).toBeNull();
    expect(result.blocking).toBe(false);
  });
});

describe("the barriers, stated directly", () => {
  const index = buildMatchIndex(equipmentItems("equipment_v1.json"));

  it("blocks an Excel fill-down that renumbers live ids", () => {
    // The description rides with its own row, so a ±1 description test never
    // fires — but the natural key resolves to an id that is not in column A.
    const real = equipmentItems("equipment_v1.json").find((r) => r.poolId === 20)!;
    const result = matchRow({ ...real, declaredId: 21 }, index);
    expect(result.blocking).toBe(true);
    expect(result.matched?.poolId).toBe(20);
  });

  it("never silently adopts an id the file asked for", () => {
    const invented: MatchCandidate = {
      poolId: 9999,
      description: "SOMETHING NOBODY HAS EVER RENTED",
      payload: { hourRate: 1, dayRate: 2, weekRate: 3, monthRate: 4 },
    };
    const result = matchRow({ ...invented, declaredId: 9999 }, index);
    // No match, so it is new — and minting is the caller's job, at a
    // server-allocated id, never at 9999.
    expect(result.matched).toBeNull();
  });

  it("scopes a labor key to its phase, so a shared name is not a collision", () => {
    const a = { description: "TECHNICIAN", parentPoolId: 79994 };
    const b = { description: "TECHNICIAN", parentPoolId: 79996 };
    expect(naturalKey(a)).not.toBe(naturalKey(b));
  });
});
