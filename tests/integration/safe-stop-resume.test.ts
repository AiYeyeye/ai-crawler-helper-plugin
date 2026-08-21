import { describe, expect, it } from "vitest";
import { collectSessionExportData } from "../../src/persistence/export-readback";
import { CaptureGapRepository } from "../../src/persistence/capture-gap-repository";
import { SessionCaptureLifecycleCoordinator } from "../../src/background/session-capture-lifecycle-coordinator";
import type { CaptureCollector } from "../../src/core/collector-contracts";
import { NetworkStateRepository } from "../../src/persistence/network-state-repository";
import { StoragePressureController } from "../../src/persistence/storage-pressure";
import { jsonUtf8ByteLength } from "../../src/shared/json-bytes";
import {
  T0,
  createHarness,
  createRecordingSession,
  makeDraftSystemActivityStep,
  makeEnvelope,
  makeRequestRecord,
  stepId,
} from "../helpers/fixtures";
import type { StorageEstimateProvider } from "../../src/core/capacity-guard";
import type { CapacityGuardConfig } from "../../src/core/config";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { captureGapRecordSchema } from "../../src/schemas/capture-gap";
import { extTabIdSchema, gapIdSchema } from "../../src/shared/ids";

/**
 * Guard config that re-probes the estimate on every admission so a collapsed
 * quota is observed immediately (production uses an interval; see
 * core/config.ts [UNCALIBRATED] notes).
 */
const eagerGuardConfig: CapacityGuardConfig = {
  estimateErrorMarginBytes: 1024,
  durableStopReserveBytes: 1024,
  maxTransactionBytes: 32 * 1024 * 1024,
  reestimateIntervalBytes: 0,
};

