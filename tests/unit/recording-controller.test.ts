/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ContentRecordingController,
  type ActionRecorderPort,
  type MutationRecorderPort,
} from "../../src/content/recording-controller";
import type { CapturedActionObservation } from "../../src/content/action-recorder";
import type { ActionRecorderOptions } from "../../src/content/action-recorder";
import type { ContentObservationEnvelope } from "../../src/schemas/content-observation";
import { candidateTokenSchema, eventIdSchema } from "../../src/shared/ids";
import { defaultSessionConfig, T0 } from "../helpers/fixtures";
import {
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
} from "../../src/shared/ids";

const sessionId = sessionIdSchema.parse("ses_controller");
const captureEpochId = captureEpochIdSchema.parse("cep_controller");
const candidateToken = candidateTokenSchema.parse("can_controller");
const scope = {
  tabId: extTabIdSchema.parse(4),
  documentId: extDocumentIdSchema.parse("doc-controller"),
  frameId: extFrameIdSchema.parse(0),
};

const clickObservation: CapturedActionObservation = {
  action: {
    type: "click",
    occurredAt: T0,
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
  },
  domBefore: {
    target: { kind: "node", node: { nodeType: "element", tagName: "button" } },
    locators: { cssSelector: "button", xpath: "//button", dataAttributes: {} },
    parentChain: [],
    shadowHostChain: [],
    iframePath: [],
    capturedAt: T0,
  },
  candidate: false,
};

const hoverObservation: CapturedActionObservation = {
  ...clickObservation,
  action: {
    type: "hover",
    occurredAt: T0,
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    hover: { dwellMs: 600, thresholdMs: 500, promotedBy: "dom_change" },
  },
  candidate: true,
};

class FakeActionRecorder implements ActionRecorderPort {
  started = false;
  stopped = false;
  candidateResults: ("dom_change" | "network_request")[] = [];

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  notifyCandidateResult(result: "dom_change" | "network_request"): void {
    this.candidateResults.push(result);
  }
}

class FakeMutationRecorder implements MutationRecorderPort {
  started = false;
  stopped = false;
  replaced = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  markDocumentReplaced(): void {
    this.replaced = true;
  }

  drain(): { mutations: []; domAfter: { captured: false; reason: "no_local_result" } } {
    return { mutations: [], domAfter: { captured: false, reason: "no_local_result" } };
  }
}

