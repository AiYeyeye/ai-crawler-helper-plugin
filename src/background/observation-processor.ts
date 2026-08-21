import {
  StepOrchestrator,
  type StepContext,
  type StepLifecycleEvent,
  type StepOrchestratorOptions,
} from "../core/step-orchestrator";
import {
  NavigationCoordinator,
  type NavigationCommit,
  type NavigationCoordinatorDependencies,
  type NavigationDecision,
} from "../core/navigation-coordinator";
import { CrossContextLinker } from "../core/cross-context-linker";
import { SCHEMA_VERSION } from "../schemas/common";
import type { ContentObservationEnvelope } from "../schemas/content-observation";
import type { DomRecord } from "../schemas/dom";
import type { NavigationRecord } from "../schemas/navigation";
import type { EnvelopeAck, EventEnvelope, FactPayload } from "../schemas/event-envelope";
import type { BrowserContextEvidence, DraftStep } from "../schemas/step";
import type { FactIngestor } from "../persistence/fact-ingestor";
import type { SessionRepository } from "../persistence/session-repository";
import type { StepRepository } from "../persistence/step-repository";
import type { NetworkStateRepository } from "../persistence/network-state-repository";
import { isExpectedFactGateClosure } from "./persistence-rejection";
import {
  eventIdSchema,
  newDomRecordId,
  newEventId,
  newNavigationRecordId,
  newStepId,
  type DomRecordId,
  type EventId,
  type SessionId,
  type StepId,
} from "../shared/ids";

export interface ObservationProcessorOptions {
  /** Kept explicit because processor instances are scoped to one database runtime. */
  db: IDBDatabase;
  ingestor: FactIngestor;
  sessionRepository: Pick<SessionRepository, "getControl">;
  stepRepository: StepRepository;
  orchestratorOptions?: StepOrchestratorOptions;
  newDomRecordId?: () => DomRecordId;
  newEventId?: () => EventId;
  inFlightRequestKeys?: (context: StepContext) => readonly string[];
  networkStateRepository?: Pick<NetworkStateRepository, "listInFlightBySession">;
  navigationCoordinatorOptions?: NavigationCoordinatorDependencies;
}

/**
 * Converts authenticated Content Script observations into durable facts.
 *
 * Each derived fact keeps the one-short-transaction rule. The original
 * observation event id is committed last as a checkpoint, so ACK means every
 * preceding derived fact is already committed (or was an idempotent duplicate).
 */
export class ObservationProcessor {
  private readonly ingestor: FactIngestor;
  private readonly sessionRepository: Pick<SessionRepository, "getControl">;
  private readonly stepRepository: StepRepository;
  private readonly makeDomRecordId: () => DomRecordId;
  private readonly makeEventId: () => EventId;
  private readonly readInFlightRequestKeys: (context: StepContext) => readonly string[];
  private readonly networkStateRepository:
    | Pick<NetworkStateRepository, "listInFlightBySession">
    | null;
  private readonly orchestrator: StepOrchestrator;
  private readonly navigationCoordinator: NavigationCoordinator;
  private readonly crossContextLinker = new CrossContextLinker();
  private collectedEvents: StepLifecycleEvent[] | null = null;
  private hydratedSessionId: SessionId | null = null;
  private processingTail: Promise<void> = Promise.resolve();
  private backgroundTail: Promise<void> = Promise.resolve();
  private backgroundSourceSeq = 0;
  private readonly pendingObservationPayloads = new Map<EventId, readonly FactPayload[]>();

  constructor(options: ObservationProcessorOptions) {
    // Touch the runtime-owned database explicitly: callers must not accidentally
    // construct a processor for a different IndexedDB runtime than its ingestor.
    void options.db;
    this.ingestor = options.ingestor;
    this.sessionRepository = options.sessionRepository;
    this.stepRepository = options.stepRepository;
    this.makeDomRecordId = options.newDomRecordId ?? newDomRecordId;
    this.makeEventId = options.newEventId ?? newEventId;
    this.readInFlightRequestKeys = options.inFlightRequestKeys ?? (() => []);
    this.networkStateRepository = options.networkStateRepository ?? null;
    const externalOnEvent = options.orchestratorOptions?.onEvent;
    this.orchestrator = new StepOrchestrator({
      ...options.orchestratorOptions,
      onEvent: (event) => {
        externalOnEvent?.(event);
        this.captureOrPersistLifecycleEvent(event);
      },
    });
    this.navigationCoordinator = new NavigationCoordinator(
      options.navigationCoordinatorOptions ?? {
        newNavigationRecordId,
        newSystemStepId: options.orchestratorOptions?.newStepId ?? newStepId,
      },
    );
  }

