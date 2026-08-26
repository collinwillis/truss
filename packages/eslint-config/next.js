import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginReact from "eslint-plugin-react";
import globals from "globals";
import pluginNext from "@next/eslint-plugin-next";
import { config as baseConfig } from "./base.js";

/**
 * A custom ESLint configuration for libraries that use Next.js.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const nextJsConfig = [
  ...baseConfig,
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.serviceworker,
      },
    },
  },
  {
    plugins: {
      "@next/next": pluginNext,
    },
    rules: {
      ...pluginNext.configs.recommended.rules,
      ...pluginNext.configs["core-web-vitals"].rules,
    },
  },
  {
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      // React scope no longer necessary with new JSX transform.
      "react/react-in-jsx-scope": "off",
      // See react-internal.js — same rule, same reasoning, kept in step across both configs.
      "react-hooks/set-state-in-effect": "off",
      /*
       * Off with the same reasoning as above. It fires on the previous-value ref in
       * three-column-layout and the status ref synced during render in update-context, both
       * shipped desktop-shell code. Rewriting either changes render timing in production
       * update logic, which is not something to do inside a merge.
       */
      "react-hooks/refs": "off",
      "react-hooks/incompatible-library": "off",
      /*
       * Also informational: the React Compiler reporting it could not preserve a hand-written
       * useMemo, so it skipped optimising that component. Nothing is broken — the memo still
       * runs — and it fires on momentum's project route.
       */
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  {
    // `next lint` excluded build output on our behalf; Next 16 removed it and eslint runs
    // directly, so the ignores have to be stated. Without these, .next/ is linted.
    ignores: [".next/**", "out/**", "next-env.d.ts", "node_modules/**"],
  },
];
