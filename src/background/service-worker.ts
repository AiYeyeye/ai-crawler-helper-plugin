import { openDatabase } from "../persistence/database";
import { DEFAULT_LOCALE } from "../shared/i18n";
import { SessionRepository, SessionRepositoryError } from "../persistence/session-repository";
import { StepRepository } from "../persistence/step-repository";
import { SettingsRepository } from "../persistence/settings-repository";
import { CaptureGapRepository } from "../persistence/capture-gap-repository";
import { FactIngestor } from "../persistence/fact-ingestor";
import { StoragePressureController } from "../persistence/storage-pressure";
import { ChromeStorageControlMirror } from "../persistence/control-mirror";
import { recoverOnStartup } from "../persistence/recovery";
import { CapacityGuard, navigatorStorageEstimateProvider } from "../core/capacity-guard";
import {
  DEFAULT_CAPACITY_GUARD_CONFIG,
  STOP_COMPLETION_POLL_MS,
  STOP_LATE_RESPONSE_WINDOW_MS,
  STOP_MIN_EARLY_EXIT_WINDOW_MS,
  STOP_QUIESCENT_WINDOW_MS,
} from "../core/config";
import {
  completeSessionStop,
  createStopActivityTracker,
  recoverStoppingSession,
  remainingStopCompletionDelayMs,
  shouldCompleteStopEarly,
  type StopActivityTracker,
} from "../core/stop-completion";
import type { CollectorPipeline } from "../core/collector-contracts";
import {
  runtimeRequestSchema,
  type FactsSubmitResponse,
  type ListSessionsResponse,
  type ObservationsSubmitResponse,
  type RuntimeRequest,
  type RuntimeResponse,
  type SessionSnapshot,
  type StepDetail,
} from "../shared/messages";
import { businessError, type BusinessError } from "../shared/errors";
import {
  newEventId,
  newGapId,
  sessionIdSchema,
  type SessionId,
} from "../shared/ids";
import { SCHEMA_VERSION } from "../schemas/common";
import type { EnvelopeAck } from "../schemas/event-envelope";
import type { StepContext } from "../core/step-orchestrator";
import {
  classifyContentObservationContext,
  resolveContentSessionContext,
  acceptsContentObservation,
  type ContentMessageSenderIdentity,
} from "./content-session-context";
import { ObservationProcessor } from "./observation-processor";
import { isExpectedFactGateClosure } from "./persistence-rejection";
import { SessionCaptureLifecycleCoordinator } from "./session-capture-lifecycle-coordinator";
import { NavigationContextRepository } from "../persistence/navigation-context-repository";
import { BrowserNavigationProcessor } from "./browser-navigation-processor";
import { NetworkStateRepository } from "../persistence/network-state-repository";
import {
  DebuggerNetworkRuntime,
  type ChromeDebuggerRuntimeApi,
} from "./debugger-network-runtime";
import {
  StorageCollector,
  chromePageStorageRequester,
  type FrameStorageTarget,
} from "./storage-collector";
import {
  chromeContentScriptRegistrar,
  startRecordingSession,
  type ContentScriptRegistrarApi,
} from "./session-start";
import type { CookiesApi, PermissionsApi } from "./cookie-collector";

type RuntimeDebuggerEventListener = Parameters<
  ChromeDebuggerRuntimeApi["onEvent"]["addListener"]
>[0];
type RuntimeDebuggerDetachListener = Parameters<
  ChromeDebuggerRuntimeApi["onDetach"]["addListener"]
>[0];
type ChromeDebuggerEventListener = Parameters<typeof chrome.debugger.onEvent.addListener>[0];
type ChromeDebuggerDetachListener = Parameters<typeof chrome.debugger.onDetach.addListener>[0];

const createChromeDebuggerRuntimeApi = (): ChromeDebuggerRuntimeApi => {
  const eventWrappers = new Map<RuntimeDebuggerEventListener, ChromeDebuggerEventListener>();
  const detachWrappers = new Map<RuntimeDebuggerDetachListener, ChromeDebuggerDetachListener>();
  return {
    attach: (debuggee, requiredVersion) => chrome.debugger.attach(debuggee, requiredVersion),
    detach: (debuggee) => chrome.debugger.detach(debuggee),
    sendCommand: (debuggee, method, commandParams) =>
      chrome.debugger.sendCommand(debuggee, method, commandParams),
    onEvent: {
      addListener: (listener) => {
        const wrapped: ChromeDebuggerEventListener = (source, method, params) => {
          listener(source, method, params);
        };
        eventWrappers.set(listener, wrapped);
        chrome.debugger.onEvent.addListener(wrapped);
      },
      removeListener: (listener) => {
        const wrapped = eventWrappers.get(listener);
        if (wrapped !== undefined) {
          chrome.debugger.onEvent.removeListener(wrapped);
          eventWrappers.delete(listener);
        }
      },
    },
    onDetach: {
      addListener: (listener) => {
        const wrapped: ChromeDebuggerDetachListener = (source, reason) => {
          listener(source, reason);
        };
        detachWrappers.set(listener, wrapped);
        chrome.debugger.onDetach.addListener(wrapped);
      },
      removeListener: (listener) => {
        const wrapped = detachWrappers.get(listener);
        if (wrapped !== undefined) {
          chrome.debugger.onDetach.removeListener(wrapped);
          detachWrappers.delete(listener);
        }
      },
    },
  };
};

