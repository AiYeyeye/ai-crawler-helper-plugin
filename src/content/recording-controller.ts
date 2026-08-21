import {
  ActionRecorder,
  type ActionRecorderOptions,
  type CandidateResult,
  type CandidateLifecycleObservation,
  type CapturedActionObservation,
} from "./action-recorder";
import { DomMutationRecorder, type DomMutationBatch } from "./mutation-recorder";
import { EnvelopeOutbox } from "./envelope-outbox";
import {
  contentObservationEnvelopeSchema,
  historyBridgeMessageSchema,
  type ContentObservationEnvelope,
  type ContentObservationPayload,
} from "../schemas/content-observation";
import { SCHEMA_VERSION } from "../schemas/common";
import type { EnvelopeAck } from "../schemas/event-envelope";
import {
  PROTOCOL_VERSION,
  handshakeResponseSchema,
  runtimeResponseSchema,
  type CollectPageStorageResponse,
  type HandshakeResponse,
} from "../shared/messages";
import { newEventId, type EventId } from "../shared/ids";
import {
  browserPageStorageSources,
  readPageStorage,
  type PageStorageSources,
} from "./page-storage-reader";

const CAPTURE_CONTEXT_HANDSHAKE_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

export interface ActionRecorderPort {
  start(): void;
  stop(): void;
  notifyCandidateResult(result: CandidateResult): void;
}

export interface MutationRecorderPort {
  start(): void;
  stop(): void;
  markDocumentReplaced(): void;
  drain(target: Element): DomMutationBatch;
}

export interface ContentRecordingControllerDependencies {
  document: Document;
  getUrl: () => string;
  sendMessage: (message: unknown) => Promise<unknown>;
  now?: () => number;
  newEventId?: () => EventId;
  createActionRecorder?: (
    onCapture: (observation: CapturedActionObservation) => void,
    options: Partial<ActionRecorderOptions>,
  ) => ActionRecorderPort;
  createMutationRecorder?: (onMutationObserved: (target: Element) => void) => MutationRecorderPort;
  /** Frame-local storage sources; defaults to this document's own globals. */
  pageStorage?: PageStorageSources;
  waitForHandshakeRetry?: (delayMs: number) => Promise<void>;
}

/**
 * Owns the current document's handshake, recorders and replayable observation
 * outbox. It never allocates Step ids or ordinals; that authority lives in the
 * Service Worker StepOrchestrator.
 */
export class ContentRecordingController {
  private readonly now: () => number;
  private readonly makeEventId: () => EventId;
  private readonly outbox: EnvelopeOutbox<ContentObservationEnvelope>;
  private readonly pageStorage: PageStorageSources;
  private context: Extract<HandshakeResponse, { active: true }> | null = null;
  private actionRecorder: ActionRecorderPort | null = null;
  private mutationRecorder: MutationRecorderPort | null = null;
  private generation = 0;
  private startPromise: Promise<boolean> | null = null;
  private rehandshakePromise: Promise<void> | null = null;

  constructor(private readonly dependencies: ContentRecordingControllerDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.makeEventId = dependencies.newEventId ?? newEventId;
    this.outbox = new EnvelopeOutbox<ContentObservationEnvelope>(
      dependencies.sendMessage,
      "observations/submit",
      (ack, envelope) => this.handleContextRejection(ack, envelope),
    );
    this.pageStorage =
      dependencies.pageStorage ??
      browserPageStorageSources(
        dependencies.document.defaultView ?? (globalThis as unknown as Window),
      );
  }

  /**
   * Read this frame's own storage. Returns null when the frame is not part of
   * an active recording — the Service Worker then records the absence
   * explicitly instead of storing an empty snapshot.
   */
  async collectPageStorage(): Promise<CollectPageStorageResponse | null> {
    if (this.context === null) {
      return null;
    }
    const content = await readPageStorage(this.pageStorage);
    return { origin: this.currentOrigin(), content };
  }

  /** Opaque-origin frames (sandboxed iframes) report the literal "null" origin. */
  private currentOrigin(): string {
    try {
      return new URL(this.dependencies.getUrl()).origin;
    } catch {
      return "null";
    }
  }

  async start(): Promise<boolean> {
    if (this.context !== null) {
      return true;
    }
    if (this.startPromise !== null) {
      return this.startPromise;
    }
    const generation = this.generation;
    const pendingStart = this.startForGeneration(generation);
    this.startPromise = pendingStart;
    try {
      return await pendingStart;
    } finally {
      if (this.startPromise === pendingStart) {
        this.startPromise = null;
      }
    }
  }

