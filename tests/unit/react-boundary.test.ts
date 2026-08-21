import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Gate 5 (subtask 06): React may only appear under `src/ui/`.
 *
 * `eslint.config.js` enforces this with `no-restricted-imports`. This test is
 * the second lock: it fails even if the lint config is loosened or the file is
 * excluded from a lint run, and it does not depend on ESLint being invoked.
 */

const SRC = join(process.cwd(), "src");
const UI_PREFIX = `ui${sep}`;

const REACT_IMPORT = /\bfrom\s+["'](react|react-dom)(\/[^"']*)?["']/u;
const REACT_REQUIRE = /\brequire\(\s*["'](react|react-dom)(\/[^"']*)?["']\s*\)/u;

const listSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSources(full);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  });

describe("React boundary", () => {
  const sources = listSources(SRC);
  const nonUi = sources.filter((file) => !relative(SRC, file).startsWith(UI_PREFIX));
  const ui = sources.filter((file) => relative(SRC, file).startsWith(UI_PREFIX));

  it("scans both sides of the boundary", () => {
    expect(nonUi.length).toBeGreaterThan(0);
    expect(ui.length).toBeGreaterThan(0);
  });

  it.each(nonUi)("%s does not import React", (file) => {
    const source = readFileSync(file, "utf8");
    expect(REACT_IMPORT.test(source)).toBe(false);
    expect(REACT_REQUIRE.test(source)).toBe(false);
  });

  it("keeps the lint rule that mirrors this assertion", () => {
    const config = readFileSync(join(process.cwd(), "eslint.config.js"), "utf8");
    expect(config).toContain("no-restricted-imports");
    expect(config).toContain('ignores: ["src/ui/**"]');
  });
});
