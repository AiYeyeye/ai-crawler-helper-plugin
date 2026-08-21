import { describe, expect, it } from "vitest";
import { SessionCaptureLifecycleCoordinator } from "../../src/background/session-capture-lifecycle-coordinator";
import type { CaptureCollector } from "../../src/core/collector-contracts";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { sessionTabKey, sessionTabRecordSchema } from "../../src/schemas/navigation";
import { businessError } from "../../src/shared/errors";
import { captureEpochIdSchema, extTabIdSchema } from "../../src/shared/ids";
import { T0, makeSessionRecord } from "../helpers/fixtures";

const session = makeSessionRecord();
const resumedEpoch = captureEpochIdSchema.parse("cep_resume_prepared");

const collector = (
  name: CaptureCollector["name"],
  calls: string[],
  startResult: "ok" | "fail" = "ok",
): CaptureCollector & {
  prepare: CaptureCollector["start"];
  activate: CaptureCollector["start"];
} => {
  const prepare: CaptureCollector["start"] = () => {
    calls.push(`start:${name}`);
    return Promise.resolve(
      startResult === "ok"
        ? { ok: true }
        : {
            ok: false,
            error: businessError("DEBUGGER_ATTACH_FAILED", `${name} refused restart`),
          },
    );
  };
  return {
    name,
    start: prepare,
    prepare,
    activate: () => Promise.resolve({ ok: true }),
    stop: () => Promise.resolve(),
    disconnect: (sessionId) => {
      calls.push(`disconnect:${name}:${sessionId}`);
      return Promise.resolve();
    },
  };
};

const rootTab = sessionTabRecordSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  tabKey: sessionTabKey(session.sessionId, session.rootTabId),
  sessionId: session.sessionId,
  captureEpochId: session.captureEpochIds[0],
  tabId: session.rootTabId,
  kind: "root",
  registeredAt: T0,
});

const derivedTabId = extTabIdSchema.parse(2);
const derivedTab = sessionTabRecordSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  tabKey: sessionTabKey(session.sessionId, derivedTabId),
  sessionId: session.sessionId,
  captureEpochId: session.captureEpochIds[0],
  tabId: derivedTabId,
  kind: "derived",
  evidence: {
    evidenceType: "opener_tab_id",
    evidenceId: "opener:1:2",
    sourceTabId: session.rootTabId,
  },
  registeredAt: T0 + 1,
});

