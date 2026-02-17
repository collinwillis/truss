import { config } from "@truss/eslint-config/base";

export default [
  { ignores: ["convex/_generated/**", "convex/betterAuth/_generated/**"] },
  ...config,
];
