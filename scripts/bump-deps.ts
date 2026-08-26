#!/usr/bin/env bun
/**
 * Set dependency versions across every workspace package.json.
 *
 * Upgrades land as an explicit, reviewable diff rather than whatever a resolver picks: each
 * package is named with its target version, the existing range prefix is preserved, and every
 * manifest that declares it — dependencies, devDependencies, peerDependencies, overrides — moves
 * together. A version drifting between two manifests is how a monorepo ends up with two copies
 * of React.
 *
 * Usage: bun scripts/bump-deps.ts <pkg>@<version> [<pkg>@<version> ...]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "overrides"] as const;

/** Keep `^`, `~` or an exact pin as the author wrote it. */
function applyPrefix(existing: string, version: string): string {
  const prefix = existing.startsWith("^") ? "^" : existing.startsWith("~") ? "~" : "";
  return `${prefix}${version}`;
}

function manifestPaths(): string[] {
  const paths = [join(ROOT, "package.json")];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(ROOT, group, entry.name, "package.json");
      try {
        readFileSync(path);
        paths.push(path);
      } catch {
        // Not every directory is a package; skip the ones without a manifest.
      }
    }
  }
  return paths;
}

const targets = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const at = arg.lastIndexOf("@");
  if (at <= 0) {
    console.error(`bad argument "${arg}" — expected <pkg>@<version>`);
    process.exit(2);
  }
  targets.set(arg.slice(0, at), arg.slice(at + 1));
}
if (targets.size === 0) {
  console.error("usage: bun scripts/bump-deps.ts <pkg>@<version> [...]");
  process.exit(2);
}

let changed = 0;
const untouched = new Set(targets.keys());

for (const path of manifestPaths()) {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as Record<string, Record<string, string> | unknown>;
  let dirty = false;

  for (const field of FIELDS) {
    const block = manifest[field] as Record<string, string> | undefined;
    if (!block) continue;
    for (const [name, version] of targets) {
      const existing = block[name];
      if (existing === undefined || existing === "*" || existing.startsWith("workspace:")) continue;
      const next = applyPrefix(existing, version);
      if (existing === next) {
        untouched.delete(name);
        continue;
      }
      block[name] = next;
      untouched.delete(name);
      dirty = true;
      changed += 1;
      console.log(`  ${manifest.name as string} · ${field} · ${name}: ${existing} -> ${next}`);
    }
  }

  if (dirty) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`\n${changed} version(s) updated across the workspace.`);
if (untouched.size > 0) {
  console.log(`Not declared anywhere (check the name): ${[...untouched].join(", ")}`);
}