  private async startForGeneration(generation: number): Promise<boolean> {
    const raw = await this.dependencies.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "handshake/contentScript",
      url: this.dependencies.getUrl(),
    });
    if (generation !== this.generation) {
      return false;
    }
    const response = runtimeResponseSchema.safeParse(raw);
    if (!response.success || !response.data.ok) {
      return false;
    }
    const handshake = handshakeResponseSchema.safeParse(response.data.value);
    if (!handshake.success || !handshake.data.active) {
      return false;
    }
    this.context = handshake.data;

    const options: Partial<ActionRecorderOptions> = {
      inputQuietWindowMs: handshake.data.config.networkQuietWindowMs,
      hoverDwellThresholdMs: handshake.data.config.hoverDwellThresholdMs,
      scrollQuietWindowMs: handshake.data.config.networkQuietWindowMs,
      now: this.now,
      onCandidateLifecycle: (observation) => {
        if (generation === this.generation) {
          this.captureCandidateLifecycle(observation);
        }
      },
    };
    this.actionRecorder =
      this.dependencies.createActionRecorder?.(
        (observation) => {
          if (generation === this.generation) {
            this.captureAction(observation);
          }
        },
        options,
      ) ??
      new ActionRecorder(
        this.dependencies.document,
        (observation) => {
          if (generation === this.generation) {
            this.captureAction(observation);
          }
        },
        options,
      );
    const onMutationObserved = (target: Element): void => {
      if (generation === this.generation) {
        void this.recordMutations(target);
      }
    };
    this.mutationRecorder =
      this.dependencies.createMutationRecorder?.(onMutationObserved) ??
      new DomMutationRecorder(this.dependencies.document, this.now, onMutationObserved);
    this.mutationRecorder.start();
    this.actionRecorder.start();
    return true;
  }

  async flush(): Promise<void> {
    await this.outbox.flush();
  }

  async recordMutations(target: Element): Promise<void> {
    if (this.mutationRecorder === null) {
      return;
    }
    const batch = this.mutationRecorder.drain(target);
    if (batch.mutations.length === 0) {
      return;
    }
    this.actionRecorder?.notifyCandidateResult("dom_change");
    this.enqueue({ kind: "mutation_observed", batch });
    await this.flush();
  }

  async candidateResult(result: CandidateResult): Promise<void> {
    this.actionRecorder?.notifyCandidateResult(result);
    await this.flush();
  }

  async historyNavigation(raw: unknown): Promise<boolean> {
    const context = this.context;
    const parsed = historyBridgeMessageSchema.safeParse(raw);
    if (
      context === null ||
      context.historyBridgeToken === undefined ||
      !parsed.success ||
      parsed.data.token !== context.historyBridgeToken
    ) {
      return false;
    }
    this.enqueue({
      kind: "navigation_observed",
      navigation: {
        action: parsed.data.action,
        beforeUrl: parsed.data.beforeUrl,
        afterUrl: parsed.data.afterUrl,
        title: this.dependencies.document.title,
      },
    }, parsed.data.occurredAt);
    await this.flush();
    return true;
  }

  async documentReplaced(): Promise<void> {
    if (this.context === null) {
      return;
    }
    this.actionRecorder?.stop();
    this.mutationRecorder?.markDocumentReplaced();
    this.enqueue({ kind: "document_replaced", url: this.dependencies.getUrl() });
    await this.flush();
    this.context = null;
  }

  stop(): void {
    this.generation += 1;
    this.stopCurrentRecorders();
    this.context = null;
  }

  private stopCurrentRecorders(): void {
    this.actionRecorder?.stop();
    this.mutationRecorder?.stop();
    this.actionRecorder = null;
    this.mutationRecorder = null;
  }

  private async handleContextRejection(
    ack: Extract<EnvelopeAck, { status: "rejected" }>,
    envelope: ContentObservationEnvelope,
  ): Promise<void> {
    if (
      ack.errorCode !== "CAPTURE_CONTEXT_STALE" &&
      ack.errorCode !== "SESSION_NOT_ACCEPTING_FACTS"
    ) {
      return;
    }
    const context = this.context;
    if (context === null || !this.envelopeMatchesContext(envelope, context)) {
      return;
    }

    this.generation += 1;
    this.stopCurrentRecorders();
    this.context = null;
    this.outbox.discardWhere((pending) => this.envelopeMatchesContext(pending, context));

    if (this.rehandshakePromise === null) {
      const invalidatedGeneration = this.generation;
      const retry = this.retryHandshake(invalidatedGeneration);
      this.rehandshakePromise = retry;
      try {
        await retry;
      } finally {
        if (this.rehandshakePromise === retry) {
          this.rehandshakePromise = null;
        }
      }
    } else {
      await this.rehandshakePromise;
    }
  }

  private async retryHandshake(generation: number): Promise<void> {
    const waitForRetry =
      this.dependencies.waitForHandshakeRetry ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    for (const delayMs of CAPTURE_CONTEXT_HANDSHAKE_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await waitForRetry(delayMs);
      }
      if (generation !== this.generation || (await this.start())) {
        return;
      }
    }
  }

  private envelopeMatchesContext(
    envelope: ContentObservationEnvelope,
    context: Extract<HandshakeResponse, { active: true }>,
  ): boolean {
    return (
      envelope.sessionId === context.sessionId &&
      envelope.captureEpochId === context.captureEpochId &&
      envelope.scope.tabId === context.scope.tabId &&
      envelope.scope.frameId === context.scope.frameId &&
      envelope.scope.documentId === context.scope.documentId
    );
  }

  private captureAction(observation: CapturedActionObservation): void {
    this.enqueue({ kind: "action_started", observation });
    void this.flush();
  }

  private captureCandidateLifecycle(observation: CandidateLifecycleObservation): void {
    const payload: ContentObservationPayload =
      observation.kind === "started"
        ? {
            kind: "candidate_started",
            candidate: {
              token: observation.token,
              type: observation.type,
              startedAt: observation.startedAt,
              domBefore: observation.domBefore,
            },
          }
        : observation.kind === "completed"
          ? {
              kind: "candidate_completed",
              candidate: {
                token: observation.token,
                observation: observation.observation,
              },
            }
        : {
            kind: "candidate_cancelled",
            candidate: {
              token: observation.token,
              type: observation.type,
              reason: observation.reason,
            },
          };
    this.enqueue(payload);
    void this.flush();
  }

  private enqueue(payload: ContentObservationPayload, sourceTimestamp = this.now()): void {
    const context = this.context;
    if (context === null) {
      return;
    }
    const envelope = contentObservationEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: this.makeEventId(),
      sourceSeq: this.outbox.allocateSeq(),
      sessionId: context.sessionId,
      captureEpochId: context.captureEpochId,
      scope: context.scope,
      sourceTimestamp,
      payload,
    });
    this.outbox.enqueue(envelope);
  }
}