  process(
    observation: ContentObservationEnvelope,
    verifiedContext: StepContext,
  ): Promise<EnvelopeAck> {
    return this.serialize(() => this.processOne(observation, verifiedContext));
  }

  activeStepId(context: StepContext): Promise<StepId | null> {
    return this.serialize(async () => {
      await this.hydrate(context.sessionId);
      return this.orchestrator.activeStepId(context);
    });
  }

  activeUserStepId(context: StepContext): Promise<StepId | null> {
    return this.serialize(async () => {
      await this.hydrate(context.sessionId);
      return this.orchestrator.activeUserStepId(context);
    });
  }

  inFlightRequestKeys(context: StepContext): Promise<string[]> {
    return this.serialize(async () => {
      await this.hydrate(context.sessionId);
      return this.orchestrator.inFlightRequestKeys(context);
    });
  }

  recordNetworkRequestStarted(
    context: StepContext,
    requestKey: string,
    observedAt: number,
  ): Promise<{ startedInStepId: StepId }> {
    return this.serialize(async () => {
      await this.hydrate(context.sessionId);
      const { events, result: assignment } = this.collectEventsWithResult(() =>
        this.orchestrator.requestStarted({ context, requestKey }),
      );
      await this.persistRuntimePayloads(
        context,
        observedAt,
        this.compactLifecycleEvents(events).map((event) => this.lifecyclePayload(event)),
      );
      return assignment;
    });
  }

  recordNetworkRequestFinished(
    sessionId: SessionId,
    requestKey: string,
  ): Promise<{ startedInStepId: StepId } | null> {
    return this.serialize(async () => {
      await this.hydrate(sessionId);
      return this.orchestrator.requestFinished({ sessionId, requestKey });
    });
  }

  recordNetworkMessageObserved(
    context: StepContext,
    observedAt: number,
  ): Promise<{ observedDuringStepId: StepId }> {
    return this.serialize(async () => {
      await this.hydrate(context.sessionId);
      const { events, result: observedDuringStepId } = this.collectEventsWithResult(() =>
        this.orchestrator.observeNetworkMessage({ context }),
      );
      await this.persistRuntimePayloads(
        context,
        observedAt,
        this.compactLifecycleEvents(events).map((event) => this.lifecyclePayload(event)),
      );
      return { observedDuringStepId };
    });
  }

  recordNavigation(
    input: NavigationCommit,
    evidence?: readonly BrowserContextEvidence[],
  ): Promise<NavigationDecision> {
    return this.serialize(async () => {
      await this.hydrate(input.sessionId);
      if (input.captureEpochId === undefined) {
        throw new Error("navigation persistence requires a capture epoch");
      }
      const sourceContext: StepContext = {
        sessionId: input.sessionId,
        captureEpochId: input.captureEpochId,
        scope: input.scope,
      };
      const activeUserStepId =
        input.activeUserStepId ?? this.orchestrator.activeUserStepId(sourceContext) ?? undefined;
      const decision = this.navigationCoordinator.record({
        ...input,
        ...(activeUserStepId === undefined ? {} : { activeUserStepId }),
      });
      const events = this.collectEvents(() => {
        if (decision.attribution.kind === "new_system_step") {
          const targetContext = decision.systemStepContext;
          if (targetContext === undefined) {
            throw new Error("system navigation requires a target Step context");
          }
          this.orchestrator.startSystemNavigation({
            context: targetContext,
            stepId: decision.attribution.stepId,
            trigger: decision.attribution.trigger,
            navigation: decision.navigation,
            ...(evidence === undefined
              ? {}
              : {
                  contextLink: this.crossContextLinker.resolve(
                    decision.attribution.stepId,
                    evidence,
                  ),
                }),
            startedAt: input.committedAt,
          });
        }
        if (decision.documentTransition.kind === "document_replaced") {
          this.orchestrator.documentReplaced(sourceContext);
        }
      });
      const payloads = this.compactLifecycleEvents(events).map((event) =>
        this.lifecyclePayload(event),
      );
      payloads.push({ kind: "navigation_record", record: decision.navigation });
      await this.persistRuntimePayloads(sourceContext, input.committedAt, payloads);
      return decision;
    });
  }

