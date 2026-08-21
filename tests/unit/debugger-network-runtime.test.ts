import { describe, expect, it, vi } from "vitest";
import {
  DebuggerNetworkRuntime,
  type ChromeDebuggerRuntimeApi,
} from "../../src/background/debugger-network-runtime";
import type { DebuggerCommandTarget } from "../../src/background/debugger-session-manager";
import type { NetworkStepProcessor } from "../../src/background/network-capture-controller";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import type { EnvelopeAck, EventEnvelope } from "../../src/schemas/event-envelope";
import { buildRequestKey, requestRecordSchema } from "../../src/schemas/network";
import {
  sessionControlRecordSchema,
  sessionRecordSchema,
  type SessionRecord,
} from "../../src/schemas/session";
import {
  attachEpochSchema,
  cdpRequestIdSchema,
  cdpSessionIdSchema,
  captureEpochIdSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  gapIdSchema,
  sessionIdSchema,
  stepIdSchema,
  type EventId,
} from "../../src/shared/ids";

const T0 = 1_700_000_000_000;

const controlFor = (session: SessionRecord) => {
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("session has no capture epoch");
  }
  return sessionControlRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.sessionId,
    captureEpochId,
    lifecycle: session.lifecycle,
    cleanStop: false,
    lastCommittedSeqBySource: {},
    openStepIds: [],
    counters: { totalLogicalBytes: 0, responseBodyLogicalBytes: 0, factCount: 0 },
  });
};

class ListenerSet<Listener extends (...args: never[]) => void> {
  readonly listeners = new Set<Listener>();
  addListener = (listener: Listener): void => {
    this.listeners.add(listener);
  };
  removeListener = (listener: Listener): void => {
    this.listeners.delete(listener);
  };
}

class FakeChromeDebuggerApi implements ChromeDebuggerRuntimeApi {
  readonly onEvent = new ListenerSet<(source: unknown, method: string, params?: unknown) => void>();
  readonly onDetach = new ListenerSet<(source: unknown, reason: string) => void>();
  readonly commands: Array<{ target: DebuggerCommandTarget; method: string }> = [];

  attach(): Promise<void> {
    return Promise.resolve();
  }
  detach(): Promise<void> {
    return Promise.resolve();
  }
  sendCommand(
    target: DebuggerCommandTarget,
    method: string,
  ): Promise<unknown> {
    this.commands.push({ target, method });
    return Promise.resolve({});
  }
}

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

const runtimeSession = (suffix: string): SessionRecord =>
  sessionRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionIdSchema.parse(`ses-runtime-${suffix}`),
    lifecycle: "recording",
    captureQuality: "complete",
    startMode: "no_reload",
    originUrl: "https://example.com/",
    rootTabId: extTabIdSchema.parse(9),
    startedAt: T0,
    config: {
      responseBodySoftBudgetBytes: 100 * 1024 * 1024,
      responseBodyMaxBytes: 2 * 1024 * 1024,
      hoverDwellThresholdMs: 500,
      networkQuietWindowMs: 800,
      stepMaxWindowMs: 10_000,
      userFilterRules: [],
      extraCookieDomains: [],
    },
    captureEpochIds: [captureEpochIdSchema.parse(`cep-runtime-${suffix}`)],
  });

const createRuntimeHarness = (suffix: string, processor: NetworkStepProcessor) => {
  const api = new FakeChromeDebuggerApi();
  const session = runtimeSession(suffix);
  const control = controlFor(session);
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("runtime fixture has no capture epoch");
  }
  const envelopes: EventEnvelope[] = [];
  const lifecycleCleanupEnvelopes: EventEnvelope[] = [];
  let eventNo = 0;
  const runtime = new DebuggerNetworkRuntime({
    debuggerApi: api,
    ingestor: {
      ingest: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    },
    ingestLifecycleCleanup: (envelope) => {
      lifecycleCleanupEnvelopes.push(envelope);
      envelopes.push(envelope);
      return Promise.resolve({
        status: "committed",
        eventId: envelope.eventId,
        committedBytes: 1,
      });
    },
    networkState: {
      nextAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(0)),
      getIdentifierMapping: () => Promise.resolve(null),
      listInFlightRequestRecordsBySession: () => Promise.resolve([]),
    },
    navigationContexts: {
      getCurrentDocument: (_sessionId, tabId, frameId) =>
        Promise.resolve({
          schemaVersion: SCHEMA_VERSION,
          documentKey: `doc-key-${suffix}-${String(tabId)}-${String(frameId)}`,
          sessionId: session.sessionId,
          captureEpochId,
          tabId,
          frameId,
          documentId: extDocumentIdSchema.parse(`doc-${suffix}-${String(tabId)}-${String(frameId)}`),
          url: session.originUrl,
          committedAt: T0,
        }),
    },
    sessions: {
      getSession: () => Promise.resolve(session),
      getControl: () => Promise.resolve(control),
    },
    processorForSession: () => processor,
    newEventId: () => eventIdSchema.parse(`evt-${suffix}-${String(eventNo++)}`),
    now: () => T0,
  });
  runtime.install();
  return { api, control, envelopes, lifecycleCleanupEnvelopes, runtime, session };
};

