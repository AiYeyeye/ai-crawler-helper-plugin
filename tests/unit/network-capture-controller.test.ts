import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NetworkCaptureController,
  type DebuggerCaptureContext,
  type NetworkCaptureControllerOptions,
  type NetworkStepProcessor,
} from "../../src/background/network-capture-controller";
import type { DebuggerCommandTarget, DebuggerTransport } from "../../src/background/debugger-session-manager";
import type { EnvelopeAck, EventEnvelope } from "../../src/schemas/event-envelope";
import type { SessionConfig } from "../../src/schemas/session";
import type { StepContext } from "../../src/core/step-orchestrator";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  cdpSessionIdSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
  stepIdSchema,
  type EventId,
  type StepId,
} from "../../src/shared/ids";

const T0 = 1_700_000_000_000;

class EnvelopeSink {
  readonly envelopes: EventEnvelope[] = [];

  ingest = (envelope: EventEnvelope): Promise<EnvelopeAck> => {
    this.envelopes.push(envelope);
    return Promise.resolve({
      status: "committed",
      eventId: envelope.eventId,
      committedBytes: 1,
    });
  };
}

class BodyTransport implements DebuggerTransport {
  readonly methods: string[] = [];

  attach(): Promise<void> {
    return Promise.resolve();
  }

  detach(): Promise<void> {
    return Promise.resolve();
  }

  sendCommand(
    _target: DebuggerCommandTarget,
    method: string,
  ): Promise<unknown> {
    this.methods.push(method);
    if (method === "Network.getResponseBody") {
      return Promise.resolve({ body: "{\"ok\":true}", base64Encoded: false });
    }
    return Promise.resolve({});
  }
}

const debuggerContext: DebuggerCaptureContext = {
  sessionId: sessionIdSchema.parse("ses-controller"),
  tabId: extTabIdSchema.parse(5),
  attachEpoch: attachEpochSchema.parse(2),
};

const stepContext: StepContext = {
  sessionId: debuggerContext.sessionId,
  captureEpochId: captureEpochIdSchema.parse("cep-controller"),
  scope: {
    tabId: debuggerContext.tabId,
    frameId: extFrameIdSchema.parse(0),
    documentId: extDocumentIdSchema.parse("doc-controller"),
  },
};

const config: SessionConfig = {
  responseBodySoftBudgetBytes: 100 * 1024 * 1024,
  responseBodyMaxBytes: 2 * 1024 * 1024,
  hoverDwellThresholdMs: 500,
  networkQuietWindowMs: 800,
  stepMaxWindowMs: 10_000,
  userFilterRules: [],
  extraCookieDomains: [],
};

const makeController = (
  resolveRequestContext: NetworkCaptureControllerOptions["resolveRequestContext"] = () =>
    Promise.resolve({
      stepContext,
      identifierMapping: {
        state: "unmapped",
        ext: stepContext.scope,
      },
    }),
  controllerOptions: Record<string, unknown> = {},
) => {
  const sink = new EnvelopeSink();
  const transport = new BodyTransport();
  const starts: string[] = [];
  const finishes: string[] = [];
  const messageObservations: number[] = [];
  const processor: NetworkStepProcessor = {
    recordNetworkRequestStarted: (_context, requestKey) => {
      starts.push(requestKey);
      return Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-controller") });
    },
    recordNetworkRequestFinished: (_sessionId, requestKey) => {
      finishes.push(requestKey);
      return Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-controller") });
    },
    recordNetworkMessageObserved: (_context, observedAt) => {
      messageObservations.push(observedAt);
      return Promise.resolve({
        observedDuringStepId: stepIdSchema.parse("stp-message-observed"),
      });
    },
  };
  let eventNumber = 0;
  const newEventId = (): EventId => eventIdSchema.parse(`evt-network-${String(eventNumber++)}`);
  const controller = new NetworkCaptureController({
    ingestor: sink,
    transport,
    resolveDebuggerContext: () => debuggerContext,
    resolveRequestContext,
    processorForSession: () => processor,
    sessionConfigFor: () => Promise.resolve(config),
    newEventId,
    ...controllerOptions,
  });
  return { controller, sink, transport, starts, finishes, messageObservations };
};

