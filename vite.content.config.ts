import { defineConfig } from "vite";

/**
 * Content script build: single-file IIFE, no code splitting, no runtime
 * `import` statements (content scripts are injected into page frames and
 * cannot rely on module resolution inside the extension bundle).
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: "src/content/content-script.ts",
      output: {
        format: "iife",
        entryFileNames: "content-script.js",
        inlineDynamicImports: true,
      },
    },
  },
});
