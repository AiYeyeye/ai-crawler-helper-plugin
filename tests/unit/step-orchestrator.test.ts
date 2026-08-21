import { describe, expect, it } from "vitest";
import {
  StepOrchestrator,
  type CancelScheduledStepTask,
  type StepContext,
  type StepLifecycleEvent,
} from "../../src/core/step-orchestrator";
import type { ActionRecord } from "../../src/schemas/action";
import type { DomAfter, DomCapture } from "../../src/schemas/dom";
import type { DraftStep, SealedStep } from "../../src/schemas/step";
import {
  captureEpochIdSchema,
  candidateTokenSchema,
  domRecordIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
  stepIdSchema,
  storageRecordIdSchema,
  type StepId,
} from "../../src/shared/ids";

const T0 = 1_700_000_000_000;

interface ScheduledTask {
  id: number;
  dueAt: number;
  run: () => void;
}

class FakeStepScheduler {
  now = T0;
  private nextId = 0;
  private readonly tasks = new Map<number, ScheduledTask>();

  readonly schedule = (delayMs: number, run: () => void): CancelScheduledStepTask => {
    const id = this.nextId++;
    this.tasks.set(id, { id, dueAt: this.now + delayMs, run });
    return () => {
      this.tasks.delete(id);
    };
  };

