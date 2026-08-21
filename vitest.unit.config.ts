import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "unit",
    // `.tsx` covers Side Panel component tests; they opt into jsdom per file
    // with a `@vitest-environment` docblock rather than switching the project.
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    environment: "node",
  },
});
