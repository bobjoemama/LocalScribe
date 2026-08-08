import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  /*
   * These mirror the "JavaScript build and dependency output" section of
   * `.gitignore`. ESLint's flat config does not read `.gitignore`, so the two
   * lists have to be kept in step by hand — and they had drifted: `main.js` is
   * the bundled main process that `make:mac` writes to the repository root, so
   * `npm run lint` failed with 41 errors on minified output for anyone who had
   * built before linting. `tests/eslintIgnoresBuildOutput.test.ts` now asserts
   * the correspondence through ESLint's own resolver so it cannot drift again.
   */
  globalIgnores([
    ".worker-venv/**",
    ".vite/**",
    "**/.venv/**",
    "artifacts/**",
    "coverage/**",
    "dist/**",
    "main.js",
    "node_modules/**",
    "out/**",
    "resources/python-runtime/**",
    "resources/python-runtime-windows/**",
    "src/main/generatedResourceIntegrity.ts",
  ]),
  {
    files: ["**/*.{js,cjs,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