  advanceBy(deltaMs: number): void {
    const target = this.now + deltaMs;
    for (;;) {
      const next = [...this.tasks.values()]
        .filter((task) => task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (next === undefined) {
        break;
      }
      this.tasks.delete(next.id);
      this.now = next.dueAt;
      next.run();
    }
    this.now = target;
  }
}

const context = (
  sessionNo: number,
  tabId: number,
  documentId: string,
  frameId = 0,
): StepContext => ({
  sessionId: sessionIdSchema.parse(`ses-${String(sessionNo)}`),
  captureEpochId: captureEpochIdSchema.parse(`epoch-${String(sessionNo)}`),
  scope: {
    tabId: extTabIdSchema.parse(tabId),
    documentId: extDocumentIdSchema.parse(documentId),
    frameId: extFrameIdSchema.parse(frameId),
  },
});

const domCapture = (capturedAt: number): DomCapture => ({
  target: {
    kind: "node",
    node: { nodeType: "element", tagName: "BUTTON", children: [] },
  },
  locators: {
    cssSelector: "#save",
    xpath: '//*[@id="save"]',
    dataAttributes: {},
  },
  parentChain: [{ nodeType: "element", tagName: "BODY", children: [] }],
  shadowHostChain: [],
  iframePath: [],
  capturedAt,
});

const clickAction = (occurredAt: number): ActionRecord => ({
  type: "click",
  occurredAt,
  modifiers: { ctrl: false, alt: false, shift: false, meta: false },
});

const hoverAction = (
  occurredAt: number,
  promotedBy: "dom_change" | "network_request",
): ActionRecord => ({
  type: "hover",
  occurredAt,
  modifiers: { ctrl: false, alt: false, shift: false, meta: false },
  hover: {
    dwellMs: 600,
    thresholdMs: 500,
    promotedBy,
  },
});

const capturedDomAfter = (capturedAt: number): DomAfter => ({
  captured: true,
  targetAfter: { nodeType: "element", tagName: "BUTTON", children: [] },
  mutationSummary: { added: 0, updated: 1, removed: 0 },
  capturedAt,
});

const eventsOf = <K extends StepLifecycleEvent["type"]>(
  events: readonly StepLifecycleEvent[],
  type: K,
): Extract<StepLifecycleEvent, { type: K }>[] =>
  events.filter((event): event is Extract<StepLifecycleEvent, { type: K }> => event.type === type);

const lastDraftFor = (events: readonly StepLifecycleEvent[], stepId: StepId): DraftStep => {
  const candidates = events
    .filter(
      (event): event is Extract<StepLifecycleEvent, { type: "draft_created" | "draft_updated" }> =>
        event.type === "draft_created" || event.type === "draft_updated",
    )
    .map((event) => event.step)
    .filter((step) => step.stepId === stepId);
  const latest = candidates.at(-1);
  if (latest === undefined) {
    throw new Error(`missing draft ${stepId}`);
  }
  return latest;
};

const makeHarness = () => {
  const scheduler = new FakeStepScheduler();
  const events: StepLifecycleEvent[] = [];
  let nextStep = 0;
  const orchestrator = new StepOrchestrator({
    now: () => scheduler.now,
    schedule: scheduler.schedule,
    newStepId: () => stepIdSchema.parse(`stp-${String(nextStep++)}`),
    onEvent: (event) => events.push(event),
  });
  return { scheduler, events, orchestrator };
};

describe("StepOrchestrator", () => {
  it("starts an incomplete candidate and completes it in place with the real action record", () => {
    const { orchestrator, events } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const candidate = orchestrator.startCandidate({
      context: stepContext,
      candidateToken: candidateTokenSchema.parse("candidate-hover-1"),
      type: "hover",
      startedAt: T0,
      domBefore: domCapture(T0),
    });

    expect(candidate).toMatchObject({
      type: "hover",
      startedAt: T0,
      candidate: true,
      candidateToken: "candidate-hover-1",
    });
    expect(candidate.action).toBeUndefined();
    const realAction = hoverAction(T0 + 600, "dom_change");
    const completed = orchestrator.completeCandidate({
      context: stepContext,
      candidateToken: candidateTokenSchema.parse("candidate-hover-1"),
      action: realAction,
    });

    expect(completed).toMatchObject({
      stepId: candidate.stepId,
      ordinal: candidate.ordinal,
      candidate: false,
      action: realAction,
    });
    expect(lastDraftFor(events, candidate.stepId)).toMatchObject({ action: realAction });
    expect(
      eventsOf(events, "draft_updated").some(
        (event) => event.step.stepId === candidate.stepId && event.reason === "candidate_completed",
      ),
    ).toBe(true);
  });

  it("attributes an early request to an incomplete candidate and promotes only after real details arrive", () => {
    const { orchestrator, scheduler, events } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const candidate = orchestrator.startCandidate({
      context: stepContext,
      candidateToken: candidateTokenSchema.parse("candidate-hover-2"),
      type: "hover",
      startedAt: T0,
      domBefore: domCapture(T0),
    });

    const assignment = orchestrator.requestStarted({
      context: stepContext,
      requestKey: "candidate-request",
    });
    expect(assignment.startedInStepId).toBe(candidate.stepId);
    const attributedDraft = lastDraftFor(events, candidate.stepId);
    expect(attributedDraft).toMatchObject({
      candidate: true,
      requestKeys: ["candidate-request"],
    });
    expect(attributedDraft.kind === "user_action" ? attributedDraft.action : null).toBeUndefined();

    const realAction = hoverAction(T0 + 25, "network_request");
    const completed = orchestrator.completeCandidate({
      context: stepContext,
      candidateToken: candidateTokenSchema.parse("candidate-hover-2"),
      action: realAction,
    });
    expect(completed).toMatchObject({
      stepId: candidate.stepId,
      ordinal: candidate.ordinal,
      candidate: false,
      action: realAction,
      requestKeys: ["candidate-request"],
    });

    orchestrator.requestFinished({
      sessionId: stepContext.sessionId,
      requestKey: "candidate-request",
    });
    scheduler.advanceBy(800);
    expect(eventsOf(events, "step_sealed")[0]?.step).toMatchObject({
      stepId: candidate.stepId,
      action: realAction,
      closeReason: "network_quiet",
    });
  });

  it.each(["pointer_leave", "quiet_window", "replaced_by_action", "stopped"] as const)(
    "preserves the raw candidate cancellation reason %s",
    (reason) => {
      const { orchestrator, events } = makeHarness();
      const stepContext = context(1, 1, "doc-a");
      const candidateToken = candidateTokenSchema.parse(`candidate-scroll-${reason}`);
      const candidate = orchestrator.startCandidate({
        context: stepContext,
        candidateToken,
        type: "scroll",
        startedAt: T0,
        domBefore: domCapture(T0),
      });

      expect(orchestrator.cancelCandidate({ context: stepContext, candidateToken, reason })).toBe(
        true,
      );
      expect(eventsOf(events, "candidate_discarded")[0]).toMatchObject({
        reason,
        step: { stepId: candidate.stepId, type: "scroll" },
      });
      expect(eventsOf(events, "candidate_discarded")[0]?.step).not.toHaveProperty("action");
      expect(orchestrator.cancelCandidate({ context: stepContext, candidateToken, reason })).toBe(
        false,
      );
    },
  );

  it("rejects candidate completion with a different action type instead of fabricating details", () => {
    const { orchestrator } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    orchestrator.startCandidate({
      context: stepContext,
      candidateToken: candidateTokenSchema.parse("candidate-hover-3"),
      type: "hover",
      startedAt: T0,
      domBefore: domCapture(T0),
    });

    expect(() =>
      orchestrator.completeCandidate({
        context: stepContext,
        candidateToken: candidateTokenSchema.parse("candidate-hover-3"),
        action: clickAction(T0 + 1),
      }),
    ).toThrow("candidate action type mismatch");
  });

  it("does not let a late token complete the replacement candidate", () => {
    const { orchestrator } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const staleToken = candidateTokenSchema.parse("candidate-stale");
    const currentToken = candidateTokenSchema.parse("candidate-current");
    orchestrator.startCandidate({
      context: stepContext,
      candidateToken: staleToken,
      type: "hover",
      startedAt: T0,
      domBefore: domCapture(T0),
    });
    const current = orchestrator.startCandidate({
      context: stepContext,
      candidateToken: currentToken,
      type: "hover",
      startedAt: T0 + 10,
      domBefore: domCapture(T0 + 10),
    });

    expect(() =>
      orchestrator.completeCandidate({
        context: stepContext,
        candidateToken: staleToken,
        action: hoverAction(T0 + 20, "dom_change"),
      }),
    ).toThrow("is not active in the requested scope");
    expect(
      orchestrator.completeCandidate({
        context: stepContext,
        candidateToken: currentToken,
        action: hoverAction(T0 + 20, "dom_change"),
      }).stepId,
    ).toBe(current.stepId);
  });

  it("hydrates open drafts and resumes attribution, candidate tokens, and session ordinals", () => {
    const original = makeHarness();
    const activeContext = context(1, 1, "doc-active");
    const candidateContext = context(1, 1, "doc-candidate");
    const candidateToken = candidateTokenSchema.parse("candidate-restart");
    const active = original.orchestrator.startUserAction({
      context: activeContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const candidate = original.orchestrator.startCandidate({
      context: candidateContext,
      candidateToken,
      type: "hover",
      startedAt: T0,
      domBefore: domCapture(T0),
    });
    const restarted = makeHarness();

    restarted.orchestrator.hydrate({
      openDraftSteps: [
        lastDraftFor(original.events, active.stepId),
        lastDraftFor(original.events, candidate.stepId),
      ],
      sessionMaxOrdinals: [{ sessionId: activeContext.sessionId, maxOrdinal: 10 }],
    });

    expect(restarted.events).toHaveLength(0);
    expect(
      restarted.orchestrator.requestStarted({
        context: activeContext,
        requestKey: "request-after-restart",
      }).startedInStepId,
    ).toBe(active.stepId);
    expect(
      restarted.orchestrator.completeCandidate({
        context: candidateContext,
        candidateToken,
        action: hoverAction(T0 + 50, "dom_change"),
      }),
    ).toMatchObject({
      stepId: candidate.stepId,
      ordinal: candidate.ordinal,
      candidate: false,
    });
    expect(
      restarted.orchestrator.startUserAction({
        context: context(1, 2, "doc-new"),
        action: clickAction(T0 + 100),
        domBefore: domCapture(T0 + 100),
        candidate: false,
      }).ordinal,
    ).toBe(11);
  });

  it("hydrates persisted in-flight assignments and keeps the original Step open until completion", () => {
    const original = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const step = original.orchestrator.startUserAction({
      context: stepContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    original.orchestrator.requestStarted({
      context: stepContext,
      requestKey: "request-before-restart",
    });
    const persistedDraft = lastDraftFor(original.events, step.stepId);
    const restarted = makeHarness();

    restarted.orchestrator.hydrate({
      openDraftSteps: [persistedDraft],
      sessionMaxOrdinals: [{ sessionId: stepContext.sessionId, maxOrdinal: step.ordinal }],
      inFlightRequests: [
        {
          context: stepContext,
          requestKey: "request-before-restart",
          startedInStepId: step.stepId,
        },
      ],
    });

    restarted.scheduler.advanceBy(800);
    expect(eventsOf(restarted.events, "step_sealed")).toHaveLength(0);
    expect(
      restarted.orchestrator.requestFinished({
        sessionId: stepContext.sessionId,
        requestKey: "request-before-restart",
      }),
    ).toEqual({ startedInStepId: step.stepId });
    restarted.scheduler.advanceBy(800);
    expect(eventsOf(restarted.events, "step_sealed")[0]?.step).toMatchObject({
      stepId: step.stepId,
      closeReason: "network_quiet",
    });
  });

  it("does not reuse a hydrated Step when the same document enters a new capture epoch", () => {
    const original = makeHarness();
    const oldContext = context(1, 1, "doc-a");
    const oldStep = original.orchestrator.startUserAction({
      context: oldContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const restarted = makeHarness();
    restarted.orchestrator.hydrate({
      openDraftSteps: [lastDraftFor(original.events, oldStep.stepId)],
      sessionMaxOrdinals: [{ sessionId: oldContext.sessionId, maxOrdinal: oldStep.ordinal }],
    });
    const newContext: StepContext = {
      ...oldContext,
      captureEpochId: captureEpochIdSchema.parse("epoch-resumed"),
    };

    expect(restarted.orchestrator.activeStepId(newContext)).toBeNull();
    const resumedStep = restarted.orchestrator.startUserAction({
      context: newContext,
      action: clickAction(T0 + 100),
      domBefore: domCapture(T0 + 100),
      candidate: false,
    });

    expect(resumedStep.captureEpochId).toBe(newContext.captureEpochId);
    expect(restarted.orchestrator.activeStepId(oldContext)).toBe(oldStep.stepId);
    expect(restarted.orchestrator.activeStepId(newContext)).toBe(resumedStep.stepId);
    expect(eventsOf(restarted.events, "step_sealed")).toHaveLength(0);
  });

  it("isolates active steps by full scope, closes only the previous same-scope step, and assigns session ordinals monotonically", () => {
    const { orchestrator, events } = makeHarness();
    const firstScope = context(1, 1, "doc-a");
    const otherFrame = context(1, 1, "doc-a", 2);

    const first = orchestrator.startUserAction({
      context: firstScope,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const isolated = orchestrator.startUserAction({
      context: otherFrame,
      action: clickAction(T0 + 10),
      domBefore: domCapture(T0 + 10),
      candidate: false,
    });
    const replacement = orchestrator.startUserAction({
      context: firstScope,
      action: clickAction(T0 + 20),
      domBefore: domCapture(T0 + 20),
      candidate: false,
    });

    expect([first.ordinal, isolated.ordinal, replacement.ordinal]).toEqual([0, 1, 2]);
    expect(eventsOf(events, "step_sealed").map((event) => event.step)).toEqual([
      expect.objectContaining({
        stepId: first.stepId,
        closeReason: "next_user_action",
        endedAt: T0,
      }),
    ]);
    expect(eventsOf(events, "step_sealed").some((event) => event.step.stepId === isolated.stepId)).toBe(
      false,
    );
  });

  it.each(["dom_change", "network_request"] as const)(
    "promotes a candidate in place on %s and preserves its step id",
    (promotionSignal) => {
      const { orchestrator, events } = makeHarness();
      const stepContext = context(1, 1, "doc-a");
      const candidate = orchestrator.startUserAction({
        context: stepContext,
        action: hoverAction(T0, promotionSignal),
        domBefore: domCapture(T0),
        candidate: true,
      });

      const attributedStepId =
        promotionSignal === "dom_change"
          ? orchestrator.observeDomChange({
              context: stepContext,
              domRecordId: domRecordIdSchema.parse("dom-1"),
              domAfter: capturedDomAfter(T0 + 1),
            })
          : orchestrator.requestStarted({ context: stepContext, requestKey: "req-1" })
              .startedInStepId;

      expect(attributedStepId).toBe(candidate.stepId);
      expect(lastDraftFor(events, candidate.stepId)).toMatchObject({
        stepId: candidate.stepId,
        candidate: false,
      });
      expect(
        eventsOf(events, "draft_updated").some(
          (event) => event.step.stepId === candidate.stepId && event.reason === "candidate_promoted",
        ),
      ).toBe(true);
    },
  );

  it("creates and aggregates document-scoped system activity when there is no active user step", () => {
    const { orchestrator, events } = makeHarness();
    const stepContext = context(1, 1, "doc-a");

    const requestAssignment = orchestrator.requestStarted({
      context: stepContext,
      requestKey: "req-background",
    });
    const storageStepId = orchestrator.observeStorageChange({
      context: stepContext,
      storageDiffId: storageRecordIdSchema.parse("storage-1"),
    });

    expect(storageStepId).toBe(requestAssignment.startedInStepId);
    const created = eventsOf(events, "draft_created");
    expect(created).toHaveLength(1);
    expect(created[0]?.step).toMatchObject({
      kind: "system_activity",
      type: "system_activity",
      trigger: "background_network",
      backgroundCandidate: true,
      candidate: false,
    });
    expect(lastDraftFor(events, requestAssignment.startedInStepId)).toMatchObject({
      requestKeys: ["req-background"],
      storageDiffIds: ["storage-1"],
    });
  });

  it("keeps request start attribution immutable and seals only after all requests stay quiet for 800ms", () => {
    const { orchestrator, scheduler, events } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const step = orchestrator.startUserAction({
      context: stepContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const first = orchestrator.requestStarted({ context: stepContext, requestKey: "req-1" });
    const duplicate = orchestrator.requestStarted({ context: stepContext, requestKey: "req-1" });
    const second = orchestrator.requestStarted({ context: stepContext, requestKey: "req-2" });

    expect(first.startedInStepId).toBe(step.stepId);
    expect(duplicate.startedInStepId).toBe(step.stepId);
    expect(second.startedInStepId).toBe(step.stepId);

    scheduler.advanceBy(200);
    orchestrator.requestFinished({ sessionId: stepContext.sessionId, requestKey: "req-1" });
    scheduler.advanceBy(1_000);
    expect(eventsOf(events, "step_sealed")).toHaveLength(0);

    orchestrator.requestFinished({ sessionId: stepContext.sessionId, requestKey: "req-2" });
    scheduler.advanceBy(799);
    expect(eventsOf(events, "step_sealed")).toHaveLength(0);
    scheduler.advanceBy(1);
    expect(eventsOf(events, "step_sealed")[0]?.step).toMatchObject({
      stepId: step.stepId,
      closeReason: "network_quiet",
      requestKeys: ["req-1", "req-2"],
    });
  });

  it("does not let an old request completion move or delay a replacement step", () => {
    const { orchestrator, scheduler, events } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const oldStep = orchestrator.startUserAction({
      context: stepContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    orchestrator.requestStarted({ context: stepContext, requestKey: "req-old" });
    scheduler.advanceBy(100);
    const replacement = orchestrator.startUserAction({
      context: stepContext,
      action: clickAction(T0 + 100),
      domBefore: domCapture(T0 + 100),
      candidate: false,
    });

    orchestrator.requestFinished({ sessionId: stepContext.sessionId, requestKey: "req-old" });
    scheduler.advanceBy(800);

    const sealed = eventsOf(events, "step_sealed").map((event) => event.step);
    expect(sealed).toEqual([
      expect.objectContaining({ stepId: oldStep.stepId, closeReason: "next_user_action" }),
      expect.objectContaining({ stepId: replacement.stepId, closeReason: "network_quiet" }),
    ]);
  });

  it("seals an active step at the 10s maximum even while a request remains in flight", () => {
    const { orchestrator, scheduler, events } = makeHarness();
    const stepContext = context(1, 1, "doc-a");
    const step = orchestrator.startUserAction({
      context: stepContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    orchestrator.requestStarted({ context: stepContext, requestKey: "long-request" });

    scheduler.advanceBy(9_999);
    expect(eventsOf(events, "step_sealed")).toHaveLength(0);
    scheduler.advanceBy(1);
    expect(eventsOf(events, "step_sealed")[0]?.step).toMatchObject({
      stepId: step.stepId,
      closeReason: "max_window_timeout",
    });
  });

  it("converges only matching documents on replacement and all matching scopes on session stop", () => {
    const { orchestrator, events } = makeHarness();
    const sessionOne = context(1, 1, "doc-a");
    const sessionOneOtherDocument = context(1, 1, "doc-b");
    const sessionTwo = context(2, 2, "doc-c");
    const replacedStep = orchestrator.startUserAction({
      context: sessionOne,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const stoppedStep = orchestrator.startUserAction({
      context: sessionOneOtherDocument,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const untouchedStep = orchestrator.startUserAction({
      context: sessionTwo,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });

    orchestrator.documentReplaced(sessionOne);
    orchestrator.sessionStopping(sessionOne.sessionId);

    const sealed = eventsOf(events, "step_sealed").map((event) => event.step);
    expect(sealed).toEqual([
      expect.objectContaining({
        stepId: replacedStep.stepId,
        closeReason: "document_replaced",
        domAfter: { captured: false, reason: "document_replaced" },
      }),
      expect.objectContaining({
        stepId: stoppedStep.stepId,
        closeReason: "session_stopping",
      }),
    ] satisfies Partial<SealedStep>[]);
    expect(sealed.some((step) => step.stepId === untouchedStep.stepId)).toBe(false);
  });

  it("quiesces a paused session without emitting timer-driven lifecycle events", () => {
    const { orchestrator, scheduler, events } = makeHarness();
    const pausedContext = context(1, 1, "doc-paused");
    const otherContext = context(2, 2, "doc-recording");
    orchestrator.startUserAction({
      context: pausedContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    orchestrator.requestStarted({ context: pausedContext, requestKey: "req-paused" });
    orchestrator.startUserAction({
      context: otherContext,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const beforePause = events.length;

    orchestrator.sessionPaused(pausedContext.sessionId);
    scheduler.advanceBy(10_000);

    const afterPause = events.slice(beforePause);
    expect(afterPause).toHaveLength(1);
    expect(afterPause[0]).toMatchObject({
      type: "step_sealed",
      step: { sessionId: otherContext.sessionId },
    });
    expect(orchestrator.activeStepId(pausedContext)).toBeNull();
    expect(orchestrator.inFlightRequestKeys(pausedContext)).toEqual([]);
    expect(
      orchestrator.requestFinished({
        sessionId: pausedContext.sessionId,
        requestKey: "req-paused",
      }),
    ).toBeNull();
  });

  it("keeps ordinal sequences independent across sessions", () => {
    const { orchestrator } = makeHarness();
    const firstSession = context(1, 1, "doc-a");
    const secondSession = context(2, 2, "doc-b");

    const first = orchestrator.startUserAction({
      context: firstSession,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });
    const second = orchestrator.startUserAction({
      context: secondSession,
      action: clickAction(T0),
      domBefore: domCapture(T0),
      candidate: false,
    });

    expect(first.ordinal).toBe(0);
    expect(second.ordinal).toBe(0);
  });
});
