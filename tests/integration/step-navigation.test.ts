import { describe, expect, it } from "vitest";
import { ObservationProcessor } from "../../src/background/observation-processor";
import type { StepContext } from "../../src/core/step-orchestrator";
import { STORES, getAllRecords, getRecord } from "../../src/persistence/database";
import { StepRepository } from "../../src/persistence/step-repository";
import type { ContentObservationEnvelope } from "../../src/schemas/content-observation";
import { contentObservationEnvelopeSchema } from "../../src/schemas/content-observation";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { domRecordSchema } from "../../src/schemas/dom";
import {
  candidateTokenSchema,
  domRecordIdSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  stepIdSchema,
} from "../../src/shared/ids";
import {
  T0,
  createHarness,
  createRecordingSession,
} from "../helpers/fixtures";

const captureEpoch = <T>(values: readonly T[]): T => {
  const value = values.at(-1);
  if (value === undefined) {
    throw new Error("fixture has no capture epoch");
  }
  return value;
};

const domBefore = {
  target: {
    kind: "node" as const,
    node: { nodeType: "element" as const, tagName: "button" },
  },
  locators: {
    id: "save",
    cssSelector: "#save",
    xpath: "//*[@id='save']",
    dataAttributes: {},
  },
  parentChain: [],
  shadowHostChain: [],
  iframePath: [],
  capturedAt: T0,
};

const clickAction = {
  type: "click" as const,
  occurredAt: T0,
  modifiers: { ctrl: false, alt: false, shift: false, meta: false },
};

const hoverAction = {
  type: "hover" as const,
  occurredAt: T0 + 25,
  modifiers: { ctrl: false, alt: false, shift: false, meta: false },
  hover: {
    dwellMs: 25,
    thresholdMs: 500,
    promotedBy: "dom_change" as const,
  },
};

const verifiedScope = {
  tabId: extTabIdSchema.parse(7),
  documentId: extDocumentIdSchema.parse("doc-verified"),
  frameId: extFrameIdSchema.parse(0),
};

const untrustedScope = {
  tabId: extTabIdSchema.parse(999),
  documentId: extDocumentIdSchema.parse("doc-untrusted"),
  frameId: extFrameIdSchema.parse(4),
};

const makeObservation = (
  context: StepContext,
  sourceSeq: number,
  payload: ContentObservationEnvelope["payload"],
): ContentObservationEnvelope =>
  contentObservationEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId: eventIdSchema.parse(`evt_observation_${String(sourceSeq)}`),
    sourceSeq,
    sessionId: context.sessionId,
    captureEpochId: context.captureEpochId,
    // Deliberately untrusted. ObservationProcessor must use verifiedContext.
    scope: untrustedScope,
    sourceTimestamp: T0 + sourceSeq,
    payload,
  });

const createProcessor = (
  harness: Awaited<ReturnType<typeof createHarness>>,
  stepNumbers: { value: number },
  domNumbers: { value: number },
): ObservationProcessor =>
  new ObservationProcessor({
    db: harness.db,
    ingestor: harness.ingestor,
    sessionRepository: harness.sessions,
    stepRepository: new StepRepository(harness.db),
    orchestratorOptions: {
      now: () => T0 + 100,
      schedule: () => () => undefined,
      newStepId: () => stepIdSchema.parse(`stp_processor_${String(stepNumbers.value++)}`),
    },
    newDomRecordId: () => domRecordIdSchema.parse(`dom_processor_${String(domNumbers.value++)}`),
    inFlightRequestKeys: () => [],
  });

