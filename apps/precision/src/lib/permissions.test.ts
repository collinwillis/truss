/**
 * The client's reading of docs/ACCESS.md for Precision. The server decides;
 * these tests pin the UI to the same table so it never offers what the server
 * refuses, nor hides what it allows.
 */
import type { EffectiveAppAccess } from "@truss/features/access/types";
import type { OrganizationRole, WorkspaceContext } from "@truss/features/organizations/types";
import { describe, expect, it } from "vitest";
import {
  canEditEstimate,
  canOpenPrecision,
  canStartEstimate,
  estimateAccessOf,
  isAdmin,
} from "./permissions";

function workspace(role: OrganizationRole | null, access: EffectiveAppAccess): WorkspaceContext {
  return {
    organization_id: "org_1",
    organization_name: "InDemand",
    organization_slug: "indemand",
    role,
    precisionAccess: access,
    momentumAccess: "assigned",
    suspended: false,
    precision_permission: "none",
    momentum_permission: "none",
    allowed_domains: null,
    auto_join_enabled: false,
  };
}

describe("opening Precision", () => {
  it("walls off No access and nobody else", () => {
    expect(canOpenPrecision(workspace("member", "none"))).toBe(false);
    expect(canOpenPrecision(workspace("member", "assigned"))).toBe(true);
    expect(canOpenPrecision(workspace("member", "view_all"))).toBe(true);
    expect(canOpenPrecision(workspace("member", "edit_all"))).toBe(true);
    expect(canOpenPrecision(workspace("admin", "full"))).toBe(true);
  });

  it("walls off a workspace that has not resolved", () => {
    expect(canOpenPrecision(null)).toBe(false);
  });
});

describe("starting an estimate", () => {
  it("is open to Only assigned, so they can get work in", () => {
    expect(canStartEstimate(workspace("member", "assigned"))).toBe(true);
  });

  it("is closed to Can view all, the read-only seat", () => {
    expect(canStartEstimate(workspace("member", "view_all"))).toBe(false);
  });

  it("follows edit-all and full access", () => {
    expect(canStartEstimate(workspace("member", "edit_all"))).toBe(true);
    expect(canStartEstimate(workspace("owner", "full"))).toBe(true);
    expect(canStartEstimate(workspace("member", "none"))).toBe(false);
  });
});

describe("admin", () => {
  it("is the role, not the app access", () => {
    expect(isAdmin(workspace("owner", "full"))).toBe(true);
    expect(isAdmin(workspace("admin", "full"))).toBe(true);
    expect(isAdmin(workspace("member", "edit_all"))).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});

describe("one estimate", () => {
  it("is editable at full and edit, and not at view", () => {
    expect(canEditEstimate("full")).toBe(true);
    expect(canEditEstimate("edit")).toBe(true);
    expect(canEditEstimate("view")).toBe(false);
  });

  it("is unknown, so not editable, while loading", () => {
    expect(estimateAccessOf(undefined, "p1")).toBeNull();
    expect(canEditEstimate(estimateAccessOf(undefined, "p1"))).toBe(false);
  });

  it("ignores the previous estimate's answer while the next one loads", () => {
    expect(estimateAccessOf({ _id: "p1", access: "edit" }, "p2")).toBeNull();
    expect(estimateAccessOf({ _id: "p2", access: "view" }, "p2")).toBe("view");
  });
});