const emitDebuggerEvent = (
  api: FakeChromeDebuggerApi,
  source: unknown,
  method: string,
  params: unknown,
): void => {
  for (const listener of api.onEvent.listeners) {
    listener(source, method, params);
  }
};

const requestWillBeSent = (requestId: string, url: string, timestamp = 10) => ({
  requestId,
  timestamp,
  wallTime: T0 / 1_000,
  type: "Fetch",
  request: { url, method: "GET", headers: {} },
});

describe("DebuggerNetworkRuntime", () => {
  it("uses a durable pause gap to explain orphan tails without hiding later unexplained loss", async () => {
    const blockedStart = deferred();
    const releaseBlockedStart = deferred();
    let blockNextStart = false;
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: async () => {
        if (blockNextStart) {
          blockNextStart = false;
          blockedStart.resolve();
          await releaseBlockedStart.promise;
        }
        return { startedInStepId: stepIdSchema.parse("stp-runtime-orphan-pause") };
      },
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({
          observedDuringStepId: stepIdSchema.parse("stp-runtime-orphan-pause"),
        }),
    };
    const { api, control, envelopes, runtime, session } = createRuntimeHarness(
      "orphan-pause",
      processor,
    );
    await runtime.start({ session });
    emitDebuggerEvent(
      api,
      { tabId: 9 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-PAUSE-SEED", "https://example.com/pause-seed"),
    );
    await vi.waitFor(() => {
      expect(envelopes.some((envelope) => envelope.payload.kind === "request_metadata")).toBe(true);
    });

    blockNextStart = true;
    emitDebuggerEvent(
      api,
      { tabId: 9 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-PAUSE-BLOCK", "https://example.com/pause-block", 11),
    );
    await blockedStart.promise;
    control.lifecycle = "paused_storage_pressure";
    control.pause = {
      reason: "headroom_exhausted",
      pausedAt: T0,
      gapId: gapIdSchema.parse("gap_runtime_pause"),
    };
    emitDebuggerEvent(api, { tabId: 9 }, "Network.responseReceived", {
      requestId: "REQ-PAUSE-ORPHAN",
      timestamp: 11.01,
      response: { status: 200, headers: {} },
    });
    const pausedDisconnect = runtime.disconnect(session.sessionId);
    await Promise.resolve();
    releaseBlockedStart.resolve();
    await pausedDisconnect;

    expect(
      envelopes.filter(
        (envelope) =>
          envelope.payload.kind === "capture_gap_open" &&
          envelope.payload.record.reason === "other_unrecoverable_window",
      ),
    ).toEqual([]);

    control.lifecycle = "recording";
    delete control.pause;
    envelopes.length = 0;
    await runtime.start({ session });
    emitDebuggerEvent(
      api,
      { tabId: 9 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-ACTIVE-SEED", "https://example.com/active-seed", 20),
    );
    await vi.waitFor(() => {
      expect(envelopes.some((envelope) => envelope.payload.kind === "request_metadata")).toBe(true);
    });
    envelopes.length = 0;
    for (const requestId of ["REQ-ACTIVE-ORPHAN-A", "REQ-ACTIVE-ORPHAN-B"]) {
      emitDebuggerEvent(api, { tabId: 9 }, "Network.responseReceived", {
        requestId,
        timestamp: 20.01,
        response: { status: 200, headers: {} },
      });
    }
    await vi.waitFor(() => {
      expect(
        envelopes.filter(
          (envelope) =>
            envelope.payload.kind === "capture_gap_open" &&
            envelope.payload.record.reason === "other_unrecoverable_window",
        ),
      ).toHaveLength(1);
    });
    runtime.dispose();
  });

  it("routes Chrome debugger events into request and CaptureGap envelopes", async () => {
    const routingErrors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      routingErrors.push(args);
    });
    const api = new FakeChromeDebuggerApi();
    const envelopes: EventEnvelope[] = [];
    const ingestor = {
      ingest: (envelope: EventEnvelope): Promise<EnvelopeAck> => {
        envelopes.push(envelope);
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
    };
    const session = sessionRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sessionId: sessionIdSchema.parse("ses-runtime-network"),
      lifecycle: "recording",
      captureQuality: "complete",
      startMode: "no_reload",
      originUrl: "https://example.com/",
      rootTabId: extTabIdSchema.parse(9),
      startedAt: T0,
      config: {
        responseBodySoftBudgetBytes: 100 * 1024 * 1024,
        responseBodyMaxBytes: 2 * 1024 * 1024,
        hoverDwellThresholdMs: 500,
        networkQuietWindowMs: 800,
        stepMaxWindowMs: 10_000,
        userFilterRules: [],
        extraCookieDomains: [],
      },
      captureEpochIds: [captureEpochIdSchema.parse("cep-runtime-network")],
    });
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: () =>
        Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-runtime-network") }),
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({
          observedDuringStepId: stepIdSchema.parse("stp-runtime-network"),
        }),
    };
    let eventNo = 0;
    const newEventId = (): EventId => eventIdSchema.parse(`evt-runtime-${String(eventNo++)}`);
    const runtime = new DebuggerNetworkRuntime({
      debuggerApi: api,
      ingestor,
      ingestLifecycleCleanup: (envelope) => ingestor.ingest(envelope),
      networkState: {
        nextAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(0)),
        getIdentifierMapping: () => Promise.resolve(null),
        listInFlightRequestRecordsBySession: () => Promise.resolve([]),
      },
      navigationContexts: {
        getCurrentDocument: () =>
          Promise.resolve({
            schemaVersion: SCHEMA_VERSION,
            documentKey: "doc-key-runtime",
            sessionId: session.sessionId,
            captureEpochId: captureEpochIdSchema.parse("cep-runtime-network"),
            tabId: session.rootTabId,
            frameId: extFrameIdSchema.parse(0),
            documentId: extDocumentIdSchema.parse("doc-runtime-network"),
            url: session.originUrl,
            committedAt: T0,
          }),
      },
      sessions: {
        getSession: () => Promise.resolve(session),
        getControl: () => Promise.resolve(controlFor(session)),
      },
      processorForSession: () => processor,
      newEventId,
      now: () => T0,
    });

    runtime.install();
    runtime.install();
    expect(api.onEvent.listeners.size).toBe(1);
    expect(api.onDetach.listeners.size).toBe(1);
    const startResult = await runtime.start({ session });
    expect(api.commands.length).toBeGreaterThan(0);
    expect({ startResult, commands: api.commands }).toMatchObject({
      startResult: { ok: true },
    });

    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Network.requestWillBeSent", {
        requestId: "REQ-RUNTIME",
        timestamp: 10,
        wallTime: T0 / 1_000,
        type: "Fetch",
        request: {
          url: "https://example.com/api",
          method: "GET",
          headers: {},
        },
      });
    }
    await vi.waitFor(() => {
      expect(envelopes.length + routingErrors.length).toBeGreaterThan(0);
    });
    expect(routingErrors).toEqual([]);
    expect(envelopes.some((envelope) => envelope.payload.kind === "request_metadata")).toBe(true);

    for (const listener of api.onDetach.listeners) {
      listener({ tabId: 9 }, "canceled_by_user");
    }
    await vi.waitFor(() => {
      expect(envelopes.at(-1)?.payload).toMatchObject({
        kind: "capture_gap_open",
        record: {
          reason: "debugger_detached",
          affectedCapabilities: ["network_metadata", "network_bodies"],
        },
      });
    });

    runtime.dispose();
    consoleError.mockRestore();
    expect(api.onEvent.listeners.size).toBe(0);
    expect(api.onDetach.listeners.size).toBe(0);
  });

  it("restores child-session in-flight records when Target.attachedToTarget is enabled", async () => {
    const api = new FakeChromeDebuggerApi();
    const envelopes: EventEnvelope[] = [];
    const session = sessionRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sessionId: sessionIdSchema.parse("ses-runtime-child"),
      lifecycle: "recording",
      captureQuality: "complete",
      startMode: "no_reload",
      originUrl: "https://example.com/",
      rootTabId: extTabIdSchema.parse(9),
      startedAt: T0,
      config: {
        responseBodySoftBudgetBytes: 100 * 1024 * 1024,
        responseBodyMaxBytes: 2 * 1024 * 1024,
        hoverDwellThresholdMs: 500,
        networkQuietWindowMs: 800,
        stepMaxWindowMs: 10_000,
        userFilterRules: [],
        extraCookieDomains: [],
      },
      captureEpochIds: [captureEpochIdSchema.parse("cep-runtime-child")],
    });
    const childSessionId = cdpSessionIdSchema.parse("child-oopif-restored");
    const requestId = cdpRequestIdSchema.parse("REQ-CHILD-RESTORED");
    const keyParts = {
      tabId: session.rootTabId,
      childSessionId,
      attachEpoch: attachEpochSchema.parse(0),
      requestId,
      redirectHop: 0,
    };
    const restored = requestRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      requestKey: buildRequestKey(keyParts),
      keyParts,
      sessionId: session.sessionId,
      captureEpochId: captureEpochIdSchema.parse("cep-runtime-child"),
      scope: {
        tabId: session.rootTabId,
        frameId: extFrameIdSchema.parse(0),
        documentId: extDocumentIdSchema.parse("doc-runtime-child"),
      },
      startedInStepId: stepIdSchema.parse("stp-runtime-child"),
      blocksStep: true,
      identifierMapping: { state: "ambiguous" },
      method: "GET",
      url: "https://example.com/oopif-api",
      queryParams: [],
      requestHeaders: [],
      requestExtraInfoState: "unknown",
      responseExtraInfoState: "unknown",
      requestBody: { kind: "none" },
      preflight: { state: "none" },
      startedAt: T0,
      cdpClockOffsetMs: T0 - 10_000,
    });
    let starts = 0;
    let listCalls = 0;
    const runtime = new DebuggerNetworkRuntime({
      debuggerApi: api,
      ingestor: {
        ingest: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({
            status: "committed",
            eventId: envelope.eventId,
            committedBytes: 1,
          });
        },
      },
      ingestLifecycleCleanup: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
      networkState: {
        nextAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(0)),
        getIdentifierMapping: () => Promise.resolve(null),
        listInFlightRequestRecordsBySession: () => {
          listCalls += 1;
          return Promise.resolve([restored]);
        },
      },
      navigationContexts: { getCurrentDocument: () => Promise.resolve(null) },
      sessions: {
        getSession: () => Promise.resolve(session),
        getControl: () => Promise.resolve(controlFor(session)),
      },
      processorForSession: () => ({
        recordNetworkRequestStarted: () => {
          starts += 1;
          return Promise.resolve({ startedInStepId: restored.startedInStepId });
        },
        recordNetworkRequestFinished: () =>
          Promise.resolve({ startedInStepId: restored.startedInStepId }),
        recordNetworkMessageObserved: () =>
          Promise.resolve({ observedDuringStepId: restored.startedInStepId }),
      }),
      newEventId: (() => {
        let eventNo = 0;
        return () => eventIdSchema.parse(`evt-runtime-child-${String(eventNo++)}`);
      })(),
      now: () => T0,
    });
    runtime.install();
    await runtime.start({ session });

    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Target.attachedToTarget", {
        sessionId: childSessionId,
        targetInfo: { targetId: "target-oopif-restored", type: "iframe" },
      });
    }
    await vi.waitFor(() => {
      expect(listCalls).toBeGreaterThan(1);
    });
    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9, sessionId: childSessionId }, "Network.responseReceived", {
        requestId,
        timestamp: 10.01,
        response: { status: 200, headers: {}, mimeType: "application/json" },
        hasExtraInfo: false,
      });
    }
    await vi.waitFor(() => {
      expect(envelopes.at(-1)?.payload).toMatchObject({
        kind: "request_metadata",
        record: { requestKey: restored.requestKey, statusCode: 200 },
      });
    });

    expect(starts).toBe(0);
    runtime.dispose();
  });

  it("discards a failed child session's buffered events via the enable-failure hook", async () => {
    const childSessionId = cdpSessionIdSchema.parse("child-oopif-b2");
    const api = new FakeChromeDebuggerApi();
    let rejectEnable!: (cause: Error) => void;
    const enablePromise = new Promise<unknown>((_resolve, reject) => {
      rejectEnable = reject;
    });
    api.sendCommand = (target, method) => {
      api.commands.push({ target, method });
      if (method === "Network.enable" && target.sessionId === childSessionId) {
        return enablePromise;
      }
      return Promise.resolve({});
    };
    const envelopes: EventEnvelope[] = [];
    const session = runtimeSession("child-b2");
    const runtime = new DebuggerNetworkRuntime({
      debuggerApi: api,
      ingestor: {
        ingest: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({
            status: "committed",
            eventId: envelope.eventId,
            committedBytes: 1,
          });
        },
      },
      ingestLifecycleCleanup: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
      networkState: {
        nextAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(0)),
        getIdentifierMapping: () => Promise.resolve(null),
        listInFlightRequestRecordsBySession: () => Promise.resolve([]),
      },
      navigationContexts: { getCurrentDocument: () => Promise.resolve(null) },
      sessions: {
        getSession: () => Promise.resolve(session),
        getControl: () => Promise.resolve(controlFor(session)),
      },
      processorForSession: () => ({
        recordNetworkRequestStarted: () =>
          Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-runtime-child-b2") }),
        recordNetworkRequestFinished: () =>
          Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-runtime-child-b2") }),
        recordNetworkMessageObserved: () =>
          Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-child-b2") }),
      }),
      newEventId: (() => {
        let eventNo = 0;
        return () => eventIdSchema.parse(`evt-runtime-child-b2-${String(eventNo++)}`);
      })(),
      now: () => T0,
    });
    runtime.install();
    await runtime.start({ session });

    // Child attaches; Network.enable stays pending while we stream in events
    // for the session (in-flight requests from before attach, buffered).
    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Target.attachedToTarget", {
        sessionId: childSessionId,
        targetInfo: { targetId: "target-oopif-b2", type: "worker" },
      });
    }
    await vi.waitFor(() => {
      expect(
        api.commands.some(
          (command) =>
            command.method === "Network.enable" && command.target.sessionId === childSessionId,
        ),
      ).toBe(true);
    });
    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9, sessionId: childSessionId }, "Network.responseReceived", {
        requestId: "REQ-CHILD-B2",
        timestamp: 10.01,
        response: { status: 200, headers: {}, mimeType: "application/json" },
        hasExtraInfo: false,
      });
    }
    await Promise.resolve();

    // Enable fails exactly like Chrome's -32001 session teardown.
    rejectEnable(new Error("Session with given id not found."));
    await vi.waitFor(() => {
      expect(
        envelopes.filter(
          (envelope) =>
            envelope.payload.kind === "capture_gap_open" &&
            envelope.payload.record.reason === "other_unrecoverable_window",
        ),
      ).toHaveLength(1);
    });

    const gaps = envelopes.filter((envelope) => envelope.payload.kind === "capture_gap_open");
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: { reason: "child_target_enable_delay" },
    });
    if (gaps[1]?.payload.kind !== "capture_gap_open") {
      throw new Error("expected an unrecoverable child-enable gap");
    }
    expect(gaps[1].payload.record.reason).toBe("other_unrecoverable_window");
    expect(gaps[1].payload.record.detail).toContain("child target network enable failed");
    expect(gaps[1].payload.record.detail).toContain(
      "1 in-flight request event(s) at attach discarded",
    );
    expect(
      envelopes.filter((envelope) => envelope.payload.kind === "request_metadata"),
    ).toHaveLength(0);

    runtime.dispose();
  });

  it("serializes request start and response persistence for one debugger source", async () => {
    const startEntered = deferred();
    const releaseStart = deferred();
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: async () => {
        startEntered.resolve(undefined);
        await releaseStart.promise;
        return { startedInStepId: stepIdSchema.parse("stp-runtime-ordered") };
      },
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-ordered") }),
    };
    const { api, envelopes, runtime, session } = createRuntimeHarness("ordered", processor);
    await runtime.start({ session });

    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Network.requestWillBeSent", {
        requestId: "REQ-ORDERED",
        timestamp: 10,
        wallTime: T0 / 1_000,
        type: "Fetch",
        request: {
          url: "https://example.com/ordered",
          method: "GET",
          headers: {},
        },
      });
    }
    await startEntered.promise;
    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Network.responseReceived", {
        requestId: "REQ-ORDERED",
        timestamp: 10.01,
        response: { status: 200, headers: {}, mimeType: "application/json" },
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseStart.resolve(undefined);

    await vi.waitFor(() => {
      expect(
        envelopes.some(
          (envelope) =>
            envelope.payload.kind === "request_metadata" &&
            envelope.payload.record.statusCode === 200,
        ),
      ).toBe(true);
    });
    runtime.dispose();
  });

  it("seals and drains admitted source work before debugger disconnect completes", async () => {
    const startEntered = deferred();
    const releaseStart = deferred();
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: async () => {
        startEntered.resolve(undefined);
        await releaseStart.promise;
        return { startedInStepId: stepIdSchema.parse("stp-runtime-drain") };
      },
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-drain") }),
    };
    const { api, envelopes, runtime, session } = createRuntimeHarness("drain", processor);
    await runtime.start({ session });
    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Network.requestWillBeSent", {
        requestId: "REQ-DRAIN",
        timestamp: 20,
        wallTime: T0 / 1_000,
        type: "Fetch",
        request: {
          url: "https://example.com/drain",
          method: "GET",
          headers: {},
        },
      });
    }
    await startEntered.promise;

    let disconnected = false;
    const disconnectPromise = runtime.disconnect(session.sessionId).then(() => {
      disconnected = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disconnected).toBe(false);

    releaseStart.resolve(undefined);
    await disconnectPromise;
    expect(envelopes.some((envelope) => envelope.payload.kind === "request_metadata")).toBe(true);
    const envelopeCountAfterDisconnect = envelopes.length;
    for (const listener of api.onEvent.listeners) {
      listener({ tabId: 9 }, "Network.responseReceived", {
        requestId: "REQ-DRAIN",
        timestamp: 20.01,
        response: { status: 200, headers: {}, mimeType: "application/json" },
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(envelopes).toHaveLength(envelopeCountAfterDisconnect);
    runtime.dispose();
  });

  it("detaches one root without sealing or clearing another root in the same session", async () => {
    const startEntered = deferred();
    const releaseStart = deferred();
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: async () => {
        startEntered.resolve(undefined);
        await releaseStart.promise;
        return { startedInStepId: stepIdSchema.parse("stp-runtime-multi-root") };
      },
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-multi-root") }),
    };
    const { api, envelopes, runtime, session } = createRuntimeHarness("multi-root", processor);
    await runtime.start({ session });
    await expect(runtime.attachTab(session.sessionId, extTabIdSchema.parse(10))).resolves.toEqual({
      ok: true,
    });

    emitDebuggerEvent(
      api,
      { tabId: 10 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-MULTI-ROOT", "https://example.com/multi-root"),
    );
    await startEntered.promise;
    for (const listener of api.onDetach.listeners) {
      listener({ tabId: 9 }, "canceled_by_user");
    }

    const gapBeforeOtherRootReleased = await Promise.race([
      vi
        .waitFor(() => {
          expect(
            envelopes.some((envelope) => envelope.payload.kind === "capture_gap_open"),
          ).toBe(true);
        })
        .then(() => true),
      new Promise<false>((resolve) => setTimeout(() => { resolve(false); }, 100)),
    ]);

    releaseStart.resolve(undefined);
    await vi.waitFor(() => {
      expect(envelopes.some((envelope) => envelope.payload.kind === "capture_gap_open")).toBe(true);
    });
    emitDebuggerEvent(api, { tabId: 10 }, "Network.responseReceived", {
      requestId: "REQ-MULTI-ROOT",
      timestamp: 10.01,
      response: { status: 200, headers: {}, mimeType: "application/json" },
    });
    const otherRootContinued = await Promise.race([
      vi
        .waitFor(() => {
          expect(
            envelopes.some(
              (envelope) =>
                envelope.payload.kind === "request_metadata" &&
                envelope.payload.record.keyParts.tabId === 10 &&
                envelope.payload.record.statusCode === 200,
            ),
          ).toBe(true);
        })
        .then(() => true),
      new Promise<false>((resolve) => setTimeout(() => { resolve(false); }, 1_000)),
    ]);

    expect(gapBeforeOtherRootReleased).toBe(true);
    expect(otherRootContinued).toBe(true);
    runtime.dispose();
  });

  it("routes a paused-compatible root gap close through the trusted cleanup entry", async () => {
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: () =>
        Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-runtime-cleanup") }),
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-cleanup") }),
    };
    const { api, envelopes, lifecycleCleanupEnvelopes, runtime, session } =
      createRuntimeHarness("cleanup", processor);
    await runtime.start({ session });

    for (const listener of api.onDetach.listeners) {
      listener({ tabId: 9 }, "canceled_by_user");
    }
    await vi.waitFor(() => {
      expect(envelopes.some((envelope) => envelope.payload.kind === "capture_gap_open")).toBe(true);
    });

    await runtime.disconnect(session.sessionId);

    expect(lifecycleCleanupEnvelopes).toHaveLength(1);
    expect(lifecycleCleanupEnvelopes[0]?.payload.kind).toBe("capture_gap_close");
    runtime.dispose();
  });

  it("routes an admitted child event with its immutable capture context after child detach", async () => {
    const firstStartEntered = deferred();
    const releaseFirstStart = deferred();
    let starts = 0;
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: async () => {
        starts += 1;
        if (starts === 1) {
          firstStartEntered.resolve(undefined);
          await releaseFirstStart.promise;
        }
        return { startedInStepId: stepIdSchema.parse("stp-runtime-context-snapshot") };
      },
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({
          observedDuringStepId: stepIdSchema.parse("stp-runtime-context-snapshot"),
        }),
    };
    const { api, envelopes, runtime, session } = createRuntimeHarness(
      "context-snapshot",
      processor,
    );
    const childSessionId = cdpSessionIdSchema.parse("child-context-snapshot");
    await runtime.start({ session });
    emitDebuggerEvent(api, { tabId: 9 }, "Target.attachedToTarget", {
      sessionId: childSessionId,
      targetInfo: { targetId: "target-context-snapshot", type: "iframe" },
    });
    await vi.waitFor(() => {
      expect(
        api.commands.some(
          (command) =>
            command.target.sessionId === childSessionId && command.method === "Network.enable",
        ),
      ).toBe(true);
    });

    emitDebuggerEvent(
      api,
      { tabId: 9, sessionId: childSessionId },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-CONTEXT-BLOCK", "https://example.com/context-block"),
    );
    await firstStartEntered.promise;
    emitDebuggerEvent(
      api,
      { tabId: 9, sessionId: childSessionId },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-CONTEXT-SNAPSHOT", "https://example.com/context-snapshot", 11),
    );
    emitDebuggerEvent(api, { tabId: 9 }, "Target.detachedFromTarget", {
      sessionId: childSessionId,
      targetId: "target-context-snapshot",
    });
    await vi.waitFor(() => {
      expect(envelopes.some((envelope) => envelope.payload.kind === "capture_gap_open")).toBe(true);
    });

    releaseFirstStart.resolve(undefined);
    await vi.waitFor(() => {
      expect(
        envelopes.some(
          (envelope) =>
            envelope.payload.kind === "request_metadata" &&
            envelope.payload.record.url === "https://example.com/context-snapshot",
        ),
      ).toBe(true);
    });
    runtime.dispose();
  });

  it("propagates an admitted event failure through disconnect", async () => {
    const routingErrors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      routingErrors.push(args);
    });
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: () => Promise.reject(new Error("accepted event failed")),
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-failure") }),
    };
    const { api, runtime, session } = createRuntimeHarness("failure", processor);
    try {
      await runtime.start({ session });
      emitDebuggerEvent(
        api,
        { tabId: 9 },
        "Network.requestWillBeSent",
        requestWillBeSent("REQ-FAILURE", "https://example.com/failure"),
      );
      await vi.waitFor(() => {
        expect(routingErrors.length).toBeGreaterThan(0);
      });

      await expect(runtime.disconnect(session.sessionId)).rejects.toThrow("accepted event failed");
    } finally {
      runtime.dispose();
      consoleError.mockRestore();
    }
  });

  it("bounds drain time and cancels queued work after the deadline", async () => {
    const firstStartEntered = deferred();
    const releaseFirstStart = deferred();
    let starts = 0;
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: async () => {
        starts += 1;
        if (starts === 1) {
          firstStartEntered.resolve(undefined);
          await releaseFirstStart.promise;
        }
        return { startedInStepId: stepIdSchema.parse("stp-runtime-deadline") };
      },
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-deadline") }),
    };
    const api = new FakeChromeDebuggerApi();
    const session = runtimeSession("deadline");
    const captureEpochId = session.captureEpochIds.at(-1);
    if (captureEpochId === undefined) {
      throw new Error("deadline fixture has no capture epoch");
    }
    const envelopes: EventEnvelope[] = [];
    let eventNo = 0;
    const runtime = new DebuggerNetworkRuntime({
      debuggerApi: api,
      ingestor: {
        ingest: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({
            status: "committed",
            eventId: envelope.eventId,
            committedBytes: 1,
          });
        },
      },
      ingestLifecycleCleanup: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
      networkState: {
        nextAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(0)),
        getIdentifierMapping: () => Promise.resolve(null),
        listInFlightRequestRecordsBySession: () => Promise.resolve([]),
      },
      navigationContexts: {
        getCurrentDocument: (_sessionId, tabId, frameId) =>
          Promise.resolve({
            schemaVersion: SCHEMA_VERSION,
            documentKey: `doc-key-deadline-${String(tabId)}-${String(frameId)}`,
            sessionId: session.sessionId,
            captureEpochId,
            tabId,
            frameId,
            documentId: extDocumentIdSchema.parse(
              `doc-deadline-${String(tabId)}-${String(frameId)}`,
            ),
            url: session.originUrl,
            committedAt: T0,
          }),
      },
      sessions: {
        getSession: () => Promise.resolve(session),
        getControl: () => Promise.resolve(controlFor(session)),
      },
      processorForSession: () => processor,
      newEventId: () => eventIdSchema.parse(`evt-deadline-${String(eventNo++)}`),
      now: () => T0,
      drainTimeoutMs: 25,
    });
    runtime.install();
    await runtime.start({ session });
    emitDebuggerEvent(
      api,
      { tabId: 9 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-DEADLINE-BLOCK", "https://example.com/deadline-block"),
    );
    await firstStartEntered.promise;
    emitDebuggerEvent(
      api,
      { tabId: 9 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-DEADLINE-QUEUED", "https://example.com/deadline-queued", 11),
    );

    const disconnectOutcome = runtime.disconnect(session.sessionId).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const boundedOutcome = await Promise.race([
      disconnectOutcome,
      new Promise<{ kind: "external_timeout" }>((resolve) =>
        setTimeout(() => { resolve({ kind: "external_timeout" }); }, 150),
      ),
    ]);
    releaseFirstStart.resolve(undefined);
    const finalDisconnectOutcome = await Promise.race([
      disconnectOutcome,
      new Promise<{ kind: "external_timeout" }>((resolve) =>
        setTimeout(() => { resolve({ kind: "external_timeout" }); }, 500),
      ),
    ]);

    expect(boundedOutcome).toMatchObject({ kind: "rejected" });
    expect(finalDisconnectOutcome).toMatchObject({ kind: "rejected" });
    if (boundedOutcome.kind === "rejected") {
      expect(boundedOutcome.error).toBeInstanceOf(Error);
      expect((boundedOutcome.error as Error).message).toContain("drain timed out");
    }
    expect(
      envelopes.some(
        (envelope) =>
          envelope.payload.kind === "request_metadata" &&
          envelope.payload.record.url === "https://example.com/deadline-queued",
      ),
    ).toBe(false);
    runtime.dispose();
  });

  it("buffers debugger facts during prepare and routes them only after activate", async () => {
    const processor: NetworkStepProcessor = {
      recordNetworkRequestStarted: () =>
        Promise.resolve({ startedInStepId: stepIdSchema.parse("stp-runtime-prepare") }),
      recordNetworkRequestFinished: () => Promise.resolve(null),
      recordNetworkMessageObserved: () =>
        Promise.resolve({ observedDuringStepId: stepIdSchema.parse("stp-runtime-prepare") }),
    };
    const { api, envelopes, runtime, session } = createRuntimeHarness("prepare", processor);

    await expect(runtime.prepare({ session })).resolves.toEqual({ ok: true });
    emitDebuggerEvent(
      api,
      { tabId: 9 },
      "Network.requestWillBeSent",
      requestWillBeSent("REQ-PREPARED", "https://example.com/prepared"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(envelopes).toEqual([]);

    await expect(runtime.activate({ session })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(
        envelopes.some(
          (envelope) =>
            envelope.payload.kind === "request_metadata" &&
            envelope.payload.record.url === "https://example.com/prepared",
        ),
      ).toBe(true);
    });
    runtime.dispose();
  });
});
