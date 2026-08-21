import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, schemaVersionSchema } from "../../src/schemas/common";
import {
  browserContextEvidenceSchema,
  contextLinkageSchema,
  draftStepSchema,
  explicitContextLinkSchema,
  sealedStepSchema,
  storedStepSchema,
} from "../../src/schemas/step";
import { responseBodyResultSchema } from "../../src/schemas/network";
import { domAfterSchema } from "../../src/schemas/dom";
import { eventEnvelopeSchema, factPayloadSchema } from "../../src/schemas/event-envelope";
import { downloadStartResponseSchema } from "../../src/shared/messages";
import {
  captureGapRecordSchema,
  captureGapRecoverySchema,
} from "../../src/schemas/capture-gap";
import {
  candidateTokenSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  cdpFrameIdSchema,
  type ExtDocumentId,
  type CdpFrameId,
} from "../../src/shared/ids";
import {
  T0,
  makeDraftSystemActivityStep,
  makeEnvelope,
  stepId,
} from "../helpers/fixtures";
import type { SessionRecord } from "../../src/schemas/session";
import { sessionRecordSchema } from "../../src/schemas/session";
import { defaultSessionConfig } from "../helpers/fixtures";
import { sessionIdSchema, captureEpochIdSchema } from "../../src/shared/ids";

const makeSession = (): SessionRecord =>
  sessionRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionIdSchema.parse("ses_schema_test"),
    lifecycle: "recording",
    captureQuality: "complete",
    startMode: "no_reload",
    originUrl: "https://example.com/",
    rootTabId: extTabIdSchema.parse(1),
    startedAt: T0,
    config: defaultSessionConfig(),
    captureEpochIds: [captureEpochIdSchema.parse("cep_schema_test")],
  });

describe("schema version compatibility", () => {
  it("writes version 4 while retaining read compatibility with versions 1-3", () => {
    expect(SCHEMA_VERSION).toBe(4);
    expect(schemaVersionSchema.safeParse(1).success).toBe(true);
    expect(schemaVersionSchema.safeParse(2).success).toBe(true);
    expect(schemaVersionSchema.safeParse(3).success).toBe(true);
    expect(schemaVersionSchema.safeParse(4).success).toBe(true);
    expect(schemaVersionSchema.safeParse(5).success).toBe(false);
  });
});

describe("step discriminated unions", () => {
  it("accepts a draft system_activity step and reports its phase", () => {
    const step = makeDraftSystemActivityStep(makeSession(), stepId(1), 0);
    const parsed = storedStepSchema.parse(step);
    expect(parsed.phase).toBe("draft");
    expect(parsed.kind).toBe("system_activity");
  });

  it("rejects an unknown step kind (parse error, no silent fallthrough)", () => {
    const step: Record<string, unknown> = {
      ...makeDraftSystemActivityStep(makeSession(), stepId(2), 0),
      kind: "mystery_kind",
    };
    expect(draftStepSchema.safeParse(step).success).toBe(false);
    expect(storedStepSchema.safeParse(step).success).toBe(false);
  });

  it("rejects a user_action sealed step without action/domBefore (contract: system vs user shapes differ)", () => {
    const draft = makeDraftSystemActivityStep(makeSession(), stepId(3), 0);
    const fakeSealed: Record<string, unknown> = {
      ...draft,
      kind: "user_action",
      type: "click",
      phase: "sealed",
      endedAt: T0 + 100,
      closeReason: "network_quiet",
      domAfter: { captured: false, reason: "no_local_result" },
      // missing: action, domBefore
    };
    expect(sealedStepSchema.safeParse(fakeSealed).success).toBe(false);
  });

  it("rejects a sealed step missing convergence fields (domAfter/closeReason)", () => {
    const draft = makeDraftSystemActivityStep(makeSession(), stepId(4), 0);
    const incomplete: Record<string, unknown> = { ...draft, phase: "sealed" };
    expect(sealedStepSchema.safeParse(incomplete).success).toBe(false);
  });

  it("system_activity steps cannot fake user-action fields (strict schema)", () => {
    const draft = makeDraftSystemActivityStep(makeSession(), stepId(5), 0);
    const polluted: Record<string, unknown> = {
      ...draft,
      domBefore: { anything: true },
    };
    expect(draftStepSchema.safeParse(polluted).success).toBe(false);
  });

  it("requires candidateToken exactly when a user-action draft is a candidate", () => {
    const activity = makeDraftSystemActivityStep(makeSession(), stepId(8), 0);
    const { trigger: _trigger, backgroundCandidate: _backgroundCandidate, ...base } = activity;
    const candidateToken = candidateTokenSchema.parse("can_schema_candidate");
    const candidate = {
      ...base,
      kind: "user_action",
      type: "hover",
      candidate: true,
      candidateToken,
    };

    expect(draftStepSchema.safeParse(candidate).success).toBe(true);
    const withoutToken: Record<string, unknown> = { ...candidate };
    delete withoutToken.candidateToken;
    expect(draftStepSchema.safeParse(withoutToken).success).toBe(false);

    expect(
      draftStepSchema.safeParse({
        ...candidate,
        candidate: false,
      }).success,
    ).toBe(false);
    const { candidateToken: _candidateToken, ...promoted } = candidate;
    expect(
      draftStepSchema.safeParse({
        ...promoted,
        candidate: false,
      }).success,
    ).toBe(true);
  });
});

