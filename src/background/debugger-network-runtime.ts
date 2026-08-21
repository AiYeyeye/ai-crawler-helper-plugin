import type { CaptureCollector, CollectorStartContext, CollectorStartResult } from "../core/collector-contracts";
import { STOP_LATE_RESPONSE_WINDOW_MS } from "../core/config";
import type { NavigationContextRepository } from "../persistence/navigation-context-repository";
import type { NetworkStateRepository } from "../persistence/network-state-repository";
import type { SessionRepository } from "../persistence/session-repository";
import type { EnvelopeAck, EventEnvelope } from "../schemas/event-envelope";
import type { SessionConfig } from "../schemas/session";
import { businessError } from "../shared/errors";
import { newEventId, type EventId, type ExtTabId, type SessionId } from "../shared/ids";
import { ChromeDebuggerTransport, type ChromeDebuggerCommandApi } from "./chrome-debugger-transport";
import {
  DebuggerSessionManager,
  chromeDebuggerSource,
  type DebuggerCommandTarget,
  type OrphanNetworkEventClassification,
} from "./debugger-session-manager";
import {
  NetworkCaptureController,
  type DebuggerCaptureContext,
  type NetworkStepProcessor,
} from "./network-capture-controller";
import { NetworkRequestContextResolver } from "./network-request-context-resolver";
import { isExpectedFactGateClosure } from "./persistence-rejection";

interface ChromeEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

type DebuggerEventListener = (source: unknown, method: string, params?: unknown) => void;
type DebuggerDetachListener = (source: unknown, reason: string) => void;

export interface ChromeDebuggerRuntimeApi extends ChromeDebuggerCommandApi {
  onEvent: ChromeEvent<DebuggerEventListener>;
  onDetach: ChromeEvent<DebuggerDetachListener>;
}

interface EnvelopeIngestor {
  ingest(envelope: EventEnvelope): Promise<EnvelopeAck>;
}

interface RuntimeGeneration {
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly roots: Map<string, RuntimeRootGeneration>;
  readonly activation: BooleanGate;
  phase: "preparing" | "active" | "sealed";
}

interface RuntimeRootGeneration {
  readonly owner: RuntimeGeneration;
  readonly context: DebuggerCaptureContext;
  readonly sourceQueueKeys: Set<string>;
  readonly admitted: Set<Promise<void>>;
  readonly failures: unknown[];
  readonly cancellation: BooleanGate;
  readonly abortController: AbortController;
  accepting: boolean;
  canceled: boolean;
  drainPromise?: Promise<void>;
}

interface SourceQueue {
  readonly owner: RuntimeRootGeneration;
  readonly tail: Promise<void>;
}

interface BooleanGate {
  readonly promise: Promise<boolean>;
  resolve(value: boolean): void;
}

interface AdmissionOwner {
  readonly generation: RuntimeGeneration;
  readonly root: RuntimeRootGeneration;
  readonly context: DebuggerCaptureContext;
}

interface AdmittedDebuggerEvent extends AdmissionOwner {
  readonly source: DebuggerCommandTarget;
  readonly method: string;
  readonly params: unknown;
}

const createBooleanGate = (): BooleanGate => {
  let settled = false;
  let resolvePromise!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise(value);
    },
  };
};

export interface DebuggerNetworkRuntimeOptions {
  debuggerApi: ChromeDebuggerRuntimeApi;
  ingestor: EnvelopeIngestor;
  ingestLifecycleCleanup: EnvelopeIngestor["ingest"];
  networkState: Pick<
    NetworkStateRepository,
    "nextAttachEpoch" | "getIdentifierMapping" | "listInFlightRequestRecordsBySession"
  >;
  navigationContexts: Pick<NavigationContextRepository, "getCurrentDocument">;
  sessions: Pick<SessionRepository, "getSession" | "getControl">;
  processorForSession: (sessionId: SessionId) => NetworkStepProcessor;
  newEventId?: () => EventId;
  now?: () => number;
  drainTimeoutMs?: number;
}

/** Production listener/transport binding for the debugger network collector. */
export class DebuggerNetworkRuntime implements CaptureCollector {
  readonly name = "debugger_network" as const;

