import { describe, expect, it } from "vitest";
import { STORES, getRecord, runAtomicWrite } from "../../src/persistence/database";
import { NetworkStateRepository } from "../../src/persistence/network-state-repository";
import { StepRepository } from "../../src/persistence/step-repository";
import { ObservationProcessor } from "../../src/background/observation-processor";
import { CaptureGapRepository } from "../../src/persistence/capture-gap-repository";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { captureGapRecordSchema } from "../../src/schemas/capture-gap";
import {
  sessionControlRecordSchema,
  sessionRecordSchema,
} from "../../src/schemas/session";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  gapIdSchema,
} from "../../src/shared/ids";
import {
  createHarness,
  createRecordingSession,
  makeDraftSystemActivityStep,
  makeEnvelope,
  makeRequestRecord,
  stepId,
  T0,
} from "../helpers/fixtures";

describe("network in-flight request recovery", () => {
  it("creates a durable store for incomplete request projections", async () => {
    const harness = await createHarness();

    expect(Object.values(STORES)).toContain("inFlightRequests");
    expect(harness.db.objectStoreNames.contains("inFlightRequests")).toBe(true);
  });

  it("persists request attribution at start and removes it with terminal metadata", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(1), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = makeRequestRecord(session, step.stepId, 1);

    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );

    const readProjection = async (): Promise<unknown> => {
      const txn = harness.db.transaction([STORES.inFlightRequests], "readonly");
      return getRecord(txn.objectStore(STORES.inFlightRequests), request.requestKey);
    };
    await expect(readProjection()).resolves.toMatchObject({
      requestKey: request.requestKey,
      sessionId: session.sessionId,
      startedInStepId: step.stepId,
      captureEpochId: session.captureEpochIds[0],
      scope: {
        tabId: 1,
        documentId: "doc-1",
        frameId: 0,
      },
      keyParts: request.keyParts,
      phase: "request_started",
      startedAt: T0,
    });

    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "request_metadata",
        record: {
          ...request,
          statusCode: 200,
          completedAt: T0 + 25,
          durationMs: 25,
        },
      }),
    );

    await expect(readProjection()).resolves.toBeUndefined();
  });

  it("reads incomplete projections and allocates attach epochs across worker restarts", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(2), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = makeRequestRecord(session, step.stepId, 2);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );
    let repository = new NetworkStateRepository(harness.db);

    await expect(repository.nextAttachEpoch(session.sessionId, session.rootTabId, T0)).resolves.toBe(0);
    harness = await harness.restart();
    repository = new NetworkStateRepository(harness.db);

    await expect(repository.listInFlightBySession(session.sessionId)).resolves.toEqual([
      expect.objectContaining({
        requestKey: request.requestKey,
        startedInStepId: step.stepId,
      }),
    ]);
    await expect(
      repository.listInFlightRequestRecordsBySession(session.sessionId),
    ).resolves.toEqual([request]);
    await expect(
      repository.nextAttachEpoch(session.sessionId, session.rootTabId, T0 + 1),
    ).resolves.toBe(1);
  });

  it("hydrates an ObservationProcessor only from durable projections and preserves attribution", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds[0];
    if (captureEpochId === undefined) {
      throw new Error("session has no capture epoch");
    }
    const step = makeDraftSystemActivityStep(session, stepId(3), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = makeRequestRecord(session, step.stepId, 3);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );
    harness = await harness.restart();
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      networkStateRepository: new NetworkStateRepository(harness.db),
    });
    const context = {
      sessionId: session.sessionId,
      captureEpochId,
      scope: step.scope,
    };

    await expect(processor.inFlightRequestKeys(context)).resolves.toEqual([request.requestKey]);
    await expect(
      processor.recordNetworkRequestFinished(session.sessionId, request.requestKey),
    ).resolves.toEqual({ startedInStepId: step.stepId });
    await expect(processor.inFlightRequestKeys(context)).resolves.toEqual([]);
  });

  it("does not hydrate draft Steps or blocking requests from an old capture epoch", async () => {
    let harness = await createHarness();
    const epochOneSession = await createRecordingSession(harness);
    const epochOneId = epochOneSession.captureEpochIds[0];
    if (epochOneId === undefined) {
      throw new Error("session has no capture epoch");
    }
    const staleStep = makeDraftSystemActivityStep(epochOneSession, stepId(30), 7);
    await harness.ingestor.ingest(
      makeEnvelope(epochOneSession.sessionId, { kind: "step_draft_upsert", step: staleStep }),
    );
    const staleRequest = makeRequestRecord(epochOneSession, staleStep.stepId, 30);
    await harness.ingestor.ingest(
      makeEnvelope(epochOneSession.sessionId, {
        kind: "request_metadata",
        record: staleRequest,
      }),
    );

    const epochTwoId = captureEpochIdSchema.parse("cep_hydration_epoch_2");
    const control = await harness.sessions.getControl(epochOneSession.sessionId);
    if (control === null) {
      throw new Error("session control vanished");
    }
    await runAtomicWrite(
      harness.db,
      [STORES.sessions, STORES.sessionControl],
      (txn) => {
        txn.objectStore(STORES.sessions).put(
          sessionRecordSchema.parse({
            ...epochOneSession,
            captureEpochIds: [...epochOneSession.captureEpochIds, epochTwoId],
          }),
        );
        txn.objectStore(STORES.sessionControl).put(
          sessionControlRecordSchema.parse({
            ...control,
            captureEpochId: epochTwoId,
            openStepIds: [],
          }),
        );
        return Promise.resolve();
      },
    );

    harness = await harness.restart();
    const scheduled: Array<() => void> = [];
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      networkStateRepository: new NetworkStateRepository(harness.db),
      orchestratorOptions: {
        now: () => T0 + 100,
        schedule: (_delay, run) => {
          scheduled.push(run);
          return () => undefined;
        },
        newStepId: () => stepId(31),
      },
    });
    const staleContext = {
      sessionId: epochOneSession.sessionId,
      captureEpochId: epochOneId,
      scope: staleStep.scope,
    };

    await processor.hydrate(epochOneSession.sessionId);
    expect.soft(await processor.activeStepId(staleContext)).toBeNull();
    expect.soft(await processor.inFlightRequestKeys(staleContext)).toEqual([]);
    expect.soft(scheduled).toHaveLength(0);

    for (const run of scheduled) {
      run();
    }
    await processor.flushBackgroundEvents();
    expect.soft(
      await new StepRepository(harness.db).listStepsBySession(epochOneSession.sessionId),
    ).toEqual([expect.objectContaining({ stepId: staleStep.stepId, phase: "draft" })]);

    await processor.recordNetworkMessageObserved(
      {
        sessionId: epochOneSession.sessionId,
        captureEpochId: epochTwoId,
        scope: staleStep.scope,
      },
      T0 + 200,
    );
    const steps = await new StepRepository(harness.db).listStepsBySession(
      epochOneSession.sessionId,
    );
    expect(steps.find((step) => step.stepId === stepId(31))).toMatchObject({
      captureEpochId: epochTwoId,
      ordinal: 8,
    });
  });

  it("restores an established stream without making it Step-blocking again", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds[0];
    if (captureEpochId === undefined) {
      throw new Error("session has no capture epoch");
    }
    const step = makeDraftSystemActivityStep(session, stepId(4), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = {
      ...makeRequestRecord(session, step.stepId, 4),
      resourceType: "EventSource",
      statusCode: 200,
      blocksStep: false,
    } as const;
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );

    harness = await harness.restart();
    const networkState = new NetworkStateRepository(harness.db);
    await expect(networkState.listInFlightBySession(session.sessionId)).resolves.toEqual([
      expect.objectContaining({ requestKey: request.requestKey, blocksStep: false }),
    ]);
    await expect(
      networkState.listInFlightRequestRecordsBySession(session.sessionId),
    ).resolves.toEqual([request]);

    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      networkStateRepository: networkState,
    });
    await expect(
      processor.inFlightRequestKeys({
        sessionId: session.sessionId,
        captureEpochId,
        scope: step.scope,
      }),
    ).resolves.toEqual([]);
  });

  it("persists debugger gap recovery metadata when the gap closes", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const gapId = gapIdSchema.parse("gap_debugger_reattached");
    const gap = captureGapRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      gapId,
      scope: {
        sessionId: session.sessionId,
        tabId: session.rootTabId,
        collector: "debugger_network",
      },
      reason: "debugger_detached",
      observedStartedAt: T0,
      boundaryConfidence: "exact",
      recoverable: true,
      affectedCapabilities: ["network_metadata", "network_bodies"],
    });
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "capture_gap_open", record: gap }),
    );
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "capture_gap_close",
        gapId,
        observedEndedAt: T0 + 10,
        recovery: {
          action: "reattached",
          newAttachEpoch: attachEpochSchema.parse(3),
          recoveredAt: T0 + 10,
        },
      }),
    );

    await expect(new CaptureGapRepository(harness.db).getGap(gapId)).resolves.toMatchObject({
      observedEndedAt: T0 + 10,
      recovery: {
        action: "reattached",
        newAttachEpoch: 3,
        recoveredAt: T0 + 10,
      },
    });
  });
});