describe("cross-context linkage schemas", () => {
  it("requires both sourceStepId and targetStepId on a verified explicit link", () => {
    const sourceStepId = stepId(10);
    const targetStepId = stepId(11);
    const link = {
      sourceStepId,
      targetStepId,
      relationType: "triggered_by_step",
      evidenceType: "created_navigation_target",
      evidenceId: "target-created-1",
      confidence: "verified",
    };

    expect(explicitContextLinkSchema.parse(link)).toEqual(link);
    const withoutTarget: Record<string, unknown> = { ...link };
    delete withoutTarget.targetStepId;
    expect(explicitContextLinkSchema.safeParse(withoutTarget).success).toBe(false);
  });

  it("uses a strict verified/ambiguous/unlinked discriminated union", () => {
    const sourceStepId = stepId(12);
    const targetStepId = stepId(13);
    const evidence = {
      evidenceType: "confirmed_action_token",
      evidenceId: "action-token-1",
      sourceStepId,
    };

    expect(
      contextLinkageSchema.safeParse({
        state: "verified",
        link: {
          ...evidence,
          targetStepId,
          relationType: "triggered_by_step",
          confidence: "verified",
        },
      }).success,
    ).toBe(true);
    expect(
      contextLinkageSchema.safeParse({
        state: "ambiguous",
        targetStepId,
        reason: "duplicate_evidence",
        evidence: [evidence, evidence],
      }).success,
    ).toBe(true);
    expect(
      contextLinkageSchema.safeParse({
        state: "unlinked",
        targetStepId,
        reason: "missing_browser_evidence",
      }).success,
    ).toBe(true);
    expect(contextLinkageSchema.safeParse({ state: "mystery", targetStepId }).success).toBe(
      false,
    );
    expect(
      contextLinkageSchema.safeParse({
        state: "unlinked",
        targetStepId,
        reason: "missing_browser_evidence",
        sourceStepId,
      }).success,
    ).toBe(false);
  });

  it("accepts only the three browser-verifiable evidence variants", () => {
    const sourceStepId = stepId(14);
    for (const evidenceType of [
      "created_navigation_target",
      "opener_tab_id",
      "confirmed_action_token",
    ] as const) {
      expect(
        browserContextEvidenceSchema.safeParse({
          evidenceType,
          evidenceId: `evidence-${evidenceType}`,
          sourceStepId,
        }).success,
      ).toBe(true);
    }

    expect(
      browserContextEvidenceSchema.safeParse({
        evidenceType: "time_proximity",
        evidenceId: "recent-step",
        sourceStepId,
      }).success,
    ).toBe(false);
    expect(
      browserContextEvidenceSchema.safeParse({
        evidenceType: "opener_tab_id",
        evidenceId: "opener-1",
        sourceStepId,
        observedAt: T0,
      }).success,
    ).toBe(false);
  });

  it("rejects a verified link whose relation contradicts its evidence type", () => {
    expect(
      explicitContextLinkSchema.safeParse({
        sourceStepId: stepId(15),
        targetStepId: stepId(16),
        relationType: "triggered_by_step",
        evidenceType: "opener_tab_id",
        evidenceId: "opener-1",
        confidence: "verified",
      }).success,
    ).toBe(false);
  });
});