  async hydrate(sessionId: SessionId): Promise<void> {
    if (this.hydratedSessionId === sessionId) {
      return;
    }
    if (this.hydratedSessionId !== null) {
      throw new Error("ObservationProcessor instances are scoped to one session");
    }
    const [control, steps, inFlightRequests] = await Promise.all([
      this.sessionRepository.getControl(sessionId),
      this.stepRepository.listStepsBySession(sessionId),
      this.networkStateRepository?.listInFlightBySession(sessionId) ?? Promise.resolve([]),
    ]);
    if (control === null) {
      throw new Error(`session control not found while hydrating ${sessionId}`);
    }
    const currentCaptureEpochId = control.captureEpochId;
    const openDraftSteps = steps.filter(
      (step): step is DraftStep =>
        step.phase === "draft" && step.captureEpochId === currentCaptureEpochId,
    );
    const maxOrdinal = steps.reduce<number | null>(
      (current, step) => (current === null ? step.ordinal : Math.max(current, step.ordinal)),
      null,
    );
    this.orchestrator.hydrate({
      openDraftSteps,
      sessionMaxOrdinals:
        maxOrdinal === null ? [] : [{ sessionId, maxOrdinal }],
      inFlightRequests: inFlightRequests
        .filter(
          (request) =>
            request.blocksStep && request.captureEpochId === currentCaptureEpochId,
        )
        .map((request) => ({
          context: {
            sessionId: request.sessionId,
            captureEpochId: request.captureEpochId,
            scope: request.scope,
          },
          requestKey: request.requestKey,
          startedInStepId: request.startedInStepId,
        })),
    });
    this.hydratedSessionId = sessionId;
  }

  async sessionStopping(sessionId: SessionId): Promise<void> {
    await this.serialize(async () => {
      await this.hydrate(sessionId);
      await this.backgroundTail;
      const events = this.collectEvents(() => {
        this.orchestrator.sessionStopping(sessionId);
      });
      await this.persistIndependentLifecycleEvents(events);
    });
  }

  async sessionPaused(sessionId: SessionId): Promise<void> {
    await this.serialize(async () => {
      await this.backgroundTail;
      this.orchestrator.sessionPaused(sessionId);
      this.pendingObservationPayloads.clear();
    });
  }

  async flushBackgroundEvents(): Promise<void> {
    await this.backgroundTail;
  }

