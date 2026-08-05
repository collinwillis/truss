import { describe, expect, it } from "vitest";
import { currencyFmt, hoursFmt, moneyFmt, quantityFmt } from "./grid-figures";

/**
 * The contract these formatters exist to keep.
 *
 * Precision draws the same estimate at three depths, and the fastest thing an
 * estimator notices is a figure that changes shape on the way down. Each report
 * used to carry its own copy of these rules; the copies drifted, and nothing
 * caught it. These are the rules, stated once, so a change to any of them has to
 * be deliberate enough to edit a test.
 */

describe("man-hours", () => {
  it("always carry exactly one decimal, so no hour figure can be read as money", () => {
    expect(hoursFmt.format(12)).toBe("12.0");
    expect(hoursFmt.format(0.5)).toBe("0.5");
    expect(hoursFmt.format(1234.5)).toBe("1,234.5");
  });

  it("round to the tenth — the precision lives in the constant, not in the product", () => {
    expect(hoursFmt.format(0.0625)).toBe("0.1");
    expect(hoursFmt.format(1234.56)).toBe("1,234.6");
  });
});

describe("money", () => {
  it("never carries a decimal, which is what keeps it apart from hours", () => {
    expect(moneyFmt.format(1234)).toBe("1,234");
    expect(moneyFmt.format(1234.56)).toBe("1,235");
  });

  it("carries the currency symbol only where a total does", () => {
    expect(moneyFmt.format(1234)).not.toContain("$");
    expect(currencyFmt.format(1234)).toBe("$1,234");
    expect(currencyFmt.format(1234.56)).toBe("$1,235");
  });
});

describe("quantities", () => {
  it("print what was measured, to the same precision the editable cell shows", () => {
    expect(quantityFmt.format(1234)).toBe("1,234");
    expect(quantityFmt.format(2.5)).toBe("2.5");
    expect(quantityFmt.format(0.0625)).toBe("0.0625");
  });
});
