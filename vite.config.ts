import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Main build: HTML entries (popup / sidepanel / offscreen) + service worker.
 * The MV3 service worker is declared with `"type": "module"` in manifest.json,
 * so it may statically import shared chunks emitted by Rollup.
 *
 * The content script is built separately (vite.content.config.ts) because it
 * must be a single self-contained IIFE without runtime import statements.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        popup: "popup/index.html",
        sidepanel: "sidepanel/index.html",
        offscreen: "offscreen/index.html",
        "service-worker": "src/background/service-worker.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "service-worker" ? "service-worker.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
