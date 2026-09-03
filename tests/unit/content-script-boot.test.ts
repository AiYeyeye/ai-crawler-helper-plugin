/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BootGlobal = typeof globalThis & {
  __aiCrawlerHelperContentBoot?: unknown;
};

const clearBoot = (): void => {
  delete (globalThis as BootGlobal).__aiCrawlerHelperContentBoot;
};

beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: () => Promise.resolve({ ok: true, value: { active: false } }),
      onMessage: { addListener: vi.fn() },
    },
  });
  clearBoot();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearBoot();
});

describe("content script boot", () => {
  it("reuses the first controller when injected a second time", async () => {
    const mod = await import("../../src/content/content-script");
    const first = mod.controller;
    const second = mod.bootContentScript();
    expect(second).toBe(first);
  });
});