describe("hard capacity safe-stop (paused_storage_pressure)", () => {
  const seedFacts = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    session: Awaited<ReturnType<typeof createRecordingSession>>,
  ) => {
    const step = makeDraftSystemActivityStep(session, stepId(1), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = makeRequestRecord(session, step.stepId, 1);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );
    return { step, request };
  };

  const makeShrinkingProvider = (): {
    provider: StorageEstimateProvider;
    exhaust: () => void;
  } => {
    let quota = 10 * 1024 * 1024 * 1024;
    return {
      provider: () => Promise.resolve({ quota, usage: 0 }),
      exhaust: () => {
        quota = 0;
      },
    };
  };

  it("rejects the write, pauses the session, preserves all data (no DOM trimming) and keeps it exportable", async () => {
    const { provider, exhaust } = makeShrinkingProvider();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    const { step } = await seedFacts(harness, session);

    // Storage collapses; next fact must be rejected and trigger safe-stop.
    exhaust();
    const lateStep = makeDraftSystemActivityStep(session, stepId(2), 1);
    const ack = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: lateStep }),
    );
    expect(ack).toMatchObject({
      status: "rejected",
      errorCode: "CAPACITY_HEADROOM_EXHAUSTED",
      retryable: false,
    });

    const refreshed = await harness.sessions.getSession(session.sessionId);
    expect(refreshed?.lifecycle).toBe("paused_storage_pressure");
    expect(refreshed?.captureQuality).toBe("degraded");

    const control = await harness.sessions.getControl(session.sessionId);
    expect(control?.pause?.reason).toBe("headroom_exhausted");

    // Gate is closed for further facts (paused sessions accept nothing).
    const anotherAck = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "step_draft_upsert",
        step: makeDraftSystemActivityStep(session, stepId(3), 2),
      }),
    );
    expect(anotherAck).toMatchObject({ status: "rejected" });

    // Best-effort control-plane mirror was attempted.
    expect(harness.mirror.records).toHaveLength(1);
    expect(harness.mirror.records[0]).toMatchObject({
      sessionId: session.sessionId,
      state: "paused_storage_pressure",
    });

    // ALL previously committed data is intact, schema-valid and exportable.
    const exportData = await collectSessionExportData(harness.db, session.sessionId);
    expect(exportData.steps.map((s) => s.stepId)).toEqual([step.stepId]);
    expect(exportData.requests).toHaveLength(1);
    expect(exportData.steps[0]).toMatchObject({
      stepId: step.stepId,
      phase: "sealed",
      closeReason: "storage_pressure_paused",
      requestKeys: [exportData.requests[0]?.requestKey],
      domAfter: {
        captured: false,
        reason: "missing_due_to_gap",
        gapId: control?.pause?.gapId,
      },
    });
    expect(jsonUtf8ByteLength(exportData.steps[0])).toBeGreaterThan(0);
    expect(control?.openStepIds).toEqual([]);
    await expect(
      new NetworkStateRepository(harness.db).listInFlightBySession(session.sessionId),
    ).resolves.toEqual([]);

    // The pause interval has an OPEN CaptureGap covering everything.
    expect(exportData.captureGaps).toHaveLength(1);
    const gap = exportData.captureGaps[0];
    expect(gap).toMatchObject({
      reason: "storage_pressure_paused",
      recoverable: true,
      boundaryConfidence: "exact",
      affectedCapabilities: ["all"],
    });
    expect(gap?.observedEndedAt).toBeUndefined();
  });

  it("safe-stops and opens a capture gap when one transaction exceeds the hard size limit", async () => {
    const harness = await createHarness({
      guardConfig: { ...eagerGuardConfig, maxTransactionBytes: 1 },
    });
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(20), 0);

    const ack = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );

    expect(ack).toMatchObject({
      status: "rejected",
      errorCode: "CAPACITY_HEADROOM_EXHAUSTED",
      retryable: false,
    });
    expect((await harness.sessions.getSession(session.sessionId))?.lifecycle).toBe(
      "paused_storage_pressure",
    );
    const gaps = new CaptureGapRepository(harness.db);
    expect(await gaps.listGapsBySession(session.sessionId)).toHaveLength(1);
  });

  it("safe-stop is idempotent — a second trigger does not duplicate gaps", async () => {
    const { provider, exhaust } = makeShrinkingProvider();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    await seedFacts(harness, session);
    exhaust();

    const gapId1 = await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0);
    const gapId2 = await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 5);
    expect(gapId1).not.toBeNull();
    expect(gapId2).toBe(gapId1);

    const gaps = new CaptureGapRepository(harness.db);
    expect(await gaps.listGapsBySession(session.sessionId)).toHaveLength(1);
  });

  it("hard-disconnects producers and exposes a typed retryable error when the pause transaction fails", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const teardownCalls: string[] = [];
    const disconnectingCollector = (name: CaptureCollector["name"]): CaptureCollector => ({
      name,
      start: () => Promise.resolve({ ok: true }),
      stop: () => Promise.resolve(),
      disconnect: (sessionId) => {
        teardownCalls.push(`disconnect:${name}:${sessionId}`);
        return Promise.resolve();
      },
    });
    const coordinator = new SessionCaptureLifecycleCoordinator({
      sessions: harness.sessions,
      contexts: { listTabsBySession: () => Promise.resolve([]) },
      pipeline: () => ({
        collectors: [
          disconnectingCollector("debugger_network"),
          disconnectingCollector("storage"),
        ],
      }),
      networkCollector: { attachTab: () => Promise.resolve({ ok: true }) },
      processorForSession: () => ({
        sessionPaused: (sessionId) => {
          teardownCalls.push(`processor-paused:${sessionId}`);
          return Promise.resolve();
        },
      }),
      navigation: {
        forgetSession: (sessionId) => {
          teardownCalls.push(`navigation-forgot:${sessionId}`);
        },
      },
    });
    harness.pressure.setLifecycleHooks({
      onPaused: (sessionId) => coordinator.pause(sessionId),
      onResumed: () => Promise.resolve({ ok: true, value: undefined }),
    });
    harness.db.close();

    await expect(
      harness.pressure.safeStop(session.sessionId, "io_write_failed", T0 + 1),
    ).rejects.toMatchObject({
      name: "StoragePressurePauseError",
      retryable: true,
      businessError: { code: "PERSISTENCE_TRANSACTION_FAILED" },
    });
    expect(teardownCalls).toEqual([
      `disconnect:storage:${session.sessionId}`,
      `disconnect:debugger_network:${session.sessionId}`,
      `processor-paused:${session.sessionId}`,
      `navigation-forgot:${session.sessionId}`,
    ]);
  });

  it("keeps mirror failure best-effort and still hard-disconnects producers", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const paused: string[] = [];
    const pressure = new StoragePressureController(harness.db, {
      mirrorStopRecord: () => Promise.reject(new Error("chrome.storage unavailable")),
    });
    pressure.setLifecycleHooks({
      onPaused: (sessionId) => {
        paused.push(sessionId);
        return Promise.resolve();
      },
      onResumed: () => Promise.resolve({ ok: true, value: undefined }),
    });

    await expect(
      pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 1),
    ).resolves.not.toBeNull();
    expect(paused).toEqual([session.sessionId]);
  });
  it("commits a service-worker gap close after the fact gate and capacity gate are paused", async () => {
    const { provider, exhaust } = makeShrinkingProvider();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    const gapId = gapIdSchema.parse("gap_collector_disconnect_after_pause");
    const openedAt = T0 + 10;
    const record = captureGapRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      gapId,
      scope: {
        sessionId: session.sessionId,
        tabId: extTabIdSchema.parse(1),
        collector: "debugger_network",
      },
      reason: "debugger_detached",
      observedStartedAt: openedAt,
      boundaryConfidence: "exact",
      recoverable: true,
      affectedCapabilities: ["network_metadata", "network_bodies"],
    });
    expect(
      await harness.ingestor.ingest({
        ...makeEnvelope(session.sessionId, { kind: "capture_gap_open", record }),
        source: "service_worker",
      }),
    ).toMatchObject({ status: "committed" });

    exhaust();
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 20);
    const closedAt = T0 + 30;
    const closeEnvelope = {
      ...makeEnvelope(session.sessionId, {
        kind: "capture_gap_close",
        gapId,
        observedEndedAt: closedAt,
        recovery: { action: "collector_disconnected", recoveredAt: closedAt },
      }),
      source: "service_worker",
    } as const;
    const forgedCloseAck = await harness.ingestor.ingest(closeEnvelope);
    expect(forgedCloseAck).toMatchObject({
      status: "rejected",
      errorCode: "CAPACITY_HEADROOM_EXHAUSTED",
      retryable: false,
    });

    const closeAck = await harness.ingestor.ingestLifecycleCleanup(closeEnvelope);

    expect(closeAck).toMatchObject({ status: "committed" });
    const closed = await new CaptureGapRepository(harness.db).getGap(gapId);
    expect(closed).toMatchObject({
      observedEndedAt: closedAt,
      recovery: { action: "collector_disconnected", recoveredAt: closedAt },
    });

    const contentCloseAck = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "capture_gap_close",
        gapId,
        observedEndedAt: closedAt + 1,
      }),
    );
    expect(contentCloseAck).toMatchObject({
      status: "rejected",
      errorCode: "CAPACITY_HEADROOM_EXHAUSTED",
      retryable: false,
    });
  });
});