const installMainWorldHistoryBridge = (token: string): void => {
  const root = document.documentElement;
  const installedAttribute = "data-ai-crawler-history-bridge-installed";
  const tokenAttribute = "data-ai-crawler-history-bridge-token";
  root.setAttribute(tokenAttribute, token);
  if (root.hasAttribute(installedAttribute)) {
    return;
  }
  root.setAttribute(installedAttribute, "true");

  const emit = (action: "push" | "replace", beforeUrl: string, afterUrl: string): void => {
    const currentToken = root.getAttribute(tokenAttribute);
    if (currentToken === null) {
      return;
    }
    window.postMessage(
      {
        source: "ai-crawler-helper-history-bridge",
        token: currentToken,
        action,
        beforeUrl,
        afterUrl,
        occurredAt: Date.now(),
      },
      "*",
    );
  };

  const originalPushState = history.pushState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>): void => {
    const beforeUrl = location.href;
    originalPushState(...args);
    emit("push", beforeUrl, location.href);
  };
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args: Parameters<History["replaceState"]>): void => {
    const beforeUrl = location.href;
    originalReplaceState(...args);
    emit("replace", beforeUrl, location.href);
  };
};

/**
 * Service worker runtime wiring (design 3.1).
 *
 * The worker is a stateless-ish coordinator: IndexedDB is the only source of
 * truth. On every (re)start we run unclean-epoch recovery before serving any
 * message. The collector pipeline (debugger network + storage) is assembled
 * here; `startRecording` refuses with `CAPTURE_PIPELINE_UNAVAILABLE` if a
 * build ever ships without one — sessions are never created half-capturing.
 */

interface Runtime {
  db: IDBDatabase;
  sessions: SessionRepository;
  steps: StepRepository;
  settings: SettingsRepository;
  gaps: CaptureGapRepository;
  ingestor: FactIngestor;
  pressure: StoragePressureController;
  guard: CapacityGuard;
  observationProcessors: Map<SessionId, ObservationProcessor>;
  contexts: NavigationContextRepository;
  navigation: BrowserNavigationProcessor;
  networkState: NetworkStateRepository;
  networkCollector: DebuggerNetworkRuntime;
  storageCollector: StorageCollector;
  stopTimers: Map<SessionId, ReturnType<typeof setTimeout>>;
  /** Collectors this build ships; replaceable via registerCollectorPipeline. */
  pipeline: CollectorPipeline | null;
}

const stopActivity: StopActivityTracker = createStopActivityTracker();

let runtimePromise: Promise<Runtime> | null = null;

