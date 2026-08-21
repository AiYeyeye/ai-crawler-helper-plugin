import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import {
  contentObservationEnvelopeSchema,
  contentObservationPayloadSchema,
  type ContentObservationEnvelope,
} from "../../src/schemas/content-observation";
import {
  handshakeResponseSchema,
  runtimeRequestSchema,
} from "../../src/shared/messages";
import { EnvelopeOutbox } from "../../src/content/envelope-outbox";
import {
  candidateTokenSchema,
  captureEpochIdSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
} from "../../src/shared/ids";
import { defaultSessionConfig, T0 } from "../helpers/fixtures";
import { businessErrorCodeSchema } from "../../src/shared/errors";

const sessionId = sessionIdSchema.parse("ses_observation");
const captureEpochId = captureEpochIdSchema.parse("cep_observation");
const candidateToken = candidateTokenSchema.parse("can_observation");
const scope = {
  tabId: extTabIdSchema.parse(2),
  documentId: extDocumentIdSchema.parse("doc-observation"),
  frameId: extFrameIdSchema.parse(0),
};

const clickObservation = {
  kind: "action_started" as const,
  observation: {
    action: {
      type: "click" as const,
      occurredAt: T0,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    },
    domBefore: {
      target: {
        kind: "node" as const,
        node: { nodeType: "element" as const, tagName: "button" },
      },
      locators: {
        cssSelector: "#save",
        xpath: "//*[@id='save']",
        dataAttributes: {},
      },
      parentChain: [],
      shadowHostChain: [],
      iframePath: [],
      capturedAt: T0,
    },
    candidate: false,
  },
};

describe("content observation protocol", () => {
  it("accepts a versioned action observation with a complete authoritative scope", () => {
    const envelope = contentObservationEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: eventIdSchema.parse("evt_action"),
      sourceSeq: 0,
      sessionId,
      captureEpochId,
      scope,
      sourceTimestamp: T0,
      payload: clickObservation,
    });

    expect(envelope.payload.kind).toBe("action_started");
    expect(envelope.scope).toEqual(scope);
  });

  it("rejects observations that omit document identity", () => {
    const result = contentObservationEnvelopeSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      eventId: "evt_missing_document",
      sourceSeq: 0,
      sessionId,
      captureEpochId,
      scope: { tabId: scope.tabId, frameId: scope.frameId },
      sourceTimestamp: T0,
      payload: clickObservation,
    });

    expect(result.success).toBe(false);
  });

  it("uses a strict mutation/document lifecycle payload union", () => {
    expect(
      contentObservationPayloadSchema.safeParse({
        kind: "candidate_started",
        candidate: {
          token: candidateToken,
          type: "hover",
          startedAt: T0,
          domBefore: clickObservation.observation.domBefore,
        },
      }).success,
    ).toBe(true);
    expect(
      contentObservationPayloadSchema.safeParse({
        kind: "candidate_cancelled",
        candidate: { token: candidateToken, type: "hover", reason: "pointer_leave" },
      }).success,
    ).toBe(true);
    expect(
      contentObservationPayloadSchema.safeParse({
        kind: "candidate_cancelled",
        candidate: { token: candidateToken, type: "hover", reason: "promoted" },
      }).success,
    ).toBe(false);
    expect(
      contentObservationPayloadSchema.safeParse({
        kind: "mutation_observed",
        batch: {
          mutations: [],
          domAfter: { captured: false, reason: "no_local_result" },
        },
      }).success,
    ).toBe(true);
    expect(
      contentObservationPayloadSchema.safeParse({
        kind: "document_replaced",
        url: "https://example.com/next",
      }).success,
    ).toBe(true);
    expect(contentObservationPayloadSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });

  it("requires the full recorder context in an active handshake", () => {
    const active = handshakeResponseSchema.parse({
      active: true,
      sessionId,
      captureEpochId,
      scope,
      config: defaultSessionConfig(),
    });
    expect(active.active).toBe(true);

    expect(handshakeResponseSchema.safeParse({ active: true, sessionId }).success).toBe(false);
    expect(handshakeResponseSchema.parse({ active: false })).toEqual({ active: false });
  });

  it("registers observation submission as a runtime request", () => {
    const observation = contentObservationEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: eventIdSchema.parse("evt_runtime"),
      sourceSeq: 1,
      sessionId,
      captureEpochId,
      scope,
      sourceTimestamp: T0,
      payload: clickObservation,
    });
    const parsed = runtimeRequestSchema.parse({
      protocolVersion: 1,
      type: "observations/submit",
      observations: [observation],
    });

    expect(parsed.type).toBe("observations/submit");
  });

  it("keeps malformed observations invalid while exposing a stale-context ACK code", () => {
    const malformed = runtimeRequestSchema.safeParse({
      protocolVersion: 1,
      type: "observations/submit",
      observations: [
        {
          schemaVersion: SCHEMA_VERSION,
          eventId: "evt_malformed_context",
          sourceSeq: 1,
          sessionId,
          captureEpochId,
          scope: { tabId: scope.tabId, frameId: scope.frameId },
          sourceTimestamp: T0,
          payload: clickObservation,
        },
      ],
    });

    expect(malformed.success).toBe(false);
    expect(businessErrorCodeSchema.safeParse("CAPTURE_CONTEXT_STALE").success).toBe(true);
  });

  it("replays observations through the same ACK outbox using the observation route", async () => {
    const observation = contentObservationEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: eventIdSchema.parse("evt_outbox_observation"),
      sourceSeq: 2,
      sessionId,
      captureEpochId,
      scope,
      sourceTimestamp: T0,
      payload: clickObservation,
    });
    const sent: unknown[] = [];
    const outbox = new EnvelopeOutbox<ContentObservationEnvelope>(
      (message) => {
        sent.push(message);
        return Promise.resolve({
          ok: true,
          value: {
            acks: [{ status: "committed", eventId: observation.eventId, committedBytes: 1 }],
          },
        });
      },
      "observations/submit",
    );
    outbox.enqueue(observation);

    await outbox.flush();

    expect(sent).toEqual([
      {
        protocolVersion: 1,
        type: "observations/submit",
        observations: [observation],
      },
    ]);
    expect(outbox.pendingCount()).toBe(0);
  });
});
