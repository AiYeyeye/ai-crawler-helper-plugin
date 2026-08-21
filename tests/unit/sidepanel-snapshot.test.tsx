/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureGapRecord } from "../../src/schemas/capture-gap";
import type { SessionRecord } from "../../src/schemas/session";
import type { StoredStep } from "../../src/schemas/step";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import {
  attachEpochSchema,
  cdpSessionIdSchema,
  cdpTargetIdSchema,
  gapIdSchema,
  sessionIdSchema,
  type StepId,
} from "../../src/shared/ids";
import {
  defaultSessionConfig,
  makeControlRecord,
  makeSealedUserActionStep,
  makeSessionRecord,
  stepId,
} from "../helpers/fixtures";

/**
 * Gate 4 (subtask 06 / design 3.4): the Side Panel must be fully rebuildable
 * from repository snapshots. Closing and reopening it — a real unmount and
 * remount, since a Side Panel is torn down when dismissed — must reproduce
 * the same view, and a review edit must be visible only after the repository
 * reports it, never from optimistic local state.
 */

const session: SessionRecord = makeSessionRecord({ captureQuality: "degraded" });

const gap: CaptureGapRecord = {
  schemaVersion: SCHEMA_VERSION,
  gapId: gapIdSchema.parse("gap_panel_1"),
  scope: {
    sessionId: session.sessionId,
    tabId: session.rootTabId,
    collector: "debugger_network",
    cdpTarget: {
      targetId: cdpTargetIdSchema.parse("target-oopif-panel"),
      sessionId: cdpSessionIdSchema.parse("child-session-panel"),
      attachEpoch: attachEpochSchema.parse(7),
    },
  },
  reason: "debugger_detached",
  observedStartedAt: session.startedAt + 500,
  observedEndedAt: session.startedAt + 900,
  boundaryConfidence: "exact",
  recoverable: true,
  affectedCapabilities: ["network_metadata"],
  recovery: {
    action: "target_destroyed",
    recoveredAt: session.startedAt + 900,
  },
};

/** In-memory stand-in for the repositories behind the message protocol. */
const store = {
  currentSession: session,
  otherSessions: [] as SessionRecord[],
  steps: [] as StoredStep[],
  reviewCalls: 0,
  stopCalls: 0,
  deleteCalls: 0,
  locale: "zh" as "zh" | "en",
  stop: () => Promise.resolve({ ok: true as const, value: {} }),
  reset(): void {
    this.currentSession = session;
    this.otherSessions = [];
    this.steps = [
      makeSealedUserActionStep(session, stepId(1), 1, {
        locators: { ariaName: "登录" },
        requestKeys: ["req-1"],
      }),
      makeSealedUserActionStep(session, stepId(2), 2, {
        locators: { ariaName: "结算" },
        excluded: true,
        note: "误点",
      }),
    ];
    this.reviewCalls = 0;
    this.stopCalls = 0;
    this.deleteCalls = 0;
    this.locale = "zh";
    this.stop = () => Promise.resolve({ ok: true as const, value: {} });
  },
};

const appSettings = () => ({
  schemaVersion: SCHEMA_VERSION,
  key: "app" as const,
  defaultSessionConfig: defaultSessionConfig(),
  locale: store.locale,
  updatedAt: session.startedAt,
});