  private readonly api: ChromeDebuggerRuntimeApi;
  private readonly ingestor: EnvelopeIngestor;
  private readonly sessions: DebuggerNetworkRuntimeOptions["sessions"];
  private readonly networkState: DebuggerNetworkRuntimeOptions["networkState"];
  private readonly manager: DebuggerSessionManager;
  private readonly controller: NetworkCaptureController;
  private readonly drainTimeoutMs: number;
  private installed = false;
  private nextGeneration = 0;
  private readonly generations = new Map<SessionId, RuntimeGeneration>();
  private readonly sourceQueues = new Map<string, SourceQueue>();
  private readonly teardowns = new Map<SessionId, Promise<void>>();
  private readonly pauseGapSessions = new Set<SessionId>();
  private readonly orphanClassifications = new Map<
    string,
    OrphanNetworkEventClassification
  >();

  private readonly eventListener: DebuggerEventListener = (rawSource, method, params) => {
    const source = chromeDebuggerSource(rawSource);
    if (source === null) {
      return;
    }
    void this.enqueueEvent(source, method, params).catch((cause: unknown) => {
      if (isExpectedFactGateClosure(cause)) {
        return;
      }
      console.error("[ai-crawler-helper] debugger event routing failed", cause);
    });
  };

  private readonly detachListener: DebuggerDetachListener = (rawSource, reason) => {
    const source = chromeDebuggerSource(rawSource);
    if (source === null) {
      return;
    }
    void this.handleDetach(source, reason).catch((cause: unknown) => {
      console.error("[ai-crawler-helper] debugger detach handling failed", cause);
    });
  };