describe("SessionCaptureLifecycleCoordinator", () => {
  it("hard-disconnects collectors and quiesces session-owned runtime state", async () => {
    const calls: string[] = [];
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(session) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [collector("debugger_network", calls), collector("storage", calls)],
      }),
      networkCollector: { attachTab: () => Promise.resolve({ ok: true }) },
      processorForSession: () => ({
        sessionPaused: (sessionId) => {
          calls.push(`processor-paused:${sessionId}`);
          return Promise.resolve();
        },
      }),
      navigation: {
        forgetSession: (sessionId) => {
          calls.push(`navigation-forgot:${sessionId}`);
        },
      },
    });

    await coordinator.pause(session.sessionId);

    expect(calls).toEqual([
      `disconnect:storage:${session.sessionId}`,
      `disconnect:debugger_network:${session.sessionId}`,
      `processor-paused:${session.sessionId}`,
      `navigation-forgot:${session.sessionId}`,
    ]);
  });

  it("continues every pause teardown after failures and propagates the first failure", async () => {
    const calls: string[] = [];
    const storageFailure = new Error("storage disconnect failed");
    const failingCollector = (
      name: CaptureCollector["name"],
      failure: Error,
    ): CaptureCollector => ({
      name,
      start: () => Promise.resolve({ ok: true }),
      stop: () => Promise.resolve(),
      disconnect: (sessionId) => {
        calls.push(`disconnect:${name}:${sessionId}`);
        return Promise.reject(failure);
      },
    });
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(session) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [
          failingCollector("debugger_network", new Error("debugger disconnect failed")),
          failingCollector("storage", storageFailure),
        ],
      }),
      networkCollector: { attachTab: () => Promise.resolve({ ok: true }) },
      processorForSession: () => ({
        sessionPaused: (sessionId) => {
          calls.push(`processor-paused:${sessionId}`);
          return Promise.reject(new Error("processor pause failed"));
        },
      }),
      navigation: {
        forgetSession: (sessionId) => {
          calls.push(`navigation-forgot:${sessionId}`);
          return Promise.reject(new Error("navigation cleanup failed"));
        },
      },
    });

    await expect(coordinator.pause(session.sessionId)).rejects.toBe(storageFailure);
    expect(calls).toEqual([
      `disconnect:storage:${session.sessionId}`,
      `disconnect:debugger_network:${session.sessionId}`,
      `processor-paused:${session.sessionId}`,
      `navigation-forgot:${session.sessionId}`,
    ]);
  });

  it("restarts root collectors and reattaches every derived tab", async () => {
    const calls: string[] = [];
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(session) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [collector("debugger_network", calls), collector("storage", calls)],
      }),
      networkCollector: {
        attachTab: (sessionId, tabId) => {
          calls.push(`attach:${sessionId}:${String(tabId)}`);
          return Promise.resolve({ ok: true });
        },
      },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    const prepared = await coordinator.resume(session.sessionId, resumedEpoch);
    expect(prepared.ok).toBe(true);
    expect(calls).toEqual([
      "start:debugger_network",
      "start:storage",
      `attach:${session.sessionId}:${String(derivedTabId)}`,
    ]);
    if (prepared.ok) {
      await expect(prepared.value.activate()).resolves.toEqual({ ok: true, value: undefined });
    }
  });

  it("rolls back already restarted collectors when a later collector fails", async () => {
    const calls: string[] = [];
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(session) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [
          collector("debugger_network", calls),
          collector("storage", calls, "fail"),
        ],
      }),
      networkCollector: { attachTab: () => Promise.resolve({ ok: true }) },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    const result = await coordinator.resume(session.sessionId, resumedEpoch);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("DEBUGGER_ATTACH_FAILED");
    expect(calls).toEqual([
      "start:debugger_network",
      "start:storage",
      `disconnect:debugger_network:${session.sessionId}`,
    ]);
  });

  it("rejects a resume collector that cannot prepare behind the closed fact gate", async () => {
    const calls: string[] = [];
    const legacyCollector: CaptureCollector = {
      name: "storage",
      start: () => {
        calls.push("unsafe-start");
        return Promise.resolve({ ok: true });
      },
      stop: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
    };
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(session) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab]) },
      pipeline: () => ({ collectors: [legacyCollector] }),
      networkCollector: { attachTab: () => Promise.resolve({ ok: true }) },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    const result = await coordinator.resume(session.sessionId, resumedEpoch);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("CAPTURE_PIPELINE_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it("rolls back the whole pipeline when a derived-tab attach fails", async () => {
    const calls: string[] = [];
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(session) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [collector("debugger_network", calls), collector("storage", calls)],
      }),
      networkCollector: {
        attachTab: () =>
          Promise.resolve({
            ok: false,
            error: businessError("DEBUGGER_ATTACH_FAILED", "derived attach failed"),
          }),
      },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    const result = await coordinator.resume(session.sessionId, resumedEpoch);

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      "start:debugger_network",
      "start:storage",
      `disconnect:storage:${session.sessionId}`,
      `disconnect:debugger_network:${session.sessionId}`,
    ]);
  });

  it("prepares collector state against the reserved epoch, then activates only after commit", async () => {
    const calls: string[] = [];
    const pausedSession = makeSessionRecord({ lifecycle: "paused_storage_pressure" });
    const preparable = {
      name: "storage" as const,
      start: () => Promise.resolve({ ok: true } as const),
      prepare: ({ session: preparedSession }: { session: typeof pausedSession }) => {
        calls.push(
          `prepare:${preparedSession.lifecycle}:${String(preparedSession.captureEpochIds.at(-1))}`,
        );
        return Promise.resolve({ ok: true } as const);
      },
      activate: () => {
        calls.push("activate:storage");
        return Promise.resolve({ ok: true } as const);
      },
      stop: () => Promise.resolve(),
      disconnect: (sessionId: string) => {
        calls.push(`disconnect:storage:${sessionId}`);
        return Promise.resolve();
      },
    };
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(pausedSession) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab]) },
      pipeline: () => ({ collectors: [preparable] }),
      networkCollector: { attachTab: () => Promise.resolve({ ok: true }) },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    const prepared = await coordinator.resume(pausedSession.sessionId, resumedEpoch);

    expect(prepared.ok).toBe(true);
    expect(calls).toEqual([`prepare:recording:${resumedEpoch}`]);
    if (!prepared.ok) {
      return;
    }
    await expect(prepared.value.activate()).resolves.toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([`prepare:recording:${resumedEpoch}`, "activate:storage"]);
    await prepared.value.rollback();
    await prepared.value.rollback();
    expect(calls).toEqual([
      `prepare:recording:${resumedEpoch}`,
      "activate:storage",
      `disconnect:storage:${pausedSession.sessionId}`,
    ]);
  });

  it("restores stopping collectors and derived tabs before the remaining deadline", async () => {
    const calls: string[] = [];
    const stoppingSession = makeSessionRecord({
      lifecycle: "stopping",
      stopRequestedAt: T0,
    });
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(stoppingSession) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [collector("debugger_network", calls), collector("storage", calls)],
      }),
      networkCollector: {
        attachTab: (sessionId, tabId) => {
          calls.push(`attach:${sessionId}:${String(tabId)}`);
          return Promise.resolve({ ok: true });
        },
      },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    await expect(coordinator.restoreStopping(stoppingSession.sessionId)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls).toEqual([
      "start:debugger_network",
      "start:storage",
      `attach:${stoppingSession.sessionId}:${String(derivedTabId)}`,
    ]);
  });

  it("rolls back restored stopping collectors when a derived tab cannot attach", async () => {
    const calls: string[] = [];
    const stoppingSession = makeSessionRecord({
      lifecycle: "stopping",
      stopRequestedAt: T0,
    });
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: { getSession: () => Promise.resolve(stoppingSession) },
      contexts: { listTabsBySession: () => Promise.resolve([rootTab, derivedTab]) },
      pipeline: () => ({
        collectors: [collector("debugger_network", calls), collector("storage", calls)],
      }),
      networkCollector: {
        attachTab: () =>
          Promise.resolve({
            ok: false,
            error: businessError("DEBUGGER_ATTACH_FAILED", "derived attach failed"),
          }),
      },
      processorForSession: () => undefined,
      navigation: { forgetSession: () => undefined },
    });

    const result = await coordinator.restoreStopping(stoppingSession.sessionId);

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      "start:debugger_network",
      "start:storage",
      `disconnect:storage:${stoppingSession.sessionId}`,
      `disconnect:debugger_network:${stoppingSession.sessionId}`,
    ]);
  });
});