vi.mock("../../src/ui/runtime-client", () => ({
  listSessions: () =>
    Promise.resolve({ ok: true, value: [store.currentSession, ...store.otherSessions] }),
  getSessionSnapshot: (sessionId: SessionRecord["sessionId"]) => {
    const selected = [store.currentSession, ...store.otherSessions].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (selected === undefined) {
      return Promise.resolve({
        ok: false as const,
        error: { code: "SESSION_NOT_FOUND" as const, message: "missing test session" },
      });
    }
    return Promise.resolve({
      ok: true,
      value: {
        session: selected,
        control: makeControlRecord(selected),
        steps: selected.sessionId === store.currentSession.sessionId ? store.steps : [],
        gaps: selected.sessionId === store.currentSession.sessionId ? [gap] : [],
      },
    });
  },
  getStepDetail: (id: StepId) =>
    Promise.resolve({
      ok: true,
      value: {
        step: store.steps.find((step) => step.stepId === id) ?? store.steps[0],
        requests: [],
        storageDiffs: [],
      },
    }),
  updateStepReview: (input: { stepId: StepId; excluded?: boolean; note?: string | null }) => {
    store.reviewCalls += 1;
    store.steps = store.steps.map((step) =>
      step.stepId === input.stepId
        ? {
            ...step,
            ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
            ...(input.note === undefined
              ? {}
              : input.note === null
                ? { note: undefined }
                : { note: input.note }),
          }
        : step,
    );
    return Promise.resolve({ ok: true, value: { ack: "ok" } });
  },
  stopRecording: () => {
    store.stopCalls += 1;
    return store.stop();
  },
  deleteSession: () => {
    store.deleteCalls += 1;
    return Promise.resolve({ ok: true, value: {} });
  },
  resumeAfterStoragePressure: () => Promise.resolve({ ok: true, value: {} }),
  getAppSettings: () => Promise.resolve({ ok: true, value: appSettings() }),
  updateAppSettings: () => Promise.resolve({ ok: false, error: { code: "SESSION_NOT_FOUND", message: "n/a" } }),
  updateLocale: (locale: "zh" | "en") => {
    store.locale = locale;
    return Promise.resolve({ ok: true, value: appSettings() });
  },
}));

const { App } = await import("../../src/ui/sidepanel/App");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

/** Let queued promises and their re-renders settle. */
const settle = async (rounds = 6): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const mount = async (): Promise<void> => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
    await Promise.resolve();
  });
  await settle();
};

