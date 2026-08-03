/**
 * Display casing for human-entered text.
 *
 * Every string below is a real value from InDemand's 731 live proposals.
 * The rule exists because the same client is stored as `cargill`, `CARGILL`
 * and `Marathon` — 115 records fully upper-case, 29 fully lower-case — and a
 * column of them reads as noise. The hard part is normalising that WITHOUT
 * destroying the tokens whose casing is information, which is most of what
 * these tests pin down.
 */
import { describe, expect, it } from "vitest";
import { displayCase } from "@truss/lib/string";

describe("client and place names", () => {
  it("settles shouted and whispered names on one form", () => {
    expect(displayCase("CARGILL")).toBe("Cargill");
    expect(displayCase("cargill")).toBe("Cargill");
    expect(displayCase("marathon")).toBe("Marathon");
    expect(displayCase("weyerhaeuser")).toBe("Weyerhaeuser");
    expect(displayCase("FISHER CONSTRUCTION GROUP")).toBe("Fisher Construction Group");
  });

  it("leaves an already-correct name alone", () => {
    expect(displayCase("Basin Electric Power Cooperative")).toBe(
      "Basin Electric Power Cooperative"
    );
    expect(displayCase("Louis Dreyfus Company")).toBe("Louis Dreyfus Company");
  });

  it("normalises city names and keeps the postal code", () => {
    expect(displayCase("BEULAH, ND")).toBe("Beulah, ND");
    expect(displayCase("blair, NE")).toBe("Blair, NE");
    expect(displayCase("JAMESTOWN, ND")).toBe("Jamestown, ND");
  });
});

describe("what must never be touched", () => {
  it("keeps short acronyms, which are the client's own names", () => {
    // Archer Daniels Midland, Basin Electric Power Cooperative.
    expect(displayCase("ADM")).toBe("ADM");
    expect(displayCase("BEPC")).toBe("BEPC");
  });

  it("keeps equipment tags and unit numbers exactly", () => {
    expect(displayCase("Gun Barrel Replacement TK-9963")).toBe("Gun Barrel Replacement TK-9963");
    expect(displayCase("DCR-1932 Siphonic Upgrades")).toBe("DCR-1932 Siphonic Upgrades");
    expect(displayCase("GFTX -DC2-0501 60MW-100MW")).toBe("GFTX -DC2-0501 60MW-100MW");
  });

  it("keeps ampersand compounds, which title case would break", () => {
    // The failure this guards against is "D&E" becoming "D&e".
    expect(displayCase("REPLACE SOFTENERS D&E")).toBe("Replace Softeners D&E");
  });

  it("keeps deliberate internal capitals", () => {
    // "SpaceX" is somebody's spelling, not a casing accident.
    expect(displayCase("SpaceX")).toBe("SpaceX");
  });
});

describe("mechanics", () => {
  it("capitalises through opening punctuation", () => {
    // The first letter sits behind a bracket; it still gets capitalised.
    expect(displayCase("piping (extraction)")).toBe("Piping (Extraction)");
  });

  it("capitalises across hyphens and slashes", () => {
    expect(displayCase("d-ring tie-off")).toBe("D-Ring Tie-Off");
  });

  it("keeps minor words lowercase unless they lead", () => {
    expect(displayCase("tank of the future")).toBe("Tank of the Future");
  });

  it("CANNOT tell a short shouted word from an acronym — the known boundary", () => {
    // `SKID` and `HOLE` are four-letter all-caps runs, and so are `ADM` and
    // `BEPC`; nothing in the string distinguishes them, so both are kept.
    // This is exactly why the rule is applied to CLIENT and LOCATION, which
    // are proper nouns, and NOT to descriptions — "REPAIR HOLE IN REBOILER"
    // would come out as "Repair HOLE IN Reboiler", which reads worse than
    // leaving it shouted. Pinned here so the limit is a decision on the
    // record rather than a surprise.
    expect(displayCase("PRE-PURIFIER SKID")).toBe("Pre-Purifier SKID");
    expect(displayCase("REPAIR HOLE IN REBOILER")).toBe("Repair HOLE IN Reboiler");
  });

  it("survives empty and whitespace-only input", () => {
    expect(displayCase("")).toBe("");
    expect(displayCase("   ")).toBe("");
  });
});
