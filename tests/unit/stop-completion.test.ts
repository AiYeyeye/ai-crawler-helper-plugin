import { describe, expect, it } from "vitest";
import {
  completeSessionStop,
  createStopActivityTracker,
  recoverStoppingSession,
  remainingStopCompletionDelayMs,
  shouldCompleteStopEarly,
} from "../../src/core/stop-completion";
import { businessError, err, ok } from "../../src/shared/errors";
import { sessionIdSchema } from "../../src/shared/ids";

const ses = (id: string) => sessionIdSchema.parse(id);

describe("stop activity tracker", () => {
  it("records activity, count and last timestamp, and clears per session", () => {
    let now = 1_000;
    const tracker = createStopActivityTracker(() => now);
    tracker.markActivity(ses("ses_a"));
    tracker.markActivity(ses("ses_a"));
    expect(tracker.activityCount(ses("ses_a"))).toBe(2);
    expect(tracker.lastActivityAt(ses("ses_a"))).toBe(1_000);
    expect(tracker.activityCount(ses("ses_b"))).toBe(0);
    expect(tracker.lastActivityAt(ses("ses_b"))).toBeNull();
    now = 2_000;
    tracker.markActivity(ses("ses_a"));
    expect(tracker.lastActivityAt(ses("ses_a"))).toBe(2_000);
    tracker.clear(ses("ses_a"));
    expect(tracker.activityCount(ses("ses_a"))).toBe(0);
    expect(tracker.lastActivityAt(ses("ses_a"))).toBeNull();
  });
});

describe("quiescent early-exit decision", () => {
  const options = { minEarlyExitWindowMs: 4_000, quiescentWindowMs: 3_000 };
  const stopRequestedAt = 10_000;

  it("never completes before the minimum window elapses", () => {
    const tracker = createStopActivityTracker(() => 13_000);
    tracker.markActivity(ses("ses_a"));
    expect(shouldCompleteStopEarly(13_000, stopRequestedAt, tracker, ses("ses_a"), options)).toBe(
      false,
    );
  });

  it("keeps the full window when the session showed no activity at all", () => {
    const tracker = createStopActivityTracker(() => 15_000);
    expect(shouldCompleteStopEarly(15_000, stopRequestedAt, tracker, ses("ses_a"), options)).toBe(
      false,
    );
  });

  it("does not exit while facts are still arriving", () => {
    const tracker = createStopActivityTracker(() => 15_000);
    tracker.markActivity(ses("ses_a")); // at 15_000: quiet 0s
    expect(shouldCompleteStopEarly(15_000, stopRequestedAt, tracker, ses("ses_a"), options)).toBe(
      false,
    );
  });

  it("exits early after min window plus quiescent silence", () => {
    let now = 10_000;
    const tracker = createStopActivityTracker(() => now);
    now = 11_000;
    tracker.markActivity(ses("ses_a"));
    now = 15_000; // elapsed 5_000 (>= 4_000), quiet 4_000 (>= 3_000)
    expect(shouldCompleteStopEarly(now, stopRequestedAt, tracker, ses("ses_a"), options)).toBe(true);
  });

  it("restart-fresh tracker (no activity) never exits early", () => {
    // A Service Worker restarted mid-stop has a fresh tracker; the session
    // must keep the full remaining window rather than exit on silence.
    const tracker = createStopActivityTracker(() => 16_000);
    expect(shouldCompleteStopEarly(16_000, stopRequestedAt, tracker, ses("ses_a"), options)).toBe(
      false,
    );
  });
});

describe("durable stop completion deadline", () => {
  it("resumes only the remaining late-response window after a worker restart", () => {
    expect(remainingStopCompletionDelayMs(1_000, 10_000, 4_000)).toBe(7_000);
    expect(remainingStopCompletionDelayMs(1_000, 10_000, 11_001)).toBe(0);
  });

  it("does not persist a clean stop when any admitted cleanup fails", async () => {
    const calls: string[] = [];

    await expect(
      completeSessionStop({
        sealAndDrainNavigation: () => {
          calls.push("navigation");
          return Promise.resolve();
        },
        finalizeObservations: () => {
          calls.push("observations");
          return Promise.resolve();
        },
        stopCollectors: [
          () => {
            calls.push("collector-a");
            return Promise.reject(new Error("gap close rejected"));
          },
          () => {
            calls.push("collector-b");
            return Promise.resolve();
          },
        ],
        persistCleanCompletion: () => {
          calls.push("persist-clean");
          return Promise.resolve();
        },
        cleanupRuntime: () => {
          calls.push("cleanup-runtime");
        },
      }),
    ).rejects.toThrow("stop cleanup failed");

    expect(calls).toEqual([
      "navigation",
      "observations",
      "collector-a",
      "collector-b",
    ]);
  });

  it("persists clean completion only after navigation, observations and collectors drain", async () => {
    const calls: string[] = [];
    await completeSessionStop({
      sealAndDrainNavigation: () => {
        calls.push("navigation");
        return Promise.resolve();
      },
      finalizeObservations: () => {
        calls.push("observations");
        return Promise.resolve();
      },
      stopCollectors: [() => {
        calls.push("collector");
        return Promise.resolve();
      }],
      persistCleanCompletion: () => {
        calls.push("persist-clean");
        return Promise.resolve();
      },
      cleanupRuntime: () => {
        calls.push("cleanup-runtime");
      },
    });

    expect(calls).toEqual([
      "navigation",
      "observations",
      "collector",
      "persist-clean",
      "cleanup-runtime",
    ]);
  });

  it("restores stopping collectors before scheduling the remaining deadline", async () => {
    const calls: string[] = [];
    await recoverStoppingSession({
      restoreCollectors: () => {
        calls.push("restore");
        return Promise.resolve(ok(undefined));
      },
      persistDegradedRecovery: () => {
        calls.push("persist-degraded");
        return Promise.resolve();
      },
      scheduleCompletion: () => calls.push("schedule"),
    });

    expect(calls).toEqual(["restore", "schedule"]);
  });

  it("persists degraded recovery before scheduling when stopping collectors cannot restore", async () => {
    const calls: string[] = [];
    const failure = businessError("DEBUGGER_ATTACH_FAILED", "restore failed");
    await recoverStoppingSession({
      restoreCollectors: () => {
        calls.push("restore");
        return Promise.resolve(err(failure));
      },
      persistDegradedRecovery: (error) => {
        calls.push(`persist-degraded:${error.code}`);
        return Promise.resolve();
      },
      scheduleCompletion: () => calls.push("schedule"),
    });

    expect(calls).toEqual(["restore", "persist-degraded:DEBUGGER_ATTACH_FAILED", "schedule"]);
  });

  it("does not schedule a clean completion path when degraded recovery cannot persist", async () => {
    const calls: string[] = [];
    await expect(
      recoverStoppingSession({
        restoreCollectors: () =>
          Promise.resolve(err(businessError("DEBUGGER_ATTACH_FAILED", "restore failed"))),
        persistDegradedRecovery: () => {
          calls.push("persist-degraded");
          return Promise.reject(new Error("gap persistence failed"));
        },
        scheduleCompletion: () => calls.push("schedule"),
      }),
    ).rejects.toThrow("gap persistence failed");

    expect(calls).toEqual(["persist-degraded"]);
  });
});