const initRuntime = async (): Promise<Runtime> => {
  const db = await openDatabase();
  const guard = new CapacityGuard(navigatorStorageEstimateProvider, DEFAULT_CAPACITY_GUARD_CONFIG);
  const mirror = new ChromeStorageControlMirror();
  const pressure = new StoragePressureController(db, mirror);
  const ingestor = new FactIngestor(db, guard, pressure, undefined, (sessionId) => {
    stopActivity.markActivity(sessionId);
  });
  const recovered = await recoverOnStartup(db, Date.now());
  if (recovered.length > 0) {
    // Recovery facts are already persisted; log locally for diagnostics only.
    console.info(
      "[ai-crawler-helper] recovered unclean sessions:",
      recovered.map((entry) => entry.sessionId).join(","),
    );
  }
  const sessions = new SessionRepository(db);
  const steps = new StepRepository(db);
  const settings = new SettingsRepository(db);
  const observationProcessors = new Map<SessionId, ObservationProcessor>();
  const contexts = new NavigationContextRepository(db);
  const networkState = new NetworkStateRepository(db);
  const getOrCreateProcessor = (sessionId: SessionId): ObservationProcessor => {
    const existing = observationProcessors.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new ObservationProcessor({
      db,
      ingestor,
      sessionRepository: sessions,
      stepRepository: steps,
      networkStateRepository: networkState,
    });
    observationProcessors.set(sessionId, created);
    return created;
  };
  const networkCollector = new DebuggerNetworkRuntime({
    debuggerApi: createChromeDebuggerRuntimeApi(),
    ingestor,
    ingestLifecycleCleanup: (envelope) => ingestor.ingestLifecycleCleanup(envelope),
    networkState,
    navigationContexts: contexts,
    sessions,
    processorForSession: getOrCreateProcessor,
  });
  networkCollector.install();
  const navigation = new BrowserNavigationProcessor({
    sessions,
    contexts,
    getObservationProcessor: getOrCreateProcessor,
    onDerivedTabRegistered: async (sessionId, tabId) => {
      const result = await networkCollector.attachTab(sessionId, tabId);
      if (!result.ok) {
        throw new Error(`derived tab debugger attach failed: ${result.error.code}`);
      }
    },
    resolveTitle: async (tabId) => {
      try {
        return (await chrome.tabs.get(tabId)).title;
      } catch {
        return undefined;
      }
    },
  });
  const storageCollector = new StorageCollector({
    cookies: { cookies: chromeCookiesApi(), permissions: chromePermissionsApi() },
    additionalCookieOriginsFor: async (sessionId) =>
      (await sessions.getSession(sessionId))?.config.extraCookieDomains ?? [],
    requestPageStorage: chromePageStorageRequester(chrome.tabs),
    listFrames: (sessionId) => listSessionFrames(contexts, sessionId),
    ingest: (envelope) => ingestor.ingest(envelope),
  });
  const runtime: Runtime = {
    db,
    sessions,
    steps,
    settings,
    gaps: new CaptureGapRepository(db),
    ingestor,
    pressure,
    guard,
    observationProcessors,
    contexts,
    navigation,
    networkState,
    networkCollector,
    storageCollector,
    stopTimers: new Map(),
    // Every collector the build actually ships. Registration is no longer
    // deferred: without it `startRecording` could only ever refuse.
    pipeline: { collectors: [networkCollector, storageCollector] },
  };
  const lifecycle = new SessionCaptureLifecycleCoordinator({
    sessions,
    contexts,
    pipeline: () => runtime.pipeline,
    networkCollector,
    processorForSession: (sessionId) => observationProcessors.get(sessionId),
    navigation,
  });
  pressure.setLifecycleHooks({
    onPaused: (sessionId) => lifecycle.pause(sessionId),
    onResumed: (sessionId, captureEpochId) => lifecycle.resume(sessionId, captureEpochId),
  });
  for (const session of await sessions.listSessions()) {
    if (session.lifecycle === "stopping") {
      const stopRequestedAt = session.stopRequestedAt ?? Date.now();
      try {
        await recoverStoppingSession({
          restoreCollectors: () => lifecycle.restoreStopping(session.sessionId),
          persistDegradedRecovery: (error) =>
            recordStoppingRecoveryGap(runtime, session.sessionId, stopRequestedAt, error),
          scheduleCompletion: () =>
            { scheduleStopCompletion(runtime, session.sessionId, stopRequestedAt); },
        });
      } catch (cause: unknown) {
        console.error(
          "[ai-crawler-helper] stopping session recovery could not be persisted",
          session.sessionId,
          cause,
        );
      }
    }
  }
  return runtime;
};

/**
 * Adapters from the ambient `chrome.*` overloads to this codebase's narrow,
 * readonly structural ports. The ports are deliberately not the chrome types:
 * they keep collectors unit-testable and immune to new fields upstream.
 */
const chromeCookiesApi = (): CookiesApi => ({
  getAll: (details) => chrome.cookies.getAll({ url: details.url }),
});

const chromePermissionsApi = (): PermissionsApi => ({
  contains: (descriptor) => chrome.permissions.contains({ origins: [...descriptor.origins] }),
});

const chromeScriptingApi = (): ContentScriptRegistrarApi => ({
  getRegisteredContentScripts: () => chrome.scripting.getRegisteredContentScripts(),
  registerContentScripts: (scripts) =>
    chrome.scripting.registerContentScripts(
      scripts.map((script) => ({
        id: script.id,
        matches: [...script.matches],
        js: [...script.js],
        runAt: script.runAt,
        allFrames: script.allFrames,
      })),
    ),
});

/**
 * Distinct (tabId, frameId) pairs currently known for the session, newest
 * document first. Storage is read per frame — never merged across frames.
 */