  private async processOne(
    observation: ContentObservationEnvelope,
    context: StepContext,
  ): Promise<EnvelopeAck> {
    if (
      observation.sessionId !== context.sessionId ||
      observation.captureEpochId !== context.captureEpochId
    ) {
      return this.rejectedObservation(observation.eventId, "PROTOCOL_MESSAGE_INVALID", false);
    }
    await this.hydrate(context.sessionId);
    if (await this.ingestor.hasCommittedEvent(observation.eventId)) {
      this.pendingObservationPayloads.delete(observation.eventId);
      return { status: "duplicate", eventId: observation.eventId };
    }

    const pendingPayloads = this.pendingObservationPayloads.get(observation.eventId);
    if (pendingPayloads !== undefined) {
      return this.persistObservationPayloads(observation, context, pendingPayloads);
    }

    const derived = {
      domRecord: null as DomRecord | null,
      navigationRecord: null as NavigationRecord | null,
    };
    const events = this.collectEvents(() => {
      switch (observation.payload.kind) {
        case "action_started":
          if (observation.payload.observation.candidate) {
            throw new Error("candidate actions must use candidate_completed");
          }
          this.orchestrator.startUserAction({
            context,
            action: observation.payload.observation.action,
            domBefore: observation.payload.observation.domBefore,
            candidate: false,
          });
          return;
        case "candidate_started":
          this.orchestrator.startCandidate({
            context,
            candidateToken: observation.payload.candidate.token,
            type: observation.payload.candidate.type,
            startedAt: observation.payload.candidate.startedAt,
            domBefore: observation.payload.candidate.domBefore,
          });
          return;
        case "candidate_completed":
          this.orchestrator.tryCompleteCandidate({
            context,
            candidateToken: observation.payload.candidate.token,
            action: observation.payload.candidate.observation.action,
          });
          return;
        case "candidate_cancelled":
          this.orchestrator.cancelCandidate({
            context,
            candidateToken: observation.payload.candidate.token,
            reason: observation.payload.candidate.reason,
          });
          return;
        case "mutation_observed": {
          const domRecordId = this.makeDomRecordId();
          const stepId = this.orchestrator.observeDomChange({
            context,
            domRecordId,
            domAfter: observation.payload.batch.domAfter,
          });
          derived.domRecord = {
            schemaVersion: SCHEMA_VERSION,
            domRecordId,
            sessionId: context.sessionId,
            stepId,
            role: "mutation_batch",
            payload: {
              role: "mutation_batch",
              mutations: observation.payload.batch.mutations,
              observedDuringStepId: stepId,
              inFlightRequestKeys: [
                ...new Set([
                  ...this.orchestrator.inFlightRequestKeys(context),
                  ...this.readInFlightRequestKeys(context),
                ]),
              ].sort((left, right) => left.localeCompare(right)),
            },
            recordedAt: observation.sourceTimestamp,
          };
          return;
        }
        case "document_replaced":
          this.orchestrator.documentReplaced(context);
          return;
        case "navigation_observed": {
          const activeUserStepId = this.orchestrator.activeUserStepId(context) ?? undefined;
          const decision = this.navigationCoordinator.record({
            sessionId: context.sessionId,
            captureEpochId: context.captureEpochId,
            scope: context.scope,
            beforeUrl: observation.payload.navigation.beforeUrl,
            afterUrl: observation.payload.navigation.afterUrl,
            afterDocumentId: context.scope.documentId,
            ...(observation.payload.navigation.title === undefined
              ? {}
              : { title: observation.payload.navigation.title }),
            signal: {
              kind: "history",
              action: observation.payload.navigation.action,
            },
            committedAt: observation.sourceTimestamp,
            ...(activeUserStepId === undefined ? {} : { activeUserStepId }),
          });
          if (decision.attribution.kind === "new_system_step") {
            const targetContext = decision.systemStepContext;
            if (targetContext === undefined) {
              throw new Error("history navigation requires a target Step context");
            }
            this.orchestrator.startSystemNavigation({
              context: targetContext,
              stepId: decision.attribution.stepId,
              trigger: decision.attribution.trigger,
              navigation: decision.navigation,
              startedAt: observation.sourceTimestamp,
            });
          }
          derived.navigationRecord = decision.navigation;
          return;
        }
      }
    });

    const payloads: FactPayload[] = this.compactLifecycleEvents(events).map((event) =>
      this.lifecyclePayload(event),
    );
    if (derived.domRecord !== null) {
      payloads.push({ kind: "dom_record", record: derived.domRecord });
    }
    if (derived.navigationRecord !== null) {
      payloads.push({ kind: "navigation_record", record: derived.navigationRecord });
    }
    if (payloads.length === 0) {
      payloads.push({
        kind: "observation_checkpoint",
        observationEventId: observation.eventId,
      });
    }
    this.pendingObservationPayloads.set(observation.eventId, payloads);
    return this.persistObservationPayloads(observation, context, payloads);
  }

  private collectEvents(run: () => void): StepLifecycleEvent[] {
    return this.collectEventsWithResult(run).events;
  }

  private collectEventsWithResult<T>(
    run: () => T,
  ): { events: StepLifecycleEvent[]; result: T } {
    if (this.collectedEvents !== null) {
      throw new Error("nested Step lifecycle collection is not supported");
    }
    const events: StepLifecycleEvent[] = [];
    this.collectedEvents = events;
    try {
      return { events, result: run() };
    } finally {
      this.collectedEvents = null;
    }
  }

  private captureOrPersistLifecycleEvent(event: StepLifecycleEvent): void {
    if (this.collectedEvents !== null) {
      this.collectedEvents.push(event);
      return;
    }
    this.backgroundTail = this.backgroundTail
      .then(() => this.persistIndependentLifecycleEvents([event]))
      .catch((cause: unknown) => {
        if (isExpectedFactGateClosure(cause)) {
          return;
        }
        console.error("[ai-crawler-helper] timer-driven Step persistence failed", cause);
      });
  }

