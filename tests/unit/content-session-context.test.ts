import { describe, expect, it } from "vitest";
import {
  acceptsContentObservation,
  classifyContentObservationContext,
  observationMatchesContentSessionContext,
  resolveContentSessionContext,
} from "../../src/background/content-session-context";
import {
  captureEpochIdSchema,
  candidateTokenSchema,
  extTabIdSchema,
  sessionIdSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
} from "../../src/shared/ids";
import { contentObservationEnvelopeSchema } from "../../src/schemas/content-observation";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { defaultSessionConfig, T0 } from "../helpers/fixtures";
import type { SessionRecord, SessionControlRecord } from "../../src/schemas/session";

const sessionId = sessionIdSchema.parse("ses_handshake");
const captureEpochId = captureEpochIdSchema.parse("cep_handshake");
const previousCaptureEpochId = captureEpochIdSchema.parse("cep_handshake_previous");

const session: SessionRecord = {
  schemaVersion: SCHEMA_VERSION,
  sessionId,
  lifecycle: "recording",
  captureQuality: "complete",
  startMode: "no_reload",
  originUrl: "https://example.com/",
  rootTabId: extTabIdSchema.parse(7),
  startedAt: T0,
  config: defaultSessionConfig(),
  captureEpochIds: [previousCaptureEpochId, captureEpochId],
};

const control: SessionControlRecord = {
  schemaVersion: SCHEMA_VERSION,
  sessionId,
  captureEpochId,
  lifecycle: "recording",
  cleanStop: false,
  lastCommittedSeqBySource: {},
  openStepIds: [],
  counters: { totalLogicalBytes: 0, responseBodyLogicalBytes: 0, factCount: 0 },
};

describe("resolveContentSessionContext", () => {
  it("returns the full active context from browser-owned sender identity", async () => {
    const result = await resolveContentSessionContext(
      {
        listSessionsForTab: () => Promise.resolve([session]),
        getControl: () => Promise.resolve(control),
      },
      { tabId: 7, frameId: 3, documentId: "doc-browser-owned" },
    );

    expect(result).toMatchObject({
      active: true,
      sessionId,
      captureEpochId,
      scope: { tabId: 7, frameId: 3, documentId: "doc-browser-owned" },
      config: session.config,
    });
  });

  it("rejects a body-reported scope that differs from browser-owned context", () => {
    const context = {
      sessionId,
      captureEpochId,
      scope: {
        tabId: extTabIdSchema.parse(7),
        frameId: extFrameIdSchema.parse(0),
        documentId: extDocumentIdSchema.parse("doc-browser-owned"),
      },
    };
    const observation = contentObservationEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: eventIdSchema.parse("evt_spoofed_scope"),
      sourceSeq: 0,
      sessionId,
      captureEpochId,
      scope: {
        tabId: extTabIdSchema.parse(99),
        frameId: extFrameIdSchema.parse(4),
        documentId: extDocumentIdSchema.parse("doc-spoofed"),
      },
      sourceTimestamp: T0,
      payload: { kind: "document_replaced", url: "https://example.com/next" },
    });

    expect(observationMatchesContentSessionContext(observation, context)).toBe(false);
    expect(
      observationMatchesContentSessionContext(
        contentObservationEnvelopeSchema.parse({ ...observation, scope: context.scope }),
        context,
      ),
    ).toBe(true);
  });

  it("classifies only browser-scoped, previously issued tuples as stale", () => {
    const context = {
      sessionId,
      captureEpochId,
      scope: {
        tabId: extTabIdSchema.parse(7),
        frameId: extFrameIdSchema.parse(0),
        documentId: extDocumentIdSchema.parse("doc-browser-owned"),
      },
    };
    const makeObservation = (
      epoch: typeof captureEpochId,
      observationScope = context.scope,
    ) =>
      contentObservationEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: eventIdSchema.parse(`evt_context_${epoch}`),
        sourceSeq: 0,
        sessionId,
        captureEpochId: epoch,
        scope: observationScope,
        sourceTimestamp: T0,
        payload: { kind: "document_replaced", url: "https://example.com/next" },
      });

    expect(classifyContentObservationContext(makeObservation(captureEpochId), context, [session]))
      .toBe("current");
    expect(
      classifyContentObservationContext(makeObservation(previousCaptureEpochId), context, [session]),
    ).toBe("stale");
    expect(
      classifyContentObservationContext(
        makeObservation(captureEpochIdSchema.parse("cep_never_issued")),
        context,
        [session],
      ),
    ).toBe("invalid");
    expect(
      classifyContentObservationContext(
        makeObservation(previousCaptureEpochId, {
          ...context.scope,
          documentId: extDocumentIdSchema.parse("doc-forged"),
        }),
        context,
        [session],
      ),
    ).toBe("invalid");
  });

  it("rejects new actions while stopping but accepts late completion facts", () => {
    expect(
      acceptsContentObservation("stopping", {
        kind: "action_started",
        observation: {
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
        },
      }),
    ).toBe(false);
    expect(
      acceptsContentObservation("stopping", {
        kind: "mutation_observed",
        batch: {
          mutations: [],
          domAfter: { captured: false, reason: "no_local_result" },
        },
      }),
    ).toBe(true);
    expect(
      acceptsContentObservation("recording", {
        kind: "candidate_started",
        candidate: {
          token: candidateTokenSchema.parse("can_recording"),
          type: "hover",
          startedAt: T0,
          domBefore: {
            target: { kind: "node", node: { nodeType: "element", tagName: "div" } },
            locators: { cssSelector: "div", xpath: "//div", dataAttributes: {} },
            parentChain: [],
            shadowHostChain: [],
            iframePath: [],
            capturedAt: T0,
          },
        },
      }),
    ).toBe(true);
  });

  it("stays inactive for incomplete senders or unrelated tabs", async () => {
    const repository = {
      listSessionsForTab: (tabId: number) =>
        Promise.resolve(tabId === session.rootTabId ? [session] : []),
      getControl: () => Promise.resolve(control),
    };

    await expect(
      resolveContentSessionContext(repository, { tabId: 7, frameId: 0 }),
    ).resolves.toEqual({ active: false });
    await expect(
      resolveContentSessionContext(repository, {
        tabId: 8,
        frameId: 0,
        documentId: "doc-other",
      }),
    ).resolves.toEqual({ active: false });
  });

  it("allows stopping for late observation verification but not for a new handshake", async () => {
    const stoppingSession: SessionRecord = { ...session, lifecycle: "stopping" };
    const stoppingControl: SessionControlRecord = { ...control, lifecycle: "stopping" };
    const repository = {
      listSessionsForTab: () => Promise.resolve([stoppingSession]),
      getControl: () => Promise.resolve(stoppingControl),
    };
    const sender = { tabId: 7, frameId: 0, documentId: "doc-stopping" };

    await expect(resolveContentSessionContext(repository, sender)).resolves.toMatchObject({
      active: true,
    });
    await expect(
      resolveContentSessionContext(repository, sender, { acceptStopping: false }),
    ).resolves.toEqual({ active: false });
  });
});
