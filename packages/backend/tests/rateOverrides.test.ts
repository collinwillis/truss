/**
 * D6 — who may carry a per-activity rate override.
 *
 * Confirmed with Collin as real business policy: the override exists so a body
 * that isn't craft can be priced at its own rate. Every eligible case is a
 * labor-standby or support role.
 *
 * Runs in plain Node — the predicate is deliberately free of Convex imports so it
 * can be shared with the client that disables the grid cells.
 *
 * @see docs/precision/DECISIONS.md D6
 */

import { describe, expect, it } from "vitest";

import {
  OVERRIDE_ELIGIBLE_PHASE_POOL_IDS,
  SUPPORT_WBS_POOL_ID,
  canOverrideRates,
  rateOverrideRejection,
  shareSameOverrideBasis,
} from "../convex/model/rateOverrides";

/** A pipefitting line under AG PIPING — the ordinary, ineligible case. */
const ORDINARY = { activityType: "labor", wbsPoolId: 70000, phasePoolId: 70001 };

describe("eligibility", () => {
  it("rejects an ordinary craft line", () => {
    expect(canOverrideRates(ORDINARY)).toBe(false);
  });

  it("allows any custom_labor line, wherever it sits", () => {
    expect(canOverrideRates({ ...ORDINARY, activityType: "custom_labor" })).toBe(true);
  });

  it("allows anything under the SUPPORT work breakdown", () => {
    expect(canOverrideRates({ ...ORDINARY, wbsPoolId: SUPPORT_WBS_POOL_ID })).toBe(true);
    expect(SUPPORT_WBS_POOL_ID).toBe(200000);
  });

  it("allows the three standby phase types by pool id", () => {
    // 180002 FIREWATCH, 180003 MANWATCH, 180004 TOOLS & EQUIPMENT RUNNER.
    for (const phasePoolId of [180002, 180003, 180004]) {
      expect(canOverrideRates({ ...ORDINARY, phasePoolId }), `pool ${phasePoolId}`).toBe(true);
    }
    expect([...OVERRIDE_ELIGIBLE_PHASE_POOL_IDS].sort()).toEqual([180002, 180003, 180004]);
  });

  it("does not allow neighbouring specialty phases that were not listed", () => {
    // 180000 is SPECIALTY SERVICES and 180001 / 180005 are siblings of the three
    // eligible pools. Legacy named exactly three, so the set is not a range and
    // must not be "helpfully" widened.
    for (const phasePoolId of [180000, 180001, 180005, 189999]) {
      expect(canOverrideRates({ ...ORDINARY, phasePoolId }), `pool ${phasePoolId}`).toBe(false);
    }
  });

  it("is an OR, not an AND — any single condition suffices", () => {
    expect(
      canOverrideRates({ activityType: "custom_labor", wbsPoolId: 70000, phasePoolId: 70001 })
    ).toBe(true);
    expect(canOverrideRates({ activityType: "labor", wbsPoolId: 200000, phasePoolId: 70001 })).toBe(
      true
    );
    expect(canOverrideRates({ activityType: "labor", wbsPoolId: 70000, phasePoolId: 180002 })).toBe(
      true
    );
  });

  it("eligibility depends on position, so moving an activity can change it", () => {
    // The type is the activity's own, but WBS and phase are not — which is why
    // the mutation re-derives eligibility from the stored position rather than
    // trusting whatever the caller sends.
    const line = { activityType: "material", phasePoolId: 180002 } as const;
    expect(canOverrideRates({ ...line, wbsPoolId: 70000 })).toBe(true);
    expect(
      canOverrideRates({ activityType: "material", wbsPoolId: 70000, phasePoolId: 70001 })
    ).toBe(false);
  });

  it("every activity type is ineligible in an ordinary position except custom_labor", () => {
    for (const activityType of ["labor", "material", "equipment", "subcontractor", "cost_only"]) {
      expect(canOverrideRates({ ...ORDINARY, activityType }), activityType).toBe(false);
    }
    expect(canOverrideRates({ ...ORDINARY, activityType: "custom_labor" })).toBe(true);
  });
});

describe("rejection message", () => {
  it("is null when eligible, so it can be used directly as a guard", () => {
    expect(rateOverrideRejection({ ...ORDINARY, activityType: "custom_labor" })).toBeNull();
  });

  it("names the eligible cases rather than restating pool ids at the user", () => {
    const message = rateOverrideRejection(ORDINARY);
    expect(message).not.toBeNull();
    expect(message).toMatch(/custom labor/i);
    expect(message).toMatch(/SUPPORT/);
    expect(message).toMatch(/Firewatch/i);
    // A user cannot act on a bare number.
    expect(message).not.toMatch(/180002/);
  });
});

describe("multi-select shared basis (a UI affordance, not a data rule)", () => {
  it("is true when every row already carries the same override values", () => {
    expect(
      shareSameOverrideBasis([
        { customCraftRate: 52.5, customSubsistenceRate: 10 },
        { customCraftRate: 52.5, customSubsistenceRate: 10 },
      ])
    ).toBe(true);
  });

  it("is true for rows that all inherit", () => {
    expect(shareSameOverrideBasis([{}, {}, {}])).toBe(true);
  });

  it("is false when the rows disagree, so the dialog cannot seed one value", () => {
    expect(shareSameOverrideBasis([{ customCraftRate: 52.5 }, { customCraftRate: 48 }])).toBe(
      false
    );
  });

  it("distinguishes an inherited row from one explicitly overridden to the same number", () => {
    // D3: absence means inherit, and 0 is a real $0.00/hr override. Those are
    // different states and must not be collapsed here either.
    expect(shareSameOverrideBasis([{ customCraftRate: undefined }, { customCraftRate: 0 }])).toBe(
      false
    );
  });

  it("is false for an empty selection rather than vacuously true", () => {
    expect(shareSameOverrideBasis([])).toBe(false);
  });
});