describe("absent-data tri-state (never fake empty values)", () => {
  it("response body result rejects a bare empty string and requires a discriminant", () => {
    expect(responseBodyResultSchema.safeParse("").success).toBe(false);
    expect(responseBodyResultSchema.safeParse({}).success).toBe(false);
    expect(
      responseBodyResultSchema.safeParse({
        kind: "unavailable",
        reason: "cdp_get_response_body_failed",
      }).success,
    ).toBe(true);
    expect(
      responseBodyResultSchema.safeParse({
        kind: "missing_due_to_gap",
        gapId: "gap_x",
      }).success,
    ).toBe(true);
  });

  it("domAfter must be explicitly captured or carry an explicit reason", () => {
    expect(domAfterSchema.safeParse({}).success).toBe(false);
    expect(
      domAfterSchema.safeParse({ captured: false, reason: "document_replaced" }).success,
    ).toBe(true);
    expect(domAfterSchema.safeParse({ captured: false }).success).toBe(false);
  });

  it("accepts an explicit bounded-mutation truncation summary", () => {
    expect(
      domAfterSchema.safeParse({
        captured: true,
        mutationSummary: { added: 0, updated: 128, removed: 0 },
        capturedAt: T0,
        truncated: true,
        truncationSummary: {
          reasons: ["records"],
          seen: { added: 0, updated: 5_000, removed: 0 },
          retained: { added: 0, updated: 128, removed: 0 },
          dropped: { added: 0, updated: 4_872, removed: 0 },
        },
      }).success,
    ).toBe(true);
  });
});

describe("capture gap schemas", () => {
  it.each(["target_destroyed", "session_stopped", "collector_disconnected"])(
    "accepts the %s terminal recovery action",
    (action) => {
      expect(
        captureGapRecoverySchema.parse({
          action,
          recoveredAt: T0,
        }),
      ).toEqual({ action, recoveredAt: T0 });
    },
  );

  it("accepts a navigation gap when the MAIN-world History bridge is unavailable", () => {
    const session = makeSession();
    const record = {
      schemaVersion: SCHEMA_VERSION,
      gapId: captureGapRecordSchema.shape.gapId.parse("gap_history_bridge"),
      scope: {
        sessionId: session.sessionId,
        tabId: session.rootTabId,
        frameId: extFrameIdSchema.parse(0),
        documentId: extDocumentIdSchema.parse("doc_history_bridge"),
        collector: "navigation",
      },
      reason: "history_bridge_unavailable",
      observedStartedAt: T0,
      boundaryConfidence: "exact",
      recoverable: false,
      affectedCapabilities: ["navigation"],
    } as const;

    expect(captureGapRecordSchema.parse(record)).toEqual(record);
  });
});

describe("runtime message boundary schemas", () => {
  it("accepts only a numeric download id from the service worker", () => {
    expect(downloadStartResponseSchema.parse({ downloadId: 17 })).toEqual({ downloadId: 17 });
    expect(downloadStartResponseSchema.safeParse({ downloadId: "17" }).success).toBe(false);
  });
});

describe("event envelope", () => {
  it("round-trips a valid envelope", () => {
    const session = makeSession();
    const envelope = makeEnvelope(session.sessionId, {
      kind: "step_draft_upsert",
      step: makeDraftSystemActivityStep(session, stepId(6), 0),
    });
    expect(eventEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects unknown payload kinds", () => {
    const session = makeSession();
    const envelope: Record<string, unknown> = {
      ...makeEnvelope(session.sessionId, {
        kind: "capture_gap_close",
        gapId: captureGapRecordSchema.shape.gapId.parse("gap_1"),
        observedEndedAt: T0,
      }),
      payload: { kind: "unknown_kind" },
    };
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("rejects wrong schemaVersion", () => {
    const session = makeSession();
    const envelope: Record<string, unknown> = {
      ...makeEnvelope(session.sessionId, {
        kind: "step_draft_upsert",
        step: makeDraftSystemActivityStep(session, stepId(7), 0),
      }),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("validates token-guarded step_draft_delete payloads", () => {
    const payload = {
      kind: "step_draft_delete",
      stepId: stepId(17),
      candidateToken: candidateTokenSchema.parse("can_delete_schema"),
    };

    expect(factPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      factPayloadSchema.safeParse({
        kind: "step_draft_delete",
        stepId: stepId(17),
      }).success,
    ).toBe(false);
  });
});

describe("branded identifier spaces", () => {
  it("brands survive parsing and hold their raw values", () => {
    const extDoc: ExtDocumentId = extDocumentIdSchema.parse("ABC");
    const cdpFrame: CdpFrameId = cdpFrameIdSchema.parse("ABC");
    // Runtime values are equal strings, but the type system forbids
    // assigning one to the other (see tests/unit/type-assertions.ts).
    expect(String(extDoc)).toBe(String(cdpFrame));
  });

  it("ext tab id rejects non-integers", () => {
    expect(extTabIdSchema.safeParse(1.5).success).toBe(false);
    expect(extTabIdSchema.safeParse(-1).success).toBe(false);
  });
});
