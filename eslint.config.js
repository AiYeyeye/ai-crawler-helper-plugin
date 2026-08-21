// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config.
 *
 * Boundary rule: React may only be imported under `src/ui/`. The recording
 * core (`core/`, `persistence/`, `schemas/`, `shared/`) and the non-UI entry
 * contexts (`background/`, `content/`, `offscreen/`) must stay React-free.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/**",
      "vite.config.ts",
      "vite.content.config.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Persisted schemas must never silently default missing data.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAnyKeyword",
          message: "`as any` is forbidden.",
        },
      ],
    },
  },
  {
    // Everything under src/ EXCEPT src/ui/. Expressed as an exclusion rather
    // than a directory list so a newly added module is React-free by default.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/ui/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "React is only allowed under src/ui/." },
            { name: "react-dom", message: "React is only allowed under src/ui/." },
            { name: "react-dom/client", message: "React is only allowed under src/ui/." },
          ],
          patterns: [
            {
              group: ["react/*", "react-dom/*"],
              message: "React is only allowed under src/ui/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
