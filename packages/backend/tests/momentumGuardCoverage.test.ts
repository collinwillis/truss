import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every public function in `momentum.ts` checks its caller.
 *
 * WHY A STRUCTURAL TEST RATHER THAN MORE BEHAVIOURAL ONES: the #29 hardening
 * pass added guards by hand and left THIRTEEN public functions without them —
 * including `deleteProject`, which cascade-deletes a live project's every
 * progress entry, and `splitActivityToPhase`, which a viewer could use to move
 * budget between phases. `momentumProjectAccess.test.ts` proves the functions
 * somebody remembered; nothing proved the set was complete, and an audit found
 * the gap eighteen months of green tests had not.
 *
 * A behavioural test per function would be better evidence but would have the
 * same hole: it only covers the functions whoever wrote it thought of. This
 * asserts the property over the WHOLE FILE, so a new unguarded export fails on
 * the day it is written rather than on the day somebody audits.
 *
 * ⚠️ THIS IS A COARSE CHECK ON PURPOSE. It proves a guard is *mentioned*, not
 * that it is correct or that it runs before the first read. It is a floor, not a
 * ceiling — the real authorization tests live beside it and still matter.
 *
 * `internalMutation`/`internalQuery`/`internalAction` are exempt: Convex does not
 * expose them to clients at all, so their caller is already trusted.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../convex/momentum.ts", import.meta.url)),
  "utf8"
);

/** The helpers that establish who the caller is, or what they may reach. */
const GUARDS = [
  "safeGetAuthUser",
  "resolveUserScope",
  "requireProjectWrite",
  "isMomentumAdmin",
  "requirePrecisionRead",
  "requirePrecisionAdmin",
] as const;

/**
 * Exempt by argument, with the reason recorded.
 *
 * Keep this list empty if you can. An entry is a standing claim that a function
 * needs no caller check — write down why, so the next reader can disagree.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "getImportJob",
    "Addressed by an unguessable one-time token, which IS the authorization; " +
      "the job carries no proposal or project data beyond its own progress.",
  ],
]);

interface ConvexFunction {
  name: string;
  kind: string;
  line: number;
  body: string;
}

function parseFunctions(source: string): ConvexFunction[] {
  const pattern =
    /export const (\w+) = (internalMutation|internalQuery|internalAction|mutation|query|action)\(/g;
  const starts: Array<{ name: string; kind: string; index: number }> = [];
  for (const match of source.matchAll(pattern)) {
    starts.push({ name: match[1] as string, kind: match[2] as string, index: match.index });
  }
  return starts.map((entry, i) => ({
    name: entry.name,
    kind: entry.kind,
    line: source.slice(0, entry.index).split("\n").length,
    // Up to the next export is a safe over-approximation of one function's body:
    // it can only ever make this check more lenient, never falsely fail.
    body: source.slice(entry.index, starts[i + 1]?.index ?? source.length),
  }));
}

describe("momentum.ts caller checks", () => {
  const all = parseFunctions(SOURCE);
  const publicFns = all.filter((fn) => !fn.kind.startsWith("internal"));

  it("finds the functions at all, so a parser change cannot silently pass", () => {
    expect(all.length).toBeGreaterThan(40);
    expect(publicFns.length).toBeGreaterThan(30);
    // The two the audit proved were exploitable, as canaries for the parser.
    expect(publicFns.map((f) => f.name)).toContain("deleteProject");
    expect(publicFns.map((f) => f.name)).toContain("splitActivityToPhase");
  });

  it("every public function mentions a caller check", () => {
    const unguarded = publicFns
      .filter((fn) => !EXEMPT.has(fn.name))
      .filter((fn) => !GUARDS.some((guard) => fn.body.includes(guard)))
      .map((fn) => `${fn.kind} ${fn.name} (momentum.ts:${fn.line})`);

    expect(
      unguarded,
      unguarded.length === 0
        ? ""
        : `These are reachable by any caller with the deployment URL, which ships ` +
            `inside the desktop bundle:\n  ${unguarded.join("\n  ")}\n\n` +
            `Add a guard, or add an EXEMPT entry saying why none is needed.`
    ).toEqual([]);
  });

  it("keeps every exemption justified", () => {
    for (const [name, reason] of EXEMPT) {
      expect(
        publicFns.some((fn) => fn.name === name),
        `${name} no longer exists`
      ).toBe(true);
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