  constructor(options: DebuggerNetworkRuntimeOptions) {
    this.api = options.debuggerApi;
    this.ingestor = options.ingestor;
    this.sessions = options.sessions;
    this.networkState = options.networkState;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.drainTimeoutMs) || this.drainTimeoutMs <= 0) {
      throw new Error("drainTimeoutMs must be a positive integer");
    }
    const transport = new ChromeDebuggerTransport(options.debuggerApi);
    const makeEventId = options.newEventId ?? newEventId;
    this.manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: (sessionId, tabId) =>
        options.networkState.nextAttachEpoch(sessionId, tabId, options.now?.() ?? Date.now()),
      onCoverageGap: async (envelope) => {
        const ack = await (envelope.payload.kind === "capture_gap_close"
          ? options.ingestLifecycleCleanup(envelope)
          : this.ingestor.ingest(envelope));
        if (ack.status === "rejected") {
          throw new Error(`debugger CaptureGap persistence rejected: ${ack.errorCode}`);
        }
      },
      newEventId: makeEventId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const resolver = new NetworkRequestContextResolver({
      sessions: options.sessions,
      networkState: options.networkState,
      navigationContexts: options.navigationContexts,
    });
    this.controller = new NetworkCaptureController({
      ingestor: options.ingestor,
      transport,
      resolveDebuggerContext: (source) => this.manager.resolveCaptureContext(source),
      resolveRequestContext: (context, input) => resolver.resolve(context, input),
      processorForSession: options.processorForSession,
      sessionConfigFor: (sessionId) => this.sessionConfigFor(sessionId),
      newEventId: makeEventId,
      classifyOrphanNetworkEvent: (sourceKey) =>
        this.orphanClassifications.get(sourceKey) ?? "unexplained",
      orphanGapWindowMs: STOP_LATE_RESPONSE_WINDOW_MS,
    });
    // Late-bound: both objects reference each other, so the hook is wired after
    // construction. A failed child enable discards the child's buffered
    // in-flight events immediately instead of waiting out the pending deadline.
    this.manager.setOnChildNetworkEnableFailed((context, cause) => {
      this.controller.discardSourceBuffers(context, cause);
    });
  }

  install(): void {
    if (this.installed) {
      return;
    }
    this.api.onEvent.addListener(this.eventListener);
    this.api.onDetach.addListener(this.detachListener);
    this.installed = true;
  }

  dispose(): void {
    if (!this.installed) {
      return;
    }
    this.api.onEvent.removeListener(this.eventListener);
    this.api.onDetach.removeListener(this.detachListener);
    this.installed = false;
  }

  async start(context: CollectorStartContext): Promise<CollectorStartResult> {
    return this.startWithPhase(context, "active");
  }

  async prepare(context: CollectorStartContext): Promise<CollectorStartResult> {
    return this.startWithPhase(context, "preparing");
  }

  activate(context: CollectorStartContext): Promise<CollectorStartResult> {
    const generation = this.generations.get(context.session.sessionId);
    if (generation === undefined || generation.phase === "sealed") {
      return Promise.resolve({
        ok: false,
        error: businessError(
          "DEBUGGER_ATTACH_FAILED",
          "The prepared debugger network collector is no longer available.",
          { sessionId: context.session.sessionId },
        ),
      });
    }
    generation.phase = "active";
    generation.activation.resolve(true);
    return Promise.resolve({ ok: true });
  }

  private async startWithPhase(
    context: CollectorStartContext,
    phase: "preparing" | "active",
  ): Promise<CollectorStartResult> {
    await this.teardowns.get(context.session.sessionId);
    const generation = this.beginGeneration(context.session.sessionId, phase);
    let result: CollectorStartResult;
    try {
      result = await this.manager.start(context);
    } catch (cause: unknown) {
      await this.cleanupFailedStart(generation);
      throw cause;
    }
    if (!result.ok) {
      await this.cleanupFailedStart(generation);
      return result;
    }
    const captureContext = this.manager.resolveCaptureContext({
      tabId: context.session.rootTabId,
    });
    if (captureContext !== null) {
      await this.restoreCaptureContext(captureContext);
    }
    if (phase === "active") {
      generation.phase = "active";
      generation.activation.resolve(true);
    }
    return result;
  }

  async attachTab(sessionId: SessionId, tabId: ExtTabId): Promise<CollectorStartResult> {
    await this.teardowns.get(sessionId);
    this.beginGeneration(sessionId, "active");
    const result = await this.manager.attachTab(sessionId, tabId);
    if (result.ok) {
      const context = this.manager.resolveCaptureContext({ tabId });
      if (context !== null) {
        await this.restoreCaptureContext(context);
      }
    }
    return result;
  }

  stop(sessionId: SessionId): Promise<void> {
    return this.teardownSession(sessionId, () => this.manager.stop(sessionId));
  }

  async disconnect(sessionId: SessionId): Promise<void> {
    try {
      const control = await this.sessions.getControl(sessionId);
      if (control?.pause !== undefined) {
        this.pauseGapSessions.add(sessionId);
      }
    } catch (cause: unknown) {
      console.warn(
        "[ai-crawler-helper] unable to inspect pause gap before debugger disconnect",
        cause,
      );
    }
    try {
      await this.teardownSession(sessionId, () => this.manager.disconnect(sessionId));
    } finally {
      this.pauseGapSessions.delete(sessionId);
    }
  }

  private enqueueEvent(
    source: DebuggerCommandTarget,
    method: string,
    params: unknown,
  ): Promise<void> {
    const owner = this.admissionOwner(source);
    if (owner === null || !owner.root.accepting || owner.generation.phase === "sealed") {
      return Promise.resolve();
    }
    const event: AdmittedDebuggerEvent = { ...owner, source: { ...source }, method, params };
    const queueKey = this.sourceQueueKey(event);
    const previous = this.sourceQueues.get(queueKey)?.tail ?? Promise.resolve();
    const tail = previous
      .catch(() => undefined)
      .then(async () => {
        const activated = await Promise.race([
          event.generation.activation.promise,
          event.root.cancellation.promise,
        ]);
        if (!activated || event.root.canceled) {
          return;
        }
        await this.routeEvent(event);
      });
    const releaseQueue = (): void => {
      if (this.sourceQueues.get(queueKey)?.tail === tail) {
        this.sourceQueues.delete(queueKey);
        event.root.sourceQueueKeys.delete(queueKey);
      }
      event.root.admitted.delete(tail);
    };
    void tail.then(releaseQueue, (cause: unknown) => {
      event.root.failures.push(cause);
      releaseQueue();
    });
    event.root.sourceQueueKeys.add(queueKey);
    event.root.admitted.add(tail);
    this.sourceQueues.set(queueKey, { owner: event.root, tail });
    return tail;
  }

  private async handleDetach(source: DebuggerCommandTarget, reason: string): Promise<void> {
    const owner = this.admissionOwner(source);
    if (owner === null) {
      await this.manager.handleDetach(source, reason);
      return;
    }
    const failures: unknown[] = [];
    try {
      await this.sealAndDrainRoot(owner.root);
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      await this.manager.handleDetach(source, reason);
    } catch (cause: unknown) {
      failures.push(cause);
    } finally {
      try {
        await this.controller.forgetCaptureRoot(owner.context);
      } catch (cause: unknown) {
        failures.push(cause);
      }
      const rootKey = this.rootGenerationKey(owner.context);
      if (owner.generation.roots.get(rootKey) === owner.root) {
        owner.generation.roots.delete(rootKey);
      }
    }
    this.throwFailures("debugger root detach failed", failures);
  }

  private beginGeneration(
    sessionId: SessionId,
    phase: "preparing" | "active",
  ): RuntimeGeneration {
    const existing = this.generations.get(sessionId);
    if (existing !== undefined && existing.phase !== "sealed") {
      return existing;
    }
    const activation = createBooleanGate();
    const generation: RuntimeGeneration = {
      sessionId,
      generation: this.nextGeneration++,
      roots: new Map(),
      activation,
      phase,
    };
    if (phase === "active") {
      activation.resolve(true);
    }
    this.generations.set(sessionId, generation);
    return generation;
  }

  private admissionOwner(source: DebuggerCommandTarget): AdmissionOwner | null {
    const context =
      this.manager.resolveCaptureContext(source) ??
      this.manager.resolveCaptureContext({ tabId: source.tabId });
    if (context === null) {
      return null;
    }
    const generation = this.generations.get(context.sessionId);
    if (generation === undefined || generation.phase === "sealed") {
      return null;
    }
    const immutableContext: DebuggerCaptureContext = { ...context };
    const root = this.ensureRoot(generation, immutableContext);
    return { generation, root, context: immutableContext };
  }

  private ensureRoot(
    generation: RuntimeGeneration,
    context: DebuggerCaptureContext,
  ): RuntimeRootGeneration {
    const immutableContext: DebuggerCaptureContext = { ...context };
    const rootKey = this.rootGenerationKey(immutableContext);
    let root = generation.roots.get(rootKey);
    if (root === undefined) {
      root = {
        owner: generation,
        context: {
          sessionId: immutableContext.sessionId,
          tabId: immutableContext.tabId,
          attachEpoch: immutableContext.attachEpoch,
        },
        sourceQueueKeys: new Set(),
        admitted: new Set(),
        failures: [],
        cancellation: createBooleanGate(),
        abortController: new AbortController(),
        accepting: true,
        canceled: false,
      };
      generation.roots.set(rootKey, root);
    }
    return root;
  }

  private rootGenerationKey(context: DebuggerCaptureContext): string {
    return JSON.stringify([context.tabId, context.attachEpoch]);
  }

  private sourceQueueKey(event: AdmittedDebuggerEvent): string {
    return JSON.stringify([
      event.generation.sessionId,
      event.generation.generation,
      event.context.tabId,
      event.context.childSessionId ?? null,
      event.context.attachEpoch,
    ]);
  }

  private sealAndDrainRoot(root: RuntimeRootGeneration): Promise<void> {
    if (root.drainPromise !== undefined) {
      return root.drainPromise;
    }
    root.accepting = false;
    if (root.owner.phase === "preparing") {
      root.canceled = true;
      root.cancellation.resolve(false);
      root.abortController.abort();
    }
    const running = (async () => {
      try {
        await this.withDrainDeadline(
          Promise.allSettled([...root.admitted]).then(() => undefined),
          `debugger root ${String(root.context.tabId)}`,
        );
      } catch (cause: unknown) {
        root.canceled = true;
        root.cancellation.resolve(false);
        root.abortController.abort();
        throw cause;
      } finally {
        if (root.canceled) {
          for (const key of root.sourceQueueKeys) {
            if (this.sourceQueues.get(key)?.owner === root) {
              this.sourceQueues.delete(key);
            }
          }
          root.sourceQueueKeys.clear();
        }
      }
      this.throwFailures("debugger root event drain failed", root.failures);
    })();
    root.drainPromise = running;
    return running;
  }

  private async sealAndDrain(generation: RuntimeGeneration): Promise<void> {
    const wasPreparing = generation.phase === "preparing";
    generation.phase = "sealed";
    if (wasPreparing) {
      generation.activation.resolve(false);
    }
    const results = await Promise.allSettled(
      [...generation.roots.values()].map((root) => this.sealAndDrainRoot(root)),
    );
    this.throwFailures(
      "debugger session event drain failed",
      results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as unknown),
    );
  }

  private teardownSession(sessionId: SessionId, teardown: () => Promise<void>): Promise<void> {
    const existing = this.teardowns.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const generation = this.generations.get(sessionId);
    const running = (async () => {
      const failures: unknown[] = [];
      if (generation !== undefined) {
        try {
          await this.sealAndDrain(generation);
        } catch (cause: unknown) {
          failures.push(cause);
        }
      }
      try {
        await teardown();
      } catch (cause: unknown) {
        failures.push(cause);
      } finally {
        try {
          await this.controller.forgetSession(sessionId);
        } catch (cause: unknown) {
          failures.push(cause);
        }
        if (generation !== undefined && this.generations.get(sessionId) === generation) {
          this.generations.delete(sessionId);
        }
      }
      this.throwFailures("debugger session teardown failed", failures);
    })();
    const tracked = running.finally(() => {
      this.teardowns.delete(sessionId);
    });
    this.teardowns.set(sessionId, tracked);
    return tracked;
  }

  private async routeEvent(
    event: AdmittedDebuggerEvent,
  ): Promise<void> {
    const attachedContext = await this.manager.handleEvent(
      event.source,
      event.method,
      event.params,
    );
    if (attachedContext !== null && !event.root.canceled) {
      await this.restoreCaptureContext(attachedContext);
    }
    if (event.method.startsWith("Network.") && !event.root.canceled) {
      const sourceKey = this.orphanSourceKey(event.context);
      const classification = this.pauseGapSessions.has(event.context.sessionId)
        ? "explained"
        : this.manager.classifyOrphanNetworkEvent(event.context);
      this.orphanClassifications.set(sourceKey, classification);
      try {
        await this.controller.handleNetworkEvent(
          event.source,
          event.method,
          event.params,
          { context: event.context, signal: event.root.abortController.signal },
        );
      } finally {
        if (this.orphanClassifications.get(sourceKey) === classification) {
          this.orphanClassifications.delete(sourceKey);
        }
      }
    }
  }

  private orphanSourceKey(context: DebuggerCaptureContext): string {
    return JSON.stringify([
      context.sessionId,
      context.tabId,
      context.childSessionId ?? null,
      context.attachEpoch,
    ]);
  }

  private async cleanupFailedStart(generation: RuntimeGeneration): Promise<void> {
    try {
      await this.sealAndDrain(generation);
    } finally {
      try {
        await this.controller.forgetSession(generation.sessionId);
      } finally {
        if (this.generations.get(generation.sessionId) === generation) {
          this.generations.delete(generation.sessionId);
        }
      }
    }
  }

  private withDrainDeadline(promise: Promise<void>, label: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`${label} drain timed out after ${String(this.drainTimeoutMs)}ms`));
      }, this.drainTimeoutMs);
    });
    return Promise.race([promise, deadline]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
  }

  private throwFailures(message: string, failures: readonly unknown[]): void {
    if (failures.length === 0) {
      return;
    }
    if (failures.length === 1 && failures[0] instanceof Error) {
      throw failures[0];
    }
    throw new AggregateError(failures, message);
  }

  private async restoreCaptureContext(
    context: NonNullable<ReturnType<DebuggerSessionManager["resolveCaptureContext"]>>,
  ): Promise<void> {
    const generation = this.generations.get(context.sessionId);
    if (generation !== undefined && generation.phase !== "sealed") {
      this.ensureRoot(generation, context);
    }
    const records = await this.networkState.listInFlightRequestRecordsBySession(
      context.sessionId,
    );
    this.controller.restoreInFlightRequests(context, records);
  }

  private async sessionConfigFor(sessionId: SessionId): Promise<SessionConfig> {
    const session = await this.sessions.getSession(sessionId);
    if (session === null) {
      throw new Error(`debugger event references missing session ${sessionId}`);
    }
    return session.config;
  }
}