  private compactLifecycleEvents(events: readonly StepLifecycleEvent[]): StepLifecycleEvent[] {
    const lastIndexByStep = new Map<string, number>();
    events.forEach((event, index) => lastIndexByStep.set(event.step.stepId, index));
    return events.filter((event, index) => lastIndexByStep.get(event.step.stepId) === index);
  }

  private lifecyclePayload(event: StepLifecycleEvent): FactPayload {
    switch (event.type) {
      case "draft_created":
      case "draft_updated":
        return { kind: "step_draft_upsert", step: event.step };
      case "step_sealed":
        return { kind: "step_seal", step: event.step };
      case "candidate_discarded":
        if (event.step.kind !== "user_action" || !event.step.candidate) {
          throw new Error("candidate discard requires a candidate user-action draft");
        }
        return {
          kind: "step_draft_delete",
          stepId: event.step.stepId,
          candidateToken: event.step.candidateToken,
        };
    }
  }

  private async persistIndependentLifecycleEvents(
    events: readonly StepLifecycleEvent[],
  ): Promise<void> {
    for (const event of this.compactLifecycleEvents(events)) {
      const context: StepContext = {
        sessionId: event.step.sessionId,
        captureEpochId: event.step.captureEpochId,
        scope: event.step.scope,
      };
      const ack = await this.ingestor.ingest(
        this.envelope(
          this.makeEventId(),
          this.backgroundSourceSeq++,
          context,
          Date.now(),
          this.lifecyclePayload(event),
        ),
      );
      if (ack.status === "rejected") {
        throw new Error(`Step lifecycle persistence rejected: ${ack.errorCode}`);
      }
    }
  }

  private async persistRuntimePayloads(
    context: StepContext,
    sourceTimestamp: number,
    payloads: readonly FactPayload[],
  ): Promise<void> {
    for (const payload of payloads) {
      const ack = await this.ingestor.ingest(
        this.envelope(
          this.makeEventId(),
          this.backgroundSourceSeq++,
          context,
          sourceTimestamp,
          payload,
        ),
      );
      if (ack.status === "rejected") {
        throw new Error(`navigation persistence rejected: ${ack.errorCode}`);
      }
    }
  }

  private async persistObservationPayloads(
    observation: ContentObservationEnvelope,
    context: StepContext,
    payloads: readonly FactPayload[],
  ): Promise<EnvelopeAck> {
    let committedBytes = 0;
    let allDuplicate = true;
    for (const [index, payload] of payloads.entries()) {
      const isLast = index === payloads.length - 1;
      const ack = await this.ingestor.ingest(
        this.envelope(
          isLast
            ? observation.eventId
            : this.derivedEventId(observation.eventId, "fact", index),
          observation.sourceSeq * 100 + index,
          context,
          observation.sourceTimestamp,
          payload,
        ),
      );
      if (ack.status === "rejected") {
        return this.rejectedObservation(
          observation.eventId,
          ack.errorCode,
          ack.retryable,
        );
      }
      if (ack.status === "committed") {
        allDuplicate = false;
        committedBytes += ack.committedBytes;
      }
    }
    this.pendingObservationPayloads.delete(observation.eventId);
    return allDuplicate
      ? { status: "duplicate", eventId: observation.eventId }
      : { status: "committed", eventId: observation.eventId, committedBytes };
  }

  private envelope(
    eventId: EventId,
    sourceSeq: number,
    context: StepContext,
    sourceTimestamp: number,
    payload: FactPayload,
  ): EventEnvelope {
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId,
      source: "service_worker",
      sourceSeq,
      sessionId: context.sessionId,
      scope: context.scope,
      sourceTimestamp,
      payload,
    };
  }

  private derivedEventId(observationEventId: EventId, label: string, index: number): EventId {
    return eventIdSchema.parse(
      `evt_derived_${observationEventId}_${label}_${String(index)}`,
    );
  }

  private rejectedObservation(
    eventId: EventId,
    errorCode: string,
    retryable: boolean,
  ): Extract<EnvelopeAck, { status: "rejected" }> {
    return { status: "rejected", eventId, errorCode, retryable };
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.processingTail.then(run, run);
    this.processingTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