const unmount = (): void => {
  act(() => {
    root.unmount();
  });
  container.remove();
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(session.startedAt + 60_000);
  store.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Side Panel rebuilds entirely from repository snapshots", () => {
  it("updates the whole side-panel shell immediately when the locale changes", async () => {
    await mount();

    expect(container.querySelector(".ach-brand-kicker")?.textContent).toBe("遥测面板");
    expect(container.querySelector(".ach-brand-title")?.textContent).toBe("录制检查");

    const settingsTab = [...container.querySelectorAll<HTMLButtonElement>(".ach-tabs button")]
      .find((button) => button.textContent?.includes("设置"));
    if (settingsTab === undefined) {
      throw new Error("expected the settings tab");
    }
    act(() => {
      settingsTab.click();
    });
    await settle();

    const englishButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "EN");
    if (englishButton === undefined) {
      throw new Error("expected the English locale button");
    }
    await act(async () => {
      englishButton.click();
      await Promise.resolve();
    });
    await settle();

    expect(store.locale).toBe("en");
    expect(container.querySelector(".ach-brand-kicker")?.textContent).toBe("Telemetry Deck");
    expect(container.querySelector(".ach-brand-title")?.textContent).toBe("Recording Inspector");
    expect(container.querySelector(".ach-tabs")?.textContent).toContain("Timeline");
    expect(container.querySelector(".ach-tabs")?.textContent).toContain("Settings");
    unmount();
  });

  it("renders timeline, quality and counters from the snapshot", async () => {
    await mount();
    const html = container.innerHTML;

    expect(container.querySelectorAll('[data-testid="step-card"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="capture-quality-value"]')?.textContent).toBe(
      "有盲区",
    );
    expect(container.querySelectorAll('[data-testid="capture-gap"]')).toHaveLength(1);
    expect(html).toContain("调试器断开");
    expect(container.querySelector('[data-testid="session-counters"]')?.textContent).toContain(
      "已提交事实 12",
    );
    unmount();
  });

  it("shows CDP target identity and a terminal state instead of recovered", async () => {
    await mount();
    const renderedGap = container.querySelector('[data-testid="capture-gap"]');

    expect(renderedGap?.textContent).toContain("target-oopif-panel");
    expect(renderedGap?.textContent).toContain("child-session-panel");
    expect(renderedGap?.textContent).toContain("attach epoch 7");
    expect(renderedGap?.getAttribute("data-gap-resolution")).toBe("terminal");
    expect(renderedGap?.textContent).not.toContain("target_destroyed");
    unmount();
  });

  it("reproduces the same view after a close/reopen cycle", async () => {
    await mount();
    const first = container.innerHTML;
    unmount();

    await mount();
    const second = container.innerHTML;
    unmount();

    expect(second).toBe(first);
  });

  it("keeps an expanded step's review state after reopening", async () => {
    await mount();
    const cards = container.querySelectorAll('[data-testid="step-card"]');
    const excludedCard = [...cards].find(
      (card) => card.getAttribute("data-step-id") === stepId(2),
    );
    expect(excludedCard?.getAttribute("data-excluded")).toBe("true");
    unmount();

    await mount();
    const reopened = [...container.querySelectorAll('[data-testid="step-card"]')].find(
      (card) => card.getAttribute("data-step-id") === stepId(2),
    );
    expect(reopened?.getAttribute("data-excluded")).toBe("true");
    expect(reopened?.textContent).toContain("已排除");
    unmount();
  });

  it("shows a review edit only after the repository reports it", async () => {
    await mount();
    const card = [...container.querySelectorAll('[data-testid="step-card"]')].find(
      (candidate) => candidate.getAttribute("data-step-id") === stepId(1),
    );
    expect(card?.getAttribute("data-excluded")).toBe("false");

    // Expand, then exclude.
    await act(async () => {
      card?.querySelector("button")?.click();
      await Promise.resolve();
    });
    await settle();

    const excludeButton = [...(card?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("标记为误操作并排除"),
    );
    expect(excludeButton).toBeDefined();
    await act(async () => {
      excludeButton?.click();
      await Promise.resolve();
    });
    await settle();

    expect(store.reviewCalls).toBe(1);
    const updated = [...container.querySelectorAll('[data-testid="step-card"]')].find(
      (candidate) => candidate.getAttribute("data-step-id") === stepId(1),
    );
    expect(updated?.getAttribute("data-excluded")).toBe("true");
    unmount();
  });

  it("renders a deterministic fact summary in the expanded step", async () => {
    await mount();
    const card = [...container.querySelectorAll('[data-testid="step-card"]')].find(
      (candidate) => candidate.getAttribute("data-step-id") === stepId(1),
    );
    await act(async () => {
      card?.querySelector("button")?.click();
      await Promise.resolve();
    });
    await settle();

    const summaryText = container.querySelector('[data-testid="fact-summary-text"]')?.textContent;
    expect(summaryText).toContain("#1 click → 登录");
    expect(summaryText).toContain("请求数: 1");
    unmount();

    // Same snapshot, same summary — verbatim.
    await mount();
    const reopenedCard = [...container.querySelectorAll('[data-testid="step-card"]')].find(
      (candidate) => candidate.getAttribute("data-step-id") === stepId(1),
    );
    await act(async () => {
      reopenedCard?.querySelector("button")?.click();
      await Promise.resolve();
    });
    await settle();
    expect(
      container.querySelector('[data-testid="fact-summary-text"]')?.textContent,
    ).toBe(summaryText);
    unmount();
  });

  it("shows immediate stopping feedback and prevents repeat clicks while the command is pending", async () => {
    const deferred: {
      resolve?: (value: { ok: true; value: Record<string, never> }) => void;
    } = {};
    store.stop = () =>
      new Promise((resolve) => {
        deferred.resolve = resolve;
      });
    await mount();
    const stopButton = container.querySelector<HTMLButtonElement>("button.ach-btn--danger");
    expect(stopButton).not.toBeNull();

    act(() => {
      stopButton?.click();
    });

    expect(store.stopCalls).toBe(1);
    expect(stopButton?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="stop-feedback"]')).not.toBeNull();
    act(() => {
      stopButton?.click();
    });
    expect(store.stopCalls).toBe(1);

    if (deferred.resolve === undefined) {
      throw new Error("stop resolver was not installed");
    }
    await act(async () => {
      deferred.resolve?.({ ok: true, value: {} });
      await Promise.resolve();
    });
    await settle();
    unmount();
  });

  it("reconstructs stopping feedback from the durable session lifecycle after reopen", async () => {
    store.currentSession = { ...session, lifecycle: "stopping" };

    await mount();

    expect(container.querySelector('[data-testid="stop-feedback"]')).not.toBeNull();
    expect(container.querySelector("button.ach-btn--danger")).toBeNull();
    unmount();
  });

  it("does not carry a pending stop request into another selected session", async () => {
    const secondSession = makeSessionRecord({
      sessionId: sessionIdSchema.parse("ses_panel_second"),
      originUrl: "https://second.example.test/",
    });
    store.otherSessions = [secondSession];
    store.stop = () => new Promise(() => undefined);
    await mount();

    const firstStop = container.querySelector<HTMLButtonElement>("button.ach-btn--danger");
    act(() => {
      firstStop?.click();
    });
    expect(container.querySelector('[data-testid="stop-feedback"]')).not.toBeNull();

    const sessionSelect = container.querySelector<HTMLSelectElement>("select.ach-select");
    await act(async () => {
      if (sessionSelect === null) {
        throw new Error("expected session selector");
      }
      sessionSelect.value = secondSession.sessionId;
      sessionSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await settle();

    expect(container.querySelector('[data-testid="stop-feedback"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>("button.ach-btn--danger")?.disabled).toBe(
      false,
    );
    unmount();
  });
});

describe("Session deletion (crawler-13)", () => {
  const deleteButtonText = (html: string): boolean => html.includes("删除会话");

  const openDeleteDialog = (): HTMLButtonElement | undefined => {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("删除会话"),
    );
    act(() => {
      button?.click();
    });
    return button;
  };

  it("offers delete for interrupted sessions via the in-app dialog", async () => {
    store.currentSession = makeSessionRecord({
      lifecycle: "interrupted",
      captureQuality: "degraded",
    });
    await mount();

    expect(deleteButtonText(container.innerHTML)).toBe(true);
    expect(container.querySelector('[data-testid="confirm-dialog"]')).toBeNull();

    const confirmSpy = vi.spyOn(window, "confirm");
    openDeleteDialog();
    await settle();
    // In-app dialog, not the native browser confirm.
    expect(container.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled(); // native confirm must not be used

    // Cancel keeps the session.
    const cancelButton = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="confirm-dialog"] button')].find(
      (button) => button.textContent?.includes("取消"),
    );
    act(() => {
      cancelButton?.click();
    });
    await settle();
    expect(store.deleteCalls).toBe(0);
    expect(container.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    unmount();
  });

  it("deletes after in-app confirmation", async () => {
    store.currentSession = makeSessionRecord({
      lifecycle: "interrupted",
      captureQuality: "degraded",
    });
    await mount();

    openDeleteDialog();
    await settle();
    const confirmButton = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="confirm-dialog"] button')].find(
      (button) => button.textContent?.includes("删除"),
    );
    act(() => {
      confirmButton?.click();
    });
    await settle();
    expect(store.deleteCalls).toBe(1);
    unmount();
  });

  it("does not offer delete while recording", async () => {
    store.currentSession = makeSessionRecord({ lifecycle: "recording" });
    await mount();
    expect(deleteButtonText(container.innerHTML)).toBe(false);
    unmount();
  });
});