const listSessionFrames = async (
  contexts: NavigationContextRepository,
  sessionId: SessionId,
): Promise<readonly FrameStorageTarget[]> => {
  const documents = await contexts.listDocumentsBySession(sessionId);
  const seen = new Set<string>();
  const frames: FrameStorageTarget[] = [];
  for (const document of documents) {
    const key = `${String(document.tabId)}:${String(document.frameId)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    frames.push({ tabId: document.tabId, frameId: document.frameId });
  }
  return frames;
};

const getRuntime = (): Promise<Runtime> => {
  runtimePromise ??= initRuntime();
  return runtimePromise;
};

/** Override hook: swaps the shipped pipeline (tests / alternate builds). */
export const registerCollectorPipeline = async (pipeline: CollectorPipeline): Promise<void> => {
  const runtime = await getRuntime();
  runtime.pipeline = pipeline;
};

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

const okResponse = (value: unknown): RuntimeResponse => ({ ok: true, value });
const errResponse = (error: BusinessError): RuntimeResponse => ({ ok: false, error });

const rejectedObservation = (
  eventId: EnvelopeAck["eventId"],
  errorCode: string,
): Extract<EnvelopeAck, { status: "rejected" }> => ({
  status: "rejected",
  eventId,
  errorCode,
  retryable: false,
});

const getObservationProcessor = (
  runtime: Runtime,
  sessionId: SessionId,
): ObservationProcessor => {
  const existing = runtime.observationProcessors.get(sessionId);
  if (existing !== undefined) {
    return existing;
  }
  const created = new ObservationProcessor({
    db: runtime.db,
    ingestor: runtime.ingestor,
    sessionRepository: runtime.sessions,
    stepRepository: runtime.steps,
    networkStateRepository: runtime.networkState,
  });
  runtime.observationProcessors.set(sessionId, created);
  return created;
};

const recordStoppingRecoveryGap = async (
  runtime: Runtime,
  sessionId: SessionId,
  stopRequestedAt: number,
  error: BusinessError,
): Promise<void> => {
  const observedStartedAt = Date.now();
  const observedEndedAt = Math.max(
    observedStartedAt,
    stopRequestedAt + STOP_LATE_RESPONSE_WINDOW_MS,
  );
  const ack = await runtime.ingestor.ingest({
    schemaVersion: SCHEMA_VERSION,
    eventId: newEventId(),
    source: "service_worker",
    sourceSeq: observedStartedAt,
    sessionId,
    scope: {},
    sourceTimestamp: observedStartedAt,
    payload: {
      kind: "capture_gap_open",
      record: {
        schemaVersion: SCHEMA_VERSION,
        gapId: newGapId(),
        scope: { sessionId, collector: "all" },
        reason: "runtime_interrupted",
        observedStartedAt,
        observedEndedAt,
        boundaryConfidence: "estimated",
        recoverable: false,
        affectedCapabilities: ["all"],
        recovery: { action: "none", recoveredAt: observedEndedAt },
        detail: `stopping collector restoration failed: ${error.code}`,
      },
    },
  });
  if (ack.status === "rejected") {
    throw new Error(`stopping recovery CaptureGap persistence rejected: ${ack.errorCode}`);
  }
};

const completeStop = async (runtime: Runtime, sessionId: SessionId): Promise<void> => {
  try {
    await completeSessionStop({
      sealAndDrainNavigation: () => runtime.navigation.sealAndDrain(sessionId),
      finalizeObservations: () =>
        getObservationProcessor(runtime, sessionId).sessionStopping(sessionId),
      // Collectors stop while lifecycle is `stopping`, so final snapshots and
      // admitted late network facts commit before the clean lifecycle boundary.
      stopCollectors: (runtime.pipeline?.collectors ?? []).map(
        (collector) => () => collector.stop(sessionId),
      ),
      persistCleanCompletion: async () => {
        await runtime.sessions.applyLifecycleEvent(sessionId, "stop_completed", {
          now: Date.now(),
          cleanStop: true,
        });
      },
      cleanupRuntime: () => {
        runtime.stopTimers.delete(sessionId);
        runtime.observationProcessors.delete(sessionId);
        stopActivity.clear(sessionId);
      },
    });
  } catch (cause: unknown) {
    console.warn("[ai-crawler-helper] clean stop failed, persisting degraded stop completion", cause);
    try {
      await runtime.sessions.applyLifecycleEvent(sessionId, "stop_completed", {
        now: Date.now(),
        cleanStop: false,
      });
    } catch (persistError: unknown) {
      console.error("[ai-crawler-helper] failed to persist degraded stop", persistError);
    }
    runtime.stopTimers.delete(sessionId);
    runtime.observationProcessors.delete(sessionId);
    stopActivity.clear(sessionId);
  }
};

/**
 * Adaptive stop-completion scheduler.
 *
 * Polls the stop window and completes as soon as it may:
 *  - hard deadline: stopRequestedAt + STOP_LATE_RESPONSE_WINDOW_MS (always),
 *  - quiescent early-exit: min window elapsed, at least one fact ingested
 *    inside the window, then STOP_QUIESCENT_WINDOW_MS of silence.
 * A session that shows no activity at all keeps the full window, because its
 * producer (e.g. a throttled background tab) may still be asleep.
 */
const scheduleStopCompletion = (
  runtime: Runtime,
  sessionId: SessionId,
  stopRequestedAt: number,
): void => {
  if (runtime.stopTimers.has(sessionId)) {
    return;
  }
  const poll = (): void => {
    const now = Date.now();
    const hardDeadlineReached = now >= stopRequestedAt + STOP_LATE_RESPONSE_WINDOW_MS;
    const mayCompleteEarly = shouldCompleteStopEarly(now, stopRequestedAt, stopActivity, sessionId, {
      minEarlyExitWindowMs: STOP_MIN_EARLY_EXIT_WINDOW_MS,
      quiescentWindowMs: STOP_QUIESCENT_WINDOW_MS,
    });
    if (hardDeadlineReached || mayCompleteEarly) {
      runtime.stopTimers.delete(sessionId);
      void completeStop(runtime, sessionId).catch((cause: unknown) => {
        console.error("[ai-crawler-helper] orderly stop finalization failed", cause);
        runtime.stopTimers.delete(sessionId);
      });
      return;
    }
    runtime.stopTimers.set(sessionId, setTimeout(poll, STOP_COMPLETION_POLL_MS));
  };
  // First tick honors the durable deadline (worker-restart remainder) but
  // never waits longer than the poll cadence; later ticks poll at
  // STOP_COMPLETION_POLL_MS for quiescent early-exit.
  const initialDelayMs = Math.min(
    remainingStopCompletionDelayMs(stopRequestedAt, STOP_LATE_RESPONSE_WINDOW_MS, Date.now()),
    STOP_COMPLETION_POLL_MS,
  );
  runtime.stopTimers.set(sessionId, setTimeout(poll, initialDelayMs));
};

const installHistoryBridge = async (
  sender: ContentMessageSenderIdentity,
  token: string,
): Promise<boolean> => {
  if (sender.tabId === undefined || sender.frameId === undefined) {
    return false;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: sender.tabId, frameIds: [sender.frameId] },
      world: "MAIN",
      func: installMainWorldHistoryBridge,
      args: [token],
    });
    return true;
  } catch (cause: unknown) {
    console.warn("[ai-crawler-helper] History API bridge unavailable", cause);
    return false;
  }
};

const recordHistoryBridgeGap = async (
  runtime: Runtime,
  context: StepContext,
  observedAt: number,
): Promise<void> => {
  const ack = await runtime.ingestor.ingest({
    schemaVersion: SCHEMA_VERSION,
    eventId: newEventId(),
    source: "service_worker",
    sourceSeq: observedAt,
    sessionId: context.sessionId,
    scope: context.scope,
    sourceTimestamp: observedAt,
    payload: {
      kind: "capture_gap_open",
      record: {
        schemaVersion: SCHEMA_VERSION,
        gapId: newGapId(),
        scope: {
          sessionId: context.sessionId,
          tabId: context.scope.tabId,
          frameId: context.scope.frameId,
          documentId: context.scope.documentId,
          collector: "navigation",
        },
        reason: "history_bridge_unavailable",
        observedStartedAt: observedAt,
        boundaryConfidence: "exact",
        recoverable: false,
        affectedCapabilities: ["navigation"],
        detail: "MAIN-world History API bridge injection failed; pushState/replaceState are unavailable for this document.",
      },
    },
  });
  if (ack.status === "rejected") {
    throw new Error(`History bridge CaptureGap persistence rejected: ${ack.errorCode}`);
  }
};

const handleRequest = async (
  request: RuntimeRequest,
  sender: ContentMessageSenderIdentity,
): Promise<RuntimeResponse> => {
  const runtime = await getRuntime();
  switch (request.type) {
    case "facts/submit": {
      const acks = [];
      for (const envelope of request.envelopes) {
        acks.push(await runtime.ingestor.ingest(envelope));
      }
      return okResponse({ acks } satisfies FactsSubmitResponse);
    }
    case "observations/submit": {
      const resolved = await resolveContentSessionContext(runtime.sessions, sender);
      if (!resolved.active) {
        return okResponse({
          acks: request.observations.map((observation) =>
            rejectedObservation(observation.eventId, "SESSION_NOT_ACCEPTING_FACTS"),
          ),
        } satisfies ObservationsSubmitResponse);
      }
      const context: StepContext = {
        sessionId: resolved.sessionId,
        captureEpochId: resolved.captureEpochId,
        scope: resolved.scope,
      };
      const processor = getObservationProcessor(runtime, resolved.sessionId);
      const session = await runtime.sessions.getSession(resolved.sessionId);
      const issuedSessions = await runtime.sessions.listSessionsForTab(context.scope.tabId);
      const acks: EnvelopeAck[] = [];
      for (const observation of request.observations) {
        const contextClassification = classifyContentObservationContext(
          observation,
          context,
          issuedSessions,
        );
        if (contextClassification !== "current") {
          acks.push(
            rejectedObservation(
              observation.eventId,
              contextClassification === "stale"
                ? "CAPTURE_CONTEXT_STALE"
                : "PROTOCOL_MESSAGE_INVALID",
            ),
          );
          continue;
        }
        if (session === null || !acceptsContentObservation(session.lifecycle, observation.payload)) {
          acks.push(
            rejectedObservation(observation.eventId, "SESSION_NOT_ACCEPTING_FACTS"),
          );
          continue;
        }
        if (observation.payload.kind === "navigation_observed") {
          const currentDocument = await runtime.contexts.getCurrentDocument(
            context.sessionId,
            context.scope.tabId,
            context.scope.frameId,
          );
          if (
            sender.url === undefined ||
            sender.url !== observation.payload.navigation.afterUrl ||
            (currentDocument !== null &&
              currentDocument.url !== observation.payload.navigation.beforeUrl)
          ) {
            acks.push(rejectedObservation(observation.eventId, "PROTOCOL_MESSAGE_INVALID"));
            continue;
          }
        }
        const ack = await processor.process(observation, context);
        acks.push(ack);
        if (ack.status !== "rejected" && observation.payload.kind === "navigation_observed") {
          await runtime.contexts.upsertDocument({
            sessionId: context.sessionId,
            captureEpochId: context.captureEpochId,
            tabId: context.scope.tabId,
            frameId: context.scope.frameId,
            documentId: context.scope.documentId,
            url: observation.payload.navigation.afterUrl,
            ...(observation.payload.navigation.title === undefined
              ? {}
              : { title: observation.payload.navigation.title }),
            committedAt: observation.sourceTimestamp,
          });
        }
      }
      return okResponse({ acks } satisfies ObservationsSubmitResponse);
    }
    case "command/startRecording": {
      const result = await startRecordingSession(
        {
          sessions: runtime.sessions,
          settings: runtime.settings,
          pipeline: runtime.pipeline,
          tabs: {
            get: (tabId) => chrome.tabs.get(tabId),
            reload: (tabId) => chrome.tabs.reload(tabId),
          },
          permissions: chromePermissionsApi(),
          contentScripts: chromeContentScriptRegistrar(chromeScriptingApi()),
          isFileSchemeAllowed: () => chrome.extension.isAllowedFileSchemeAccess(),
          now: () => Date.now(),
        },
        { tabId: request.tabId, mode: request.mode },
      );
      return result.ok
        ? okResponse({ sessionId: result.value.sessionId })
        : errResponse(result.error);
    }
    case "command/stopRecording": {
      const now = Date.now();
      const existing = await runtime.sessions.getSession(request.sessionId);
      if (existing?.lifecycle === "stopping") {
        const stopRequestedAt = existing.stopRequestedAt ?? now;
        if (now >= stopRequestedAt + STOP_LATE_RESPONSE_WINDOW_MS) {
          await completeStop(runtime, request.sessionId);
        } else {
          scheduleStopCompletion(runtime, request.sessionId, stopRequestedAt);
        }
        return okResponse({
          stopping: true,
          lateResponseWindowMs: STOP_LATE_RESPONSE_WINDOW_MS,
        });
      }
      await runtime.sessions.applyLifecycleEvent(request.sessionId, "stop_requested", { now });
      const stoppingSession = await runtime.sessions.getSession(request.sessionId);
      scheduleStopCompletion(
        runtime,
        request.sessionId,
        stoppingSession?.stopRequestedAt ?? now,
      );
      return okResponse({
        stopping: true,
        lateResponseWindowMs: STOP_LATE_RESPONSE_WINDOW_MS,
      });
    }
    case "command/resumeAfterStoragePressure": {
      const result = await runtime.pressure.resume(request.sessionId, runtime.guard, Date.now());
      return result.ok ? okResponse(result.value) : errResponse(result.error);
    }
    case "command/exportSession": {
      const hasOffscreen = await chrome.offscreen.hasDocument();
      if (!hasOffscreen) {
        await chrome.offscreen.createDocument({
          url: "offscreen/index.html",
          reasons: [chrome.offscreen.Reason.BLOBS],
          justification: "Streaming ZIP export runner",
        });
      }
      // Snapshot the language once at export start so a single export is
      // internally consistent even if the user switches language mid-run.
      const settings = await runtime.settings.getAppSettings();
      const locale = settings.locale ?? DEFAULT_LOCALE;
      const response: unknown = await chrome.runtime.sendMessage({
        type: "offscreen/export/start",
        sessionId: request.sessionId,
        locale,
        ...(request.format === undefined ? {} : { format: request.format }),
        ...(request.sink === undefined ? {} : { sink: request.sink }),
      });
      return response as RuntimeResponse;
    }
    case "offscreen/download/start": {
      const downloadId = await chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        saveAs: request.saveAs,
      });
      return okResponse({ downloadId });
    }
    case "command/deleteSession": {
      await runtime.navigation.forgetSession(request.sessionId);
      for (const collector of [...(runtime.pipeline?.collectors ?? [])].reverse()) {
        await collector.disconnect(request.sessionId);
      }
      await runtime.sessions.deleteSession(request.sessionId, Date.now());
      runtime.observationProcessors.delete(request.sessionId);
      stopActivity.clear(request.sessionId);
      return okResponse({ deleted: true });
    }
    case "query/listSessions": {
      const sessions = await runtime.sessions.listSessions();
      for (const session of sessions) {
        if (session.lifecycle === "stopping") {
          const stopRequestedAt = session.stopRequestedAt ?? Date.now();
          if (Date.now() >= stopRequestedAt + STOP_LATE_RESPONSE_WINDOW_MS) {
            void completeStop(runtime, session.sessionId);
          } else {
            scheduleStopCompletion(runtime, session.sessionId, stopRequestedAt);
          }
        }
      }
      return okResponse({ sessions } satisfies ListSessionsResponse);
    }
    case "query/sessionSnapshot": {
      const sessionId = sessionIdSchema.parse(request.sessionId);
      const session = await runtime.sessions.getSession(sessionId);
      const control = await runtime.sessions.getControl(sessionId);
      if (session === null || control === null) {
        return errResponse(businessError("SESSION_NOT_FOUND", `session ${sessionId} not found`));
      }
      if (session.lifecycle === "stopping") {
        const stopRequestedAt = session.stopRequestedAt ?? Date.now();
        if (Date.now() >= stopRequestedAt + STOP_LATE_RESPONSE_WINDOW_MS) {
          void completeStop(runtime, sessionId);
        } else {
          scheduleStopCompletion(runtime, sessionId, stopRequestedAt);
        }
      }
      const snapshot: SessionSnapshot = {
        session,
        control,
        steps: await runtime.steps.listStepsBySession(sessionId),
        gaps: await runtime.gaps.listGapsBySession(sessionId),
      };
      return okResponse(snapshot);
    }
    case "query/stepDetail": {
      const detail = await runtime.steps.getStepDetail(request.stepId);
      return detail === null
        ? errResponse(businessError("STEP_NOT_FOUND", `step ${request.stepId} not found`))
        : okResponse(detail satisfies StepDetail);
    }
    case "command/updateStepReview": {
      const step = await runtime.steps.getStep(request.stepId);
      if (step === null) {
        return errResponse(businessError("STEP_NOT_FOUND", `step ${request.stepId} not found`));
      }
      const now = Date.now();
      const ack = await runtime.ingestor.ingest({
        schemaVersion: SCHEMA_VERSION,
        eventId: newEventId(),
        source: "service_worker",
        sourceSeq: now,
        sessionId: step.sessionId,
        scope: step.scope,
        sourceTimestamp: now,
        payload: {
          kind: "step_review_update",
          stepId: request.stepId,
          ...(request.excluded === undefined ? {} : { excluded: request.excluded }),
          ...(request.note === undefined ? {} : { note: request.note }),
        },
      });
      return okResponse({ ack });
    }
    case "query/appSettings":
      return okResponse(await runtime.settings.getAppSettings());
    case "command/updateAppSettings":
      return okResponse(
        await runtime.settings.updateDefaultSessionConfig(request.patch, Date.now()),
      );
    case "command/updateLocale":
      return okResponse(await runtime.settings.updateLocale(request.locale, Date.now()));
    case "handshake/contentScript": {
      const resolved = await resolveContentSessionContext(runtime.sessions, sender, {
        acceptStopping: false,
      });
      if (!resolved.active) {
        return okResponse(resolved);
      }
      await runtime.contexts.upsertDocument({
        sessionId: resolved.sessionId,
        captureEpochId: resolved.captureEpochId,
        tabId: resolved.scope.tabId,
        frameId: resolved.scope.frameId,
        documentId: resolved.scope.documentId,
        url: request.url,
        committedAt: Date.now(),
      });
      const historyBridgeToken = newEventId();
      const installed = await installHistoryBridge(sender, historyBridgeToken);
      if (!installed) {
        await recordHistoryBridgeGap(runtime, {
          sessionId: resolved.sessionId,
          captureEpochId: resolved.captureEpochId,
          scope: resolved.scope,
        }, Date.now());
      }
      return okResponse(
        installed ? { ...resolved, historyBridgeToken } : resolved,
      );
    }
  }
};

const toBusinessError = (cause: unknown): BusinessError => {
  if (cause instanceof SessionRepositoryError) {
    return cause.businessError;
  }
  // Boundary rule: no stacks/raw messages across contexts.
  return businessError("PERSISTENCE_TRANSACTION_FAILED", "internal persistence failure");
};

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  const parsed = runtimeRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendResponse(
      errResponse(
        businessError("PROTOCOL_MESSAGE_INVALID", "message failed protocol validation"),
      ),
    );
    return false;
  }
  const senderIdentity: ContentMessageSenderIdentity = {
    ...(sender.tab?.id === undefined ? {} : { tabId: sender.tab.id }),
    ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
    ...(sender.documentId === undefined ? {} : { documentId: sender.documentId }),
    ...(sender.url === undefined ? {} : { url: sender.url }),
  };
  handleRequest(parsed.data, senderIdentity)
    .then(sendResponse)
    .catch((cause: unknown) => {
      console.error("[ai-crawler-helper] request failed", cause);
      sendResponse(errResponse(toBusinessError(cause)));
    });
  return true; // async response
});

// Kick off recovery eagerly on worker startup.
void getRuntime();

const reportNavigationFailure = (cause: unknown): void => {
  if (isExpectedFactGateClosure(cause)) {
    return;
  }
  console.error("[ai-crawler-helper] browser navigation processing failed", cause);
};

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  void getRuntime()
    .then((runtime) =>
      runtime.navigation.handleBeforeNavigate({
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        timeStamp: details.timeStamp,
        parentFrameId: details.parentFrameId,
      }),
    )
    .catch(reportNavigationFailure);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  const documentId = details.documentId;
  if (documentId === undefined) {
    return;
  }
  void getRuntime()
    .then((runtime) =>
      runtime.navigation.handleCommitted({
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        timeStamp: details.timeStamp,
        documentId,
        transitionType: details.transitionType,
        transitionQualifiers: details.transitionQualifiers,
        ...(details.parentDocumentId === undefined
          ? {}
          : { parentDocumentId: details.parentDocumentId }),
      }),
    )
    .catch(reportNavigationFailure);
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  const documentId = details.documentId;
  if (documentId === undefined) {
    return;
  }
  void getRuntime()
    .then((runtime) =>
      runtime.navigation.handleHashChange({
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        timeStamp: details.timeStamp,
        documentId,
        transitionType: details.transitionType,
        transitionQualifiers: details.transitionQualifiers,
        ...(details.parentDocumentId === undefined
          ? {}
          : { parentDocumentId: details.parentDocumentId }),
      }),
    )
    .catch(reportNavigationFailure);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void getRuntime()
    .then((runtime) => runtime.navigation.handleCreatedNavigationTarget(details))
    .catch(reportNavigationFailure);
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  void getRuntime()
    .then((runtime) => {
      runtime.navigation.handleNavigationError(details.tabId, details.frameId);
    })
    .catch(reportNavigationFailure);
});

chrome.tabs.onCreated.addListener((tab) => {
  const tabId = tab.id;
  if (tabId === undefined) {
    return;
  }
  void getRuntime()
    .then((runtime) =>
      runtime.navigation.handleTabCreated({
        tabId,
        ...(tab.openerTabId === undefined ? {} : { openerTabId: tab.openerTabId }),
        createdAt: Date.now(),
      }),
    )
    .catch(reportNavigationFailure);
});
