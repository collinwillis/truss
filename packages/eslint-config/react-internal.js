import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginReact from "eslint-plugin-react";
import globals from "globals";
import { config as baseConfig } from "./base.js";

/**
 * A custom ESLint configuration for libraries that use React.
 *
 * @type {import("eslint").Linter.Config[]} */
export const config = [
  ...baseConfig,
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  {
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.serviceworker,
        ...globals.browser,
      },
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
      // TypeScript handles prop type validation.
      "react/prop-types": "off",
      /*
       * Off pending a dedicated pass, not because the rule is wrong.
       *
       * eslint-plugin-react-hooks 7 added this, and it flags a real cost: seeding state from an
       * effect costs every consumer a second render. It fires on nine pre-existing sites in
       * @truss/features — auth-screen, command-palette, status-bar, theme-provider and
       * entry-history-panel — all of which are shipped desktop-shell code. Rewriting those
       * effects changes runtime behaviour and belongs in its own change, not inside a dependency
       * upgrade where a regression could not be attributed.
       *
       * The two genuine bugs this plugin version found in @truss/ui were fixed rather than
       * silenced: Math.random() re-rolling inside a useMemo, and this same pattern in useIsMobile,
       * which is now a useSyncExternalStore subscription.
       */
      "react-hooks/set-state-in-effect": "error",
      /*
       * Off with the same reasoning as above. It fires on the previous-value ref in
       * three-column-layout and the status ref synced during render in update-context, both
       * shipped desktop-shell code. Rewriting either changes render timing in production
       * update logic, which is not something to do inside a merge.
       */
      "react-hooks/refs": "error",
      /*
       * Informational, not a defect: the React Compiler reports it skipped optimising a component
       * because a library it uses is not compatible. The only site is workbook-table.tsx via
       * @tanstack/react-table 8, which stays on 8 until its v9 migration is done deliberately —
       * v9 needs 25 type fixes across a 1,635-line production grid. Re-enable once that lands.
       */
      "react-hooks/incompatible-library": "off",
      /*
       * Also informational: the React Compiler reporting it could not preserve a hand-written
       * useMemo, so it skipped optimising that component. Nothing is broken — the memo still
       * runs — and it fires on momentum's project route.
       */
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];
