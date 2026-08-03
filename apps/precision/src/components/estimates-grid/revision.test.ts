/**
 * Deriving the next revision.
 *
 * Every family below is real, taken from the live 731 proposals. They are
 * here because they are the cases that break a naive "+1" — inconsistent
 * padding inside one family, letter prefixes, suffixes that merely contain a
 * number, and numbers that are already used twice.
 */
import { describe, expect, it } from "vitest";
import { deriveRevision, deriveRevisionNumber, stripMarker } from "./revision";

const f = (proposalNumber: string, description = "") => ({ proposalNumber, description });

describe("the next number", () => {
  it("starts a family that has never been revised at .01", () => {
    // 42 families of 85 open this way, against 32 that use .1.
    expect(deriveRevisionNumber("2118", ["2118"])).toBe("2118.01");
  });

  it("inherits zero-padding from the family's latest revision", () => {
    // Family 1602 runs 1602, 1602.3, 1602.04, 1602.05 — three conventions in
    // one family. The most recent wins, so the next is .06 and not .6.
    expect(deriveRevisionNumber("1602.05", ["1602", "1602.3", "1602.04", "1602.05"])).toBe(
      "1602.06"
    );
  });

  it("keeps a plain family plain", () => {
    expect(deriveRevisionNumber("1879.2", ["1879", "1879.1", "1879.2"])).toBe("1879.3");
  });

  it("carries a letter prefix through", () => {
    expect(deriveRevisionNumber("2112.R2", ["2112", "2112.R1", "2112.R2"])).toBe("2112.R3");
    expect(deriveRevisionNumber("2100.CO1", ["2100", "2100.CO1"])).toBe("2100.CO2");
  });

  it("carries a trailing letter group through", () => {
    expect(deriveRevisionNumber("2100.CO1NR", ["2100", "2100.CO1NR"])).toBe("2100.CO2NR");
  });

  it("counts from the family's HIGHEST revision, not the one right-clicked", () => {
    // Right-clicking the original must not propose a number already taken.
    expect(deriveRevisionNumber("2112", ["2112", "2112.R1", "2112.R2"])).toBe("2112.R3");
  });

  it("refuses to read a number out of prose", () => {
    // "2082 - 50% FACTOR (SHARED SAVINGS)" must not become "51% FACTOR".
    const family = ["2082", "2082 - 50% FACTOR (SHARED SAVINGS)", "2082 - 25% FACTOR"];
    expect(deriveRevisionNumber("2082 - 50% FACTOR (SHARED SAVINGS)", family)).toBe("2082.01");
  });

  it("survives a number it cannot parse", () => {
    expect(deriveRevisionNumber("", [""])).toBe("");
  });
});

describe("the description", () => {
  it("leaves it alone when the family has never marked revisions", () => {
    // About half of real revisions carry no marker; inventing one would
    // impose a convention on families that have never used it.
    const family = [
      f("2109", "BUILDING U-704 - ADDITIONAL SLAB"),
      f("2109.01", "BUILDING U-704 - ADDITIONAL SLAB"),
    ];
    expect(deriveRevision(family[0]!, family).description).toBe("BUILDING U-704 - ADDITIONAL SLAB");
  });

  it("continues the family's own marker, in its own spelling", () => {
    const family = [
      f("1602", "Demo 10'-9\" Furnace"),
      f("1602.3", "Demo 10'-9\" Furnace (Rev #3)"),
      f("1602.04", "Demo 10'-9\" Furnace (Rev #4)"),
      f("1602.05", "Demo 10'-9\" Furnace (R5)"),
    ];
    const next = deriveRevision(family[3]!, family);
    expect(next.proposalNumber).toBe("1602.06");
    // (R5) is the most recent marker, so its spelling is the one continued.
    expect(next.description).toBe("Demo 10'-9\" Furnace (R6)");
  });

  it("keeps the marker number in step with the proposal number", () => {
    const family = [
      f("2112", "Plant Air Seed and Meal"),
      f("2112.R1", "Plant Air Seed and Meal (R1)"),
    ];
    const next = deriveRevision(family[1]!, family);
    expect(next.proposalNumber).toBe("2112.R2");
    expect(next.description).toBe("Plant Air Seed and Meal (R2)");
  });

  it("replaces the old marker rather than stacking another on", () => {
    expect(stripMarker("Plant Air Seed and Meal (R2)")).toBe("Plant Air Seed and Meal");
    expect(stripMarker("Oshkosh ASU - Civil & MEI (Rev. 2)")).toBe("Oshkosh ASU - Civil & MEI");
    expect(stripMarker("No marker here")).toBe("No marker here");
  });
});

describe("collisions", () => {
  /**
   * The guard is defensive, and these tests say so rather than pretending
   * otherwise. Because the rule always takes the family's HIGHEST revision
   * and adds one, it cannot propose a number the family already holds — so
   * `collides` should read false throughout normal operation. It is computed
   * anyway because 24 proposal numbers in the live data are already used more
   * than once, which is proof the data can hold states this rule did not
   * create, and the dialog would rather check than assume.
   */
  it("stays clear of an existing revision even when the original is clicked", () => {
    const all = [
      f("1594", "Mechanical Site Services"),
      f("1594.01", "Mechanical Site Services (R1)"),
    ];
    const next = deriveRevision(all[0]!, all);
    expect(next.proposalNumber).toBe("1594.02");
    expect(next.collides).toBe(false);
  });

  it("stays clear when the log already holds the number twice", () => {
    // 1594 really does appear twice in production.
    const all = [f("1594", "Mechanical Site Services"), f("1594", "Mechanical Site Services")];
    const next = deriveRevision(all[0]!, all);
    expect(next.proposalNumber).toBe("1594.01");
    expect(next.collides).toBe(false);
  });

  it("does not flag a free number", () => {
    const all = [f("2118", "Process piping")];
    const next = deriveRevision(all[0]!, all);
    expect(next.proposalNumber).toBe("2118.01");
    expect(next.collides).toBe(false);
  });

  it("ignores other families when picking the number", () => {
    const all = [f("2112", "A"), f("2112.R1", "A (R1)"), f("2113", "B"), f("2113.09", "B")];
    expect(deriveRevision(all[0]!, all).proposalNumber).toBe("2112.R2");
  });
});
