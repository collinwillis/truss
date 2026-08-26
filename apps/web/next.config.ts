import path from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Merged from a former next.config.js and next.config.ts pair.
 *
 * Next resolves .js before .ts, so the .ts file — and with it reactStrictMode and
 * transpilePackages — had never been loaded.
 *
 * The .ts file also imported ./src/env to validate environment at build time. That import is
 * not carried over: Next evaluates this config before it loads .env files, so the check saw
 * undefined for everything and could only ever throw. Validation belongs in instrumentation or
 * a server entry point, where the environment is actually populated.
 */
const config: NextConfig = {
  reactStrictMode: true,

  // Shared monorepo packages ship TypeScript source rather than a build.
  transpilePackages: ["@truss/ui"],

  // The workspace root, so Turbopack traces files outside this app.
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

export default config;
