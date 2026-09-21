#!/usr/bin/env bun
/**
 * Resolve a conflicted package.json by unioning both sides' dependency blocks.
 *
 * A manifest conflict during a merge is almost never a disagreement about intent — one side
 * upgraded versions, the other added packages, and the text collided. Hand-editing five of them
 * invites a dropped dependency that only surfaces at runtime, so this reads both stages from the
 * index and merges them by rule: every key either side declares is kept, and where both declare
 * one, the higher version wins. Non-dependency fields fall back to ours, with any difference
 * reported rather than silently chosen.
 *
 * Usage: bun scripts/resolve-manifest-conflict.ts <path-to-package.json>
 */

import { writeFileSync } from "node:fs";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "overrides"] as const;

type Manifest = Record<string, unknown>;

async function stage(path: string, which: 2 | 3): Promise<Manifest> {
  const proc = Bun.spawn(["git", "show", `:${which}:${path}`], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(text) as Manifest;
}

/** Compare two npm range strings by their numeric parts, ignoring the range prefix. */
function isHigher(a: string, b: string): boolean {
  const parts = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const [l, r] = [x[i] ?? 0, y[i] ?? 0];
    if (l !== r) return l > r;
  }
  return false;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/resolve-manifest-conflict.ts <path-to-package.json>");
  process.exit(2);
}

const ours = await stage(path, 2);
const theirs = await stage(path, 3);
const merged: Manifest = { ...theirs, ...ours };

/*
 * `exports` is a union, not a preference. Each side added subpath entries the other does not
 * have, and dropping either half breaks an import that resolves today — which a manifest merge
 * would otherwise hide until runtime.
 */
for (const field of ["exports", "peerDependenciesMeta"] as const) {
  const a = ours[field] as Record<string, unknown> | undefined;
  const b = theirs[field] as Record<string, unknown> | undefined;
  if (!a && !b) continue;
  const union: Record<string, unknown> = { ...(b ?? {}), ...(a ?? {}) };
  for (const key of Object.keys(union)) {
    if (a && !(key in a)) console.log(`  + ${field}["${key}"] (only on the incoming side)`);
  }
  merged[field] = Object.fromEntries(Object.entries(union).sort(([x], [y]) => x.localeCompare(y)));
}

for (const field of DEP_FIELDS) {
  const a = (ours[field] ?? {}) as Record<string, string>;
  const b = (theirs[field] ?? {}) as Record<string, string>;
  if (Object.keys(a).length === 0 && Object.keys(b).length === 0) continue;

  const out: Record<string, string> = {};
  for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const mine = a[name];
    const yours = b[name];
    if (mine === undefined) {
      out[name] = yours!;
      console.log(`  + ${field}.${name} ${yours} (only on the incoming side)`);
    } else if (yours === undefined || mine === yours) {
      out[name] = mine;
    } else if (isHigher(mine, yours)) {
      out[name] = mine;
      console.log(`  ↑ ${field}.${name} ${yours} -> ${mine}`);
    } else {
      out[name] = yours;
      console.log(`  ↑ ${field}.${name} ${mine} -> ${yours} (incoming was newer)`);
    }
  }
  merged[field] = out;
}

// Anything outside the dependency blocks that genuinely differs is worth a human's eye.
for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
  if ((DEP_FIELDS as readonly string[]).includes(key)) continue;
  if (key === "exports" || key === "peerDependenciesMeta") continue;
  const a = JSON.stringify(ours[key]);
  const b = JSON.stringify(theirs[key]);
  if (a !== b)
    console.log(
      `  ! "${key}" differs — kept ours: ${a ?? "(absent)"} / theirs: ${b ?? "(absent)"}`
    );
}

writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`  resolved ${path}`);