describe("ContentRecordingController", () => {
  beforeEach(() => {
    document.body.innerHTML = "<button>Save</button>";
  });

  it("does not start recorders when the handshake is inactive", async () => {
    const action = new FakeActionRecorder();
    const mutation = new FakeMutationRecorder();
    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/",
      now: () => T0,
      newEventId: () => eventIdSchema.parse("evt_unused"),
      sendMessage: () => Promise.resolve({ ok: true, value: { active: false } }),
      createActionRecorder: () => action,
      createMutationRecorder: () => mutation,
    });

    await expect(controller.start()).resolves.toBe(false);
    expect(action.started).toBe(false);
    expect(mutation.started).toBe(false);
  });

  it("starts with handshake config and submits action observations immediately", async () => {
    const sent: unknown[] = [];
    const action = new FakeActionRecorder();
    const mutation = new FakeMutationRecorder();
    let capture: ((observation: CapturedActionObservation) => void) | undefined;
    let recorderOptions: Partial<ActionRecorderOptions> | undefined;
    let eventNo = 0;
    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/",
      now: () => T0,
      newEventId: () => eventIdSchema.parse(`evt_controller_${String(eventNo++)}`),
      sendMessage: (message) => {
        sent.push(message);
        const type = (message as { type?: string }).type;
        if (type === "handshake/contentScript") {
          return Promise.resolve({
            ok: true,
            value: {
              active: true,
              sessionId,
              captureEpochId,
              scope,
              config: defaultSessionConfig({
                hoverDwellThresholdMs: 650,
                networkQuietWindowMs: 900,
              }),
            },
          });
        }
        const observation = (message as { observations: ContentObservationEnvelope[] })
          .observations[0];
        return Promise.resolve({
          ok: true,
          value: {
            acks:
              observation === undefined
                ? []
                : [{ status: "committed", eventId: observation.eventId, committedBytes: 1 }],
          },
        });
      },
      createActionRecorder: (onCapture, options) => {
        capture = onCapture;
        recorderOptions = options;
        return action;
      },
      createMutationRecorder: () => mutation,
    });

    await expect(controller.start()).resolves.toBe(true);
    expect(action.started).toBe(true);
    expect(mutation.started).toBe(true);
    expect(recorderOptions).toMatchObject({
      hoverDwellThresholdMs: 650,
      inputQuietWindowMs: 900,
      scrollQuietWindowMs: 900,
    });

    recorderOptions?.onCandidateLifecycle?.({
      kind: "started",
      token: candidateToken,
      type: "hover",
      startedAt: T0,
      domBefore: clickObservation.domBefore,
    });
    await controller.flush();

    const submit = sent.find(
      (message) => (message as { type?: string }).type === "observations/submit",
    ) as { observations: ContentObservationEnvelope[] } | undefined;
    expect(submit?.observations[0]).toMatchObject({
      sessionId,
      captureEpochId,
      scope,
      payload: {
        kind: "candidate_started",
        candidate: {
          token: candidateToken,
          type: "hover",
          startedAt: T0,
          domBefore: clickObservation.domBefore,
        },
      },
    });

    const startedEnvelope = submit?.observations[0];
    if (startedEnvelope === undefined) {
      throw new Error("candidate lifecycle observation was not submitted");
    }
    sent.length = 0;
    recorderOptions?.onCandidateLifecycle?.({
      kind: "completed",
      token: candidateToken,
      observation: hoverObservation,
    });
    await controller.flush();
    const completedSubmit = sent.find(
      (message) => (message as { type?: string }).type === "observations/submit",
    ) as { observations: ContentObservationEnvelope[] } | undefined;
    expect(completedSubmit?.observations[0]).toMatchObject({
      sourceSeq: startedEnvelope.sourceSeq + 1,
      payload: {
        kind: "candidate_completed",
        candidate: { token: candidateToken, observation: hoverObservation },
      },
    });

    sent.length = 0;
    if (capture === undefined) {
      throw new Error("action capture callback was not registered");
    }
    capture(clickObservation);
    await controller.flush();
    const actionSubmit = sent.find(
      (message) => (message as { type?: string }).type === "observations/submit",
    ) as { observations: ContentObservationEnvelope[] } | undefined;
    expect(actionSubmit?.observations[0]).toMatchObject({
      sessionId,
      captureEpochId,
      scope,
      sourceSeq: startedEnvelope.sourceSeq + 2,
      payload: { kind: "action_started", observation: clickObservation },
    });
  });

  it("marks document replacement, stops capture, and flushes the lifecycle observation", async () => {
    const sent: unknown[] = [];
    const action = new FakeActionRecorder();
    const mutation = new FakeMutationRecorder();
    let eventNo = 0;
    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/next",
      now: () => T0,
      newEventId: () => eventIdSchema.parse(`evt_stop_${String(eventNo++)}`),
      sendMessage: (message) => {
        sent.push(message);
        if ((message as { type?: string }).type === "handshake/contentScript") {
          return Promise.resolve({
            ok: true,
            value: {
              active: true,
              sessionId,
              captureEpochId,
              scope,
              config: defaultSessionConfig(),
            },
          });
        }
        const observation = (message as { observations?: ContentObservationEnvelope[] })
          .observations?.[0];
        return Promise.resolve({
          ok: true,
          value: {
            acks:
              observation === undefined
                ? []
                : [{ status: "committed", eventId: observation.eventId, committedBytes: 1 }],
          },
        });
      },
      createActionRecorder: () => action,
      createMutationRecorder: () => mutation,
    });

    await controller.start();
    await controller.documentReplaced();

    expect(action.stopped).toBe(true);
    expect(mutation.replaced).toBe(true);
    const lifecycle = sent.find(
      (message) =>
        (message as { observations?: ContentObservationEnvelope[] }).observations?.[0]?.payload
          .kind === "document_replaced",
    ) as { observations: ContentObservationEnvelope[] } | undefined;
    expect(lifecycle?.observations[0]?.payload).toEqual({
      kind: "document_replaced",
      url: "https://example.com/next",
    });
  });

  it("accepts only the authenticated main-world History bridge token", async () => {
    const sent: unknown[] = [];
    let eventNo = 0;
    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/after",
      now: () => T0,
      newEventId: () => eventIdSchema.parse(`evt_history_${String(eventNo++)}`),
      sendMessage: (message) => {
        sent.push(message);
        if ((message as { type?: string }).type === "handshake/contentScript") {
          return Promise.resolve({
            ok: true,
            value: {
              active: true,
              sessionId,
              captureEpochId,
              scope,
              config: defaultSessionConfig(),
              historyBridgeToken: "bridge-token",
            },
          });
        }
        const observation = (message as { observations?: ContentObservationEnvelope[] })
          .observations?.[0];
        return Promise.resolve({
          ok: true,
          value: {
            acks:
              observation === undefined
                ? []
                : [{ status: "committed", eventId: observation.eventId, committedBytes: 1 }],
          },
        });
      },
      createActionRecorder: () => new FakeActionRecorder(),
      createMutationRecorder: () => new FakeMutationRecorder(),
    });
    await controller.start();

    await expect(
      controller.historyNavigation({
        source: "ai-crawler-helper-history-bridge",
        token: "wrong-token",
        action: "push",
        beforeUrl: "https://example.com/before",
        afterUrl: "https://example.com/after",
        occurredAt: T0,
      }),
    ).resolves.toBe(false);
    await expect(
      controller.historyNavigation({
        source: "ai-crawler-helper-history-bridge",
        token: "bridge-token",
        action: "replace",
        beforeUrl: "https://example.com/before",
        afterUrl: "https://example.com/after",
        occurredAt: T0,
      }),
    ).resolves.toBe(true);

    const submit = sent.find(
      (message) =>
        (message as { observations?: ContentObservationEnvelope[] }).observations?.[0]?.payload
          .kind === "navigation_observed",
    ) as { observations: ContentObservationEnvelope[] } | undefined;
    expect(submit?.observations[0]?.payload).toEqual({
      kind: "navigation_observed",
      navigation: {
        action: "replace",
        beforeUrl: "https://example.com/before",
        afterUrl: "https://example.com/after",
        title: "",
      },
    });
  });

  it.each(["CAPTURE_CONTEXT_STALE", "SESSION_NOT_ACCEPTING_FACTS"] as const)(
    "invalidates %s capture state and automatically re-handshakes once with a new epoch",
    async (rejectionCode) => {
    const sentObservations: ContentObservationEnvelope[] = [];
    const actions: FakeActionRecorder[] = [];
    const mutations: FakeMutationRecorder[] = [];
    const captures: Array<(observation: CapturedActionObservation) => void> = [];
    const resumedEpoch = captureEpochIdSchema.parse("cep_controller_resumed");
    let handshakeCount = 0;
    let eventNo = 0;
    let rejectNextObservation = true;
    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/",
      now: () => T0,
      newEventId: () => eventIdSchema.parse(`evt_rehandshake_${String(eventNo++)}`),
      sendMessage: (message) => {
        if ((message as { type?: string }).type === "handshake/contentScript") {
          handshakeCount++;
          return Promise.resolve({
            ok: true,
            value: {
              active: true,
              sessionId,
              captureEpochId: handshakeCount === 1 ? captureEpochId : resumedEpoch,
              scope,
              config: defaultSessionConfig(),
            },
          });
        }
        const observation = (message as { observations?: ContentObservationEnvelope[] })
          .observations?.[0];
        if (observation === undefined) {
          return Promise.resolve({ ok: true, value: { acks: [] } });
        }
        sentObservations.push(observation);
        const rejected = rejectNextObservation;
        rejectNextObservation = false;
        return Promise.resolve({
          ok: true,
          value: {
            acks: rejected
              ? [
                  {
                    status: "rejected",
                    eventId: observation.eventId,
                    errorCode: rejectionCode,
                    retryable: false,
                  },
                ]
              : [{ status: "committed", eventId: observation.eventId, committedBytes: 1 }],
          },
        });
      },
      createActionRecorder: (onCapture) => {
        const action = new FakeActionRecorder();
        actions.push(action);
        captures.push(onCapture);
        return action;
      },
      createMutationRecorder: () => {
        const mutation = new FakeMutationRecorder();
        mutations.push(mutation);
        return mutation;
      },
    });

    await controller.start();
    captures[0]?.(clickObservation);
    captures[0]?.(clickObservation);
    await controller.flush();

    expect(actions[0]?.stopped).toBe(true);
    expect(mutations[0]?.stopped).toBe(true);
    expect(handshakeCount).toBe(2);
    expect(actions).toHaveLength(2);
    expect(mutations).toHaveLength(2);
    expect(sentObservations).toHaveLength(1);

    captures[0]?.(clickObservation);
    await controller.flush();
    expect(sentObservations).toHaveLength(1);

    captures[1]?.(clickObservation);
    await controller.flush();

    expect(sentObservations.at(-1)?.captureEpochId).toBe(resumedEpoch);
    },
  );

  it("bounds inactive stopping re-handshakes with real retry delays and no recorder restart", async () => {
    const retryDelays: number[] = [];
    const actions: FakeActionRecorder[] = [];
    const mutations: FakeMutationRecorder[] = [];
    const captures: Array<(observation: CapturedActionObservation) => void> = [];
    let handshakeCount = 0;
    let eventNo = 0;
    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/",
      now: () => T0,
      newEventId: () => eventIdSchema.parse(`evt_bounded_handshake_${String(eventNo++)}`),
      waitForHandshakeRetry: (delayMs) => {
        retryDelays.push(delayMs);
        return Promise.resolve();
      },
      sendMessage: (message) => {
        if ((message as { type?: string }).type === "handshake/contentScript") {
          handshakeCount += 1;
          return Promise.resolve({
            ok: true,
            value:
              handshakeCount === 1
                ? {
                    active: true,
                    sessionId,
                    captureEpochId,
                    scope,
                    config: defaultSessionConfig(),
                  }
                : { active: false },
          });
        }
        const observation = (message as { observations?: ContentObservationEnvelope[] })
          .observations?.[0];
        return Promise.resolve({
          ok: true,
          value: {
            acks:
              observation === undefined
                ? []
                : [
                    {
                      status: "rejected",
                      eventId: observation.eventId,
                      errorCode: "SESSION_NOT_ACCEPTING_FACTS",
                      retryable: false,
                    },
                  ],
          },
        });
      },
      createActionRecorder: (onCapture) => {
        const action = new FakeActionRecorder();
        actions.push(action);
        captures.push(onCapture);
        return action;
      },
      createMutationRecorder: () => {
        const mutation = new FakeMutationRecorder();
        mutations.push(mutation);
        return mutation;
      },
    });

    await controller.start();
    captures[0]?.(clickObservation);
    await controller.flush();

    expect(handshakeCount).toBe(4);
    expect(retryDelays).toEqual([250, 1_000]);
    expect(actions).toHaveLength(1);
    expect(mutations).toHaveLength(1);
    expect(actions[0]?.stopped).toBe(true);
    expect(mutations[0]?.stopped).toBe(true);
  });
});
