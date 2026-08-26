#!/usr/bin/env bun
/**
 * Typecheck a package against a recorded baseline of known errors.
 *
 * Three packages historically shipped `check-types` as an `echo`, so `tsc` never ran in CI and
 * errors accumulated unseen. Turning the real compiler back on all at once would fail the build
 * on day one, so this ratchets instead: the known errors are recorded, and the check fails only
 * when a NEW one appears. Fixing errors is then a separate, unblocked piece of work, and the
 * baseline shrinks as they go.
 *
 * Errors are compared by signature — file plus code plus message, with line and column stripped —
 * so unrelated edits that shift line numbers do not read as new failures.
 *
 * Usage: bun scripts/typecheck.ts <tsconfig-path> <baseline-name> [--update]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASELINE_DIR = join(import.meta.dir, "typecheck-baselines");

/** One error reduced to what stays stable across unrelated edits. */
function signature(line: string): string {
  return line.replace(/\((\d+),(\d+)\)/, "").trim();
}

/**
 * Run `tsc --noEmit` and return each diagnostic's stable signature.
 *
 * @param tsconfig - Path to the project's tsconfig
 */
async function collectErrors(tsconfig: string): Promise<string[]> {
  const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", tsconfig], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return `${out}${err}`
    .split("\n")
    .filter((line) => /error TS\d+/.test(line))
    .map(signature)
    .sort();
}

function readBaseline(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** Count occurrences, so a second copy of a known error still reads as new. */
function tally(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

const [tsconfig, name, ...flags] = process.argv.slice(2);
if (!tsconfig || !name) {
  console.error("usage: bun scripts/typecheck.ts <tsconfig-path> <baseline-name> [--update]");
  process.exit(2);
}

const baselinePath = join(BASELINE_DIR, `${name}.txt`);
const current = await collectErrors(tsconfig);

if (flags.includes("--update")) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, current.length > 0 ? `${current.join("\n")}\n` : "");
  console.log(`${name}: baseline updated — ${current.length} known errors recorded`);
  process.exit(0);
}

const baseline = readBaseline(baselinePath);
const currentCounts = tally(current);
const baselineCounts = tally(baseline);

const added: string[] = [];
for (const [sig, count] of currentCounts) {
  const known = baselineCounts.get(sig) ?? 0;
  for (let i = known; i < count; i += 1) added.push(sig);
}
const fixed: string[] = [];
for (const [sig, count] of baselineCounts) {
  const still = currentCounts.get(sig) ?? 0;
  for (let i = still; i < count; i += 1) fixed.push(sig);
}

if (added.length > 0) {
  console.error(`${name}: ${added.length} NEW type error(s) — not in the baseline:\n`);
  for (const sig of added) console.error(`  ${sig}`);
  console.error(
    `\nFix them, or re-record with: bun scripts/typecheck.ts ${tsconfig} ${name} --update`
  );
  process.exit(1);
}

if (fixed.length > 0) {
  console.log(
    `${name}: ${current.length} known errors (${fixed.length} fixed since the baseline).`
  );
  console.log(`Shrink the baseline with: bun scripts/typecheck.ts ${tsconfig} ${name} --update`);
} else {
  console.log(`${name}: ${current.length} known errors, no new ones.`);
}