describe("Content observation -> durable Step facts", () => {
  it("uses sender-verified context and does not create a second Step for a replayed observation", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const processor = createProcessor(harness, { value: 1 }, { value: 1 });
    const observation = makeObservation(context, 1, {
      kind: "action_started",
      observation: { action: clickAction, domBefore, candidate: false },
    });

    const firstAck = await processor.process(observation, context);
    const replayAck = await processor.process(observation, context);

    expect(firstAck).toMatchObject({ status: "committed", eventId: observation.eventId });
    expect(replayAck).toEqual({ status: "duplicate", eventId: observation.eventId });
    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ scope: verifiedScope, ordinal: 0, type: "click" });
    expect((await harness.sessions.getControl(session.sessionId))?.counters.factCount).toBe(1);
  });

  it("commits candidate lifecycle and mutation DOM record before acknowledging the observation", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const processor = createProcessor(harness, { value: 10 }, { value: 10 });
    const token = candidateTokenSchema.parse("can_processor_hover");

    await expect(
      processor.process(
        makeObservation(context, 10, {
          kind: "candidate_started",
          candidate: { token, type: "hover", startedAt: T0, domBefore },
        }),
        context,
      ),
    ).resolves.toMatchObject({ status: "committed" });
    await expect(
      processor.process(
        makeObservation(context, 11, {
          kind: "candidate_completed",
          candidate: {
            token,
            observation: { action: hoverAction, domBefore, candidate: true },
          },
        }),
        context,
      ),
    ).resolves.toMatchObject({ status: "committed" });

    const mutationObservation = makeObservation(context, 12, {
      kind: "mutation_observed",
      batch: {
        mutations: [
          {
            mutationKind: "updated",
            targetLocators: {
              id: "save",
              cssSelector: "#save",
              xpath: "//*[@id='save']",
              dataAttributes: {},
            },
            attribute: "aria-busy",
            before: "true",
            after: "false",
            observedAt: T0 + 30,
          },
        ],
        domAfter: {
          captured: true,
          mutationSummary: { added: 0, updated: 1, removed: 0 },
          capturedAt: T0 + 30,
        },
      },
    });
    const mutationAck = await processor.process(mutationObservation, context);

    expect(mutationAck).toMatchObject({ status: "committed", eventId: mutationObservation.eventId });
    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: "hover",
      candidate: false,
      action: hoverAction,
      domRecordIds: ["dom_processor_10"],
    });
    const domTxn = harness.db.transaction([STORES.domRecords], "readonly");
    const domRecords = (await getAllRecords(domTxn.objectStore(STORES.domRecords))).map((raw) =>
      domRecordSchema.parse(raw),
    );
    expect(domRecords).toHaveLength(1);
    expect(domRecords[0]).toMatchObject({
      domRecordId: "dom_processor_10",
      role: "mutation_batch",
      stepId: steps[0]?.stepId,
      payload: {
        role: "mutation_batch",
        observedDuringStepId: steps[0]?.stepId,
        inFlightRequestKeys: [],
      },
    });
    const completionTxn = harness.db.transaction([STORES.inbox], "readonly");
    expect(await getRecord(completionTxn.objectStore(STORES.inbox), mutationObservation.eventId)).toBeDefined();
  });

  it("hydrates open drafts after an IndexedDB restart and completes the same candidate Step", async () => {
    let harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const stepNumbers = { value: 20 };
    const domNumbers = { value: 20 };
    const token = candidateTokenSchema.parse("can_restart_hover");
    const original = createProcessor(harness, stepNumbers, domNumbers);
    await original.process(
      makeObservation(context, 20, {
        kind: "candidate_started",
        candidate: { token, type: "hover", startedAt: T0, domBefore },
      }),
      context,
    );
    const beforeRestart = await new StepRepository(harness.db).listOpenDraftSteps(session.sessionId);
    const originalStepId = beforeRestart[0]?.stepId;

    harness = await harness.restart();
    const restarted = createProcessor(harness, stepNumbers, domNumbers);
    await restarted.hydrate(session.sessionId);
    const completion = makeObservation(context, 21, {
      kind: "candidate_completed",
      candidate: {
        token,
        observation: { action: hoverAction, domBefore, candidate: true },
      },
    });
    await expect(restarted.process(completion, context)).resolves.toMatchObject({
      status: "committed",
      eventId: completion.eventId,
    });

    const afterRestart = await new StepRepository(harness.db).listOpenDraftSteps(session.sessionId);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]).toMatchObject({
      stepId: originalStepId,
      candidate: false,
      action: hoverAction,
      ordinal: 0,
    });
  });

  it("acknowledges a candidate completion that arrives after stopping without reviving the candidate", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const processor = createProcessor(harness, { value: 25 }, { value: 25 });
    const token = candidateTokenSchema.parse("can_late_after_stop");
    await processor.process(
      makeObservation(context, 25, {
        kind: "candidate_started",
        candidate: { token, type: "hover", startedAt: T0, domBefore },
      }),
      context,
    );

    await processor.sessionStopping(session.sessionId);
    const completion = makeObservation(context, 26, {
      kind: "candidate_completed",
      candidate: {
        token,
        observation: { action: hoverAction, domBefore, candidate: true },
      },
    });

    await expect(processor.process(completion, context)).resolves.toMatchObject({
      status: "committed",
      eventId: completion.eventId,
    });
    expect(await new StepRepository(harness.db).listOpenDraftSteps(session.sessionId)).toEqual([]);
    const completionTxn = harness.db.transaction([STORES.inbox], "readonly");
    expect(
      await getRecord(completionTxn.objectStore(STORES.inbox), completion.eventId),
    ).toBeDefined();
  });

  it("persists a timer-driven network-quiet seal", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const scheduled: Array<() => void> = [];
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      orchestratorOptions: {
        now: () => T0 + 100,
        schedule: (_delay, run) => {
          scheduled.push(run);
          return () => undefined;
        },
        newStepId: () => stepIdSchema.parse("stp_timer_seal"),
      },
    });
    await processor.process(
      makeObservation(context, 30, {
        kind: "action_started",
        observation: { action: clickAction, domBefore, candidate: false },
      }),
      context,
    );
    const quietTimer = scheduled[1];
    if (quietTimer === undefined) {
      throw new Error("network quiet timer was not scheduled");
    }

    quietTimer();
    await processor.flushBackgroundEvents();

    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps).toEqual([
      expect.objectContaining({
        stepId: "stp_timer_seal",
        phase: "sealed",
        closeReason: "network_quiet",
      }),
    ]);
  });

  it("quiesces pending Step timers without persisting lifecycle events after pause", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const scheduled: Array<() => void> = [];
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      orchestratorOptions: {
        now: () => T0 + 100,
        schedule: (_delay, run) => {
          scheduled.push(run);
          return () => undefined;
        },
        newStepId: () => stepIdSchema.parse("stp_paused_timer"),
      },
    });
    await processor.process(
      makeObservation(context, 31, {
        kind: "action_started",
        observation: { action: clickAction, domBefore, candidate: false },
      }),
      context,
    );

    await processor.sessionPaused(session.sessionId);
    for (const run of scheduled) {
      run();
    }
    await processor.flushBackgroundEvents();

    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps).toEqual([
      expect.objectContaining({ stepId: "stp_paused_timer", phase: "draft" }),
    ]);
  });

  it("seals the old document without creating a full-page DOM record", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const context: StepContext = {
      sessionId: session.sessionId,
      captureEpochId: captureEpoch(session.captureEpochIds),
      scope: verifiedScope,
    };
    const processor = createProcessor(harness, { value: 40 }, { value: 40 });
    await processor.process(
      makeObservation(context, 40, {
        kind: "action_started",
        observation: { action: clickAction, domBefore, candidate: false },
      }),
      context,
    );

    await processor.process(
      makeObservation(context, 41, {
        kind: "document_replaced",
        url: "https://example.com/next",
      }),
      context,
    );

    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps).toEqual([
      expect.objectContaining({
        phase: "sealed",
        closeReason: "document_replaced",
        domAfter: { captured: false, reason: "document_replaced" },
        scope: verifiedScope,
      }),
    ]);
    const txn = harness.db.transaction([STORES.domRecords], "readonly");
    expect(await getAllRecords(txn.objectStore(STORES.domRecords))).toEqual([]);
  });
});
