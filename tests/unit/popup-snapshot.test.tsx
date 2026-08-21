/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIdSchema } from "../../src/shared/ids";
import { makeControlRecord, makeSessionRecord } from "../helpers/fixtures";

const session = makeSessionRecord({
  lifecycle: "stopping",
  stopRequestedAt: 1_700_000_001_000,
});

const completedSession = makeSessionRecord({
  sessionId: sessionIdSchema.parse("ses_test_completed"),
  lifecycle: "completed",
  stoppedAt: 1_700_000_060_000,
});

let listedSessions = [session, completedSession];
let savedLocale: "zh" | "en" = "zh";
const openSidePanel = vi.fn(() => Promise.resolve());

vi.mock("../../src/ui/runtime-client", () => ({
  getAppSettings: () =>
    Promise.resolve({
      ok: true,
      value: {
        schemaVersion: 4,
        key: "app",
        defaultSessionConfig: {
          responseBodySoftBudgetBytes: 1,
          responseBodyMaxBytes: 1,
          hoverDwellThresholdMs: 500,
          networkQuietWindowMs: 800,
          stepMaxWindowMs: 10_000,
          userFilterRules: [],
          extraCookieDomains: [],
        },
        locale: savedLocale,
        updatedAt: 0,
      },
    }),
  listSessions: () => Promise.resolve({ ok: true, value: listedSessions }),
  getSessionSnapshot: () =>
    Promise.resolve({
      ok: true,
      value: {
        session,
        control: makeControlRecord(session),
        steps: [],
        gaps: [],
      },
    }),
  startRecording: () => Promise.resolve({ ok: false }),
  stopRecording: vi.fn(() => Promise.resolve({ ok: true, value: {} })),
}));

const { App } = await import("../../src/ui/popup/App");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  listedSessions = [session, completedSession];
  savedLocale = "zh";
  openSidePanel.mockClear();
  vi.stubGlobal("chrome", {
    tabs: {
      query: () =>
        Promise.resolve([
          { id: 1, windowId: 1, url: "https://example.com/", title: "Example" },
        ]),
    },
    extension: { isAllowedFileSchemeAccess: () => Promise.resolve(false) },
    permissions: { request: () => Promise.resolve(true) },
    sidePanel: { open: openSidePanel },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderPopup = async (): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
    await Promise.resolve();
  });
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return { container, root };
};

const disposePopup = (container: HTMLDivElement, root: Root): void => {
  act(() => {
    root.unmount();
  });
  container.remove();
};

describe("Popup", () => {
  it("shows localized stopping feedback and disables the stop command", async () => {
    const { container, root } = await renderPopup();

    expect(container.querySelector(".ach-status-chip")?.textContent).toContain("停止中");
    // Session rows: the completed session offers a row delete button, the
    // stopping session does not (crawler-13 lifecycle gate).
    const rows = container.querySelectorAll("li.ach-session-row");
    expect(rows).toHaveLength(2);
    const rowButtons = [...container.querySelectorAll("li.ach-session-row button")];
    expect(rowButtons).toHaveLength(1);
    expect(rowButtons[0]?.getAttribute("aria-label")).toBe("删除");
    const stopButton = container.querySelector<HTMLButtonElement>(".ach-btn--danger");
    expect(stopButton?.disabled).toBe(true);
    expect(stopButton?.textContent).toContain("正在停止录制");

    disposePopup(container, root);
  });

  it("localizes standby and the side-panel command from the saved locale", async () => {
    listedSessions = [];
    const zh = await renderPopup();
    expect(zh.container.querySelector(".ach-status-chip")?.textContent).toContain("待机");
    expect(
      zh.container.querySelector<HTMLButtonElement>(".ach-btn-row .ach-btn--ghost")?.textContent,
    ).toContain("打开侧边栏");
    disposePopup(zh.container, zh.root);

    savedLocale = "en";
    const en = await renderPopup();
    expect(en.container.querySelector(".ach-status-chip")?.textContent).toContain("Standby");
    expect(
      en.container.querySelector<HTMLButtonElement>(".ach-btn-row .ach-btn--ghost")?.textContent,
    ).toContain("Side Panel");
    disposePopup(en.container, en.root);
  });

  it("closes the popup after the side panel opens successfully", async () => {
    const closePopup = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const { container, root } = await renderPopup();
    const button = container.querySelector<HTMLButtonElement>(".ach-btn-row .ach-btn--ghost");
    if (button === null) {
      throw new Error("expected the side-panel command");
    }

    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(openSidePanel).toHaveBeenCalledWith({ windowId: 1 });
    expect(closePopup).toHaveBeenCalledTimes(1);
    disposePopup(container, root);
  });

  it("keeps the popup open and reports an error when the side panel cannot open", async () => {
    const closePopup = vi.spyOn(window, "close").mockImplementation(() => undefined);
    openSidePanel.mockRejectedValueOnce(new Error("side panel unavailable"));
    const { container, root } = await renderPopup();
    const button = container.querySelector<HTMLButtonElement>(".ach-btn-row .ach-btn--ghost");
    if (button === null) {
      throw new Error("expected the side-panel command");
    }

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(closePopup).not.toHaveBeenCalled();
    expect(container.querySelector(".ach-banner--err")?.textContent).toContain(
      "侧边栏需要由用户点击打开",
    );
    disposePopup(container, root);
  });

  it("toggles the start mode dropdown and displays option descriptions", async () => {
    listedSessions = [];
    const { container, root } = await renderPopup();
    const trigger = container.querySelector<HTMLButtonElement>(".ach-split-btn__trigger");
    expect(trigger).not.toBeNull();

    // Menu initially closed
    expect(container.querySelector(".ach-dropdown-menu")).toBeNull();

    // Click trigger to open menu
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const menu = container.querySelector(".ach-dropdown-menu");
    expect(menu).not.toBeNull();
    const items = menu?.querySelectorAll(".ach-dropdown-item");
    expect(items).toHaveLength(2);

    expect(items?.[0]?.textContent).toContain("开始录制");
    expect(items?.[0]?.textContent).toContain("保留当前页面");
    expect(items?.[0]?.textContent).toContain("不刷新页面");

    expect(items?.[1]?.textContent).toContain("开始并刷新");
    expect(items?.[1]?.textContent).toContain("抓取首屏接口");
    expect(items?.[1]?.textContent).toContain("先挂载监听再自动刷新页面");

    // Click trigger again to close menu
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(container.querySelector(".ach-dropdown-menu")).toBeNull();

    disposePopup(container, root);
  });
});
