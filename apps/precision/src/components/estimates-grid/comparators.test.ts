/**
 * Proposal-number ordering.
 *
 * Every case here is drawn from the 731 real proposal numbers, and two of
 * them encode defects that shipped and were caught in review:
 *
 *  - `parseFloat("2112.R1") === 2112`, so the screen this replaced compared a
 *    proposal EQUAL to every one of its revisions and ordered them by luck.
 *  - numeric collation parses each digit run as an integer, so `.01` and `.1`
 *    tie — the same collision, reintroduced by the collator after the
 *    `Number()` version of it had been avoided by hand.
 */
import { describe, expect, it } from "vitest";
import { compareProposalNumbers, proposalBase, proposalSuffix } from "./comparators";

const sorted = (input: string[]) => [...input].sort(compareProposalNumbers);

describe("proposal numbers", () => {
  it("orders by the base number, not by string", () => {
    expect(sorted(["1010", "999", "2112"])).toEqual(["999", "1010", "2112"]);
  });

  it("keeps a revision with the proposal it revises", () => {
    // The defect: parseFloat("2112.R1") is 2112, so these three tied.
    expect(sorted(["2113", "2112.R2", "2112", "2112.R1"])).toEqual([
      "2112",
      "2112.R1",
      "2112.R2",
      "2113",
    ]);
  });

  it("NEVER collapses .01 and .1 — both forms exist in volume", () => {
    // 125 rows use the .## form and 56 use .#; treating them as equal would
    // merge two different proposals into one position.
    expect(compareProposalNumbers("1956.01", "1956.1")).not.toBe(0);
    expect(sorted(["1956.1", "1956.01"])).toEqual(["1956.01", "1956.1"]);
  });

  it("still orders numerically within one convention", () => {
    // The plain-string fallback must only break ties, or .10 would sort
    // before .2 the way a lexical compare would have it.
    expect(sorted(["1879.10", "1879.2", "1879.1"])).toEqual(["1879.1", "1879.2", "1879.10"]);
  });

  it("handles the real suffix zoo without collapsing anything", () => {
    const forms = ["2100.CO1", "2100.CO1NR", "2100.LA", "2100.R1", "2100"];
    expect(new Set(sorted(forms)).size).toBe(forms.length);
    expect(sorted(forms)[0]).toBe("2100");
  });

  it("sorts blank and unparseable numbers last", () => {
    // Two live rows carry an empty string. Missing data is not "smallest".
    expect(sorted(["2112", "", "1010"])).toEqual(["1010", "2112", ""]);
    expect(compareProposalNumbers("", "1010")).toBeGreaterThan(0);
  });

  it("tolerates the leading space one row actually has", () => {
    expect(proposalBase(" 1821.03.02")).toBe(1821);
    expect(sorted([" 1821.03.02", "1820"])).toEqual(["1820", " 1821.03.02"]);
  });

  it("splits base from suffix for the two-weight rendering", () => {
    expect(proposalBase("2112.R1")).toBe(2112);
    expect(proposalSuffix("2112.R1")).toBe(".R1");
    expect(proposalSuffix("2112")).toBe("");
    expect(proposalBase("")).toBeNull();
  });
});
