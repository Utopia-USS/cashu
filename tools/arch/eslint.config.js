// ESLint exists here for one reason: eslint-plugin-react-hooks, whose recommended set carries the
// React Compiler diagnostics (purity, refs, set-state-in-render, immutability, ...). Biome has no
// equivalent. Everything else (format, imports, layers) is Biome and dependency-cruiser.
// Run from the repo root: `eslint --config tools/arch/eslint.config.js <files>`.
import { fileURLToPath } from "node:url";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** React code: components (.tsx) and hooks (use*.ts). */
export const REACT_FILES = [
  "packages/**/*.tsx",
  "apps/**/*.tsx",
  "packages/**/use[A-Z]*.ts",
  "apps/**/use[A-Z]*.ts",
];

export default [
  {
    basePath: repoRoot,
    ignores: ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "frontend/**"],
  },
  {
    basePath: repoRoot,
    files: REACT_FILES,
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // A missing dependency is a stale-closure bug, not a style nit.
      "react-hooks/exhaustive-deps": "error",
      // Opting a component out of the compiler is a decision, not an accident.
      "react-hooks/unsupported-syntax": "error",
      "react-hooks/incompatible-library": "error",
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
];