describe("NetworkCaptureController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists start, authoritative ExtraInfo response, body, and terminal metadata", async () => {
    const { controller, sink, transport, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-CONTROLLER",
      timestamp: 10,
      wallTime: T0 / 1_000,
      type: "Fetch",
      frameId: "FRAME-1",
      loaderId: "LOADER-1",
      request: {
        url: "https://example.com/api",
        method: "GET",
        headers: { accept: "application/json" },
      },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-CONTROLLER",
      statusCode: 403,
      headers: { "content-type": "application/json" },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-CONTROLLER",
      timestamp: 10.01,
      type: "Fetch",
      response: {
        status: 0,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
      },
    });
    await controller.handleNetworkEvent(source, "Network.loadingFinished", {
      requestId: "REQ-CONTROLLER",
      timestamp: 10.025,
      encodedDataLength: 11,
    });

    expect(starts).toHaveLength(1);
    expect(finishes).toEqual(starts);
    expect(transport.methods).toEqual(["Network.getResponseBody"]);
    expect(sink.envelopes.map((envelope) => envelope.payload.kind)).toEqual([
      "request_metadata",
      "request_metadata",
      "request_metadata",
      "response_body",
      "request_metadata",
    ]);
    const terminal = sink.envelopes.at(-1)?.payload;
    expect(terminal).toMatchObject({
      kind: "request_metadata",
      record: {
        statusCode: 403,
        completedAt: T0 + 25,
        durationMs: 25,
        responseBody: {
          kind: "captured",
          byteLength: 11,
          encoding: "utf8",
        },
      },
    });
    expect(
      sink.envelopes.some((envelope) =>
        envelope.payload.kind === "request_metadata" &&
        envelope.payload.record.responseBody?.kind === "unavailable",
      ),
    ).toBe(false);
  });

  it("treats a negative encoded length as unknown and captures a text body", async () => {
    const { controller, sink, transport, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-UNKNOWN-TEXT-LENGTH",
      timestamp: 15,
      wallTime: T0 / 1_000,
      type: "Fetch",
      request: {
        url: "https://example.com/unknown-text",
        method: "GET",
        headers: {},
      },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-UNKNOWN-TEXT-LENGTH",
      timestamp: 15.01,
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
      },
    });

    await expect(
      controller.handleNetworkEvent(source, "Network.loadingFinished", {
        requestId: "REQ-UNKNOWN-TEXT-LENGTH",
        timestamp: 15.02,
        encodedDataLength: -1,
      }),
    ).resolves.toBeUndefined();

    expect(transport.methods).toEqual(["Network.getResponseBody"]);
    expect(finishes).toEqual(starts);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        completedAt: T0 + 20,
        responseBody: { kind: "captured", byteLength: 11, encoding: "utf8" },
      },
    });
  });

  it("omits an unknown byte length for binary metadata without fetching a body", async () => {
    const { controller, sink, transport, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-UNKNOWN-BINARY-LENGTH",
      timestamp: 16,
      wallTime: T0 / 1_000,
      type: "Image",
      request: {
        url: "https://example.com/image.png",
        method: "GET",
        headers: {},
      },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-UNKNOWN-BINARY-LENGTH",
      timestamp: 16.01,
      response: {
        status: 200,
        headers: { "content-type": "image/png" },
        mimeType: "image/png",
      },
    });

    await expect(
      controller.handleNetworkEvent(source, "Network.loadingFinished", {
        requestId: "REQ-UNKNOWN-BINARY-LENGTH",
        timestamp: 16.02,
        encodedDataLength: -1,
      }),
    ).resolves.toBeUndefined();

    expect(transport.methods).toEqual([]);
    expect(finishes).toEqual(starts);
    const payload = sink.envelopes.at(-1)?.payload;
    if (payload?.kind !== "request_metadata") {
      throw new Error("expected terminal binary request metadata");
    }
    expect(payload.record.responseBody).toEqual({
      kind: "binary_metadata_only",
      mimeType: "image/png",
    });
  });

  it("persists loadingFailed as an explicit terminal failure without requesting a body", async () => {
    const { controller, sink, transport, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-FAILED",
      timestamp: 20,
      wallTime: T0 / 1_000,
      type: "XHR",
      request: {
        url: "https://example.com/fail",
        method: "POST",
        headers: {},
      },
    });
    await controller.handleNetworkEvent(source, "Network.loadingFailed", {
      requestId: "REQ-FAILED",
      timestamp: 20.02,
      type: "XHR",
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    expect(transport.methods).toEqual([]);
    expect(finishes).toHaveLength(1);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        completedAt: T0 + 20,
        failure: { errorText: "net::ERR_FAILED", canceled: false },
      },
    });
  });

  it("counts attach/pause-explained orphan tails without opening another gap", async () => {
    const classifyOrphanNetworkEvent = vi.fn(() => "explained");
    const { controller, sink, finishes, messageObservations } = makeController(
      undefined,
      { classifyOrphanNetworkEvent },
    );
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-CLOCK-SEED",
      timestamp: 29,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/seed", method: "GET", headers: {} },
    });
    sink.envelopes.length = 0;
    const orphanEvents: Array<[string, Record<string, unknown>]> = [
      [
        "Network.responseReceived",
        {
          requestId: "REQ-ORPHAN",
          timestamp: 30,
          response: { status: 200, headers: {} },
        },
      ],
      [
        "Network.loadingFinished",
        { requestId: "REQ-ORPHAN", timestamp: 30.01, encodedDataLength: 10 },
      ],
      [
        "Network.loadingFailed",
        {
          requestId: "REQ-ORPHAN-FAILED",
          timestamp: 30.02,
          errorText: "net::ERR_ABORTED",
          canceled: true,
        },
      ],
      ["Network.webSocketClosed", { requestId: "WS-ORPHAN", timestamp: 30.03 }],
      [
        "Network.webSocketFrameError",
        { requestId: "WS-ORPHAN", timestamp: 30.04, errorMessage: "ws error" },
      ],
      [
        "Network.webSocketFrameReceived",
        {
          requestId: "WS-ORPHAN",
          timestamp: 30.05,
          response: { opcode: 1, mask: false, payloadData: "x" },
        },
      ],
      [
        "Network.eventSourceMessageReceived",
        {
          requestId: "SSE-ORPHAN",
          timestamp: 30.06,
          eventName: "message",
          eventId: "1",
          data: "x",
        },
      ],
    ];
    for (const [method, params] of orphanEvents) {
      await expect(
        controller.handleNetworkEvent(source, method, params),
      ).resolves.toBeUndefined();
    }
    expect(sink.envelopes).toEqual([]);
    expect(finishes).toEqual([]);
    expect(messageObservations).toEqual([]);
    expect(classifyOrphanNetworkEvent).toHaveBeenCalledTimes(orphanEvents.length);
  });

  it("opens one nonrecoverable gap for unexplained orphan tails in one source window", async () => {
    const { controller, sink } = makeController(undefined, {
      orphanGapWindowMs: 1_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-CLOCK-SEED",
      timestamp: 29,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/seed", method: "GET", headers: {} },
    });
    sink.envelopes.length = 0;
    for (const requestId of ["REQ-ORPHAN-A", "REQ-ORPHAN-B"]) {
      await controller.handleNetworkEvent(source, "Network.responseReceived", {
        requestId,
        timestamp: 30,
        response: { status: 200, headers: {} },
      });
    }

    const gapPayloads = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gapPayloads).toHaveLength(1);
    expect(gapPayloads[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: {
        reason: "other_unrecoverable_window",
        recoverable: false,
        scope: { collector: "debugger_network" },
      },
    });
  });

  it("forgets session-owned request chains before late events reuse the debugger source", async () => {
    const { controller, sink } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-FORGOTTEN",
      timestamp: 31,
      wallTime: T0 / 1_000,
      type: "Fetch",
      request: {
        url: "https://example.com/forgotten",
        method: "GET",
        headers: {},
      },
    });
    const envelopeCountBeforeDisconnect = sink.envelopes.length;

    await controller.forgetSession(debuggerContext.sessionId);
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-FORGOTTEN",
      timestamp: 31.01,
      response: { status: 200, headers: {}, mimeType: "application/json" },
    });

    expect(sink.envelopes).toHaveLength(envelopeCountBeforeDisconnect);
  });

  it("persists ExtraInfo that arrives after loadingFinished back to the original request", async () => {
    const { controller, sink } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-LATE-EXTRA",
      timestamp: 30,
      wallTime: T0 / 1_000,
      type: "Image",
      request: {
        url: "https://example.com/image.png",
        method: "GET",
        headers: {},
      },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-LATE-EXTRA",
      timestamp: 30.01,
      response: {
        status: 200,
        headers: { "content-type": "image/png" },
        mimeType: "image/png",
      },
    });
    await controller.handleNetworkEvent(source, "Network.loadingFinished", {
      requestId: "REQ-LATE-EXTRA",
      timestamp: 30.02,
      encodedDataLength: 128,
    });
    await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-LATE-EXTRA",
      statusCode: 304,
      headers: { "content-type": "image/png", "x-cache": "hit" },
    });

    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        statusCode: 304,
        completedAt: T0 + 20,
        responseHeaders: [
          { name: "content-type", value: "image/png" },
          { name: "x-cache", value: "hit" },
        ],
        responseBody: {
          kind: "binary_metadata_only",
          byteLength: 128,
          mimeType: "image/png",
        },
      },
    });
  });

  it("persists WebSocket text in both directions and binary frames as metadata only", async () => {
    const { controller, sink, messageObservations } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-WEBSOCKET",
      timestamp: 40,
      wallTime: T0 / 1_000,
      type: "WebSocket",
      request: {
        url: "wss://example.com/socket",
        method: "GET",
        headers: {},
      },
    });

    await controller.handleNetworkEvent(source, "Network.webSocketFrameSent", {
      requestId: "REQ-WEBSOCKET",
      timestamp: 40.01,
      response: { opcode: 1, mask: true, payloadData: "hello" },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketFrameReceived", {
      requestId: "REQ-WEBSOCKET",
      timestamp: 40.02,
      response: { opcode: 1, mask: false, payloadData: "world" },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketFrameReceived", {
      requestId: "REQ-WEBSOCKET",
      timestamp: 40.03,
      response: { opcode: 2, mask: false, payloadData: "AAEC" },
    });

    expect(messageObservations).toEqual([T0 + 10, T0 + 20, T0 + 30]);
    expect(sink.envelopes.slice(1).map((envelope) => envelope.payload)).toMatchObject([
      {
        kind: "network_stream_message",
        record: {
          kind: "websocket",
          direction: "sent",
          startedInStepId: "stp-controller",
          observedDuringStepId: "stp-message-observed",
          payload: { kind: "text", text: "hello", byteLength: 5 },
        },
      },
      {
        kind: "network_stream_message",
        record: {
          kind: "websocket",
          direction: "received",
          payload: { kind: "text", text: "world", byteLength: 5 },
        },
      },
      {
        kind: "network_stream_message",
        record: {
          kind: "websocket",
          direction: "received",
          payload: { kind: "binary_metadata_only", opcode: 2, byteLength: 3 },
        },
      },
    ]);
    expect(JSON.stringify(sink.envelopes.at(-1)?.payload)).not.toContain("AAEC");
  });

  it("creates and releases a WebSocket request from handshake events without requestWillBeSent", async () => {
    const { controller, sink, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.webSocketCreated", {
      requestId: "REQ-WS-HANDSHAKE",
      url: "wss://example.com/socket",
      initiator: { type: "script" },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketWillSendHandshakeRequest", {
      requestId: "REQ-WS-HANDSHAKE",
      timestamp: 45,
      wallTime: T0 / 1_000,
      request: { headers: { upgrade: "websocket", connection: "Upgrade" } },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketHandshakeResponseReceived", {
      requestId: "REQ-WS-HANDSHAKE",
      timestamp: 45.01,
      response: { status: 101, headers: { upgrade: "websocket" } },
    });

    expect(starts).toHaveLength(1);
    expect(finishes).toEqual(starts);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        method: "GET",
        url: "wss://example.com/socket",
        resourceType: "WebSocket",
        statusCode: 101,
        blocksStep: false,
        requestHeaders: [
          { name: "upgrade", value: "websocket" },
          { name: "connection", value: "Upgrade" },
        ],
      },
    });
  });

  it("persists webSocketClosed as terminal metadata without releasing the Step twice", async () => {
    const { controller, sink, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.webSocketCreated", {
      requestId: "REQ-WS-CLOSED",
      url: "wss://example.com/closed",
    });
    await controller.handleNetworkEvent(source, "Network.webSocketWillSendHandshakeRequest", {
      requestId: "REQ-WS-CLOSED",
      timestamp: 46,
      wallTime: T0 / 1_000,
      request: { headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketHandshakeResponseReceived", {
      requestId: "REQ-WS-CLOSED",
      timestamp: 46.01,
      response: { status: 101, headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketClosed", {
      requestId: "REQ-WS-CLOSED",
      timestamp: 46.02,
    });

    expect(finishes).toEqual(starts);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        blocksStep: false,
        completedAt: T0 + 20,
        durationMs: 20,
      },
    });
  });

  it("does not duplicate a WebSocket request when requestWillBeSent also exists", async () => {
    const { controller, sink, starts } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-WS-ORDINARY-TOO",
      timestamp: 47,
      wallTime: T0 / 1_000,
      type: "WebSocket",
      request: {
        url: "wss://example.com/ordinary-too",
        method: "GET",
        headers: { origin: "https://example.com" },
      },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketCreated", {
      requestId: "REQ-WS-ORDINARY-TOO",
      url: "wss://example.com/ordinary-too",
    });
    await controller.handleNetworkEvent(source, "Network.webSocketWillSendHandshakeRequest", {
      requestId: "REQ-WS-ORDINARY-TOO",
      timestamp: 47.001,
      wallTime: (T0 + 1) / 1_000,
      request: { headers: { origin: "https://example.com", upgrade: "websocket" } },
    });

    expect(starts).toHaveLength(1);
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "request_metadata"),
    ).toHaveLength(2);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        keyParts: { redirectHop: 0 },
        requestHeaders: [
          { name: "origin", value: "https://example.com" },
          { name: "upgrade", value: "websocket" },
        ],
      },
    });
  });

  it("records a runtime-interrupted gap when a WebSocket handshake has no creation context", async () => {
    const { controller, sink, starts } = makeController();
    const source = { tabId: debuggerContext.tabId };

    await expect(
      controller.handleNetworkEvent(source, "Network.webSocketWillSendHandshakeRequest", {
        requestId: "REQ-WS-CREATION-LOST",
        timestamp: 48,
        wallTime: T0 / 1_000,
        request: { headers: { upgrade: "websocket" } },
      }),
    ).resolves.toBeUndefined();

    expect(starts).toEqual([]);
    const payload = sink.envelopes.at(-1)?.payload;
    expect(payload).toMatchObject({
      kind: "capture_gap_open",
      record: {
        reason: "runtime_interrupted",
        recoverable: false,
        affectedCapabilities: ["network_metadata", "network_bodies"],
      },
    });
    if (payload?.kind !== "capture_gap_open") {
      throw new Error("expected a WebSocket creation-loss CaptureGap");
    }
    expect(payload.record.detail).toContain("REQ-WS-CREATION-LOST");
    await expect(
      controller.handleNetworkEvent(source, "Network.webSocketFrameReceived", {
        requestId: "REQ-WS-CREATION-LOST",
        timestamp: 48.01,
        response: { opcode: 1, mask: false, payloadData: "unrecoverable" },
      }),
    ).resolves.toBeUndefined();
    expect(sink.envelopes).toHaveLength(1);
  });

  it("persists webSocketFrameError as a terminal failure", async () => {
    const { controller, sink, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.webSocketCreated", {
      requestId: "REQ-WS-FRAME-ERROR",
      url: "wss://example.com/frame-error",
    });
    await controller.handleNetworkEvent(source, "Network.webSocketWillSendHandshakeRequest", {
      requestId: "REQ-WS-FRAME-ERROR",
      timestamp: 49,
      wallTime: T0 / 1_000,
      request: { headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketHandshakeResponseReceived", {
      requestId: "REQ-WS-FRAME-ERROR",
      timestamp: 49.01,
      response: { status: 101, headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.webSocketFrameError", {
      requestId: "REQ-WS-FRAME-ERROR",
      timestamp: 49.02,
      errorMessage: "WebSocket protocol error",
    });

    expect(finishes).toEqual(starts);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        completedAt: T0 + 20,
        failure: { errorText: "WebSocket protocol error", canceled: false },
      },
    });
  });

  it("persists EventSource messages as text facts", async () => {
    const { controller, sink } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-SSE",
      timestamp: 50,
      wallTime: T0 / 1_000,
      type: "EventSource",
      request: {
        url: "https://example.com/events",
        method: "GET",
        headers: { accept: "text/event-stream" },
      },
    });
    await controller.handleNetworkEvent(source, "Network.eventSourceMessageReceived", {
      requestId: "REQ-SSE",
      timestamp: 50.04,
      eventName: "inventory.updated",
      eventId: "evt-42",
      data: "{\"count\":2}",
    });

    const payload = sink.envelopes.at(-1)?.payload;
    expect(payload).toMatchObject({
      kind: "network_stream_message",
      record: {
        kind: "sse",
        startedInStepId: "stp-controller",
        observedDuringStepId: "stp-message-observed",
        eventName: "inventory.updated",
        serverEventId: "evt-42",
        data: "{\"count\":2}",
        byteLength: 11,
        observedAt: T0 + 40,
      },
    });
    if (payload?.kind !== "network_stream_message") {
      throw new Error("expected a persisted network stream message");
    }
    expect(payload.record.requestKey).toContain("REQ-SSE");
  });

  it("releases an established EventSource response from Step in-flight tracking", async () => {
    const { controller, sink, starts, finishes } = makeController();
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-SSE-ESTABLISHED",
      timestamp: 55,
      wallTime: T0 / 1_000,
      type: "EventSource",
      request: {
        url: "https://example.com/events",
        method: "GET",
        headers: { accept: "text/event-stream" },
      },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-SSE-ESTABLISHED",
      timestamp: 55.01,
      type: "EventSource",
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        mimeType: "text/event-stream",
      },
      hasExtraInfo: false,
    });

    expect(finishes).toEqual(starts);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: { resourceType: "EventSource", blocksStep: false },
    });
  });

  it("buffers a request start until its durable document scope can be resolved", async () => {
    let scopeAvailable = false;
    const { controller, sink, starts } = makeController(() =>
      Promise.resolve(
        scopeAvailable
          ? {
              stepContext,
              identifierMapping: { state: "unmapped", ext: stepContext.scope },
            }
          : null,
      ),
    );
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-BUFFERED",
      timestamp: 60,
      wallTime: T0 / 1_000,
      type: "Fetch",
      request: {
        url: "https://example.com/early",
        method: "GET",
        headers: {},
      },
    });
    expect(sink.envelopes).toEqual([]);
    expect(starts).toEqual([]);

    scopeAvailable = true;
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-BUFFERED",
      timestamp: 60.01,
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
      },
    });

    expect(starts).toHaveLength(1);
    expect(sink.envelopes.map((envelope) => envelope.payload.kind)).toEqual([
      "request_metadata",
      "request_metadata",
    ]);
    expect(sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: { requestKey: starts[0], statusCode: 200 },
    });
  });

  it("replays missing-clock events in arrival order with their immutable admission", async () => {
    const admission = { context: debuggerContext };
    const { controller, sink, starts, finishes } = makeController(undefined, {
      resolveDebuggerContext: () => null,
      pendingEventDeadlineMs: 1_000,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(
      source,
      "Network.responseReceived",
      {
        requestId: "REQ-MISSING-CLOCK",
        timestamp: 64.01,
        response: { status: 204, headers: {} },
      },
      admission,
    );
    await controller.handleNetworkEvent(
      source,
      "Network.loadingFailed",
      {
        requestId: "REQ-MISSING-CLOCK",
        timestamp: 64.02,
        errorText: "net::ERR_ABORTED",
      },
      admission,
    );

    await controller.handleNetworkEvent(
      source,
      "Network.requestWillBeSent",
      {
        requestId: "REQ-MISSING-CLOCK",
        timestamp: 64,
        wallTime: T0 / 1_000,
        request: { url: "https://example.com/replay", method: "GET", headers: {} },
      },
      admission,
    );

    expect(finishes).toEqual(starts);
    expect(sink.envelopes.map((envelope) => envelope.payload)).toMatchObject([
      { kind: "request_metadata" },
      { kind: "request_metadata", record: { statusCode: 204 } },
      {
        kind: "request_metadata",
        record: { statusCode: 204, failure: { errorText: "net::ERR_ABORTED" } },
      },
    ]);
  });

  it("deduplicates count and byte overflow gaps within one source window", async () => {
    const { controller, sink } = makeController(undefined, {
      pendingEventMaxCount: 1,
      pendingEventMaxBytes: 128,
      pendingEventDeadlineMs: 10_000,
      orphanGapWindowMs: 10_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-COUNT-OVERFLOW",
      statusCode: 200,
      headers: {},
    });
    await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-COUNT-OVERFLOW",
      statusCode: 200,
      headers: {},
    });
    await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-BYTE-OVERFLOW",
      statusCode: 200,
      headers: { "x-large": "x".repeat(512) },
    });

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: { reason: "other_unrecoverable_window", recoverable: false },
    });
  });

  it("bounds missing-clock buffers by count and bytes with one gap per source window", async () => {
    const { controller, sink } = makeController(undefined, {
      pendingEventMaxCount: 1,
      pendingEventMaxBytes: 256,
      pendingEventDeadlineMs: 10_000,
      orphanGapWindowMs: 10_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-MISSING-CLOCK-COUNT",
      timestamp: 70,
      response: { status: 200, headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.loadingFinished", {
      requestId: "REQ-MISSING-CLOCK-COUNT",
      timestamp: 70.01,
      encodedDataLength: 0,
    });
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-MISSING-CLOCK-BYTES",
      timestamp: 71,
      response: { status: 200, headers: { "x-large": "x".repeat(512) } },
    });

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: { reason: "other_unrecoverable_window", recoverable: false },
    });
  });

  it("preserves the combined buffer count and missing-clock path when scope enqueue overflows", async () => {
    const { controller, sink } = makeController(() => Promise.resolve(null), {
      pendingEventMaxCount: 3,
      pendingEventMaxBytes: 64 * 1024,
      pendingEventDeadlineMs: 10_000,
      orphanGapWindowMs: 10_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-COMBINED-BUDGET",
      timestamp: 74.01,
      response: { status: 200, headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-COMBINED-BUDGET",
      timestamp: 74,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/combined", method: "GET", headers: {} },
    });
    await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-COMBINED-BUDGET",
      statusCode: 200,
      headers: {},
    });
    await controller.handleNetworkEvent(source, "Network.loadingFinished", {
      requestId: "REQ-COMBINED-BUDGET",
      timestamp: 74.02,
      encodedDataLength: 0,
    });

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a combined-buffer overflow CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "in-flight request events before Network.requestWillBeSent",
    );
    expect(gaps[0].payload.record.detail).toContain("4 event(s) discarded");
  });

  it("preserves a pre-start missing-clock path when the direct scope enqueue overflows", async () => {
    const { controller, sink } = makeController(() => Promise.resolve(null), {
      pendingEventMaxCount: 1,
      pendingEventMaxBytes: 64 * 1024,
      pendingEventDeadlineMs: 10_000,
      orphanGapWindowMs: 10_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-DIRECT-SCOPE-OVERFLOW",
      timestamp: 74.01,
      response: { status: 200, headers: {} },
    });

    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-DIRECT-SCOPE-OVERFLOW",
      timestamp: 74,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/direct-overflow", method: "GET", headers: {} },
    });

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a direct scope-overflow CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "in-flight request events before Network.requestWillBeSent",
    );
    expect(gaps[0].payload.record.detail).toContain("2 event(s) discarded");
  });

  it("reports a replay tail requeue overflow with the complete discarded count", async () => {
    let resolveReplayScope!: (value: null) => void;
    const replayScope = new Promise<null>((resolve) => {
      resolveReplayScope = resolve;
    });
    let replayScopeEntered!: () => void;
    const replayEntered = new Promise<void>((resolve) => {
      replayScopeEntered = resolve;
    });
    let resolverCalls = 0;
    const { controller, sink } = makeController(() => {
      resolverCalls += 1;
      if (resolverCalls === 2) {
        replayScopeEntered();
        return replayScope;
      }
      return Promise.resolve(null);
    }, {
      pendingEventMaxCount: 2,
      pendingEventMaxBytes: 64 * 1024,
      pendingEventDeadlineMs: 10_000,
      orphanGapWindowMs: 10_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    const requestStart = {
      requestId: "REQ-REPLAY-TAIL-OVERFLOW",
      timestamp: 74,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/replay-tail", method: "GET", headers: {} },
    };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", requestStart);

    const replay = controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
      requestId: "REQ-REPLAY-TAIL-OVERFLOW",
      statusCode: 200,
      headers: {},
    });
    await replayEntered;

    // This independent callback is not owned by the checked-out replay batch.
    // It fills the map-backed queue while the replayed request start is paused.
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", requestStart);
    resolveReplayScope(null);
    await replay;

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a replay-tail overflow CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain("request scope unresolved after");
    expect(gaps[0].payload.record.detail).toContain("3 event(s) discarded");
  });

  it("measures missing-clock byte limits as UTF-8 rather than code units", async () => {
    const { controller, sink } = makeController(undefined, {
      pendingEventMaxCount: 10,
      pendingEventMaxBytes: 200,
      pendingEventDeadlineMs: 10_000,
      orphanGapWindowMs: 10_000,
      now: () => T0,
    });
    await controller.handleNetworkEvent(
      { tabId: debuggerContext.tabId },
      "Network.responseReceived",
      {
        requestId: "REQ-UTF8-BUDGET",
        timestamp: 75,
        response: { status: 200, headers: { "x-multibyte": "你".repeat(60) } },
      },
    );

    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
  });

  it("opens a gap instead of dropping the remaining missing-clock replay after failure", async () => {
    const replayEnvelopes: EventEnvelope[] = [];
    const rejectingIngestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> => {
        replayEnvelopes.push(envelope);
        if (
          envelope.payload.kind === "request_metadata" &&
          envelope.payload.record.completedAt !== undefined
        ) {
          return Promise.resolve({
            status: "rejected",
            eventId: envelope.eventId,
            errorCode: "PERSISTENCE_TRANSACTION_FAILED",
            retryable: true,
          });
        }
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    };
    const { controller } = makeController(undefined, {
      ingestor: rejectingIngestor,
      pendingEventDeadlineMs: 1_000,
      orphanGapWindowMs: 1_000,
      now: () => T0,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-REPLAY-FAILURE",
      timestamp: 76.01,
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
      },
    });
    await controller.handleNetworkEvent(source, "Network.loadingFinished", {
      requestId: "REQ-REPLAY-FAILURE",
      timestamp: 76.02,
      encodedDataLength: 16,
    });
    await controller.handleNetworkEvent(source, "Network.loadingFailed", {
      requestId: "REQ-REPLAY-FAILURE",
      timestamp: 76.03,
      errorText: "net::ERR_ABORTED",
    });

    await expect(
      controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
        requestId: "REQ-REPLAY-FAILURE",
        timestamp: 76,
        wallTime: T0 / 1_000,
        request: { url: "https://example.com/replay-failure", method: "GET", headers: {} },
      }),
    ).resolves.toBeUndefined();
    const gaps = replayEnvelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a missing-clock replay CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "in-flight request events before Network.requestWillBeSent",
    );
    expect(gaps[0].payload.record.detail).toContain("2 event(s) discarded");
  });

  it("enforces a finite missing-clock deadline by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { controller, sink } = makeController();
    await controller.handleNetworkEvent(
      { tabId: debuggerContext.tabId },
      "Network.responseReceived",
      {
        requestId: "REQ-DEFAULT-DEADLINE",
        timestamp: 77,
        response: { status: 200, headers: {} },
      },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
  });

  it("waits for a triggered deadline gap and propagates its rejected ACK during teardown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let resolveGapAck!: (ack: EnvelopeAck) => void;
    const gapAck = new Promise<EnvelopeAck>((resolve) => {
      resolveGapAck = resolve;
    });
    const delayedIngestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> =>
        envelope.payload.kind === "capture_gap_open"
          ? gapAck
          : Promise.resolve({
              status: "committed",
              eventId: envelope.eventId,
              committedBytes: 1,
            }),
    };
    const { controller } = makeController(undefined, {
      ingestor: delayedIngestor,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    await controller.handleNetworkEvent(
      { tabId: debuggerContext.tabId },
      "Network.responseReceived",
      {
        requestId: "REQ-DEADLINE-TEARDOWN",
        timestamp: 78,
        response: { status: 200, headers: {} },
      },
    );
    await vi.advanceTimersByTimeAsync(50);

    const forgetPromise = Promise.resolve(controller.forgetSession(debuggerContext.sessionId));
    let settled = false;
    void forgetPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    const settledBeforeAck = settled;
    resolveGapAck({
      status: "rejected",
      eventId: eventIdSchema.parse("evt-deadline-gap-rejected"),
      errorCode: "SESSION_NOT_ACCEPTING_FACTS",
      retryable: false,
    });

    expect(settledBeforeAck).toBe(false);
    await expect(forgetPromise).rejects.toThrow("network CaptureGap persistence rejected");
  });

  it("expires a missing-clock buffer into one gap and cleanup cancels pending timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { controller, sink } = makeController(undefined, {
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-DEADLINE",
      timestamp: 72,
      response: { status: 200, headers: {} },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);

    await controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-CLEANUP",
      timestamp: 73,
      response: { status: 200, headers: {} },
    });
    await controller.forgetSession(debuggerContext.sessionId);
    expect(vi.getTimerCount()).toBe(0);
    const gapCount = sink.envelopes.length;
    await vi.advanceTimersByTimeAsync(50);
    expect(sink.envelopes).toHaveLength(gapCount);
  });

  it("details a missing-clock deadline gap as in-flight before attach", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { controller, sink } = makeController(undefined, {
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    await controller.handleNetworkEvent(
      { tabId: debuggerContext.tabId },
      "Network.responseReceived",
      {
        requestId: "REQ-DEADLINE-MISSING-CLOCK",
        timestamp: 72,
        response: { status: 200, headers: {} },
      },
    );
    await vi.advanceTimersByTimeAsync(50);
    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: { reason: "other_unrecoverable_window", recoverable: false },
    });
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a missing-clock CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "in-flight request events before Network.requestWillBeSent",
    );
    expect(gaps[0].payload.record.detail).toContain("1 event(s) discarded");
  });

  it("details a scope-pending deadline gap as unresolved request scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { controller, sink } = makeController(() => Promise.resolve(null), {
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    await controller.handleNetworkEvent(
      { tabId: debuggerContext.tabId },
      "Network.requestWillBeSent",
      {
        requestId: "REQ-DEADLINE-SCOPE",
        timestamp: 73,
        wallTime: T0 / 1_000,
        request: { url: "https://example.com/scope", method: "GET", headers: {} },
      },
    );
    await vi.advanceTimersByTimeAsync(50);
    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a scope-pending CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain("request scope unresolved after");
    expect(gaps[0].payload.record.detail).toContain("1 event(s) discarded");
  });

  it("discards a failed child session's buffers and opens one precise gap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-b2"),
    };
    const { controller, sink } = makeController(undefined, {
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    const childSource: DebuggerCommandTarget = {
      tabId: debuggerContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    await controller.handleNetworkEvent(childSource, "Network.responseReceived", {
      requestId: "REQ-CHILD-B2-A",
      timestamp: 80,
      response: { status: 200, headers: {} },
    });
    await controller.handleNetworkEvent(childSource, "Network.responseReceived", {
      requestId: "REQ-CHILD-B2-B",
      timestamp: 80.1,
      response: { status: 200, headers: {} },
    });

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a child-enable CaptureGap");
    }
    expect(gaps[0].payload.record).toMatchObject({
      reason: "other_unrecoverable_window",
      recoverable: false,
      scope: { collector: "debugger_network" },
    });
    expect(gaps[0].payload.record.detail).toContain("child target network enable failed");
    expect(gaps[0].payload.record.detail).toContain(
      "2 in-flight request event(s) at attach discarded",
    );

    // Deadline timers were cleared: advancing time produces no second gap.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);

    // Late events for a discarded chain are dropped, not re-buffered.
    await controller.handleNetworkEvent(childSource, "Network.loadingFinished", {
      requestId: "REQ-CHILD-B2-A",
      timestamp: 80.2,
      encodedDataLength: 10,
    });
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
  });

  it("counts and drops a child request still resolving when network enable fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-resolving"),
    };
    let resolvePendingContext: ((value: null) => void) | undefined;
    const pendingContext = new Promise<null>((resolve) => {
      resolvePendingContext = resolve;
    });
    const { controller, sink } = makeController(() => pendingContext, {
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    const childSource: DebuggerCommandTarget = {
      tabId: childContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    const request = controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", {
      requestId: "REQ-CHILD-RESOLVING",
      timestamp: 80,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/resolving", method: "GET", headers: {} },
    });

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    const gapsBeforeResolution = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gapsBeforeResolution).toHaveLength(1);

    resolvePendingContext?.(null);
    await request;
    await Promise.resolve();

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a resolving child-enable CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain("child target network enable failed");
    expect(gaps[0].payload.record.detail).toContain(
      "1 in-flight request event(s) at attach discarded",
    );
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await controller.handleNetworkEvent(childSource, "Network.loadingFinished", {
      requestId: "REQ-CHILD-RESOLVING",
      timestamp: 80.1,
      encodedDataLength: 10,
    });
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not double-count a scope-overflow start when its B1 gap ACK races child failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-overflow-gap-pending"),
    };
    const childSource: DebuggerCommandTarget = {
      tabId: childContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    let releaseFirstGapAck!: (ack: EnvelopeAck) => void;
    const firstGapAck = new Promise<EnvelopeAck>((resolve) => {
      releaseFirstGapAck = resolve;
    });
    let firstGapEntered!: () => void;
    const firstGapStarted = new Promise<void>((resolve) => {
      firstGapEntered = resolve;
    });
    const envelopes: EventEnvelope[] = [];
    let gapCount = 0;
    const ingestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> => {
        envelopes.push(envelope);
        if (envelope.payload.kind === "capture_gap_open" && gapCount++ === 0) {
          firstGapEntered();
          return firstGapAck;
        }
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    };
    const { controller } = makeController(() => Promise.resolve(null), {
      ingestor,
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      pendingEventMaxCount: 1,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 0,
    });
    await controller.handleNetworkEvent(childSource, "Network.responseReceived", {
      requestId: "REQ-CHILD-OVERFLOW-GAP-PENDING",
      timestamp: 80.01,
      response: { status: 200, headers: {} },
    });

    const request = controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", {
      requestId: "REQ-CHILD-OVERFLOW-GAP-PENDING",
      timestamp: 80,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/overflow-gap", method: "GET", headers: {} },
    });
    await firstGapStarted;

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    expect(
      envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);

    releaseFirstGapAck({
      status: "committed",
      eventId: eventIdSchema.parse("evt-child-overflow-gap-held"),
      committedBytes: 1,
    });
    await request;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
  });

  it("counts and stops a child request awaiting durable Step assignment when enable fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-start-pending"),
    };
    const childSource: DebuggerCommandTarget = {
      tabId: childContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    let releaseStart!: (value: { startedInStepId: StepId }) => void;
    const startPending = new Promise<{ startedInStepId: StepId }>(
      (resolve) => {
        releaseStart = resolve;
      },
    );
    let startEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const finishCalls: string[] = [];
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: () => {
        startEntered();
        return startPending;
      },
      recordNetworkRequestFinished: (_sessionId, requestKey) => {
        finishCalls.push(requestKey);
        return Promise.resolve(null);
      },
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-child-start-message") }),
    };
    const { controller, sink } = makeController(undefined, {
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      processorForSession: () => processor,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });

    const request = controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", {
      requestId: "REQ-CHILD-START-PENDING",
      timestamp: 81,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/start-pending", method: "GET", headers: {} },
    });
    await entered;

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    releaseStart({ startedInStepId: stepIdSchema.parse("stp-child-start-pending") });
    await request;

    const gaps = sink.envelopes.filter(
      (envelope) => envelope.payload.kind === "capture_gap_open",
    );
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a pending request-start CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "1 in-flight request event(s) at attach discarded",
    );
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "request_metadata"),
    ).toHaveLength(0);
    expect(finishCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
  });

  it("attempts both redirect-hop releases when the first compensation rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-redirect-pending"),
    };
    const childSource: DebuggerCommandTarget = {
      tabId: childContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    let releaseRedirectAck!: (ack: EnvelopeAck) => void;
    const redirectAck = new Promise<EnvelopeAck>((resolve) => {
      releaseRedirectAck = resolve;
    });
    let redirectEntered!: () => void;
    const redirectMetadataStarted = new Promise<void>((resolve) => {
      redirectEntered = resolve;
    });
    const envelopes: EventEnvelope[] = [];
    const ingestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> => {
        envelopes.push(envelope);
        if (
          envelope.payload.kind === "request_metadata" &&
          envelope.payload.record.statusCode === 302 &&
          envelope.payload.record.keyParts.redirectHop === 0
        ) {
          redirectEntered();
          return redirectAck;
        }
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    };
    const finishCalls: string[] = [];
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: (_context, requestKey) =>
        Promise.resolve({
          startedInStepId: stepIdSchema.parse(
            requestKey.includes(":1") ? "stp-child-redirect-new" : "stp-child-redirect-old",
          ),
        }),
      recordNetworkRequestFinished: (_sessionId, requestKey) => {
        finishCalls.push(requestKey);
        return finishCalls.length === 1
          ? Promise.reject(new Error("old redirect hop release failed"))
          : Promise.resolve(null);
      },
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-child-redirect-message") }),
    };
    const { controller } = makeController(undefined, {
      ingestor,
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      processorForSession: () => processor,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    const initial = {
      requestId: "REQ-CHILD-REDIRECT-PENDING",
      timestamp: 81,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/old", method: "GET", headers: {} },
    };
    await controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", initial);

    const redirect = controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", {
      ...initial,
      timestamp: 81.1,
      request: { url: "https://example.com/new", method: "GET", headers: {} },
      redirectResponse: {
        status: 302,
        headers: { location: "https://example.com/new" },
        mimeType: "text/html",
      },
    });
    await redirectMetadataStarted;

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    releaseRedirectAck({
      status: "committed",
      eventId: eventIdSchema.parse("evt-child-redirect-held"),
      committedBytes: 1,
    });
    await expect(redirect).rejects.toThrow("old redirect hop release failed");

    expect(
      envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
    expect(finishCalls).toHaveLength(2);
    expect(new Set(finishCalls).size).toBe(2);
    expect(
      envelopes.filter(
        (envelope) =>
          envelope.payload.kind === "request_metadata" &&
          envelope.payload.record.keyParts.redirectHop === 1,
      ),
    ).toHaveLength(0);
  });

  it("compensates a child request whose initial metadata ACK races enable failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-metadata-pending"),
    };
    const childSource: DebuggerCommandTarget = {
      tabId: childContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    let releaseMetadataAck!: (ack: EnvelopeAck) => void;
    const metadataAck = new Promise<EnvelopeAck>((resolve) => {
      releaseMetadataAck = resolve;
    });
    let metadataEntered!: () => void;
    const metadataIngestStarted = new Promise<void>((resolve) => {
      metadataEntered = resolve;
    });
    const envelopes: EventEnvelope[] = [];
    const ingestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> => {
        envelopes.push(envelope);
        if (envelope.payload.kind === "request_metadata") {
          metadataEntered();
          return metadataAck;
        }
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    };
    const finishCalls: string[] = [];
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: () =>
        Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-child-metadata-pending") }),
      recordNetworkRequestFinished: (_sessionId, requestKey) => {
        finishCalls.push(requestKey);
        return Promise.resolve(null);
      },
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-child-metadata-message") }),
    };
    const { controller } = makeController(undefined, {
      ingestor,
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      processorForSession: () => processor,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });

    const request = controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", {
      requestId: "REQ-CHILD-METADATA-PENDING",
      timestamp: 81.5,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/metadata-pending", method: "GET", headers: {} },
    });
    await metadataIngestStarted;

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    const envelopeCountAtFailure = envelopes.length;
    releaseMetadataAck({
      status: "committed",
      eventId: eventIdSchema.parse("evt-child-metadata-held"),
      committedBytes: 1,
    });
    await request;

    const gaps = envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open");
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected an initial-metadata race CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "1 in-flight request event(s) at attach discarded",
    );
    expect(finishCalls).toHaveLength(1);
    expect(envelopes).toHaveLength(envelopeCountAtFailure);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(envelopes).toHaveLength(envelopeCountAtFailure);
  });

  it("counts a checked-out replay and an independent direct request when enable fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const childContext: DebuggerCaptureContext = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      attachEpoch: debuggerContext.attachEpoch,
      childSessionId: cdpSessionIdSchema.parse("cdp-child-replay-pending"),
    };
    const childSource: DebuggerCommandTarget = {
      tabId: childContext.tabId,
      ...(childContext.childSessionId === undefined
        ? {}
        : { sessionId: childContext.childSessionId }),
    };
    let releaseReplayAck!: (ack: EnvelopeAck) => void;
    const replayAck = new Promise<EnvelopeAck>((resolve) => {
      releaseReplayAck = resolve;
    });
    let replayEntered!: () => void;
    const replayIngestStarted = new Promise<void>((resolve) => {
      replayEntered = resolve;
    });
    let releaseIndependentScope!: (value: null) => void;
    const independentScope = new Promise<null>((resolve) => {
      releaseIndependentScope = resolve;
    });
    let independentEntered!: () => void;
    const independentScopeStarted = new Promise<void>((resolve) => {
      independentEntered = resolve;
    });
    const envelopes: EventEnvelope[] = [];
    const ingestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> => {
        envelopes.push(envelope);
        if (
          envelope.payload.kind === "request_metadata" &&
          envelope.payload.record.statusCode !== undefined &&
          envelope.payload.record.completedAt === undefined
        ) {
          replayEntered();
          return replayAck;
        }
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    };
    const { controller } = makeController((_context, input) => {
      if (input.url.endsWith("/independent")) {
        independentEntered();
        return independentScope;
      }
      return Promise.resolve({
        stepContext,
        identifierMapping: { state: "unmapped", ext: stepContext.scope },
      });
    }, {
      ingestor,
      resolveDebuggerContext: (source: DebuggerCommandTarget) =>
        source.sessionId === childContext.childSessionId ? childContext : debuggerContext,
      pendingEventDeadlineMs: 50,
      orphanGapWindowMs: 1_000,
    });
    await controller.handleNetworkEvent(childSource, "Network.responseReceived", {
      requestId: "REQ-CHILD-REPLAY-PENDING",
      timestamp: 82.01,
      response: { status: 200, headers: {} },
    });
    await controller.handleNetworkEvent(childSource, "Network.loadingFailed", {
      requestId: "REQ-CHILD-REPLAY-PENDING",
      timestamp: 82.02,
      errorText: "net::ERR_ABORTED",
    });

    const request = controller.handleNetworkEvent(childSource, "Network.requestWillBeSent", {
      requestId: "REQ-CHILD-REPLAY-PENDING",
      timestamp: 82,
      wallTime: T0 / 1_000,
      request: { url: "https://example.com/replay-pending", method: "GET", headers: {} },
    });
    await replayIngestStarted;
    const independentRequest = controller.handleNetworkEvent(
      childSource,
      "Network.requestWillBeSent",
      {
        requestId: "REQ-CHILD-INDEPENDENT-PENDING",
        timestamp: 82.5,
        wallTime: T0 / 1_000,
        request: { url: "https://example.com/independent", method: "GET", headers: {} },
      },
    );
    await independentScopeStarted;

    controller.discardSourceBuffers(
      childContext,
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    const envelopeCountAtFailure = envelopes.length;
    releaseReplayAck({
      status: "committed",
      eventId: eventIdSchema.parse("evt-child-replay-held"),
      committedBytes: 1,
    });
    releaseIndependentScope(null);
    await Promise.all([request, independentRequest]);

    const gaps = envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open");
    expect(gaps).toHaveLength(1);
    if (gaps[0]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected a checked-out replay CaptureGap");
    }
    expect(gaps[0].payload.record.detail).toContain(
      "3 in-flight request event(s) at attach discarded",
    );
    expect(envelopes).toHaveLength(envelopeCountAtFailure);
    expect(
      envelopes.some(
        (envelope) =>
          envelope.payload.kind === "request_metadata" &&
          envelope.payload.record.failure !== undefined,
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(1);
  });

  it("does not open an extra gap when a failed child enable had no buffered events", async () => {
    const { controller, sink } = makeController();
    controller.discardSourceBuffers(
      {
        sessionId: debuggerContext.sessionId,
        tabId: debuggerContext.tabId,
        attachEpoch: debuggerContext.attachEpoch,
        childSessionId: cdpSessionIdSchema.parse("cdp-child-empty"),
      },
      "Error: Session with given id not found.",
    );
    await Promise.resolve();
    expect(
      sink.envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open"),
    ).toHaveLength(0);
  });

  it("converts a durable-scope buffer overflow into one explicit CaptureGap", async () => {
    const { controller, sink, starts } = makeController(() => Promise.resolve(null));
    const source = { tabId: debuggerContext.tabId };
    await controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-BUFFER-OVERFLOW",
      timestamp: 65,
      wallTime: T0 / 1_000,
      type: "Fetch",
      request: {
        url: "https://example.com/never-mapped",
        method: "GET",
        headers: {},
      },
    });

    await expect(
      (async () => {
        for (let index = 0; index < 256; index += 1) {
          await controller.handleNetworkEvent(source, "Network.responseReceivedExtraInfo", {
            requestId: "REQ-BUFFER-OVERFLOW",
            statusCode: 200,
            headers: { "x-seq": index },
          });
        }
      })(),
    ).resolves.toBeUndefined();

    expect(starts).toEqual([]);
    expect(sink.envelopes).toHaveLength(1);
    const payload = sink.envelopes[0]?.payload;
    expect(payload).toMatchObject({
      kind: "capture_gap_open",
      record: {
        reason: "other_unrecoverable_window",
        recoverable: false,
        affectedCapabilities: ["network_metadata", "network_bodies"],
      },
    });
    if (payload?.kind !== "capture_gap_open") {
      throw new Error("expected a buffer-overflow CaptureGap");
    }
    expect(payload.record.detail).toContain("REQ-BUFFER-OVERFLOW");
  });

  it("restores an in-flight request after worker restart without reallocating its Step", async () => {
    const beforeRestart = makeController();
    const source = { tabId: debuggerContext.tabId };
    await beforeRestart.controller.handleNetworkEvent(source, "Network.requestWillBeSent", {
      requestId: "REQ-WORKER-RESTART",
      timestamp: 70,
      wallTime: T0 / 1_000,
      type: "Fetch",
      request: {
        url: "https://example.com/slow-restart",
        method: "GET",
        headers: {},
      },
    });
    const initialPayload = beforeRestart.sink.envelopes.at(-1)?.payload;
    if (initialPayload?.kind !== "request_metadata") {
      throw new Error("expected persisted request metadata before restart");
    }

    const afterRestart = makeController();
    afterRestart.controller.restoreInFlightRequests(debuggerContext, [initialPayload.record]);

    await afterRestart.controller.handleNetworkEvent(source, "Network.responseReceived", {
      requestId: "REQ-WORKER-RESTART",
      timestamp: 70.01,
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
      },
    });
    await afterRestart.controller.handleNetworkEvent(source, "Network.loadingFinished", {
      requestId: "REQ-WORKER-RESTART",
      timestamp: 70.02,
      encodedDataLength: 11,
    });

    expect(afterRestart.starts).toEqual([]);
    expect(afterRestart.finishes).toEqual([initialPayload.record.requestKey]);
    expect(afterRestart.sink.envelopes.at(-1)?.payload).toMatchObject({
      kind: "request_metadata",
      record: {
        requestKey: initialPayload.record.requestKey,
        startedInStepId: "stp-controller",
        completedAt: T0 + 20,
      },
    });
  });
});