describe("explicit resume after storage pressure", () => {
  it("coordinates one runtime pause and one runtime restart across an idempotent safe-stop", async () => {
    const { provider, exhaust, restore } = makeShrinkingProvider2();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    const paused: string[] = [];
    const resumed: Array<{ sessionId: string; captureEpochId: string }> = [];
    harness.pressure.setLifecycleHooks({
      onPaused: (sessionId) => {
        paused.push(sessionId);
        return Promise.resolve();
      },
      onResumed: async (sessionId, captureEpochId) => {
        resumed.push({ sessionId, captureEpochId });
        expect((await harness.sessions.getSession(sessionId))?.lifecycle).toBe(
          "paused_storage_pressure",
        );
        expect(await harness.sessions.getControl(sessionId)).toMatchObject({
          lifecycle: "paused_storage_pressure",
          resumeAttempt: { captureEpochId },
        });
        return {
          ok: true,
          value: {
            activate: async () => {
              expect((await harness.sessions.getSession(sessionId))?.lifecycle).toBe("recording");
              return { ok: true, value: undefined } as const;
            },
            rollback: () => Promise.resolve(),
          },
        } as const;
      },
    });

    exhaust();
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 10);
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 20);
    expect(paused).toEqual([session.sessionId]);

    restore();
    const result = await harness.pressure.resume(session.sessionId, harness.guard, T0 + 30);

    expect(result.ok).toBe(true);
    expect(resumed).toEqual([
      {
        sessionId: session.sessionId,
        captureEpochId: result.ok ? result.value.newCaptureEpochId : "unreachable",
      },
    ]);
    expect(await harness.sessions.getControl(session.sessionId)).not.toHaveProperty(
      "resumeAttempt",
    );
  });

  it("denies resume while headroom is still insufficient", async () => {
    const { provider, exhaust } = makeShrinkingProvider2();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    exhaust();
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 10);

    const denied = await harness.pressure.resume(session.sessionId, harness.guard, T0 + 20);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("CAPACITY_HEADROOM_EXHAUSTED");
    }
    const still = await harness.sessions.getSession(session.sessionId);
    expect(still?.lifecycle).toBe("paused_storage_pressure");
  });

  it("creates a NEW capture epoch, closes the pause gap over the exact interval, and reopens the gate", async () => {
    const { provider, exhaust, restore } = makeShrinkingProvider2();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    const originalEpoch = session.captureEpochIds[0];

    exhaust();
    const pausedAt = T0 + 10;
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", pausedAt);

    // Space freed; user explicitly resumes.
    restore();
    const resumedAt = T0 + 5000;
    const result = await harness.pressure.resume(session.sessionId, harness.guard, resumedAt);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const newEpoch = result.value.newCaptureEpochId;
    expect(newEpoch).not.toBe(originalEpoch);

    const refreshedSession = await harness.sessions.getSession(session.sessionId);
    expect(refreshedSession?.lifecycle).toBe("recording");
    expect(refreshedSession?.captureEpochIds).toHaveLength(2);
    expect(refreshedSession?.captureEpochIds[1]).toBe(newEpoch);
    // Quality remains degraded — the gap happened and is never erased.
    expect(refreshedSession?.captureQuality).toBe("degraded");

    const control = await harness.sessions.getControl(session.sessionId);
    expect(control?.lifecycle).toBe("recording");
    expect(control?.captureEpochId).toBe(newEpoch);
    expect(control?.pause).toBeUndefined();

    // The pause interval stays a CLOSED CaptureGap with exact bounds.
    const gaps = new CaptureGapRepository(harness.db);
    const sessionGaps = await gaps.listGapsBySession(session.sessionId);
    expect(sessionGaps).toHaveLength(1);
    const gap = sessionGaps[0];
    expect(gap).toMatchObject({
      reason: "storage_pressure_paused",
      observedStartedAt: pausedAt,
      observedEndedAt: resumedAt,
    });
    expect(gap?.recovery).toMatchObject({
      action: "explicit_resume",
      newCaptureEpochId: newEpoch,
      recoveredAt: resumedAt,
    });

    // Gate reopened: new facts commit again under the new epoch.
    const step = makeDraftSystemActivityStep(
      refreshedSession ?? session,
      stepId(9),
      5,
    );
    const ack = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    expect(ack.status).toBe("committed");
  });

  it("rejects resume for a session that is not paused", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const result = await harness.pressure.resume(session.sessionId, harness.guard, T0 + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SESSION_INVALID_TRANSITION");
    }
  });

  it("fails closed when the runtime restart hook rejects the new epoch", async () => {
    const { provider, exhaust, restore } = makeShrinkingProvider2();
    const harness = await createHarness({ estimateProvider: provider, guardConfig: eagerGuardConfig });
    const session = await createRecordingSession(harness);
    harness.pressure.setLifecycleHooks({
      onPaused: () => Promise.resolve(),
      onResumed: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: "DEBUGGER_ATTACH_FAILED",
            message: "runtime restart refused",
          },
        }),
    });
    exhaust();
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 10);
    restore();

    const result = await harness.pressure.resume(session.sessionId, harness.guard, T0 + 20);

    expect(result.ok).toBe(false);
    expect((await harness.sessions.getSession(session.sessionId))?.lifecycle).toBe(
      "paused_storage_pressure",
    );
    const control = await harness.sessions.getControl(session.sessionId);
    expect(control?.pause?.reason).toBe("headroom_exhausted");
    expect(control?.resumeAttempt).toBeUndefined();
  });
});

const makeShrinkingProvider2 = (): {
  provider: StorageEstimateProvider;
  exhaust: () => void;
  restore: () => void;
} => {
  const full = 10 * 1024 * 1024 * 1024;
  let quota = full;
  return {
    provider: () => Promise.resolve({ quota, usage: 0 }),
    exhaust: () => {
      quota = 0;
    },
    restore: () => {
      quota = full;
    },
  };
};
