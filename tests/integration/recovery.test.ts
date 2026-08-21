import { describe, expect, it } from "vitest";
import { recoverOnStartup } from "../../src/persistence/recovery";
import { STORES, runAtomicWrite } from "../../src/persistence/database";
import { StepRepository } from "../../src/persistence/step-repository";
import { CaptureGapRepository } from "../../src/persistence/capture-gap-repository";
import { sessionControlRecordSchema } from "../../src/schemas/session";
import { captureEpochIdSchema } from "../../src/shared/ids";
import {
  T0,
  createHarness,
  createRecordingSession,
  makeDraftSystemActivityStep,
  makeEnvelope,
  stepId,
} from "../helpers/fixtures";

describe("service-worker restart session recovery", () => {
  it("marks an unclean recording epoch interrupted, keeps committed facts and open draft steps, and writes a CaptureGap", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    const draft = makeDraftSystemActivityStep(session, stepId(1), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: draft }),
    );

    // SW dies (no clean stop) and restarts.
    harness = await harness.restart();
    const recoveredAt = T0 + 60_000;
    const recovered = await recoverOnStartup(harness.db, recoveredAt);

    expect(recovered).toHaveLength(1);
    const entry = recovered[0];
    if (entry === undefined) {
      throw new Error("unreachable");
    }
    expect(entry.sessionId).toBe(session.sessionId);
    expect(entry.previousLifecycle).toBe("recording");
    expect(entry.openStepIds).toContain(draft.stepId);

    // Session + control moved to interrupted, quality degraded.
    const refreshed = await harness.sessions.getSession(session.sessionId);
    expect(refreshed?.lifecycle).toBe("interrupted");
    expect(refreshed?.captureQuality).toBe("degraded");
    const control = await harness.sessions.getControl(session.sessionId);
    expect(control?.lifecycle).toBe("interrupted");

    // Committed facts survive; the draft step is recoverable.
    const steps = new StepRepository(harness.db);
    const drafts = await steps.listOpenDraftSteps(session.sessionId);
    expect(drafts.map((s) => s.stepId)).toContain(draft.stepId);

    // A gap covers lastCommittedAt -> recovery time with estimated bounds.
    const gaps = new CaptureGapRepository(harness.db);
    const sessionGaps = await gaps.listGapsBySession(session.sessionId);
    expect(sessionGaps).toHaveLength(1);
    const gap = sessionGaps[0];
    if (gap === undefined) {
      throw new Error("unreachable");
    }
    expect(gap.reason).toBe("runtime_interrupted");
    expect(gap.boundaryConfidence).toBe("estimated");
    expect(gap.observedEndedAt).toBe(recoveredAt);
    expect(gap.observedStartedAt).toBe(control?.lastCommittedAt);
    expect(gap.recovery?.action).toBe("session_interrupted");
  });

  it("recovery is idempotent — a second pass changes nothing", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    harness = await harness.restart();

    const first = await recoverOnStartup(harness.db, T0 + 1000);
    expect(first).toHaveLength(1);
    const second = await recoverOnStartup(harness.db, T0 + 2000);
    expect(second).toHaveLength(0);

    const gaps = new CaptureGapRepository(harness.db);
    expect(await gaps.listGapsBySession(session.sessionId)).toHaveLength(1);
  });

  it("does not touch cleanly completed sessions", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    await harness.sessions.applyLifecycleEvent(session.sessionId, "stop_requested", { now: T0 });
    await harness.sessions.applyLifecycleEvent(session.sessionId, "stop_completed", {
      now: T0,
      cleanStop: true,
    });

    harness = await harness.restart();
    const recovered = await recoverOnStartup(harness.db, T0 + 1000);
    expect(recovered).toHaveLength(0);
    const refreshed = await harness.sessions.getSession(session.sessionId);
    expect(refreshed?.lifecycle).toBe("completed");
    expect(refreshed?.captureQuality).toBe("complete");
  });

  it("leaves paused_storage_pressure sessions paused (no silent resume)", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 10);

    harness = await harness.restart();
    const recovered = await recoverOnStartup(harness.db, T0 + 1000);
    expect(recovered).toHaveLength(0);
    const refreshed = await harness.sessions.getSession(session.sessionId);
    expect(refreshed?.lifecycle).toBe("paused_storage_pressure");
  });

  it("clears an unfinished resume attempt after a crash without resuming the session", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    await harness.pressure.safeStop(session.sessionId, "headroom_exhausted", T0 + 10);
    const reservedCaptureEpochId = captureEpochIdSchema.parse("cep_crashed_resume_attempt");
    const control = await harness.sessions.getControl(session.sessionId);
    if (control === null) {
      throw new Error("session control vanished");
    }
    await runAtomicWrite(harness.db, [STORES.sessionControl], (txn) => {
      txn.objectStore(STORES.sessionControl).put(
        sessionControlRecordSchema.parse({
          ...control,
          resumeAttempt: {
            captureEpochId: reservedCaptureEpochId,
            reservedAt: T0 + 20,
          },
        }),
      );
      return Promise.resolve();
    });

    harness = await harness.restart();
    const recovered = await recoverOnStartup(harness.db, T0 + 1_000);

    expect(recovered).toEqual([]);
    expect(await harness.sessions.getControl(session.sessionId)).toMatchObject({
      lifecycle: "paused_storage_pressure",
      captureEpochId: session.captureEpochIds[0],
    });
    expect(await harness.sessions.getControl(session.sessionId)).not.toHaveProperty(
      "resumeAttempt",
    );
    expect(await new CaptureGapRepository(harness.db).listGapsBySession(session.sessionId)).toHaveLength(
      1,
    );
  });

  it("preserves a durable stopping deadline across worker restart", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    const stopRequestedAt = T0 + 1_000;
    await harness.sessions.applyLifecycleEvent(session.sessionId, "stop_requested", {
      now: stopRequestedAt,
    });

    expect((await harness.sessions.getSession(session.sessionId))?.stopRequestedAt).toBe(
      stopRequestedAt,
    );
    harness = await harness.restart();
    const recovered = await recoverOnStartup(harness.db, stopRequestedAt + 2_000);

    expect(recovered).toEqual([]);
    expect((await harness.sessions.getSession(session.sessionId))?.lifecycle).toBe("stopping");
    expect((await harness.sessions.getControl(session.sessionId))?.lifecycle).toBe("stopping");
    expect(await new CaptureGapRepository(harness.db).listGapsBySession(session.sessionId)).toEqual(
      [],
    );
  });
});
